#!/usr/bin/env python3
"""Cache-backed proxy for BYO basemap tiles.

Use this when the owned MBTiles packs are on another Mac and cannot yet be copied
locally. It keeps the browser-facing port the same (:8091) while caching fetched
tiles under ~/.helm so repeated zoom/pan work is local instead of LAN-bound.

Run:
  HELM_BASEMAP_UPSTREAM=http://192.168.1.137:8091 python3 server.py 8091
"""
import hashlib
import http.server
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import socketserver

UPSTREAM = os.environ.get("HELM_BASEMAP_UPSTREAM", "").rstrip("/")
CACHE = os.path.abspath(os.path.expanduser(os.environ.get(
    "HELM_BASEMAP_PROXY_CACHE", "~/.helm/basemap-proxy-cache"
)))


def content_type(path):
    ext = os.path.splitext(path.split("?", 1)[0])[1].lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".png":
        return "image/png"
    return "application/octet-stream"


def cache_path(path):
    clean = path.split("?", 1)[0].lstrip("/")
    if clean == "catalog":
        return os.path.join(CACHE, "catalog.json")
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()[:16]
    return os.path.join(CACHE, clean + "." + digest)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_common(self, body, status=200, ctype=None):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Type", ctype or content_type(self.path))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not UPSTREAM:
            body = b"HELM_BASEMAP_UPSTREAM is required\n"
            self.send_common(body, status=503, ctype="text/plain")
            return

        path = self.path.split("?", 1)[0]
        dst = cache_path(path)
        meta = dst + ".type"
        if os.path.exists(dst):
            ctype = open(meta).read().strip() if os.path.exists(meta) else content_type(path)
            with open(dst, "rb") as f:
                self.send_common(f.read(), ctype=ctype)
            return

        url = UPSTREAM + "/" + path.lstrip("/")
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                status = resp.status
                body = resp.read()
                ctype = resp.headers.get("Content-Type") or content_type(path)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_common(body, status=e.code, ctype=e.headers.get("Content-Type") or "text/plain")
            return
        except Exception as e:
            body = ("upstream basemap fetch failed: %s\n" % e).encode("utf-8")
            self.send_common(body, status=502, ctype="text/plain")
            return

        if status == 200 and body:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".tmp"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dst)
            with open(meta, "w") as f:
                f.write(ctype)

        self.send_common(body, status=status, ctype=ctype)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    if not UPSTREAM:
        print("FATAL: set HELM_BASEMAP_UPSTREAM, e.g. http://192.168.1.137:8091", file=sys.stderr)
        sys.exit(2)
    os.makedirs(CACHE, exist_ok=True)
    print("basemap proxy-cache :%d  upstream=%s  cache=%s" % (port, UPSTREAM, CACHE))
    Server(("0.0.0.0", port), Handler).serve_forever()
