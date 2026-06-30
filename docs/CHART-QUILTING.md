# Chart engine: multi-cell tiler → quilting, vs OpenCPN

**Status:** 2026-06-24 · `engine/vendor/cli/helm_tiles.cpp`
**TL;DR:** the tiler went from **one hard-coded cell** to **full per-tile quilting**. It loads a
whole folder of ENC cells and, for every `{z}/{x}/{y}` tile, composites the zoom-appropriate
covering cells (coarsest→finest, no-data transparent) into one seamless tile — overview when
zoomed out, harbour when zoomed in, no seams between cells. Because no-data is transparent it
also composites **over satellite** (depth-on-satellite). This doc explains what we built and —
concretely — **where OpenCPN's quilting falls short in its own code**, and what we do instead.

> Honesty note: OpenCPN class/method names below come from our file-by-file read
> (from the OpenCPN deep-read notes); the quilt lives in
> `gui/src/Quilt.cpp` + `ChartCanvas` (`gui/src/chcanv.cpp`). Treat exact symbol names as
> "as-read," re-verify against source before quoting in anything binding. The architectural
> claims (GUI/viewport coupling, dual GL/DC paths, no tile cache) are well-established.

---

## 1. What "quilting" means, and the three rungs

A sea area is covered by *many* ENC cells at different **usage bands** (1 overview … 6 berthing),
which overlap. Showing charts well means:

1. **Single-cell** *(where we were)* — load one cell, render its area, blank elsewhere.
2. **Multi-cell selection** *(done)* — load all cells; per tile, pick the zoom-appropriate
   covering cell. Seamless coverage as you pan; right detail as you zoom.
3. **Full quilting** *(done, 2026-06-24)* — within one tile, **stitch overlapping cells of
   different scales into one picture**: finer-on-top, no-data transparent, no seams, no holes —
   and, because no-data is transparent, composited over satellite too.

All three rungs are in. We reached rung 3 *per tile* — deterministic, headless, cacheable —
without inheriting OpenCPN's quilt problems (§4).

---

## 2. What we built (rung 2)

`helm_tiles.cpp` now:

- **Loads a folder of cells** (`init_charts(root)` → `wxDir::GetAllFiles("*.000")`), each into a
  `Cell { s57chart*, Extent, scale, path }`. Bad cells are **skipped, not fatal** (a real region
  folder has dud cells; keep serving the good ones). Fail-closed per cell on invalid native
  scale (SCAMIN/safety-contour selection can't be trusted then).
- **Picks the cell per tile** (`pick_cell`): of the cells covering the tile, choose the one whose
  native scale is closest **in log space** to the tile's display scale
  (`zoom_scale = 559082264.029·cos φ / 2^z`, the OGC Web-Mercator scale denominator), preferring
  a cell that contains the tile centre. Verified: at lat 24.5°, z8–10 → overview (1:700k),
  z11–12 → coastal (1:150k), z13–14 → approach (1:40k), z15–16 → harbour (1:12k).
- Renders that cell on the main thread (CoreGraphics) via the existing job queue; transparent
  tile where no cell covers.

---

## 3. Full quilting (rung 3) — DONE (2026-06-24)

Both pieces shipped, and our tile model made them *easier* than OpenCPN's canvas model:

1. **NODTA → transparent.** At init we capture the S-52 no-data colour
   (`ps52plib->getColor("NODTA")` — the same call the renderer uses to fill it) and key those
   pixels to alpha 0 in `render_cell_to_image`. A cell now paints **only where it has data**.
2. **Per-tile compositing.** `rank_cells` returns every in-band covering cell coarsest→finest;
   `render_tile` renders each into the tile and `composite_over`s them back-to-front. Finer
   cells land on top within their coverage; coarser fills the rest. **One tile, fully quilted —
   no seams, no holes** (the rung-2 straddle artifact is gone), and it's a pure function of the
   tile, so it's cacheable.

**Bonus — depth-on-satellite unlocked.** Because NODTA is now transparent, the ENC tiles
composite over MapLibre's satellite layer instead of laying down an opaque grey blanket. Turn on
*Satellite* + *S-52 charts (engine)* together and the chart sits over the imagery — Helm's
headline differentiator, which OpenCPN's canvas model **cannot** do (§4, row 6).

This is quilting *as a pure function of the tile* — deterministic, parallelizable, headless,
and CDN/offline-cacheable. OpenCPN cannot do any of those (see §4).

---

## 4. Where OpenCPN's quilting falls short — in its own code

These are properties of OpenCPN's `Quilt`/`ChartCanvas` design, not user error:

| # | OpenCPN, per its code | Consequence | What we do instead |
|---|---|---|---|
| 1 | **Quilt is welded to the GUI ViewPort and the canvas paint thread.** `Quilt::Compose` runs on the wx paint path against the live `ViewPort`. | Pan/zoom **recomputes the candidate array and re-renders the whole viewport every frame**; no persistent cache → repeated work, stutter on big chart sets / slow hardware. | **Per-tile render, cached.** A pan is cache hits, not recompute. Tiles are immutable for a cell version. |
| 2 | **Reference-chart selection is a scale-threshold heuristic** (`m_reference_scale`, `m_refchart_dbIndex`, `BuildExtendedChartArray`). | Well-known **"quilt flashing"** (charts popping in/out while zooming), wrong reference chart at band boundaries, and **quilt holes** where mismatched-scale overlaps leave gaps. | **Deterministic per-tile log-scale nearest pick.** No frame-to-frame popping (a tile's choice is fixed); holes impossible once compositing fills coarser-under-finer. |
| 3 | **Two divergent render paths** — `RenderQuiltViewGL` vs `…DC`. | They drift; overzoom/blending bugs differ between GL and DC; double the maintenance. | **One DC path, headless.** GL isn't needed — MapLibre composites the raster tiles at 60 fps. |
| 4 | **Coverage clipping via per-chart `M_COVR` regions on the canvas.** | Geometry edge-cases → **visible seams/overlaps at cell edges** (notably CM93 composite). | Compositing clips by the same coverage but **per tile**, so errors are bounded to one 256-px tile and fixed by finer-on-top fill. |
| 5 | **No tiling, no tile cache, no headless mode, single-client.** It *is* a desktop canvas. | Can't pre-bake tiles, can't serve a CDN, can't feed multiple displays, can't run server/edge-side. | **Slippy-tile HTTP server today**; trivially cache to disk / mbtiles (offline) / CDN; multi-client; already headless. |
| 6 | **Renders to the chart canvas only.** | **Cannot composite ENC over satellite** — depth-on-satellite (Helm's headline differentiator) is impossible in OpenCPN's model. | ENC tiles composite over MapLibre's satellite/raster — the fused screen. |
| 7 | **Loads full SENC for every quilt candidate** held in memory. | Large areas = heavy RAM; no demand paging. | Same today (we load all cells), but the tile model allows **lazy load + LRU evict per tile demand** — a clean future win OpenCPN's design resists. |

---

## 5. Where OpenCPN is still ahead (what we must earn)

Not overclaiming — these are real and we haven't matched them yet:

- **True multi-scale-in-one-view** (a single screen stitching harbour + approach + coastal). We
  pick one band per tile today; rung-3 compositing closes most of this, but OpenCPN's view-level
  quilt is more general.
- **Decades of M_COVR/seam hardening** across thousands of messy real-world cells, plus **CM93**,
  **S-63/oeSENC encrypted** formats, and the long tail of **S-52 conditional symbology**.
- **Mature SCAMIN/overzoom behaviour** tuned over many releases.

The plan reaches **parity on correctness** (rung 3 + format coverage) while **beating OpenCPN on
architecture** (cacheable, headless, multi-client, fused-over-satellite, parallel pre-bake) —
because those wins fall out of the tile-server design, not from out-coding a mature renderer.

---

## 6. Try it

```bash
# folder of ENC cells (recursively scanned), or a single .000:
HELM_ENC_ROOT=/path/to/ENC_ROOT  "$HELM_OCPN_DIR/build/cli/helm-tiles"
#   → loads N cells, logs "native scales 1:x .. 1:y", serves zoom-quilted tiles on :8082
```

The MapLibre `enc` raster source (`web/style.json`, "S-52 charts (engine)" toggle) consumes it
unchanged — now with real coverage as you pan and the right band as you zoom.

---

## 7. Why OpenCPN makes you toggle views/zooms/basemaps — and we don't

This is the "Google Earth, curvature-of-the-earth to a beach, seamless" question. OpenCPN
forces manual toggling because of *what it fundamentally is*, not bad UX:

- **It's a stack of discrete charts, not a continuous pyramid.** Each ENC cell is a separate
  object with a native scale. Quilting stitches *compatible-scale* charts for the current view,
  but crossing a scale band isn't continuous — it pops, or you press the **chart up/down**
  hotkeys / click the chart-bar "piano keys" to jump to the next chart. There is no single
  zoomable surface. **We** serve a **slippy-tile pyramid**: every zoom is a level-of-detail the
  renderer swaps automatically and continuously; the multi-cell quilter picks the band *by zoom*
  (§2). Pinch and it just works — no chart hotkeys.

- **It's flat Mercator on a desktop canvas, not a globe.** You can't pull back to see Earth's
  curvature because the projection and engine aren't a globe (at most a "perspective" tilt). We
  run MapLibre, which now does a **globe projection** — a real sphere at world scale that
  flattens to Mercator as you zoom in. Enabled (2026-06-24): zoom all the way out → the globe;
  all the way in → the beach; one continuous motion. *(Needs MapLibre v5; guarded so older
  builds stay flat.)*

- **No native, curated basemap — so you swap chart sets for clean imagery/color.** OpenCPN's
  base *is* the chart; satellite is bolted on as separate mbtiles/plugin chart sets, so to get
  good imagery (or dodge clouds, or change color) you toggle chart groups. **We** composite on
  **one surface**: cloudless **Sentinel-2 (s2cloudless)** is the default base, ENC composites
  over it (NODTA transparent, §3), weather layers on top — and **Day/Dusk/Night** is one
  first-class toggle (auto-by-time is a small next step). Nothing to swap for clean color.

**Net:** OpenCPN's toggling is a symptom of *discrete-charts + flat-Mercator + bolt-on imagery*.
Helm is *continuous-pyramid + globe + one composited surface*, so the seamless Google-Earth feel
is the **default behaviour**, not a feature to bolt on.

---

*Cross-references: [OPENCPN-REUSE.md](OPENCPN-REUSE.md) (quilting = "rebuild, high"),
[CHART-PIPELINE.md](CHART-PIPELINE.md) (on-demand download + depth-on-satellite). Broader
chart capability context lives in the private feature audit.*
