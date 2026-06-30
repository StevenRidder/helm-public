# Interface: Render Backend v1

Schema family: `helm.render.*.v1`  
Producer: `helm-chartd` presentation compiler  
Consumer: `helm-renderd` or in-process backend module  
Current code/docs anchors: renderer seam, draw backend, cache, native VSG backend, WebGPU consumer

## Purpose

Define the draw-only backend contract. The backend draws render primitives; it does not own chart semantics.

## Owns

- GPU buffers.
- Texture and symbol atlas bindings.
- Draw batching.
- Framebuffer/offscreen targets.
- Device-specific artifact use.

## Does Not Own

- S-52/S-101 object semantics.
- Feature-to-symbol decisions.
- Display priority or chart z-order policy.
- Safety contour behavior.
- Text/sounding semantic placement.

## Input

Schema: `helm.render.model.v1`

```json
{
  "schema": "helm.render.model.v1",
  "modelId": "model-001",
  "viewport": {
    "bbox": [-81.85, 24.43, -81.76, 24.57],
    "z": 13,
    "pixelSize": [256, 256]
  },
  "style": {
    "palette": "day",
    "displayCategory": "standard"
  },
  "layers": [
    {
      "id": "chart-points",
      "kind": "point-symbols",
      "authority": "presentation-compiler",
      "primitives": []
    }
  ],
  "trace": {"sourceProduct": "US5FL96M", "presentationId": "present-001"}
}
```

## Output

For tile rendering:

```json
{
  "schema": "helm.render.result.v1",
  "status": "ok",
  "mediaType": "image/png",
  "artifactId": "artifact-abc",
  "traceId": "trace-abc",
  "warnings": []
}
```

## Failure Rules

- Backend failure returns `render_failed`; chart service decides fallback.
- Backend must preserve trace handles.
- Backend must not silently substitute unknown symbols for safety-relevant chart primitives.
