#!/usr/bin/env bash
#
# OFFLINE-16 smoke: run the C++ helm-packd binary against generated local
# MBTiles/PMTiles fixtures on a private ephemeral port.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
BIN="${HELM_PACKD_BIN:-$OCPN_DIR/build/cli/helm-packd}"

if [ ! -x "$BIN" ]; then
  echo "no helm-packd at $BIN" >&2
  echo "run: engine/bootstrap.sh --dir <private-ocpn-dir> --jobs N" >&2
  exit 2
fi

HELM_PACKD_BIN="$BIN" python3 "$REPO/pipeline/test_helm_packd_contract.py"
