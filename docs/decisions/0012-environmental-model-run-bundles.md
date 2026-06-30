# ADR-0012 - Environmental Model-Run Bundles

- **Status:** Accepted for WX-17 contract scope; baker and renderer remain follow-up work.
- **Date:** 2026-06-29
- **Builds on:** [ADR-0008](0008-prebaked-offline-tile-packs.md), [ADR-0011](0011-s100-layer-ingestion-spike.md), `WX-10`, `WX-14`, `OFFLINE-14`, `LABS-5`

## Context

Helm's weather path has proven the wrong long-term shape for Windy-class interaction. On-demand
server-baked raster tiles can be made less bad with throttles, warm regions, and cache headers, but
that is still not the product target:

- the whole globe and closest harbour zoom must both work from the same layer contract;
- pan, zoom, timeline scrub, layer toggle, and probe must not trigger upstream API calls;
- colour fields and particles must be one coherent environmental scene, not separate ad hoc layers;
- route weather, AI explain-this, pass advisors, and offline packs need the same numeric field data;
- S-100-family met-ocean datasets must fit without teaching the renderer product-specific semantics.

The correct unit is a prepared model-run bundle:

```text
model: ecmwf/gfs/open-meteo/marine
run:   2026-06-29T00:00:00Z
times: t0..tN valid times
layers: wind, gust, rain, temp, pressure, clouds, cape, waves, swell, current, sst
tiles: numeric field tiles + vector fields + optional display tiles
```

## Decision

Helm defines `helm.env.bundle.v1` as the canonical environmental bundle manifest.

A bundle contains:

- source and model-run metadata (`provider`, `model`, `runTime`, `validTimes`);
- coverage and level-of-detail metadata for overview, basin, and regional use;
- fixed per-layer value encodings and colour ramps;
- scalar numeric field-tile templates;
- vector u/v field templates for particle layers such as wind and current;
- cache policy, including the target invariant that gestures read prepared local/cache data only;
- a `helm.layer.sample.v1` probe contract for tap, route, AI, and pass-condition consumers;
- S-100 alignment metadata that identifies the likely product family while preserving source honesty.

The first executable compatibility manifest is served by `services/wx`:

```text
GET /bundles/index.json
GET /bundles/open-meteo/latest/manifest.json
```

The implementation-grade field contract is specified in
[Environmental Bundle v1](../ENVIRONMENTAL-BUNDLE-V1.md).

The current Open-Meteo bundle is deliberately labelled `latest-frame-compatibility`. It advertises
the real target contract while acknowledging that existing `/{layer}/{z}/{x}/{y}.png` endpoints may
still fetch on cache miss until `WX-18` moves ingest into an explicit baker/refresh process.

## S-100 posture

Open-Meteo output is advisory forecast data. It is not an official S-100 product and must never be
labelled as authoritative.

The bundle still carries S-100 alignment metadata so official products can use the same layer/probe
pipe later:

| Helm layer family | S-100-family alignment |
|---|---|
| surface currents | S-111 Surface Currents |
| wind, pressure, temperature, clouds, sea-state conditions | S-413 Marine Weather and Wave Conditions |
| gust/rain/CAPE hazard cues | S-412 Marine Weather Warnings |
| future observed met-ocean layers | S-414 Marine Weather and Wave Observations |

This mirrors ADR-0011: product semantics stay above the renderer. A WebGPU/WebGL/Vulkan renderer draws
numeric fields, particles, contours, glyphs, and probes; it does not decide what S-111 or S-413 means.

## Consequences

- `WX-18` should implement the bundle baker/cache service: model-run ingest, regional/global tile
  materialization, refresh scheduling, stale serving, and quota-aware provider access.
- `WX-19` should render from this bundle contract as one environmental scene instead of stacking
  unrelated raster and particle paths.
- `OFFLINE-15` should package environmental bundles beside charts/basemaps/places so a passage area
  survives offline reload and timeline scrub.
- `LABS-8` or a later production task can add official S-100 parsers/adapters behind the same
  manifest/probe contract.
- The current value-tile API remains as a compatibility payload and test fixture. It is not the
  architecture endpoint.

## Non-Goals

- No production GRIB/ECMWF/GFS baker in this task.
- No renderer rewrite in this task.
- No claim that Open-Meteo is official S-100 data.
- No live `:8080` deployment.

## References

- IHO S-100 based product specification list: <https://iho.int/en/s-100-based-product-specifications>
- IHO WMO S-411 to S-420 product-family page: <https://iho.int/en/wmo-s-411-to-s-420>
- NOAA S-41X marine weather overlay overview: <https://ocean.weather.gov/S-41X/index.php>
