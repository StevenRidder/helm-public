# ADR-0006 — Server-client / thin-display architecture (the iOS path)

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

The "port OpenCPN to iOS" problem is really two problems, and both are about *shipping
GPL through the App Store*:

1. **License.** OpenCPN's `model/` core (and its S-52 renderer) is **GPLv2-or-later**.
   GPL is incompatible with the App Store's additional restrictions (the "VLC problem"),
   so a GPL binary can't go through Apple.
2. **Sandbox + toolchain.** iOS has no serial/USB, and `wxWidgets` (a hard dependency of
   the OpenCPN core per [OPENCPN-REUSE.md](../OPENCPN-REUSE.md)) has no production iOS
   backend.

[ADR-0002](0002-enc-engine.md) answered this with "rebuild the engine on permissive libs
(GDAL/PROJ) so there's no GPL to ship." That's real but slow work, and it's only
*required* if the engine has to live **on the phone**.

But Phase 2 already built the engine as a **network server**, not a linked library. Per
[engine/README.md](../../engine/README.md), `helm-engine` already serves nav state over
`ws://127.0.0.1:8081` and `helm-tiles` already serves S-52 tiles over
`http://127.0.0.1:8082/chart/{z}/{x}/{y}.png`, and the UI ([web/](../../web/)) already
consumes both as a **fully decoupled client that runs in a plain browser**. The only thing
making it "local" is the `127.0.0.1` binding.

## Decision

**The engine is a boat server; every screen — macOS, iPad, iPhone, cockpit — is a thin
client over the network.** Promote the Phase 2 engine from a localhost helper to a
LAN service, and treat iOS as *a client of that service*, not a host of the engine.

```
        Boat data (NMEA0183/2000) ──► SignalK ──┐
                                                 ▼
   ┌──────── Helm Engine — boat server (Mac mini / Raspberry Pi) ────────┐
   │  GPL: OpenCPN model/ (routes·nav·AIS·tracks) + s57chart (S-52)       │
   │  one TLS origin, Bonjour-advertised  ──►  see STREAMING-API.md       │
   │    wss://helm.local/nav      (snapshot+delta nav state, channels)    │
   │    https://helm.local/chart/{z}/{x}/{y}.png   (S-52 raster tiles)    │
   └───────▲────────────────────▲────────────────────▲──────────────────┘
           │ arm's-length        │ network protocol    │ (no GPL on these devices)
   ┌───────┴──────┐     ┌────────┴───────┐     ┌────────┴────────┐
   │ macOS app    │     │ iPad client    │     │ iPhone client   │
   │ (SwiftUI)    │     │ (SwiftUI+Metal)│     │ (SwiftUI)       │
   └──────────────┘     └────────────────┘     └─────────────────┘
```

**Why this clears the App Store, both halves:**

1. **Nothing GPL ships through Apple.** GPLv2 obligations trigger on *distribution*, not
   *network use*. OpenCPN is GPLv2-**or-later** — which is **not** AGPL (the "or-later"
   clause reaches GPLv3, never the separate AGPL). Running the GPL engine on a boat server
   and letting a phone talk to it over the network is the run-as-a-service case plain GPL
   leaves open. The engine binary never touches the App Store.
2. **The iOS client is arm's-length, so it can be proprietary.** It speaks only a
   documented network protocol (JSON/WebSocket + PNG/HTTP). Programs that communicate over
   sockets via a defined protocol are *separate works*, not a derivative — so the client
   is not GPL-encumbered and is App-Store-distributable.
3. **The sandbox problem evaporates too.** `wxWidgets`, the C++ core, serial/USB ingest —
   all stay on the server. The phone is a thin renderer that needs none of it.

This is the marine **"one engine, many displays"** model (MFD + repeaters;
OpenPlotter/SignalK on a Pi viewed from any device) — arguably the right shape for a boat
regardless of licensing.

## Consequences

- **The clean-room rebuild ([ADR-0002](0002-enc-engine.md) Option B) is no longer on the
  critical path to iOS.** It's now required *only* for a server-less, fully-offline,
  phone-only standalone app sold through the App Store. iPad/iPhone on the GPL engine is
  available now, via the server.
- **This is a server-present architecture.** The client needs the boat server reachable
  (boat WiFi). Natural for a boat with an always-on Pi/Mac mini at the nav station; the
  away-from-boat case is mitigated by on-client tile + last-state caching, not solved.
- **Distributing the server itself is GPL distribution** (e.g. selling a preloaded Pi
  appliance, or shipping the engine binary). That's fine and common for an open/personal
  posture, and GPL software *can* be sold — but it must comply (source on request, no added
  restrictions) and still can't go through the App Store. Keep the client↔engine boundary a
  clean network protocol; **never compile GPL headers into the Swift client.**
- **Streaming quality is now the product surface for iOS.** A thin client over boat WiFi is
  only as good as the stream. The full design — framing, reconnect/resume, staleness,
  alarm reliability, tile caching, discovery, pairing/TLS, iOS specifics, perf budgets — is
  specified in [STREAMING-API.md](../STREAMING-API.md).
- Not legal advice; the GPL boundary stays "gated on IP counsel" per ADR-0002 and
  [LEGAL](../LEGAL.md) — but
  this posture is *materially safer* than the linking question those ADRs worry about,
  because there is no linking and no distribution to the phone at all.

## Open

- Confirm with counsel that the arm's-length network-client reading holds for the intended
  distribution (personal vs. sold server appliance vs. App Store client).
- Pick the server target matrix to support first (macOS + Raspberry Pi are the stated two).
- Decide whether the first iOS client is the existing web UI in a `WKWebView` (zero-port,
  proves it today) or a native SwiftUI/MapLibre client (better UX). See STREAMING-API.md.
