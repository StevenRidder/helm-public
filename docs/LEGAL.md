# Legal & licensing guardrails

> The single largest legal exposure in the product is the on-demand chart pipeline.
> This register survived an adversarial feasibility/ToS review ("sound, approve with
> minor corrections"). **Gate the on-demand chart feature behind counsel review before
> any commercial launch.**
>
> Note: for **personal use** (the current posture), bring-your-own covers all four
> imagery sources exactly as ChartLocker does today. The tiers below bind a *distributed*
> product.

## Chart & imagery source register

| Source | Status | Rule |
|---|---|---|
| **Sentinel-2 / Copernicus** | ✅ ship | Free, commercial-OK, derivatives-OK — **with permanent attribution** `Copernicus Sentinel data [Year]` / `Contains modified Copernicus Sentinel data [Year]`. Disclose 10 m resolution. |
| **NOAA ENC / NCDS raster** | ✅ ship | US public domain, bulk-OK. Prefer ENC/NCDS (RNC seamless services retired 2021/2022). |
| **OpenSeaMap** | ✅ ship (overlay) | ODbL — attribution + share-alike. Seamarks **overlay only**, never a primary chart. |
| **Google imagery** | ⛔ BYO only | ToS explicitly bars scrape / bulk-download / cache / offline. User-BYO only; never server-fetch or host. |
| **Bing imagery** | ⛔ do-not-build | No offline support; Bing Maps Enterprise EOL 2028-06-30, no new licensees since 2024. |
| **Esri / ArcGIS World Imagery** | 🔶 partnership | Offline only under a signed Esri commercial agreement, **inside Esri's own SDK**, per-export ~100k-tile cap, downstream Maxar license + audit. **Not** freely redistributable from a third-party binary. Phase-3 "pursue a deal or drop it." |
| **Navionics** | 🔶 partnership | DO NOT scrape/rasterize web tiles (the ChartLocker method) — ToS forbids non-official-API access + reverse engineering. Only legit path: approval-gated paid Garmin/Navionics Web API or Mobile SDK, which is **online-display-only** (no offline even on the paid path). |

## Weather source rules

- **Own GRIB (GFS/WW3/RTOFS):** free, public, no branding — the primary weather.
- **Windy:** online-only, Leaflet-only, **cannot composite on our chart**; forbids
  caching/offline/redistribution/model-reconstruction; mandates permanent clickable logo
  + attribution; free tier non-production. Ship **only** as an optional online WebView tab
  under paid Professional **and** with written clearance from `api@windy.com` that a
  marine-nav app is permitted under the direct-competition/added-value clause. No
  clearance → drop the feature.
- **PredictWind:** NO public API — do **not** architect against a routing endpoint, do
  **not** promise an in-app PredictWind route overlay, **never** store/replay user
  credentials. Only a route/GRIB the user themselves exported may carry the "PredictWind"
  label. Imported PredictWind/ECMWF-derived GRIB stays **device-local** — excluded from
  cloud-sync/share, never server-stored.

## Code licensing (OpenCPN / GPL)

- OpenCPN is **GPLv2-or-later**. Do **not** statically link GPL source into a closed
  App Store binary (GPL non-transferable vs. App Store terms — the "VLC problem").
- Keep any GPL chart engine as an **arm's-length contained component**, or rebuild S-52
  on permissive **GDAL/PROJ + custom symbology**. Given the "open-now-maybe-sell-later"
  posture, the permissive rebuild is favored. See [ADR-0002](decisions/0002-enc-engine.md).
- **IP counsel must sign off before any OpenCPN source is embedded.**
- Helm's own license terms are in root [LICENSE](../LICENSE) and
  [LICENSE.BSL](../LICENSE.BSL): BSL 1.1 → Apache-2.0 for Helm-authored components.
- Vulkan renderer POC boundaries are tracked in
  [VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md):
  shared OpenCPN-derived renderer semantics stay on the GPL-compatible engine
  side, while Helm web/mobile clients consume tiles and nav data over protocol
  boundaries.

## Mandatory user-facing disclaimer

On all satellite / satellite-derived-bathymetry layers, permanently:

> **Supplemental aid — NOT for primary navigation. Cross-reference official charts.**

Use the fuller project-wide safety language in [SAFETY.md](../SAFETY.md) for
README text, release notes, demos, and tester-facing material.

(Clouds and imagery can hide or paint-out reefs; SDB accuracy ≈ IHO ZOC-C, ~1.9–10 m.)

## Attribution checklist

- `Copernicus Sentinel data [Year]` — on any Sentinel-2 layer.
- OpenSeaMap — ODbL attribution + share-alike.
- Windy — permanent clickable logo + attribution (if the tab ships).
- NOAA — courtesy attribution (public domain, not required).
