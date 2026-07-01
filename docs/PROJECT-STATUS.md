# Project Status

Helm is a public pre-alpha source release. It is useful for experimentation,
review, and contribution, but it is not a packaged chartplotter app and it is
not a primary navigation system.

## How Helm Is Being Built

Helm began as an AI-accelerated solo build around a real cruising need: one screen
that fuses charts, weather, routing, AIS, and instruments instead of four separate
apps. That moved a working headless-engine + browser-cockpit prototype onto the water
quickly.

The goal is **not** an AI-only project. The phase that matters now is turning a working
prototype into a legible open technical project — clear module boundaries (engine,
client, services, data pipeline), real build/run docs, issue structure, and a review
bar that applies to every change. The ask to the community is not "merge a large thing
into OpenCPN." It is: here is an experimental web-first chartplotter built on OpenCPN's
core ideas — help test, critique, port, document, package, and harden specific parts.

Every contribution, AI-assisted or not, is held to the same bar: human-readable intent,
reproducible behavior, tests or a verification recipe, and review. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What Helm Is Today

Today Helm is:

- a local `helm-server` built from C++ sources;
- a headless OpenCPN-derived navigation/chart server;
- a browser cockpit UI served from `web/`;
- a MapLibre-based chart surface with layered navigation context;
- a hybrid set of optional local services and data pipelines, including Python
  paths that still work and serve as references while C++ runtime parity is built;
- a bring-your-own chart/basemap system.

The browser UI opens from the local server, usually at a private development
port such as `http://127.0.0.1:9001/`.

## What Helm Is Not Yet

Helm is not yet:

- a compiled macOS `.app`;
- a Windows installer;
- a Linux package;
- an iOS or Android app;
- a certified or type-approved navigation product;
- a replacement for official charts, instruments, watchkeeping, or seamanship.

## Current Supported Run Path

The documented path is macOS from source:

1. install the listed Homebrew/Xcode dependencies;
2. run `engine/bootstrap.sh`;
3. start `/tmp/helm-opencpn/build/cli/helm-server` on a private port;
4. open the local browser UI;
5. provide user-owned chart and boat data if you want real navigation context.

See [docs/RUNBOOK.md](RUNBOOK.md).

## Data You Need To Provide

The public repo does not include real chart packs or private basemaps. For a
useful local chartplotter view, provide your own data:

- an OpenCPN-compatible ENC `.000` cell via `HELM_ENC`;
- optional local depth overlays under `~/.helm/data` or `HELM_USER_DATA_ROOT`;
- optional MBTiles/raster basemap packs served locally;
- NMEA 0183, SignalK, or another configured boat-data input.

Without that data, the UI can still load and demo fixtures can render, but it
will not be a complete local navigation setup.

## What Works In The Alpha

The current codebase includes:

- one-origin `helm-server` serving UI, `/nav`, `/chart`, `/catalog`, and
  `/health`;
- headless OpenCPN chart/nav reuse behind an HTTP/WebSocket boundary;
- MapLibre browser cockpit;
- Python weather/tooling/reference paths that are current but not the target
  required boat-side runtime;
- local/user-owned chart and depth overlay paths;
- AIS, route, track, alarm, weather, and instrument UI surfaces in active
  development;
- web unit tests and Playwright browser tests;
- engine smoke tests for the one-origin server and navigation behavior.

Some features are partial, experimental, or dependent on local data and hardware.
Please file issues with exact commands, platform, logs, and screenshots.

## Where Help Is Wanted

Good contribution lanes:

- simplify first-run setup;
- improve Linux and Windows build notes;
- test with different ENC cells and local chart libraries;
- improve missing-data and stale-data states in the UI;
- harden AIS/route/track/alarm behavior with tests;
- improve docs and screenshots;
- package a repeatable developer build without weakening the safety warning.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and
[docs/REPO-MAP.md](REPO-MAP.md).

## Safety Status

Helm is supplemental alpha software only. It may be wrong, stale, incomplete, or
misconfigured. Read [SAFETY.md](../SAFETY.md) before using or sharing it.
