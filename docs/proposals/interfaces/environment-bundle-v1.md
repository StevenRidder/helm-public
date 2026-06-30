# Interface: Environmental Bundle Service v1

Schema family: `helm.env.*.v1`  
Producer: `helm-envd`
Consumers: WebGPU scene, clients, package service
Current OpenCPN anchor: `plugins/grib_pi`, especially `GribReader`, `GribV2Record`, and `GribOverlayFactory`

## Purpose

Expose prepared weather/metocean bundles and value-encoded field tiles without making pan/zoom gestures call upstream providers.

## Owns

- Materialized environmental bundles.
- Value-encoded scalar tiles.
- Vector u/v field tiles.
- Bundle manifests.
- Provider freshness and NODATA honesty.

## Does Not Own

- Official S-100 product authority unless the source is actually official.
- Navigation safety decisions.
- Renderer shader policy.

## Endpoints

```text
GET /health
GET /index.json
GET /bundles/index.json
GET /bundles/{provider}/{run}/manifest.json
POST /bundles/{provider}/{run}/materialize
GET /bundles/{provider}/{run}/{region}/manifest.json
GET /bundles/{provider}/{run}/{region}/layers/{layer}/scalar/{valid}/{z}/{x}/{y}.png
GET /bundles/{provider}/{run}/{region}/layers/{layer}/vector/{valid}/{u|v}/{z}/{x}/{y}.png
```

## Bundle Manifest

Schema: `helm.env.bundle.v1`

```json
{
  "schema": "helm.env.bundle.v1",
  "id": "open-meteo/latest/fiji",
  "provider": "open-meteo",
  "status": "ok",
  "notForNavigation": true,
  "run": {
    "model": "latest",
    "issued": "2026-07-01T00:00:00Z",
    "validTimes": ["2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z"]
  },
  "layers": [
    {
      "id": "wind",
      "kind": "vector",
      "unit": "kn",
      "encoding": "helm-env-field-v1",
      "s100Alignment": {"productIdentifier": "S-413", "authority": "informative"},
      "tiles": {
        "u": "/bundles/open-meteo/latest/fiji/layers/wind/vector/20260701T000000Z/u/{z}/{x}/{y}.png",
        "v": "/bundles/open-meteo/latest/fiji/layers/wind/vector/20260701T000000Z/v/{z}/{x}/{y}.png"
      }
    }
  ]
}
```

## Failure Rules

- NODATA remains transparent.
- Provider outage may serve stale cache only if marked stale.
- Replay endpoints must not fetch upstream.
- Materialize jobs must fail closed on tile/provider budget overflow.
