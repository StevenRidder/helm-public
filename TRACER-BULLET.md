# Tracer bullet

The first real code. One screen that proves the magic end-to-end on real data:
**satellite + ENC depth overlaid + a live wind layer + a route**, offline-capable.

**Go/no-go:** if this screen feels worth using, we commit to the native build. If not, we
learned cheaply — and the pipeline + style below are reused either way.

## Why this shape (web-first, but reusable)

About two-thirds of this carries straight to the native Swift app:

- **`pipeline/`** — the tiler, depth extractor, and wind fetcher are plain CLI. MapLibre
  GL JS (web) and MapLibre **Native** (Swift/Metal) consume the same `.mbtiles` + GeoJSON
  + wind JSON, so none of it changes.
- **`web/style.json`** — MapLibre's style spec is **identical** across web and native.
  The cartographic styling (depth fills, contours, soundings, route, wind) transfers verbatim.

Throwaway only if we later go *pure*-native: `web/index.html`'s JS glue and the WebGL wind
renderer (a Metal rewrite). If we wrap the web app (Tauri + Capacitor) instead, nothing is
throwaway and the prototype *is* the product. We decide that **after** feeling the perf.

## Prerequisites

- `python3` (the tiler + wind fetcher are stdlib — run now)
- `gdal` for the depth step only: `brew install gdal`
- a static server to view the page (`python3 -m http.server`)

## Run it

```bash
# 0) see the chart immediately (live satellite + sample route, no pipeline yet)
cd web && python3 -m http.server 8080      # open http://localhost:8080

# 1) build the data (new terminal) — one command: wind + places + offline charts
bash pipeline/build.sh
bash pipeline/build.sh ~/Downloads/US5FLxxx.000   # ...also ENC depth (needs GDAL)
```

Reload the page → depth + wind light up over the chart.

## What each step proves

| Step | Proves |
|---|---|
| page loads (live satellite + route) | MapLibre renders our style; the look matches the mockups |
| `fetch_tiles.py` → mbtiles | on-demand "lasso → offline charts" (ChartLocker, live) |
| `extract_depth.sh` → GeoJSON over satellite | **depth-on-satellite** (the differentiator) |
| `fetch_wind.py` → wind layer | composited weather over the chart |

## After go: the native step

1. New Xcode app (SwiftUI macOS) with **MapLibre Native** via Swift Package Manager.
2. Point it at the **same `style.json`** and the **same mbtiles** the pipeline produced.
3. Re-implement the layer toggles / inspector in SwiftUI.
4. Port the wind particle layer to a Metal custom layer (or keep web-wrapped — decide here).

Further build sequencing lives in the private roadmap; this public repo keeps the runnable
tracer-bullet path and supporting architecture notes.
