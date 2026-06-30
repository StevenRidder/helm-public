# Weather data sources — matching Windy

Windy has **no proprietary data**. They ingest the public global + regional forecast models
and render them well. We use the **same sources**.

## What Windy runs

- **Global:** ECMWF IFS (~9 km), GFS/NOAA (~22 km), DWD ICON, meteoblue mLM.
- **Regional:** ICON-EU, ICON-D2, Météo-France AROME, NOAA NAM/HRRR, BOM ACCESS.
- **Waves:** ECMWF-WAM, NOAA GFS-Wave (WaveWatch III).
- **Currents / SST:** ocean models (CMEMS/Mercator-class, NOAA RTOFS).
- **Radar:** national Doppler networks (nowcast).

Sources: [Windy community](https://community.windy.com/topic/12/what-source-of-weather-data-windy-use),
[Windy.app models](https://windy.app/support/windy-app-weather-forecast-models.html).

## How we get the same data — two tiers

### Tier 1 — Open-Meteo (free, used by the prototype)
Open-Meteo aggregates **the exact same models** (ECMWF, GFS, ICON, MeteoFrance; waves from
ECMWF-WAM / GFS-Wave / MFWAM / DWD EWAM-GWAM) and exposes every variable over HTTP JSON — no
GRIB parsing. Free for non-commercial use.

- **Forecast API** `api.open-meteo.com/v1/forecast` — atmosphere.
- **Marine API** `marine-api.open-meteo.com/v1/marine` — waves, swell, currents, SST.

### Tier 2 — raw GRIB (production / offline)
The real models, free, for offline packs and commercial independence (parse with
`wgrib2` / `eccodes` / `cfgrib`):

- **NOAA NOMADS** — GFS (atmosphere), **GFS-Wave / WaveWatch III** (waves), **RTOFS** (currents/SST). US public domain.
- **ECMWF open data** — IFS at 0.25°, GRIB2, **CC-BY-4.0** ([ecmwf-opendata](https://github.com/ecmwf/ecmwf-opendata)).
- **DWD ICON open data** — global + EU, free.
- **Radar:** NOAA MRMS (US) or [RainViewer API](https://www.rainviewer.com/api.html) (global, freemium).

## Per-layer source map

| Layer | Windy model | Open-Meteo variable (Tier 1) | GRIB source (Tier 2) |
|---|---|---|---|
| Wind | ECMWF/GFS/ICON | `wind_speed_10m` + `wind_direction_10m` | GFS UGRD/VGRD 10m |
| Gusts | ECMWF/GFS | `wind_gusts_10m` | GFS GUST |
| Rain / precip | ECMWF/GFS | `precipitation` | GFS APCP |
| Temperature | ECMWF/GFS | `temperature_2m` | GFS TMP 2m |
| Clouds | ECMWF/GFS | `cloud_cover` | GFS TCDC |
| Pressure (MSLP) | ECMWF/GFS | `pressure_msl` | GFS PRMSL |
| CAPE / thunder | GFS | `cape` | GFS CAPE |
| Waves | ECMWF-WAM / GFS-Wave | `wave_height` + `wave_direction` | GFS-Wave HTSGW/DIRPW |
| Swell | ECMWF-WAM / GFS-Wave | `swell_wave_height/direction/period` | GFS-Wave SWELL/SWDIR/SWPER |
| Wind waves | GFS-Wave | `wind_wave_height/direction` | GFS-Wave WVHGT/WVDIR |
| Currents | Mercator/RTOFS | `ocean_current_velocity/direction` | RTOFS u/v |
| SST | Ocean models | `sea_surface_temperature` | RTOFS SST |
| Tide / sea level | Tidal models | `sea_level_height_msl` | (harmonic / model) |

## Licensing

- **Open-Meteo:** free for non-commercial; commercial + self-host tiers exist (Tier 1 is for the
  prototype; a shipped product uses Tier 2 or an Open-Meteo commercial license).
- **ECMWF open data:** CC-BY-4.0 — attribution required.
- **NOAA (GFS/GFS-Wave/RTOFS):** US public domain.
- See [LEGAL.md](LEGAL.md) for the full register.

## Take-away

Every layer Windy shows is a public model variable. Tier 1 (Open-Meteo) gets the prototype to
full layer parity today; Tier 2 (NOMADS/ECMWF GRIB) is the offline-first, commercial-clean path —
and the renderer doesn't change between them, only the fetcher.
