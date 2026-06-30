#!/usr/bin/env bash
#
# CHART-18 smoke: run the C++ helm-basemap-cache binary against a local fixture
# upstream on private ephemeral ports. Proves cache-first replay, transparent
# hard-miss behavior, and no dependency on the real internet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
BIN="${HELM_BASEMAP_CACHE_BIN:-$OCPN_DIR/build/cli/helm-basemap-cache}"

if [ ! -x "$BIN" ]; then
  echo "no helm-basemap-cache at $BIN" >&2
  echo "run: engine/bootstrap.sh --dir <private-ocpn-dir> --jobs N" >&2
  exit 2
fi

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

TMP="${TMPDIR:-/tmp}/helm-basemap-cache-test.$$"
UPSTREAM_PORT="$(free_port)"
CACHE_PORT="$(free_port)"
CACHE_DIR="$TMP/cache"
WWW="$TMP/www"
LOG_UP="$TMP/upstream.log"
LOG_CACHE="$TMP/cache.log"
TILE_REL="wmts/1.0.0/s2cloudless-2023_3857/default/g/1/0/0.jpg"
mkdir -p "$WWW/$(dirname "$TILE_REL")" "$CACHE_DIR"
printf 'fixture-eox-tile\n' > "$WWW/$TILE_REL"
printf '{"packs":["fiji-chart"]}\n' > "$WWW/catalog"

UP_PID=""
CACHE_PID=""
cleanup() {
  if [ -n "$CACHE_PID" ]; then
    kill "$CACHE_PID" 2>/dev/null || true
    wait "$CACHE_PID" 2>/dev/null || true
  fi
  if [ -n "$UP_PID" ]; then
    kill "$UP_PID" 2>/dev/null || true
    wait "$UP_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

python3 - "$WWW" "$UPSTREAM_PORT" >"$LOG_UP" 2>&1 <<'PY' &
import http.server
import os
import socketserver
import sys

root = sys.argv[1]
port = int(sys.argv[2])

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

os.chdir(root)
Server(("127.0.0.1", port), Handler).serve_forever()
PY
UP_PID=$!
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$UPSTREAM_PORT/$TILE_REL" && break
  sleep 0.1
done

HELM_BIND=127.0.0.1 \
HELM_FILL_CACHE="$CACHE_DIR" \
HELM_FILL_TIMEOUT=3 \
HELM_BASEMAP_EOX_URL="http://127.0.0.1:$UPSTREAM_PORT/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg" \
HELM_BASEMAP_UPSTREAM="http://127.0.0.1:$UPSTREAM_PORT" \
  "$BIN" "$CACHE_PORT" >"$LOG_CACHE" 2>&1 &
CACHE_PID=$!

for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$CACHE_PORT/health" && break
  sleep 0.1
done

health="$(curl -sf "http://127.0.0.1:$CACHE_PORT/health")"
echo "$health" | grep -q '"engine":"helm-basemap-cache"'

tile="$TMP/tile.jpg"
code="$(curl -sS -D "$TMP/h1" -o "$tile" -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/basemap/eox/1/0/0.jpg")"
[ "$code" = 200 ] || { echo "first tile returned $code"; cat "$LOG_CACHE"; exit 1; }
grep -q 'fixture-eox-tile' "$tile"
grep -qi 'X-Helm-Cache: miss-store' "$TMP/h1"

code="$(curl -sS -D "$TMP/h-proxy1" -o "$TMP/catalog" -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/catalog")"
[ "$code" = 200 ] || { echo "proxy catalog returned $code"; cat "$LOG_CACHE"; exit 1; }
grep -q 'fiji-chart' "$TMP/catalog"
grep -qi 'X-Helm-Cache: miss-store' "$TMP/h-proxy1"

kill "$UP_PID" 2>/dev/null || true
wait "$UP_PID" 2>/dev/null || true
UP_PID=""
code="$(curl -sS -D "$TMP/h2" -o "$TMP/tile-offline.jpg" -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/basemap/eox/1/0/0.jpg")"
[ "$code" = 200 ] || { echo "cached offline tile returned $code"; cat "$LOG_CACHE"; exit 1; }
cmp "$tile" "$TMP/tile-offline.jpg"
grep -qi 'X-Helm-Cache: hit' "$TMP/h2"

code="$(curl -sS -D "$TMP/h-proxy2" -o "$TMP/catalog-offline" -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/catalog")"
[ "$code" = 200 ] || { echo "cached proxy catalog returned $code"; cat "$LOG_CACHE"; exit 1; }
cmp "$TMP/catalog" "$TMP/catalog-offline"
grep -qi 'X-Helm-Cache: hit' "$TMP/h-proxy2"

code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/basemap/eox/1/1/1.jpg")"
[ "$code" = 204 ] || { echo "hard miss returned $code"; cat "$LOG_CACHE"; exit 1; }

code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CACHE_PORT/basemap/unknown/1/0/0.jpg")"
[ "$code" = 404 ] || { echo "unknown source returned $code"; cat "$LOG_CACHE"; exit 1; }

stats="$(curl -sf "http://127.0.0.1:$CACHE_PORT/stats")"
echo "$stats" | grep -q '"cached_tiles":2'

echo "helm-basemap-cache smoke passed on :$CACHE_PORT"
