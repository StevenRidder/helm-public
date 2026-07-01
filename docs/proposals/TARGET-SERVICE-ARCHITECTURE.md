# Helm/OpenCPN C++ Target Service Architecture

Status: Draft  
Date: 2026-07-01  
Scope: C++/OpenCPN-native target service architecture based on the public OpenCPN repository and Helm's HELMC++ acceptance gate

## Purpose

This document starts from OpenCPN's public source layout, then proposes the
C++ service boundaries Helm should expose around it. It describes the target
architecture, not a claim that every current public-alpha service has already
been ported.

The goal is not "many processes everywhere." The goal is a boat system made of
small, inspectable, independently testable C++ building blocks with explicit
contracts. Required boat-side runtime services are C++/CMake/OpenCPN-native.
Today, Python remains in working weather/reference services, pipelines,
fixtures, and optional AI/community surfaces. Those paths are useful while the
contracts are proven, but they are not the intended required-runtime end state.

Interface catalog: [INTERFACE-CATALOG.md](INTERFACE-CATALOG.md)

Graphic view: [target-service-architecture.svg](target-service-architecture.svg)

Canonical Helm runtime gate: [../HELMCXX-ACCEPTANCE.md](../HELMCXX-ACCEPTANCE.md)

## Source Audit

Audit target: public [OpenCPN/OpenCPN](https://github.com/OpenCPN/OpenCPN) `master` at commit `6d120d5627dd751e63d7d463fd372cc583b7bfcd` on 2026-07-01.

The audit used the public repository, not Helm's vendored runtime tree.

### OpenCPN Surfaces

| Surface | Public OpenCPN path | Architecture read |
|---|---|---|
| Navigation model | `model/include/model`, `model/src`, `model/CMakeLists.txt` | C++ model layer already contains routes, tracks, nav objects, AIS, comm drivers, ownship state, local APIs, notifications, plugin loading, and persistence surfaces. |
| Routes and tracks | `model/include/model/routeman.h`, `route.h`, `route_point.h`, `track.h`, `nav_object_database.h`, `navobj_db.h` | Route activation, waypoint progression, GPX/navobj persistence, and track storage belong in the C++ nav service boundary. |
| Instrument and comm input | `comm_drv_*`, `comm_navmsg*`, `comm_ais.*`, `multiplexer.*`, `own_ship.h` | NMEA 0183, NMEA 2000, Signal K, AIS, and ownship truth are OpenCPN-native C++ concerns. |
| Chart abstraction | `gui/include/gui/chartbase.h`, `chartdb.h`, `chartdbs.h`, `chartimg.h` | Chart loading, catalog/index, chart stacks, and chart cache are existing C++ chart-service seams. |
| S-57/S-52 chart path | `gui/include/gui/s57chart.h`, `s57_*`, `s57/CMakeLists.txt`, `data/s57data/*` | Official chart portrayal must remain in the OpenCPN chart/presentation path. S-52 assets live in `data/s57data`. |
| Canvas and quilting | `gui/include/gui/chcanv.h`, `gl_chart_canvas.h`, `quilt.h`, `viewport.h` | Current GUI rendering mixes canvas interaction, quilting, OpenGL rendering, and viewport math. Helm should extract contracts without moving cartography into clients. |
| Plugin API | `include/ocpn_plugin.h`, `model/src/ocpn_plugin.cpp`, `model/src/plugin_*` | OpenCPN already has a capability-based plugin contract. Helm proposals should respect this instead of inventing a hidden runtime bus. |
| Headless/CLI shim | `cli/CMakeLists.txt`, `cli/api_shim.cpp`, `cli/console.cpp` | OpenCPN already carries a command-line/shim precedent useful for bounded headless tests and proof slices. |
| Weather plugin example | `plugins/grib_pi` | GRIB/weather is C++ plugin/runtime code in OpenCPN. Helm environmental runtime should follow C++ contracts, not a web-service runtime model. |
| Dashboard/example integrations | `plugins/dashboard_pi`, `plugins/chartdldr_pi`, `plugins/wmm_pi` | These show existing plugin/data-flow patterns for instrument panels, chart download, and magnetic variation. |

### Current OpenCPN Ownership Boundaries

OpenCPN already suggests these boundaries:

- `model/` owns navigation, comms, AIS, nav objects, persistence, notifications, local API, and plugin management substrate.
- `gui/include/gui` owns chart canvas, chart database, chart display, S-57 chart classes, query UI, quilting, OpenGL canvas, and user-facing GUI surfaces.
- `s57` and `data/s57data` carry the S-57/S-52 chart and presentation asset path.
- `include/ocpn_plugin.h` defines the extension capability contract and overlay priorities.
- `cli` provides a bounded C++ command/headless shim precedent.

Helm should align with these seams instead of inventing a parallel runtime architecture.

## Target Architecture

```text
                         clients
       browser / iPad / native / test harnesses
                           |
                           v
                    helm-gateway
       one-origin TLS, pairing, auth, static UI, routing
                           |
   ----------------------------------------------------------------
   |              |              |              |                  |
   v              v              v              v                  v
helm-navd    helm-chartd    helm-packd    helm-envd          helm-layerd
OpenCPN      OpenCPN chart  local packs   environmental      user/extra
model nav/   DB + S-57/     catalog,      bundles and        overlays and
AIS/routes   S-52 tiles     layers,       field replay       metadata
alarms       queries        prefetch
   |              |              |              |                  |
   |              v              v              v                  v
   |         helm-renderd   helm-cache     field/cache       layer index
   |         neutral model  GPU/tile       artifacts         inspection
   |         draw backend   artifacts
   |
   v
hardware/input adapters
NMEA 0183 / NMEA 2000 / Signal K / AIS / GPS / depth / pilot boundaries
```

Some boxes may remain in one process for a while. The target is contract
separation first, process separation second.

## Service Catalog

### 1. `helm-gateway`

Purpose:

- One-origin TLS endpoint.
- Pairing and auth.
- Bonjour/mDNS advertisement.
- Static client serving.
- Reverse proxy/routing to local C++ daemons.
- Common health surface.

OpenCPN anchors:

- `model/include/model/mdns_*`
- `model/include/model/pincode.h`
- `model/include/model/rest_server.h`
- `model/include/model/local_api.h`

Split recommendation:

- Keep one-origin behavior as the external product boundary.
- Keep pairing/auth centralized so each daemon does not grow its own security surface.

Boundary RFC:

- `RFC: Helm Gateway, Pairing, And Service Discovery`

### 2. `helm-navd`

Purpose:

- OpenCPN `model/` navigation core.
- Routes, active route, ETA, XTE, waypoint advance.
- Track recording and nav-object persistence.
- AIS decode and target state.
- Nav state stream.
- Alarm state and ack/replay.
- Connection adapters for NMEA 0183, NMEA 2000, Signal K, GPS, depth, and pilot-status inputs.

OpenCPN anchors:

- `model/include/model/routeman.h`
- `model/include/model/route.h`
- `model/include/model/route_point.h`
- `model/include/model/track.h`
- `model/include/model/nav_object_database.h`
- `model/include/model/navobj_db.h`
- `model/include/model/ais_decoder.h`
- `model/include/model/ais_target_data.h`
- `model/include/model/comm_drv_*`
- `model/include/model/multiplexer.h`
- `model/include/model/own_ship.h`

Keep authoritative here:

- Route progression.
- CPA/TCPA and AIS state.
- Ownship/source validity and staleness truth.
- Alarm state derived from nav/chart/runtime truth.
- Pilot command preconditions and read-only pilot status.

Do not push to clients:

- OpenCPN-derived route/nav semantics.
- CPA/TCPA authority.
- Active route progression authority.
- Source-validity decisions.

Boundary RFC:

- `RFC: Nav State And Alarm Stream`
- `RFC: Route/Track Command Contract`

### 3. `helm-chartd`

Purpose:

- Chart source loading.
- Chart database/catalog/index behavior.
- S-57/S-52 chart tile generation.
- Object query.
- Chart groups/stacks.
- Presentation provenance.

OpenCPN anchors:

- `gui/include/gui/chartbase.h`
- `gui/include/gui/chartdb.h`
- `gui/include/gui/chartdbs.h`
- `gui/include/gui/s57chart.h`
- `gui/include/gui/s57_object_desc.h`
- `gui/include/gui/s57_query_dlg.h`
- `s57/CMakeLists.txt`
- `data/s57data/chartsymbols.xml`
- `data/s57data/rastersymbols-day.png`
- `data/s57data/rastersymbols-dusk.png`
- `data/s57data/rastersymbols-dark.png`
- `data/s57data/S52RAZDS.RLE`

Keep authoritative here:

- Official chart portrayal execution.
- Feature-to-symbol selection for official chart content.
- Display category, SCAMIN, safety contours, text/soundings.
- Chart object query semantics.
- Source-to-render provenance for official chart content.

Do not let other services own:

- Official chart portrayal.
- Cartographic z-order/display priority.
- Safety-contour behavior.
- Chart feature-to-symbol decisions.

Boundary RFC:

- `RFC: Chart Service Contract`
- `RFC: Presentation Compiler Boundary`
- `RFC: Source-To-Render Query Contract`

### 4. `helm-renderd`

Purpose:

- Draw-only rendering backend service or module.
- Neutral render model consumption.
- Native VSG/Vulkan proof backend.
- Helm WebGPU artifact parity target.
- Render command stream consumption.

OpenCPN anchors:

- `gui/include/gui/gl_chart_canvas.h`
- `gui/include/gui/gl_tex_cache.h`
- `gui/include/gui/gl_texture_mgr.h`
- `gui/include/gui/ocpndc.h`
- `gui/include/gui/shaders.h`
- `gui/include/gui/viewport.h`

Split recommendation:

- Keep as module/library until the command stream and cache contract are stable.
- Do not make the renderer a network daemon until there is a measured reason.

Why:

- GPU lifecycle, platform windows, and offscreen contexts are operationally sensitive.
- The seam matters more than process separation.

Boundary RFC:

- `RFC: Nautical Render Command Stream`
- `RFC: Draw-Only Backend Contract`

### 5. `helm-packd`

Purpose:

- Local package service.
- MBTiles/PMTiles/package serving.
- `/catalog`, `/layers`, `/prefetch`, `/bundle`.
- Region bundles and route-corridor cache advice.
- Public sidecar metadata allow-listing.

OpenCPN anchors:

- `gui/include/gui/mbtiles.h`
- chart database/catalog patterns under `gui/include/gui/chartdb*`
- plugin chart extension concepts in `include/ocpn_plugin.h`

Keep authoritative here:

- Local package identity.
- Offline package coverage.
- Pack freshness and source metadata.
- Package-level inspection envelopes.

Do not own:

- Official chart portrayal.
- Navigation truth.
- Environmental field meaning beyond package metadata.

Boundary RFC:

- `RFC: Local Package Service`
- `RFC: Portable Nautical Package And Index`
- `RFC: Route/BBox Prefetch Manifest`

### 6. `helm-cache`

Purpose:

- Generic tile/cache/proxy service.
- Cache-first tile replay.
- Stale-while-revalidate behavior.
- Online-fill or remote/local-pack fallback when enabled.

OpenCPN anchors:

- Existing OpenCPN cache patterns in chart DB and GL texture/cache headers.
- Helm's C++ runtime cache service follows the same C++ runtime rule.

Do not own:

- Source chart truth.
- Chart portrayal.
- Environmental truth.
- Route/nav decisions.

Boundary RFC:

- `RFC: Tile Cache/Proxy Contract`

### 7. `helm-envd`

Purpose:

- Environmental model-run bundles.
- Weather/metocean field tiles.
- Prepared replay of wind/current/waves/temp/rain/cloud layers.
- Materialization and local replay jobs.

OpenCPN anchors:

- `plugins/grib_pi` demonstrates C++ GRIB/weather parsing and rendering surfaces.
- `plugins/grib_pi/src/GribReader.h`
- `plugins/grib_pi/src/GribV2Record.h`
- `plugins/grib_pi/src/GribOverlayFactory.h`

Keep authoritative here:

- Prepared environmental bundle manifests.
- Field tile identity and valid-time metadata.
- Missing/out-of-coverage/stale environmental states.
- Source/provenance metadata for environmental data.

Do not own:

- Official chart portrayal.
- Navigation authority.
- Renderer/backend policy.

Boundary RFC:

- `RFC: Environmental Bundle Service`
- `RFC: Field Texture Artifact Contract`

### 8. `helm-layerd`

Purpose:

- Extra georeferenced user/application layers.
- GeoJSON/PMTiles/COG/OGC-style overlays.
- User-data indexing.
- Inspection metadata.
- Local source attribution and freshness.

OpenCPN anchors:

- `include/ocpn_plugin.h` overlay callbacks, vector object info, mouse events, and plugin messaging.
- `gui/include/gui/layer.h`
- `gui/include/gui/kml.h`
- `gui/include/gui/shapefile_basemap.h`

Keep separate from:

- Official ENC chart products.
- S-52/S-101 portrayal.
- Safety-critical route/nav/alarms.

Boundary RFC:

- `RFC: Marine Overlay Layer Manifest`

### 9. `helm-inspectd`

Purpose:

- Source-to-render inspection.
- Object query provenance.
- Pixel/object debug trace.
- Human and agent debuggability.

OpenCPN anchors:

- `s57chart` object query and description surfaces.
- `ChartDB::GetXMLDescription`.
- Plugin vector object info callbacks in `ocpn_plugin.h`.

Why:

- This is the answer to "AI coded it, can humans inspect it?"
- Every rendered object should be traceable to source product, compiler rule, primitive, cache artifact, and backend draw.

Boundary RFC:

- `RFC: Source-To-Render Inspection Trace`

### 10. `helm-controld`

Purpose:

- Future actuation safety boundary.
- Read-only pilot status first.
- Guarded route/heading output later.
- Approval UI, interlocks, audit log, and self-test.

OpenCPN anchors:

- `model/include/model/autopilot_output.h`
- `model/include/model/comm_n0183_output.h`
- `model/include/model/comm_out_queue.h`
- route activation and active waypoint state in `routeman.h`

Rules:

- Keep separated from display-only overlays.
- No implicit AI actuation.
- No hidden route-follow behavior.
- Every command needs explicit source, approval, preconditions, and audit.

Boundary RFC:

- `RFC: Control Safety Boundary`

## Extraction Order

### Extract now

1. `helm-packd`: C++ local package/catalog/layers/prefetch/bundle service.
2. `helm-cache`: C++ tile cache/proxy for online-fill and fallback tile replay.
3. `helm-envd`: C++ environmental bundle daemon after the field-texture contract is proven.

### Module first, daemon later

1. `helm-gateway`
2. `helm-navd`
3. `helm-chartd`
4. `helm-renderd`
5. `helm-layerd`
6. `helm-inspectd`

### Keep in core unless a hard boundary is proven

1. Active route progression.
2. Ownship/source-validity state.
3. AIS/CPA/TCPA authority.
4. Alarm state.
5. Official chart portrayal.
6. Safety-contour behavior.
7. Pilot command preconditions.

## RFC Queue

1. `RFC: Presentation Compiler Boundary`
2. `RFC: Chart Service Contract`
3. `RFC: Nav State And Alarm Stream`
4. `RFC: Local Package Service`
5. `RFC: Environmental Bundle Service`
6. `RFC: Nautical Render Command Stream`
7. `RFC: Rebuildable GPU Artifact Cache`
8. `RFC: Source-To-Render Inspection Trace`
9. `RFC: Marine Overlay Layer Manifest`
10. `RFC: Control Safety Boundary`

## Public Framing

Use this wording:

> Helm is a C++/OpenCPN-native boat-server architecture with thin clients and
> explicit service contracts. The public OpenCPN repository already exposes the
> useful seams: `model/` for navigation/comms/AIS/nav objects, chart/S-57/S-52
> classes for portrayal, plugin APIs for extensions, and a CLI/shim precedent
> for headless proof slices.

Avoid this wording:

- Web clients owning official chart portrayal.
- Symbol registries owning cartography.

## Non-Goals

- Do not replace OpenCPN's chart portrayal.
- Do not create a parallel charting standards body.
- Do not move S-52/S-101 decisions into render backends or web clients.
- Do not invent a new plugin bus where OpenCPN's plugin/data-flow contracts already fit.
- Do not make every boundary a separate process before the contract is stable.
- Do not hide optional or experimental features inside required navigation runtime.
