#!/usr/bin/env bash
# ============================================================================
#  start-helm.sh — bring up the Helm stack on its canonical ports (docs/PORTS.md).
#
#  The CORE (helm-server) is required and always started. The helper services are
#  OPT-IN and bring-your-own-data — each is checked for prerequisites and either
#  started or SKIPPED with a loud, specific reason (never silently faked).
#
#  Usage:
#    scripts/start-helm.sh                 # core only (UI + nav + S-52 charts)
#    scripts/start-helm.sh --all           # core + every helper whose deps/data are present
#    scripts/start-helm.sh --weather --fill # core + chosen helpers
#    HELM_BASEMAP_UPSTREAM=http://192.168.1.137:8091 scripts/start-helm.sh --basemap-proxy
#
#  Flags:  --weather        weather value-tile gateway (services/wx) on :8093
#          --basemap        offline MBTiles/PMTiles local pack server (pipeline) on :8091
#          --basemap-proxy  cache-backed proxy to HELM_BASEMAP_UPSTREAM on :8091
#          --fill           online basemap-fill cache proxy on :8095
#          --backend        AI/places/community backend on :8090
#          --all            all except --basemap-proxy (each still skipped if deps/data are missing)
#          --port N         helm-server port (default 8080; use a private port on shared boats)
#
#  Key env (all overridable):
#    HELM_PORT          core port (default 8080)
#    HELM_OCPN_DIR      build dir (default ~/.helm/build/helm-opencpn)
#    HELM_SERVER_BIN    helm-server binary (default $HELM_OCPN_DIR/build/cli/helm-server)
#    HELM_WEB_ROOT      web/ dir (default: this repo's web/)
#    HELM_CONFIG        durable config/runtime dir (default ~/.helm/config)
#    HELM_ENC           NOAA ENC .000 cell for real S-52 charts
#    HELM_MBTILES_DIR       dir of *.mbtiles/*.pmtiles for --basemap (optional; else demo web/data)
#    HELM_BASEMAP_UPSTREAM  upstream :8091 URL for --basemap-proxy (example: http://192.168.1.137:8091)
#
#  Ctrl-C stops everything this script started.
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- config ---------------------------------------------------------------
HELM_PORT="${HELM_PORT:-8080}"
HELM_RUNTIME_DIR="${HELM_RUNTIME_DIR:-$HOME/.helm/runtime}"
HELM_OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
HELM_SERVER_BIN="${HELM_SERVER_BIN:-$HELM_OCPN_DIR/build/cli/helm-server}"
HELM_WEB_ROOT="${HELM_WEB_ROOT:-$REPO_ROOT/web}"
HELM_CONFIG="${HELM_CONFIG:-$HOME/.helm/config}"
HELM_SAMPLE_ENC="${HELM_SAMPLE_ENC:-$HELM_RUNTIME_DIR/enc/US5FL4CR/US5FL4CR.000}"

WANT_WEATHER=0; WANT_BASEMAP=0; WANT_BASEMAP_PROXY=0; WANT_FILL=0; WANT_BACKEND=0
while [ $# -gt 0 ]; do
  case "$1" in
    --weather) WANT_WEATHER=1 ;;
    --basemap) WANT_BASEMAP=1 ;;
    --basemap-proxy) WANT_BASEMAP_PROXY=1 ;;
    --fill)    WANT_FILL=1 ;;
    --backend) WANT_BACKEND=1 ;;
    --all)     WANT_WEATHER=1; WANT_BASEMAP=1; WANT_FILL=1; WANT_BACKEND=1 ;;
    --port)    shift; HELM_PORT="$1" ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "start-helm: unknown arg '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "start-helm: $*" >&2; exit 1; }
have_py() { python3 -c "import $1" >/dev/null 2>&1; }
port_busy() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 || curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$1/health" 2>/dev/null; }
wx_python() {
  if [ -x "$REPO_ROOT/services/wx/.venv/bin/python" ]; then
    echo "$REPO_ROOT/services/wx/.venv/bin/python"
  else
    echo python3
  fi
}

# pid -> "label@port" for the status summary + cleanup
declare -a PIDS=() ; declare -a STARTED=() ; declare -a SKIPPED=()

cleanup() {
  trap - INT TERM EXIT
  [ ${#PIDS[@]} -gt 0 ] && echo && echo "start-helm: stopping ${#PIDS[@]} service(s)…"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

start_bg() { # $1=label  $2=port  shift 2; rest = command
  local label="$1" port="$2"; shift 2
  if port_busy "$port"; then SKIPPED+=("$label :$port — already running (reused)"); return; fi
  ( "$@" ) & local pid=$!
  PIDS+=("$pid"); STARTED+=("$label :$port  (pid $pid)")
}

# ---- CORE: helm-server (required) ----------------------------------------
[ -x "$HELM_SERVER_BIN" ] || die "helm-server not built: $HELM_SERVER_BIN missing — run engine/bootstrap.sh first."
[ -d "$HELM_WEB_ROOT" ]   || die "web root not found: $HELM_WEB_ROOT (set HELM_WEB_ROOT)."
mkdir -p "$HELM_CONFIG"

if [ -z "${HELM_ENC:-}" ] && [ -f "$HELM_SAMPLE_ENC" ]; then
  HELM_ENC="$HELM_SAMPLE_ENC"
fi

# macOS: helm-server links wxWidgets 3.2 from Homebrew at runtime.
if [ "$(uname)" = "Darwin" ]; then
  export DYLD_LIBRARY_PATH="/opt/homebrew/opt/wxwidgets@3.2/lib:/opt/homebrew/opt/libarchive/lib:${DYLD_LIBRARY_PATH:-}"
fi

[ -n "${HELM_ENC:-}" ] || die "no ENC chart found. Run scripts/install-sample-enc.sh or set HELM_ENC to a .000 chart cell."

echo "start-helm: launching core helm-server on :$HELM_PORT (web=$HELM_WEB_ROOT)…"
port_busy "$HELM_PORT" && die "port $HELM_PORT already serving /health — core not started (use --port N for a private port)."
env HELM_PORT="$HELM_PORT" HELM_WEB_ROOT="$HELM_WEB_ROOT" HELM_CONFIG="$HELM_CONFIG" \
    ${HELM_ENC:+HELM_ENC="$HELM_ENC"} HELM_TILES_NO_WARMUP="${HELM_TILES_NO_WARMUP:-1}" \
    "$HELM_SERVER_BIN" &
PIDS+=("$!"); STARTED+=("helm-server (core) :$HELM_PORT  (pid $!)")

# ---- HELPERS (opt-in, prerequisite-checked) -------------------------------
if [ "$WANT_WEATHER" = 1 ]; then
  WX_PY="$(wx_python)"
  if "$WX_PY" -c "import uvicorn, fastapi, httpx, numpy" >/dev/null 2>&1 && [ -f "$REPO_ROOT/services/wx/app.py" ]; then
    start_bg "weather-gateway (services/wx)" 8093 \
      bash -c "cd '$REPO_ROOT/services/wx' && exec '$WX_PY' -m uvicorn app:app --port 8093"
  else
    SKIPPED+=("weather-gateway :8093 — deps missing: python3 -m venv services/wx/.venv && services/wx/.venv/bin/python -m pip install -r services/wx/requirements.txt")
  fi
fi

if [ "$WANT_BASEMAP" = 1 ]; then
  if [ -f "$REPO_ROOT/pipeline/mbtiles_server.py" ]; then
    [ -n "${HELM_MBTILES_DIR:-}" ] || SKIPPED+=("basemap note — HELM_MBTILES_DIR unset; serving demo web/data, not your charts")
    start_bg "local-pack-server (pipeline)" 8091 \
      bash -c "exec python3 '$REPO_ROOT/pipeline/mbtiles_server.py' 8091"
  else
    SKIPPED+=("local-pack-server :8091 — pipeline/mbtiles_server.py not found")
  fi
fi

if [ "$WANT_BASEMAP_PROXY" = 1 ]; then
  if [ "$WANT_BASEMAP" = 1 ]; then
    SKIPPED+=("basemap-proxy :8091 — skipped because --basemap already requested :8091")
  elif [ -z "${HELM_BASEMAP_UPSTREAM:-}" ]; then
    SKIPPED+=("basemap-proxy :8091 — HELM_BASEMAP_UPSTREAM unset (example: http://192.168.1.137:8091)")
  elif [ -f "$REPO_ROOT/services/basemap-proxy-cache/server.py" ]; then
    start_bg "basemap-proxy-cache" 8091 \
      bash -c "exec python3 '$REPO_ROOT/services/basemap-proxy-cache/server.py' 8091"
  else
    SKIPPED+=("basemap-proxy :8091 — services/basemap-proxy-cache/server.py not found")
  fi
fi

if [ "$WANT_FILL" = 1 ]; then
  if [ -x "$REPO_ROOT/services/basemap-fill/run.sh" ]; then
    start_bg "basemap-fill (online cache)" 8095 bash "$REPO_ROOT/services/basemap-fill/run.sh"
  else
    SKIPPED+=("basemap-fill :8095 — services/basemap-fill/run.sh not executable/found")
  fi
fi

if [ "$WANT_BACKEND" = 1 ]; then
  if have_py uvicorn && [ -f "$REPO_ROOT/backend/main.py" ]; then
    start_bg "backend (AI/places)" 8090 \
      bash -c "cd '$REPO_ROOT/backend' && exec python3 -m uvicorn main:app --port 8090"
  else
    SKIPPED+=("backend :8090 — deps missing: pip install -r backend/requirements.txt")
  fi
fi

# ---- status summary -------------------------------------------------------
sleep 1
echo
echo "════════════════════ Helm is up ════════════════════"
for s in "${STARTED[@]:-}"; do [ -n "$s" ] && echo "  ▶ $s"; done
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "  ── skipped ──"
  for s in "${SKIPPED[@]:-}"; do [ -n "$s" ] && echo "  · $s"; done
fi
echo "─────────────────────────────────────────────────────"
echo "  Open:  http://127.0.0.1:$HELM_PORT/"
echo "  Stop:  Ctrl-C (stops everything started here)"
echo "═════════════════════════════════════════════════════"

wait
