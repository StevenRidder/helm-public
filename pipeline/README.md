# Helm pipeline — the reusable engine

Front-end-agnostic data plumbing for the tracer bullet. **Everything here carries over to
the native Swift app unchanged** — it's plain CLI that produces mbtiles + GeoJSON + wind
JSON, which MapLibre (GL JS *and* Native) consume identically.

| Script | Does | Needs |
|---|---|---|
| `fetch_tiles.py` | lasso bbox → XYZ tiles → offline `.mbtiles` (TMS Y-flip handled) | python3 (stdlib) |
| `bake_s52_region_pack.py` | live S-52 chart tiles → stamped region `.pmtiles` pack | private `helm-tiles`/`helm-server` chart tile origin |
| `region_bundle.py` | `/catalog` JSON + route/bbox → region bundle manifest + delta plan | python3 (stdlib) |
| `layer_inventory.py` | `/catalog` + optional env bundles → boat-local chart/weather/depth/place inventory | python3 (stdlib) |
| `mbtiles_server.py` | Python reference/oracle for BYO MBTiles/PMTiles local serving; runtime serving is moving to C++ `helm-packd` | python3 (stdlib) |
| `fetch_wind.py` | gridded wind → `wind.json` (particles) + `wind_points.geojson` (arrows) | python3 (stdlib) |
| `extract_depth.sh` | NOAA ENC S-57 → `depare`/`depcnt`/`soundg` GeoJSON (depth-on-satellite) | GDAL (`brew install gdal`) |

## Run it

```bash
# one command (wind + places + offline charts; pass an ENC cell to also extract depth)
bash pipeline/build.sh
bash pipeline/build.sh ~/Downloads/US5FLxxx.000

# ...or step by step. NOTE the --bbox= form: a bbox starting with "-" is otherwise
# mistaken for a flag (argparse). Wind covers WIND_BBOX (much larger than the charts).
cd pipeline && cp region.env.example region.env && source region.env
python3 fetch_wind.py  --bbox="$WIND_BBOX" --nx="$WIND_NX" --ny="$WIND_NY" --out ../web/data
python3 fetch_places.py
python3 fetch_tiles.py --source "$SRC_CHART" --bbox="$BBOX" --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --out ../web/data/$REGION_NAME-charts.mbtiles --name "NOAA"
python3 fetch_tiles.py --source "$SRC_SAT" --fmt jpg --bbox="$BBOX" --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --out ../web/data/$REGION_NAME-sat.mbtiles --name "Sentinel-2"
python3 bake_s52_region_pack.py --source "http://127.0.0.1:9001/chart/{z}/{x}/{y}.png" --bbox="$BBOX" --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --palette day --palette dusk --palette night --edition "source-edition" --out ../web/data/$REGION_NAME-s52-{palette}.pmtiles
./extract_depth.sh ~/Downloads/US5FLxxx.000 ../web/data   # needs GDAL

# once a local pack helper is running, describe the whole offline region
python3 region_bundle.py --catalog http://127.0.0.1:9120/catalog --bbox "$BBOX" --minzoom "$MINZOOM" --maxzoom "$MAXZOOM" --bundle-id "$REGION_NAME" --title "$REGION_NAME"
```

Then serve the prototype: `cd ../web && python3 -m http.server 8080` → open
http://localhost:8080.

## Notes / ToS
- NOAA chart tiles + ENC: US public domain.
- Sentinel-2 cloudless (EOX): CC-BY-4.0 — attribute "Sentinel-2 cloudless by EOX".
- Open-Meteo: free for non-commercial; production swaps to GFS/ECMWF GRIB (same output format).
- Be polite: `fetch_tiles.py` sleeps between requests; cap zoom for big areas (size grows ~4× per zoom).
- S-52 region packs are point-in-time rendered snapshots. Repeat `--palette` to bake day/dusk/night
  sibling PMTiles in one run. The baker stamps source edition, render date, freshness window,
  requested-vs-baked tile counts, coverage gaps, and palette group metadata; `helm-packd`
  exposes those as `/catalog` `staleness`, `coverage`, and `warnings` fields for the UI.
- Local MBTiles/PMTiles may also have a sibling `*.metadata.json` or `*.sidecar.json`.
  The server exposes allow-listed source/license/freshness/coverage fields plus an
  explicit `inspection` policy, so raster taps can show pack metadata honestly
  without pretending pixels are S-57/S-101 objects.
- The local pack service exposes `GET /prefetch` for route-corridor or bbox tile
  manifests, e.g. `/prefetch?route=178.0,-18.0;178.3,-17.7&radius_nm=2&minzoom=8&maxzoom=12`.
  It is an advisory manifest for warming caches; it does not download or mutate packs.
- `HELM_ENV_BUNDLE_MANIFESTS=/path/to/manifest.json[,/path/to/other.json]` lets the
  local pack server expose prepared `helm.env.bundle.v1` weather/met-ocean bundles
  in `GET /layers` and `GET /prefetch`. The JSON response contains public manifest
  facts, coverage, valid times, freshness/cache-only policy, layer list, and sample
  handles, but never the private source file path.
- OFFLINE-16 introduced `helm-packd`, a small C++ replacement for the runtime
  portions of `mbtiles_server.py`. OFFLINE-17 extends it with `/layers`,
  `/prefetch`, `/bundle`, sidecar/source/freshness/coverage/inspection metadata,
  and environmental-bundle visibility. Keep `mbtiles_server.py` as the broad
  oracle/reference for manifest evolution; use `engine/test-packd.sh` for the
  C++ fixture smoke once `engine/bootstrap.sh` has built `build/cli/helm-packd`.
- `region_bundle.py` and `GET /bundle` publish `helm.region_bundle.manifest.v1`:
  catalog metadata, route/bbox prefetch advice, chart/basemap/depth/places components,
  per-component fingerprints, stale/out-of-coverage status, and a delta-plan helper for
  comparing an available bundle with an installed one. This is still read-only; clients
  decide how to download, retain, or evict packs.
- See [../docs/LEGAL.md](../docs/LEGAL.md) before adding Google/Bing/Navionics.
