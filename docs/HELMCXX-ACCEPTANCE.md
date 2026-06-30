# HELMC++ acceptance contract

Status: HELMC++-1 contract for the final C++ runtime acceptance gate.

This document defines what "Helm is C++" means for the project. It does not mean every
line of Helm becomes C++. It means every required boat-side chartplotter runtime daemon is
C++/CMake/OpenCPN-native, with Python limited to tooling, references, prototypes, and optional
non-safety services.

## Scope

The HELMC++ gate covers required runtime services that a boat must run to use Helm as a local
chartplotter. A required runtime service is any process needed for normal navigation, chart display,
local packs, environmental packs, cache serving, health reporting, or offline operation.

The gate does not cover client UI language, one-shot data preparation tools, test harnesses, or
optional advisory/community features unless those paths become required for normal runtime.

## Required C++ runtime shape

The accepted runtime shape is:

```text
web cockpit / native client
        |
        | HTTP + WebSocket contracts
        v
helm-server        C++  required nav/chart/safety core
helm-packd         C++  required local MBTiles/PMTiles/portable package service
helm-basemap-cache C++  runtime tile cache/proxy when online-fill or remote-pack fallback is enabled
helm-envd          C++  environmental bundle replay/materialization daemon
```

The service names are less important than the boundary. Required boat daemons must be:

- C++17-shaped and OpenCPN-adjacent in style;
- built through CMake or the repo's normal native build path;
- independently testable with deterministic fixtures;
- explicit about stale, offline, out-of-coverage, invalid-pack, and missing-data states;
- small enough for a human reviewer to understand in one sitting;
- free of hidden Python, Docker, venv, or developer-machine assumptions.

## Runtime inventory

| Surface | Accepted role | HELMC++ requirement |
|---|---|---|
| `engine/` / `helm-server` | Nav, AIS, route, chart tile, health, and one-origin boat server | Required C++ runtime. |
| `helm-packd` | Local MBTiles/PMTiles packs, catalog, layers, prefetch, bundle manifests | Required C++ runtime. |
| `helm-basemap-cache` | Cache/proxy for online fill and remote/local pack fallback | C++ when enabled as a runtime service; not required for chart-only installs. |
| `helm-envd` | Environmental model-run bundle replay/materialization | Required C++ runtime after WX-19 proves the contract. |
| `backend/` | AI/community/research/advisory backend | May remain Python only if optional and non-safety. |
| `pipeline/*.py` | Import, bake, conversion, sample generation, fixture tooling | May remain Python as offline tooling, not runtime. |
| `web/` | Browser cockpit, MapLibre, WebGPU, UI tests | Not intended to be C++; client surface remains web-native. |
| native Apple clients | WKWebView, SwiftUI, MapLibre Native, Metal | Not intended to be C++; thin client over the boat server. |
| dev/test harnesses | Playwright, smoke helpers, mock engines, local scripts | May use Python or JS when clearly dev/test only. |

## Non-C++ allowance

Non-C++ code is allowed when it is visibly outside required boat runtime:

- Browser JavaScript/WebGPU owns the cockpit UI and client rendering.
- Swift/SwiftUI/Metal may own native Apple client surfaces.
- Python may own offline import/bake tools and fixture generation.
- Python may own optional AI/community/research services if they cannot affect safety-critical runtime
  and Helm remains usable without them.
- Python/JS may own tests, Playwright harnesses, developer scripts, and references.

Any non-C++ daemon that becomes required for normal chartplotter runtime fails HELMC++ unless it has
a frozen contract, a C++ port plan, and a visible temporary status.

## Python oracle rule

Python reference paths should be used as oracles before they are retired. The C++ replacement must
match the frozen behavior with fixtures and contract tests before the Python path is deleted or
demoted to dev/reference-only.

Parity must cover:

- `/health` and service version reporting;
- `/catalog`, `/layers`, `/prefetch`, and `/bundle`;
- tile, PMTiles range, and environmental field responses;
- headers, ETags, cache semantics, and range behavior;
- source, freshness, coverage, inspection, and provenance metadata;
- stale, offline, out-of-coverage, invalid-pack, missing-pack, and no-network responses;
- expected `404`, `204`, and invalid-input errors;
- no hidden provider fetches in offline mode.

Outputs should be byte-identical where practical. Where byte identity is not the right bar, tests
must use normalized JSON, normalized headers, semantic image checks, or documented tolerances.

## End-to-end proof

The final C++ runtime proof must launch Helm on private ports with required C++ daemons only. It must
assert that no required Python daemon is running, contacted, or necessary.

The end-to-end harness must prove:

- cold start from a fresh runtime directory;
- restart after clean shutdown;
- reboot-style restart with only persisted runtime state;
- chart tiles and catalog are served;
- local MBTiles/PMTiles packs are visible;
- environmental bundles are visible after WX-20;
- the nav WebSocket produces usable state;
- bad manifests, missing packs, missing ENC, missing network, and out-of-coverage regions fail
  visibly instead of optimistically;
- health/status endpoints identify the C++ services and their versions.

No HELMC++ test may use the live `:8080` screen. Use private ports only.

## Cockpit proof

End-to-end runtime success is not enough. The user-visible cockpit must also prove the C++ runtime is
as good as or better than the previous/reference path.

Playwright acceptance must include:

- chart tiles visible;
- basemap/offline packs visible;
- environmental scene visible;
- time and layer controls working;
- AIS, route, ownship/nav, and health/status visible where fixtures provide them;
- no blank-map regressions during pan, zoom, and time scrub;
- no console errors in the tested workflow;
- no provider fetches during offline-mode tests;
- screenshots and artifacts retained for review.

## Better-than-reference evidence

C++ is not accepted because it is C++. It must keep correctness and earn operational advantages.

HELMC++ benchmarking must record:

- cold start time;
- time to first visible chart layer;
- time to first visible environmental layer;
- p50, p95, and p99 latency for tiles, pack manifests, range requests, and bundle requests;
- CPU and RSS during pan/zoom/time-scrub traffic;
- disk footprint and runtime dependency footprint;
- cache hit/miss behavior;
- behavior with multiple clients on constrained boat WiFi profiles;
- crash/restart behavior;
- no-network behavior;
- 12-24 hour soak with nav feed plus chart, basemap, weather, and offline-pack traffic.

The comparison baseline is the Python/reference path or the last accepted runtime path. If C++ does
not win a metric, the dossier must explain why the tradeoff is acceptable.

## Packaging proof

HELMC++ requires an installable runtime, not a developer-only build.

Packaging proof must show:

- no Docker requirement;
- no required Python daemon or venv requirement;
- fresh-machine macOS install path;
- fresh-machine Linux/Raspberry-Pi-style install path where supported;
- no dependency on `/tmp` build artifacts;
- deterministic runtime directories;
- service supervision story such as launchd, systemd, or an explicitly documented equivalent;
- codesign/notarization path where applicable;
- smoke proof that a user can install, start, inspect health, load local packs, and shut down cleanly.

## Maintainability bar

Every C++ runtime service must be boring, bounded, and reviewable:

- C++17-shaped, standard library first, minimal dependencies;
- CMake integration through the normal build;
- small modules with one responsibility;
- RAII ownership and explicit lifetime boundaries;
- explicit error types or error responses;
- deterministic unit, fixture, and HTTP smoke tests;
- useful service logs and health surfaces;
- sanitizer/debug builds where practical;
- no clever template machinery unless it removes real complexity;
- no line-for-line Python translation when a native C++ shape is clearer;
- reviewer-readable diffs and documentation.

## Go/no-go rule

HELMC++ passes only when all of the following are true:

- required boat/runtime daemons are C++;
- no required Python daemon remains;
- optional Python/backend/tooling surfaces are explicitly non-safety, dev-only, reference-only, or
  offline-only;
- Python oracle parity is recorded;
- no-Python runtime E2E passes;
- Playwright cockpit proof passes;
- performance/reliability/soak comparison is recorded;
- packaging/install proof passes without Docker;
- maintainability audit has no blocking findings;
- final evidence links exact PRs, branches, merged SHAs, logs, screenshots, and benchmark artifacts.

If any required runtime path still depends on Python, HELMC++ is not done.
