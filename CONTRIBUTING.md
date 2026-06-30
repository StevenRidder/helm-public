# Contributing to Helm

Helm is a pre-alpha marine chartplotter experiment. Contributions are welcome,
especially from people who can test, document, package, simplify, or harden one
clear part of the system.

The fastest way to help is to make the project easier for the next human to
run.

## Start Here

1. Read [SAFETY.md](SAFETY.md).
2. Read [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md).
3. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. Build and run the one-origin server with [docs/RUNBOOK.md](docs/RUNBOOK.md).
5. Pick a small issue or open one with the template.

## What Contributions Are Useful Now

- clearer setup instructions for macOS, Linux, and Windows;
- reproducible build fixes;
- web cockpit polish and MapLibre layer improvements;
- AIS, route, track, alarm, weather, and instrument UI tests;
- chart data onboarding docs for user-owned ENC/MBTiles data;
- safer failure states for missing, stale, or invalid boat data;
- packaging experiments that keep the safety warning visible;
- screenshots, logs, and alpha test reports from real machines.

Large rewrites are harder to review during alpha. Small, well-described pull
requests are much more likely to land.

## Architecture Rules

Helm is intentionally split into a boat server and thin clients:

- `engine/` owns the headless C++ navigation/chart server;
- `web/` owns the browser cockpit UI;
- `services/` owns optional local helper services;
- `pipeline/` owns local data generation/import tools;
- `docs/` owns contributor and operator documentation.

Try to keep a pull request inside one boundary. If a change must cross
boundaries, explain why in the PR description.

## Chart And Data Rules

Do not commit private or generated navigation data:

- no private ENC chart packs;
- no `.mbtiles` basemap packs;
- no private satellite imagery;
- no `~/.helm` runtime data;
- no generated chart caches;
- no secret tokens or machine-local paths.

The public repo should contain code, docs, tests, safe fixtures, and templates.
Users provide their own local charts and basemaps at runtime. See
[docs/RUNBOOK.md](docs/RUNBOOK.md#2-chart-and-weather-data).

## Safety Rules

Helm is supplemental alpha software only. Do not describe it as certified,
type-approved, ECDIS, carriage-compliant, or ready for primary navigation.

Safety-sensitive changes should include either an automated test or a clear
manual verification recipe. Treat these areas as safety-sensitive:

- vessel position, heading, course, speed, and source tags;
- chart rendering, chart selection, and chart cache behavior;
- depth, soundings, contours, and bathymetry overlays;
- AIS target state, CPA/TCPA, alarms, and guard zones;
- route progress, arrival, cross-track error, and waypoint activation;
- weather, current, tide, and routing layers.

## Development Commands

For the current macOS source path:

```bash
brew install wxwidgets@3.2 gpatch cmake gdal node python3
engine/bootstrap.sh
engine/test-engine.sh
```

Run the browser/client tests:

```bash
node web/test/run.mjs
cd web/test
npm ci
npx playwright install --with-deps chromium
npx playwright test
```

Use [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the contributor workflow and
[docs/RUNBOOK.md](docs/RUNBOOK.md) for the operator build/run path.

## Pull Request Checklist

Before opening a PR, please check:

- the change is scoped to one clear area where possible;
- docs were updated when behavior or setup changed;
- tests or a manual verification recipe are included;
- no private charts, basemaps, caches, secrets, or machine-local paths are
  committed;
- public safety language remains accurate;
- generated/vendor files are avoided unless the change specifically requires
  them.

AI-assisted contributions are fine. The bar is the same as any other PR:
human-readable intent, reproducible behavior, tests or verification, and review.
