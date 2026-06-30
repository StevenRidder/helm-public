# Interface: Local Package Service v1

Schema family: `helm.package.*.v1`  
Producer: `helm-packd`  
Consumers: gateway, browser/native clients, offline tooling  
Current OpenCPN anchor: `gui/include/gui/mbtiles.h`, chart database/catalog patterns, and plugin chart extension concepts in `include/ocpn_plugin.h`

## Purpose

Serve local MBTiles, PMTiles, portable package metadata, layer inventory, prefetch manifests, and region bundle manifests.

## Owns

- Local pack discovery.
- MBTiles tile lookup.
- PMTiles byte-range serving.
- Public metadata allow-listing.
- `/catalog`, `/layers`, `/prefetch`, `/bundle`.
- Privacy-preserving source metadata.

## Does Not Own

- Official chart portrayal.
- Source chart licensing decisions beyond local allow-listing.
- Downloading proprietary packs.
- UI policy.

## Endpoints

```text
GET /health
GET /catalog
GET /layers
GET /prefetch?bbox=...|route=...
GET /bundle?bbox=...|route=...
GET /{pack}/{z}/{x}/{y}.{ext}
GET /{pack}.pmtiles
```

## Catalog

Schema: `helm.package.catalog.v1`

```json
{
  "schema": "helm.package.catalog.v1",
  "status": "ok",
  "packs": [
    {
      "id": "fiji-s52-day",
      "kind": "chart-raster",
      "format": "pmtiles",
      "url": "/fiji-s52-day.pmtiles",
      "bbox": [178.0, -18.5, 179.0, -17.5],
      "freshness": {"status": "ok", "rendered": "2026-07-01T00:00:00Z"},
      "source": {"label": "NOAA ENC render", "license": "public-domain"},
      "inspection": {"mode": "pack-metadata"}
    }
  ]
}
```

## Prefetch

Schema: `helm.package.prefetch.v1`

```json
{
  "schema": "helm.package.prefetch.v1",
  "status": "ok",
  "request": {"bbox": [178.0, -18.5, 179.0, -17.5], "minzoom": 8, "maxzoom": 12},
  "tiles": [
    {"pack": "fiji-s52-day", "z": 8, "x": 254, "y": 145, "url": "/fiji-s52-day/8/254/145.png"}
  ],
  "truncated": false
}
```

## Failure Rules

- Missing packs return `not_configured` or `not_available`.
- Out-of-bounds requests return `out_of_coverage`.
- Local filesystem paths are never leaked.
