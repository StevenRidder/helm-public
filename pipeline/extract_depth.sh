#!/usr/bin/env bash
# Helm depth extractor — the "depth-on-satellite" half.
# Pulls depth features out of a NOAA ENC (S-57) cell into GeoJSON the front-end can
# overlay on satellite imagery. Requires GDAL with the S-57 driver (brew install gdal).
#
# Get an ENC cell first (free, US public domain):
#   https://www.charts.noaa.gov/ENCs/ENCs.shtml   (download the .000 cell, e.g. US5FL...)
#
# Usage: ./extract_depth.sh /path/to/US5FLxxx.000 [outdir]
set -euo pipefail

ENC="${1:?usage: extract_depth.sh <ENC .000 cell> [outdir]}"
DEFAULT_OUT="${HELM_USER_DATA_ROOT:-${HELM_CONFIG:-${HOME:-.}/.helm}/data}"
OUT="${2:-$DEFAULT_OUT}"
mkdir -p "$OUT"

# SPLIT_MULTIPOINT + ADD_SOUNDG_DEPTH => each sounding is its own point carrying DEPTH.
export OGR_S57_OPTIONS="SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON,RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=OFF"

echo "ENC: $ENC"
ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$OUT/depare.geojson" "$ENC" DEPARE   # depth areas (fills)
ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$OUT/depcnt.geojson" "$ENC" DEPCNT   # depth contours (lines)
ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$OUT/soundg.geojson" "$ENC" SOUNDG   # soundings (points + DEPTH)

echo "wrote depare.geojson, depcnt.geojson, soundg.geojson -> $OUT"
echo "tip: list every layer in a cell with:  ogrinfo -so \"$ENC\""
