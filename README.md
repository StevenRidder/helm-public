# Helm

**One screen for everything on the water.**

Helm is a source-available, pre-alpha marine chartplotter experiment. Today it
is **not** a packaged macOS app, Windows installer, Linux package, or mobile
app. The current runnable shape is a local C++ `helm-server` that reuses
[OpenCPN](https://opencpn.org)'s `model/` navigation core and S-52/S-57 renderer
headlessly, serves a browser client from `web/`, and exposes `/nav`, `/chart`,
`/catalog`, and `/health` on one localhost port.

The long-term direction is a modern, cross-platform chartplotter that carries
OpenCPN's feature set forward and fuses the data a sailor currently juggles
across four apps into a single situational picture:

> charts + satellite imagery + Windy-class weather layers + PredictWind routing +
> AIS + instruments — composited on one chart, offline-first.

Today a cruiser bounces between Windy (for some weather layers), PredictWind (for
routing), a separate weather app (for the rest), and a charting/nav app (for the
chart itself). Nothing on the market shows it all on one screen. **That is the product.**

## How it fits together

Helm is **one system, not several loose apps**: a headless boat server with thin
clients around it. If the directory layout looks like "a few projects in different
languages," this is the hierarchy that ties them together.

| Part | Language | Role |
|---|---|---|
| **`engine/` → `helm-server`** | C++ | The safety core. A headless OpenCPN-derived navigation + S-52 chart engine that serves `/nav`, `/chart`, `/catalog`, and `/health` on one local origin. |
| **`web/`** | Browser / MapLibre | The cockpit UI — a thin client over the server. Runs on the same machine or another display on the boat LAN. |
| **runtime services** | C++ | Local package serving, cache/proxy behavior, and environmental bundle replay as they become required boat-side services. |
| **data preparation** | native tools / scripts | Tools to generate and import *your own* local chart, depth, and weather data. No chart packs are bundled. |

```text
   web/ cockpit  ──HTTP+WebSocket──▶  engine/ helm-server (C++)  ──▶  local charts + boat data
  (browser/tablet)   one local origin      OpenCPN nav core            ENC/MBTiles · NMEA/SignalK
                                                  ▲
                                   C++ runtime services · local data tools
```

The C++ process owns navigation-critical computation and chart rendering; everything
else orbits it behind the HTTP/WebSocket boundary. That split is what lets Helm grow
toward browser, mobile, and native clients later. Full detail in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Pre-alpha source release. The documented build/run path is **macOS from
source**: build `helm-server`, run it on a private local port, then open
`http://127.0.0.1:9001/` in a browser. There is no native SwiftUI/iOS client yet.

Linux and Windows are not packaged or documented yet. The browser client is
portable, but the headless OpenCPN engine build currently assumes the macOS
toolchain, Homebrew paths, wxWidgets 3.2, and Helm's bootstrap script.

The current code includes a reusable data pipeline + MapLibre browser client,
plus a one-origin [Helm Engine](engine/) that drives OpenCPN's real `Routeman`
headlessly and serves S-52 ENC chart tiles over HTTP. The web app can show
OpenCPN-rendered charts under OpenCPN-computed navigation state when you provide
chart data and NMEA/SignalK input. See [docs/OPENCPN-REUSE.md](docs/OPENCPN-REUSE.md).

## What You Can Run Today

| Path | Status |
|---|---|
| macOS source build | Documented path. Build `helm-server`, run it locally, open the browser UI. |
| Browser UI | Reference client. Served by `helm-server`; can also be served as a static demo with `web/serve.py`. |
| Charts | Helm does not include chart packs. Real S-52 tiles require user-provided OpenCPN-compatible charts such as NOAA ENC `.000` cells, pointed to with `HELM_ENC`. |
| Local basemaps | User-owned MBTiles/raster packs stay local and are served at runtime; do not commit chart packs or private imagery to Git. |
| Boat data | Live movement requires NMEA 0183, SignalK, or another configured input. The server does not silently invent live boat data. |
| Linux / Windows | Not a one-command supported path yet. Expect porting/dependency work. |
| Native desktop/mobile app | Not shipped yet. |

## The three differentiators

1. **One fused screen.** Charts, satellite, the full weather stack, your route, AIS
   targets and instruments, composited as toggleable layers on a single chart —
   instead of four apps and a guess.
2. **On-demand charts + depth-on-satellite.** Lasso an area, fetch charts, cache them
   offline — the live version of [ChartLocker](https://chartlocker.brucebalan.com) —
   and overlay ENC depth soundings *on top of* satellite imagery, so you see the reef
   **and** the numbers. (Inspired by the S-57 depth rendering in
   [wholybee/chartplotter](https://github.com/wholybee/chartplotter).)
3. **Own weather + open routing.** Windy's whole layer catalog (wind, gust, swell,
   wave, rain, current, pressure, cloud) rendered from public GRIB as *our own*
   composited overlay — offline, no ToS strings — plus PredictWind route import and
   our own isochrone weather router.

## Start here

| Doc | What it is |
|-----|------------|
| [SAFETY.md](SAFETY.md) | Alpha navigation disclaimer - supplemental aid only, not primary navigation |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How humans can contribute: scope, PR rules, safety/data boundaries |
| [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) | What works today, what is alpha, and where help is wanted |
| [docs/REPO-MAP.md](docs/REPO-MAP.md) | Quick orientation to the directories and contribution areas |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Contributor workflow, ports, tests, local data rules |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Headless C++ boat server + browser/mobile client boundary |
| [docs/RUNTIME-SERVICES.md](docs/RUNTIME-SERVICES.md) | End-state C++ runtime services and HELMC++ acceptance guardrails |
| [docs/proposals/TARGET-SERVICE-ARCHITECTURE.md](docs/proposals/TARGET-SERVICE-ARCHITECTURE.md) | OpenCPN-source audit, proposed C++ service end state, and extraction order |
| [docs/proposals/INTERFACE-CATALOG.md](docs/proposals/INTERFACE-CATALOG.md) | Draft interface contracts between proposed services |
| [docs/proposals/STANDARDS-LAYER-MAP.md](docs/proposals/STANDARDS-LAYER-MAP.md) | Existing standards by layer, and where Helm-specific RFCs/proposals fit |
| [docs/STREAMING-API.md](docs/STREAMING-API.md) | Boat server ↔ iOS thin clients — the world-class streaming/API contract |
| [docs/VULKAN-HELM-WEBGPU-PROOF.md](docs/VULKAN-HELM-WEBGPU-PROOF.md) | Helm's WebGPU-first consumer path for the shared OpenCPN renderer proof |
| [docs/CHART-PIPELINE.md](docs/CHART-PIPELINE.md) | On-demand tiler + depth-on-satellite |
| [docs/WEATHER.md](docs/WEATHER.md) | Own-GRIB overlay + Windy + PredictWind |
| [docs/WEATHER-DATA.md](docs/WEATHER-DATA.md) | Data sources — Windy's models are public; we use the same |
| [docs/OPENCPN-REUSE.md](docs/OPENCPN-REUSE.md) | Read OpenCPN file-by-file: reuse its nav core; the new plan |
| [docs/CHART-QUILTING.md](docs/CHART-QUILTING.md) | Multi-cell S-52 tiler → quilting; where OpenCPN's quilt code falls short vs ours |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | **Build & run on macOS** — bootstrap the engine, run the stack, feature-by-feature verification checklist |
| [docs/integrations/noforeignland.md](docs/integrations/noforeignland.md) | NoForeignLand + community-places overlay scope |
| [TRACER-BULLET.md](TRACER-BULLET.md) | **The first code** — run the pipeline + prototype |
| [pipeline/](pipeline/) | Reusable engine: tiler · depth · wind |
| [web/](web/) | MapLibre prototype + shared `style.json` |
| [docs/LEGAL.md](docs/LEGAL.md) | Source licensing tiers — **read before touching a tile** |
| [docs/decisions/](docs/decisions/) | Architecture decision records (ADRs) |

## Reviewer Path In 10 Minutes

For a skeptical first pass, use the public docs in this order:

1. Read [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) and
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to see what Helm is, what works
   today, and what is still pre-alpha.
2. Read [SAFETY.md](SAFETY.md) before treating any screenshot or demo as a
   navigation claim.
3. Build and run from [docs/RUNBOOK.md](docs/RUNBOOK.md). Use a private local
   port such as `9001`, provide your own chart data, and verify `/health`,
   `/catalog`, and a sample `/chart/{z}/{x}/{y}.png` tile.
4. Run `engine/test-engine.sh` after a build to exercise the one-origin server,
   chart route, navigation behavior, containment checks, and smoke coverage.
5. For the renderer proof context, read
   [docs/VULKAN-HELM-WEBGPU-PROOF.md](docs/VULKAN-HELM-WEBGPU-PROOF.md) and the
   OpenCPN proof branch it links to. Helm is the WebGPU-first consumer path;
   VSG/Vulkan is the OpenCPN/native proof backend.

Internal business strategy, product requirements, feature audits, roadmap/epic plans,
release-post drafts, UI mockups, raw research artifacts, live-machine notes, and local
operator configuration are intentionally kept out of the public repository.

## Navigation Safety

Helm is pre-alpha marine navigation software. It is not certified, not
type-approved ECDIS, not carriage-compliant, and not a substitute for official
charts, notices, instruments, watchkeeping, or seamanship. Treat it as a
supplemental evaluation tool only.

Read [SAFETY.md](SAFETY.md) before running Helm, sharing screenshots, posting a
demo, or inviting testers.

## Requirements

There is intentionally no root runtime dependency file: Helm is a C++ boat
server plus browser client and local data tools, so dependencies are scoped to
the part you are running.

| Area | Requirements |
|---|---|
| Main macOS runtime | Xcode CLT, Homebrew, `wxwidgets@3.2`, `gpatch`, `cmake`, `gdal`, `node` |
| C++ engine | Built by `engine/bootstrap.sh`; see [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Web tests | `web/test/package.json` |
| Runtime chart data | NOAA ENC `.000` cells, pointed to with `HELM_ENC` |
| Runtime basemap data | User-owned MBTiles/raster packs served locally, outside Git |
| Runtime boat data | NMEA 0183, SignalK, or configured connection input |

## Contributing

The public alpha is being shaped into a contributor-friendly project. If you
want to help, start with [CONTRIBUTING.md](CONTRIBUTING.md),
[docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md), and
[docs/REPO-MAP.md](docs/REPO-MAP.md).

Useful first contributions include setup reports, build fixes, docs, web-client
tests, platform notes, chart-data onboarding examples, and small UI improvements.
Please keep private chart packs, private basemaps, credentials, generated
caches, and vessel-sensitive data out of issues and pull requests.

## Quick Start (macOS)

The current public-alpha path is the one-origin `helm-server`: it serves the
browser UI, `/nav`, `/chart`, `/catalog`, and `/health` on one private port.

```bash
brew install wxwidgets@3.2 gpatch cmake gdal node
engine/bootstrap.sh
scripts/install-sample-enc.sh
scripts/start-helm.sh --port 9001 --fill

open http://127.0.0.1:9001/
```

Use [docs/RUNBOOK.md](docs/RUNBOOK.md) for NOAA ENC setup, NMEA/SignalK input,
and end-to-end verification. In the shared development environment, do not use
`:8080`; use a private development port instead.

## Bring Your Own Charts

Helm does not ship Steve's private charts, private satellite packs, `~/.helm`
runtime data, or generated gigabytes of chart/cache output. The public repo is
code plus safe sample/public data.

For real charting, provide your own local chart data at runtime:

- point `HELM_ENC` at an OpenCPN-compatible ENC `.000` file for S-52 rendering;
- generate or copy user-owned depth overlay GeoJSON into `~/.helm/data`, or set
  `HELM_USER_DATA_ROOT` to another local data directory;
- serve your own MBTiles/raster basemap packs locally if you want chart or
  imagery underlays;
- keep private chart packs, downloaded imagery, and runtime caches outside Git.

The app serves that local data directory at same-origin `/user-data/` and
prefers those user-owned overlays over the bundled `web/data` demo fixtures.

The optional `Online fill` layer is an internet/cache underlay for filling gaps
beneath local/user-owned charts. It is off by default and is not a replacement
for proper local chart data.

## The tracer bullet (first code)

Prove the magic before architecting anything. A macOS spike that:

1. renders a MapLibre map,
2. lets you lasso a bounding box and fetches Sentinel-2 + NOAA ENC for it,
3. packs the tiles into mbtiles and caches them offline,
4. overlays ENC `SOUNDG`/`DEPCNT` depth on the satellite imagery, and
5. drops a GRIB wind layer on top.

If that one screen feels good, the project is real and de-risked. The cross-platform
core then *emerges from working code* rather than upfront architecture.

## License

Multi-license — see [LICENSE](LICENSE), [LICENSE.BSL](LICENSE.BSL), and
[docs/LEGAL.md](docs/LEGAL.md).

- **OpenCPN-derived engine work:** GPLv2-or-later, source-visible, and kept in a
  separate boat-server process behind the HTTP/WebSocket protocol boundary.
- **Helm-authored web, runtime-service, data-tooling, and docs code:** Business Source License 1.1
  today, with personal boat use, self-hosting, internal use, modification,
  redistribution, non-commercial use, and contribution allowed now. It converts
  to Apache-2.0 on the change date.
- **Reserved use:** offering Helm as a competing hosted or managed commercial
  service before the BSL change date.

BSL is source-available, not OSI open source. The paid/commercial distribution
path is still gated on IP counsel; see [docs/LEGAL.md](docs/LEGAL.md).
