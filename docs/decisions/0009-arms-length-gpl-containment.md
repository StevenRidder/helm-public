# ADR-0009 — Arm's-length GPL containment interface

- **Status:** Accepted (interface + build-time guard implemented; commercial distribution of any GPL-derived path stays gated on IP counsel)
- **Date:** 2026-06-26
- **Tracked as:** `ENGINE-11`

## Context

Helm reuses OpenCPN's `model/` nav core and its `s57chart` S-52 renderer headless
([ADR-0001](0001-successor-not-fork.md), [OPENCPN-REUSE](../OPENCPN-REUSE.md)). That makes
the **engine GPLv2-or-later**. Helm's own code is licensed separately, and the hard
constraint from [LEGAL](../LEGAL.md) is the **VLC problem**: GPL source must **never be
statically linked into a distributed, closed binary** (e.g. an App Store app) — GPL's terms
are non-transferable against App Store terms.

Two earlier ADRs set the frame but did not, by themselves, resolve how a GPL engine ships:
[ADR-0002](0002-enc-engine.md) leans toward *rebuilding* S-52 on permissive GDAL/PROJ to
keep the core relicensable; [ADR-0006](0006-server-client-thin-display.md) establishes the
**boat-server ↔ thin-client** split. What was missing is the **explicit boundary** that
makes the GPL engine compliant *as shipped today*, and a way to keep that boundary from
silently eroding. This ADR defines that boundary and its enforcement.

## Decision

**The GPL engine is contained as a standalone process. Its only coupling to any client is
a versioned network protocol. No GPL/wx object is ever statically linked into — nor exposed
as a linkable library to — a distributed client binary.**

### The containment interface (the sole coupling)

The engine (`helm-server`, one origin) exposes exactly:

| Surface | Transport | Purpose |
|---|---|---|
| `/nav` | WebSocket | snapshot + delta nav state (vessel, active route/leg, AIS, alarms) |
| `/chart/{z}/{x}/{y}.png` | HTTP | S-52 raster tiles rendered by the GPL `s57chart` engine |
| `/health`, `/catalog` | HTTP | liveness + chart-cell catalog |
| `/` (static) | HTTP | serves the client UI assets (no engine code) |

This protocol — specified in [STREAMING-API.md](../STREAMING-API.md), owned by the
`CONTRACT` epic — **is** the containment interface. There is no in-process/FFI API into the
GPL core. "Network use is not distribution; an arm's-length protocol client is not a
derivative work" ([ADR-0006](0006-server-client-thin-display.md)).

### Two compliant client paths

1. **Thin network client (now).** Browser today; native macOS/iPad/iPhone later. Runs the
   engine on the boat (Mac mini / Pi) and talks to it over the LAN. App-Store-clean: no GPL
   or wxWidgets on the client. This is how iOS rides the *same* GPL engine immediately.
2. **Server-less, phone-only app (later, optional).** The only case the network boundary
   cannot cover. It requires the **clean-room S-52 rebuild on GDAL/PROJ + custom symbology**
   ([ADR-0002](0002-enc-engine.md) option 2) — no OpenCPN code on the device at all.

Helm's *own* code stays GPL-free under the root [LICENSE](../../LICENSE) /
[LICENSE.BSL](../../LICENSE.BSL); the GPL lives only in the contained engine process.

### Enforcement (so the boundary can't silently erode)

- **Process separation, not linkage.** The GPL renderer is a *build-internal* static
  archive (`libhelm-chartrender.a`) linked only into engine **executables**
  (`helm-engine`/`helm-server`/`helm-tiles`/`chart-spike`). The build emits **no** shared
  library or framework that a client could dynamically embed.
- **Source-only client surface.** The distributed client (`web/` today) ships only
  HTML/JS/CSS and reaches the engine through `/nav` + `/chart` — never a native artifact.
- **Build-time guard:** [`engine/containment-check.sh`](../../engine/containment-check.sh)
  asserts all three of the above and **fails the build** on a breach (a GPL `.dylib`/
  framework, a native artifact under `web/`, or loss of protocol-only coupling). It is wired
  into `engine/bootstrap.sh` next to the existing headless seam check, so every reproducible
  build re-proves containment. (Companion to the `top_frame::Get → want 0` seam check.)
- **Packaging rule (future native):** any notarized/installer artifact must bundle the
  engine as a separate executable the client launches/▸connects to, never a statically
  linked dependency. The guard extends to native build outputs when those exist
  (tracked in private native packaging tasks).

## Consequences

- The GPL engine ships **today**, compliantly, behind the network boundary — no wait on the
  GDAL rebuild for the server-backed (web + native-over-LAN) product.
- The commercialize-later option survives: Helm's own code is GPL-free; the only GPL is an
  arm's-length, user-run process.
- A regression that tried to embed the GPL engine in a client (a convenience `.dylib`, a
  WASM build of `s57chart`, a native FFI bridge) **fails CI/the build** rather than shipping
  a license violation.
- The clean-room GDAL path ([ADR-0002](0002-enc-engine.md)) is **not** on the critical path;
  it remains the optional north-star for a fully offline, server-less phone app only.
- **Still gated on IP counsel** before any *commercial* distribution that depends on the
  GPL engine — the technical boundary is necessary, not by itself sufficient
  ([LEGAL](../LEGAL.md)).

## Open

- Counsel sign-off on the boat-server/thin-client reading before a paid tier ships.
- Extend the containment guard to native packaging outputs once `NATIVE-*` produces them
  (assert the shipped bundle launches the engine as a separate process).
