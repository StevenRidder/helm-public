# Architecture

Helm is a local-first marine chartplotter system, not a single monolithic app.
The public alpha has four intentional parts:

```text
                 browser / tablet / cockpit displays
                               |
                               v
                    web/ MapLibre cockpit UI
                               |
                  HTTP + WebSocket, one local origin
                               |
                               v
        engine/ helm-server, a headless OpenCPN-derived boat server
             |                 |                    |
             v                 v                    v
      local charts       boat data feeds       C++ runtime services
      ENC / MBTiles      NMEA / SignalK        weather / basemap fill
             |
             v
      local data generation and import tools
```

This split can look like "several apps" at first glance. It is really a
boat-server architecture: the C++ process owns navigation-critical computation
and chart rendering, while the web client is a thin, fast cockpit surface that
can run on the same machine or another display on the boat LAN. The current
alpha is still hybrid: Python helper services and pipelines remain where they
work, especially weather/reference tooling and optional AI/community features.
The end state for the maintained product is **small C++ runtime services around
OpenCPN-native contracts**, plus the browser/WebGPU cockpit.
See [RUNTIME-SERVICES.md](RUNTIME-SERVICES.md) and the final
[HELMC++ acceptance contract](HELMCXX-ACCEPTANCE.md).

## Current Runnable Shape

The normal public-alpha path is the one-origin `helm-server`:

- serves the browser UI from `web/`;
- streams navigation state over `/nav`;
- renders chart tiles at `/chart/{z}/{x}/{y}.png`;
- exposes chart metadata at `/catalog`;
- exposes health at `/health`;
- reads user-owned chart and depth data from local runtime paths.

The server is built from `engine/vendor/cli/helm_server.cpp` by
`engine/bootstrap.sh`. The browser is the reference client today. Native desktop
or mobile packaging is a future distribution layer, not the thing you need in
order to test the alpha.

Weather/environment services and some local data tooling are still transitional
Python paths. They should be treated as current/reference implementations or
offline tools until each contract has C++ parity. Python is allowed for optional
non-safety AI/community features; it is not the target dependency for required
boat-side chart/nav/weather runtime.

## Why These Parts Exist

### `engine/`

The engine is the boat-side safety core. It reuses OpenCPN `model/` navigation
logic and the S-52/S-57 renderer headlessly, behind an HTTP/WebSocket boundary.
That keeps OpenCPN-derived code in a contained server process and lets the
client stay thin.

### `web/`

The browser cockpit is the main user interface. It uses MapLibre for the
interactive map and composes Helm's layers: chart tiles, satellite/basemap
underlays, weather, AIS, routes, tracks, alarms, depth overlays, and instrument
state.

### Runtime Services

Runtime services are moving to C++/CMake/OpenCPN-native when they are required
for normal boat-side operation. Examples include local package serving, tile
cache/proxy behavior, and environmental bundle replay. A boundary may start in
Python or inside the current boat server while the contract is being proven, but
the maintained required-runtime target is C++ with narrow, testable HTTP/file
contracts.

### Data Preparation

Data preparation covers chart/depth extraction, demo data generation, and
weather-layer preparation. Real chart packs, private imagery, MBTiles, and
runtime caches stay outside Git.

## Data Boundary

Helm does not ship chart packs. Users bring their own local data, like they do
with OpenCPN:

- `HELM_ENC` can point at an OpenCPN-compatible ENC `.000` cell for S-52 tiles;
- `HELM_USER_DATA_ROOT`, `HELM_CONFIG/data`, or `~/.helm/data` can hold
  generated depth overlays such as `depare.geojson`, `depcnt.geojson`, and
  `soundg.geojson`;
- user-owned MBTiles or raster packs can be served by a local basemap service;
- online fill is optional, off by default, and not a replacement for local
  chart data.

The public repo may include small demo fixtures. It should not include private
chart libraries, private satellite packs, downloaded chart blobs, or generated
gigabytes of data.

## Collaboration Boundaries

The repo is organized so contributors can work in one area without needing to
understand all of Helm:

| Area | Good contribution examples |
|---|---|
| `web/` | UI polish, MapLibre layers, AIS/route/track panels, accessibility, tests |
| `engine/` | build fixes, protocol behavior, chart rendering, NMEA/SignalK ingest, smoke tests |
| runtime services | C++ package/cache/environment daemons, clear failure modes |
| data preparation | import tools, data transforms, reproducible sample generation |
| `docs/` | setup guides, diagrams, examples, platform notes |
| `.github/` | issue templates, CI, contribution workflow |

The most useful pull requests are small, reproducible, and tied to one boundary.
For example: "make the web client surface stale AIS state", "document Linux
build blockers", or "add a smoke test for `/catalog`" are easier to review than
a broad rewrite across engine, web, and services.

## Safety Boundary

Helm is pre-alpha supplemental navigation software. The architecture is built
to preserve data provenance and stale/missing-data honesty, but it is not
certified, not type-approved ECDIS, and not a primary navigation system. See
[SAFETY.md](../SAFETY.md).

Safety-sensitive changes should include a test or a clear manual verification
recipe, especially for heading, position, depth, AIS, alarms, route progress,
and chart rendering.

## Future Direction

The long-term product direction is still a modern chartplotter that fuses
charts, satellite, weather, AIS, instruments, and routing into one offline-first
screen. The near-term open collaboration goal is more basic and more important:

- make the alpha easy to build and run;
- make the repo understandable to new contributors;
- keep the bring-your-own chart model clean;
- improve platform coverage;
- harden the engine/client contract with tests;
- package the system without hiding the safety caveats.

## Proposed Service Boundaries

The public alpha is intentionally not presented as a finished microservice
system. The proposed end state is documented separately so contributors can
review the boundaries without confusing them for current build instructions:

- [proposals/TARGET-SERVICE-ARCHITECTURE.md](proposals/TARGET-SERVICE-ARCHITECTURE.md)
  maps the public OpenCPN source layout into target C++ services and extraction order.
- [proposals/INTERFACE-CATALOG.md](proposals/INTERFACE-CATALOG.md) defines the
  first-pass contracts between those services.
- [proposals/STANDARDS-LAYER-MAP.md](proposals/STANDARDS-LAYER-MAP.md) records
  which existing standards own each layer and where Helm-specific proposals are
  appropriate.
