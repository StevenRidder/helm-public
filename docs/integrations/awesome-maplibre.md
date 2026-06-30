# Integration scope — awesome-maplibre

> Source: <https://github.com/maplibre/awesome-maplibre>. We mined the list for
> tools that touch Helm's differentiators (fused weather, on-demand/offline
> charts, depth, AIS, routing) and wired ten of them against the tracer-bullet
> web app. This doc is the map of what each is, where it lives, and its status.

All ten are reachable from the **Lab** drawer (flask icon in the left rail), except
the two server-side ones (Martin, Mercator) which are docs + config. The production
tracer-bullet UI is untouched — the Lab is a side-by-side surface for feeling each
library on real Key West data.

## How the web wiring works

The prototype is dependency-free classic `<script>` modules. The new plugins are
ESM on a CDN, so:

- `web/index.html` carries an **import map** resolving each bare specifier to
  `https://esm.sh/<pkg>` with `?external=maplibre-gl`.
- `web/integrations/_maplibre-shim.js` re-exports the page's single global
  MapLibre so plugins don't pull a second copy (and `instanceof` holds).
- `web/integrations/lab.js` **lazy-imports** each module the first time its toggle
  is switched on — a slow/unreachable CDN never blocks page load, and one broken
  integration can't take down the others.
- MapLibre GL JS was bumped **4.7.1 → 5.24.0** for the globe projection.

## The ten

| # | Library | Where | Maps onto | Status |
|---|---------|-------|-----------|--------|
| 1 | **MapLibre v5 globe** (in-core) | Lab → Globe projection | wind-layer.js is projection-aware, so it rides the globe | wired |
| 2 | **PMTiles** `pmtiles@4` | Lab → PMTiles offline raster; `pipeline/make_pmtiles.sh` | offline chart pack (replaces `.mbtiles`, no server, no Y-flip) | wired (needs converted file) |
| 3 | **maplibre-cog-protocol** `@geomatico/...@0.9` | Lab → COG overlay | GRIB→COG weather + depth/imagery, no tiler | wired (demo COG) |
| 4 | **maplibre-contour** `@0.1` | Lab → Contours from DEM | replaces hand-rolled `isolines.js`; depth contours from Terrarium bathymetry | wired |
| 5 | **Mercator pattern** (mercator.blue) | Lab → Value-encoded tiles | weather as value-encoded tiles vs our `field-*.json` blob | pattern demo + service documented |
| 6 | **Terra Draw** `terra-draw@1` + maplibre adapter | Lab → Draw route / Lasso area | route editing + the "lasso → fetch charts" gesture | wired (lasso emits bbox → Download drawer) |
| 7 | **maplibre-gl-measures** `@0.0.20` | Lab → Measure | distance/bearing nav tool | wired |
| 8 | **maplibre-gl-temporal-control** `@1.2` | Lab → Temporal control | time scrubber across weather frames (demo: RainViewer nowcast) | wired |
| 9 | **deck.gl** `@deck.gl/*@9.3` | Lab → AIS at scale | hundreds/thousands of AIS targets (scatter + heatmap) | wired (synthetic fleet for the scale demo) |
| 10 | **Martin** | `pipeline/martin/config.yaml` | off-the-shelf tile server for the offline packs | config + docs (server-side) |

## Notes per integration

- **Globe** — MapLibre has **no** native raster-particle layer (that's Mapbox-only),
  so we kept `wind-layer.js`. The win from v5 is the globe; the particle canvas
  reprojects per-frame and already survives it by design.
- **PMTiles** — the Lab toggle loads `pmtiles://data/<region>-sat.pmtiles`. Produce it
  with `bash pipeline/make_pmtiles.sh` (needs the `pmtiles` CLI). Until then the toggle
  shows a "run the pipeline" notice instead of erroring.
- **COG** — `cog://<url>` with an optional `#color:` fragment that colourises a
  value-encoded single-band COG client-side. Demo points at geomatico's public DEM;
  swap for a `gdal_translate -of COG` GFS field in production.
- **Contour** — uses the public **Terrarium** DEM, which encodes bathymetry, so around
  Key West it draws real depth contours. For isobars, feed a pressure field as
  terrain-RGB through the same path.
- **Mercator** — mercator.blue is a hosted, keyed service. Rather than gate the demo on
  a signup we show the *pattern* (decode a value-encoded raster → MapLibre hillshade)
  live with Terrarium tiles. Production weather would point the same machinery at
  mercator.blue (or our own GRIB→value-tile bake).
- **Measures** — the plugin reports km/mi; a chartplotter post-converts to NM
  (1 NM = 1.852 km). Tracked for the native port.
- **deck.gl** — synthesises ~2,000 jittered targets to make the "at scale" point;
  the layers are identical for a live AIS feed.
- **Martin** — serves the pipeline's mbtiles/pmtiles over HTTP TileJSON. Complements
  the Helm Engine's ENC tile endpoint rather than replacing it.

## Verification status

Modules are written to each library's documented API and the import map versions are
pinned to current releases. **A visual smoke test in a browser is still required** (the
build environment is headless): run `cd web && python3 -m http.server 8080`, open the
Lab drawer, and toggle each. Most likely to need a small tweak: deck.gl (multiple
`@deck.gl/core` resolutions) and the Terra Draw adapter constructor options.
