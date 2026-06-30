# VulkanSceneGraph Resource Ownership

Status: Vulkan board `VSG-4`

This note defines the first CPU-side resource and batching contract for the VSG
backend. It is intentionally not an offscreen renderer. It plans the resources
and draw batches that VSG-2, VSG-3, and later renderer integrations can consume
when they own an actual device, framebuffer, swapchain, or readback path.

Runtime implementation is C++17-compatible C++ only.

## Ownership Boundary

VSG-4 owns:

- command grouping into deterministic draw batches;
- shader/material keys;
- atlas/resource references for symbols, patterns, line styles, fonts, and
  raster textures;
- buffer reservations for vertices, indices, instances, and per-draw uniforms;
- diagnostics for missing resources or unsupported command types.

VSG-4 does not own:

- Vulkan/VSG device lifecycle;
- offscreen framebuffer setup;
- window/swapchain setup;
- image readback;
- PNG or tile handoff;
- final GPU cache persistence.

The intended seam is:

```cpp
RenderResourcePlan plan = BuildResourcePlanFromSceneJson(scene_json);
```

VSG-2 can consume the plan later, but VSG-4 does not call into VSG-2.

## Batch Key

The current `BatchKey` is:

```text
shader_family
topology
atlas_id
material_id
blend_mode
order_bucket
```

`order_bucket` is derived from command-group order plus a coarse pass rank:
area fills, pattern fills, line styles, symbols, text placeholders, then raster
sheets. Commands inside a batch keep their source order. Only contiguous
compatible commands are folded into one batch; a later matching command is not
pulled ahead of an intervening draw with a different key.

Current shader families:

- `AreaFill`
- `PatternFill`
- `LineStyle`
- `SymbolInstanced`
- `TextPlaceholder`
- `RasterSheet`

These names are material contracts, not final shader source names.

## Resource Model

The resource planner reads `resource_table` from the command stream and records
unique `AtlasRegion` descriptors as commands reference them.

Supported resource arrays:

- `symbols[]` -> symbol atlas entries
- `area_patterns[]` -> repeatable pattern atlas entries
- `line_styles[]` -> line-style atlas entries
- `fonts[]` -> dynamic text/font atlas placeholders
- `raster_textures[]` -> raster texture descriptors

Missing resources produce `resource.missing` diagnostics and the affected
command is skipped from the resource plan. This keeps planning fail-loud without
letting a backend crash while dereferencing an absent atlas record.

## Buffer Reservations

Each planned batch records:

```text
owner
vertices
indices
instances
uniforms
```

Ownership labels are explicit:

- `atlas-owned`: compiled texture/atlas regions;
- `frame-owned`: per-frame instances, text placeholders, and dynamic uniforms;
- `command-stream-owned`: geometry derived directly from command-stream rings
  or polylines;
- `backend-owned`: backend lifecycle resources such as future raster sheet
  bindings.

Reservations are counts, not allocations. Later VSG code can translate them into
VSG arrays, descriptor sets, staging buffers, and draw commands.

## Fixture Evidence

The fixture lives at:

```text
engine/test/fixtures/vulkan-render/vsg-resource-plan/scene.commands.json
```

It proves:

- solid area fill planning;
- pattern fill atlas references;
- line-style atlas references;
- repeated point symbols collapsed into one instanced symbol batch;
- dynamic text and sounding placeholders sharing a font batch;
- missing atlas references reported as diagnostics.

Run:

```bash
scripts/vulkan-resource-plan \
  engine/test/fixtures/vulkan-render/vsg-resource-plan/scene.commands.json
```

Use `--json` to print the deterministic plan. Use `--smoke` to enforce the
fixture-specific assertions used by this POC, while a default run performs
generic structural validation suitable for any command stream.

## Deferred

This slice does not implement actual VSG draw graph creation, shader source,
glyph shaping, text placement, offscreen rendering, swapchain rendering,
machine-local GPU cache persistence, or Chart 1 visual acceptance. Those remain
owned by downstream VSG, SYM, and chart-acceptance tasks.
