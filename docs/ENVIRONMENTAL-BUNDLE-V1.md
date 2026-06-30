# Environmental Bundle v1

> Implementation contract for Windy-parity met-ocean layers in Helm.
> ADR: [ADR-0012](decisions/0012-environmental-model-run-bundles.md).

`helm.env.bundle.v1` is the contract between:

- the bundle baker/cache (`WX-18`);
- the environmental renderer (`WX-19`);
- offline packs (`OFFLINE-15`);
- route/weather probes, AI explain-this, pass advisors, and future native clients;
- future S-100-family adapters.

The point of this contract is simple: **pan, zoom, timeline scrub, layer toggle, probe, and route
sampling must read prepared local/cache data only.** Those interactions must not call Open-Meteo,
NOAA, ECMWF, or any other upstream provider while the user is watching.

Existing `services/wx` value tiles remain a compatibility payload. They are useful test vectors, but
they are not the final architecture by themselves.

---

## 1. Normative language

This document uses:

- **MUST** for requirements a producer or consumer must obey.
- **SHOULD** for preferred behavior with a documented exception allowed.
- **MAY** for optional behavior.

Any layer that cannot meet the honesty rules MUST fail visibly and remain sampleable as `no data`;
it MUST NOT synthesize plausible-looking weather.

---

## 2. Bundle identity and layout

A bundle is a directory or HTTP namespace containing one model run, one region/global coverage, and
one fixed schema version.

Recommended offline/on-disk layout:

```text
env/
  bundles/
    <provider>/<model>/<run-id>/<region-id>/
      manifest.json
      index.json                         optional local index fragment
      layers/
        <layer>/
          manifest.json                  optional per-layer manifest mirror
          scalar/
            <valid-time-id>/<z>/<x>/<y>.png
          vector/
            <valid-time-id>/u/<z>/<x>/<y>.png
            <valid-time-id>/v/<z>/<x>/<y>.png
          display/
            <valid-time-id>/<z>/<x>/<y>.png   optional pre-colourised cache
```

Recommended HTTP discovery:

```text
GET /bundles/index.json
GET /bundles/<provider>/<model>/<run-id>/<region-id>/manifest.json
```

The current compatibility endpoint is:

```text
GET /bundles/open-meteo/latest/manifest.json
```

Bundle ids MUST be stable enough to cache:

```text
<provider>/<model>/<run-id>/<region-id>
open-meteo/gfs-seamless/2026-06-29T00Z/fiji-south-pacific
noaa/gfs/2026-06-29T00Z/global
noaa/rtofs/2026-06-29T00Z/south-pacific
```

`latest` MAY be used for online compatibility, but offline bundles SHOULD use explicit run ids.

---

## 3. Manifest top-level schema

The bundle manifest MUST be JSON with this top-level shape:

```jsonc
{
  "schema": "helm.env.bundle.v1",
  "bundleId": "open-meteo/gfs-seamless/2026-06-29T00Z/fiji-south-pacific",
  "title": "Fiji / South Pacific environmental bundle",
  "productFamily": "met-ocean",
  "encoding": "helm-wxv1",
  "generatedAt": "2026-06-29T00:10:00Z",
  "source": {},
  "run": {},
  "coverage": {},
  "lod": {},
  "cachePolicy": {},
  "renderPolicy": {},
  "sampleContract": {},
  "layers": {},
  "disclaimer": "Forecast/advisory met-ocean data. Cross-reference official sources. NOT FOR NAVIGATION."
}
```

Required top-level fields:

| Field | Type | Meaning |
|---|---:|---|
| `schema` | string | MUST be `helm.env.bundle.v1`. |
| `bundleId` | string | Stable id used for cache keys and offline pack inventory. |
| `title` | string | Human-readable label. |
| `productFamily` | string | MUST be `met-ocean` for this version. |
| `encoding` | string | Default scalar value encoding. MUST be `helm-wxv1` unless the layer overrides it. |
| `generatedAt` | ISO time | Time the manifest was generated, not necessarily model issue time. |
| `source` | object | Provider/provenance/licensing metadata. |
| `run` | object | Model run and valid-time metadata. |
| `coverage` | object | CRS, bbox/polygon, antimeridian, and region metadata. |
| `lod` | object | Tile matrix, zoom ranges, fallback and overzoom behavior. |
| `cachePolicy` | object | Refresh, TTL, stale, and upstream-fetch rules. |
| `renderPolicy` | object | Renderer expectations and display/non-display artifacts. |
| `sampleContract` | object | Probe/sample return contract. |
| `layers` | object | Layer records keyed by layer id. |
| `disclaimer` | string | Human-readable safety warning. |

Unknown fields MUST be ignored by consumers. Unknown layer ids MUST be ignored unless the user
explicitly enabled an experimental layer.

---

## 4. Source and run metadata

`source` MUST describe where the data came from and what the user may trust.

```jsonc
"source": {
  "provider": "open-meteo",
  "modelAuthority": "advisory",
  "forecastEndpoint": "https://api.open-meteo.com/v1/forecast",
  "marineEndpoint": "https://marine-api.open-meteo.com/v1/marine",
  "licensing": "caller must verify production/commercial terms separately",
  "advisoryOnly": true,
  "notForNavigation": true
}
```

`run` MUST distinguish model issue time from forecast valid time:

```jsonc
"run": {
  "mode": "model-run",
  "model": "NOAA GFS 0.25",
  "marineModel": "NOAA GFS-Wave / RTOFS",
  "runTime": "2026-06-29T00:00:00Z",
  "runLabel": "2026-06-29T00Z",
  "validTimes": [
    "2026-06-29T00:00:00Z",
    "2026-06-29T03:00:00Z",
    "2026-06-29T06:00:00Z"
  ],
  "frames": 3,
  "timeStepSeconds": 10800
}
```

Rules:

- `runTime` is the model run/issue time.
- `validTimes[]` are forecast times available for rendering/sampling.
- `generatedAt` is when Helm produced the bundle artifact.
- Compatibility/live endpoints MAY use `mode: "latest-frame-compatibility"` with `runTime: null` and
  `frames: 1`; prepared offline bundles SHOULD NOT.

Time ids in paths SHOULD use compact UTC:

```text
20260629T000000Z
20260629T030000Z
```

A manifest MAY also provide `frameIdByValidTime` when path ids differ from ISO strings.
Prepared bundles MAY also expose an ordered top-level `frames[]` convenience list with
`validTime`, `time`, `validTimeId`, `isLatest`/`latest`, and offset metadata. `run.validTimes[]`
and `run.frameIdByValidTime` remain the canonical contract for clients that only need tile path ids.

---

## 5. Coverage and antimeridian

`coverage` MUST use `OGC:CRS84` lon/lat ordering unless explicitly overridden.

```jsonc
"coverage": {
  "crs": "OGC:CRS84",
  "bbox": {
    "west": 160.0,
    "south": -35.0,
    "east": -150.0,
    "north": 5.0,
    "crossesAntimeridian": true
  },
  "polygon": null,
  "global": false,
  "wrap": "antimeridian",
  "regionId": "fiji-south-pacific",
  "homeWaters": "Fiji / Tonga / Samoa / South Pacific passage region"
}
```

Rules:

- A bbox with `crossesAntimeridian: true` represents `[west..180] + [-180..east]`.
- Consumers MUST handle antimeridian coverage without treating `east < west` as empty.
- Bakers MAY split physical tile generation into two lon ranges internally, but the bundle manifest
  SHOULD preserve the user-facing wrapped coverage.
- A sample outside coverage MUST return `value: null` and a coverage note.

---

## 6. Level of detail and all-zoom behavior

`lod` defines how the renderer stays instant from whole-world view to close harbour zoom.

```jsonc
"lod": {
  "tileMatrixSet": "WebMercatorQuad",
  "tileSize": 256,
  "dataMinZoom": 0,
  "dataMaxZoom": 8,
  "levels": {
    "overview": {"minzoom": 0, "maxzoom": 2, "purpose": "instant whole-ocean view"},
    "basin": {"minzoom": 3, "maxzoom": 5, "purpose": "passage-scale planning"},
    "regional": {"minzoom": 6, "maxzoom": 8, "purpose": "boat-region native grid detail"}
  },
  "parentFallback": true,
  "overzoom": "renderer may overzoom prepared parent/native field tiles beyond dataMaxZoom",
  "interpolation": "bilinear-in-field-space"
}
```

Renderer rules:

- For any map zoom above `dataMaxZoom`, renderer MUST overzoom from the best available native tile.
- If a requested tile is missing and `parentFallback` is true, renderer MUST look for the nearest
  valid parent tile before showing an empty layer.
- Fallback MUST be visually apparent only as lower detail, not as missing global coverage.
- No fallback path may perform upstream provider fetch during a gesture.
- Scalar interpolation SHOULD happen in decoded numeric field space, then colour ramp should be
  applied. Do not interpolate already-colourised display pixels unless using optional display tiles
  as a last-resort cache.

WX-18 acceptance SHOULD include a Fiji/South Pacific warm bundle with all layers available at
overview, basin, and regional LOD. WX-19 acceptance SHOULD include widest zoom, passage zoom, and
harbour zoom visual checks.

---

## 7. Layer records

Each entry in `layers` is keyed by a stable layer id:

```text
wind, gust, rain, temp, pressure, clouds, cape, waves, swell, current, sst
```

Required layer shape:

```jsonc
"wind": {
  "id": "wind",
  "kind": "vector",
  "unit": "kn",
  "source": "open-meteo-forecast",
  "model": "Open-Meteo (GFS-seamless)",
  "providerVariable": "wind_speed_10m",
  "directionVariable": "wind_direction_10m",
  "valueEncoding": {},
  "range": {"min": 0, "max": 80, "unit": "kn"},
  "ramp": [[0, [98, 113, 183]], [5, [57, 131, 168]]],
  "fieldTiles": {},
  "vectorField": {},
  "displayTiles": {},
  "s100": {},
  "probe": {},
  "disclaimer": "Forecast — cross-reference official sources. NOT FOR NAVIGATION."
}
```

Required fields:

| Field | Meaning |
|---|---|
| `id` | Same as the layer key. |
| `kind` | `scalar` or `vector`. Vector layers still SHOULD expose a scalar speed/magnitude field. |
| `unit` | Display/sample unit. |
| `source` / `model` | Per-layer provenance. |
| `valueEncoding` | Numeric field encoding. |
| `range` | Physical min/max for legend and fixed scale. |
| `ramp` | Fixed colour stops. |
| `fieldTiles` | Scalar/magnitude field tile template. |
| `s100` | S-100-family alignment metadata. |
| `probe` | Sampling handle and return semantics. |
| `disclaimer` | Layer-specific safety label. |

Layer ids and units for v1:

| Layer | Kind | Unit | Notes |
|---|---|---:|---|
| `wind` | vector | kn | Speed colour + particles. |
| `gust` | scalar | kn | Hazard cue, no particles. |
| `rain` | scalar | mm | Accumulation/precip field. |
| `temp` | scalar | °C | Air temperature. |
| `pressure` | scalar | hPa | MSLP; renderer MAY derive isobars. |
| `clouds` | scalar | % | Cloud cover. |
| `cape` | scalar | J/kg | Convective potential / thunder cue. |
| `waves` | scalar | m | Significant wave height. |
| `swell` | scalar | m | Swell height; later may add direction/period. |
| `current` | vector | kn | Surface-current speed colour + particles. |
| `sst` | scalar | °C | Sea-surface temperature. |

---

## 8. Scalar numeric field tiles

Scalar field tiles use `helm-wxv1`, inherited from [WEATHER-TILES.md](WEATHER-TILES.md).

```jsonc
"valueEncoding": {
  "encoding": "helm-wxv1",
  "bits": 24,
  "scale": 0.000004768372,
  "offset": 0.0,
  "nodataAlpha": 0,
  "hasAlpha": true
},
"fieldTiles": {
  "type": "value-raster-tile",
  "tileMatrixSet": "WebMercatorQuad",
  "tileSize": 256,
  "minzoom": 0,
  "maxzoom": 8,
  "urlTemplate": "layers/wind/scalar/{validTimeId}/{z}/{x}/{y}.png"
}
```

Encoding:

```text
n      = clamp(round((value - offset) / scale), 0, 0xFFFFFF)
R,G,B  = (n>>16)&255, (n>>8)&255, n&255
A      = 255 valid, 0 no data
value  = offset + ((R<<16)|(G<<8)|B) * scale
```

Rules:

- `scale` and `offset` MUST be fixed for a layer across all times and zooms in the bundle.
- Alpha `< 128` MUST mean no data.
- Bakers MUST NOT encode a fake value for land/gaps/out-of-provider coverage.
- Renderers MUST apply colour ramps after decoding values, not before, unless consuming optional
  display tiles.
- Probes MUST sample the same decoded field tiles that drive the visual field.

---

## 9. Vector fields and particles

Vector layers need both a scalar magnitude/colour field and a vector field for motion.

Prepared bundles SHOULD use component tiles:

```jsonc
"vectorField": {
  "type": "component-tiles",
  "components": ["u", "v"],
  "speedUnit": "kn",
  "directionConvention": "from",
  "u": {
    "encoding": "helm-wxv1",
    "unit": "kn",
    "range": {"min": -80, "max": 80},
    "urlTemplate": "layers/wind/vector/{validTimeId}/u/{z}/{x}/{y}.png"
  },
  "v": {
    "encoding": "helm-wxv1",
    "unit": "kn",
    "range": {"min": -80, "max": 80},
    "urlTemplate": "layers/wind/vector/{validTimeId}/v/{z}/{x}/{y}.png"
  }
}
```

Compatibility/live services MAY expose a bbox JSON endpoint:

```jsonc
"vectorField": {
  "type": "bbox-json-compatibility",
  "components": ["u", "v"],
  "speedUnit": "kn",
  "directionConvention": "from",
  "urlTemplate": "/velocity/wind?w={west}&s={south}&e={east}&n={north}",
  "cacheKey": "snapped-bbox"
}
```

Rules:

- WX-18 prepared bundles SHOULD emit component tiles for vector fields; the bbox JSON path is for
  compatibility only and SHOULD NOT be used for instant all-zoom rendering.
- `wind` direction convention is meteorological **from**; motion vectors are negated from direction.
- `current` direction convention is oceanographic **toward**; motion vectors follow direction.
- Particle animation MUST use the same valid time and coverage as the scalar colour field.
- If vector components are missing but scalar magnitude exists, renderer MAY show colour field without
  particles and MUST surface degraded state.
- If scalar field is missing but vector components exist, renderer MAY animate particles on transparent
  colour but MUST surface degraded state.

---

## 10. Optional display tiles

Display tiles are pre-colourised caches. They MAY be used for very low-power clients or CDN-style
preview, but they MUST NOT replace numeric field tiles as the source of truth.

```jsonc
"displayTiles": {
  "optional": true,
  "status": "materialized",
  "urlTemplate": "layers/wind/display/{validTimeId}/{z}/{x}/{y}.png",
  "derivedFrom": "fieldTiles",
  "rampVersion": "bundle"
}
```

Rules:

- Probe/sample MUST use numeric field/vector tiles, not display pixels.
- Display tiles MUST declare which ramp produced them.
- If display tiles and numeric tiles disagree, numeric tiles win.

---

## 11. Cache and refresh lifecycle

The cache policy is part of the user-visible safety contract:

```jsonc
"cachePolicy": {
  "targetInvariant": "pan, zoom, scrub, and layer toggles read prepared local/cache data only",
  "upstreamFetchesAllowedDuringGesture": false,
  "refreshOnly": true,
  "ttlSeconds": 10800,
  "staleServing": true,
  "staleMaxSeconds": 86400,
  "refreshCadenceSeconds": 10800,
  "providerBackoffSeconds": 300,
  "quotaPolicy": "batch-by-run-and-region"
}
```

Baker/cache states:

| State | Meaning | Gesture behavior |
|---|---|---|
| `fresh` | Bundle inside TTL. | Render normally. |
| `stale` | TTL expired but data exists. | Render with stale badge; do not fetch on gesture. |
| `refreshing` | Background update in progress. | Keep rendering previous bundle. |
| `partial` | Some layers/times missing. | Render available layers; show degraded state. |
| `unavailable` | No local/cache data. | Show empty/degraded layer; offer refresh/download. |

WX-18 rules:

- Fetch upstream by model run, valid time, layer, and region — not by viewport tile request.
- Batch provider calls and obey provider quotas.
- Store previous good bundles until a newer bundle is fully usable or explicitly marked partial.
- Never delete the only usable bundle while refreshing.
- Emit a bundle inventory entry for offline pack management.
- Record source, model, run time, generation time, freshness, and confidence for every layer.

---

## 12. Sampling contract

Every layer MUST support deterministic sampling:

```jsonc
{
  "schema": "helm.layer.sample.v1",
  "layer": "wind",
  "position": {"lat": -17.6, "lon": 177.4},
  "time": "2026-06-29T03:00:00Z",
  "validTime": "2026-06-29T03:00:00Z",
  "value": 18.4,
  "unit": "kn",
  "vector": {"u": -4.2, "v": 17.9, "unit": "kn"},
  "sourceRef": {
    "bundleId": "open-meteo/gfs-seamless/2026-06-29T00Z/fiji-south-pacific",
    "provider": "open-meteo",
    "model": "Open-Meteo (GFS-seamless)",
    "runTime": "2026-06-29T00:00:00Z"
  },
  "freshness": {"generatedAt": "2026-06-29T00:10:00Z", "ageSeconds": 10200},
  "confidence": "fair",
  "coverage": "inside",
  "advisory": true,
  "notForNavigation": true,
  "note": null
}
```

Rules:

- `sample(lat, lon, time)` is the canonical argument order.
- If `time` falls between valid times, consumers MAY interpolate in time only when
  `run.timeInterpolation` permits it; otherwise choose nearest valid time and report it.
- If outside coverage, missing tile, or no-data pixel, return `value: null`, `coverage: "outside"` or
  `"nodata"`, and a human note.
- The sample result MUST carry source and freshness. A value without provenance is invalid.
- Route weather samples use the same function along worldline `W(position,time)`.

---

## 13. S-100-family alignment

This contract is S-100-shaped, but it does not make advisory data authoritative.

Layer metadata MUST include:

```jsonc
"s100": {
  "aligned": true,
  "officialProduct": false,
  "advisorySource": "open-meteo",
  "productIdentifier": "S-413",
  "productName": "Marine Weather and Wave Conditions",
  "datasetName": null,
  "edition": null,
  "referenceDate": null,
  "producer": null,
  "coverage": "bundle.coverage",
  "validity": "bundle.run.validTimes",
  "traceHandle": "open-meteo:wind_speed_10m"
}
```

Initial alignment:

| Helm layer family | S-100-family alignment |
|---|---|
| `current` | S-111 Surface Currents |
| `wind`, `temp`, `pressure`, `clouds`, `waves`, `swell`, `sst` | S-413 Marine Weather and Wave Conditions |
| `gust`, `rain`, `cape` | S-412 Marine Weather Warnings / hazard cues |
| future observations | S-414 Marine Weather and Wave Observations |

Rules:

- Open-Meteo, NOAA, ECMWF, and local derived products MUST use `officialProduct: false` unless the
  source is an actual official S-100 dataset.
- Official S-100 adapters MUST fill `datasetName`, `edition`, `referenceDate`, `producer`, and
  product-specific trace handles.
- Renderer code MUST NOT branch on S-100 semantics. It draws fields and particles. Product meaning
  belongs in metadata, probes, warnings, and source cards.

---

## 14. Renderer contract for WX-19

The environmental renderer consumes a bundle and draws one coherent scene.

Renderer MUST:

- load a bundle manifest and ignore unknown optional fields;
- resolve valid time, LOD, and coverage before requesting tiles;
- keep scalar colour, particles, probes, and legends on the same layer/time/source;
- decode numeric fields on or off the GPU without blocking pan/zoom;
- overzoom/fallback from prepared tiles instead of fetching upstream;
- render missing/stale/partial states visibly;
- keep all weather below safety-critical chart/ownship/AIS layers unless the user explicitly changes
  ordering;
- preserve alpha/no-data semantics.

Renderer SHOULD:

- upload scalar/vector fields as textures and colourise in shader/WebGPU/WebGL rather than
  synchronously re-rasterizing on the main thread;
- reuse textures across pan/zoom/timeline where tile keys match;
- animate particles from vector components and fade trails in screen space;
- derive isobars from pressure fields in a worker or GPU pass;
- support low-power fallback via optional display tiles.

Renderer MUST NOT:

- call Open-Meteo/NOAA/ECMWF directly;
- use separate unsynchronized data sources for particles and colour fields;
- silently hide layer failure;
- invent values to fill land/holes.

---

## 15. Offline pack contract

Environmental bundles are offline-pack members beside chart, basemap, depth, and places packs.

Pack inventory SHOULD include:

```jsonc
{
  "kind": "environmental-bundle",
  "schema": "helm.env.bundle.v1",
  "bundleId": "open-meteo/gfs-seamless/2026-06-29T00Z/fiji-south-pacific",
  "manifest": "env/bundles/open-meteo/gfs-seamless/2026-06-29T00Z/fiji-south-pacific/manifest.json",
  "coverage": {},
  "sizeBytes": 123456789,
  "layers": ["wind", "gust", "rain", "temp", "pressure", "clouds", "cape", "waves", "swell", "current", "sst"],
  "validTimes": ["2026-06-29T00:00:00Z", "2026-06-29T03:00:00Z"],
  "notForNavigation": true
}
```

Rules:

- Offline reload must find the bundle without network.
- Pack deletion must remove manifest and tiles together.
- Stale/out-of-coverage warnings must be visible in the layer picker and probe cards.
- Imported proprietary GRIB remains device-local and excluded from sync unless licensing explicitly
  allows sharing.

---

## 16. WX-18 acceptance checklist

WX-18 should be considered ready when it can:

- generate a Fiji/South Pacific warm bundle manifest using this spec;
- materialize all v1 layers for at least one model run and multiple valid times;
- write scalar field tiles for every scalar/magnitude layer;
- write vector component tiles for `wind` and `current`;
- handle antimeridian coverage;
- serve previous good data while refreshing;
- avoid upstream provider calls during pan/zoom/scrub/toggle/sample;
- expose bundle inventory for offline pack management;
- pass a no-network test after bundle creation;
- label advisory data and S-100 alignment honestly.

---

## 17. WX-19 acceptance checklist

WX-19 should be considered ready when the client can:

- load the bundle manifest and choose available layers/times;
- render all v1 scalar layers from numeric fields;
- animate wind and current from vector fields;
- keep scalar colour and particles synchronized by valid time;
- work at widest global view, basin view, and close harbour zoom using overzoom/parent fallback;
- switch layers and scrub time without upstream calls;
- show stale/partial/no-data states;
- sample the visible field and return `helm.layer.sample.v1`;
- pass a no-network visual/probe smoke test from a prepared Fiji/South Pacific bundle.

---

## 18. Compatibility with current `services/wx`

Current `services/wx` now exposes the v1 manifest surface:

```text
/bundles/index.json
/bundles/open-meteo/latest/manifest.json
```

That compatibility manifest:

- advertises all v1 layers;
- exposes scalar `helm-wxv1` field tile endpoints;
- exposes bbox JSON velocity endpoints for vector layers;
- includes LOD/cache/S-100/sample metadata;
- honestly labels itself as `latest-frame-compatibility`.

It is allowed to fetch on cache miss today. That exception is only for compatibility. Prepared
bundles produced by WX-18 MUST move upstream provider work to refresh/bake time and keep the gesture
path local/cache-only.
