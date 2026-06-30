# Icon Forge — POC

Proof of concept for the Vulkan board **`FORGE`** lane
([docs/VULKAN-ICON-FORGE.md](../../docs/VULKAN-ICON-FORGE.md)): an LLM-driven
generator for the S-52 / U.S. Chart No.1 symbol library as owned, multi-style
SVG — the **Presentation Asset Pack** that feeds the `SYM-2` atlas pipeline.

This POC runs the full pipeline over **5 symbols × 2 styles × 3 palettes**, plus
one deliberately-broken hazard case to exercise the verifier.

## Result

```
symbol            style        structural vision  overall  identity
BOYCAR_north      open-bridge  pass       pass    PASS     BOYCAR_north
BCNCAR_south      open-bridge  pass       pass    PASS     BCNCAR_south
BOYSAW            open-bridge  pass       pass    PASS     BOYSAW
RESARE_pattern    open-bridge  pass       pass    PASS     RESARE_pattern
WRECKS_dangerous  open-bridge  pass       pass    PASS     WRECKS_dangerous
... (us-paper: same 5, all PASS) ...
BOYCAR_north__BROKEN  us-paper pass       FAIL    REJECT   BOYCAR_south
accepted 10/11  rejected: BOYCAR_north__BROKEN
```

See [`samples/contact_sheet.png`](samples/contact_sheet.png) for the rendered
grid. The broken case is a north-cardinal with its topmark cones flipped **down**
— structurally valid SVG, correct colours, but the vision + sibling-discrimination
judge identifies it as a **south cardinal** (a wrong-quadrant grounding hazard)
and rejects it. That is the whole point: the verifier, not the generator, is the
safety mechanism.

During the POC the **structural** check also caught a real mistake — the wreck
was first drawn in the `ink` token while its load-bearing invariant colour is
`black`, so `invariant_colours_used` failed until the artwork referenced `black`.
Exactly the class of silent error a human contractor would ship.

## The 5 symbols

| id | kind | invariant highlights |
|---|---|---|
| `BOYCAR_north` | buoy | black/yellow, **two cones point up** |
| `BCNCAR_south` | beacon | yellow/black, **two cones point down**, fixed base |
| `BOYSAW` | buoy | red/white **vertical** stripes, single red sphere |
| `RESARE_pattern` | area pattern | tileable magenta diagonal hatch |
| `WRECKS_dangerous` | danger | hull-and-masts inside a **dotted** danger oval |

Region-independent and unambiguous, with crisp siblings — ideal for stressing the
verifier.

## Run it

```bash
cd pipeline/iconforge
pip install cairosvg pillow
python3 -m forge._seed_fixtures   # write the recorded compose/verdict fixtures
python3 -m forge.run              # run the pipeline -> out/
```

Set `ANTHROPIC_API_KEY` to swap the recorded backend for live `claude-opus-4-8`
calls (`forge/model.py: LiveModel`) — same interface, same downstream stages.

### Live vision judge (FORGE-6, production)

Run the **real** vision judge against the recorded renders — including the
broken hazard — and compare to the recorded verdicts:

```bash
ANTHROPIC_API_KEY=... python3 -m forge.judge_live          # the live call
python3 -m forge.tests.test_live_judge_wiring              # offline plumbing check (no key)
```

`judge_live` isolates the judge from compose (it consumes SVGs we already have),
so the only live variable is the model's verdict — the sharpest test of whether
a real vision pass catches the flipped-cone north cardinal and clears the ten
good symbols. The wiring test stubs the client to prove the request build
(model id, structured-output schema, base64 vision block, per-symbol checklist)
and the verdict parse are correct without an API key; the live run is a
transport swap on that validated plumbing.

If `ANTHROPIC_API_KEY` is absent, `judge_live` writes a blocked
`out/live_judge_report.json` and exits non-zero so the production gate cannot be
mistaken for an observed live agreement.

## What is real vs recorded

| Stage | POC |
|---|---|
| compose (SVG) — FORGE-4 | **recorded** claude-opus-4-8 output (`fixtures/compose/`) |
| vision judge + sibling test — FORGE-6 | **recorded** claude-opus-4-8 verdicts (`fixtures/verdicts/`) |
| structural verify — FORGE-6 | **live, deterministic** (`forge/verify.py`) |
| render + palette substitution — FORGE-5 | **live, deterministic** (cairosvg, `forge/render.py`) |
| atlas pack + manifest — FORGE-9 | **live, deterministic** (`forge/atlas.py`) |

The recorded artwork/verdicts are genuine output of the model the pipeline
specifies; only the transport (file vs HTTP) differs. The `LiveModel` path is
coded to the Claude API (structured outputs, vision image blocks, a cached
per-style prefix) and is the production backend.

## Layout

```
catalog/        5 SymbolSpec JSON (durable, reviewable truth)
stylepacks/     2 StylePack JSON (open-bridge, us-paper)
fixtures/       recorded compose SVGs + vision verdicts
forge/          the program: schema, model, render, verify, atlas, contact, run
pilots/         pilot contracts, including the 20-symbol stress catalog
samples/        committed artifacts (contact sheet, atlas sheets, manifests, report)
out/            regenerated each run (gitignored)
```

The atlas manifest is the `engine/vendor/cli/helm_s52_atlas` shape — entries
keyed `(name, kind, palette)` with `pixel_rect` / `uv` / `anchor` — plus the new
`style` axis. The C++/Vulkan loader consumes it unchanged.

## 20-symbol stress pilot

`pilots/stress20.json` is the next scaling gate. It deliberately covers
cardinal orientation, beacon-vs-buoy body, lateral red/green and can/conical
confusion, safe-water and special marks, dangerous/non-dangerous wrecks,
rock/obstruction confusion, area patterns, and light flares. Run:

```bash
python3 -m forge.tests.test_stress20_catalog
python3 -m forge.stress20_generate
python3 -m forge.tests.test_stress20_generate
python3 -m forge.stress20_verify
python3 -m forge.tests.test_stress20_verify
python3 -m forge.tests.test_scale_decision
```

`pilots/scale_decision.json` records the go/no-go decision for the next
100-150 asset batch and the thresholds needed before claiming the path to 99%
coverage is credible.

## 125-asset scale batch

`pilots/scale125.json` is generated from local `chartsymbols.xml` lookup rows,
with quotas for buoy/beacon marks, lights/daymarks/topmarks,
wreck/rock/obstruction cases, area/pattern/line-style assets, and ugly
attribute-driven edges. Run:

```bash
python3 -m forge.scale125_select
python3 -m forge.tests.test_scale125_selection
python3 -m forge.scale125_generate
python3 -m forge.tests.test_scale125_generate
python3 -m forge.scale125_verify
python3 -m forge.tests.test_scale125_verify
python3 -m forge.scale125_atlas
python3 -m forge.tests.test_scale125_atlas
python3 -m forge.scale125_provenance
python3 -m forge.tests.test_scale125_provenance
```
