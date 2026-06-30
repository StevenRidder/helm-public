#!/usr/bin/env python3
"""
Helm basemap-fill proxy — clean-IP caching reverse-proxy for the ONLINE-FILL underlay (CHART-16).

Sits BENEATH the offline MBTiles charts: serves licensed online satellite tiles (EOX
Sentinel-2 cloudless) so the map is never a void where the owned packs have gaps (the
missing z16 in every Fiji pack, anything past the pack's zoom, and everywhere outside
the Fiji bbox). The client layer ships visibility:none (default OFF) and sits above the
"ocean" background + below the 4 MBTiles basemaps, so this can only ADD beneath the charts.

  GET /basemap/{source}/{z}/{x}/{y}.{ext}   -> tile bytes (cache-first)
  GET /health                                -> {"ok":true}
  GET /stats                                 -> {"cached_tiles":N,"sources":[...]}

Design:
- CLEAN-IP: permissive stdlib only, NO GPL / NO OpenCPN (ADR-0006/0009). Holds the
  upstream URL/credentials server-side so the browser only ever talks to THIS origin.
  Runs on its OWN port (default 8095) — NOT the contended :8091 basemap port (WX-15).
- WORLD-CLASS CACHE (no size cap by decision — Mac mini / iOS, not a Pi):
    * cache-FIRST — a cached tile is served instantly, even with no internet.
    * STALE-WHILE-REVALIDATE — if a cached tile is older than REFRESH_DAYS, a BACKGROUND
      conditional GET (If-None-Match via the stored ETag) refreshes it; the response never
      waits. 304 -> touch (fresh again); 200 -> replace. Satellite mosaics update ~annually,
      so the default 30d refresh keeps tiles from going super-stale without churn.
    * serve-stale-on-outage — upstream down/timeout serves any cached bytes; if none,
      204 transparent (fail-safe: the dark ocean shows, never a 5xx / spinner / broken tile).
    * NO eviction (roadmap: byte-budget + route-pin for tiny devices).
- Mirrors the WX-14 fetch-once/serve-stale pattern; can later fold into a content-agnostic
  WX cache (parameterize OrderedTileCache ext+subdir + ignore_ttl).
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import os
import sys
import json
import time
import threading
import re

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("HELM_FILL_PORT", "8095"))
CACHE = os.environ.get("HELM_FILL_CACHE", os.path.expanduser("~/.helm/basemap-fill-cache"))
REFRESH_DAYS = float(os.environ.get("HELM_FILL_REFRESH_DAYS", "30"))   # background revalidate when older than this
TIMEOUT = float(os.environ.get("HELM_FILL_TIMEOUT", "12"))
UA = "helm-basemap-fill/1.0 (+https://github.com/StevenRidder/Helm; marine chartplotter, cached client)"

# Source registry. Upstream URL template + tile-axis order. Keep keys/credentials HERE (server-side).
# Most XYZ-imagery providers (EOX WMTS, Esri) address tiles as {z}/{y}/{x} (row/col); MapLibre
# requests {z}/{x}/{y}, so the route hands us (x=col, y=row) and we slot them into the template.
SOURCES = {
    # EOX Sentinel-2 cloudless 2023 — global, ~10 m native (z14), CC-BY-4.0. PRODUCTION source;
    # matches Helm's existing offline 'sat' pack credit. Its own Cache-Control is max-age=604800.
    "eox": {
        "url": "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg",
        "ext": "jpg", "ct": "image/jpeg",
        "attribution": "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (CC-BY-4.0)",
    },
    # Esri World Imagery — DEV/ALT only (paid commercial ToS; do not ship as the default).
    "esri": {
        "url": "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "ext": "jpg", "ct": "image/jpeg",
        "attribution": "Esri, Maxar, Earthstar Geographics (dev only)",
    },
}

_locks = {}
_locks_guard = threading.Lock()


def _lock(key):
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        return lock


def _paths(source, z, x, y, ext):
    base = os.path.join(CACHE, source, str(z), str(x))
    tile = os.path.join(base, "%d.%s" % (y, ext))
    return tile, tile + ".etag"


def _fetch(url, etag=None):
    """Return (status, bytes_or_None, etag). status: 200 new, 304 unchanged, 0 error/offline."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if etag:
        req.add_header("If-None-Match", etag)
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return 200, resp.read(), resp.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, None, etag
        return 0, None, None
    except Exception:
        return 0, None, None


def _store(tile_path, etag_path, data, etag):
    os.makedirs(os.path.dirname(tile_path), exist_ok=True)
    tmp = tile_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, tile_path)   # atomic — a reader never sees a half-written tile
    if etag:
        with open(etag_path, "w") as f:
            f.write(etag)


def _revalidate_bg(url, tile_path, etag_path):
    """Background conditional refresh — never blocks a response (stale-while-revalidate)."""
    def run():
        with _lock(tile_path):
            etag = None
            if os.path.exists(etag_path):
                try:
                    etag = open(etag_path).read().strip()
                except Exception:
                    etag = None
            status, data, new_etag = _fetch(url, etag)
            if status == 200 and data:
                _store(tile_path, etag_path, data, new_etag)
            elif status == 304:
                os.utime(tile_path, None)   # confirmed current -> reset the age clock
            # error -> keep the stale tile (offline-safe)
    threading.Thread(target=run, daemon=True).start()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ct=None):
        self.send_response(code)
        if ct:
            self.send_header("Content-Type", ct)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
            return
        if path == "/stats":
            n = 0
            for _, _, files in os.walk(CACHE):
                n += sum(1 for fn in files if not fn.endswith(".etag") and not fn.endswith(".tmp"))
            self._send(200, json.dumps({"cached_tiles": n, "sources": list(SOURCES)}).encode(), "application/json")
            return
        match = re.match(r"^/basemap/([\w-]+)/(\d+)/(\d+)/(\d+)\.(\w+)$", path)
        if not match:
            self._send(404)
            return
        source, z, x, y = match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))
        src = SOURCES.get(source)
        if not src:
            self._send(404)
            return
        span = 1 << z
        if not (0 <= x < span and 0 <= y < span):
            self._send(404)
            return
        tile_path, etag_path = _paths(source, z, x, y, src["ext"])
        url = src["url"].format(z=z, x=x, y=y)
        # cache-FIRST: serve instantly (works offline), refresh in the background if stale
        if os.path.exists(tile_path):
            try:
                with open(tile_path, "rb") as f:
                    data = f.read()
            except Exception:
                data = None
            if data:
                if time.time() - os.path.getmtime(tile_path) > REFRESH_DAYS * 86400:
                    _revalidate_bg(url, tile_path, etag_path)
                self._send(200, data, src["ct"])
                return
        # cache MISS -> fetch upstream (coalesced per tile)
        with _lock(tile_path):
            if os.path.exists(tile_path):
                with open(tile_path, "rb") as f:
                    self._send(200, f.read(), src["ct"])
                return
            status, data, etag = _fetch(url)
            if status == 200 and data:
                _store(tile_path, etag_path, data, etag)
                self._send(200, data, src["ct"])
                return
        # hard miss / upstream down + nothing cached -> fail-safe transparent (ocean shows, no error)
        self._send(204)


class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    print("helm basemap-fill :%d  cache=%s  refresh=%.0fd  sources=%s"
          % (PORT, CACHE, REFRESH_DAYS, ",".join(SOURCES)))
    ThreadedServer(("0.0.0.0", PORT), Handler).serve_forever()
