# Helm/OpenCPN Target Service Architecture

Status: Draft  
Date: 2026-07-01  
Scope: broad end-state service architecture based on current Helm code and renderer seams

## Purpose

This document starts with the broad target architecture, then uses the current code audit to propose what becomes decoupled, what becomes a service, what stays a module, and what remains inside the safety/chart/nav core.

The goal is not "microservices everywhere." The goal is a boat system made of small, inspectable, independently testable building blocks with explicit contracts.

Interface catalog: [INTERFACE-CATALOG.md](INTERFACE-CATALOG.md)

## Current Code Audit

Audited source: current Helm `main` branch.

### Current Runtime And Tooling Surfaces

| Surface | Current location | Size / shape | Current role | Architecture read |
|---|---|---:|---|---|
| `helm-server` | `engine/vendor/cli/helm_server.cpp` | 4480 LOC | One-origin C++ runtime: static UI, `/nav` WS, `/chart`, `/query`, `/catalog`, tides endpoints, pairing/auth, TLS/Bonjour, user-data serving, SignalK/AIS/alarms. | Too many responsibilities in one integration file. Keep as gateway/core initially, but extract modules/services. |
| `helm-packd` | `engine/vendor/cli/helm_packd.cpp` | 2178 LOC | C++ MBTiles/PMTiles/local package service: `/catalog`, `/layers`, `/prefetch`, `/bundle`, range serving. | Good existing microservice. Keep and harden. |
| `helm-basemap-cache` | `engine/vendor/cli/helm_basemap_cache.cpp` | 766 LOC | C++ online-fill/cache/proxy service: `/basemap/...`, `/stats`, `/health`, upstream proxy/cache. | Good existing microservice. Keep separate. |
| `helm-wx` | `services/wx/app.py` | 1736 LOC | Python FastAPI environmental bundle/value-tile reference service on `:8093`. | Strong reference implementation; target C++ `helm-envd` after renderer contract stabilizes. |
| Optional backend | `backend/main.py` plus backend modules | 215 LOC entrypoint | Python FastAPI places, saved pins, reviews, recommendations, dossier/research, give-back. | Keep optional and non-safety. Could split into community/AI services later. |
| Offline pack/server reference | `pipeline/mbtiles_server.py` | 945 LOC | Python oracle/reference for local pack service behavior. | Keep as reference/tooling; runtime path is `helm-packd`. |
| Split debug engines | `helm-engine`, `helm-tiles` | C++ debug targets | Nav-only WS and chart-only tile debugging. | Useful proof that seams can be split. |
| Web cockpit | `web/*.js`, `web/index.html` | Browser client | Thin client consuming HTTP/WS/tile/overlay contracts. | Stays client. Do not move source authority into browser. |
| Icon Forge | `pipeline/iconforge/` | Python pipeline | Generated symbol asset production, QA, provenance. | Offline/CI asset pipeline, not boat-runtime daemon. |
| Renderer probes | `engine/vulkan/*` | C++ probes | VSG/offscreen/resource/text-placement work. | Renderer backend/proof code; target runtime stays C++ boundary. |

### Current `helm-server` Responsibilities

`helm-server` currently owns or hosts:

- Static web UI from `HELM_WEB_ROOT`.
- WebSocket `/nav` stream.
- Command-plane handling over the nav socket.
- S-52 chart tile serving at `/chart/{z}/{x}/{y}.png`.
- Vulkan/legacy renderer selection and fallback.
- Object query at `/query`.
- Chart catalog at `/catalog`.
- Pairing/auth with `POST /pair`.
- TLS setup and Bonjour advertisement.
- Health reporting.
- Tides endpoints:
  - `/tides/summary`
  - `/tides/providers`
  - `/tides/currents`
  - `/tides/resolve`
  - `/tides/acquisition`
  - `/tides/acquisition/status`
  - `/tides/curve`
  - `/tides/stations`
- User-owned overlay static serving at `/user-data/...`.
- SignalK optional overlay startup.
- AIS decoder initialization.
- Alarm replay/ack loop.

That concentration is understandable for the first working boat server. It is not the desired end state.

## Target Architecture

Graphic view: [target-service-architecture.svg](target-service-architecture.svg)

```text
                         clients
       browser / iPad / native / test harnesses
                           |
                           v
                    helm-gateway
       one-origin TLS, pairing, auth, static UI, routing
                           |
   ---------------------------------------------------------------
   |             |             |             |          |          |
   v             v             v             v          v          v
helm-navd   helm-chartd   helm-packd   helm-envd   helm-layerd   helm-ai
nav/AIS/    chart query   local packs  weather/    user/extra    optional
routes/     S-52/S-101    catalog      metocean    overlays      research
alarms      presentation  prefetch     bundles     GeoJSON/etc   community
   |             |             |             |          |
   |             v             v             v          v
   |        helm-renderd   helm-cache   field/cache  layer index
   |        Vulkan/VSG/    GPU/tile     materialized inspection
   |        WebGPU model   artifacts    bundles
   |
   v
hardware/input adapters
NMEA/SignalK/AIS/GPS/depth/autopilot boundaries
```

Some boxes may remain in one process for a while. The target is contract separation first, process separation second.

## Service Catalog

### 1. `helm-gateway`

Purpose:

- One-origin TLS endpoint.
- Pairing and auth.
- Bonjour/mDNS advertisement.
- Static web client serving.
- Reverse proxy/routing to local daemons.
- Common health surface.

Current code:

- Mostly in `helm-server.cpp`: TLS, pairing, Bonjour, static serving, auth checks.

Split recommendation:

- Module first, service later.
- Keep it inside `helm-server` until at least two backend daemons are stable behind it.

Why:

- One-origin is a product feature. It hides service complexity from clients.
- Pairing/auth should not be copy-pasted across every daemon.

Boundary RFC:

- `RFC: Helm Gateway, Pairing, And Service Discovery`

### 2. `helm-navd`

Purpose:

- OpenCPN `model/` navigation core.
- Routes, active route, ETA, XTE, waypoint advance.
- Track recording.
- AIS decode and CPA/TCPA.
- Nav state stream.
- Alarm state and ack/replay.
- Connection adapters for NMEA/SignalK.

Current code:

- `helm-server.cpp` currently hosts `/nav`, command-plane, alarms, SignalK startup, AIS init.
- OpenCPN model reuse is documented in `docs/OPENCPN-REUSE.md`.

Split recommendation:

- Extract as C++ module first.
- Then daemonize if gateway/core pressure or tests justify it.

Keep in core:

- Safety-critical route/nav/AIS/alarm decisions.
- Staleness truth.
- Alarm ack/replay state.

Do not push to browser:

- OpenCPN-derived nav semantics.
- CPA/TCPA authority.
- Active route progression authority.

Boundary RFC:

- `RFC: Nav State And Alarm Stream`
- `RFC: Route/Track Command Contract`

### 3. `helm-chartd`

Purpose:

- Chart source loading.
- S-52/S-101 presentation/compiler execution.
- Chart tile generation.
- Object query.
- Chart catalog for official chart products.
- Presentation provenance.

Current code:

- `/chart`, `/query`, `/catalog`, legacy S-52 path, and Vulkan fallback live in `helm-server.cpp`.
- Split debug target `helm-tiles` already proves a chart-only server path.
- Renderer workstreams for presentation, format conversion, cache, backend, and debug/inspection already show the chart/render seams.

Split recommendation:

- Extract from `helm-server` as a C++ chart module, then separate daemon.
- This is the most important decoupling after `helm-packd`.

Keep authoritative here:

- Chart presentation semantics.
- Feature-to-symbol selection for official chart content.
- Display category, SCAMIN, safety contours, text/soundings.
- Source-to-render provenance.

Do not let other services own:

- Official chart portrayal.
- Cartographic z-order/display priority.

Boundary RFC:

- `RFC: Chart Service Contract`
- `RFC: Presentation Compiler Boundary`
- `RFC: Source-To-Render Query Contract`

### 4. `helm-renderd`

Purpose:

- Draw-only rendering backend service or module.
- Vulkan/VSG/offscreen backend.
- WebGPU artifact parity target.
- Render command stream consumption.

Current code:

- Renderer proof work exists under `engine/vulkan/*`, with related documentation for seam, backend, cache, and WebGPU consumer boundaries.
- `helm-server.cpp` currently can select Vulkan/legacy renderer for tile requests.

Split recommendation:

- Keep as module/library until the command stream and cache contract are stable.
- Do not make renderer a network daemon until there is a measurable reason.

Why:

- GPU lifecycle, platform windows, and offscreen contexts are operationally fussy.
- The seam matters more than process separation.

Boundary RFC:

- `RFC: Nautical Render Command Stream`
- `RFC: Draw-Only Backend Contract`

### 5. `helm-packd`

Purpose:

- Local package service.
- MBTiles/PMTiles serving.
- `/catalog`, `/layers`, `/prefetch`, `/bundle`.
- Region bundles and route-corridor cache advice.
- Public sidecar metadata allow-listing.

Current code:

- Already C++ in `engine/vendor/cli/helm_packd.cpp`.
- Python reference/oracle remains `pipeline/mbtiles_server.py`.

Split recommendation:

- Keep as separate daemon.
- Treat as the model for future service extraction.

Boundary RFC:

- `RFC: Local Package Service`
- `RFC: Portable Nautical Package And Index`
- `RFC: Route/BBox Prefetch Manifest`

### 6. `helm-basemap-cache`

Purpose:

- Online-fill tile cache.
- Remote pack proxy/cache.
- Stale-while-revalidate tile behavior.

Current code:

- Already C++ in `engine/vendor/cli/helm_basemap_cache.cpp`.
- Python references under `services/basemap-fill` and `services/basemap-proxy-cache`.

Split recommendation:

- Keep separate daemon.
- Fold Python helpers into dev/reference only.

Boundary RFC:

- `RFC: Basemap Cache/Proxy Contract`

### 7. `helm-envd`

Purpose:

- Environmental model-run bundles.
- Weather/metocean field tiles.
- Prepared replay of wind/current/waves/temp/rain/cloud layers.
- Materialization jobs.

Current code:

- Python reference service `services/wx/app.py`.
- Contract documented in `services/wx/README.md`.
- WebGPU consumer work already exists for environmental bundles and field-texture rendering.

Split recommendation:

- Keep Python reference until WebGPU environmental scene proves the contract.
- Then port required runtime subset to C++.

Do not own:

- Official S-100 product semantics.
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

Current code:

- `/user-data/...` static serving currently lives in `helm-server.cpp`.
- `helm-packd` already exposes `/layers` and bundle metadata.
- `backend/` and web code carry places/pins/community overlays.

Split recommendation:

- Define as target architecture now.
- Implement initially as `helm-packd` expansion or a module behind gateway.
- Separate daemon only once ownership diverges from package serving.

Boundary RFC:

- `RFC: Marine Overlay Layer Manifest`
- `RFC: Layer Inspection Metadata`

### 9. `helm-tided`

Purpose:

- Tide/current provider catalog.
- Station resolution.
- Tide/current curves.
- Acquisition/cache status.
- Observed/residual honesty when real observations exist.

Current code:

- Tide code is in `engine/vendor/cli/helm_tides.cpp` and endpoints are mounted inside `helm-server.cpp`.

Split recommendation:

- Extract as C++ module first.
- Daemonize later if station/catalog acquisition becomes independently scheduled or heavy.

Boundary RFC:

- `RFC: Tide/Current Service Contract`

### 10. `helm-ai`

Purpose:

- Places, reviews, owned pins.
- Dossier/research.
- Advisory recommendations.
- Give-back publishing.

Current code:

- Python FastAPI under `backend/`.

Split recommendation:

- Keep optional Python service.
- Never required for chartplotter safety runtime.
- If any endpoint becomes core product state, split that state into `helm-layerd` or `helm-navd` first.

Boundary RFC:

- `RFC: Advisory Backend Contract`
- `RFC: Community Places/Giveback Contract`

### 11. `helm-forged`

Purpose:

- Generated symbol asset pipeline.
- QA and hard-pile.
- Provenance and clean-IP records.
- Symbol library manifest generation.

Current code:

- `pipeline/iconforge/`.
- Follow-on implementation work for a seed symbol library manifest.

Split recommendation:

- Do not run as boat daemon.
- Keep as offline/CI tool.

Boundary RFC:

- `RFC: Generated Symbol Library Manifest`

### 12. `helm-controld`

Purpose:

- Future autopilot/control output.
- Hardware interlocks.
- Explicit skipper approvals.
- Audit trail.

Current code:

- Autopilot planning exists in docs/board memory, not as a required current runtime service.

Split recommendation:

- Separate safety-critical future workstream.
- Do not hide actuation inside nav display, route format, or AI backend.

Boundary RFC:

- `RFC: Autopilot Control Safety Boundary`

## What To Extract From `helm-server`

Priority order:

1. `chart_service` module  
   Extract `/chart`, `/query`, chart catalog, renderer choice, tile cache headers, and presentation provenance from the 4480-line integration file.

2. `nav_service` module  
   Extract nav stream, command handling, connection state, AIS, alarms, and staleness framing.

3. `tide_service` module  
   Extract tide/current endpoint routing and acquisition loop wiring.

4. `gateway` module  
   Extract TLS, pairing, auth, Bonjour, static UI, and routing.

5. `user_data/layer_service` module  
   Extract `/user-data/...` static allow-listing and layer metadata.

After those modules exist and have fixture tests, decide which become separate daemons.

## Split Now / Later / Keep

| Candidate | Decision | Why |
|---|---|---|
| `helm-packd` | Split now; already split. | Clear local package contract and no chart semantics. |
| `helm-basemap-cache` | Split now; already split. | Cache/proxy is naturally independent. |
| Chart rendering/query | Module now, daemon soon. | Too much in `helm-server`; Vulkan seam already exists. |
| Nav/AIS/routes/alarms | Module now, daemon later. | Safety-critical; needs careful state/ordering. |
| Tides/currents | Module now, daemon later. | Current endpoints already distinct; acquisition may deserve own scheduler. |
| Environmental bundles | Python reference now, C++ daemon later. | Contract still maturing through WebGPU scene. |
| Layer/user-data index | Module or `helm-packd` extension now, daemon later. | Related to packs but may become separate overlay service. |
| AI/community backend | Keep optional Python. | Not safety-critical and benefits from Python. |
| Icon Forge | Keep offline/CI. | Asset pipeline, not runtime. |
| Gateway/auth/discovery | Module now, maybe separate later. | One-origin simplifies clients; avoid premature proxy complexity. |
| Autopilot/control | Separate future service. | Actuation needs its own safety boundary. |

## RFC Boundaries After Target Architecture

Define RFCs only after the service target is clear:

1. `RFC: Gateway, Pairing, Discovery, And Auth`
2. `RFC: Nav State, Commands, And Alarm Reliability`
3. `RFC: Chart Service And Presentation Compiler Boundary`
4. `RFC: Render Command Stream And Draw Backend`
5. `RFC: Local Package Service`
6. `RFC: Environmental Bundle Service`
7. `RFC: Marine Overlay Layer Manifest`
8. `RFC: Source-To-Render Inspection Trace`
9. `RFC: Generated Symbol Library Manifest`
10. `RFC: Autopilot Control Safety Boundary`

## OpenCPN Code Audit Plan

The broad architecture is now defined enough to guide audits. Each extraction needs a targeted OpenCPN/Helm audit:

### Audit A: Chart Service

Read:

- `engine/vendor/cli/helm_server.cpp` chart/query/catalog sections.
- `engine/vendor/cli/helm_tiles.cpp`.
- OpenCPN chart render path in the vendored build tree after `engine/bootstrap.sh`.
- Renderer boundary docs and generated contracts.

Output:

- list of chart globals;
- main-thread requirements;
- cache keys;
- query/pixel provenance;
- presentation compiler ownership;
- extraction patch plan.

### Audit B: Nav Service

Read:

- `helm_server.cpp` nav socket, command handling, alarms.
- OpenCPN `model/` route, track, AIS, comms paths in the bootstrapped OpenCPN tree.
- `docs/OPENCPN-REUSE.md`.
- `docs/STREAMING-API.md`.

Output:

- nav state schema;
- command schema;
- alarm reliability semantics;
- connection adapter model;
- service/module extraction plan.

### Audit C: Tide Service

Read:

- `engine/vendor/cli/helm_tides.cpp`.
- `helm_server.cpp` tide endpoints.
- tide-related docs and tests.

Output:

- endpoint contract;
- station/provider cache model;
- acquisition scheduler boundary;
- observed/residual status plan.

### Audit D: Layer/Package Service

Read:

- `helm_packd.cpp`.
- `pipeline/mbtiles_server.py`.
- `pipeline/layer_inventory.py`.
- `pipeline/region_bundle.py`.
- `/user-data` serving in `helm_server.cpp`.

Output:

- whether `helm-layerd` is separate or part of `helm-packd`;
- layer manifest schema;
- inspection metadata contract;
- privacy/allow-list rules.

### Audit E: Environmental Service

Read:

- `services/wx/app.py`.
- `services/wx/README.md`.
- `web/wx-*` and `web/wx-scene-webgpu.js`.

Output:

- stable bundle contract;
- C++ port plan;
- replay/materialize split;
- WebGPU field texture requirements.

## First Implementation Slice

Do not begin with process orchestration.

Begin by extracting modules from `helm-server.cpp`:

```text
engine/vendor/cli/helm_gateway.*
engine/vendor/cli/helm_chart_service.*
engine/vendor/cli/helm_nav_service.*
engine/vendor/cli/helm_tide_service.*
engine/vendor/cli/helm_user_data_service.*
```

Acceptance for the first slice:

- No endpoint behavior changes.
- `engine/test-engine.sh` still passes.
- `/health`, `/nav`, `/chart`, `/query`, `/catalog`, `/tides/*`, `/pair`, and static UI still work.
- The extracted service modules expose interfaces that could later be hosted behind `helm-gateway`.

This keeps the end-state service architecture real without destabilizing the current boat runtime.
