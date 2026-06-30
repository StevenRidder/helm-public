#!/usr/bin/env bash
# Helm pipeline — mbtiles -> pmtiles.
# PMTiles is a single-file, serverless tileset read over HTTP range requests
# (or straight off disk). It's the modern offline-charts container: no SQLite,
# no server, and it sidesteps the mbtiles TMS Y-flip the tiler has to handle.
# The web Lab drawer's "PMTiles offline raster" toggle loads the output of this.
#
# Needs the off-the-shelf `pmtiles` CLI (go-pmtiles):
#   - macOS:  brew install pmtiles
#   - or grab a release: https://github.com/protomaps/go-pmtiles/releases
#
# Usage:
#   bash pipeline/make_pmtiles.sh                       # converts web/data/<region>-sat.mbtiles
#   bash pipeline/make_pmtiles.sh path/to/file.mbtiles  # convert a specific file
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA="$ROOT/web/data"
# shellcheck disable=SC1091
REGION_ENV="${HELM_REGION_ENV:-$SCRIPT_DIR/region.env}"
if [ ! -f "$REGION_ENV" ]; then
  REGION_ENV="$SCRIPT_DIR/region.env.example"
fi
source "$REGION_ENV"

IN="${1:-$DATA/${REGION_NAME}-sat.mbtiles}"
OUT="${IN%.mbtiles}.pmtiles"

if ! command -v pmtiles >/dev/null 2>&1; then
  echo "! 'pmtiles' CLI not found — brew install pmtiles (or go-pmtiles release)"; exit 1
fi
if [ ! -f "$IN" ]; then
  echo "! input not found: $IN"
  echo "  build offline tiles first:  bash pipeline/build.sh"; exit 1
fi

echo "== pmtiles convert =="
echo "  in:  $IN"
echo "  out: $OUT"
pmtiles convert "$IN" "$OUT" && echo "  done -> $(basename "$OUT")"
echo
echo "The Lab drawer loads pmtiles://data/$(basename "$OUT") — reload the web app and toggle 'PMTiles offline raster'."
