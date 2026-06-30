#!/usr/bin/env bash
# Helm pipeline — one-command runner.
# Builds everything the web prototype (and offline charts) need, driven by
# pipeline/region.env when present, otherwise the public sample region.
# Tolerant by design: a failed or skipped step never aborts the rest (set -u, NOT set -e).
#
# Usage:
#   bash pipeline/build.sh                         # wind + places + offline charts
#   bash pipeline/build.sh ~/Downloads/USxxx.000   # ...also extract ENC depth
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA="$ROOT/web/data"
mkdir -p "$DATA"
# shellcheck disable=SC1091
REGION_ENV="${HELM_REGION_ENV:-$SCRIPT_DIR/region.env}"
if [ ! -f "$REGION_ENV" ]; then
  REGION_ENV="$SCRIPT_DIR/region.env.example"
fi
source "$REGION_ENV"

ENC="${1:-}"   # optional NOAA ENC .000 cell for the depth step
step() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

step "region: $REGION_NAME   charts bbox $BBOX   wind bbox $WIND_BBOX   config $REGION_ENV"

# --- quick overlay data (the web prototype needs these) ---
step "weather  (Open-Meteo: wind/rain/temp/pressure/waves/current heatmap fields + wind particles)"
python3 "$SCRIPT_DIR/fetch_weather.py" --bbox="$WIND_BBOX" --nx=14 --ny=14 \
  --layers wind,rain,temp,pressure,waves,current --out "$DATA" \
  || echo "  ! weather step failed (network/rate-limit?) — continuing"

step "places  (OpenStreetMap / Overpass)"
python3 "$SCRIPT_DIR/fetch_places.py" \
  || echo "  ! places step failed (Overpass busy?) — continuing"

# --- offline-first RUNTIME data: baked once here, served locally at runtime (no CDN on the boat) ---
step "DEM  (Terrarium terrain-RGB tiles -> web/data/dem, feeds depth contours + hillshade)"
python3 "$SCRIPT_DIR/fetch_dem.py" \
  || echo "  ! DEM step failed (network?) — continuing"

step "satellite basemap  (Sentinel-2 cloudless -> web/data/sat — the OFFLINE-by-default basemap, no CDN at runtime)"
python3 "$SCRIPT_DIR/fetch_sat_tiles.py" 8 13 \
  || echo "  ! sat-tiles step failed (network?) — continuing"

step "depth contours  (smooth, Windy-style: DEM -> gaussian -> marching-squares -> Chaikin -> geojson)"
python3 "$SCRIPT_DIR/make_depth_contours.py" \
  || echo "  ! depth-contour step failed (matplotlib/numpy missing?) — continuing"

step "depth layers  (DEM -> S-52 depth-area fill + contours + soundings, for regions with NO ENC cell)"
python3 "$SCRIPT_DIR/make_depth_layers.py" \
  || echo "  ! depth-layers step failed — continuing"

step "glyphs  (Noto Sans label ranges -> web/fonts, so map labels work offline)"
python3 "$SCRIPT_DIR/fetch_glyphs.py" \
  || echo "  ! glyphs step failed — continuing"

step "demo COG  (local SST GeoTIFF for the cog:// Lab toggle)"
if python3 -c "import tifffile" 2>/dev/null || PYTHONPATH=/tmp/helm-pylibs python3 -c "import tifffile" 2>/dev/null; then
  python3 "$SCRIPT_DIR/make_demo_cog.py" || echo "  ! demo COG step failed — continuing"
else
  python3 -m pip install --quiet --target=/tmp/helm-pylibs tifffile 2>/dev/null \
    && PYTHONPATH=/tmp/helm-pylibs python3 "$SCRIPT_DIR/make_demo_cog.py" \
    || echo "  - tifffile unavailable; skipping demo COG (the .tif ships in the repo)"
fi

# --- ENC depth (optional; needs GDAL + a downloaded cell) ---
step "depth  (NOAA ENC -> GeoJSON)"
if [ -n "$ENC" ] && [ -f "$ENC" ]; then
  if have ogr2ogr; then
    bash "$SCRIPT_DIR/extract_depth.sh" "$ENC" "$DATA" || echo "  ! depth step failed — continuing"
  else
    echo "  ! GDAL not found (brew install gdal) — skipping depth"
  fi
else
  echo "  - no ENC cell passed; skipping depth"
  echo "    (usage: build.sh /path/to/USxxxx.000 — cells at https://www.charts.noaa.gov/ENCs/ENCs.shtml)"
fi

# --- offline chart tiles (optional, larger; the web demo uses LIVE tiles) ---
step "offline charts: NOAA raster -> mbtiles"
python3 "$SCRIPT_DIR/fetch_tiles.py" --source "$SRC_CHART" --bbox="$BBOX" \
  --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --out "$DATA/$REGION_NAME-charts.mbtiles" \
  --name "NOAA $REGION_NAME" || echo "  ! charts mbtiles failed — continuing"

step "offline charts: Sentinel-2 -> mbtiles"
python3 "$SCRIPT_DIR/fetch_tiles.py" --source "$SRC_SAT" --fmt jpg --bbox="$BBOX" \
  --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --out "$DATA/$REGION_NAME-sat.mbtiles" \
  --name "Sentinel-2 $REGION_NAME" || echo "  ! sat mbtiles failed — continuing"

step "done"
echo "web/data now contains:"
ls -1 "$DATA" | sed 's/^/  /'
echo
echo "serve it:  cd $ROOT/web && python3 -m http.server 8080   ->  http://localhost:8080"
