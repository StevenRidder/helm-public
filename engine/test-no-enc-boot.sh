#!/usr/bin/env bash
#
# ENGINE-15 smoke: helm-server must boot with no ENC chart available.
# It should keep the UI/nav origin alive, report chart_loaded=false, return an
# empty catalog/query result, and serve transparent chart tiles instead of
# failing startup.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BIN="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}/build/cli"
SERVER="${HELM_SERVER_BIN:-$BIN/helm-server}"

if [ ! -x "$SERVER" ]; then
  echo "no helm-server at $SERVER" >&2
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

TMP="${TMPDIR:-/tmp}/helm-no-enc-test.$$"
PORT="${HELM_TEST_PORT:-$(free_port)}"
RELAY_PORT="${HELM_RELAY_PORT:-$(free_port)}"
CONFIG="$TMP/config"
LOG="$TMP/helm-server.log"
mkdir -p "$CONFIG"

PID=""
cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

HELM_BIND=127.0.0.1 \
HELM_PORT="$PORT" \
HELM_RELAY_PORT="$RELAY_PORT" \
HELM_TILES_NO_WARMUP=1 \
HELM_WEB_ROOT="$REPO/web" \
HELM_CONFIG="$CONFIG" \
HELM_ENC="$TMP/missing/NO_SUCH_CELL.000" \
  "$SERVER" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 80); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/health"; then
    break
  fi
  sleep 0.1
done

health="$(curl -sf "http://127.0.0.1:$PORT/health")" || { cat "$LOG"; exit 1; }
echo "$health" | grep -q '"engine":"helm-server"'
echo "$health" | grep -q '"chart_loaded":false'
echo "$health" | grep -q '"chart_status":"unavailable"'
echo "$health" | grep -q '"nav":{'
echo "$health" | grep -q '"fix_status":"offline"'
echo "$health" | grep -q '"missing":\["pos","sog","cog"\]'

catalog="$(curl -sf "http://127.0.0.1:$PORT/catalog")" || { cat "$LOG"; exit 1; }
echo "$catalog" | grep -q '"cells":\[\]'
echo "$catalog" | grep -q '"count":0'
echo "$catalog" | grep -q '"chart_loaded":false'

query_code="$(curl -sS -o "$TMP/query.json" -w '%{http_code}' "http://127.0.0.1:$PORT/query?lat=0&lon=0&z=8")"
[ "$query_code" = 200 ] || { echo "query returned $query_code"; cat "$LOG"; exit 1; }
grep -qx '\[\]' "$TMP/query.json"

tile_code="$(curl -sS -D "$TMP/tile.headers" -o "$TMP/tile.png" -w '%{http_code}' "http://127.0.0.1:$PORT/chart/2/1/1.png")"
[ "$tile_code" = 200 ] || { echo "tile returned $tile_code"; cat "$LOG"; exit 1; }
grep -qi '^Content-Type: image/png' "$TMP/tile.headers"
grep -qi '^X-Helm-Chart-Status: unavailable' "$TMP/tile.headers"
python3 - "$TMP/tile.png" <<'PY'
import sys
data = open(sys.argv[1], "rb").read()
assert data.startswith(b"\x89PNG\r\n\x1a\n"), "tile is not PNG"
assert len(data) > 50, "tile is unexpectedly empty"
PY

ui_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
[ "$ui_code" = 200 ] || { echo "UI returned $ui_code"; cat "$LOG"; exit 1; }

grep -q 'booting basemap-only' "$LOG"

echo "helm-server no-ENC boot smoke passed on :$PORT"
