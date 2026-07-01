# Runtime Services

Helm remains a small-service boat system, not a single monolith. The current
repo is a working hybrid: core nav/chart runtime is already C++, while Python
still exists for weather/reference paths, data tooling, fixtures, and optional
AI/community experiments. The target maintained product is smaller:
**required boat-side runtime daemons are C++/CMake/OpenCPN-native by default**,
and the cockpit remains browser JavaScript/WebGPU.

The final acceptance gate for this policy is [HELMCXX-ACCEPTANCE.md](HELMCXX-ACCEPTANCE.md). That
contract defines what must be C++, what may remain outside required runtime, and what evidence is
required before the runtime can be called C++-only.

This is an architecture guardrail, not a rewrite order to stop all product work
or break working helpers before parity exists. The rule is:

- C++ owns required boat/runtime infrastructure.
- Browser JavaScript/WebGPU owns the cockpit UI and client rendering.
- Python may remain for AI/lab/dev tooling, fixture generation, transitional
  reference/oracle implementations, and explicitly optional non-safety companion services.
- Data-preparation tools and test harnesses stay outside required boat runtime unless
  they become part of a shipped boat appliance path.
- Any non-C++ daemon that becomes required for normal chartplotter runtime needs a frozen contract
  and a C++ ownership decision before it can be accepted.
- Service boundaries are still the desired shape. The target is small, testable C++ services, not
  one giant process.

## Current Versus Target

| Surface | Current status | Target status |
|---|---|---|
| `helm-server` nav/chart core | C++ one-origin boat server | C++ required runtime |
| `helm-packd` local packs | C++ port merged; Python oracle may remain for tests | C++ required runtime |
| tile cache/proxy | C++ cache/proxy merged for runtime use | C++ when enabled |
| weather/environment bundles | Python `services/wx` remains current/reference while WebGPU scene and contract stabilize | C++ `helm-envd`/`helm-wxd` required runtime after parity |
| `backend/` FastAPI/AI/community | Optional prototype/companion path | Optional non-safety only, or ported if ever promoted to required runtime |
| `pipeline/` and generators | Python and shell tooling | Allowed outside required runtime; selected appliance paths may be ported |
| `web/` cockpit | Browser JavaScript/MapLibre/WebGPU | Browser JavaScript/WebGPU product UI |

## Maintainability Bar For C++ Services

The OpenCPN maintainer concern is valid: generated code often becomes wide, clever, inconsistent,
and hard to review. Helm's answer is not "write faster." The answer is that runtime C++ work must
be boring, bounded, and reviewable.

Every C++ runtime service port must follow this bar:

- **Contract first.** Freeze the HTTP/file contract and golden fixtures before the port.
- **Small vertical slices.** Land one capability at a time: health, one tile path, range request,
  catalog, then metadata.
- **Native C++ shape.** Use clear value types, narrow interfaces, RAII ownership, and explicit
  errors.
- **OpenCPN-native C++ style.** Target conservative modern C++ that fits the OpenCPN/toolchain
  baseline: CMake, C++17-shaped, standard library first, minimal dependencies.
- **One responsibility per module.** HTTP routing, cache/index storage, tile decoding, metadata
  normalization, and filesystem policy stay separate.
- **Visible failure modes.** Return explicit `404`, `204`, stale/offline, out-of-coverage, or
  invalid-pack states. Never hide missing data behind optimistic fallbacks.
- **Deterministic tests before polish.** Unit tests for pure code, fixture tests for tile/package
  behavior, and HTTP smoke tests for service surfaces are required before UI work depends on the
  port.
- **Threading is opt-in and named.** Single-threaded/simple paths are preferred until profiling
  proves otherwise.
- **Retire references after parity, not before.** Keep reference behavior until the C++ service has
  fixture parity and the client has been switched.
- **Reviewable diffs.** Prefer smaller PRs with clear before/after evidence over broad abstractions.

## Target Runtime Shape

```text
web cockpit / future native client
        |
        | HTTP + WebSocket contracts
        v
helm-server        C++  required nav/chart/safety core
helm-packd         C++  local MBTiles/PMTiles/portable package serving, catalog, layers, prefetch
helm-basemap-cache C++  optional generic cache/proxy for satellite/online-fill and remote packs
helm-envd          C++  environmental bundle replay/materialization
```

Names are provisional. What matters is the boundary:

- required boat daemons are C++/CMake/OpenCPN-native where practical;
- services speak narrow HTTP/file contracts so they can be ported without client rewrites;
- data products and caches remain bring-your-own and local-first;
- stale/offline/out-of-coverage states are explicit and testable;
- the browser remains a thin client, not a hidden owner of runtime semantics.

## Target Service Inventory

| Target service | Accepted role | C++ runtime decision |
|---|---|---|
| `engine/` / `helm-server` | Nav, AIS, route, chart tile, health, and one-origin boat server | Required C++ runtime. |
| `helm-packd` | Local MBTiles/PMTiles packs, catalog, layers, prefetch, bundle manifests | Required C++ runtime. |
| `helm-basemap-cache` | Cache/proxy for online fill and remote/local pack fallback | C++ when enabled as a runtime service. |
| `helm-envd` | Environmental model-run bundle replay/materialization | Required C++ runtime after the field-texture contract is proven. |
| data-preparation tools | Import, bake, conversion, sample generation, fixture tooling | Outside required runtime. |
| `web/` | Browser cockpit, MapLibre, WebGPU, UI tests | Client surface, not boat runtime daemon. |
| native Apple clients | WKWebView, SwiftUI, MapLibre Native, Metal | Thin client over the boat server. |
| dev/test harnesses | Playwright, smoke helpers, mock engines, local scripts | Outside required runtime. |

## Port Order

### 1. `helm-packd`: local pack service

Required contract:

- serve local MBTiles raster tiles;
- serve PMTiles with HTTP Range support;
- expose `/catalog`;
- expose `/layers` maritime layer inventory;
- expose `/prefetch` route/bbox cache-warming manifests;
- expose `/bundle` region-bundle manifests;
- preserve sidecar/source/freshness/coverage/inspection metadata allow-listing;
- preserve the bring-your-own-pack and local-filesystem privacy model;
- never require internet to show installed packs.

Suggested C++ shape:

- `pack_index` discovers configured packs and reads allow-listed metadata.
- `mbtiles_store` owns SQLite tile lookup and TMS/XYZ conversion.
- `pmtiles_store` owns archive metadata and byte-range serving.
- `pack_manifest` owns catalog, layer inventory, prefetch, and bundle JSON shaping.
- `pack_http` owns request parsing, response headers, and error mapping.
- `pack_fixtures` compare C++ responses against frozen fixtures.

### 2. C++ tile cache/proxy

Required contract:

- cache-first tile serving;
- stale-while-revalidate for slow-changing imagery;
- serve-stale-on-outage;
- transparent/empty fail-safe on hard miss;
- tile budget and route-pin hooks for smaller devices.

This should not decide chart semantics. It is a cache service.

### 3. `helm-envd`: environmental bundle daemon

Required contract:

- replay prepared environmental bundles;
- serve scalar and vector field tiles;
- expose all-zoom fallback/overzoom behavior;
- preserve valid-time and source metadata;
- avoid provider fetches during offline-mode tests;
- consume S-100-family metadata as provenance/portrayal data, not shader/backend policy.

The C++ service should replay prepared bundles and run scheduled/materialize jobs, but it should
not bake UI assumptions into the service.

## OpenCPN Alignment

The OpenCPN public repo already has useful C++ seams:

- `model/` for navigation, comms, AIS, nav objects, persistence, notifications, local APIs, and
  plugin management substrate;
- `gui/include/gui` for chart DB, chart canvas, S-57 chart classes, quilting, query surfaces, and
  OpenGL canvas;
- `s57` plus `data/s57data` for S-57/S-52 chart and presentation assets;
- `include/ocpn_plugin.h` for extension capabilities, overlay callbacks, vector object access, and
  plugin data-flow discipline;
- `cli` for bounded command/headless proof slices.

Helm runtime-service cleanup should mirror that pattern: contract first, adapter boundary second,
small C++ vertical slice third.

## Non-Goals

- Do not collapse services into one process merely to reduce the process count.
- Do not move optional advisory/community features into the safety core.
- Do not block client/environment rendering proof on premature service rewrites.
- Do not introduce new required non-C++ daemons.

## HELMC++ Acceptance

The runtime-service policy is accepted only after the HELMC++ gate passes:

- required boat/runtime daemons are C++;
- no required non-C++ daemon remains;
- reference behavior has parity evidence before retirement;
- the cockpit passes a C++-only Playwright proof;
- packaging works on fresh machines without Docker;
- performance, reliability, soak, and maintainability evidence is recorded.
