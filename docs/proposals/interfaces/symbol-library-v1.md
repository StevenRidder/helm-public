# Interface: Generated Symbol Library Manifest v1

Schema family: `helm.symbol.*.v1`  
Producer: symbol asset pipeline  
Consumers: chart service, render backend, cache, UI tools  
Current local scaffold: `registry/symbols.yaml`, `registry/symbols.json`, `registry/symbol.schema.json`

## Purpose

Provide stable IDs and metadata for generated symbol assets.

## Owns

- Symbol IDs.
- Asset paths.
- Palette/style variants.
- Accessibility labels.
- QA status.
- Provenance and clean-IP status.
- Informative source mappings.

## Does Not Own

- Official chart feature-to-symbol selection.
- Chart z-order/display priority.
- Scale visibility for official chart content.
- Decluttering.
- Safety contour behavior.

## Manifest

Schema: `helm.symbol.library.v1`

```json
{
  "schema": "helm.symbol.library.v1",
  "manifestVersion": "0.1.0",
  "symbols": [
    {
      "id": "N0001",
      "name": "Port lateral buoy",
      "tier": "chart-artifact",
      "type": "navigation-aid",
      "assets": {"canonicalSvg": "assets/svg/canonical/N0001.svg"},
      "sourceRefs": [{"system": "s52", "ref": "BOYLAT", "authority": "informative"}],
      "qa": {"status": "needs_review", "visualParity": "needs_review"},
      "provenance": {"status": "generated_owned"}
    }
  ]
}
```

## Acceptance

- Every asset exists.
- Every asset has QA status.
- Every chart-like asset carries provenance and evidence status.
- Exact-crop evidence remains distinct from class-panel or multi-symbol references.
