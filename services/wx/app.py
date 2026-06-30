#!/usr/bin/env python3
"""
helm-wx — the met-ocean / data-layer gateway (clean-IP microservice)
====================================================================
A standalone, permissively-licensed service that turns external weather sources into Helm's
VALUE-ENCODED Mercator tiles on demand — the online counterpart of pipeline/make_value_tiles.py.

WHY IT EXISTS (the architecture, see docs/decisions/0006/0009 + docs/ARCHITECTURE.md):
  • The GPL OpenCPN/S-52 engine is quarantined behind the wire (arm's-length containment). This
    service is the OPPOSITE corner — net-new, clean IP (FastAPI + httpx + Python stdlib only; no GPL,
    no OpenCPN) — a brick in the POST-GPL data plane, not the legacy core.
  • It is the seam where map data layers enter Helm. Today: Open-Meteo. Tomorrow: the S-100 met-ocean
    product specs (S-411 wind/pressure, S-412 waves, S-104 water level, S-111 currents) plug in here,
    beside the planned permissive S-101 chart rebuild. The client never changes — it just consumes
    helm-wxv1 tiles over HTTP.
  • "Fetch once, serve many" (what Windy does): a coarse source grid is fetched per coarse cell and
    cached; every output tile in that cell is baked from it. One client or twenty, panning or zooming,
    we touch Open-Meteo only when we move into a genuinely new area or the cache ages out.

CONTRACT (mirrors web/wx-value-codec.js + pipeline/make_value_tiles.py — "helm-wxv1"):
  GET /{layer}/manifest.json     -> {encoding, scale, offset, ramp, bbox, minzoom, maxzoom, unit, ...}
  GET /{layer}/{z}/{x}/{y}.png   -> 256x256 RGBA; RGB = 24-bit value, A = NODATA mask (0 = no data)
      value = offset + ((R<<16)|(G<<8)|B) * scale     (decoded + colourised client-side by cog.js)
  GET /index.json                -> layer catalogue for the UI picker
  GET /health

HONESTY: never fabricates a value to fill a gap (NODATA stays transparent). On a provider 429/outage
we serve stale cache if we have it, else fail honestly — we do NOT invent weather. NOT FOR NAVIGATION.

Run:  uvicorn app:app --port 8093      (deps: pip install -r requirements.txt)
      Use :8093 — :8091 is the offline basemap MBTiles server; binding :8091 here
      collides with it (WX-15) and broke live Navionics. The web client already
      targets :8093 for weather.
"""
import asyncio
import json
import math
import os
import hashlib
import struct
import time
import traceback
import zlib
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set, Tuple

import httpx
import numpy as np
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

# ------------------------------------------------------------------ config
VMAX24 = 0xFFFFFF
ENCODING = "helm-wxv1"
BUNDLE_SCHEMA = "helm.env.bundle.v1"
BUNDLE_ID = "open-meteo/latest"
BUNDLE_TITLE = "Open-Meteo live environmental bundle"
BUNDLE_PROVIDER = "open-meteo"
BUNDLE_MODEL_ID = "latest"
BUNDLE_VALID_TIME_ID = "latest"
DEFAULT_PREPARED_REGION = "fiji-south-pacific"
DEFAULT_BUNDLE_FRAMES = int(os.environ.get("HELM_WX_BUNDLE_FRAMES", "1"))
DEFAULT_BUNDLE_FRAME_STEP_HOURS = float(os.environ.get("HELM_WX_BUNDLE_FRAME_STEP_HOURS", "1"))


def _load_dotenv():
    """Load services/wx/.env (gitignored) into the environment if present — so the API key lives in a
    local secret file, never in source/git. Real env vars win (setdefault)."""
    p = os.path.join(os.path.dirname(__file__), ".env")
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


_load_dotenv()
# Open-Meteo endpoint. With a commercial key (HELM_WX_OPENMETEO_KEY in the ENV/.env — never in source/git)
# we use the customer host + &apikey (1M calls/mo, no daily cap); otherwise the free, daily-capped host.
OPENMETEO_KEY = os.environ.get("HELM_WX_OPENMETEO_KEY", "").strip()
FORECAST = ("https://customer-api.open-meteo.com/v1/forecast" if OPENMETEO_KEY
            else "https://api.open-meteo.com/v1/forecast")
# Marine endpoint (waves/swell/sst/currents) — same key, different host. Marine layers carry marine:True.
MARINE = ("https://customer-marine-api.open-meteo.com/v1/marine" if OPENMETEO_KEY
          else "https://marine-api.open-meteo.com/v1/marine")
KMH2KN = 0.539957
CACHE_DIR = os.environ.get("HELM_WX_CACHE", os.path.join(os.path.dirname(__file__), "cache"))
TTL = int(os.environ.get("HELM_WX_TTL", "1800"))            # a fetched grid / baked tile is reusable for 30 min
COOLDOWN = int(os.environ.get("HELM_WX_COOLDOWN", "300"))   # after a 429 we serve cache only for 5 min
DATA_Z_MAX = int(os.environ.get("HELM_WX_DATA_Z", "7"))     # manifest maxzoom — the client overzooms (scales) beyond
# We fetch SOURCE grids at this COARSE zoom and bake every finer tile from them, so a whole viewport is
# 1–few grid fetches, not one-per-tile ("fetch once, serve many"). Coarser => fewer Open-Meteo calls but
# a softer field; the animated particles carry the fine detail. (The truly world-class fix is GRIB model
# ingestion — one download per run, full resolution, zero per-tile calls — see README "Phase 2".)
FETCH_Z = int(os.environ.get("HELM_WX_FETCH_Z", "5"))
GRID_N = int(os.environ.get("HELM_WX_GRID_N", "12"))        # source-grid resolution per coarse cell (GRID_N x GRID_N pts)
# NOTE: GRID_N**2 points go in ONE Open-Meteo GET; >~150 points overflows the URI (HTTP 414). 12x12=144
# is the safe max (matches web/wx-live.js). Finer detail comes from a finer FETCH_Z (smaller cells), not N.
TILE_MEM_MAX = int(os.environ.get("HELM_WX_TILE_MEM", "400"))
TIMEOUT = float(os.environ.get("HELM_WX_TIMEOUT", "12"))
# Throttle is key-aware: the commercial key (1M/mo) tolerates bursts, so fetch a viewport's cells in
# parallel for a faster first paint; the free tier stays conservative to avoid 429s.
CONCURRENCY = int(os.environ.get("HELM_WX_CONCURRENCY", "6" if OPENMETEO_KEY else "2"))
MIN_INTERVAL = float(os.environ.get("HELM_WX_MIN_INTERVAL", "0.05" if OPENMETEO_KEY else "0.2"))
USER_AGENT = "helm-wx/0.1 (+https://github.com/StevenRidder/Helm; marine chartplotter, cached client)"

# Per-layer config. scale/offset are FIXED per layer (from a sensible physical [vmin,vmax]) so colours
# and decoded values are comparable across EVERY tile and session — like Windy's fixed scales, and
# unlike the offline baker's per-pack min/max. Ramps mirror web/wx-live.js so Live and tiles agree.
LAYERS: Dict[str, dict] = {
    "wind":     {"v": "wind_speed_10m", "dir": "wind_direction_10m", "vector": True, "unit": "kn", "vmin": 0.0, "vmax": 80.0,
                 "stops": [[0, [98, 113, 183]], [5, [57, 131, 168]], [10, [52, 171, 151]], [16, [123, 183, 80]],
                           [22, [225, 200, 60]], [30, [232, 130, 50]], [40, [214, 70, 74]], [55, [150, 60, 150]]]},
    "gust":     {"v": "wind_gusts_10m", "unit": "kn", "vmin": 0.0, "vmax": 100.0,
                 "stops": [[0, [56, 189, 248]], [10, [45, 212, 191]], [20, [250, 204, 21]], [30, [249, 115, 22]],
                           [42, [239, 68, 68]], [60, [217, 33, 154]]]},
    "temp":     {"v": "temperature_2m", "unit": "°C", "vmin": -40.0, "vmax": 50.0,
                 "stops": [[-10, [70, 90, 200]], [0, [80, 180, 235]], [10, [70, 200, 130]], [20, [245, 205, 60]],
                           [30, [240, 120, 40]], [42, [210, 40, 40]]]},
    "pressure": {"v": "pressure_msl", "unit": "hPa", "vmin": 950.0, "vmax": 1050.0,
                 "stops": [[980, [120, 80, 200]], [1000, [80, 160, 230]], [1013, [120, 205, 140]],
                           [1025, [240, 200, 80]], [1040, [230, 110, 55]]]},
    "rain":     {"v": "precipitation", "unit": "mm", "vmin": 0.0, "vmax": 50.0,
                 "stops": [[0, [70, 170, 225, 0]], [0.1, [120, 205, 240, 0.45]], [0.5, [70, 175, 250, 0.72]],
                           [2, [45, 120, 240, 0.84]], [6, [110, 80, 225, 0.88]], [12, [165, 60, 195, 0.92]],
                           [25, [210, 55, 90, 0.95]]]},   # Windy-parity: light rain (~0.1mm) reads as cyan; heavy -> red
    "clouds":   {"v": "cloud_cover", "unit": "%", "vmin": 0.0, "vmax": 100.0,
                 "stops": [[0, [150, 170, 190, 0]], [40, [200, 210, 222, 0.4]], [80, [235, 240, 246, 0.75]],
                           [100, [250, 252, 255, 0.9]]]},
    "cape":     {"v": "cape", "unit": "J/kg", "vmin": 0.0, "vmax": 4000.0,
                 "stops": [[0, [56, 160, 200, 0]], [300, [120, 200, 120, 0.5]], [1000, [245, 205, 60, 0.8]],
                           [2500, [240, 120, 40, 0.9]], [4000, [220, 40, 40, 0.95]]]},
    # MARINE layers — Open-Meteo Marine API (marine:True). NODATA over land falls out as transparent.
    "sst":      {"v": "sea_surface_temperature", "marine": True, "unit": "°C", "vmin": 0.0, "vmax": 35.0,
                 "stops": [[0, [70, 90, 200]], [10, [80, 180, 235]], [18, [70, 200, 150]], [24, [245, 205, 60]],
                           [30, [240, 120, 40]], [35, [210, 40, 40]]]},
    "waves":    {"v": "wave_height", "marine": True, "unit": "m", "vmin": 0.0, "vmax": 12.0,
                 "stops": [[0, [60, 110, 180, 0.15]], [1, [60, 160, 190, 0.6]], [2.5, [80, 200, 140, 0.8]],
                           [4, [235, 205, 70, 0.85]], [6, [235, 130, 50, 0.9]], [9, [210, 50, 60, 0.95]]]},
    "swell":    {"v": "swell_wave_height", "marine": True, "unit": "m", "vmin": 0.0, "vmax": 10.0,
                 "stops": [[0, [60, 110, 180, 0.15]], [1, [70, 150, 200, 0.6]], [2.5, [90, 190, 160, 0.8]],
                           [4, [230, 200, 80, 0.85]], [6, [230, 120, 60, 0.9]], [8, [200, 50, 70, 0.95]]]},
    "current":  {"v": "ocean_current_velocity", "dir": "ocean_current_direction", "vector": True, "conv": "kmh2kn",
                 "dir_to": True,                            # ocean-current direction is TOWARD (oceanographic), unlike wind (FROM)
                 "marine": True, "unit": "kn", "vmin": 0.0, "vmax": 3.2,   # MATCHES Windy's current scale (kt: 0,0.4,0.8,1.6,2,3.2)
                 "stops": [[0.0, [40, 50, 130, 0.5]], [0.4, [40, 110, 230, 0.72]], [0.8, [45, 200, 215, 0.82]],
                           [1.2, [120, 210, 90, 0.86]], [1.6, [230, 215, 70, 0.9]], [2.0, [242, 150, 40, 0.93]],
                           [3.2, [216, 45, 50, 0.96]]]},  # Windy currents: navy->blue->cyan->green->yellow->orange->RED at 3.2 kn
}
MODEL_NAME = "Open-Meteo (GFS-seamless)"
MARINE_MODEL = "Open-Meteo Marine"
BUNDLE_LAYER_ORDER = [
    "wind", "gust", "rain", "temp", "pressure", "clouds", "cape",
    "waves", "swell", "current", "sst",
]
S100_LAYER_REFS = {
    # S-41X weather/wave products are S-100-family overlays. Open-Meteo is NOT an official S-100
    # source; these refs keep Helm's metadata/probe shape aligned so an official S-413/S-412
    # adapter can swap in behind the same bundle contract later.
    "wind":     {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "wind condition"},
    "gust":     {"productIdentifier": "S-412", "productName": "Marine Weather Warnings", "role": "wind-gust hazard cue"},
    "rain":     {"productIdentifier": "S-412", "productName": "Marine Weather Warnings", "role": "precipitation hazard cue"},
    "temp":     {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "air-temperature condition"},
    "pressure": {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "pressure condition"},
    "clouds":   {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "cloud-cover condition"},
    "cape":     {"productIdentifier": "S-412", "productName": "Marine Weather Warnings", "role": "convective hazard cue"},
    "waves":    {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "wave-height condition"},
    "swell":    {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "swell-height condition"},
    "sst":      {"productIdentifier": "S-413", "productName": "Marine Weather and Wave Conditions", "role": "sea-surface-temperature condition"},
    "current":  {"productIdentifier": "S-111", "productName": "Surface Currents", "role": "surface-current condition"},
}


def layer_scale_offset(cfg: dict) -> Tuple[float, float]:
    vmin, vmax = float(cfg["vmin"]), float(cfg["vmax"])
    scale = (vmax - vmin) / VMAX24 if vmax > vmin else 1.0
    return scale, vmin


# ------------------------------------------------------------------ web mercator (mirrors make_value_tiles.py)
def lonlat_to_tile(lon: float, lat: float, z: int) -> Tuple[float, float]:
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat = max(-85.05112878, min(85.05112878, lat))
    lr = math.radians(lat)
    y = (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n
    return x, y


def pixel_to_lonlat(z: int, xt: int, yt: int, px: float, py: float, size: int = 256) -> Tuple[float, float]:
    n = 2 ** z
    x = xt + px / size
    y = yt + py / size
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tile_bounds(z: int, xt: int, yt: int) -> Tuple[float, float, float, float]:
    """(west, south, east, north) of tile (z,xt,yt)."""
    w, n = pixel_to_lonlat(z, xt, yt, 0, 0)
    e, s = pixel_to_lonlat(z, xt, yt, 256, 256)
    return w, s, e, n


# ------------------------------------------------------------------ helm-wxv1 encode + PNG (stdlib; mirrors the codec)
def encode_value(v: float, scale: float, offset: float) -> Tuple[int, int, int]:
    n = int(round((v - offset) / (scale if scale > 0 else 1.0)))
    n = 0 if n < 0 else (VMAX24 if n > VMAX24 else n)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def write_png_bytes(buf: bytes, size: int = 256, alpha: bool = True) -> bytes:
    ch = 4 if alpha else 3
    stride = size * ch
    raw = bytearray()
    for row in range(size):
        raw.append(0)                                   # filter type 0 (None)
        raw.extend(buf[row * stride:(row + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6 if alpha else 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


# ------------------------------------------------------------------ source grid (coarse Open-Meteo data)
class Grid:
    """A coarse NxN field over a bbox: row-major, row0=north, col0=west. Bilinear sample, NODATA-honest."""
    def __init__(self, nx, ny, west, south, east, north, values):
        self.nx, self.ny = nx, ny
        self.west, self.south, self.east, self.north = west, south, east, north
        self.values = values

    def sample(self, lon: float, lat: float) -> Optional[float]:
        fx = (lon - self.west) / ((self.east - self.west) or 1) * (self.nx - 1)
        fy = (self.north - lat) / ((self.north - self.south) or 1) * (self.ny - 1)
        if fx < -0.001 or fx > self.nx - 1 + 0.001 or fy < -0.001 or fy > self.ny - 1 + 0.001:
            return None
        x0 = max(0, min(self.nx - 1, int(math.floor(fx))))
        y0 = max(0, min(self.ny - 1, int(math.floor(fy))))
        x1 = min(self.nx - 1, x0 + 1)
        y1 = min(self.ny - 1, y0 + 1)
        gx, gy = fx - x0, fy - y0
        v = self.values
        v00, v10 = v[y0 * self.nx + x0], v[y0 * self.nx + x1]
        v01, v11 = v[y1 * self.nx + x0], v[y1 * self.nx + x1]
        if None in (v00, v10, v01, v11):
            # nearest valid corner rather than NaN-propagate; fully-missing -> None
            cand = [c for c in (v00, v10, v01, v11) if c is not None]
            if not cand:
                return None
            return cand[0]
        return (v00 * (1 - gx) + v10 * gx) * (1 - gy) + (v01 * (1 - gx) + v11 * gx) * gy


# ------------------------------------------------------------------ caches + provider state
_grids: Dict[str, Tuple[Grid, float]] = {}
_grid_locks: Dict[str, asyncio.Lock] = {}
_tiles: "OrderedTileCache" = None  # set below
_cooldown_until = 0.0
_stats = {"openmeteo_calls": 0, "grid_hits": 0, "tile_hits": 0, "bakes": 0, "cooldowns": 0,
          "bundle_materializations": 0, "bundle_tiles_written": 0,
          "bundle_replay_hits": 0, "bundle_replay_misses": 0}
_om_sem: Optional[asyncio.Semaphore] = None       # bounds concurrent Open-Meteo calls (lazy: needs a loop)
_om_last = 0.0                                     # timestamp of the last call (for MIN_INTERVAL spacing)


class OrderedTileCache:
    """Tiny in-memory LRU of baked PNG bytes, mirrored to disk so restarts/offline keep coverage."""
    def __init__(self, cap: int):
        self.cap = cap
        self.mem: Dict[str, Tuple[bytes, float]] = {}
        self.order: List[str] = []

    def _disk(self, key: str) -> str:
        return os.path.join(CACHE_DIR, "tiles", key + ".png")

    def get(self, key: str) -> Optional[bytes]:
        now = time.time()
        v = self.mem.get(key)
        if v and now - v[1] <= TTL:
            return v[0]
        p = self._disk(key)
        try:
            if os.path.exists(p) and now - os.path.getmtime(p) <= TTL:
                data = open(p, "rb").read()
                self.put(key, data, persist=False)
                return data
        except OSError:
            pass
        return None

    def put(self, key: str, data: bytes, persist: bool = True):
        self.mem[key] = (data, time.time())
        self.order.append(key)
        while len(self.mem) > self.cap:
            old = self.order.pop(0)
            self.mem.pop(old, None)
        if persist:
            p = self._disk(key)
            try:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "wb") as f:
                    f.write(data)
            except OSError:
                pass


_tiles = OrderedTileCache(TILE_MEM_MAX)


def _coarse_cell(z: int, x: int, y: int) -> Tuple[int, int, int]:
    """The source-grid cell a tile bakes from — its ancestor at the COARSE FETCH_Z, so many tiles share
    one grid fetch ("fetch once, serve many"). At z <= FETCH_Z the tile is its own cell."""
    if z <= FETCH_Z:
        return z, x, y
    d = z - FETCH_Z
    return FETCH_Z, x >> d, y >> d


async def _fetch_grid(layer: str, cz: int, cx: int, cy: int) -> Grid:
    """Fetch ONE coarse Open-Meteo grid over a coarse cell (+small margin). Honest: raises on 429/error."""
    global _cooldown_until
    cfg = LAYERS[layer]
    w, s, e, n = tile_bounds(cz, cx, cy)
    mw, mh = (e - w) * 0.08, (n - s) * 0.08          # small overlap so child-tile edges interpolate cleanly
    w, e = w - mw, e + mw
    s, n = max(-85.0, s - mh), min(85.0, n + mh)
    lats, lons = [], []
    for j in range(GRID_N):
        lats.append(n - (n - s) * j / (GRID_N - 1))
    for i in range(GRID_N):
        lons.append(w + (e - w) * i / (GRID_N - 1))
    qlat, qlon = [], []
    for la in lats:
        for lo in lons:
            qlat.append(round(la, 3))                                      # 3dp keeps the URI short (HTTP 414 guard)
            qlon.append(round(((lo + 180) % 360 + 360) % 360 - 180, 3))   # wrap for the API (antimeridian-safe)
    params = {
        "latitude": ",".join(str(v) for v in qlat),
        "longitude": ",".join(str(v) for v in qlon),
        "current": cfg["v"],
    }
    if OPENMETEO_KEY:
        params["apikey"] = OPENMETEO_KEY
    if layer in ("wind", "gust"):
        params["wind_speed_unit"] = "kn"
    endpoint = MARINE if cfg.get("marine") else FORECAST   # waves/swell/sst/currents come from the Marine API
    # Be a polite client: cap concurrency + space calls, so a viewport's burst of cell-fetches doesn't
    # hammer Open-Meteo (what tripped the 429s before caching+throttling).
    global _om_sem, _om_last
    if _om_sem is None:
        _om_sem = asyncio.Semaphore(CONCURRENCY)
    async with _om_sem:
        gap = MIN_INTERVAL - (time.time() - _om_last)
        if gap > 0:
            await asyncio.sleep(gap)
        _om_last = time.time()
        _stats["openmeteo_calls"] += 1
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            r = await client.get(endpoint, params=params)
    if r.status_code == 429:
        _cooldown_until = time.time() + COOLDOWN
        _stats["cooldowns"] += 1
        raise RuntimeError("open-meteo 429 (hourly limit) — cooling down")
    r.raise_for_status()
    nodes = r.json()
    if not isinstance(nodes, list):
        nodes = [nodes]
    conv = cfg.get("conv")
    vals: List[Optional[float]] = []
    for node in nodes:
        cur = (node or {}).get("current") or {}
        v = cur.get(cfg["v"])
        if isinstance(v, (int, float)):
            vals.append(float(v) * KMH2KN if conv == "kmh2kn" else float(v))
        else:
            vals.append(None)                            # NODATA (land for an ocean-only layer) — never faked
    return Grid(GRID_N, GRID_N, lons[0], lats[-1], lons[-1], lats[0], vals)


async def get_grid(layer: str, cz: int, cx: int, cy: int) -> Grid:
    """Cached + deduped coarse grid. Serves stale on cooldown; one fetch per cell feeds many tiles."""
    key = "%s|z%d|%d|%d" % (layer, cz, cx, cy)
    now = time.time()
    hit = _grids.get(key)
    if hit and now - hit[1] <= TTL:
        _stats["grid_hits"] += 1
        return hit[0]
    if now < _cooldown_until:
        if hit:                                       # stale-but-present beats hammering a rate-limited API
            _stats["grid_hits"] += 1
            return hit[0]
        raise RuntimeError("rate-limited (cooldown) and no cached grid")
    lock = _grid_locks.setdefault(key, asyncio.Lock())
    async with lock:                                  # coalesce concurrent identical fetches
        hit = _grids.get(key)
        if hit and time.time() - hit[1] <= TTL:
            return hit[0]
        try:
            grid = await _fetch_grid(layer, cz, cx, cy)
        except Exception:
            if hit:
                return hit[0]                         # any failure -> serve stale if we can
            raise
        _grids[key] = (grid, time.time())
        return grid


# ---------------------------------------------------------------- dense REGIONAL ingestion (Windy parity)
# Fetch a HIGH-RES grid over the boat's region ONCE (batched), cache it, and bake every tile in that
# region from it -> native-resolution (Copernicus ~8 km) detail at EVERY zoom, like Windy's pre-baked CDN.
# Outside the region we fall back to the coarse on-demand path. A boat only needs its own area, and the
# region follows you (re-warm on a schedule). Same Open-Meteo data, no new deps, fits the keyed budget.
REGION_TTL = int(os.environ.get("HELM_WX_REGION_TTL", "10800"))    # 3 h (fields change slowly)
REGION_RES = float(os.environ.get("HELM_WX_REGION_RES", "0.1"))    # ~11 km sampling (~Copernicus native)
BUNDLE_SOURCE_POINT_BUDGET = int(os.environ.get("HELM_WX_BUNDLE_SOURCE_POINT_BUDGET", "2048"))
_regions: Dict[str, dict] = {}                                     # layer -> {bbox, grid, vel, t}
_region_lock = asyncio.Lock()


def _region_covers(reg, cz, cx, cy) -> bool:
    w, s, e, n = tile_bounds(cz, cx, cy)
    rw, rs, re_, rn = reg["bbox"]
    return rw <= w and re_ >= e and rs <= s and rn >= n


def _iso_hour_key(value: str) -> str:
    return (value or "").replace("Z", "")[:13]


def _node_for_valid_time(node: dict, cfg: dict, valid_time: Optional[str]) -> dict:
    """Return a current-shaped node, using hourly arrays when a forecast valid time was requested."""
    if not valid_time:
        return node or {}
    hourly = (node or {}).get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return node or {}
    target = _iso_hour_key(valid_time)
    idx = None
    for i, t in enumerate(times):
        if _iso_hour_key(str(t)) == target:
            idx = i
            break
    if idx is None:
        return node or {}
    cur = {}
    for key in (cfg.get("v"), cfg.get("dir")):
        if not key:
            continue
        vals = hourly.get(key) or []
        if idx < len(vals):
            cur[key] = vals[idx]
    return {"current": cur}


async def _fetch_points(layer: str, qlat, qlon, valid_time: Optional[str] = None):
    """One batched (<=~140-pt) Open-Meteo request -> list of nodes. Throttled + keyed; raises on 429."""
    global _om_sem, _om_last, _cooldown_until
    cfg = LAYERS[layer]
    cur = cfg["v"] + ("," + cfg["dir"] if cfg.get("dir") else "")
    params = {"latitude": ",".join(str(round(a, 3)) for a in qlat),
              "longitude": ",".join(str(round(((o + 180) % 360 + 360) % 360 - 180, 3)) for o in qlon)}
    if valid_time:
        params.update({"hourly": cur, "timezone": "UTC", "forecast_hours": "24"})
    else:
        params["current"] = cur
    if not cfg.get("marine"):
        params["wind_speed_unit"] = "kn"
    if OPENMETEO_KEY:
        params["apikey"] = OPENMETEO_KEY
    endpoint = MARINE if cfg.get("marine") else FORECAST
    if _om_sem is None:
        _om_sem = asyncio.Semaphore(CONCURRENCY)
    async with _om_sem:
        gap = MIN_INTERVAL - (time.time() - _om_last)
        if gap > 0:
            await asyncio.sleep(gap)
        _om_last = time.time()
        _stats["openmeteo_calls"] += 1
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            r = await client.get(endpoint, params=params)
    if r.status_code == 429:
        _cooldown_until = time.time() + COOLDOWN
        raise RuntimeError("open-meteo 429")
    r.raise_for_status()
    nodes = r.json()
    rows = nodes if isinstance(nodes, list) else [nodes]
    return [_node_for_valid_time(node, cfg, valid_time) for node in rows]


async def warm_region(layer: str, w: float, s: float, e: float, n: float, res: float = REGION_RES,
                      valid_time: Optional[str] = None):
    """Ingest a dense grid over (w,s,e,n) into _regions[layer] — the source for Windy-parity tiles there."""
    cfg = LAYERS[layer]
    conv = cfg.get("conv"); sign = 1.0 if cfg.get("dir_to") else -1.0; D2R = math.pi / 180.0
    nx = max(2, int(round((e - w) / res)) + 1)
    ny = max(2, int(round((n - s) / res)) + 1)
    lats = [n - (n - s) * j / (ny - 1) for j in range(ny)]
    lons = [w + (e - w) * i / (nx - 1) for i in range(nx)]
    pts = [(j, i) for j in range(ny) for i in range(nx)]
    vals: List[Optional[float]] = [None] * (nx * ny)
    us = [0.0] * (nx * ny); vs = [0.0] * (nx * ny)
    BATCH = 140
    failed = 0

    async def do_batch(chunk):
        nonlocal failed
        try:
            nodes = await _fetch_points(layer, [lats[j] for (j, i) in chunk],
                                        [lons[i] for (j, i) in chunk],
                                        valid_time=valid_time)
        except Exception:
            failed += 1            # one bad batch (e.g. a transient 429 on a cold-start burst) must NOT
            return                 # sink the whole region warm — leave its points NODATA, keep the rest
        for k, (j, i) in enumerate(chunk):
            c = (nodes[k] or {}).get("current") or {}
            v = c.get(cfg["v"])
            if isinstance(v, (int, float)):
                vv = float(v) * KMH2KN if conv == "kmh2kn" else float(v)
                vals[j * nx + i] = vv
                if cfg.get("dir"):
                    d = c.get(cfg["dir"]); d = float(d) if isinstance(d, (int, float)) else 0.0
                    us[j * nx + i] = sign * vv * math.sin(d * D2R)
                    vs[j * nx + i] = sign * vv * math.cos(d * D2R)

    batches = [pts[b:b + BATCH] for b in range(0, len(pts), BATCH)]
    await asyncio.gather(*[do_batch(c) for c in batches])
    valid = sum(1 for v in vals if v is not None)
    reg = {"bbox": (w, s, e, n), "grid": Grid(nx, ny, lons[0], lats[-1], lons[-1], lats[0], vals), "t": time.time()}
    if cfg.get("vector"):
        hdr = {"nx": nx, "ny": ny, "lo1": lons[0], "la1": lats[0], "lo2": lons[-1], "la2": lats[-1],
               "dx": (lons[-1] - lons[0]) / (nx - 1), "dy": (lats[0] - lats[-1]) / (ny - 1)}
        reg["vel"] = [{"header": dict(parameterNumber=2, **hdr), "data": us},
                      {"header": dict(parameterNumber=3, **hdr), "data": vs}]
    _regions[layer] = reg
    # Invalidate this layer's already-baked tiles so they re-bake from the dense grid (else cache wins).
    import shutil
    for k in [k for k in _tiles.order if k.startswith(layer + "/")]:
        _tiles.mem.pop(k, None)
    _tiles.order = [k for k in _tiles.order if not k.startswith(layer + "/")]
    shutil.rmtree(os.path.join(CACHE_DIR, "tiles", layer), ignore_errors=True)
    for k in [k for k in list(_vel) if k.startswith("vel|" + layer + "|")]:
        _vel.pop(k, None)
    return {"layer": layer, "nx": nx, "ny": ny, "points": nx * ny, "valid": valid,
            "failed_batches": failed, "batches": len(batches), "res_deg": res, "bbox": [w, s, e, n]}


async def bake_tile(layer: str, z: int, x: int, y: int) -> bytes:
    """Bake (or cache-hit) one helm-wxv1 value tile. PNG bytes, 256x256 RGBA."""
    return await _bake_tile_impl(layer, z, x, y)


SMOOTH_PASSES = int(os.environ.get("HELM_WX_SMOOTH", "2"))   # display-only field blur (0 = off) — Windy-style silk


def _blur_grid_np(gv, passes):
    """NaN-aware separable [1,2,1] blur (~Gaussian), `passes` times — DISPLAY-ONLY smoothing so the
    coarse ~11km field reads silky (Windy-like) instead of showing grid cells. NODATA contributes 0
    weight; edges replicate (no dateline wrap). The value PROBE uses the RAW grid, never this."""
    m = (~np.isnan(gv)).astype(np.float64)
    v = np.where(np.isnan(gv), 0.0, gv) * m
    for _ in range(passes):
        for ax in (0, 1):
            pad = [(0, 0), (0, 0)]; pad[ax] = (1, 1)
            vp = np.pad(v, pad, mode='edge'); mp = np.pad(m, pad, mode='edge')
            lo = [slice(None), slice(None)]; hi = [slice(None), slice(None)]
            lo[ax] = slice(0, -2); hi[ax] = slice(2, None)
            v = vp[tuple(lo)] + 2.0 * v + vp[tuple(hi)]
            m = mp[tuple(lo)] + 2.0 * m + mp[tuple(hi)]
    out = np.full(gv.shape, np.nan)
    nz = m > 1e-9
    out[nz] = v[nz] / m[nz]
    return out


def _bake_np(grid: "Grid", lons, lats, scale: float, offset: float):
    """Vectorised bilinear sample + helm-wxv1 encode of a 256x256 tile. Returns (rgba_bytes, any_valid).
    NaN (NODATA — land for ocean layers, gaps) -> alpha 0; never faked."""
    nx, ny = grid.nx, grid.ny
    gv = np.array([np.nan if v is None else v for v in grid.values], dtype=np.float64).reshape(ny, nx)
    if SMOOTH_PASSES and nx > 2 and ny > 2:
        gv = _blur_grid_np(gv, SMOOTH_PASSES)   # smooth the field for display (Windy-style); probe uses raw grid
    ew = (grid.east - grid.west) or 1.0
    ns = (grid.north - grid.south) or 1.0
    fx_raw = (lons - grid.west) / ew * (nx - 1)
    fy_raw = (grid.north - lats) / ns * (ny - 1)
    inside_x = (fx_raw >= -0.001) & (fx_raw <= nx - 1 + 0.001)
    inside_y = (fy_raw >= -0.001) & (fy_raw <= ny - 1 + 0.001)
    fx = np.clip(fx_raw, 0, nx - 1)
    fy = np.clip(fy_raw, 0, ny - 1)
    x0 = np.floor(fx).astype(np.intp); x1 = np.minimum(x0 + 1, nx - 1)
    y0 = np.floor(fy).astype(np.intp); y1 = np.minimum(y0 + 1, ny - 1)
    gx = fx - x0; gy = fy - y0
    X0, Y0 = np.meshgrid(x0, y0); X1, Y1 = np.meshgrid(x1, y1)
    GX, GY = np.meshgrid(gx, gy)
    v00 = gv[Y0, X0]; v10 = gv[Y0, X1]; v01 = gv[Y1, X0]; v11 = gv[Y1, X1]
    # NaN-aware bilinear: a NODATA corner (land for an ocean layer) contributes 0 weight, so ocean pixels
    # next to the coast still render from the valid corners; only an all-NODATA cell stays transparent.
    w00 = (1 - GX) * (1 - GY) * (~np.isnan(v00)); w10 = GX * (1 - GY) * (~np.isnan(v10))
    w01 = (1 - GX) * GY * (~np.isnan(v01)); w11 = GX * GY * (~np.isnan(v11))
    den = w00 + w10 + w01 + w11
    num = (np.nan_to_num(v00) * w00 + np.nan_to_num(v10) * w10
           + np.nan_to_num(v01) * w01 + np.nan_to_num(v11) * w11)
    valid = (den > 0) & inside_y[:, None] & inside_x[None, :]
    val = num / np.where(valid, den, 1.0)
    s = scale if scale > 0 else 1.0
    n = np.clip(np.round((np.nan_to_num(val) - offset) / s), 0, VMAX24).astype(np.uint32)
    rgba = np.empty((256, 256, 4), dtype=np.uint8)
    rgba[..., 0] = (n >> 16) & 255
    rgba[..., 1] = (n >> 8) & 255
    rgba[..., 2] = n & 255
    rgba[..., 3] = np.where(valid, 255, 0).astype(np.uint8)
    return rgba.tobytes(), bool(valid.any())


async def _bake_tile_impl(layer: str, z: int, x: int, y: int) -> bytes:
    key = "%s/%d/%d/%d" % (layer, z, x, y)
    cached = _tiles.get(key)
    if cached is not None:
        _stats["tile_hits"] += 1
        return cached
    cfg = LAYERS[layer]
    scale, offset = layer_scale_offset(cfg)
    reg = _regions.get(layer)
    if reg and (time.time() - reg["t"]) <= REGION_TTL and _region_covers(reg, z, x, y):
        grid = reg["grid"]                               # dense regional grid covers this TILE -> native detail
    else:
        cz, cx, cy = _coarse_cell(z, x, y)
        grid = await get_grid(layer, cz, cx, cy)
    # Per-column lon, per-row lat (512 mercator unprojects, not 65 536), then VECTORISE the whole 256x256
    # bilinear+encode in numpy (was a multi-second Python loop -> a few ms). NODATA (NaN) stays transparent.
    lons = np.array([pixel_to_lonlat(z, x, y, px + 0.5, 0.0)[0] for px in range(256)])
    lats = np.array([pixel_to_lonlat(z, x, y, 0.0, py + 0.5)[1] for py in range(256)])
    buf, any_valid = _bake_np(grid, lons, lats, scale, offset)
    png = write_png_bytes(buf, 256, alpha=True)
    _stats["bakes"] += 1
    if any_valid:
        _tiles.put(key, png)                          # don't pollute cache with all-NODATA tiles
    return png


def manifest_for(layer: str) -> dict:
    cfg = LAYERS[layer]
    scale, offset = layer_scale_offset(cfg)
    return {
        "encoding": ENCODING, "bits": 24, "tileSize": 256,
        "layer": layer, "unit": cfg["unit"], "kind": "scalar",
        "scale": scale, "offset": offset, "nodata_alpha": 0, "has_alpha": True,
        "minzoom": 0, "maxzoom": DATA_Z_MAX,
        "bbox": [-180.0, -85.0, 180.0, 85.0],         # global — the gateway serves anywhere
        "global": True,                                # tells cog.js NOT to set source bounds (wrap across the dateline)
        "vmin": cfg["vmin"], "vmax": cfg["vmax"], "ramp": cfg["stops"],
        "source": "open-meteo", "model": MARINE_MODEL if cfg.get("marine") else MODEL_NAME,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "times": None, "frames": None,
        "tiles_template": "{z}/{x}/{y}.png",
        "horizon": "good ~0–7 d; beyond is climatology", "confidence": "fair",
        "disclaimer": "Forecast — cross-reference official sources. NOT FOR NAVIGATION.",
    }


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_iso_utc(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _iso_from_dt(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _compact_time_id(value: str) -> str:
    return _parse_iso_utc(value).strftime("%Y%m%dT%H%M%SZ")


def _parse_frame_offsets(frame_hours: str, frame_count: int) -> List[int]:
    if frame_count < 1:
        frame_count = 1
    offsets: List[int] = []
    for raw in (frame_hours or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        offsets.append(int(round(float(raw) * 3600)))
    if not offsets:
        step = int(round(DEFAULT_BUNDLE_FRAME_STEP_HOURS * 3600))
        offsets = [i * step for i in range(frame_count)]
    while len(offsets) < frame_count:
        step = int(round(DEFAULT_BUNDLE_FRAME_STEP_HOURS * 3600))
        offsets.append(offsets[-1] + step)
    return offsets[:frame_count]


def _bundle_frames(generated_at: str, frame_count: int = 1, frame_hours: str = "") -> List[dict]:
    base = _parse_iso_utc(generated_at)
    offsets = _parse_frame_offsets(frame_hours, frame_count)
    multi = len(offsets) > 1
    frames = []
    for i, seconds in enumerate(offsets):
        valid_time = _iso_from_dt(base + timedelta(seconds=seconds))
        frames.append({
            "validTime": valid_time,
            "time": valid_time,
            "validTimeId": _compact_time_id(valid_time) if multi else BUNDLE_VALID_TIME_ID,
            "offsetSeconds": seconds,
            "isLatest": i == 0,
            "latest": i == 0,
        })
    return frames


def _warm_region_hint() -> Optional[dict]:
    raw = os.environ.get("HELM_WX_WARM_BBOX", "").strip()
    if not raw:
        return None
    try:
        w, s, e, n = [float(x) for x in raw.split(",")]
    except Exception:
        return None
    return {
        "bbox": [w, s, e, n],
        "layers": [x.strip() for x in os.environ.get("HELM_WX_WARM_LAYERS", "current,wind").split(",") if x.strip()],
        "resolutionDegrees": REGION_RES,
        "ttlSeconds": REGION_TTL,
    }


def _registered_warm_regions() -> List[dict]:
    out = []
    now = time.time()
    for layer, reg in sorted(_regions.items()):
        w, s, e, n = reg["bbox"]
        out.append({
            "layer": layer,
            "bbox": [w, s, e, n],
            "ageSeconds": max(0, int(now - reg["t"])),
            "ttlSeconds": REGION_TTL,
            "grid": {"nx": reg["grid"].nx, "ny": reg["grid"].ny},
            "hasVector": bool(reg.get("vel")),
        })
    return out


def s100_ref_for(layer: str) -> dict:
    ref = S100_LAYER_REFS.get(layer, {})
    return {
        "aligned": True,
        "officialProduct": False,
        "advisorySource": "open-meteo",
        "productIdentifier": ref.get("productIdentifier"),
        "productName": ref.get("productName"),
        "role": ref.get("role"),
        "posture": (
            "Metadata is shaped for S-100-family adapters, but this Open-Meteo layer is not an "
            "official S-100 dataset and must stay labelled advisory/not-for-navigation."
        ),
    }


def bundle_layer_for(layer: str) -> dict:
    cfg = LAYERS[layer]
    scalar_manifest = manifest_for(layer)
    layer_bundle = {
        "id": layer,
        "kind": "vector" if cfg.get("vector") else "scalar",
        "unit": cfg["unit"],
        "source": "open-meteo-marine" if cfg.get("marine") else "open-meteo-forecast",
        "model": MARINE_MODEL if cfg.get("marine") else MODEL_NAME,
        "providerVariable": cfg["v"],
        "directionVariable": cfg.get("dir"),
        "valueEncoding": {
            "encoding": ENCODING,
            "bits": scalar_manifest["bits"],
            "scale": scalar_manifest["scale"],
            "offset": scalar_manifest["offset"],
            "nodataAlpha": scalar_manifest["nodata_alpha"],
            "hasAlpha": scalar_manifest["has_alpha"],
        },
        "range": {"min": cfg["vmin"], "max": cfg["vmax"], "unit": cfg["unit"]},
        "ramp": cfg["stops"],
        "fieldTiles": {
            "type": "value-raster-tile",
            "tileMatrixSet": "WebMercatorQuad",
            "tileSize": 256,
            "minzoom": 0,
            "maxzoom": DATA_Z_MAX,
            "urlTemplate": f"/{layer}/{{z}}/{{x}}/{{y}}.png",
            "relativeTemplate": f"{layer}/{{z}}/{{x}}/{{y}}.png",
        },
        "displayTiles": {
            "optional": True,
            "status": "not-materialized-yet",
            "reason": "WX-19 should render colours/particles client-side from numeric field tiles.",
        },
        "s100": s100_ref_for(layer),
        "probe": {
            "sample": f"{layer}.sample(lon,lat,validTime)",
            "returns": ["value", "unit", "sourceRef", "freshness", "confidence", "coverage"],
        },
        "disclaimer": "Forecast — cross-reference official sources. NOT FOR NAVIGATION.",
    }
    if cfg.get("vector"):
        layer_bundle["vectorField"] = {
            "type": "bbox-json-compatibility",
            "components": ["u", "v"],
            "speedUnit": cfg["unit"],
            "directionConvention": "toward" if cfg.get("dir_to") else "from",
            "urlTemplate": f"/velocity/{layer}?w={{west}}&s={{south}}&e={{east}}&n={{north}}",
            "cacheKey": "snapped-bbox",
            "preparedComponentTiles": {
                "status": "planned-for-WX-18",
                "type": "component-tiles",
                "u": {
                    "encoding": ENCODING,
                    "range": {"min": -float(cfg["vmax"]), "max": float(cfg["vmax"])},
                    "urlTemplate": f"layers/{layer}/vector/{{validTimeId}}/u/{{z}}/{{x}}/{{y}}.png",
                },
                "v": {
                    "encoding": ENCODING,
                    "range": {"min": -float(cfg["vmax"]), "max": float(cfg["vmax"])},
                    "urlTemplate": f"layers/{layer}/vector/{{validTimeId}}/v/{{z}}/{{x}}/{{y}}.png",
                },
            },
        }
    return layer_bundle


def environment_bundle_manifest() -> dict:
    warm_hint = _warm_region_hint()
    return {
        "schema": BUNDLE_SCHEMA,
        "bundleId": BUNDLE_ID,
        "title": BUNDLE_TITLE,
        "productFamily": "met-ocean",
        "encoding": ENCODING,
        "generatedAt": _now_iso(),
        "source": {
            "provider": "open-meteo",
            "licensing": "caller must verify production/commercial terms separately",
            "forecastEndpoint": FORECAST,
            "marineEndpoint": MARINE,
            "advisoryOnly": True,
        },
        "run": {
            "mode": "latest-frame-compatibility",
            "model": MODEL_NAME,
            "marineModel": MARINE_MODEL,
            "runTime": None,
            "runLabel": "latest",
            "validTimes": [],
            "frames": 1,
            "future": "WX-18 materializes real model-run times from prepared regional/global bundles.",
        },
        "coverage": {
            "crs": "OGC:CRS84",
            "bbox": [-180.0, -85.0, 180.0, 85.0],
            "global": True,
            "wrap": "antimeridian",
            "defaultWarmRegion": warm_hint,
            "registeredWarmRegions": _registered_warm_regions(),
        },
        "lod": {
            "tileMatrixSet": "WebMercatorQuad",
            "tileSize": 256,
            "dataMaxZoom": DATA_Z_MAX,
            "fetchZoom": FETCH_Z,
            "levels": {
                "overview": {"minzoom": 0, "maxzoom": min(2, DATA_Z_MAX), "purpose": "instant whole-ocean view"},
                "basin": {"minzoom": 3, "maxzoom": min(FETCH_Z, DATA_Z_MAX), "purpose": "passage-scale planning"},
                "regional": {"minzoom": min(FETCH_Z + 1, DATA_Z_MAX), "maxzoom": DATA_Z_MAX,
                             "purpose": "boat-region native grid detail"},
            },
            "parentFallback": True,
            "overzoom": "renderer may overzoom cached parent/native tiles beyond dataMaxZoom without upstream fetches",
        },
        "cachePolicy": {
            "targetInvariant": "pan, zoom, scrub, and layer toggles read prepared local/cache data only",
            "upstreamFetchesAllowedDuringGesture": False,
            "refreshOnly": True,
            "currentCompatibility": (
                "Existing value-tile endpoints may fetch on cache miss until WX-18 moves upstream ingest "
                "to a model-run bundle baker."
            ),
            "ttlSeconds": TTL,
            "cooldownSeconds": COOLDOWN,
            "regionTtlSeconds": REGION_TTL,
            "regionResolutionDegrees": REGION_RES,
            "gridPointsPerFetchCell": GRID_N,
            "concurrency": CONCURRENCY,
            "minIntervalSeconds": MIN_INTERVAL,
        },
        "renderPolicy": {
            "renderer": "client-webgpu-or-webgl-field-scene",
            "scalarColour": "colourise from numeric field tiles using fixed per-layer ramps",
            "particles": "animate vector layers from uv-grid fields using the same bundle/time/coverage",
            "displayTiles": "optional CDN/cache artifact, never the primary data contract",
            "nodata": "alpha=0; never fabricate weather values",
        },
        "sampleContract": {
            "schema": "helm.layer.sample.v1",
            "requiredFields": ["value", "unit", "sourceRef", "freshness", "confidence", "coverage", "advisory"],
            "routeWeather": "sample layer values along worldline W(position,time)",
        },
        "layers": {layer: bundle_layer_for(layer) for layer in BUNDLE_LAYER_ORDER if layer in LAYERS},
        "disclaimer": "Forecast/advisory met-ocean data. Cross-reference official sources. NOT FOR NAVIGATION.",
    }


def bundle_index() -> dict:
    prepared = discover_prepared_bundles()
    return {
        "schema": "helm.env.bundle.index.v1",
        "generatedAt": _now_iso(),
        "bundles": [{
            "id": BUNDLE_ID,
            "title": BUNDLE_TITLE,
            "kind": "environmental-bundle",
            "schema": BUNDLE_SCHEMA,
            "manifest": "/bundles/open-meteo/latest/manifest.json",
            "coverage": "global-with-regional-warm-cache",
            "layers": list(BUNDLE_LAYER_ORDER),
            "validTimes": [BUNDLE_VALID_TIME_ID],
            "runTime": BUNDLE_VALID_TIME_ID,
            "model": MODEL_NAME,
            "cacheOnlyReplay": False,
            "upstreamFetchesAllowedDuringGesture": False,
            "sample": {"probeHandle": "weather.bundle", "contract": "sample(lat, lon, t)"},
            "advisoryOnly": True,
            "offlineReady": False,
        }] + prepared,
    }


def _safe_segment(value: str, default: str = "bundle") -> str:
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value or default))
    text = "-".join(part for part in text.split("-") if part)
    return text or default


def _prepared_bundle_root(region_id: str) -> str:
    return os.path.join(CACHE_DIR, "env", "bundles", BUNDLE_PROVIDER, BUNDLE_MODEL_ID,
                        _safe_segment(region_id, DEFAULT_PREPARED_REGION))


def _prepared_bundle_manifest_path(region_id: str) -> str:
    return os.path.join(_prepared_bundle_root(region_id), "manifest.json")


def _prepared_bundle_url(region_id: str) -> str:
    rid = _safe_segment(region_id, DEFAULT_PREPARED_REGION)
    return f"/bundles/{BUNDLE_PROVIDER}/{BUNDLE_MODEL_ID}/{rid}/manifest.json"


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _coverage_bbox(w: float, s: float, e: float, n: float) -> dict:
    return {
        "west": float(w),
        "south": float(s),
        "east": float(e),
        "north": float(n),
        "crossesAntimeridian": float(e) < float(w),
    }


def _internal_bbox(w: float, s: float, e: float, n: float) -> Tuple[float, float, float, float]:
    """Return a continuous-longitude bbox suitable for source grids."""
    return float(w), float(s), (float(e) + 360.0 if float(e) < float(w) else float(e)), float(n)


def _source_grid_shape(w: float, s: float, e: float, n: float, res: float) -> Tuple[int, int, int]:
    if res <= 0:
        raise ValueError("res must be > 0")
    nx = max(2, int(round((float(e) - float(w)) / res)) + 1)
    ny = max(2, int(round((float(n) - float(s)) / res)) + 1)
    return nx, ny, nx * ny


def _fit_source_resolution(w: float, s: float, e: float, n: float,
                           requested_res: float, point_budget: int = BUNDLE_SOURCE_POINT_BUDGET) -> dict:
    """Bound provider fan-out for explicit materialize jobs.

    Tight regional bboxes keep the requested/native resolution. Wide overview bboxes, especially
    Fiji/South-Pacific antimeridian coverage, are source-coarsened so a warm job cannot turn into
    thousands of Open-Meteo requests while baking only a handful of low-zoom tiles.
    """
    requested = float(requested_res)
    budget = max(4, int(point_budget))
    nx, ny, points = _source_grid_shape(w, s, e, n, requested)
    if points <= budget:
        return {"requested": requested, "effective": requested, "nx": nx, "ny": ny,
                "points": points, "pointBudget": budget, "adjusted": False}

    span_lon = max(0.0, float(e) - float(w))
    span_lat = max(0.0, float(n) - float(s))
    effective = max(requested, math.sqrt(max(span_lon * span_lat, requested * requested) / budget))
    nx, ny, points = _source_grid_shape(w, s, e, n, effective)
    while points > budget:
        effective *= 1.05
        nx, ny, points = _source_grid_shape(w, s, e, n, effective)
    return {"requested": requested, "effective": effective, "nx": nx, "ny": ny,
            "points": points, "pointBudget": budget, "adjusted": True}


def _bbox_parts(w: float, s: float, e: float, n: float) -> List[Tuple[float, float, float, float]]:
    if e < w:
        return [(w, s, 180.0, n), (-180.0, s, e, n)]
    return [(w, s, e, n)]


def _tile_coords_for_bbox(z: int, w: float, s: float, e: float, n: float) -> Set[Tuple[int, int, int]]:
    max_i = 2 ** z - 1
    out: Set[Tuple[int, int, int]] = set()
    for pw, ps, pe, pn in _bbox_parts(w, s, e, n):
        x0, y0 = lonlat_to_tile(pw, pn, z)
        x1, y1 = lonlat_to_tile(pe, ps, z)
        xmin = max(0, min(max_i, int(math.floor(min(x0, x1)))))
        xmax = max(0, min(max_i, int(math.ceil(max(x0, x1)) - 1)))
        ymin = max(0, min(max_i, int(math.floor(min(y0, y1)))))
        ymax = max(0, min(max_i, int(math.ceil(max(y0, y1)) - 1)))
        for x in range(xmin, xmax + 1):
            for y in range(ymin, ymax + 1):
                out.add((z, x, y))
    return out


def _tile_axes_for_grid(z: int, x: int, y: int, grid: "Grid"):
    lons = np.array([pixel_to_lonlat(z, x, y, px + 0.5, 0.0)[0] for px in range(256)])
    if grid.east > 180.0:
        # Continuous antimeridian regions are stored as e.g. 160..210. Shift negative tile longitudes
        # into that frame so Fiji/South-Pacific prepared bundles do not vanish east of 180.
        lons = np.where(lons < grid.west, lons + 360.0, lons)
    lats = np.array([pixel_to_lonlat(z, x, y, 0.0, py + 0.5)[1] for py in range(256)])
    return lons, lats


def _bake_grid_tile(grid: "Grid", z: int, x: int, y: int, scale: float, offset: float) -> Tuple[bytes, bool]:
    lons, lats = _tile_axes_for_grid(z, x, y, grid)
    buf, any_valid = _bake_np(grid, lons, lats, scale, offset)
    return write_png_bytes(buf, 256, alpha=True), any_valid


def _vector_component_scale_offset(cfg: dict) -> Tuple[float, float]:
    vmax = float(cfg["vmax"])
    return (2.0 * vmax / VMAX24 if vmax > 0 else 1.0), -vmax


def _vector_component_grid(reg: dict, component: str) -> Optional[Grid]:
    idx = 0 if component == "u" else 1 if component == "v" else None
    if idx is None or not reg.get("vel") or len(reg["vel"]) <= idx:
        return None
    item = reg["vel"][idx]
    hdr = item["header"]
    return Grid(int(hdr["nx"]), int(hdr["ny"]), float(hdr["lo1"]), float(hdr["la2"]),
                float(hdr["lo2"]), float(hdr["la1"]), item["data"])


def _write_bytes(path: str, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _write_json(path: str, data: dict):
    _write_bytes(path, (json.dumps(data, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return None


def _prepared_tile_path(region_id: str, layer: str, family: str, valid_time_id: str,
                        z: int, x: int, y: int, component: Optional[str] = None) -> str:
    root = _prepared_bundle_root(region_id)
    if family == "scalar":
        return os.path.join(root, "layers", layer, "scalar", valid_time_id, str(z), str(x), f"{y}.png")
    return os.path.join(root, "layers", layer, "vector", valid_time_id, component or "u", str(z), str(x), f"{y}.png")


def _parse_layers(layers: str) -> List[str]:
    out = []
    for layer in [x.strip() for x in str(layers or "").split(",") if x.strip()]:
        if layer not in LAYERS:
            raise ValueError("unknown layer: " + layer)
        if layer not in out:
            out.append(layer)
    return out or ["wind", "current"]


def _parse_route_bbox(route: str, margin_deg: float) -> Optional[Tuple[float, float, float, float]]:
    if not route:
        return None
    pts = []
    for item in route.split(";"):
        if not item.strip():
            continue
        parts = [p.strip() for p in item.split(",")]
        if len(parts) != 2:
            raise ValueError("route must be lon,lat;lon,lat")
        pts.append((float(parts[0]), float(parts[1])))
    if not pts:
        return None
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    plain_span = max(lons) - min(lons)
    shifted = [lon + 360.0 if lon < 0 else lon for lon in lons]
    shifted_span = max(shifted) - min(shifted)
    if shifted_span < plain_span:
        w = min(shifted) - margin_deg
        e = max(shifted) + margin_deg
        if e > 180.0:
            e -= 360.0
        if w > 180.0:
            w -= 360.0
    else:
        w = min(lons) - margin_deg
        e = max(lons) + margin_deg
    s = max(-85.0, min(lats) - margin_deg)
    n = min(85.0, max(lats) + margin_deg)
    return max(-180.0, w), s, min(180.0, e), n


def _planned_tile_count(layers: List[str], w: float, s: float, e: float, n: float, minzoom: int,
                        maxzoom: int, frame_count: int = 1) -> int:
    coords = []
    for z in range(minzoom, maxzoom + 1):
        coords.extend(_tile_coords_for_bbox(z, w, s, e, n))
    per_scalar = len(set(coords))
    total = 0
    for layer in layers:
        total += per_scalar
        if LAYERS[layer].get("vector"):
            total += per_scalar * 2
    return total * max(1, frame_count)


def _planned_source_summary(layers: List[str], w: float, s: float, e: float, n: float, res: float) -> dict:
    iw, is_, ie, in_ = _internal_bbox(w, s, e, n)
    fit = _fit_source_resolution(iw, is_, ie, in_, res)
    return {
        "requestedResolutionDegrees": fit["requested"],
        "effectiveResolutionDegrees": fit["effective"],
        "sourcePointsPerLayer": fit["points"],
        "sourcePointBudget": fit["pointBudget"],
        "sourceResolutionAdjusted": fit["adjusted"],
        "layers": len(layers),
    }


def _prepared_layer_for(region_id: str, layer: str, minzoom: int, maxzoom: int) -> dict:
    info = bundle_layer_for(layer)
    base = f"/bundles/{BUNDLE_PROVIDER}/{BUNDLE_MODEL_ID}/{_safe_segment(region_id, DEFAULT_PREPARED_REGION)}"
    info["fieldTiles"] = {
        "type": "value-raster-tile",
        "tileMatrixSet": "WebMercatorQuad",
        "tileSize": 256,
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "urlTemplate": f"{base}/layers/{layer}/scalar/{{validTimeId}}/{{z}}/{{x}}/{{y}}.png",
        "relativeTemplate": f"layers/{layer}/scalar/{{validTimeId}}/{{z}}/{{x}}/{{y}}.png",
    }
    if LAYERS[layer].get("vector"):
        cfg = LAYERS[layer]
        scale, offset = _vector_component_scale_offset(cfg)
        info["vectorField"] = {
            "type": "component-tiles",
            "components": ["u", "v"],
            "speedUnit": cfg["unit"],
            "directionConvention": "toward" if cfg.get("dir_to") else "from",
            "u": {"encoding": ENCODING, "scale": scale, "offset": offset, "unit": cfg["unit"],
                  "range": {"min": offset, "max": -offset},
                  "urlTemplate": f"{base}/layers/{layer}/vector/{{validTimeId}}/u/{{z}}/{{x}}/{{y}}.png"},
            "v": {"encoding": ENCODING, "scale": scale, "offset": offset, "unit": cfg["unit"],
                  "range": {"min": offset, "max": -offset},
                  "urlTemplate": f"{base}/layers/{layer}/vector/{{validTimeId}}/v/{{z}}/{{x}}/{{y}}.png"},
        }
    return info


def _prepared_manifest(region_id: str, layers: List[str], w: float, s: float, e: float, n: float,
                       minzoom: int, maxzoom: int, generated_at: str, frames: List[dict], tile_summary: dict,
                       upstream_calls: int, route: str = "", source_summary: Optional[dict] = None) -> dict:
    region_slug = _safe_segment(region_id, DEFAULT_PREPARED_REGION)
    valid_times = [f["validTime"] for f in frames]
    frame_id_by_valid_time = {f["validTime"]: f["validTimeId"] for f in frames}
    time_step = None
    if len(frames) > 1:
        steps = [frames[i + 1]["offsetSeconds"] - frames[i]["offsetSeconds"] for i in range(len(frames) - 1)]
        if steps and all(step == steps[0] for step in steps):
            time_step = steps[0]
    return {
        "schema": BUNDLE_SCHEMA,
        "bundleId": f"{BUNDLE_PROVIDER}/{BUNDLE_MODEL_ID}/{region_slug}",
        "title": f"Open-Meteo prepared environmental bundle · {region_slug}",
        "productFamily": "met-ocean",
        "encoding": ENCODING,
        "generatedAt": generated_at,
        "source": {
            "provider": "open-meteo",
            "modelAuthority": "advisory",
            "forecastEndpoint": FORECAST,
            "marineEndpoint": MARINE,
            "advisoryOnly": True,
            "notForNavigation": True,
        },
        "run": {
            "mode": "model-run-cache",
            "model": MODEL_NAME,
            "marineModel": MARINE_MODEL,
            "runTime": generated_at,
            "runLabel": BUNDLE_MODEL_ID,
            "validTimes": valid_times,
            "frameIdByValidTime": frame_id_by_valid_time,
            "frames": len(frames),
            "timeStepSeconds": time_step,
            "latestValidTime": valid_times[0] if valid_times else None,
        },
        "frames": frames,
        "coverage": {
            "crs": "OGC:CRS84",
            "bbox": _coverage_bbox(w, s, e, n),
            "polygon": None,
            "global": False,
            "wrap": "antimeridian" if e < w else "none",
            "regionId": region_slug,
            "route": route or None,
        },
        "lod": {
            "tileMatrixSet": "WebMercatorQuad",
            "tileSize": 256,
            "dataMinZoom": minzoom,
            "dataMaxZoom": maxzoom,
            "levels": {
                "overview": {"minzoom": minzoom, "maxzoom": min(2, maxzoom), "purpose": "instant overview"},
                "basin": {"minzoom": min(maxzoom, 3), "maxzoom": min(maxzoom, 5), "purpose": "passage planning"},
                "regional": {"minzoom": min(maxzoom, 6), "maxzoom": maxzoom, "purpose": "local detail"},
            },
            "parentFallback": True,
            "overzoom": "renderer may overzoom prepared parent/native field tiles beyond dataMaxZoom",
            "interpolation": "bilinear-in-field-space",
        },
        "cachePolicy": {
            "targetInvariant": "pan, zoom, scrub, and layer toggles read prepared local/cache data only",
            "upstreamFetchesAllowedDuringGesture": False,
            "refreshOnly": True,
            "cacheOnlyReplay": True,
            "ttlSeconds": REGION_TTL,
            "staleServing": True,
            "staleMaxSeconds": max(REGION_TTL, TTL) * 8,
            "providerBackoffSeconds": COOLDOWN,
            "quotaPolicy": "batch-by-run-and-region",
        },
        "cacheState": {
            "state": "fresh",
            "materializedAt": generated_at,
            "offlineReady": True,
            "serveStale": True,
        },
        "renderPolicy": {
            "renderer": "client-webgpu-or-webgl-field-scene",
            "scalarColour": "colourise from numeric field tiles using fixed per-layer ramps",
            "particles": "animate vector layers from component tiles using the same bundle/time/coverage",
            "displayTiles": "optional",
            "nodata": "alpha=0; never fabricate weather values",
        },
        "sampleContract": {
            "schema": "helm.layer.sample.v1",
            "requiredFields": ["value", "unit", "sourceRef", "freshness", "confidence", "coverage", "advisory"],
            "routeWeather": "sample layer values along worldline W(position,time)",
        },
        "layers": {layer: _prepared_layer_for(region_slug, layer, minzoom, maxzoom) for layer in layers},
        "telemetry": {
            "tileSummary": tile_summary,
            "tilesWritten": sum(v.get("scalar", 0) + v.get("vector", 0) for v in tile_summary.values()),
            "upstreamCallsDuringMaterialize": upstream_calls,
            "gesturePathUpstreamFetches": 0,
            "replayMode": "cache-only",
            "framesMaterialized": len(frames),
            "materializeSourceGrid": source_summary or _planned_source_summary(layers, w, s, e, n, REGION_RES),
        },
        "disclaimer": "Forecast/advisory met-ocean data. Cross-reference official sources. NOT FOR NAVIGATION.",
    }


def discover_prepared_bundles() -> List[dict]:
    root = os.path.join(CACHE_DIR, "env", "bundles", BUNDLE_PROVIDER, BUNDLE_MODEL_ID)
    out = []
    try:
        regions = sorted(os.listdir(root))
    except OSError:
        return out
    for region in regions:
        manifest = _read_json(os.path.join(root, region, "manifest.json"))
        if not manifest:
            continue
        run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
        cache = manifest.get("cacheState") if isinstance(manifest.get("cacheState"), dict) else {}
        policy = manifest.get("cachePolicy") if isinstance(manifest.get("cachePolicy"), dict) else {}
        layers = manifest.get("layers") if isinstance(manifest.get("layers"), dict) else {}
        out.append({
            "id": manifest.get("bundleId", f"{BUNDLE_PROVIDER}/{BUNDLE_MODEL_ID}/{region}"),
            "title": manifest.get("title", region),
            "kind": "environmental-bundle",
            "schema": manifest.get("schema", BUNDLE_SCHEMA),
            "manifest": _prepared_bundle_url(region),
            "coverage": manifest.get("coverage"),
            "layers": sorted(layers.keys()),
            "validTimes": run.get("validTimes") or [],
            "runTime": run.get("runTime"),
            "model": run.get("model"),
            "sizeBytes": _dir_size(os.path.join(root, region)),
            "cacheState": manifest.get("cacheState"),
            "freshness": {
                "status": cache.get("state") or "unknown",
                "materializedAt": cache.get("materializedAt") or manifest.get("generatedAt"),
            },
            "cacheOnlyReplay": bool(policy.get("cacheOnlyReplay", True)),
            "upstreamFetchesAllowedDuringGesture": bool(policy.get("upstreamFetchesAllowedDuringGesture", False)),
            "sample": {"probeHandle": "weather.bundle", "contract": "sample(lat, lon, t)"},
            "advisoryOnly": True,
            "offlineReady": bool((manifest.get("cacheState") or {}).get("offlineReady")),
        })
    return out


async def materialize_environment_bundle(region_id: str, layers: List[str], w: float, s: float, e: float, n: float,
                                         minzoom: int = 0, maxzoom: int = 3, res: float = REGION_RES,
                                         route: str = "", tile_budget: int = 512, frames: int = DEFAULT_BUNDLE_FRAMES,
                                         frame_hours: str = "") -> dict:
    if minzoom < 0 or maxzoom < minzoom or maxzoom > 22:
        raise ValueError("invalid zoom range")
    generated_at = _now_iso()
    frame_list = _bundle_frames(generated_at, frames, frame_hours)
    iw, is_, ie, in_ = _internal_bbox(w, s, e, n)
    planned = _planned_tile_count(layers, w, s, e, n, minzoom, maxzoom, len(frame_list))
    if planned > tile_budget:
        raise ValueError(f"planned tile count {planned} exceeds tile_budget {tile_budget}")
    source_fit = _fit_source_resolution(iw, is_, ie, in_, res)
    calls0 = int(_stats["openmeteo_calls"])
    region_slug = _safe_segment(region_id, DEFAULT_PREPARED_REGION)
    tile_summary: Dict[str, dict] = {}
    for layer in layers:
        coords: Set[Tuple[int, int, int]] = set()
        for z in range(minzoom, maxzoom + 1):
            coords.update(_tile_coords_for_bbox(z, w, s, e, n))
        scale, offset = layer_scale_offset(LAYERS[layer])
        scalar_count = 0
        scalar_valid = 0
        vector_count = 0
        vector_valid = 0
        warms = []
        for frame in frame_list:
            warm = await warm_region(layer, iw, is_, ie, in_, source_fit["effective"],
                                     valid_time=frame["validTime"] if len(frame_list) > 1 else None)
            warm["requested_res_deg"] = source_fit["requested"]
            warm["source_point_budget"] = source_fit["pointBudget"]
            warm["source_resolution_adjusted"] = source_fit["adjusted"]
            warm["validTime"] = frame["validTime"]
            warm["validTimeId"] = frame["validTimeId"]
            warms.append(warm)
            reg = _regions[layer]
            for z, x, y in sorted(coords):
                png, any_valid = _bake_grid_tile(reg["grid"], z, x, y, scale, offset)
                _write_bytes(_prepared_tile_path(region_slug, layer, "scalar", frame["validTimeId"], z, x, y), png)
                scalar_count += 1
                scalar_valid += 1 if any_valid else 0
            if LAYERS[layer].get("vector"):
                vscale, voffset = _vector_component_scale_offset(LAYERS[layer])
                for component in ("u", "v"):
                    grid = _vector_component_grid(reg, component)
                    if grid is None:
                        continue
                    for z, x, y in sorted(coords):
                        png, any_valid = _bake_grid_tile(grid, z, x, y, vscale, voffset)
                        _write_bytes(_prepared_tile_path(region_slug, layer, "vector", frame["validTimeId"], z, x, y, component), png)
                        vector_count += 1
                        vector_valid += 1 if any_valid else 0
        tile_summary[layer] = {"scalar": scalar_count, "scalarWithData": scalar_valid,
                               "vector": vector_count, "vectorWithData": vector_valid,
                               "warm": warms[-1] if warms else None, "frames": warms}
    upstream_calls = int(_stats["openmeteo_calls"]) - calls0
    source_summary = {
        "requestedResolutionDegrees": source_fit["requested"],
        "effectiveResolutionDegrees": source_fit["effective"],
        "sourcePointsPerLayer": source_fit["points"],
        "sourcePointBudget": source_fit["pointBudget"],
        "sourceResolutionAdjusted": source_fit["adjusted"],
        "layers": len(layers),
    }
    manifest = _prepared_manifest(region_slug, layers, w, s, e, n, minzoom, maxzoom,
                                  generated_at, frame_list, tile_summary, upstream_calls, route=route,
                                  source_summary=source_summary)
    _write_json(_prepared_bundle_manifest_path(region_slug), manifest)
    _stats["bundle_materializations"] += 1
    _stats["bundle_tiles_written"] += manifest["telemetry"]["tilesWritten"]
    return manifest


def _resolve_prepared_valid_time_id(region_id: str, valid_time_id: str) -> str:
    if valid_time_id != BUNDLE_VALID_TIME_ID:
        return valid_time_id
    manifest = _read_json(_prepared_bundle_manifest_path(region_id))
    run = manifest.get("run") if isinstance(manifest, dict) and isinstance(manifest.get("run"), dict) else {}
    valid_times = run.get("validTimes") or []
    frame_ids = run.get("frameIdByValidTime") or {}
    latest = run.get("latestValidTime") or (valid_times[0] if valid_times else "")
    if latest and frame_ids.get(latest):
        return frame_ids[latest]
    return valid_time_id


def _serve_prepared_file(path: str, request: Request, media_type: str):
    if not os.path.exists(path):
        _stats["bundle_replay_misses"] += 1
        return PlainTextResponse("prepared bundle cache miss", status_code=404,
                                 headers={"X-Helm-Bundle-Cache": "miss", "X-Helm-Upstream-Fetch": "0"})
    data = open(path, "rb").read()
    etag = 'W/"%s"' % hashlib.md5(data).hexdigest()
    headers = {"Cache-Control": "public, max-age=%d, stale-while-revalidate=%d" % (REGION_TTL, REGION_TTL),
               "ETag": etag, "X-Helm-Encoding": ENCODING, "X-Helm-Bundle-Cache": "hit",
               "X-Helm-Upstream-Fetch": "0"}
    inm = request.headers.get("if-none-match")
    if inm and etag in [t.strip() for t in inm.split(",")]:
        _stats["bundle_replay_hits"] += 1
        return Response(status_code=304, headers=headers)
    _stats["bundle_replay_hits"] += 1
    return Response(content=data, media_type=media_type, headers=headers)


# ------------------------------------------------------------------ FastAPI app
app = FastAPI(title="helm-wx", version="0.1",
              description="Met-ocean / data-layer gateway — value-encoded weather tiles (helm-wxv1).")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.get("/health")
def health():
    return {"ok": True, "service": "helm-wx", "encoding": ENCODING,
            "layers": list(LAYERS.keys()), "cooldown": time.time() < _cooldown_until, "stats": _stats}


@app.get("/index.json")
def index():
    return {"encoding": ENCODING, "bundles": {
        BUNDLE_ID: "/bundles/open-meteo/latest/manifest.json",
    }, "layers": {
        k: {"unit": v["unit"], "source": "open-meteo", "model": MARINE_MODEL if v.get("marine") else MODEL_NAME,
            "minzoom": 0, "maxzoom": DATA_Z_MAX, "frames": 1, "manifest": "%s/manifest.json" % k}
        for k, v in LAYERS.items()}}


@app.get("/bundles/index.json")
def bundles():
    return bundle_index()


@app.get("/bundles/open-meteo/latest/manifest.json")
def bundle_manifest():
    return environment_bundle_manifest()


@app.get("/bundles/open-meteo/latest/materialize")
async def materialize_bundle(region: str = DEFAULT_PREPARED_REGION, layers: str = "wind,current",
                             w: float = 160.0, s: float = -35.0, e: float = -150.0, n: float = 5.0,
                             minzoom: int = 0, maxzoom: int = 3, res: float = REGION_RES,
                             route: str = "", route_margin: float = 1.0, tile_budget: int = 512,
                             frames: int = DEFAULT_BUNDLE_FRAMES, frame_hours: str = ""):
    """Explicit refresh/warm job for a prepared bundle.

    This is the WX-18 boundary: provider calls happen here, not while a user pans/zooms/scrubs.
    e.g. /bundles/open-meteo/latest/materialize?region=fiji&layers=wind,current&w=160&s=-35&e=-150&n=5
    """
    try:
        picked_layers = _parse_layers(layers)
        route_bbox = _parse_route_bbox(route, route_margin)
        if route_bbox:
            w, s, e, n = route_bbox
        manifest = await materialize_environment_bundle(region, picked_layers, w, s, e, n,
                                                        minzoom=minzoom, maxzoom=maxzoom, res=res,
                                                        route=route, tile_budget=tile_budget,
                                                        frames=frames, frame_hours=frame_hours)
        return {"ok": True, "bundle": manifest, "manifest": _prepared_bundle_url(region)}
    except ValueError as ex:
        return JSONResponse({"error": True, "reason": str(ex)}, status_code=400)
    except Exception as ex:
        print("[helm-wx] bundle materialize failed: %r" % ex)
        traceback.print_exc()
        return JSONResponse({"error": True, "reason": str(ex)}, status_code=503)


@app.get("/bundles/open-meteo/latest/{region_id}/manifest.json")
def prepared_bundle_manifest(region_id: str):
    manifest = _read_json(_prepared_bundle_manifest_path(region_id))
    if not manifest:
        return JSONResponse({"error": True, "reason": "unknown prepared bundle"}, status_code=404,
                            headers={"X-Helm-Bundle-Cache": "miss", "X-Helm-Upstream-Fetch": "0"})
    return JSONResponse(manifest, headers={"X-Helm-Bundle-Cache": "hit", "X-Helm-Upstream-Fetch": "0"})


@app.get("/bundles/open-meteo/latest/{region_id}/layers/{layer}/scalar/{valid_time_id}/{z}/{x}/{y}.png")
def prepared_scalar_tile(region_id: str, layer: str, valid_time_id: str, z: int, x: int, y: int, request: Request):
    if layer not in LAYERS:
        return PlainTextResponse("unknown layer", status_code=404)
    valid_time_id = _resolve_prepared_valid_time_id(region_id, valid_time_id)
    return _serve_prepared_file(_prepared_tile_path(region_id, layer, "scalar", valid_time_id, z, x, y),
                                request, "image/png")


@app.get("/bundles/open-meteo/latest/{region_id}/layers/{layer}/vector/{valid_time_id}/{component}/{z}/{x}/{y}.png")
def prepared_vector_tile(region_id: str, layer: str, valid_time_id: str, component: str,
                         z: int, x: int, y: int, request: Request):
    if layer not in LAYERS or not LAYERS[layer].get("vector") or component not in ("u", "v"):
        return PlainTextResponse("unknown vector component", status_code=404)
    valid_time_id = _resolve_prepared_valid_time_id(region_id, valid_time_id)
    return _serve_prepared_file(_prepared_tile_path(region_id, layer, "vector", valid_time_id, z, x, y, component),
                                request, "image/png")


@app.get("/{layer}/manifest.json")
def manifest(layer: str):
    if layer not in LAYERS:
        return JSONResponse({"error": True, "reason": "unknown layer"}, status_code=404)
    return manifest_for(layer)


# ---- wind VELOCITY for the animated particle layer (leaflet-velocity u/v) — keyed + cached ----------
# The GPU particle layer (web/wind-layer.js) needs u/v, not a scalar tile. We fetch wind speed+direction
# over the (snapped) viewport server-side with the KEY, build u/v, and cache — so particles are live and
# animated everywhere WITHOUT the client ever touching the rate-capped free API or holding the key.
_vel: Dict[str, Tuple[list, float]] = {}
_vel_locks: Dict[str, asyncio.Lock] = {}


def _snap(w, s, e, n, step=2.0):
    fl = lambda x: math.floor(x / step) * step
    ce = lambda x: math.ceil(x / step) * step
    return fl(w), max(-84.0, fl(s)), ce(e), min(84.0, ce(n))


async def _fetch_velocity(layer, w, s, e, n, gn):
    global _cooldown_until, _om_last, _om_sem
    cfg = LAYERS[layer]
    spd_var, dir_var, conv = cfg["v"], cfg["dir"], cfg.get("conv")
    endpoint = MARINE if cfg.get("marine") else FORECAST
    sign = 1.0 if cfg.get("dir_to") else -1.0             # TOWARD (current) -> motion = +dir; FROM (wind) -> negate
    D2R = math.pi / 180.0
    lats = [n - (n - s) * j / (gn - 1) for j in range(gn)]
    lons = [w + (e - w) * i / (gn - 1) for i in range(gn)]
    qlat, qlon = [], []
    for la in lats:
        for lo in lons:
            qlat.append(round(la, 3))
            qlon.append(round(((lo + 180) % 360 + 360) % 360 - 180, 3))
    params = {"latitude": ",".join(str(v) for v in qlat), "longitude": ",".join(str(v) for v in qlon),
              "current": spd_var + "," + dir_var}
    if not cfg.get("marine"):
        params["wind_speed_unit"] = "kn"
    if OPENMETEO_KEY:
        params["apikey"] = OPENMETEO_KEY
    if _om_sem is None:
        _om_sem = asyncio.Semaphore(CONCURRENCY)
    async with _om_sem:
        gap = MIN_INTERVAL - (time.time() - _om_last)
        if gap > 0:
            await asyncio.sleep(gap)
        _om_last = time.time()
        _stats["openmeteo_calls"] += 1
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            r = await client.get(endpoint, params=params)
    if r.status_code == 429:
        _cooldown_until = time.time() + COOLDOWN
        raise RuntimeError("open-meteo 429")
    r.raise_for_status()
    nodes = r.json()
    if not isinstance(nodes, list):
        nodes = [nodes]
    us, vs = [], []
    for node in nodes:
        cur = (node or {}).get("current") or {}
        spd = cur.get(spd_var)
        dr = cur.get(dir_var)
        spd = float(spd) if isinstance(spd, (int, float)) else 0.0
        dr = float(dr) if isinstance(dr, (int, float)) else 0.0
        if conv == "kmh2kn":
            spd *= KMH2KN
        us.append(sign * spd * math.sin(dr * D2R))      # wind: FROM (sign=-1); current: TOWARD (sign=+1)
        vs.append(sign * spd * math.cos(dr * D2R))
    hdr = {"nx": gn, "ny": gn, "lo1": lons[0], "la1": lats[0], "lo2": lons[-1], "la2": lats[-1],
           "dx": (lons[-1] - lons[0]) / (gn - 1), "dy": (lats[0] - lats[-1]) / (gn - 1)}
    return [{"header": dict(parameterNumber=2, **hdr), "data": us},
            {"header": dict(parameterNumber=3, **hdr), "data": vs}]


@app.get("/velocity/{layer}")
async def velocity(layer: str, w: float, s: float, e: float, n: float):
    cfg = LAYERS.get(layer)
    if not cfg or not cfg.get("vector"):
        return JSONResponse({"error": True, "reason": "velocity is for vector layers (wind, current)"}, status_code=404)
    if e < w:
        e += 360.0                                       # continuous across the antimeridian
    reg = _regions.get(layer)                            # dense regional particles (Windy parity) if the view is inside
    if reg and reg.get("vel") and (time.time() - reg["t"]) <= REGION_TTL:
        rw, rs, re_, rn = reg["bbox"]
        if rw <= w and re_ >= e and rs <= s and rn >= n:
            return reg["vel"]
    sw, ss, se, sn = _snap(w, s, e, n)                   # snap so nearby pans/zooms reuse one fetch
    key = "vel|%s|%.2f,%.2f,%.2f,%.2f" % (layer, sw, ss, se, sn)
    now = time.time()
    hit = _vel.get(key)
    if hit and now - hit[1] <= TTL:
        return hit[0]
    if now < _cooldown_until and hit:
        return hit[0]
    lock = _vel_locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _vel.get(key)
        if hit and time.time() - hit[1] <= TTL:
            return hit[0]
        try:
            vel = await _fetch_velocity(layer, sw, ss, se, sn, GRID_N)
        except Exception:
            if hit:
                return hit[0]
            return JSONResponse({"error": True, "reason": "velocity unavailable"}, status_code=503)
        _vel[key] = (vel, time.time())
        return vel


@app.get("/warm")
async def warm(layers: str, w: float, s: float, e: float, n: float, res: float = REGION_RES):
    """Dense-ingest a region so its tiles render at native (~Copernicus) resolution — Windy parity.
    e.g. /warm?layers=current,wind&w=170&s=-25&e=185&n=-10"""
    out = []
    async with _region_lock:
        for L in [x.strip() for x in layers.split(",") if x.strip()]:
            if L not in LAYERS:
                out.append({"layer": L, "error": "unknown layer"}); continue
            try:
                out.append(await warm_region(L, w, s, e, n, res))
            except Exception as ex:
                out.append({"layer": L, "error": str(ex)})
    return {"warmed": out}


@app.on_event("startup")
async def _startup_warm():
    """If HELM_WX_WARM_BBOX is set, dense-ingest the boat's region on boot + refresh every REGION_TTL."""
    bbox = os.environ.get("HELM_WX_WARM_BBOX", "").strip()
    if not bbox:
        return
    try:
        w, s, e, n = [float(x) for x in bbox.split(",")]
    except Exception:
        return
    layers = [x.strip() for x in os.environ.get("HELM_WX_WARM_LAYERS", "current,wind").split(",") if x.strip()]
    print(f"[helm-wx] auto-warm scheduled: layers={layers} bbox=({w},{s},{e},{n}) refresh={REGION_TTL}s", flush=True)

    async def warm_once(L):
        # Retry transient cold-start failures (e.g. a 429 burst) with backoff instead of silently going
        # coarse for a whole REGION_TTL. valid==0 means every batch failed (do_batch swallows per-batch).
        for attempt in range(1, 5):
            try:
                async with _region_lock:
                    r = await warm_region(L, w, s, e, n)
                if r.get("valid", 0) > 0:
                    note = f" ({r['failed_batches']}/{r['batches']} batches failed)" if r.get("failed_batches") else ""
                    print(f"[helm-wx] warmed {L}: {r['valid']}/{r['points']} cells{note}", flush=True)
                    return True
                print(f"[helm-wx] warm {L} attempt {attempt}: 0 cells (all batches failed) — retrying", flush=True)
            except Exception as ex:
                print(f"[helm-wx] warm {L} attempt {attempt} FAILED: {ex!r} — retrying", flush=True)
            await asyncio.sleep(min(30, 5 * attempt))
        print(f"[helm-wx] warm {L}: gave up after retries — that layer stays coarse until next refresh", flush=True)
        return False

    async def loop():
        await asyncio.sleep(2)   # let the app finish starting before the cold-start fetch burst
        while True:
            for L in layers:
                if L in LAYERS:
                    await warm_once(L)
            await asyncio.sleep(REGION_TTL)
    asyncio.create_task(loop())


@app.get("/{layer}/{z}/{x}/{y}.png")
async def tile(layer: str, z: int, x: int, y: int, request: Request):
    if layer not in LAYERS:
        return PlainTextResponse("unknown layer", status_code=404)
    if z < 0 or z > 22 or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        return PlainTextResponse("tile out of range", status_code=404)
    try:
        png = await bake_tile(layer, z, x, y)
    except Exception as e:
        # honest failure: no cache + rate-limited/offline. The client's own fallback handles it.
        # Fail LOUD in the server log with the REAL cause — a bare "[Errno 2]" with no stack is
        # what made the original outage undiagnosable. The 503 body to the client is unchanged.
        print("[helm-wx] bake %s/%d/%d/%d failed: %r" % (layer, z, x, y, e))
        traceback.print_exc()
        return PlainTextResponse("weather unavailable: %s" % e, status_code=503)
    # Mapbox-grade HTTP caching: strong ETag + conditional 304 so the browser/CDN revalidate cheaply
    # (no re-transfer of the ~200 KB PNG when the tile is unchanged) on top of max-age.
    etag = 'W/"%s"' % hashlib.md5(png).hexdigest()
    headers = {"Cache-Control": "public, max-age=%d" % TTL, "ETag": etag, "X-Helm-Encoding": ENCODING}
    inm = request.headers.get("if-none-match")
    if inm and etag in [t.strip() for t in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(content=png, media_type="image/png", headers=headers)
