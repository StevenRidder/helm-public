# Vulkan Text And Sounding Placement Contract

`SYM-4` makes text placement explicit before the Vulkan POC tries to draw every
S-52 label. The deliverable is a C++ contract checker, not a font renderer: it
turns `draw_text` and `draw_sounding` command-stream records into deterministic
placement records, shared glyph-resource reservations, and diagnostics for work
that is intentionally deferred.

## Boundary

Owned here:

- label records for object names, light descriptions, and soundings;
- semantic visibility gates such as display category, SCAMIN, and safety-depth
  filtering when those decisions are already present in the command stream;
- deterministic ordering from the S-52 semantic `order_key`;
- a frame-owned glyph resource need compatible with the VSG resource plan;
- explicit diagnostics for culled labels and unsupported shaping.

Deferred:

- full text shaping, bidi, ligatures, fallback fonts, and glyph rasterization;
- a production declutter/collision solver;
- offscreen render targets, swapchain presentation, framebuffer comparison, and
  tile serving;
- recomputing S-52 conditional symbology from raw S-57 attributes.

## Input Contract

The command stream carries text as data. `draw_text` is used for object names,
light labels, and annotations. `draw_sounding` is used for depth soundings and
must provide `formatted_text`; adapters must not reformat sounding depths in the
backend.

Each text command may carry:

```text
command_id
type = draw_text | draw_sounding
text | formatted_text
font_ref
position = [x, y]
s52_semantics.object_class
s52_semantics.visible
s52_semantics.safety_class
s52_semantics.order_key
placement.label_kind
placement.priority
placement.collision_policy
placement.visible
placement.cull_reason
placement.requires_shaping
placement.defer_reason
```

`font_ref` must resolve through `resource_table.fonts[]`. The contract emits one
`glyphs:<font_ref>` resource key per font, owned by the frame. VSG can map that
key to a dynamic text atlas or another glyph cache without changing S-52
semantics.

## Output Contract

The C++ checker emits `vulkan.text_placement_contract.v0`:

- `placements[]`: one accepted label, sounding, or light-label record;
- `resource_needs[]`: frame-owned glyph/text reservations grouped by font;
- `diagnostics[]`: structured reasons for culled or deferred text.

Placement records include the command id, label kind, text, object class,
font/resource key, anchor, priority, rotation, S-52 order key, collision policy,
safety class, and reservation estimates. The fixture uses one placeholder quad
per placed label (`4` vertices, `6` indices) plus a glyph count estimate. Later
glyph expansion may subdivide that geometry, but it must preserve the same
semantic record and ordering.

## Smoke Fixture

`engine/test/fixtures/vulkan-render/text-placement/scene.commands.json` covers:

- a normal chart object label;
- a shoal-class sounding;
- a light description label;
- a SCAMIN-hidden label that is culled with a diagnostic;
- a text command deferred because full shaping is out of scope.

Run:

```bash
scripts/vulkan-text-placement \
  engine/test/fixtures/vulkan-render/text-placement/scene.commands.json

scripts/vulkan-text-placement \
  engine/test/fixtures/vulkan-render/text-placement/scene.commands.json \
  --json
```

The `--json` output is deterministic and is checked against
`expected-placement.json`.
