#!/usr/bin/env bash
# OFFLINE-13 Fiji cockpit acceptance runner.
#
# Starts a private helm-server and private C++ helm-packd, then runs the opt-in
# Playwright proof against local BYO Fiji packs. It never binds or stops :8080.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CORE_PORT="${HELM_OFFLINE13_CORE_PORT:-9130}"
PACKD_PORT="${HELM_OFFLINE13_PACKD_PORT:-9127}"
EVIDENCE_DIR="${HELM_OFFLINE13_EVIDENCE_DIR:-$ROOT/test-results/offline13-fiji}"

HELM_OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
HELM_SERVER_BIN="${HELM_SERVER_BIN:-$HELM_OCPN_DIR/build/cli/helm-server}"
HELM_PACKD_BIN="${HELM_PACKD_BIN:-$HELM_OCPN_DIR/build/cli/helm-packd}"
HELM_WEB_ROOT="${HELM_WEB_ROOT:-$ROOT/web}"
HELM_CONFIG="${HELM_CONFIG:-$(mktemp -d /tmp/helm-offline13-config.XXXXXX)}"
HELM_SAMPLE_ENC="${HELM_SAMPLE_ENC:-$HOME/.helm/runtime/enc/US5FL4CR/US5FL4CR.000}"

PIDS=()

die() { echo "verify-offline13-fiji: $*" >&2; exit 1; }

cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

wait_health() {
  local url="$1" label="$2"
  for _ in $(seq 1 80); do
    if curl -sf --max-time 1 "$url" >/dev/null; then return 0; fi
    sleep 0.25
  done
  die "$label did not become healthy at $url"
}

port_free() {
  local port="$1"
  ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

[ -x "$HELM_SERVER_BIN" ] || die "helm-server missing/not executable: $HELM_SERVER_BIN"
[ -x "$HELM_PACKD_BIN" ] || die "helm-packd missing/not executable: $HELM_PACKD_BIN"
[ -n "${HELM_MBTILES_DIR:-}" ] || die "set HELM_MBTILES_DIR to a local Fiji MBTiles/PMTiles directory"
[ -d "$HELM_MBTILES_DIR" ] || die "HELM_MBTILES_DIR is not a directory: $HELM_MBTILES_DIR"

if [ -z "${HELM_ENC:-}" ] && [ -f "$HELM_SAMPLE_ENC" ]; then
  HELM_ENC="$HELM_SAMPLE_ENC"
fi
[ -n "${HELM_ENC:-}" ] || die "set HELM_ENC to a .000 ENC cell, or install the sample ENC"
[ -f "$HELM_ENC" ] || die "HELM_ENC not found: $HELM_ENC"

port_free "$CORE_PORT" || die "private core port $CORE_PORT is already in use"
port_free "$PACKD_PORT" || die "private packd port $PACKD_PORT is already in use"

mkdir -p "$EVIDENCE_DIR" "$HELM_CONFIG"

echo "verify-offline13-fiji: starting helm-packd on :$PACKD_PORT"
env HELM_BIND=127.0.0.1 HELM_MBTILES_DIR="$HELM_MBTILES_DIR" \
  "$HELM_PACKD_BIN" "$PACKD_PORT" >"$EVIDENCE_DIR/helm-packd.log" 2>&1 &
PIDS+=("$!")
wait_health "http://127.0.0.1:$PACKD_PORT/health" "helm-packd"

echo "verify-offline13-fiji: starting helm-server on :$CORE_PORT"
env HELM_PORT="$CORE_PORT" HELM_WEB_ROOT="$HELM_WEB_ROOT" HELM_CONFIG="$HELM_CONFIG" \
  HELM_ENC="$HELM_ENC" HELM_TILES_NO_WARMUP="${HELM_TILES_NO_WARMUP:-1}" \
  "$HELM_SERVER_BIN" >"$EVIDENCE_DIR/helm-server.log" 2>&1 &
PIDS+=("$!")
wait_health "http://127.0.0.1:$CORE_PORT/health" "helm-server"

if [ ! -d "$ROOT/web/test/node_modules" ]; then
  echo "verify-offline13-fiji: installing web/test dependencies"
  npm --prefix "$ROOT/web/test" ci
fi

echo "verify-offline13-fiji: running Playwright OFFLINE-13 proof"
(
  cd "$ROOT/web/test"
  HELM_OFFLINE13=1 \
  HELM_E2E_URL="http://127.0.0.1:$CORE_PORT" \
  HELM_E2E_PORT="$CORE_PORT" \
  HELM_OFFLINE13_PACKD_URL="http://127.0.0.1:$PACKD_PORT" \
  HELM_OFFLINE13_EVIDENCE_DIR="$EVIDENCE_DIR" \
    npx playwright test e2e/offline13-fiji-acceptance.spec.js
)

echo "verify-offline13-fiji: evidence in $EVIDENCE_DIR"
