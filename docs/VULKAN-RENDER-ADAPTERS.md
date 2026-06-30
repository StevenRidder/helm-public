# Vulkan Render Adapter Contracts

Status: stacked POC draft for Vulkan board `SEAM-3`

This document defines the thin adapter contracts for consuming the shared
Vulkan renderer from OpenCPN and Helm. It builds on
[VULKAN-RENDERER-SEAM.md](VULKAN-RENDERER-SEAM.md): the shared core owns chart
semantics and render commands; adapters own integration with their host app.
The license/upstream contribution boundary is recorded in
[VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md).

## Contract Rule

Adapters translate host state into renderer requests and renderer results back
into host surfaces. They must not reimplement S-52 object ordering, SCAMIN,
display-category behavior, palette semantics, symbol selection, label placement,
quilt priority, or depth-contour decisions.

If an adapter needs behavior that changes pixels, that behavior belongs in the
shared renderer input or command stream, not in adapter-local code.

## Shared Adapter Surface

The shared surface can be implemented as C++ interfaces or equivalent structs:

```text
RendererSession
  create(device_policy, resource_policy)
  begin_frame(RenderRequest) -> RenderFrame
  submit(RenderScene, RenderTarget) -> RenderResult
  readback(RenderResult) -> PixelBuffer
  collect_diagnostics() -> Diagnostic[]
  destroy()

RenderRequest
  render_view
  display_state
  source_epoch
  target_policy
  adapter_context

RenderTarget
  kind                 # onscreen_swapchain | offscreen_image
  pixel_size
  format
  color_space
  sample_count
  present_policy
```

`adapter_context` may identify the caller and debug labels, but it must not be
required to interpret render commands. A command stream generated for a given
view and display state should replay the same semantics for either adapter.

## OpenCPN Adapter

OpenCPN owns the interactive adapter around the shared renderer:

```text
OpenCpnVulkanAdapter
  on_canvas_created(canvas, window_surface)
  on_canvas_resized(size, device_pixel_ratio)
  on_view_changed(opencpn_viewport)
  on_display_options_changed(options)
  on_chart_database_changed(chart_db_epoch)
  render_frame()
  compose_plugin_overlays(frame_phase)
  present()
```

### Inputs

OpenCPN translates these host concepts into shared renderer inputs:

- `ViewPort` or equivalent canvas view state;
- chart database epoch and selected chart groups;
- S-52 display options, palette, safety contour/depth, text/sounding toggles;
- onscreen target size, scale, rotation, and device pixel ratio;
- invalidation reason: pan, zoom, rotate, chart update, display-setting change,
  plugin overlay update, or device/swapchain reset.

### Outputs

OpenCPN receives:

- an onscreen frame rendered into a swapchain target;
- structured diagnostics for status bar, logs, and debug panes;
- optional command/provenance ids for inspect/debug tools;
- resource-cache status useful for performance diagnostics.

### OpenCPN-Specific Ownership

The OpenCPN adapter owns:

- wx event-loop integration;
- window-surface and swapchain lifecycle;
- frame invalidation and present timing;
- mouse/keyboard interaction and native UI feedback;
- plugin overlay phase ordering and compatibility;
- OpenCPN preference wiring and maintainer-facing build shape.

The OpenCPN adapter does not own:

- command stream ordering;
- S-52 semantic decisions;
- chart-source conversion rules;
- label or symbol placement semantics;
- golden-image fixture expectations.

## Helm Adapter

Helm owns the headless/offscreen adapter around the shared renderer:

```text
HelmTileRenderAdapter
  configure(runtime_paths, cache_policy)
  render_tile(TileRequest) -> TileResponse
  render_catalog(CatalogRequest) -> CatalogResponse
  prefetch(PrefetchPlan)
  collect_diagnostics() -> Diagnostic[]
```

### `TileRequest`

```text
TileRequest
  z
  x
  y
  tile_size_px
  overscan_px
  palette
  display_category
  safety_depth_m
  text_policy
  source_epoch
  accept_debug_layers
```

`TileRequest` is translated into a shared `RenderView` and `DisplayState`.
HTTP headers, ETags, and MapLibre source names stay outside the renderer
request.

### `TileResponse`

```text
TileResponse
  status
  pixel_buffer | encoded_png
  content_hash
  source_epoch
  diagnostics[]
  provenance_summary
```

Helm may encode PNGs, compute ETags, return HTTP status codes, and decide cache
lifetimes after rendering. Those policies do not belong in the shared renderer.

### Helm-Specific Ownership

The Helm adapter owns:

- slippy tile math for `{z}/{x}/{y}`;
- offscreen target creation and PNG readback;
- cache key and ETag/304 policy;
- HTTP route behavior and error codes;
- runtime path resolution for bring-your-own chart data;
- MapLibre source composition;
- tile prefetch, overscan, and zoom-band blending policy.

The Helm adapter does not own:

- S-52 object ordering or styling;
- chart-source conversion semantics;
- quilt priority decisions that affect pixels;
- text, sounding, or symbol placement;
- command stream schema.

## Plugin And Overlay Boundary

OpenCPN plugins are host integrations, not implicit renderer-core dependencies.
The POC should support plugin overlays by translating them into one of two
explicit forms:

- pre-render chart-source/conversion input when the overlay affects chart
  semantics;
- post-render host overlay when the overlay is a UI adornment or interactive
  tool.

The command stream should not call plugin globals directly. Any plugin-derived
draw content that enters the shared renderer must carry provenance and stable
ordering like normal commands.

Helm overlays, such as AIS, routes, weather, or MapLibre UI layers, remain Helm
web/client layers unless they are deliberately promoted into shared renderer
input. The Vulkan chart renderer must not become the owner of Helm cockpit UI.

## Device And Resource Policy

Adapters may choose different device policies:

```text
DevicePolicy
  preferred_backend       # VulkanSceneGraph during POC
  allow_headless
  allow_readback
  max_frames_in_flight
  cache_root
  memory_budget_mb
```

OpenCPN will prefer low-latency onscreen presentation. Helm will prefer
deterministic offscreen rendering, readback, and cache reuse. Both must submit
the same renderer semantics.

## Failure Modes

Failures should be structured and adapter-actionable:

- `device.unavailable`: adapter may fall back or report renderer unavailable;
- `swapchain.lost`: OpenCPN recreates the surface;
- `offscreen_target.failed`: Helm returns a chart-tile failure without killing
  nav;
- `source.no_coverage`: Helm may return a transparent tile; OpenCPN may show
  no-chart status;
- `resource.missing`: shared renderer emits fallback diagnostics;
- `command.unsupported`: POC fixture or backend is incomplete.

Adapters decide user-facing presentation. The shared renderer emits the failure
code, provenance, and whether pixels are safe to use.

## Threading And Lifetime

- Renderer sessions own backend device resources.
- Chart-source/conversion snapshots are immutable for a `source_epoch`.
- Command streams are immutable after construction.
- Adapters may schedule work across threads, but command ordering and output
  semantics must not depend on race timing.
- Resource caches may outlive a frame but must be invalidated by source epoch,
  schema version, display state, and backend resource version.

## Test Contract

Minimum adapter acceptance:

- OpenCPN adapter can render a fixture scene into an onscreen or test target.
- Helm adapter can render the same fixture scene into an offscreen target.
- Both consume the same command stream hash for equivalent view/display inputs.
- Golden-image tests pass for at least the first fixture corpus.
- Diagnostics preserve source/provenance ids in both adapters.
- Adapter-specific policies, such as ETag or swapchain present mode, can change
  without changing command semantics.

## Staged Implementation

1. Build the shared command-stream fixture runner.
2. Add a headless/offscreen adapter path and render the fixture.
3. Add an OpenCPN canvas adapter path and render the same fixture.
4. Compare command-stream hashes before pixel output.
5. Add diagnostics and provenance inspection.
6. Only after dual-adapter proof, revisit standalone repository extraction.
