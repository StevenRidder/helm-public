# Vulkan S-52 Semantics Audit

Status: Vulkan board `SYM-1`

This audit identifies the OpenCPN S-52 behavior the shared Vulkan renderer POC
must preserve. It is an input to the symbol/atlas lane, the ordering and display
rule lane, the text/soundings contract, and the first real Chart 1 acceptance
fixtures.

## Scope

Reviewed sources:

- Helm seam docs: `VULKAN-RENDERER-SEAM.md`,
  `VULKAN-RENDER-COMMAND-STREAM.md`, `VULKAN-RENDER-ADAPTERS.md`, and
  `VULKAN-RENDER-FIXTURES.md`.
- Helm chart paths: `engine/vendor/cli/helm_server.cpp`,
  `engine/vendor/cli/helm_tiles.cpp`, `engine/patches/0001-*`,
  `engine/patches/0004-*`, and `engine/patches/0005-*`.
- Patched OpenCPN tree from the local bootstrap clone at `/tmp/helm-opencpn`,
  including `gui/src/s57chart.cpp`, `libs/s52plib/src/s52plib.cpp`,
  `libs/s52plib/src/s52plib.h`, `libs/s52plib/src/s52cnsy.cpp`,
  `libs/s52plib/src/chartsymbols.cpp`, and `data/s57data/*`.

No server was started and the live `:8080` instance was not touched.

## Main Finding

The Vulkan POC should reuse OpenCPN's S-52 semantic decision path, not rebuild it
inside Helm or the backend. The useful extraction point is after S-57/SENC
objects have been decoded, LUPs selected, conditional symbology evaluated, and
visibility/display-category checks applied, but before the DC/GL backend turns
rules into pixels.

The command builder should therefore translate OpenCPN's `ObjRazRules`, LUP
metadata, rule chains, display state, and provenance into `RenderScene`
commands. The Vulkan backend should render commands; it must not make S-52
visibility, safety-contour, SCAMIN, palette, or label-placement decisions on its
own.

## Semantic Source Map

| Behavior | OpenCPN source of truth | Vulkan POC treatment |
|---|---|---|
| Presentation assets | `data/s57data/chartsymbols.xml` and `S52RAZDS.RLE`; parsed by `libs/s52plib/src/chartsymbols.cpp` into colors, symbols, line styles, patterns, lookup records, and instruction strings. | Feed `SYM-2` atlas/resource generation. Preserve symbol names, anchors, pivots, HPGL/vector payloads, raster payloads, line styles, area patterns, and per-palette color tables by content hash. |
| S-57 object catalog | `data/s57data/s57objectclasses.csv`, `s57attributes.csv`, and `s57expectedinput.csv`. | Use for object-class coverage, provenance, query/debug labels, and fixture assertions. Do not treat this as styling by itself. |
| Object-to-LUP selection | `s57chart::BuildRAZFromSENCFile` chooses the LUP table from primitive plus symbol/boundary style, then calls `S52_LUPLookup`, `_LUP2rules`, and `_insertRules`. | The command builder should start from the selected LUP/rule chain, not redo object-class lookup independently. |
| Display priority and LUP type | `_insertRules` maps S-52 display priority to a 0-9 priority index and maps LUP type to simplified points, paper-chart points, lines, plain boundaries, or symbolized boundaries. | `command_groups[]` need explicit `s52_display_priority`, `lup_type`, source sequence, chart priority, and quilt rank. |
| Conditional symbology | `libs/s52plib/src/s52cnsy.cpp`, `RenderCS`, and `GetAndAddCSRules` generate dynamic rules and may mutate display category. | Treat conditional-symbology output as semantic input to commands. Do not approximate safety/danger procedures in adapter code. |
| Visibility and display category | `ObjectRenderCheckRules` and `ObjectRenderCheckCat` apply position, category, no-show, meta, sounding, SCAMIN, date, and conditional-symbolization checks. | Emit commands only for visible objects, but keep optional diagnostics for culled objects in audit/debug captures. |
| SCAMIN and overzoom | `ObjectRenderCheckCat` applies SCAMIN with exemptions for display base and group 1; Helm patches initialize `m_bUseSCAMIN=true`, `m_bUseSUPER_SCAMIN=false`, and fail closed on invalid native scale. | `DisplayState` must include SCAMIN policy and chart zoom modifier. `RenderView` must include display scale and overzoom diagnostics. |
| Safety contours and depths | Mariner params drive `DEPARE01`, `DEPCNT02`, `SOUNDG02/03`, underwater danger, obstruction, and wreck conditional symbology. | Preserve safety-depth, shallow/safety/deep contour, two-shade, depth unit, and source chart scale as explicit inputs. |
| Draw ordering | `s57chart` renders area fills first, then object/boundary/line/point passes by display priority, with a later text-only pass. Natural source order is preserved within a priority/LUP bucket. | `SYM-3` must reproduce this ordering before backend submission. Backend batching may optimize only within order-safe groups. |
| Text and soundings | `RenderTX`, `RenderTE`, `RenderT_All`, `RenderMPS`, `RenderSoundingSymbol`, text overlap lists, and sounding scale factors determine placement and glyph output. | `SYM-4` must make placement replayable: text/sounding commands need anchor, priority, collision box, declutter key, font metrics, sounding safety class, and provenance. |
| Palette | `SetPLIBColorScheme` selects S-52 color tables; Helm already switches day/dusk/night per tile and includes palette in ETags. | Palette is semantic display state and atlas input. It is not a raster post-process. |
| Quilting and coverage | Helm's tiler ranks cells by display scale, renders coarser to finer, and keys NODTA to transparent for composition. | Shared renderer must carry chart priority, quilt rank, no-data/collar/coverage policy, and provenance for seam debugging. |

## Display State Required By SYM

The current command-stream draft already includes several of these fields. SYM
work should ensure the full state that changes pixels is explicit:

- `palette`: day, dusk, night, and any OpenCPN color table alias.
- `display_category`: display base, standard, all/other, mariner standard.
- `symbol_style`: simplified or paper-chart point symbols.
- `boundary_style`: plain or symbolized area boundaries.
- `safety_depth_m`, `shallow_contour_m`, `safety_contour_m`,
  `deep_contour_m`, and `two_shade_depth`.
- `show_text`, `show_important_text_only`, `show_national_text`,
  `show_aton_text`, `show_light_descriptions`, and text declutter policy.
- `show_soundings` plus sounding scale/font state.
- `show_meta`, `show_quality_of_data`, and mariner no-show/object visibility
  list for mariner standard.
- `use_scamin`, `use_super_scamin`, `chart_zoom_modifier_vector`, display scale,
  native chart scale, and overzoom ratio.
- `depth_unit_display` and height/unit choices when they affect labels or
  conditional symbolization.
- Source epoch for presentation assets, chart cell edition/update, SENC/native
  scale, mariner parameters, and command schema version.

Headless defaults are load-bearing. Helm's patches fixed nondeterminism by
initializing render-decision flags and sounding scale that the GUI normally sets
from preferences. Vulkan code should not read these from ambient app globals.

## Display Category Rules To Preserve

OpenCPN does not treat display category as a simple tag filter:

- Display base shows only `DISPLAYBASE` objects.
- Standard shows `DISPLAYBASE` plus `STANDARD`.
- All/other shows `DISPLAYBASE`, `STANDARD`, and `OTHER`, with meta objects
  controlled separately.
- Mariner standard uses the `OBJL` visibility array, except objects moved to
  `DISPLAYBASE` by conditional symbology remain visible.
- `M_QUAL` is special-cased by the quality-of-data toggle.
- `SOUNDG` visibility is controlled by `show_soundings` rather than only by the
  category bucket.
- Conditional symbology can make category decisions mutable for objects such as
  `OBSTRN`, `WRECKS`, `DEPCNT`, and `UWTROC`.

Downstream implication: `SYM-3` should call or reproduce
`ObjectRenderCheckRules` semantics before command emission. A backend-side
category filter would be too late and would miss conditional-symbolization
category mutations.

## SCAMIN And Native Scale

The SCAMIN path is safety-critical:

- SCAMIN is ignored for display-base and group-1 objects even if a cell carries
  spurious SCAMIN values.
- `chart_scale` must be the real native compilation scale. Helm patches
  propagate DSPM/CSCL on the headless full-init path and fail closed when native
  scale is invalid.
- `m_bUseSCAMIN` should default on.
- `m_bUseSUPER_SCAMIN` should default off for headless work; enabling it can
  cull `DEPARE`, `DEPCNT`, and `SOUNDG` in ways that are dangerous unless
  deliberately tested.
- The chart zoom modifier can keep objects visible in a transition band with
  reduced symbol scale. If the POC defers that behavior, it should be an explicit
  diagnostic/known gap.
- Helm's overzoom header is advisory. It does not replace SCAMIN filtering; it
  warns that the view is beyond the native scale where SCAMIN/detail behavior may
  hide detail.

## Safety-Contour Semantics

Safety behavior is concentrated in conditional procedures, not just colors:

- `DEPARE01` chooses depth-area fills from shallow, safety, and deep contour
  mariner params, plus two-shade mode.
- `DEPCNT02` selects the safety contour. If the requested safety contour is not
  present, OpenCPN defaults to the next deeper contour and highlights that.
- `SOUNDG02/03` formats sounding values and chooses the safety-related sounding
  symbol/color from safety depth and display units.
- `OBSTRN`, `UWTROC`, and `WRECKS` use safety contour/depth context to decide
  isolated-danger presentation.

Downstream implication: `SYM-3` should emit already-resolved contour roles,
depth-area classes, danger classes, and safety classes from OpenCPN conditional
symbology. The VSG backend should not infer these from raw `DRVAL*` values.

## Ordering Contract For SYM-3

The command stream needs enough order keys to reproduce OpenCPN:

1. Chart/quilt order: chart priority and quilt rank.
2. S-52 display priority: 0 through 9.
3. LUP type: area boundaries, lines, simplified/paper points, text pass.
4. Source-natural order inside each priority/type bucket.
5. Conditional-symbolization child rules and multi-point sounding order.
6. Text/sounding pass order after base geometry when rendering labels.

Backend batching may merge commands only when these keys prove the merge is
order-safe. A golden command hash should change if any of these ordering inputs
change.

## Object-Class Coverage For The First POC Fixtures

Minimum object classes for real ENC captures:

- Group 1 and depth: `DEPARE`, `DEPCNT`, `SOUNDG`, `UNSARE`, `DRGARE`, `LNDARE`,
  `COALNE`, `M_COVR`, `M_QUAL`.
- Aids and lights: `BOY*`, `BCN*`, `TOPMAR`, `DAYMAR`, `LIGHTS`, `LITFLT`,
  `LITVES`, `FOGSIG`.
- Hazards and dangers: `OBSTRN`, `UWTROC`, `WRECKS`, `SBDARE`.
- Routes and traffic: `FAIRWY`, `DWRTPT`, `RECTRC`, `RCRTCL`, `TSS*`,
  `PRCARE`, `RESARE`, `CTNARE`.
- Human-readable labels: `OBJNAM`, `NOBJNM`, light descriptions, bridge/clearance
  labels, and depth labels.
- Raster/debug path: a chart collar/no-data raster fixture so NODTA/coverage
  handling stays testable.

The synthetic `chart-1` fixture already covers command types. The first real ENC
fixture should add real conditional symbology, display-category differences,
SCAMIN behavior, safety-contour selection, and palette changes.

## Inputs To Follow-On Tasks

`SYM-2` atlas pipeline:

- Build resources from OpenCPN presentation assets, not from hand-drawn
  replacements.
- Preserve names from rule tokens: `SY`, `LS`, `LC`, `AC`, `AP`, `TX`, `TE`,
  `MPS`, and conditional-symbolization output.
- Store symbol logical size, pivot, origin, anchor, HPGL/vector payload, raster
  payload, color table, line dash/style, area pattern transform, and content
  hash.
- Generate per-palette atlas entries or palette-indexed resources; do not tint a
  day atlas into night.

`SYM-3` ordering/category/SCAMIN/safety implementation:

- Use OpenCPN LUP/rule/conditional-symbolization decisions as the semantic
  source.
- Add command fields or diagnostics for display priority, LUP type, category,
  SCAMIN policy, safety class, contour role, native scale, and culled reason.
- Keep `use_super_scamin` explicit and default off unless a fixture proves the
  intended behavior.

`SYM-4` text and soundings contract:

- Treat text and soundings as first-class semantic commands, not backend
  annotations.
- Preserve font metrics, text scale, sounding scale, halo, anchor, collision
  rectangles, declutter keys, priority, safety class, and shaped text/glyph-run
  provenance.
- Pin at least one label-overlap fixture and one `SOUNDG` multi-point fixture.

`CHART-1` Chart 1 acceptance catalog:

- Include fixture cases for day/dusk/night, base/standard/all/mariner,
  safety-depth changes, two-shade changes, symbol-style and boundary-style
  changes, SCAMIN/overzoom, and show/hide text/soundings.
- Capture command hashes before pixel hashes so semantic drift is visible before
  backend drift.

## Open Risks

- Exact extraction strategy remains open: parse OpenCPN `Rules` into commands,
  instrument `Render*` calls, or add a new command-builder path beside the DC/GL
  renderers. Parsing rules gives the cleanest seam; instrumenting render calls may
  be faster but risks inheriting DC-specific artifacts.
- Mariner-standard object visibility needs a portable representation of
  OpenCPN's `OBJL` visibility list.
- Text layout will need deliberate ownership: OpenCPN's text overlap list is a
  semantic output for fixtures, but the final backend may want shaped glyph runs.
- Real ENC fixture captures must stay redistributable. Raw chart cells and SENC
  caches should remain outside Git; manifests can record source ids, edition
  metadata, and hashes.
- The POC should not claim clean-room status while it consumes OpenCPN
  presentation rules and conditional-symbolization code.

## Completion Criteria For SYM-1

This audit is enough to unblock implementation planning for `SYM-2`, `SYM-3`,
and `SYM-4` when the renderer POC owner accepts:

- the extraction point: after OpenCPN semantic decisions, before backend pixels;
- the required display-state additions;
- the ordering keys;
- the minimum object-class fixture set;
- the open risks above as explicit follow-up work rather than hidden scope.
