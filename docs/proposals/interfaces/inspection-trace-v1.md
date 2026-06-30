# Interface: Source-To-Render Inspection Trace v1

Schema family: `helm.debug.*.v1`  
Producers: chart, presentation, cache, render, package, layer services  
Consumers: debug UI, tests, agents, reviewers  
Current code/docs anchors: debug inspection, chart source pipeline, presentation compiler, cache, draw backend

## Purpose

Make a rendered pixel or selected object explainable from source to screen.

## Owns

- Provenance envelope.
- Service hop trace.
- Source product references.
- Presentation/compiler decision references.
- Cache/artifact references.
- Warnings and missing evidence.

## Does Not Own

- Source data truth.
- Chart portrayal decisions.
- Legal equivalence to official standards.

## Trace

Schema: `helm.debug.trace.v1`

```json
{
  "schema": "helm.debug.trace.v1",
  "traceId": "trace-abc",
  "status": "ok",
  "request": {
    "kind": "chart-query",
    "point": {"lat": 24.4587, "lon": -81.8078},
    "viewport": {"z": 13}
  },
  "hops": [
    {
      "service": "helm-chartd",
      "stage": "source-feature",
      "status": "ok",
      "source": {"product": "US5FL96M", "objectClass": "WRECKS"}
    },
    {
      "service": "helm-chartd",
      "stage": "presentation",
      "status": "ok",
      "authority": "s52",
      "decision": "source-owned"
    },
    {
      "service": "helm-renderd",
      "stage": "draw",
      "status": "ok",
      "artifactId": "artifact-123"
    }
  ],
  "warnings": []
}
```

## Failure Rules

- Missing provenance is a warning or failure, never silently absent.
- Trace may say `not_available` when a raster pixel has no object identity.
- Debug trace must distinguish chart artifacts, overlays, and UI symbols.
