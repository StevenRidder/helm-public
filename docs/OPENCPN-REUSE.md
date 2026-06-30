# OpenCPN reuse — read the repo, here's the plan

> Produced by a 5-agent file-by-file read of the OpenCPN source (cloned, ~700 C++ files).
> Source notes: OpenCPN deep-read notes kept outside the public tree.

## TL;DR — the reframe

"Headless OpenCPN" should **not** mean "headless *renderer*." OpenCPN's reusable asset is its
entire **`model/` library** — routing, active-route navigation, tracks, AIS, comms, persistence —
not just the chart-drawing code. The renderer is the **hardest** thing to extract and the **least**
OpenCPN-specific in value (a chart picture); the **navigation core** is the **easiest** to reuse and
the **most** valuable (it's the safety-critical code that keeps you off the rocks, and it's already
decoupled from the UI).

**So: reuse OpenCPN's `model/` as the nav engine, build a new GUI (this web UI) on top, and treat
the S-52 chart renderer as a separate, deferrable sub-decision (Option A wins).**

## What OpenCPN is

A genuinely well-architected, mature **C++17** codebase. The key structural fact: a **CMake-enforced
split** between `model/` (the UI-independent nav core, exported as `ocpn::model`) and `gui/` (the
wxWidgets app). It's **proven headless three ways in-tree** — `opencpn-cmd` (the CLI instantiates the
route manager with no window), the GoogleTest suite, and helper executables (all link
`ocpn::model-src` and stub the GUI via `cli/api_shim.cpp`). Modern patterns throughout:
std::function dependency-injection contexts, an observable event bus, a versioned plugin ABI. The
2022–2025 comms rewrite (drivers → NavMsgBus → AppMsgBus) is the cleanest open-chartplotter
subsystem out there.

Caveats: **wxWidgets is a hard dependency** (but it's `wxBase` — strings/files/sockets — in ~65% of
model files, not GUI), some legacy smell (raw pointers, global singletons), and **GPLv2-or-later**.

## "Does Option B do the same?" — No.

Option B was *only* the chart **picture** (S-52 on GDAL). Drawing a route, the boat **navigating** it
(XTE/arrival/auto-advance), recording a track, AIS, NMEA — **separate subsystems** B doesn't touch.
A rebuild-on-GDAL gives a styled chart and **nothing that navigates**. But every one of those already
exists, GUI-free, in `model/` — so you reuse, not rebuild.

## Reuse map (how much you need)

| Feature | OpenCPN location | Disposition | Effort |
|---|---|---|---|
| Routes/waypoints + ETA math | `model/src/route.cpp`, `route_point.cpp` | reuse model/ | low |
| Active-route nav (activate/advance/arrival/XTE/autopilot) | `model/src/routeman.cpp` + the per-fix geometry `RoutemanGui::UpdateProgress` (in **gui/**) | reuse + **1 relocation** | medium |
| Track recording | `model/src/track.cpp` (`ActiveTrack`) | reuse model/ | low |
| GPX + SQLite persistence | `nav_object_database.cpp`, `navobj_db.cpp` | reuse model/ | low |
| AIS decode + **CPA/TCPA** | `model/src/ais_decoder.cpp` (0 GUI-wx includes) | reuse verbatim | medium |
| Anchor watch / MOB | (small) | rebuild on nav core | low |
| NMEA 0183/2000/SignalK comms | `model/src/comm_*` | **standard feed** (SignalK) | medium |
| Autopilot output | `model/src/autopilot_output.cpp` | standard feed (sentences/PGNs) | low |
| Tides & currents | `gui/src/tcmgr.cpp` (**wart: in gui/**) | reuse + **relocate** | medium |
| Dashboard / instruments | gauges | standard feed (presentation) | low |
| **ENC S-52 rendering** | `gui/src/s57chart.cpp`, `libs` s52plib | **reuse-renderer (A)** | very-high to rebuild |
| Raster / mbtiles charts | model/ chart classes | reuse or off-the-shelf | medium |
| Quilting | gui/, viewport-coupled | rebuild | high |
| GRIB weather | plugin | optional (we already have our own) | — |
| Plugin ecosystem | plugin ABI | optional | very-high |

**Three tiers:** *reuse `model/`* for the safety-critical nav core; *standard feed* (SignalK/NMEA) for
comms/autopilot/instruments — no OpenCPN code needed; *hard/optional* = the S-52 renderer, quilting,
plugins.

## The two relocations the model/ split didn't finish
1. **`RoutemanGui::UpdateProgress()`** (per-GPS-fix BRG/DTG/XTE + arrival/auto-advance) lives in
   `gui/` as a friend of the model `Routeman`. It depends only on model primitives (`toSM`,
   `DistGreatCircle`, `vector2D`, `gLat/gLon`, arrival radius) — **lift it down into `Routeman`.**
   This is the one piece of safety-critical code that has to move.
2. **Tides/currents (`tcmgr.cpp`)** sits in `gui/` but is standalone harmonic math — lift into the core.

## Charts: Option A beats B (and got easier) — ✅ PROVEN headless (2026-06-23)
`s57chart::RenderRegionViewOnDC` renders the **full S-52 picture into a `wxBitmap` with NO GL
context** — **proven**: it rendered NOAA cell US5FL96M (Key West) to a real S-52 PNG headless, no GUI
window, no display. See [spike/opencpn-headless/chart-render/](../spike/opencpn-headless/chart-render/)
(harness + recipe + the proof image + the hard-won gotchas: keep `ocpnUSE_GL` ON for ABI, grab
`dc.GetSelectedBitmap()` after render, assign `m_pRegistrarMan`). That's exactly the
`render(viewport, scale, scheme) → bitmap` shape Option A needs → serve as raster tiles to MapLibre.
So **A preserves true IHO S-52 correctness in weeks**, vs B rebuilding the hard 80% (S-52 conditional
symbology, color schemes, safety contours, text placement) from scratch. B stays the optional
north-star (esp. for iOS, where OpenCPN can't go).

For the Vulkan renderer POC, the first boundary is the shared seam: rendering semantics, normalized
chart objects, command-stream construction, Vulkan backend behavior, and golden fixtures are shared;
OpenCPN owns the interactive wx/swapchain adapter, and Helm owns the headless `/chart` tile adapter.
See [VULKAN-RENDERER-SEAM.md](VULKAN-RENDERER-SEAM.md) for the current ownership contract. Repository
layout and standalone extraction remain separate REPO-lane decisions. The upstream-shaped branch
structure is tracked in [VULKAN-RENDERER-STRUCTURE.md](VULKAN-RENDERER-STRUCTURE.md): OpenCPN owns the
shared render command stream and VulkanSceneGraph backend on a `vulkan/render-core-poc` branch, while
Helm consumes that commit through a thin `vulkan/consume-render-core` headless tile adapter.
The upstream/GPL boundary for that POC is tracked in
[VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md).

## The new architecture

```
  Boat data (NMEA0183/2000) ──► SignalK server ──┐
                                                  ▼
   ┌─────────────────────── Helm Engine (C++, GPL) ───────────────────────┐
   │  links OpenCPN ocpn::model  (routes · active-nav · tracks · AIS ·     │
   │  persistence)  +  s57chart  (S-52 → bitmap)                           │
   │  serves:  ws://127.0.0.1  (nav state, AIS, active leg)                │
   │           http://127.0.0.1/chart/{z}/{x}/{y}.png  (S-52 tiles)        │
   └───────────────▲───────────────────────────────────────▲──────────────┘
                   │ WebSocket (position/route/XTE/AIS)      │ raster tiles
   ┌───────────────┴───────────────────────────────────────┴──────────────┐
   │  Helm UI (this web prototype: MapLibre + glass chrome)                 │
   │  + our own satellite / weather / places / radar overlays              │
   └───────────────────────────────────────────────────────────────────────┘
              wrapped by Tauri (desktop window + packaging + launches engine)
```

The webview talks to the C++ engine over **localhost (WebSocket + HTTP tiles)** — so the UI stays
decoupled from C++ (it even runs in a plain browser during dev), and Tauri/Rust is just the shell.

## Licensing reckoning
Reusing OpenCPN's `model/` makes the engine **GPLv2-or-later** → the desktop app is GPL.
- For a **personal / open-source** Helm (your lean): embrace it. A GPL modern OpenCPN successor that
  reuses its battle-tested nav core is honest, community-friendly, and *far* faster than clean-room.
- The **"sell it closed later"** option is **off the table for this GPL-engine codepath** — that
  would require the clean-room rebuild (the B / GDAL path) and IP-counsel review.
- **iOS** can't *host* the wx-bound GPL engine (App Store + wxWidgets + GPL). But it doesn't have to:
  the engine runs as a **boat server** (Mac mini / Pi) and iPad/iPhone are **thin network clients** —
  no GPL or wx on the phone, App Store-clean (network use ≠ distribution; arm's-length protocol ≠
  derivative). So iOS rides the **same GPL engine, now**, over the wire — see
  [ADR-0006](decisions/0006-server-client-thin-display.md) + [STREAMING-API.md](STREAMING-API.md). The
  clean-room/vector path is needed **only** for a server-less, fully-offline, phone-only app.

You can have both eventually: the GPL desktop app you actually sail with (fast), and a future
clean-room cross-platform/commercial version (slow, separate). Or just embrace the GPL open path.

## The phased plan
- **Phase 1 — spike ✅ PROVEN (2026-06-23): BOTH reuse halves run headless on a Mac.**
  - *Nav core* — built a route, `ActivateRoute`, advanced waypoints, computed live BRG/DTW, no GUI.
    See [spike/opencpn-headless/](../spike/opencpn-headless/). (Gotcha: pin **wxWidgets 3.2**.)
  - *S-52 renderer* — rendered NOAA cell US5FL96M to a real S-52 PNG, no GUI / no GL context. See
    [spike/opencpn-headless/chart-render/](../spike/opencpn-headless/chart-render/).
  Option A is validated end-to-end: OpenCPN's nav engine **and** chart picture both reusable headless.
- **Phase 2 — engine (started):** the Helm Engine — link `model/` + `s57chart`; serve nav state over
  localhost WS + S-52 tiles over localhost HTTP. Do the two relocations (`UpdateProgress`, tides).
  - ✅ *nav-state WebSocket live* ([engine/](../engine/)): OpenCPN's real `Routeman` driven headless →
    `ws://127.0.0.1:8081` → the UI cockpit (instruments + route inspector + ownship), verified
    end-to-end. The UI prefers the engine, falls back to the JS sim — same JSON contract.
  - ✅ *S-52 chart-tile HTTP server live* ([engine/vendor/cli/helm_tiles.cpp](../engine/vendor/cli/helm_tiles.cpp)): renders
    NOAA ENC tiles headless → `http://127.0.0.1:8082/chart/{z}/{x}/{y}.png` → a MapLibre raster source;
    real S-52 charts (soundings/depth/contours) display under the live nav in the UI.
  - ⬜ Next: NODTA→transparent (depth-on-satellite compositing), real position-in (SignalK/NMEA), merge
    to one binary, the two relocations.
- **Phase 3 — wire the UI:** connect this web UI to the engine — real S-52 charts + real
  position/route/AIS, alongside the existing satellite/weather/places. Now it's a real chartplotter
  with this face.
- **Phase 4 — shell + parallel sea-trial:** Tauri-package it; run it on the boat **alongside OpenCPN**
  off the same SignalK feed; build trust mile by mile.
- **Phase 5 — iOS thin clients:** iPad/iPhone as network clients of the boat-server engine
  ([ADR-0006](decisions/0006-server-client-thin-display.md) + [STREAMING-API.md](STREAMING-API.md)) —
  the existing web UI in a WKWebView first, then a native SwiftUI/MapLibre client. Clean-room vector
  path, plugin support, and B-as-north-star stay later/optional (only a server-less phone app needs them).

## Rule zero
**OpenCPN stays on the boat, in parallel, as backup — forever.** The new app earns primary only over
real miles, on your terms. We are not abandoning the code that carried you around the world — we're
keeping it (the `model/` nav core, and its S-52 renderer) and giving it this face.
