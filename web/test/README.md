# web/test — the web-client test suite (CLIENT epic · CLIENT-17)

One command runs every JS test in `web/`:

```sh
node web/test/run.mjs            # run all suites, print a summary (exit 0 = green)
node web/test/run.mjs --verbose  # also print each suite's own output
```

CI runs exactly this on every push / PR that touches `web/**` — see
[`.github/workflows/web-tests.yml`](../../.github/workflows/web-tests.yml). No dependencies, no build
step: it's plain `node` (the same dependency-free, `vm`-sandbox style as the existing smoke tests).

## What it runs

`run.mjs` is a thin aggregator. Each suite is a standalone node script that exits `0` (pass) /
non-zero (fail); the runner just executes each and tallies.

| Suite | Source | What it covers |
|---|---|---|
| `persist` | `web/persist.smoke.js` | `HelmStore` namespaced get/set + **fail-loud** on quota/unavailable/corrupt (TOOLS-7) |
| `alarms` | `web/alarms.smoke.js` | alarm logic |
| `true-wind` | `web/true-wind.js` (inline self-test) | TWS/TWD/TWA from apparent wind + boat motion (WX-13) |
| `wx-value-codec` | `web/wx-value-codec.js` (inline self-test) | value↔RGBA round-trip, NODATA honesty, tile math (WX-10) |
| `ais-risk` *(new)* | `web/test/ais-risk.test.cjs` | **collision-risk tiering** — danger/caution/normal matrix, engine-`risk` precedence, `cpaValid`/no-tcpa/opening guards; `danger` == the CPA-alarm predicate exactly |
| `ais-guard` *(new)* | `web/test/ais-guard.test.cjs` | **proximity / guard-zone** breach detection, exit hysteresis, and **fail-loud** (feed loss freezes a breach; no fix clears it) — never a false "all clear" |

The first four already existed and passed — they just weren't runnable as one suite or wired into CI.
The `ais-risk` and `ais-guard` tests are new coverage for previously-untested safety logic.

## E2E (Playwright) — validating the Tier-1 behaviours

The unit suite above can't exercise behaviours that need a real browser (rAF, the map, the DOM). The
Playwright suite in [`e2e/`](e2e/) drives the **real app in headless Chromium** in SIM mode (no
engine) — and headless Chromium runs `requestAnimationFrame` normally (unlike a backgrounded preview
tab), so the rAF-driven ownship/track behaviours ARE testable. **Each spec maps to a product claim:**

| Spec | Fix | Claim it proves |
|---|---|---|
| `e2e/client1-ownship-overlay.spec.js` | CLIENT-1 | "Glass-smooth, easy on battery" — rings render, redraws happen while moving, and **stop when the boat is settled** (vs ~90 rebuilds/1.5 s un-gated); a manual pan still works |
| `e2e/client2-track-cap.spec.js` | CLIENT-2 | "Plot for days" — a 5000-pt snapshot and overflowing deltas stay **capped at 3000** (most-recent kept) |
| `e2e/client3-deck-leak.spec.js` | CLIENT-3 | "Toggle layers freely" — enable→disable→enable leaves **no leaked map control**, re-enable rebuilds cleanly |
| `e2e/client4-error-surface.spec.js` | CLIENT-4 | "Honest when something's wrong" — real errors/rejections banner, benign tile 404s are suppressed, a **dead nav backend surfaces**, rate-limit + dismiss work, and a failed style shows the banner **not a blank page** |
| `e2e/smoke.spec.js` | — | boots in SIM with no uncaught errors, banner hidden |

```sh
cd web/test
npm install                              # @playwright/test
npx playwright install chromium          # one-time browser download
npx playwright test                      # run all E2E (starts serve.py itself)
```

CI runs this on every `web/**` push/PR — see [`.github/workflows/web-e2e.yml`](../../.github/workflows/web-e2e.yml).

**These tests are mutation-verified.** Each fix was temporarily reverted and the matching spec was
confirmed to go **red** (CLIENT-1 un-gated → churn; CLIENT-2 cap removed → unbounded; CLIENT-3 no
`removeControl` → leaked control; CLIENT-4 broad benign-regex → a dead backend hidden). A test that
can't fail is worthless — these can.

## Adding a test

Drop a `web/test/<name>.test.cjs` that exits non-zero on failure — it's auto-discovered, no edit to
`run.mjs` needed. For a browser module that attaches to `window` (no `module.exports`), load it in a
`vm` sandbox like `ais-risk.test.cjs` / `persist.smoke.js`; stub only the host globals it touches
(`document`, `localStorage`, timers — ES intrinsics like `Math`/`JSON`/`Date` come free).

## Known gap (coordination)

`collision.js` `classify()` (the **COLREGs give-way / stand-on / monitor** role) is safety logic worth
testing, but it's a module-private function inside the `HelmCollision` IIFE. Unit-testing it cleanly
needs the **AIS** epic (which owns `web/collision.js`) to either export `classify` or move it to a
small pure module — the CLIENT epic does not edit `collision.js`. Tracked on the board.
