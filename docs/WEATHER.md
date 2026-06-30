# Weather stack — own GRIB overlay + Windy + PredictWind

> The magic the user asked for: "make Windy overlaid." The answer is **not** to embed
> Windy — it's to render Windy's whole layer catalog ourselves from public GRIB, so it
> composites natively over the chart, offline, with no ToS strings.

## Why we render our own (and why that's better)

Windy's beautiful animated layers are just **GPU particles + heatmaps advected by a
GRIB field** (GFS/ECMWF). That field is public data anyone can fetch. So instead of
fighting Windy's API, we reproduce the renderer over our own chart.

This is strictly better than embedding Windy:

| | Embed Windy | Own GRIB render (chosen) |
|---|---|---|
| Composite over our chart | ❌ impossible (owns its own map) | ✅ native layer |
| Offline | ❌ online-only, uncacheable | ✅ cached GRIB |
| Layer control (opacity/time) | limited | ✅ full |
| ToS / branding | logo mandatory, may bar marine apps | none |
| Cost | free tier non-prod; ~€990/yr Pro | free data |

### The renderer

Proven open-source lineage for GRIB-driven layers over MapLibre/Leaflet:

- [mapbox/webgl-wind](https://github.com/mapbox/webgl-wind) — the original WebGL particle
  technique.
- [windgl](https://github.com/astrosat/windgl) /
  [windgl-js](https://github.com/illogicz/windgl-js) — Maplibre custom layers.
- [maplibre-gl-wind](https://github.com/geoql/maplibre-gl-wind),
  [leaflet-velocity](https://github.com/danwild/leaflet-velocity).
- [Mapbox raster-particle-layer](https://docs.mapbox.com/mapbox-gl-js/example/raster-particle-layer/)
  — native particle support.

GRIB (GFS) is parsed into a u/v grid; vector fields → animated particles, scalar fields
→ heatmaps.

### The layer catalog (all from GRIB variables)

| Layer | Source variable | Render |
|---|---|---|
| Wind | 10 m u/v | animated particles |
| Gust | gust | heatmap |
| Swell / waves | WW3 / wave model (height, period, dir) | heatmap + arrows |
| Rain / precip | precip accumulation | heatmap |
| Current | RTOFS / ocean model u/v | particles |
| Pressure | MSLP | isobars |
| Cloud | total cloud | heatmap |
| Temp / CAPE | t2m / CAPE | heatmap |

Default models (free, public): **GFS, GFS-Wave (WW3), RTOFS** via NOAA; ECMWF open data
where licensing permits. Each layer has on/off, opacity, and a **forecast-time scrubber**
with prominent forecast-age display.

## Windy — optional online tab only

Windy can **only** ever be an optional online WebView tab, **never** a chart overlay:

- Its [Map Forecast API](https://api.windy.com/map-forecast/docs) is a Leaflet 1.4.x
  plugin that owns its **own** map instance (staff-confirmed it cannot be added to
  another map).
- Online-only; forbids caching/offline/redistribution; mandates a permanent clickable
  logo + attribution; free tier is GFS-only and non-production (~€990/yr Professional,
  ECMWF extra).
- A marine-nav app may be barred as "direct competition" / lacking "significant added
  value" under its ToS.

**Gate:** ships **only if** `api@windy.com` grants written clearance that a marine-nav
app is permitted. No clearance → feature dropped entirely. Own-GRIB is the weather either
way.

## PredictWind — import only

[PredictWind](https://www.predictwind.com) has **no public API** (confirmed in their FAQ;
not on the roadmap). Optimal routing runs server-side in their cloud, delivered only into
their own Offshore app and OEM MFD copies (Raymarine/B&G run PredictWind's own app, not a
licensable feed).

So a live "compute/overlay the PredictWind route" integration is **impossible** and must
not be promised. The only path:

- The user exports a **GPX route** / GRIB from their own logged-in PredictWind app.
- Helm **imports** it (file picker / iOS share-sheet), overlays it distinctly, labels it
  honestly as imported.
- Kept **device-local**: imported PredictWind GRIB is ECMWF/AROME/UKMO-derived (notably
  ECMWF "internal use only"), so it is **excluded** from any cloud-sync/share path and
  never server-stored.
- Never store/replay PredictWind credentials (single-person license; 5 devices/IPs in 6 h
  triggers forced logout).

### Our own router (the open alternative)

Because we already need GRIB + an isochrone engine, **Helm Weather Routing** (Phase 2)
computes optimal routes on free NOAA GRIB + the user's **boat polars** (`.pol`/`.csv`
import + editor) — so the user isn't dependent on PredictWind at all.
