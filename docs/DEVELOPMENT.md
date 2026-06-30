# Development Guide

This guide is for contributors working on the source tree. For an operator-style
build/run recipe, see [RUNBOOK.md](RUNBOOK.md).

Internal multi-agent coordination uses private planning docs and board tooling. Public contributors
can work from this guide, the runbook, and normal GitHub issues or pull requests.

## Mental Model

Helm has a boat-side server and thin clients:

- the C++ `helm-server` is the local navigation/chart server;
- the browser UI in `web/` is the reference cockpit;
- optional services add local helper behavior;
- pipeline scripts prepare local/user-owned data.

You usually do not need to understand every part to contribute. Pick one area,
make a small change, and include a test or verification note.

## Ports

Use private development ports. The examples use `9001`.

```bash
HELM_PORT=9001
```

Avoid assuming `8080` is available. On a shared boat or development machine it
may be reserved for a stable live display.

## Build The Engine

```bash
brew install wxwidgets@3.2 gpatch cmake gdal node python3
engine/bootstrap.sh
```

The build creates:

```text
~/.helm/build/helm-opencpn/build/cli/helm-server
~/.helm/build/helm-opencpn/build/cli/helm-engine
~/.helm/build/helm-opencpn/build/cli/helm-tiles
```

`helm-server` is the normal product path.

## Run The Server

```bash
scripts/install-sample-enc.sh
python3 -m venv services/wx/.venv
services/wx/.venv/bin/python -m pip install -r services/wx/requirements.txt
scripts/start-helm.sh --port 9001 --weather --fill
```

Then open:

```bash
open http://127.0.0.1:9001/
```

Set `HELM_ENC` to a local ENC `.000` file when you want real S-52 chart tiles.

## Run Tests

Engine smoke:

```bash
engine/test-engine.sh
```

Web unit tests:

```bash
node web/test/run.mjs
```

Browser E2E tests:

```bash
cd web/test
npm ci
npx playwright install --with-deps chromium
npx playwright test
```

If you cannot run a test locally, say so in the PR and include the manual
verification you did run.

## Local Chart Data

Keep private/user-owned data outside Git:

- chart packs and `.000` cells;
- `.mbtiles` files;
- private satellite imagery;
- generated GeoJSON overlays;
- runtime caches and `~/.helm` state.

Useful runtime paths:

```text
HELM_ENC=/path/to/chart.000
HELM_USER_DATA_ROOT=/path/to/user-data
~/.helm/data/
```

Helm serves user data from `/user-data/` and prefers it over bundled demo
fixtures.

## Working On Specific Areas

| Area | Before you start | Useful checks |
|---|---|---|
| `web/` | read `web/test/README.md` | `node web/test/run.mjs`, Playwright tests |
| `engine/` | read `engine/README.md` and `docs/RUNBOOK.md` | `engine/bootstrap.sh`, `engine/test-engine.sh` |
| `services/` | read the service README | service-specific smoke plus `/health` if present |
| `pipeline/` | read `pipeline/README.md` and `docs/CHART-PIPELINE.md` | generated files stay outside Git unless they are safe fixtures |
| `docs/` | check public links and safety wording | links resolve in the public mirror |

## Public Mirror

The public repository is maintained from a sanitized export of the private
source tree. Public cleanup should not mutate the live runtime UX or remove the
bring-your-own chart path. Private chart data and internal planning material
must stay out of the exported tree.

If you are reading the public mirror, you do not need private publish tooling to
contribute. Open issues and pull requests against the public repo with small,
reviewable changes and clear verification notes.
