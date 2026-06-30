# Interface: Marine Overlay Layer Manifest v1

Schema family: `helm.layer.*.v1`  
Producer: `helm-layerd`, `helm-packd`
Consumers: clients, debug tools
Current code anchors: `helm_packd.cpp`, `pipeline/layer_inventory.py`, `/user-data` serving

## Purpose

Describe extra georeferenced layers that augment the displayed chart without becoming chart data or chart portrayal.

## Owns

- Overlay identity.
- Source attribution.
- Freshness and coverage.
- Geometry/tile format references.
- Inspection/probe metadata.
- Local privacy allow-listing.

## Does Not Own

- Official chart features.
- Official chart z-order/display priority.
- Navigation safety decisions.

## Manifest

Schema: `helm.layer.manifest.v1`

```json
{
  "schema": "helm.layer.manifest.v1",
  "layers": [
    {
      "id": "owned-anchorage-notes",
      "title": "Owned anchorage notes",
      "kind": "points",
      "format": "geojson",
      "tier": "overlay",
      "url": "/user-data/layers/anchorages.geojson",
      "bbox": [178.0, -18.5, 179.0, -17.5],
      "source": {"label": "owned", "license": "private-local"},
      "freshness": {"status": "ok"},
      "inspection": {"mode": "feature-properties"}
    }
  ]
}
```

## Supported Formats

Initial:

- GeoJSON.
- PMTiles.
- MBTiles.
- PNG/JPEG tile templates.
- Value-encoded field tiles through `helm.env.bundle.v1`.

Future:

- GeoPackage.
- Cloud Optimized GeoTIFF.
- OGC API Features/Tiles references.

## Failure Rules

- Private filesystem paths are never exposed.
- Missing optional layers do not fail chart rendering.
- Layers must visibly report stale/out-of-coverage status.
