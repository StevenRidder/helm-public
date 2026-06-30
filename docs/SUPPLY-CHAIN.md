# Helm — supply-chain / dependency audit

Bill of materials + CVE status for the code that ships to (or serves) the Helm **web client**. The
safety-critical C++ nav engine is out of scope here — it vendors OpenCPN `model/` via the maintained
patch series (see `engine/`). This covers the web frontend and the Python companion services.

Generated 2026-06-26 (CLIENT-16). Re-run with the commands under each section.

## Web frontend — `web/vendor/` (JavaScript)

Pinned in `web/vendor/package.json` + `package-lock.json`; no CDN at runtime (offline-first). Reproduce
the bundles: `cd web/vendor && npm ci && node build.mjs` — **verified to rebuild all 8 esbuild plugin
bundles byte-identical** to the committed files, so the lockfile is an accurate bill of materials.

| Package | Version | Role |
|---|---|---|
| `maplibre-gl` | 5.24.0 | map core (UMD, copied verbatim) |
| `@deck.gl/{core,mapbox,layers,aggregation-layers}` | 9.3.4 | AIS-at-scale overlay (`deck.js`) |
| `pmtiles` | 4.4.1 | offline PMTiles protocol |
| `@geomatico/maplibre-cog-protocol` | 0.9.0 | COG / value-tile protocol |
| `maplibre-contour` | 0.1.0 | DEM depth contours |
| `terra-draw` (+ `-maplibre-gl-adapter`) | 1.31.2 / 1.4.1 | route / waypoint drawing |
| `maplibre-gl-measures` | 0.0.20 | range / bearing ruler |
| `maplibre-gl-temporal-control` | 1.2.0 | forecast time-scrubber |
| `esbuild` *(devDependency)* | 0.24.2 | build-time bundler (NOT shipped) |

### CVE status — `cd web/vendor && npm audit`
- **1 moderate — esbuild ≤0.24.2 (GHSA-67mh-4wv8-2f99).** Not exploitable in our usage: esbuild is a
  **build-time** devDependency, and the advisory is specifically the esbuild **dev server**
  (`esbuild serve`), which Helm never runs — `build.mjs` uses the `build()` API only, and the shipped
  artifact contains no esbuild. The pin stays at 0.24.2 because it reproduces the committed bundles
  byte-identical; the fix (0.28.1) is a breaking change that would re-emit every bundle and force a full
  re-test for no real exposure reduction. Revisit only if a zero-finding `npm audit` is wanted.
- All **runtime** deps (maplibre-gl, deck.gl, pmtiles, terra-draw, …): **no known vulnerabilities.**

## Python companion services (FastAPI)

`backend/` (AI / companion service) and `services/wx/` (the helm-wx value-tile gateway). These are
server-side **companion** services — not the nav core. Audited with `pip-audit -r <requirements.txt>`.

> CLIENT-16 **audits and recommends** here; it does **not** edit these files — `backend/requirements.txt`
> and `services/wx/requirements.txt` are owned by the BACKEND and WX epics. Two gaps: (1) deps use
> unpinned `>=` ranges (no lockfile → not reproducible); (2) the resolved versions carry known CVEs.

### Findings (2026-06-26)
| Package | Resolved | CVEs | Fixed in |
|---|---|---|---|
| `starlette` (via `fastapi`) | 0.49.3 | 5 — PYSEC-2026-161, GHSA-wqp7-x3pw-xc5r, GHSA-x746-7m8f-x49c, GHSA-82w8-qh3p-5jfq, GHSA-jp82-jpqv-5vv3 | ≥ 1.3.1 |
| `python-dotenv` | 1.2.1 | 1 — GHSA-mf9w-mj56-hr94 | ≥ 1.2.2 |

Both `requirements.txt` resolve to the same vulnerable `starlette` (pulled transitively by `fastapi`).

### Recommendation (for BACKEND / WX owners)
- Pin exact versions + add a lockfile (`pip-compile` / `uv lock`) so the Python supply chain is
  reproducible and auditable like the JS one.
- Move the FastAPI line forward so it pulls **`starlette` ≥ 1.3.1**, and **`python-dotenv` ≥ 1.2.2**.
- Severity is in context: these are companion services (AI + weather tiles), not the C++ safety core, and
  exposure depends on whether they're reachable beyond the boat LAN (CONTRACT-15 access tiers).

## Re-running this audit
```sh
cd web/vendor && npm ci && npm audit            # JavaScript
pip-audit -r backend/requirements.txt            # Python (run in a venv)
pip-audit -r services/wx/requirements.txt
```
