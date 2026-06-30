# Runtime services end state

Helm remains a small-service boat system, not a single monolith. The correction is that
**runtime boat daemons should be C++ by default** while Python stays in its strongest lanes:
offline tooling, reference bakers, experiments, and explicitly optional AI/community services.

The final acceptance gate for this policy is [HELMCXX-ACCEPTANCE.md](HELMCXX-ACCEPTANCE.md). That
contract defines what must be C++, what may remain non-C++, and what evidence is required before the
runtime can be called C++-only.

This is an architecture guardrail, not a rewrite order to stop all product work. The rule is:

- C++ owns required boat/runtime infrastructure.
- Browser JavaScript/WebGPU owns the cockpit UI and client rendering.
- Python may own offline import/bake tools, prototypes, and optional AI/community services.
- Any Python daemon that becomes required for normal chartplotter runtime needs a frozen
  HTTP/file contract and a C++ port plan.
- Microservices are still the desired shape. The target is small, testable C++ services, not one
  giant process.

## Maintainability bar for C++ services

The OpenCPN maintainer concern is valid: AI-generated code often becomes wide, clever, inconsistent,
and hard to review. Helm's answer is not "AI writes faster." The answer is that runtime C++ work must
be boring, bounded, and reviewable.

Every C++ runtime service port must follow this bar:

- **Contract first.** Freeze the HTTP/file contract and golden fixtures before the port. The C++
  service should be able to prove parity against the Python reference or existing client contract.
- **Small vertical slices.** Land one capability at a time: health, one tile path, range request,
  catalog, then metadata. No big-bang rewrite.
- **No line-for-line Python translation.** Use Python as the oracle, not the architecture. The C++
  design should have clear value types, narrow interfaces, RAII ownership, and explicit errors.
- **OpenCPN-native C++ style.** Target conservative modern C++ that fits the OpenCPN/toolchain
  baseline: CMake, C++17-shaped, standard library first, minimal dependencies, no novelty template
  machinery unless it removes real complexity.
- **One responsibility per module.** HTTP routing, cache/index storage, tile decoding, metadata
  normalization, and filesystem policy stay separate. A maintainer should be able to replace one
  module without reading the whole service.
- **Visible failure modes.** Return explicit `404`, `204`, stale/offline, out-of-coverage, or
  invalid-pack states. Never hide missing data behind optimistic fallbacks.
- **Deterministic tests before polish.** Unit tests for pure code, fixture tests for tile/package
  behavior, and HTTP smoke tests for service surfaces are required before UI work depends on the port.
- **Threading is opt-in and named.** Single-threaded/simple paths are preferred until profiling proves
  otherwise. When concurrency is needed, state ownership and locks must be obvious in the file names
  and tests.
- **Delete after parity, not before.** Keep the Python reference until the C++ service has fixture
  parity and the client has been switched. Then either retire it or mark it explicitly dev/tooling-only.
- **Reviewable diffs.** Agents should prefer smaller PRs with clear before/after evidence over clever
  abstractions. If a reviewer cannot understand the patch in one sitting, the slice is too large.

This is what we do differently from "AI slop": agents may accelerate inventory, fixtures, boilerplate,
and first drafts, but the accepted artifact must look like maintainable OpenCPN-adjacent C++ written
for human review.

## Current service inventory

| Current service or tool | Language | Runtime status | Decision |
|---|---:|---|---|
| `engine/` → `helm-server` | C++ | Required runtime | Keep as the safety/chart/nav core. |
| `pipeline/mbtiles_server.py` | Python | Runtime helper on `:8091` | Port first. It is now product infrastructure despite living under `pipeline/`. |
| `services/wx` | Python FastAPI | Runtime helper on `:8093` | Keep briefly as the Weather 2.0 reference baker/cache; port after the WX-19 renderer proves the bundle contract. |
| `helm-basemap-cache` | C++ | Optional runtime helper on `:8095` or proxy port | Preferred online-fill/remote-pack tile cache. |
| `services/basemap-fill` | Python stdlib | Reference/dev fallback on `:8095` | Keep until C++ parity is proven everywhere. |
| `services/basemap-proxy-cache` | Python stdlib | Transitional helper on `:8091` | Dev/reference only; replacement path is `helm-basemap-cache` with `HELM_BASEMAP_UPSTREAM`. |
| `backend/` | Python FastAPI | Optional AI/community prototype on `:8090` | Keep optional and non-safety. Do not let it become required chartplotter runtime without a separate architecture decision. |
| `pipeline/*.py` one-shot tools | Python | Offline tooling | Keep Python. These are import/bake tools, not daemons. |
| `web/serve.py`, `engine/mock-engine.js`, web tests | Python/JS | Dev/test only | Keep as support harnesses. |

## Target runtime shape

```text
web cockpit / future native client
        |
        | HTTP + WebSocket contracts
        v
helm-server        C++  required nav/chart/safety core
helm-packd         C++  local MBTiles/PMTiles/portable package serving, catalog, layers, prefetch
helm-basemap-cache C++  optional generic cache/proxy for satellite/online-fill and remote packs
helm-envd          C++  environmental bundle replay/materialization after WX-19 proves the contract
helm-ai/backend    Python optional AI/community/research service, never safety-critical
pipeline/*         Python CLI data import and bake tools
```

Names are provisional. What matters is the boundary:

- required boat daemons are C++/CMake/OpenCPN-native where practical;
- services speak narrow HTTP/file contracts so they can be ported without client rewrites;
- data products and caches remain bring-your-own and local-first;
- stale/offline/out-of-coverage states are explicit and testable;
- the browser remains a thin client, not a hidden dependency on Python internals.

## Port order

### 1. `helm-packd`: local pack service

Port the runtime contract from `pipeline/mbtiles_server.py` into a C++ service.
`mbtiles_server.py` remains the Python reference/oracle for manifest evolution;
the boat runtime should use `helm-packd`.

Required contract:

- serve local MBTiles raster tiles;
- serve PMTiles with HTTP Range support;
- expose `/catalog`;
- expose `/layers` maritime layer inventory;
- expose `/prefetch` route/bbox cache-warming manifests;
- expose `/bundle` region-bundle manifests;
- expose OFFLINE-15 environmental bundle visibility from `HELM_ENV_BUNDLE_MANIFESTS`;
- preserve sidecar/source/freshness/coverage/inspection metadata allow-listing;
- preserve the bring-your-own-pack and local-filesystem privacy model;
- never require internet to show installed packs.

Suggested C++ shape:

- `pack_index` discovers configured packs and reads allow-listed metadata.
- `mbtiles_store` owns SQLite tile lookup and TMS/XYZ conversion.
- `pmtiles_store` owns archive metadata and byte-range serving.
- `pack_manifest`/equivalent owns catalog, layer inventory, prefetch, and bundle JSON shaping.
- `pack_http` owns only request parsing, response headers, and error mapping.
- `pack_fixtures` compare C++ responses against the existing Python helper for small MBTiles/PMTiles
  fixtures.

This is the highest-priority port because it is already runtime infrastructure. The current Python
location under `pipeline/` misleads maintainers and agents into treating a boat daemon like a data
script.

### 2. C++ tile cache/proxy

Port or fold `services/basemap-fill` and `services/basemap-proxy-cache` into a generic C++ cache
service after `helm-packd`.

Required contract:

- cache-first tile serving;
- stale-while-revalidate for slow-changing imagery;
- serve-stale-on-outage;
- transparent/empty fail-safe on hard miss;
- tile budget and route-pin hooks for smaller devices.

This should not decide chart semantics. It is a cache service.

### 3. `helm-envd`: environmental bundle daemon

Do not rush this port before WX-19. `services/wx` just became the reference implementation for
`helm.env.bundle.v1`; the browser renderer still needs to consume that contract in anger.

Port after WX-19 proves:

- bundle manifest fields are sufficient;
- scalar and vector field tiles are the right payloads;
- all-zoom fallback/overzoom behavior works in the client;
- timeline/layer toggles never trigger provider fetches;
- S-100-family metadata is consumed as provenance/portrayal data, not shader/backend policy.

The future C++ service should replay prepared bundles and run scheduled/materialize jobs, but it
should not bake Windy-parity UI assumptions into the service.

### 4. Keep AI/community backend optional

`backend/` can remain Python as long as it is explicitly optional:

- places/reviews;
- recommender;
- dossier/research agents;
- give-back publishers;
- advisory probe narration.

If any part becomes required for chartplotter runtime, split that durable contract out first and
decide whether it belongs in C++.

## Vulkan/OpenCPN alignment

The Vulkan project is already applying the same decomposition discipline to OpenCPN rendering:

- `SEAM-*` defines ownership boundaries and command/model contracts;
- `ADAPT-*` separates the OpenCPN interactive adapter from Helm's headless adapter;
- `PIPE-*`, `FORMAT-*`, `PRESENT-*`, `CACHE-*`, and `BACKEND-*` split chart-source conversion,
  package format, presentation compilation, artifacts/cache, and draw-only backend contracts;
- runtime/renderer implementation is C++/CMake/OpenCPN-native;
- WebGPU is Helm's client consumer path, not a reason to move OpenCPN runtime semantics into the
  browser or Python.

Helm runtime-service cleanup should mirror that pattern: contract first, adapter boundary second,
small C++ vertical slice third. Do not create a language sidecar for behavior that maintainers will
expect to be OpenCPN-native runtime code.

## Non-goals

- Do not port all Python immediately.
- Do not collapse services into one process merely to reduce the language count.
- Do not move optional AI/community features into the safety core.
- Do not block WX-19 on a premature weather-service rewrite.
- Do not introduce new required Python daemons without an explicit deprecation or C++ port plan.

## HELMC++ acceptance

The runtime-service policy is considered accepted only after the HELMC++ gate passes:

- required boat/runtime daemons are C++;
- no required Python daemon remains;
- Python references have parity evidence before retirement;
- the cockpit passes a C++-only Playwright proof;
- packaging works on fresh machines without Docker;
- performance, reliability, soak, and maintainability evidence is recorded.
