# Vulkan Renderer Repository Structure

This is the repository strategy for the shared Vulkan renderer POC. The goal is not a Helm-only
fork and not a new standalone library too early. The goal is an upstream-shaped OpenCPN renderer seam
that Helm can consume through a thin headless adapter.

## Decision

Use two branches first:

```text
OpenCPN fork/branch: vulkan/render-core-poc
Helm branch:        vulkan/consume-render-core
```

Current branch anchors:

```text
OpenCPN: https://github.com/StevenRidder/OpenCPN/tree/vulkan/render-core-poc
  base: OpenCPN/OpenCPN master @ 6d120d5627dd751e63d7d463fd372cc583b7bfcd

Helm: https://github.com/StevenRidder/Helm/tree/vulkan/consume-render-core
  base: StevenRidder/Helm main @ 2fb334ee7c4ce79f189159cad26356053f1304a0
```

Do not create a standalone `opencpn-chart-renderer` repository until the render seam is stable,
accepted by both sides, and easy to build outside the full OpenCPN app. A new repo too early risks a
beautiful island that OpenCPN never merges. A Helm-only branch risks a forever fork.

## Ownership Split

The shared renderer belongs upstream-shaped in the OpenCPN branch:

```text
S-57/SENC data + S-52 presentation rules
    -> render command stream
    -> VulkanSceneGraph backend
    -> pixels
```

OpenCPN-specific code stays thin:

```text
OpenCPN viewport/chart canvas/swapchain/plugin overlay glue
```

Helm-specific code stays thin:

```text
/chart/{z}/{x}/{y}.png viewport math/cache/ETag/MapLibre composition/headless output
```

There should also be a pluggable chart-source/conversion boundary before rendering:

```text
source charts
  -> chart-source module       # S-57/SENC, raster, MBTiles, PMTiles, future S-101, etc.
  -> normalized chart objects / raster sheets / debug artifacts
  -> render command stream
  -> backend-specific GPU resources
```

That boundary is what lets multiple engines be swapped later: OpenCPN-derived S-52 today, a
clean-room GDAL/OGR pipeline later, or a Go/Rust/C++ conversion module if that language is better for
the job. The renderer core must consume explicit typed objects and metadata, not a hidden global
OpenCPN chart canvas state.

Everything below should be shared or deliberately excluded:

- S-52/S-57 rendering semantics;
- object ordering, display categories, SCAMIN, safety contours;
- tessellation for areas, shorelines, depth areas, and depth contours;
- line styles, patterns, symbols, text and soundings contracts;
- Vulkan buffers, shaders, texture atlases, batching;
- golden image regression fixtures.

## Module Feedback To Preserve

Sean Dpanger's feedback is a design constraint for the POC:

- Tile fetching should support overscan past the visible screen and smooth blending between zoom
  levels while zooming.
- The vector-to-render conversion should be discrete and inspectable so a future maintainer can
  replace or re-vibe one module without rewriting the whole plotter.
- Incorrect object placement, such as buoys inland or in wrong positions, must be debuggable from
  intermediate artifacts: source object id, chart cell, projection transform, generated geometry,
  and final screen/tile coordinates.
- Modules may be written in different languages if they interoperate through a stable file/process
  boundary.
- MBTiles is acceptable as an intermediate/debug interchange format, but it is not the efficient
  final render format.
- Raster charts eventually want GPU-ready compressed textures compiled for the machine doing the
  rendering.
- Vector charts eventually want GPU-ready vertex/index buffers, not repeated tile-image decode work.
- Quilting must remain explicit: one chart does not cover the world, raster charts may have useful
  visible information outside their formal chart boundary, and single-chart mode cannot be reduced
  blindly to tiled clipping.

The Vulkan renderer should therefore distinguish three cache layers:

```text
interchange/debug cache: MBTiles/PMTiles/GeoJSON/MVT-like artifacts
normalized scene cache: chart objects, quilt decisions, transforms, geometry provenance
GPU cache: compressed textures, vertex arrays, atlases, descriptor-ready resources
```

MapLibre can still consume `/chart/{z}/{x}/{y}.png` during the POC, but Helm should not pretend PNG
tiles are the final efficient renderer contract. They are the compatibility adapter.

## OpenCPN Branch Shape

The OpenCPN branch should be structured as an upstreamable feature branch, not as a Helm import
dump. Proposed logical modules:

```text
chart-render/
  include/
    render_scene.hpp          # backend-neutral command stream API
    render_view.hpp           # viewport, scale, palette, safety settings
    render_backend.hpp        # backend interface: submit(scene) -> target
  s52/
    s52_command_builder.*     # S-57/SENC + S-52 rules -> render scene
    s52_assets.*              # symbols, line styles, patterns, palettes
  vsg/
    vsg_backend.*             # VulkanSceneGraph implementation
    vsg_atlas.*
    vsg_offscreen_target.*
  sources/
    chart_source.*            # chart-source/conversion interface
    mbtiles_source.*          # optional intermediate/debug source, not final GPU contract
    raster_sheet_source.*     # raster chart collars/bounds/quilt metadata
  tests/
    fixtures/
    golden/
    provenance/
    render_regression.*

adapters/
  opencpn/
    chart_canvas_vulkan.*     # interactive OpenCPN viewport/swapchain adapter
  headless/
    offscreen_tile_renderer.* # reusable offscreen adapter Helm can call
```

The exact paths should be adjusted to OpenCPN maintainer preference, but the rule is firm:
the command stream and Vulkan backend must not depend on Helm, MapLibre, HTTP, or Helm cache policy.

## Helm Branch Shape

The Helm branch should consume a pinned OpenCPN fork commit and keep local code limited to adapter
and server integration:

```text
engine/vendor/OPENCPN_REF       # points to the OpenCPN Vulkan branch commit
engine/patches/*                # shrinks as work moves upstream
engine/vendor/cli/helm_server.cpp
engine/vendor/cli/helm_tiles.cpp
engine/test-engine.sh
```

Helm should not copy the renderer core. Helm should call the shared offscreen renderer from the
pinned OpenCPN source, then handle:

- slippy tile viewport math;
- overscan/prefetch beyond the visible viewport;
- zoom-level blending while zooming;
- tile-size framebuffer target;
- PNG readback and response;
- cache keys and `ETag`/`304`;
- MapLibre raster source composition;
- headless runtime diagnostics.

## When To Split A New Repo

Create a standalone renderer repo only after all are true:

1. OpenCPN and Helm both consume the same command stream and VSG backend.
2. Chart 1 and contour golden-image tests pass from the shared test runner.
3. The renderer core builds without OpenCPN GUI/wx canvas dependencies.
4. The adapter boundary is boring: OpenCPN has an interactive adapter, Helm has an offscreen adapter,
   and neither forks renderer semantics.
5. The chart-source/conversion boundary can emit inspectable provenance for wrong-location bugs.
6. There is a documented path from interchange caches to machine-local GPU caches.
7. OpenCPN maintainers agree the module wants separate release/versioning.

The later standalone shape would be:

```text
opencpn-chart-renderer/
  render-core/
  s52/
  vsg-backend/
  adapters/opencpn/
  adapters/headless/
  tests/golden-images/
```

Until then, branch first.

## First Working Sequence

1. Create/prepare an OpenCPN fork branch `vulkan/render-core-poc`.
2. Add the renderer seam design and a minimal command-stream fixture.
3. Bring up a tiny VulkanSceneGraph backend that renders deterministic pixels from the fixture.
4. Add a headless/offscreen target in the OpenCPN branch.
5. Create Helm branch `vulkan/consume-render-core`.
6. Pin Helm to the OpenCPN branch commit and route `/chart/{z}/{x}/{y}.png` through the offscreen
   adapter behind a feature flag.
7. Add golden-image tests shared by Chart 1 and contour fixtures.
8. Only then discuss extracting a standalone repo.

## Non-Goals For The POC

- Do not rewrite all OpenCPN charting at once.
- Do not make Helm own a private renderer fork.
- Do not move GPL-derived renderer code into web/mobile clients.
- Do not treat Vulkan as a visual-only swap; S-52 ordering, SCAMIN, display category, palette, and
  safety-contour behavior are the hard acceptance criteria.
