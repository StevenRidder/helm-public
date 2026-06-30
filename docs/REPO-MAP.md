# Repo Map

Use this as the quick orientation guide for the public alpha.

| Path | Owns | Notes |
|---|---|---|
| `README.md` | first public explanation | what Helm is, what runs today, quick start |
| `SAFETY.md` | navigation safety notice | link this from demos, releases, and tester docs |
| `CONTRIBUTING.md` | human contribution workflow | scope, PR expectations, safety/data rules |
| `engine/` | headless C++ boat server | builds `helm-server` and related CLI tools |
| `engine/vendor/cli/` | Helm's OpenCPN CLI/server layer | includes the one-origin server source |
| `web/` | browser cockpit | MapLibre UI, layer controls, AIS/routes/tracks/alarms |
| `web/test/` | browser/client tests | dependency-free JS tests plus Playwright E2E |
| `services/` | optional local helper services | basemap fill, weather helpers, service docs |
| `pipeline/` | local data tools | chart/depth/weather processing and fixtures |
| `backend/` | optional backend/agent experiments | Python requirements are scoped here |
| `docs/` | public docs | architecture, runbook, licensing, data, integrations |
| `docs/decisions/` | ADRs | architecture decision records that are public-safe |
| `.github/workflows/` | CI | web unit tests and Playwright E2E |
| `.github/ISSUE_TEMPLATE/` | issue intake | bug reports, alpha tests, contribution tasks |

## Common Entry Points

| Goal | Start with |
|---|---|
| Understand the system | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| Build and run locally | [docs/RUNBOOK.md](RUNBOOK.md) |
| Contribute a small fix | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Check alpha readiness | [docs/PROJECT-STATUS.md](PROJECT-STATUS.md) |
| Work on chart data | [docs/CHART-PIPELINE.md](CHART-PIPELINE.md) |
| Work on OpenCPN reuse | [docs/OPENCPN-REUSE.md](OPENCPN-REUSE.md) |
| Review the Helm/WebGPU renderer path | [docs/VULKAN-HELM-WEBGPU-PROOF.md](VULKAN-HELM-WEBGPU-PROOF.md) |
| Work on streaming clients | [docs/STREAMING-API.md](STREAMING-API.md) |
| Check licensing boundaries | [docs/LEGAL.md](LEGAL.md) |

## What Not To Commit

Do not commit private or generated navigation data:

- user chart packs;
- `.mbtiles` basemap packs;
- private satellite imagery;
- `~/.helm` runtime data;
- generated caches;
- tokens, credentials, or machine-local paths.
