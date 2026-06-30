# Vulkan Renderer Seam

Status: POC seam contract for Vulkan board `SEAM-1`

This document defines the ownership boundary for the shared Vulkan renderer POC.
It is intentionally narrower than repository layout. The repo/lane decision is
paused elsewhere; the seam decision here is the contract both OpenCPN and Helm
can build toward without turning the renderer into a Helm-only fork.

## Goal

Build one renderer core that can serve two adapters:

- OpenCPN: interactive chart canvas, wx event loop, swapchain, plugin overlays,
  and desktop viewport behavior.
- Helm: headless/offscreen tile rendering behind `/chart/{z}/{x}/{y}.png`,
  MapLibre composition, HTTP caching, and boat-server diagnostics.

The shared core owns rendering semantics. Each app owns its integration shell.

## POC Working Posture

During the POC, keep the shared renderer upstream-shaped:

- OpenCPN fork branch `vulkan/render-core-poc` owns shared render semantics,
  command-stream construction, VulkanSceneGraph backend behavior, and the
  interactive OpenCPN adapter.
- Helm branch `vulkan/consume-render-core` consumes a pinned OpenCPN commit and
  owns only the headless/offscreen tile adapter plus `/chart` integration.
- Standalone repository extraction is intentionally deferred until both adapters
  use the same renderer core and golden-image tests prove the shared behavior.

Those branch names are coordination anchors, not permission for Helm to copy the
renderer core or for the renderer core to depend on Helm.

## Standalone Repository Extraction Gate

A future `opencpn-chart-renderer` repository becomes appropriate only after all
of these gates are satisfied with linked evidence:

- Both the OpenCPN interactive adapter and Helm headless tile adapter consume the
  same renderer core and the same render command stream. Helm may wrap the core
  for HTTP tiles, but it must not carry a copied or forked renderer semantics
  path.
- The Chart 1 fixture and contour/depth golden regression tests pass against
  that shared command stream, with stable command-stream hashes, pixel hashes,
  and source/provenance ids available for failure reports.
- The renderer core builds as a C++/CMake, OpenCPN-native library or target
  without hidden wx canvas, wx event-loop, GUI swapchain, plugin-global, Helm
  HTTP, MapLibre, or web-client dependencies. Host-specific wiring stays in the
  adapters.
- OpenCPN maintainers and the Helm architecture owner agree that separate
  versioning and release cadence would reduce review and integration burden
  compared with keeping the renderer POC in the OpenCPN tree.
- The GPL/upstream contribution boundary is documented for the extracted shape,
  including provenance for OpenCPN-derived code and the arm's-length
  boat-server/client boundary Helm relies on.

Until every gate is satisfied, `vulkan/render-core-poc` remains the canonical
home for shared renderer semantics, and Helm consumes it through a pinned
adapter integration instead of becoming the renderer's source of truth.

## Shared Core

The shared renderer core owns:

- chart object normalization for the renderer input model;
- S-52 display rules, object ordering, display categories, SCAMIN, safety
  contours, palettes, symbols, line styles, patterns, text, and soundings;
- render command stream construction from normalized chart/raster objects;
- VulkanSceneGraph backend behavior, shaders, buffers, texture atlases,
  batching, and offscreen/onscreen render target abstractions;
- quilt decisions that affect visual correctness, including cell priority,
  scale-band selection, no-data behavior, chart collars, coverage metadata, and
  provenance for boundary cases;
- regression fixtures and golden-image tests that prove shared rendering
  behavior independently of either adapter.

The shared core must not depend on:

- Helm HTTP routes, MapLibre source configuration, ETag policy, or web-client
  state;
- OpenCPN wx canvas classes, plugin manager globals, toolbar state, or live
  swapchain ownership;
- a hidden global chart canvas as the only place where projection, scale, or
  display settings can be inspected.

## Source And Conversion Boundary

The renderer receives explicit, typed input. The conversion step is discrete and
inspectable so chart-source engines can be replaced later.

Sean Dpanger's feedback is a POC constraint: conversion and rendering must be
modular enough that future maintainers can replace one source/conversion engine
without rewriting the whole plotter. Intermediate artifacts should make
wrong-location bugs debuggable rather than hiding them in a single opaque
renderer.

Accepted source families for the POC boundary:

- S-57/SENC vector charts through the OpenCPN-derived path;
- raster chart sheets with collar, bounds, georeference, and coverage metadata;
- debug/interchange artifacts such as MBTiles, PMTiles, GeoJSON, or MVT-like
  dumps;
- future S-101 or clean-room conversion modules, provided they emit the same
  normalized scene objects and provenance.

The boundary must preserve enough provenance to debug wrong-location bugs:

- source chart id and edition/update metadata;
- source object id and object class;
- source geometry before projection;
- projection transform and scale/display settings;
- generated tessellation or label candidate data;
- final tile/screen coordinates and contributing quilt decision.

MBTiles can be useful as an interchange or debug cache. It is not the final hot
path contract. The efficient path should allow machine-local GPU resources:
compressed raster textures for raster charts, and vertex/index buffers plus
atlases for vector charts.

## Render Command Stream

The command stream is the seam between chart semantics and backend execution.
`SEAM-2` owns the exact schema, but `SEAM-1` fixes these constraints:

- commands describe what to draw, not where an app stores it;
- commands include stable ids back to source/provenance records;
- commands carry palette, display category, safety-contour, SCAMIN, overzoom,
  label, and text/sounding decisions as explicit data;
- commands can target onscreen and offscreen render targets;
- command ordering is deterministic and regression-testable;
- no command may require Helm HTTP context or OpenCPN UI state to be valid.

## OpenCPN Adapter Ownership

OpenCPN owns the interactive desktop integration:

- wx event-loop integration and invalidation;
- chart canvas and viewport event handling;
- swapchain/window surface creation and resize behavior;
- mouse/keyboard interaction, cursor feedback, chart bar, and native desktop UI;
- plugin overlay composition and compatibility boundaries;
- any OpenCPN-specific chart database discovery or user preference wiring;
- upstream maintainer-facing build system shape and coding conventions.

OpenCPN may call the shared renderer core, but it should not make the core depend
on wx canvas classes or plugin globals. Adapter state must be translated into the
shared render view/scene inputs.

## Helm Adapter Ownership

Helm owns the headless boat-server integration:

- slippy tile viewport math for `{z}/{x}/{y}`;
- offscreen framebuffer target sizing and PNG readback;
- `/chart/{z}/{x}/{y}.png`, `/catalog`, `/health`, diagnostics, and failure
  codes;
- cache keys, ETag/304 behavior, immutable tile caching, and runtime status;
- MapLibre raster source composition and depth-on-satellite layering;
- private/offline runtime paths and bring-your-own-chart data policy;
- tile scheduler behavior, including overscan, prefetch, and zoom-level blending
  for the web client.

Helm should consume the shared renderer through a thin offscreen adapter. It
must not copy renderer semantics into Helm-only C++ or web code.

## Quilting And Tile Scheduling

The POC must keep quilting explicit. One chart does not cover the world, and
different chart types carry different boundary semantics.

Shared core responsibilities:

- choose and record visual quilt decisions that affect correctness;
- keep no-data/collar/coverage rules inspectable;
- expose enough metadata for golden-image tests and bug reports.

Adapter responsibilities:

- OpenCPN decides how those shared decisions are presented in an interactive
  canvas.
- Helm decides how to schedule tiles, overscan outside the viewport, prefetch
  adjacent zoom bands, and blend while MapLibre zooms.

Raster charts deserve special care: useful visible information can exist outside
formal chart bounds, collars may need removal or retention depending on source,
and single-chart mode cannot blindly clip every pixel to a tile boundary.

## License And Upstream Boundary

OpenCPN-derived chart semantics and renderer code remain GPL-compatible and
boat-server/client-separated in Helm. The shared core can be upstream-shaped in
the OpenCPN fork during the POC, but Helm clients must continue to talk through
HTTP/WebSocket or another arm's-length protocol boundary.

Do not move GPL-derived renderer code into web/mobile clients. Do not present the
Vulkan POC as a clean-room renderer unless the OpenCPN-derived conversion and
semantic code has been replaced and reviewed separately.

The detailed contribution and distribution boundary is recorded in
[VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md).

## Deferred Decisions

This document does not decide:

- exact filesystem layout or standalone repository timing; this document defines
  the extraction gate, but extraction timing stays deferred until the gate is
  satisfied;
- the command-stream schema fields; that is `SEAM-2` and is drafted in
  [VULKAN-RENDER-COMMAND-STREAM.md](VULKAN-RENDER-COMMAND-STREAM.md);
- the detailed adapter APIs for OpenCPN and Helm; that is `SEAM-3` and is
  drafted in [VULKAN-RENDER-ADAPTERS.md](VULKAN-RENDER-ADAPTERS.md);
- fixture corpus and image-regression harness details; that is `SEAM-4` and is
  drafted in [VULKAN-RENDER-FIXTURES.md](VULKAN-RENDER-FIXTURES.md);
- commercial relicensing or App Store posture.

## Acceptance Checklist

`SEAM-1` is satisfied when future work can answer these without ambiguity:

- Is this renderer behavior shared, OpenCPN-specific, or Helm-specific?
- Can the render command stream be built without reading Helm HTTP state or
  OpenCPN canvas globals?
- Can a wrong buoy, seam, collar, or label be traced from final pixels back to a
  source chart/object and transform?
- Can Helm remain a thin headless adapter while OpenCPN remains the interactive
  upstream-shaped adapter?
- Are MBTiles/PMTiles treated as interchange/debug caches rather than the final
  GPU-hot-path contract?
- Does a proposed standalone repository satisfy the extraction gate, including
  dual-adapter command-stream consumption, Chart 1 and contour/depth golden
  regressions, a GUI-free core build, maintainer agreement, and a documented
  GPL/upstream boundary?
