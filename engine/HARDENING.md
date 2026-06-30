# Chart-core hardening — turning the spike into a production renderer

The headless S-52 renderer was first proven as a *spike* (extract a slice of OpenCPN's `gui/`,
prop it up with stubs). For a life/death navigation tool that's not good enough. This tracks the
work to make it production-grade — **no hacks, no faked symbols, correct safety features**. Driven by
a file-by-file read of OpenCPN's real source.

## The key finding
OpenCPN **already renders charts to bitmaps headlessly** — `s57chart::BuildThumbnail`
(`gui/src/s57chart.cpp:2982`) renders into a plain `wxMemoryDC` via `DoRenderViewOnDC` →
`ps52plib->RenderAreaToDC` with **no window, no GL context, no ChartCanvas**. So we are not faking a
capability that doesn't exist — the supported render-to-bitmap path is real. The *only* reason the
spike needs ~450 lines of stubs is that `s57chart.cpp` is compiled into the **monolithic `opencpn`
executable**, not a reusable library, so a headless consumer must re-link a slice and satisfy a few
app globals. **Recommendation: Option A — extract a first-class `ocpn::chart-render` static library
(upstream a headless seam)**, rather than running OpenCPN offscreen (Option B).

## Status

| # | Item | Status |
|---|------|--------|
| 1 | **Native-scale → SCAMIN / safety-contour** (SAFETY) | ✅ **done + verified** |
| 2 | **Sever faked `ChartPlugInWrapper` RTTI** (the loader landmine) | ✅ **done + verified** |
| 3 | Sever the GUI top-frame from the render path (drop magic `GetBestVPScale`) | ✅ **done + verified** |
| 4 | Platform `GetDisplayDPmm()` hardcoded `4.0` → real `BasePlatform::GetDisplayDPmm()` | ✅ **done + verified** |
| 5 | **ChartDB + quilting** (real multi-cell, not one hardcoded cell) | ⬜ larger (~1.5–3 wk) |
| 6 | Extract `ocpn::chart-render` library; vendor OpenCPN + maintained patches (Option A) | 🟡 **library extracted + AbstractTopFrame seam done** (no frame stub left); vendoring next |

### ✅ 1 — Native-scale / safety-contour fix (the dangerous one)
`s57chart::BuildRAZFromSENCFile()` ingested the SENC but **never copied the decoded native
(compilation) scale back into the chart**, so `GetNativeScale()` returned the constructor default `1`.
The GUI hides this via a separate header-only pass; our headless full-Init path exposed it. With
scale `1`, `s52plib`'s SUPER_SCAMIN test (`chart_ref_scale * 4 = 4`) culls **DEPCNT / DEPARE / SOUNDG**
— i.e. the **safety contour and dangerous soundings silently disappear**.
Fix: copy `sencfile.getSENCReadScale()` into `m_Chart_Scale` (and surface a bad scale loudly — never
render silently at `1`). See [`patches/0001-s57chart-headless-correctness.patch`](patches/).
**Verified:** `GetNativeScale()` now returns the true `1:40000`; previously SCAMIN-culled tiles went
from ~777 B (near-blank) to ~10 KB (full soundings + depth contour) at z13/z15.
*This is a genuine OpenCPN latent bug — the patch is upstreamable.*

### ✅ 2 — Sever the faked RTTI
The spike emitted a **fake `typeinfo for ChartPlugInWrapper`** (`chart_typeinfo.cpp`) so a
`dynamic_cast<ChartPlugInWrapper*>` would link — a same-named stand-in class whose layout differs from
the real one: a latent crash if ever actually dereferenced. Those casts live only in **light-sector
helpers** that take a `ChartCanvas*` (cursor interaction, never the tile-render path) and only fire for
**plugin charts**, which a headless engine never loads. Fix: guard them out under `OCPN_HEADLESS`
(`target_plugin_chart = NULL`) — structural severance, not a fake — and drop `chart_typeinfo.cpp`.
**Verified:** links with no undefined typeinfo; tiles still render correctly; no `__ZTI18ChartPlugInWrapper`.

### ✅ 3 — Sever the GUI top-frame from the render path
The spike's `HeadlessTopFrame` returned a **magic `10000.0`** from `GetBestVPScale()`. Tracing it:
`s57chart::BuildRAZFromSENCFile` calls `top_frame::Get()->GetBestVPScale(this)` and the result feeds
**only** `SendVectorChartObjectInfo()` — a plugin notification that is a no-op with no plugins loaded.
So the render path doesn't need a frame at all. Fix: under `OCPN_HEADLESS`, compute `scale` from the
chart's own (now-correct) `GetNativeScale()` and drop the `top_frame::Get()` call. The residual
`HeadlessTopFrame` is now render-path-dead (its remaining callers are background-SENC paths bypassed by
`DisableBackgroundSENC()`); it survives only to satisfy the fat `AbstractTopFrame` interface until
Step 6 splits it. **Verified:** tiles render byte-identical (the severed value was inert), no magic
number drives the render path.

### ✅ 4 — Real platform DPmm
`OCPNPlatform::GetDisplayDPmm()` was hardcoded to `4.0`. Replaced with the real
`BasePlatform::GetDisplayDPmm()` (linked from `model-src`) — actual platform code, not a constant.
DPmm feeds `m_LOD_meters`; it's inert today (`g_SENC_LOD_pixels == 0` gates LOD decimation off), but
production tile-LOD parity would pin it to the SENC build environment. **Verified:** byte-identical tiles.

### 🟡 6 — chart-render as a first-class library (in progress)
The headless S-52 renderer was a `gui/src` source *slice* recompiled into each executable, propped up
by stubs. **Increment 1 (done):** it's now a real static library, `ocpn::chart-render`
(`libhelm-chartrender.a`) — the slice + stubs compiled once, with `PUBLIC` include/define/link usage
requirements that flow to consumers, and `GetpSharedDataLocation()` moved into the library so it has
**no back-reference to its host executable**. Both `chart-spike` and `helm-tiles` now just link it;
because the library carries `OCPN_HEADLESS`, **the faked-RTTI shim (`chart_typeinfo.cpp`) is no longer
needed by any target** and is retired. Verified: both build from the library and render identically
(nativeScale 40000, same tiles).

**Increment 2 (done) — the `AbstractTopFrame` seam.** The library no longer contains a frame object at
all. Previously `chart_stubs.cpp` defined a `HeadlessTopFrame` (~79 `helm_dead()` no-op overrides of the
fat `AbstractTopFrame : wxFrame` interface) purely to satisfy `top_frame::Get()`. A workflow mapped +
adversarially verified the real dependency: under `OCPN_HEADLESS` the **only render-path call**
(`s57chart.cpp` `GetBestVPScale`) is already compiled out (Step 3), and the **5 remaining `top_frame::Get()`
callers all live in `senc_manager.cpp`** (background-SENC status-bar cosmetics) — runtime-dead
(`g_SencThreadManager` is never instantiated: `s57_load.cpp` isn't in the slice, and both harnesses call
`DisableBackgroundSENC()`), but still a *link* dependency because they compile unconditionally. Seam:
guard those 5 call sites under `#ifndef OCPN_HEADLESS` (upstream patch
[`0002-senc_manager-headless-topframe-seam.patch`](patches/) — mirrors the Step-3 s57chart pattern), which
drops `senc_manager.cpp.o`'s `U top_frame::Get()`; then **delete `HeadlessTopFrame`, its singleton storage,
the `top_frame::Get()` definition, and its instantiation** from `chart_stubs.cpp` (478→368 lines). **Verified:**
`nm` shows zero `top_frame`/`AbstractTopFrame` symbols in `libhelm-chartrender.a`, `helm-tiles`, and
`chart-spike` (no `U`, no `T`, no vtable/typeinfo); both binaries link clean; and **all 91 z13/z15 content
tiles render byte-identical** to the pre-change baseline (warm-vs-warm, same build). Removing the abort
tripwire is net-safer here: re-enabling the `#else` arm would now be a loud *link* failure, not a runtime
abort. *(Correction, established later — now **RESOLVED**: the S-52 renderer was **per-process
non-deterministic** — across fresh processes ~30/112 z13/z15 tiles flipped between stable "attractor"
values, though each process was internally consistent. So the byte-identical seam evidence held within a
build but was attractor-dependent across relinks — corroboration, not proof; the seam's correctness rests on
the logical argument above (the removed code was never on the render path). Two earlier guesses were both
**misdiagnoses**: a "startup warmup render" (a same-process warmup cannot touch cross-process variance —
measured equally non-deterministic on/off) and "address-ordered render iteration." The PROVEN root cause
(soundings-toggle bisection + `MallocPreScribble` constant-fill → deterministic) is an **uninitialized
member**: `s52plib::m_nSoundingFactor` was never set in the ctor (only `m_nTextFactor` was), and
`PrepareForRender()` reads it as `m_SoundingsScaleFactor = m_nSoundingFactor*.1 + 1`, so the sounding-font
point size — hence every sounding digit's pixel placement — varied per process. Fix: initialise
`m_nSoundingFactor = 0` (the app default), shipped as
[`patches/0004-s52plib-headless-sounding-determinism.patch`](patches/). Verified: 12/12 fresh processes
byte-identical and 0/112 cross-process tile diffs — which also restores the cross-build byte-identical
comparison this seam evidence relies on.)*

**Next:** vendor OpenCPN as a maintained patch series (`patches/0001`, `0002`, …) rather than building
against a mutable clone — the remaining Step-6 work.

## Fail-and-fix-early hardening (no masked failures)
A nav system must surface problems the moment they occur, never hide them behind fallbacks or
placeholders. Audited the tile server + engine + UI for silent masking and fixed:
- **Tile render failure was served as a transparent tile** — indistinguishable from open water. Now
  `render_tile` returns a distinct status and the HTTP layer answers `200` (chart), `200`-transparent
  (genuinely no coverage), `400` (bad tile coords), or **`500` + a logged stage** on a real failure. A
  broken chart render is never served as blank ocean.
- **Invalid native scale is now fail-closed** — the tile server *refuses to serve* a cell whose
  SCAMIN/safety-contour filtering can't be trusted, instead of rendering it silently.
- **Uninitialized GUI-config members in `s52plib` were read as per-process garbage during render.** The
  full app sets these from its options dialog; a headless consumer never does, and the ctor left several
  unset. This first surfaced as the sounding-render non-determinism (`m_nSoundingFactor`, patch 0004), so
  an audit of every flag read by `ObjectRenderCheck()` (the per-object render gate) followed. Found and
  fixed (patch 0005): `m_bUseSCAMIN`, **`m_bUseSUPER_SCAMIN`** (garbage-on culls DEPCNT/DEPARE/SOUNDG — the
  **safety contour + dangerous soundings** — the exact hazard the native-scale fix above guards against),
  `m_bShowMeta`, `m_chart_zoom_modifier_vector` — all defaulted to OpenCPN factory values (SUPER_SCAMIN
  **off** = the safe choice). Detector + regression guard: a `MallocPreScribble=1` differential (uninit
  heap → constant fill) — any tile whose bytes change vs a normal run is still reading uninitialized memory.
  Breadth-validated **0 uninitialized-memory diffs, all cross-process deterministic** over: US5FL96M across
  all three color schemes (day/dusk/night, ~2.5k tiles) **plus 5 additional cells spanning scale bands 3–5
  (overview 1:180000 → approach 1:80000 → harbor 1:12000) in FL/GA — ~16k more tiles**. The detector makes
  each new cell a few seconds of work, so coverage is cheap to extend further.
- **A dropped live engine silently fell back to the simulator** (a plausible fake position). The UI now
  raises a red **"ENGINE LOST"** alarm and dims the readings stale; the browser sim is used *only* when
  no engine was ever present (honest prototype mode).
- **A simulated position was badged "LIVE".** The engine now declares `posSource`; a simulated own-ship
  reads **"ENGINE · SIM POS"** (amber) — green "LIVE" is reserved for a real GPS/NMEA/SignalK feed.
- Boundary input validation + a blank-tile generation check fail loud at startup.
- **Real data now overrides sim per-field, and every field declares its source.** The engine listens
  for **NMEA 0183 over TCP (port 10110)**; a fresh, checksum-valid sentence overrides the matching
  field (`pos`/`sog`/`cog`/`hdg`/`depth`/`wind`) and stamps `sources.<field> = "nmea"`; stale or absent
  fields fall back to sim as `"simulated"`. Corrupt (bad-checksum) sentences are rejected, not trusted.
  The UI dots each still-simulated reading amber and promotes the badge to green **LIVE** once the
  position is real. To take the boat off sim, stop emitting the sim fallbacks. *(Verified: fed RMC+DBT →
  pos/sog/cog/depth flipped to `nmea`, hdg/wind stayed dotted; a corrupt sentence was rejected.)*
- **The render-path-dead `HeadlessTopFrame` stub is now deleted outright** (Step 6 increment 2). It
  formerly abort-on-call'd (`helm_dead()`) so a wrong "unreachable" assumption failed loud; the seam went
  further and removed the frame object entirely, so the `top_frame::Get()` callers are `#ifndef
  OCPN_HEADLESS`-guarded and re-introducing one would be a loud *link* failure rather than a silent
  default. *(Verified: zero `top_frame` symbols remain; all 91 z13/z15 tiles byte-identical.)*
- **Weather-layer load failures no longer swallow.** `field-layer.js` propagates a failed/404 fetch
  instead of returning `null`; the UI surfaces a visible "data unavailable" notice. *(Verified: a
  missing field rejects with `HTTP 404`.)*

## Patches
`patches/` holds the OpenCPN source changes (against the upstream clone). They are deliberately small,
real, and upstreamable — not workarounds. The build still happens against a clone today; **Step 6**
moves this to a vendored OpenCPN + maintained patch series + a real `ocpn::chart-render` library.
