# Vulkan Icon Forge — Presentation Asset Pack generator

Status: Vulkan board `FORGE-1` (lane open; tasks `FORGE-1`..`FORGE-11`)

This lane plans an LLM-driven program that **generates** the S-52/S-57 symbol
library as owned, multi-style SVG artwork — the **Presentation Asset Pack** that
feeds the `SYM-2` atlas pipeline. It is the "draw all the Chart No.1 icons"
work, reframed: not hand-tracing on Fiverr, and not extracting OpenCPN's
GPL raster symbols, but a regenerable pipeline that re-draws a fixed,
safety-critical catalog with style varied only on the non-semantic axis.

## TL;DR — the reframe

A chart symbol's **meaning is load-bearing**: a green starboard buoy drawn red
is a navigation hazard, not a style miss. So every symbol splits into two axes:

- **Invariant (semantic) — never varies, machine-checked:** lateral/cardinal
  colour, topmark shape, light-flare presence, distinguishing geometry, and the
  anchor/pivot. Sourced from the catalog; *checked*, never invented.
- **Free (aesthetic) — what "style" means:** stroke weight, corner rounding,
  fill vs. line, engraving/hand-drawn treatment, the house look. This is where
  "open-bridge feel" vs. "US paper-chart feel" lives.

A human holds both axes in their head and hopes. The program makes the
invariants machine-checked and the aesthetics a parameter. That is the edge —
and the verifier, not the generator, is the centre of gravity.

## Where it sits on the board

```text
U.S. Chart No.1 (public domain)            chartsymbols.xml (S-52, reference only)
        │                                          │
        └──────────────┬───────────────────────────┘
                       ▼
            FORGE — Presentation Asset Pack          ← THIS LANE
            (catalog spec + multi-style SVG)
                       │
                       ▼
            SYM-2 — atlas pipeline (pack → manifest)
                       │
                       ▼
            SYM-3 ordering · SYM-4 text/soundings · CHART-1 acceptance
```

The Presentation Asset Pack is a **first-class, versioned input to the
Presentation Compiler**, parallel to the portable chart package — it is neither
chart truth (not about any cell) nor GPU cache (the SVG definitions are durable).
It is the style sheet. `SYM-2` packs it; this lane produces it.

## Owns (collision boundary)

```text
pipeline/iconforge/forge/*.py            # the program
pipeline/iconforge/catalog/**            # SymbolSpec JSON + reference crops (durable, reviewed)
pipeline/iconforge/stylepacks/**         # design-token packs (durable, reviewed)
pipeline/iconforge/{primitives,generated,atlas,.cache}/**   # regenerable artifacts
```

Touches shared (coordinate): the atlas-manifest contract owned by
`engine/vendor/cli/helm_s52_atlas.*` (`SYM-2`). `FORGE-9` adds a `style` axis to
the existing `(name, kind, palette)` key; it does not change the loader's
semantics.

## Data model

Three durable schemas (see `docs/VULKAN-S52-ATLAS-PIPELINE.md` for the manifest
they ultimately feed):

- **SymbolSpec** — `id`, `s52_token`, `name`, `category`, plain-language
  `meaning`, `Invariants{ colors[], topmark, light_flare, shape_class,
  distinguishing, anchor }`, `reference_image`, `siblings[]` (3 nearest cousins).
- **StylePack** — `id`, `stroke_width`, `corner_radius`, `fill_mode`,
  `line_treatment`, `shadow`, `palettes{ day|dusk|night → {colour → hex} }`.
- **GeneratedSymbol** — keyed `(catalog_id, style, palette)`; carries the SVG
  (colours as CSS variables, so palettes are pure substitution), `anchor`,
  `Verdict`, and `Provenance`.

The key `(catalog_id, style, palette)` is the existing `helm_s52_atlas`
`(name, kind, palette)` plus a `style` axis. One SVG → three palette renders;
palettes cost no extra generation.

## Pipeline — code-orchestrated, not an agent

A deterministic workflow (loops/conditionals we control) with Claude as the
generation/verification primitive. Model: `claude-opus-4-8` (vision-capable) for
both composition and the judge; structured outputs for every typed result;
prompt caching on the per-style stable prefix; the Batch API (50%) for the bulk
run.

1. **Catalog build** — U.S. Chart No.1 crop + S-52 metadata → `SymbolSpec` via
   vision-assisted extraction (structured output), then human review.
2. **Primitive generation** — per style, generate the shared SVG building blocks
   (buoy stick, topmark cones, light flare, beacon body). Everything composes
   from these, so the set reads as one family — the coherence trick.
3. **Symbol composition** — per `(symbol, style)`, compose SVG from primitives +
   invariants. The catalog entry + style pack + primitives are a cached stable
   prefix; only the per-symbol suffix varies.
4. **Render** — SVG → PNG via `resvg` (deterministic). Palette substitution
   here: one SVG, three rasters (day/dusk/night).
5. **Verify** — three checks, cheapest first:
   - *structural* (deterministic, no LLM): required palette vars present, anchor
     defined & in-bounds, viewBox sane, renders cleanly, pivot matches S-52.
   - *vision judge*: render + reference + per-symbol checklist → typed
     per-criterion pass/fail.
   - *sibling discrimination*: forced choice over the candidate + 3 cousins —
     catches subtle-but-dangerous confusions a "does it look like a buoy?" check
     passes.
6. **Repair loop** — bounded (≈3 attempts); failing criteria become the next
   compose() feedback. After N, route to a human "hard pile" queue — **logged,
   never silently dropped**.
7. **Atlas compile** — pack verified PNGs into per-style/per-palette sheets and
   emit a manifest in the exact shape `helm_s52_atlas` already loads.

## Tasks

- [ ] ⚪ **FORGE-1** — Presentation Asset Pack schemas (`SymbolSpec`,
  `StylePack`, `GeneratedSymbol`) + the `(catalog_id, style, palette)` contract
  and its mapping onto the `SYM-2` manifest ⛔ *(foundational)*
- [ ] ⚪ **FORGE-2** — Catalog ingestion: U.S. Chart No.1 + `chartsymbols.xml` →
  `SymbolSpec` via vision-assisted extraction + human review  ↳ FORGE-1
- [ ] ⚪ **FORGE-3** — Style packs + primitive generation (per-style shared SVG
  building blocks; the coherence mechanism)  ↳ FORGE-1
- [ ] ⚪ **FORGE-4** — Symbol composition (Claude → SVG from primitives +
  invariants; prompt-cached prefix; Batch API for bulk)  ↳ FORGE-2, FORGE-3
- [ ] ⚪ **FORGE-5** — Deterministic render (`resvg`; CSS-var palette
  substitution for day/dusk/night)  ↳ FORGE-4
- [ ] ⚪ **FORGE-6** — Verification harness: structural + vision judge + sibling
  discrimination (the QA core; typed verdicts) ⛔  ↳ FORGE-5
- [ ] ⚪ **FORGE-7** — Bounded repair loop + human hard-pile queue (feedback-fed
  regeneration; no silent caps)  ↳ FORGE-6
- [ ] ⚪ **FORGE-8** — Provenance + content-addressed incremental cache (audit
  trail; reproducible rebuilds; only changed inputs regenerate)  ↳ FORGE-4
- [ ] ⚪ **FORGE-9** — Atlas compile → `helm_s52_atlas` manifest with the added
  `style` axis  ↳ FORGE-7 · SYM-2
- [ ] ⚪ **FORGE-10** — Clean-IP / licensing: own-artwork-from-public-domain
  provenance, GPL-boundary placement, IP-counsel note *(gated on counsel)*
- [ ] ⚪ **FORGE-11** — Multi-style sweep + cost/throughput proof (the
  marginal-cost-of-style-N economics)  ↳ FORGE-9

## Next step — keep it tiny (the `FORGE` proof)

Mirror the board's "intentionally tiny proof" discipline. A vertical slice over
**~5 symbols × 2 styles** that exercises every stage:

```text
5 SymbolSpec (2 buoys, 1 beacon+topmark, 1 area pattern, 1 conditional danger)
  └── 2 style packs (open-bridge, us-paper)
        └── primitives → compose → render → verify → repair
              └── day/dusk/night renders + atlas manifest
                    └── one deliberately-broken case (verifier must catch a wrong topmark)
```

Deliverable: real SVG output in both styles, palette renders, and the verifier's
typed verdicts — proving or breaking the approach (especially the part everyone
underestimates, the verifier) in one pass before the full ~1,000-symbol run.

## Licensing — the clean-IP play

Generating **own** SVG artwork from the **public-domain** U.S. Chart No.1 (a U.S.
Government work), rather than extracting OpenCPN's GPL `rastersymbols-*.png`,
yields a symbol library Helm **owns** — no GPL contamination, no IHO
redistribution question. Symbol *meanings* are an open IHO standard (functional,
largely unprotectable); the booklet is public domain; fresh artwork conveying the
same standardised meaning is Helm's own work. This turns the icon library from a
GPL liability into an owned, relicensable asset.

`FORGE-10` is the explicit gate: confirm the own-artwork provenance with counsel
and place the pack on the correct side of the boundary in
`docs/VULKAN-RENDER-LICENSE-BOUNDARY.md`. Until then, treat the pack as
engine-side and do not cross the neutral-model seam with raw symbol artwork.
(This document is engineering scope, not legal advice.)

## Determinism

Same byte-deterministic ethos as `SYM-2`:

- content-hash `(spec + stylepack + primitives + prompt_version + model_id)` →
  `.cache/` key; re-runs regenerate only what changed;
- palettes are deterministic substitution, not generation;
- `resvg` raster output is stable;
- provenance on every symbol records input hash, model id, prompt version,
  verdict, and `human_approved` — the trace, not trust, is the trust mechanism.

## Cost (the Fiverr-killer)

`claude-opus-4-8` at $5/$25 per MTok, with a prompt-cached per-style prefix
(~0.1× on the shared span) and the Batch API (50%): a compose+verify round is
roughly **$0.03–0.06 per (symbol, style)**. A full ~1,000-symbol library is
≈**$40–80 in one style**, ≈**$150–250 across three** — regenerable on demand.
A contractor is ~$1–3K *per style* and not regenerable. Palettes are free.

## Deferred

This lane does not cover the Presentation Compiler's S-52 *decisions* (display
category, SCAMIN, safety contours, ordering — those are `SYM-3`), text/sounding
placement (`SYM-4`), or the GPU artifact cache and backend (the atlas image
encoding and GPU upload remain `SYM-2`/VSG concerns). FORGE produces the durable
style sheet; downstream lanes consume it.

## Completion criteria for FORGE-1

The lane is unblocked for implementation when the renderer-POC owner accepts:

- the Presentation Asset Pack as a first-class versioned input feeding `SYM-2`;
- the `(catalog_id, style, palette)` key and its mapping onto the atlas manifest;
- the two-axis (invariant vs. aesthetic) model and the verifier-as-centre-of-
  gravity QA approach;
- the clean-IP direction as the licensing intent (subject to the `FORGE-10`
  counsel gate);
- the tiny `FORGE` proof as the first deliverable before any bulk run.
