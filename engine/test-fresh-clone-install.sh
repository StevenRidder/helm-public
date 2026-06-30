#!/usr/bin/env bash
#
# ENGINE-16 smoke: prove a clean checkout with an empty HOME can bootstrap,
# install runtime assets into ~/.helm/runtime, and render a real ENC tile with
# no /tmp pre-seeding.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

die() {
  echo "fresh-clone-smoke: $*" >&2
  exit 1
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

TMP="${HELM_FRESH_SMOKE_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/helm-fresh-smoke.XXXXXX")}"
KEEP_TMP="${HELM_FRESH_SMOKE_KEEP:-0}"

cleanup() {
  if [ "$KEEP_TMP" = 1 ]; then
    echo "fresh-clone-smoke: keeping $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

if [ "${HELM_FRESH_ALLOW_DIRTY:-0}" != 1 ]; then
  dirty="$(git -C "$REPO" status --porcelain)"
  [ -z "$dirty" ] || die "checkout is dirty; commit first or set HELM_FRESH_ALLOW_DIRTY=1 for local development"
fi

FRESH_HOME="$TMP/home"
export HOME="$FRESH_HOME"
export HELM_RUNTIME_DIR="$FRESH_HOME/.helm/runtime"
export HELM_BUILD_TMP="$FRESH_HOME/.helm/build/tmp"
export HELM_ENC_ROOT="$HELM_RUNTIME_DIR/enc"

mkdir -p "$HOME"
[ ! -e "$HOME/.helm" ] || die "fresh HOME unexpectedly already contains .helm"

echo "fresh-clone-smoke: repo=$REPO"
echo "fresh-clone-smoke: home=$HOME"
echo "fresh-clone-smoke: runtime=$HELM_RUNTIME_DIR"

echo "fresh-clone-smoke: installing sample ENC into isolated runtime"
ENC_PATH="$("$REPO/scripts/install-sample-enc.sh" | tail -n 1)"
[ -f "$ENC_PATH" ] || die "sample ENC was not installed: $ENC_PATH"

BOOTSTRAP_LOG="$TMP/bootstrap.log"
OCPN_DIR="$FRESH_HOME/.helm/build/helm-opencpn"
SMOKE_PORT="${HELM_FRESH_SMOKE_PORT:-$(free_port)}"

export HELM_ENC="$ENC_PATH"
export HELM_BOOTSTRAP_SMOKE_PORT="$SMOKE_PORT"

echo "fresh-clone-smoke: running bootstrap smoke on port $SMOKE_PORT"
"$REPO/engine/bootstrap.sh" \
  --dir "$OCPN_DIR" \
  --jobs "${HELM_FRESH_JOBS:-2}" \
  --clean \
  --smoke | tee "$BOOTSTRAP_LOG"

SERVER="$OCPN_DIR/build/cli/helm-server"
[ -x "$SERVER" ] || die "helm-server was not built at $SERVER"
[ -d "$HELM_RUNTIME_DIR/s57data" ] || die "runtime s57data was not installed"
[ -f "$HELM_RUNTIME_DIR/enc/US5FL4CR/US5FL4CR.000" ] || die "sample ENC missing from runtime"

grep -q "/health -> http=200" "$BOOTSTRAP_LOG" || die "health smoke did not pass"
grep -q "/catalog -> http=200" "$BOOTSTRAP_LOG" || die "catalog smoke did not pass"
grep -q "/chart/.*/.*.png -> http=200" "$BOOTSTRAP_LOG" || die "ENC tile smoke did not request a chart tile"
grep -q "one-origin server rendered S-52 chart content" "$BOOTSTRAP_LOG" || die "ENC tile was not large enough to prove chart rendering"

if grep -q "skipped tile render" "$BOOTSTRAP_LOG"; then
  die "bootstrap skipped ENC tile render; this smoke must prove chart rendering"
fi

echo "fresh-clone-smoke: passed"
