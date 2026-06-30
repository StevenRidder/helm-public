# Phase-1 spike — OpenCPN's `model/` nav core, headless ✅ PROVEN

This proves the load-bearing assumption of [the plan](../../docs/OPENCPN-REUSE.md): **OpenCPN's
navigation core (`model/`) builds and runs with NO GUI**, so we can reuse it and put our own UI on
top. Validated on macOS (Apple Silicon, 2026-06-23).

## What it does (`helm_spike.cpp`, ~60 lines)
Mirrors OpenCPN's own headless `cli/console.cpp`: builds a 3-waypoint `Route`, runs the planning math
(`Route::UpdateSegmentDistances`), instantiates the route engine
(`new Routeman(RoutePropDlgCtx(), RoutemanDlgCtx())` — the exact construction `console.cpp` uses),
activates the route, advances waypoints, and computes live bearing/distance to the active waypoint
(`DistanceBearingMercator`) — the one bit the `model/`-vs-`gui/` split left in `gui/`
(`RoutemanGui::UpdateProgress`), here shown to be a handful of model-only lines.

## Proven output
```
== Helm spike: OpenCPN model/ nav core, headless ==
1) Route built headless: 3 waypoints; planning math ran.
2) Routeman instantiated (no window).
3) ActivateRoute -> OK; active route: yes
   LIVE NAV -> active WP 'WP1'   BRG 138 deg   DTW 4.06 NM
4) advanced to next waypoint
   LIVE NAV -> active WP 'WP2'   BRG 138 deg   DTW 8.11 NM
5) deactivated.
== HEADLESS NAV CORE WORKS ==
```

## Reproduce it
```bash
# 1) deps (macOS / Homebrew). CRITICAL: OpenCPN needs wxWidgets 3.2 — 3.3 removed wxNode and
#    breaks libs/nmea0183. Pin 3.2.
brew install cmake pkg-config wxwidgets@3.2 shapelib libarchive libsndfile mpg123 gpatch

# 2) clone OpenCPN (no submodules needed for this)
git clone --depth 1 https://github.com/OpenCPN/OpenCPN.git /tmp/opencpn

# 3) drop in the spike + register a build target
cp helm_spike.cpp /tmp/opencpn/cli/helm_spike.cpp
#    append cli-CMakeLists-snippet.txt to /tmp/opencpn/cli/CMakeLists.txt
cat cli-CMakeLists-snippet.txt >> /tmp/opencpn/cli/CMakeLists.txt

# 4) configure against wx 3.2 (+ keg-only libarchive hint)
WX=/opt/homebrew/opt/wxwidgets@3.2/bin/wx-config-3.2
LA=/opt/homebrew/opt/libarchive
cmake -S /tmp/opencpn -B /tmp/opencpn/build -DCMAKE_BUILD_TYPE=Release \
  -DwxWidgets_CONFIG_EXECUTABLE=$WX \
  -DLibArchive_INCLUDE_DIR=$LA/include -DLibArchive_LIBRARY=$LA/lib/libarchive.dylib

# 5) build just the spike (pulls in ocpn::model-src + the in-tree libs)
cmake --build /tmp/opencpn/build --target helm-spike --parallel 8

# 6) run it
DYLD_LIBRARY_PATH=$LA/lib /tmp/opencpn/build/cli/helm-spike
```

## What this validates (and the gotchas found)
- ✅ `ocpn::model-src` compiles + links **without the wxWidgets GUI** (only `wxBase`/`wxCore` data
  types) — the `model/` library is genuinely reusable, as designed.
- ✅ The route engine, planning math, activation/advance, and live nav math all run headless.
- ✅ OpenCPN's full CMake configures cleanly on a stock Mac once deps are present.
- ⚠️ **wxWidgets must be 3.2**, not brew's default 3.3 (3.3 removed `wxNode`/`wxMRLNode`).
- ⚠️ macOS needs **GNU patch** (`gpatch`) — BSD `patch` fails the ShapefileCpp patch step.
- ⚠️ keg-only **libarchive** needs an explicit CMake hint.
- ℹ️ The one piece to "relocate" from `gui/` to the core is `RoutemanGui::UpdateProgress`
  (per-fix BRG/XTE/arrival) — demonstrated trivially in `liveNav()` here.

## Next (Phase 2)
Build the **Helm Engine**: link `ocpn::model-src` + `s57chart`, serve nav state over a localhost
WebSocket and S-52 chart tiles over localhost HTTP, for this web UI to consume. See
[../../docs/OPENCPN-REUSE.md](../../docs/OPENCPN-REUSE.md).
