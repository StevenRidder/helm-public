# Vulkan Render Command Stream

Status: stacked POC draft for Vulkan board `SEAM-2`

This document specifies the backend-neutral command stream between chart
semantics and renderer execution. It builds on
[VULKAN-RENDERER-SEAM.md](VULKAN-RENDERER-SEAM.md): conversion and S-52
decisions are shared; OpenCPN and Helm adapters only choose targets, scheduling,
and integration policy.

The stream is a data contract, not an API signature. The first implementation
can be C++ structs, JSON fixtures, or a compact binary form, but all forms must
preserve the same semantics and provenance.

## Design Goals

- make S-52 rendering decisions explicit before backend submission;
- keep command replay deterministic across OpenCPN onscreen and Helm offscreen
  adapters;
- allow golden-image tests to diff command streams before diffing pixels;
- keep source/conversion modules replaceable;
- preserve enough provenance to debug misplaced objects, wrong labels, collar
  artifacts, quilt seams, and overzoom behavior;
- let the backend choose efficient GPU resources without leaking Vulkan details
  into chart semantics.

## Non-Goals

- no Helm HTTP, MapLibre, cache, or ETag fields;
- no OpenCPN wx canvas, toolbar, plugin manager, or swapchain globals;
- no final standalone repository layout decision;
- no promise that MBTiles/PMTiles/GeoJSON/MVT debug artifacts are the final hot
  path format;
- no attempt to restate the full S-52 standard in this doc.

## Stream Envelope

Every render submission is a `RenderScene`:

```text
RenderScene
  schema_version
  scene_id
  source_epoch
  render_view
  display_state
  resource_table
  command_groups[]
  provenance_table
  diagnostics
```

Required invariants:

- `schema_version` changes whenever command meaning changes.
- `scene_id` is stable for a deterministic view/source/display tuple.
- `source_epoch` identifies chart database inputs, updates, and renderer
  settings that invalidate cached command streams.
- `command_groups` are already sorted into deterministic draw order.
- `provenance_table` is addressable from every command.

## Render View

`RenderView` describes the target-independent view:

```text
RenderView
  projection
  geographic_bbox
  center
  scale_denom
  rotation_deg
  pixel_size
  device_pixel_ratio
  overzoom
  overscan_px
```

Notes:

- `projection` must be explicit, for example Web Mercator tile, OpenCPN
  Mercator canvas, or future globe segment.
- `scale_denom` is the chart display scale used for SCAMIN, scale-band, and
  symbolization decisions.
- `pixel_size` is the logical target size. Helm may choose tile-sized offscreen
  targets; OpenCPN may choose window-sized swapchain targets.
- `overscan_px` lets Helm and OpenCPN request extra geometry for smooth pan/zoom
  without changing command semantics.
- `overzoom` must record when the view is beyond source/native chart scale.

## Display State

`DisplayState` captures S-52 and chart display knobs that affect output:

```text
DisplayState
  palette              # day, dusk, night, etc.
  display_category     # base, standard, all, mariner
  symbol_style         # simplified or paper_chart point symbols
  boundary_style       # plain or symbolized area boundaries
  safety_depth_m
  shallow_contour_m
  safety_contour_m
  deep_contour_m
  show_text
  show_important_text_only
  show_national_text
  show_aton_text
  show_light_descriptions
  show_soundings
  show_lights
  show_meta
  show_quality_of_data
  simplified_symbols
  two_shade_depth
  use_scamin
  use_super_scamin
  chart_zoom_modifier_vector
  language
  units
```

If a field changes pixels, it belongs in `DisplayState` or a command-specific
override. If it only changes adapter scheduling or network behavior, it does not.

SCAMIN defaults are semantic inputs, not backend policy: `use_scamin` is on for
normal S-52 output, `use_super_scamin` is off unless a fixture explicitly covers
it, and `chart_zoom_modifier_vector` records any transition-band behavior used
by the command builder.

## Resource Table

The stream references resources by stable ids:

```text
ResourceTable
  symbols[]
  line_styles[]
  area_patterns[]
  fonts[]
  raster_textures[]
  geometry_buffers[]
  palettes[]
```

Resource records include:

- `resource_id`;
- content hash or source epoch;
- source/provenance ids;
- logical size and anchor metrics;
- backend hints, such as atlas eligibility or preferred GPU upload class.

The backend may compile resources into Vulkan textures, buffers, atlases, or
descriptor-ready objects. That compiled cache is not the command stream itself.

## Command Groups

Commands are grouped by deterministic layer:

```text
CommandGroup
  group_id
  chart_priority
  s52_layer
  quilt_rank
  commands[]
```

`chart_priority` and `quilt_rank` make multi-chart composition inspectable.
OpenCPN and Helm may render different target sizes, but the same group ordering
must produce the same visual semantics.

Commands that come from S-52/S-57 features carry a stable semantic envelope:

```text
s52_semantics
  source_object_id
  object_class
  display_category
  display_priority
  lup_type
  render_pass
  source_sequence
  native_scale
  scamin_max_scale
  safety_class | contour_role | danger_class
  order_key[]
```

`order_key[]` is the already-resolved deterministic ordering tuple. Its current
fixture form is `[chart_priority, quilt_rank, display_priority, render_pass_rank,
source_sequence]`; later implementations may add child-rule or text-pass fields
as long as the schema version changes. The backend may batch commands only when
the semantic order remains equivalent.

Visible commands are the normal output. Culled S-52 objects do not become
backend commands, but debug fixtures may record a `semantic.culled` diagnostic
with `source_object_id`, `reason`, and relevant scale/category metadata so
category, SCAMIN, and mariner-visibility decisions can be tested without making
the backend re-run S-52 rules.

## Coordinate Spaces

Commands may carry coordinates in these spaces:

- geographic: WGS84 lon/lat source geometry;
- projected: projection-space meters or chart-native projected coordinates;
- target: logical pixels in the render target;
- glyph: font/layout local units;
- raster: source image pixels.

Every command must state its coordinate space. Converters may include multiple
coordinate forms when that helps provenance, but the backend consumes the
declared render geometry.

## Command Types

### `fill_area`

Used for depth areas, land, dredged areas, restricted areas, and other polygon
fills.

```text
fill_area
  command_id
  geometry_ref | rings
  fill
  pattern_ref
  opacity
  clip_ref
  provenance_refs[]
```

Rules:

- ring winding and hole semantics must be normalized before command emission;
- pattern scale and rotation are explicit;
- no-data and collar handling must appear as either clip metadata or provenance.

### `stroke_line`

Used for coastlines, contours, boundaries, routes inside fixtures, and line
features.

```text
stroke_line
  command_id
  geometry_ref | polyline
  stroke
  line_style_ref
  width_px
  join
  cap
  dash_phase
  symbol_spacing
  provenance_refs[]
```

Depth contours are `stroke_line` commands with `role=depth_contour` metadata and
contour value in meters.

### `place_symbol`

Used for buoys, beacons, lights, rocks, wrecks, AIS-like test fixtures, and
point symbols.

```text
place_symbol
  command_id
  symbol_ref
  position
  anchor
  rotation_deg
  scale
  declutter_key
  priority
  provenance_refs[]
```

Symbol placement must be replayable: decluttering inputs and decisions need
stable keys, not hidden frame-local state.

### `draw_text`

Used for object names, light descriptions, labels, and annotation text.

```text
draw_text
  command_id
  text
  text_run_refs[]
  position
  anchor
  rotation_deg
  font_ref
  halo
  priority
  collision_box
  provenance_refs[]
```

Text commands may reference shaped glyph runs once the backend needs them. The
initial fixture form can carry UTF-8 text plus font metrics, but golden tests
must lock the resulting placement.

### `draw_sounding`

Used for depth sounding labels.

```text
draw_sounding
  command_id
  depth_m
  formatted_text
  position
  font_ref
  priority
  safety_class
  provenance_refs[]
```

`formatted_text` is explicit so adapters do not reimplement sounding formatting.
`depth_m` remains available for debug and safety classification.

### `draw_raster_sheet`

Used for raster chart sheets and debug/interchange layers.

```text
draw_raster_sheet
  command_id
  texture_ref
  source_quad
  target_quad
  opacity
  collar_policy
  coverage_policy
  provenance_refs[]
```

Raster commands must record collar and coverage policy. Useful raster
information can exist outside formal chart bounds; clipping must be a conscious
choice, not an accidental tile crop.

### `push_clip` / `pop_clip`

Used only when a group or command needs explicit clipping:

```text
push_clip
  clip_id
  geometry_ref | rect
  reason
  provenance_refs[]

pop_clip
  clip_id
```

Clips are part of visual semantics and must be visible in command diffs.

## Provenance Table

Every command references one or more provenance records:

```text
ProvenanceRecord
  provenance_id
  source_chart_id
  source_chart_edition
  source_update
  source_object_id
  source_object_class
  source_geometry_hash
  conversion_stage
  transform_chain
  quilt_decision_id
  warnings[]
```

Wrong-location debugging requires at least:

- original source object id;
- chart/cell id and update;
- source geometry hash;
- projection transform chain;
- generated render geometry id;
- final target coordinate bounds.

## Diagnostics

Diagnostics are structured records, not log text:

```text
Diagnostic
  severity
  code
  message
  provenance_refs[]
  suggested_action
```

Examples:

- `overzoom.native_scale_exceeded`;
- `semantic.culled`;
- `source.unsupported_object_class`;
- `quilt.coverage_gap`;
- `text.decluttered`;
- `raster.collar_retained`;
- `resource.missing_symbol_fallback`.

## Determinism Rules

- Sort commands by explicit group order, chart priority, S-52 layer, object
  priority, source id, and command id.
- Randomness is forbidden. Any sampling must use deterministic seeds in the
  scene envelope.
- Floating point tolerances for golden tests must be documented per command
  family.
- Text placement and decluttering decisions must be emitted, not recomputed
  differently by each adapter.
- Backend resource packing must not change command semantics.

## Fixture Form

The first fixture should be a small text-serializable scene:

```text
fixtures/
  chart-1/
    source.json
    scene.commands.json
    provenance.json
    expected.png
```

The fixture must include at least:

- one filled depth area;
- one depth contour;
- one point symbol;
- one text label;
- one sounding;
- one raster-sheet or no-data/coverage clip example.

This is enough for OpenCPN and Helm to prove they consume the same command
stream before attempting full S-52 coverage.

The initial committed fixture corpus and checker live under
`engine/test/fixtures/vulkan-render/` and
`engine/vendor/cli/helm_vulkan_fixture_check.cpp`; see
[VULKAN-RENDER-FIXTURES.md](VULKAN-RENDER-FIXTURES.md).

## Open Questions For Implementation

- whether the C++ in-memory form should mirror the fixture JSON exactly or use
  a compact typed struct layer with a JSON exporter;
- whether glyph shaping belongs in command construction or backend resource
  preparation;
- how much S-52 conditional-symbology reasoning should be captured in
  provenance records;
- the binary cache format for compiled GPU resources;
- the minimum fixture corpus needed before a standalone renderer repository is
  worth discussing.
