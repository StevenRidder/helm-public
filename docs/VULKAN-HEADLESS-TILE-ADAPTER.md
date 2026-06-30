# Vulkan Headless Tile Adapter

This is the Helm-side sketch for consuming the shared OpenCPN Vulkan renderer
branch. Helm must not copy renderer-core code. Helm owns the HTTP tile adapter,
cache policy, diagnostics, and MapLibre composition around the shared offscreen
renderer output.

## Route Contract

The public route stays unchanged:

```text
GET /chart/{z}/{x}/{y}.png
```

The renderer path is selected by feature flag, not by changing the client
contract:

```text
HELM_CHART_RENDERER=legacy   # current OpenCPN S-52 tile path
HELM_CHART_RENDERER=vulkan   # shared offscreen renderer path
```

During development, `?renderer=legacy|vulkan` may override the process default
on private ports only. The live Helm screen must continue using the default
configured process path.

The Helm REPO-4 adapter uses these support knobs:

```text
HELM_CHART_RENDERER_QUERY_OVERRIDE=1       # enable ?renderer= on private ports
HELM_VULKAN_RENDERER_BIN=/path/to/renderer # shared offscreen renderer command
HELM_VULKAN_FIXTURE_DIR=/path/to/fixture   # POC fixture input while the shared API matures
HELM_VULKAN_RENDERER_SHA=<commit>          # pinned OpenCPN renderer commit for headers/cache
HELM_VULKAN_FALLBACK=legacy                # explicit fallback; never silent
```

If `HELM_VULKAN_RENDERER_BIN` is unset, the development default is
`scripts/vulkan-render-fixture`. Production-like verification should point this
at the OpenCPN-branch offscreen renderer binary.

## Tile To Render View

For a 256 px XYZ tile:

```text
west  = x / 2^z * 360 - 180
east  = (x + 1) / 2^z * 360 - 180
north = atan(sinh(pi * (1 - 2 * y / 2^z)))
south = atan(sinh(pi * (1 - 2 * (y + 1) / 2^z)))
```

The adapter maps this to the shared renderer view:

```text
projection            = web_mercator_tile
geographic_bbox       = [west, south, east, north]
center                = midpoint bbox
pixel_size            = [256, 256]
device_pixel_ratio    = 1
overscan_px           = 16 initially; ADAPT-4 owns the final policy
scale_denom           = existing Helm display-scale calculation
```

Helm maps existing query/display state into the shared `DisplayState`:

```text
palette               = day | dusk | night
display_category      = base | standard | all | mariner
safety_depth_m        = current Helm/OpenCPN setting
shallow_contour_m     = current Helm/OpenCPN setting
safety_contour_m      = current Helm/OpenCPN setting
deep_contour_m        = current Helm/OpenCPN setting
show_text             = existing chart text option
show_soundings        = existing sounding option
```

## Offscreen Target

The Helm adapter requests an offscreen RGBA8 target:

```text
target.kind           = offscreen
target.pixel_size     = [256, 256]
target.target_id      = chart:z/x/y
```

The shared renderer returns pixels and diagnostics. Helm encodes successful
pixels as PNG and returns the same route shape the web client already consumes.

## Cache Key And ETag

The cache key must prove which renderer, chart data, display state, and viewport
created the PNG:

```text
renderer=vulkan
renderer_branch=vulkan/render-core-poc
renderer_sha=<pinned OpenCPN commit>
scene_schema=<render scene schema version>
chart_epoch=<cell/catalog/source epoch>
z=<z>
x=<x>
y=<y>
palette=<palette>
category=<display category>
safety=<shallow,safety,deep depths>
text=<on/off>
soundings=<on/off>
overscan=<px>
```

The strong ETag is the hash of the normalized cache-key string plus renderer
output metadata:

```text
ETag: "vulkan:<sha256(cache-key)>"
Cache-Control: public, max-age=31536000, immutable
```

Error responses must not be cached:

```text
Cache-Control: no-store
```

## Diagnostics

Successful Vulkan tiles should include lightweight headers:

```text
X-Helm-Renderer: vulkan
X-Helm-Renderer-Sha: <pinned OpenCPN commit>
X-Helm-Scene-Schema: <schema version>
X-Helm-Chart-Epoch: <source epoch>
X-Helm-Renderer-Cache-Key: <sha256(normalized cache key)>
X-Helm-Renderer-Output-Sha: <sha256(encoded PNG)>
```

When the shared renderer returns diagnostics, Helm should log the structured
diagnostics and expose the failure as a plain-text `500 Render Failed` matching
the existing tile route behavior. Debug builds may add an internal JSON
diagnostic endpoint later; the public tile route stays PNG or error text.

## MapLibre Composition

The browser continues using the existing raster chart source. The feature flag
changes only the tile URL origin/template served by Helm:

```text
tiles: ["/chart/{z}/{x}/{y}.png"]
```

No MapLibre S-52 logic is introduced. MapLibre still composes Helm's raster
chart tiles with satellite, weather, AIS, routes, and other client-side layers.

## Fallback

If the Vulkan renderer is disabled, unavailable, or returns a render failure,
Helm may fall back to the legacy S-52 tile path only when the request is
feature-flagged for fallback. Fallback responses must include:

```text
X-Helm-Renderer: legacy
X-Helm-Renderer-Fallback: vulkan-render-failed
```

Silent fallback is not allowed in verification runs because it hides renderer
regressions.

Fallback is explicit through `HELM_VULKAN_FALLBACK=legacy` or, on private ports
with query overrides enabled, `?fallback=legacy`.

## REPO-4 Implementation Checklist

- Pin the OpenCPN `vulkan/render-core-poc` commit in the Helm consumer branch.
- Add `HELM_CHART_RENDERER=legacy|vulkan` process selection.
- Keep `/chart/{z}/{x}/{y}.png` stable for the client.
- Convert tile z/x/y to the shared `RenderView`.
- Map existing palette/category/safety settings to `DisplayState`.
- Request an offscreen RGBA8 target from the shared renderer.
- Encode the returned pixel buffer as PNG.
- Use the cache key and ETag fields above.
- Preserve legacy renderer fallback with explicit diagnostics.
- Do not copy shared renderer-core code into Helm.
