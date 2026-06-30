# Vulkan Depth And Shoreline Fixtures

Status: POC fixture-cell selection for Vulkan board `DEPTH-1`

This document selects the first real NOAA ENC targets for depth, shoreline, and
quilt-boundary renderer work. It extends the fixture policy in
[VULKAN-RENDER-FIXTURES.md](VULKAN-RENDER-FIXTURES.md) without committing any
raw chart cells, SENC caches, or private chart data.

## Source Policy

The capture source of truth is NOAA's public S-57 ENC distribution:

```text
https://www.charts.noaa.gov/ENCs/<CELL>.zip
```

Use NOAA's product catalog to refresh cell metadata before a capture run:

```text
https://www.charts.noaa.gov/ENCs/ENCProdCat_19115.xml
```

NOAA ENC Direct is useful for preflight inspection and feature-count sanity
checks. It is not the renderer input contract; captures still use the S-57 ENC
zip for the selected cell.

Relevant ENC Direct layer families:

| Service | Layers Used For Preflight |
|---|---|
| `enc_harbour` | `Sounding_point`, `Depth_Area`, `Depth_Contour_line`, `Coastline_line`, `Land_Area` |
| `enc_approach` | approach-scale soundings, coastlines, shoreline construction, contours, depth areas, land areas |
| `enc_coastal` | coastal-scale shoreline, contours, depth areas, land areas, tidal stream context |

Committed fixture metadata may include NOAA cell id, title, source URL, catalog
date, downloaded zip hash, `.000` file hash, feature-count spot checks, and
capture bbox. Do not commit the raw `.zip`, `.000`, generated SENC, rendered
PNG baselines from non-redistributable sources, or private chart packs.

## Selected Cells

### Primary Harbor Pair: Key West

| Cell | NOAA Title | Use |
|---|---|---|
| `US5FL4CR` | Entrance to Key West Harbor | Primary depth/safety-contour fixture |
| `US5FL4CP` | Approaches to Key West Harbor | Harbor approach shoreline and land/coverage companion |

Why this pair:

- already matches Helm's sample-cell workflow (`scripts/install-sample-enc.sh`
  defaults to `US5FL4CR`);
- keeps the first real capture small and fast;
- covers dense soundings, many depth contours, depth areas, and a neighboring
  approach cell for land/coastline/quilt transitions;
- stays close to the historical `US5FL96M` proof region without relying on that
  retired-or-historical cell as a primary target.

Live spot checks against NOAA ENC Direct on 2026-06-28 UTC:

| Cell | Service | Soundings | Depth Areas | Drying Areas (`DRVAL1 < 0`) | Depth Contours | Coastline Lines | Land Areas |
|---|---|---:|---:|---:|---:|---:|---:|
| `US5FL4CR.000` | `enc_harbour` | 1131 | 184 | 1 | 190 | 0 | 0 |
| `US5FL4CP.000` | `enc_harbour` | 916 | 98 | 5 | 97 | 2 | 2 |

### Approach-Scale Shoal And Shoreline Set

| Cell | NOAA Title | Use |
|---|---|---|
| `US4DE12M` | Delaware Bay | Shoals, shoreline construction, dense contours, broad depth areas |
| `US4LA1EP` | Mississippi River - Head of Passes | Delta shoreline complexity, land/water boundaries, many contours |

Why this pair:

- gives the renderer broad estuary/delta cases that Key West does not stress;
- exercises shallow-area polygons, contour transitions, land/water edges, and
  shoreline-construction lines;
- provides likely future quilting stress around rivers, passes, and shoals.

Live spot checks against NOAA ENC Direct on 2026-06-28 UTC:

| Cell | Service | Soundings | Depth Areas | Drying Areas (`DRVAL1 < 0`) | Depth Contours | Coastline Lines | Shoreline Construction Lines | Land Areas |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `US4DE12M.000` | `enc_approach` | 1172 | 134 | 57 | 151 | 277 | 31 | 129 |
| `US4LA1EP.000` | `enc_approach` | 500 | 242 | 100 | 245 | 631 | 192 | 403 |

### Coastal-Scale Regression Context

| Cell | NOAA Title | Use |
|---|---|---|
| `US3WA46M` | Puget Sound | Coastal shoreline density, many depth contours, scale-band context |
| `US3DE01M` | Cape May to Cape Hatteras | Broad coastal soundings, Atlantic shoreline, Delaware approach companion |

Why this pair:

- gives the POC one Pacific Northwest and one Atlantic coastal-scale context;
- makes future scale-band and SCAMIN checks less Key-West-specific;
- supports broader coastline and contour regressions once VSG rendering is
  stable enough for larger scenes.

Live spot checks against NOAA ENC Direct on 2026-06-28 UTC:

| Cell | Service | Soundings | Depth Areas | Drying Areas (`DRVAL1 < 0`) | Depth Contours | Coastline Lines | Shoreline Construction Lines | Land Areas |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `US3WA46M.000` | `enc_coastal` | 2099 | 598 | 341 | 700 | 383 | 434 | 72 |
| `US3DE01M.000` | `enc_coastal` | 4963 | 179 | 0 | 188 | 319 | 20 | 313 |

## Historical Proof Cell

`US5FL96M` remains useful as a historical proof reference because the headless
chart-render spike rendered it successfully. It should not be the primary
DEPTH-1 fixture target unless a capture job verifies it in the current NOAA
catalog. Prefer `US5FL4CR` and `US5FL4CP` for new work.

## Capture Matrix

Every capture should record:

```text
cell id and NOAA title
NOAA zip URL
catalog dateStamp and zipfile date/time
downloaded zip sha256
extracted .000 sha256
capture bbox or tile z/x/y
service/layer spot checks used to justify the fixture
palette
display category
safety depth and safety contour settings
show_text and show_soundings toggles
command-stream hash
image hash or review artifact
```

Minimum DEPTH capture set:

| Fixture Name | Cell | View | Display State | Purpose |
|---|---|---|---|---|
| `key-west-harbor-safety10` | `US5FL4CR` | existing Key West tile `z=12 x=1120 y=1756` | day, standard, safety depth 10 m | baseline depth areas, contours, soundings |
| `key-west-harbor-safety20` | `US5FL4CR` | same tile | day, standard, safety depth 20 m | safety-contour color transition |
| `key-west-approach-land` | `US5FL4CP` | bbox overlapping approach/land edge | day, standard, safety depth 10 m | coastline, land area, coverage edge, small drying-area case |
| `delaware-bay-shoals` | `US4DE12M` | shoal/shoreline bbox selected after download | day, standard, safety depth 10 m | broad shoals, drying areas, shoreline construction, contours |
| `mississippi-head-passes` | `US4LA1EP` | delta/pass bbox selected after download | day, standard, safety depth 10 m | river/delta shoreline, drying areas, land/water complexity |
| `puget-sound-coastal-scale` | `US3WA46M` | coastal-scale bbox selected after download | day, standard, safety depth 10 m | dense coastline, drying areas, scale-band regression |

Do not add all captures at once. Start with `key-west-harbor-safety10`, then
add one fixture at a time as VSG/offscreen rendering and golden comparison
mature.

## Downstream Tasks

- `DEPTH-2` should use these cells to prototype polygon and line tessellation
  for depth areas, shorelines, land, and contours.
- `DEPTH-3` should use `key-west-harbor-safety10` and
  `key-west-harbor-safety20` to prove safety-contour styling changes.
- `DEPTH-4` should use the larger `US4DE12M`, `US4LA1EP`, and `US3WA46M`
  captures for tile-scale performance smoke once the small Key West baseline is
  stable.
- `DEPTH-5` should use `US5FL4CP`, `US4LA1EP`, and `US3WA46M` for collars,
  coverage boundaries, and quilting edge cases.
- `QA-2` should record command hash, image hash, source zip hash, and `.000`
  hash for every promoted golden fixture.

## Acceptance For DEPTH-1

DEPTH-1 is complete when:

- the primary cell set is explicit and small enough for repeatable POC work;
- each selected cell is public NOAA ENC data referenced by runtime download URL;
- no chart bundle, SENC cache, or generated non-source artifact is committed;
- the selected cells cover shoreline polygons, depth areas, depth contours,
  soundings, land/coastline boundaries, and safety-contour transitions;
- downstream DEPTH and QA tasks have a concrete capture order.
