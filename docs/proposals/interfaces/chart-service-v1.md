# Interface: Chart Service v1

Schema family: `helm.chart.*.v1`  
Producer: `helm-chartd`  
Consumers: gateway, clients, render backend, debug tools  
Current OpenCPN anchor: `ChartBase`, `ChartDB`, `s57chart`, `S57ENC`, and `data/s57data`

## Purpose

Expose chart tiles, chart catalog metadata, and object queries while keeping official chart portrayal authority inside the chart/presentation layer.

## Owns

- Chart source loading.
- S-52/S-101 presentation execution.
- Feature-to-symbol selection for official chart content.
- Display category, SCAMIN, safety contours, text/soundings.
- Object query semantics.
- Chart product catalog.
- Presentation provenance.

## Does Not Own

- Generic overlay UI.
- Weather/metocean truth.
- Generated symbol asset authority beyond consuming verified assets.
- Autopilot/control decisions.

## Endpoints

```text
GET /chart/{z}/{x}/{y}.png
GET /query?lat={lat}&lon={lon}&z={z}&radius={px}
GET /catalog
GET /chart/health
```

## Tile Response Headers

```text
Content-Type: image/png
ETag: "chart-product.edition.palette.safetyContour.z.x.y"
Cache-Control: public, max-age=31536000, immutable
X-Helm-Chart-Product: US5FL96M
X-Helm-Chart-Edition: 2026-06-01
X-Helm-Palette: day
X-Helm-Renderer: s52-legacy|vulkan
X-Helm-Overzoom: 0|1
```

## Catalog

Response schema: `helm.chart.catalog.v1`

```json
{
  "schema": "helm.chart.catalog.v1",
  "status": "ok",
  "products": [
    {
      "id": "US5FL96M",
      "kind": "s57-enc",
      "edition": "7",
      "updated": "2026-06-01",
      "bbox": [-81.9, 24.4, -81.6, 24.7],
      "source": {"authority": "NOAA", "license": "public-domain"},
      "portrayal": {"system": "s52", "palette": ["day", "dusk", "night"]}
    }
  ]
}
```

## Query

Response schema: `helm.chart.query.v1`

```json
{
  "schema": "helm.chart.query.v1",
  "status": "ok",
  "point": {"lat": 24.4587, "lon": -81.8078},
  "features": [
    {
      "id": "feature-1",
      "sourceProduct": "US5FL96M",
      "objectClass": "WRECKS",
      "attributes": {"VALSOU": "3.2"},
      "portrayal": {
        "authority": "s52",
        "symbol": "informative-or-source-id",
        "displayPriority": "source-owned"
      },
      "traceId": "trace-abc"
    }
  ]
}
```

## Boundary Rules

- Official chart ordering and display priority are not configurable by symbol manifests or backend renderers.
- Renderer backends consume already-compiled render primitives.
- Raster pack taps return pack metadata, not fake vector feature attributes.
