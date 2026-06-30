# ADR-0006 — Adopt awesome-maplibre tools where they replace home-rolled code

- **Status:** Accepted (prototype)
- **Date:** 2026-06-24

## Context

The tracer-bullet web app hand-rolls several MapLibre capabilities: a wind particle
canvas (`wind-layer.js`), a scalar heatmap from a custom JSON blob (`field-layer.js`),
pressure isobars via marching squares (`isolines.js`), a RainViewer radar cycler
(`radar.js`), and an mbtiles offline-tiler (`pipeline/`). The
[awesome-maplibre](https://github.com/maplibre/awesome-maplibre) list has off-the-shelf
libraries that overlap these and the product's differentiators (fused weather, on-demand
charts, depth, AIS, routing). Worth knowing which to adopt before we freeze contracts for
the native Swift port.

## Decision

Wire **ten** of them against the prototype behind a new **Lab** drawer, keeping the
production UI intact, and record the keep/replace verdict for each. See
[docs/integrations/awesome-maplibre.md](../integrations/awesome-maplibre.md) for the wiring.

**Adopt / strong candidates to replace our code**

- **maplibre-contour** → **ADOPTED in production** (2026-06-25): off-thread DEM depth
  contours in the Layers drawer (`web/depth-contours.js`), fed by a LOCAL terrain-RGB DEM
  (`pipeline/fetch_dem.py` → `web/data/dem/`). The hand-rolled `isolines.js` is **deleted**.
  Note: the open Terrarium DEM is flat over the immediate Key West shoal, so contours show
  over the deeper approaches; a higher-res local bathymetry can feed the same path later.
- **PMTiles** → the offline-charts container, replacing `.mbtiles` (single file, no
  server, no TMS Y-flip). Pipeline step added (`make_pmtiles.sh`).
- **maplibre-cog-protocol** → GRIB→COG and depth/imagery stream with no tiler; simplifies
  `pipeline/` for raster.
- **Mercator (value-encoded tiles)** → the right contract for weather vs our fixed-bbox
  `field-*.json` blob. Hosted/keyed, so adopt the *pattern* now, evaluate the service.
- **MapLibre v5 globe** → in-core; bumped 4.7.1→5.24.0.

**Adopt as additive capability (no existing code to replace)**

- **Terra Draw** → route editing + the "lasso → fetch charts" gesture (emits a bbox to the
  Download drawer).
- **deck.gl** → AIS at scale (scatter + heatmap) beyond the symbol-layer sample.
- **maplibre-gl-measures** → distance/bearing nav tool.
- **maplibre-gl-temporal-control** → reusable time scrubber for every weather layer.
- **Martin** → off-the-shelf server for the offline packs (config + docs; complements the
  Engine's ENC endpoint).

**Explicitly NOT adopted**

- **Native raster-particle layer** → does **not** exist in MapLibre (Mapbox-only). Keep
  `wind-layer.js`; it's projection-aware and rides the v5 globe by design. The Metal port
  for the native app stays on the roadmap as planned.

## Consequences

- New `web/integrations/` ESM modules, lazy-loaded via an import map + a MapLibre shim, so
  page load and the production UI are unaffected if a CDN is slow or a plugin breaks.
- Native-port note: measures reports km/mi → convert to NM; the style-spec layers
  (contours, hillshade) transfer verbatim to MapLibre Native, the plugins (deck.gl,
  Terra Draw, measures, temporal) are web-only and need Swift equivalents.
- **Verification:** modules follow each library's documented API against pinned current
  versions but need a browser smoke test (build env is headless). deck.gl core
  de-duplication and the Terra Draw adapter options are the likeliest tweaks.
