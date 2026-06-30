# Streaming & API — boat server ↔ thin clients

> How the Helm Engine talks to its displays. The contract that makes a Mac mini / Raspberry
> Pi engine feel **native** on an iPad or iPhone across flaky boat WiFi.
> Architecture rationale: [decisions/0006-server-client-thin-display.md](decisions/0006-server-client-thin-display.md).
> Current engine surface: [engine/README.md](../engine/README.md).

## The deployment reality (what "world-class" has to survive)

This is not a datacenter. The design is shaped by five facts of life on a boat:

1. **Boat WiFi is bad.** Weak, congested, dead spots below deck, drops as you move around.
   The stream must reconnect seamlessly and **degrade visibly, never silently**.
2. **It's safety-critical.** A nav display must *never* show stale data as if it were live.
   Staleness is a first-class, always-visible UI state — this is the single most important
   rule in the whole document.
3. **The server may be small.** A Raspberry Pi rendering S-52 on the main thread (per
   [engine/README.md](../engine/README.md)) is CPU-bound. Fan-out to N clients must be cheap;
   tiles must be rendered once and cached, not per-request-per-client.
4. **iOS suspends apps and guards the battery.** A 1 Hz socket + tile fetches must not drain
   the iPad; a backgrounded iPhone still has to receive an anchor-drag alarm.
5. **The marina network is shared and hostile.** A stranger must not be able to read your
   boat's position or — far worse — inject a fake MOB/anchor alarm. **Auth is not optional.**

## Shape: one origin, two surfaces, many channels

Collapse today's two ports (8081 WS + 8082 HTTP) into **one TLS origin** behind one Bonjour
record. Simpler discovery, one cert to pin, one thing to firewall. (The engine README already
lists "merge to one binary" as a next step — this is that, plus TLS.)

```
   wss://helm.local/nav            ← state stream  (snapshot + delta, channels)
   https://helm.local/chart/{z}/{x}/{y}.png   ← S-52 raster tiles (cache-immutable)
   https://helm.local/catalog      ← chart cells available + editions + bbox
   https://helm.local/health       ← liveness/version (unauthenticated, tiny)
   https://helm.local/pair         ← pairing handshake (QR/PIN → token)
```

Everything below the line is the wire contract. Build it once; macOS / iPad / iPhone / a
plain browser all speak it identically.

---

## 1. The nav stream — `wss://helm.local/nav`

### 1.1 Snapshot + delta + sequence (small frames, cheap resync)

Today the engine pushes a **full** ~1 Hz JSON blob (see the contract in
[engine/README.md](../engine/README.md)). At 1 Hz that's fine on localhost and wasteful over
WiFi to multiple clients. World-class:

- On connect (and **every reconnect**), the server sends one **`snapshot`** = full state.
- Thereafter it sends **`delta`** frames carrying *only changed fields*.
- Every frame has a monotonically increasing **`seq`**. A periodic **keyframe** (full
  snapshot every ~30 frames) lets a client that missed deltas resync without reconnecting.
- The client tracks `lastSeq`; on reconnect it sends it, and the server replies with a fresh
  snapshot immediately (never "wait for the next tick").

```jsonc
// server → client, on connect
{ "t":"snapshot", "seq":1042, "ts":1750000000.123, "mono":918273.4,
  "nav":{ "pos":{"lat":24.4587,"lon":-81.8078}, "sog":6.1, "cog":15, "hdg":14, "depth":13.2 },
  "wind":{"spd":17,"dir":105,"range":"13–25 kt"},
  "active":{ "name":"Route to Marina", "eta":"23:43", "dtg":"6.1 NM", "xte":"0 m",
             "legs":[{"name":"WP2 · sea buoy","brg":"15°","active":true}], "nextWp":"WP2 · 1.6 NM" } }

// server → client, steady state (only what moved)
{ "t":"delta", "seq":1043, "ts":1750000001.121, "mono":918274.4,
  "nav":{ "pos":{"lat":24.4589,"lon":-81.8077}, "sog":6.0, "cog":16 } }

// client → server, on (re)connect
{ "t":"hello", "lastSeq":1042, "subscribe":["nav","route","alarms"], "rates":{"nav":2},
  "viewport":{"z":13,"bbox":[-81.85,24.43,-81.76,24.57]} }
```

The existing UI keeps working: it merges `delta` into its last state and renders the **same
object shape** it renders today — `nav-source.js`'s contract is preserved, just reframed.

### 1.2 Channels & subscriptions (pay only for what you show)

Different data has different rates and consumers. Split the stream into channels a client
subscribes to in `hello`:

| Channel  | Rate            | Payload                                   | Who subscribes |
|----------|-----------------|-------------------------------------------|----------------|
| `nav`    | 1–4 Hz (client-chosen) | pos · SOG · COG · HDG · depth        | everyone |
| `route`  | on-change       | active route · XTE · ETA · next WP        | chart views |
| `ais`    | 1 Hz, **bbox-culled** | targets in viewport + CPA/TCPA + `risk` tier | chart views |
| `alarms` | event-driven, **reliable tier** | anchor · depth · CPA · MOB    | **everyone, always** |
| `weather`/`tide` | low / on-change | overlay state, tide curve         | optional |

An iPhone showing only the instrument bar subscribes to `nav`+`alarms` and saves battery and
bandwidth. The iPad showing the full chart subscribes to everything and sends a `viewport` so
**AIS is culled server-side to what's on screen** (critical near busy harbors — don't stream
500 targets to render 12).

### 1.3 Staleness & heartbeat (the safety rule)

- Every frame carries server **`ts`** (wall clock) and **`mono`** (monotonic seconds). The
  client computes `age = clientNow − frameArrival` and tracks gap since last frame.
- Server sends a `ping` every 2 s when idle so silence is unambiguous.
- The client surfaces an explicit, always-visible state derived from frame age:

  | State    | Trigger                  | UI |
  |----------|--------------------------|----|
  | **LIVE** | last frame < 3 s         | normal |
  | **LAGGING** | 3–10 s                | amber age badge on instruments |
  | **STALE** | > 10 s                  | ownship greys, "STALE — last fix 14s ago" banner |
  | **OFFLINE** | socket down / no path | red banner, dead-reckon ownship optional + clearly labeled |

  Position is **never** silently frozen-but-live-looking. A greyed ownship with an age is the
  correct failure mode for a chartplotter.

### 1.4 Reconnect & backpressure (built for bad WiFi)

- **Reconnect:** exponential backoff with jitter (e.g. 0.25 s → 8 s cap), instant retry on a
  fresh network path (see iOS `NWPathMonitor` below). Resume via `lastSeq` → snapshot.
- **Backpressure = latest-wins, never a queue.** If a client's send buffer is filling (slow
  link), the server **coalesces**: it drops intermediate `nav` deltas and sends the *latest*
  state. Never buffer a backlog of old positions — a stale fix delivered late is worse than
  useless on a moving boat. (`alarms` are exempt — see §3.)
- **Adaptive rate:** the server may lower a struggling client's `nav` rate and tell it so, so
  the client can show "reduced update rate" rather than guess.

---

## 2. The chart tiles — `https://helm.local/chart/{z}/{x}/{y}.png`

Already proven ([engine/README.md](../engine/README.md), [web/style.json](../web/style.json)
`enc` raster source). Make it world-class on a small server + flaky link:

### 2.1 Cache like the tiles are immutable (because they are)

An S-52 tile for a given **cell edition + style (Day/Dusk/Night) + safety-contour** doesn't
change. Encode those into an **ETag / version segment** and serve:

```
Cache-Control: public, max-age=31536000, immutable
ETag: "US5FL96M.e07.day.sc4"
```

The client caches to disk **permanently** (the offline-first principle from
[ARCHITECTURE.md](ARCHITECTURE.md)). Once you've viewed an area, it works with the server
offline. Changing palette or safety contour changes the ETag → clean cache bust, no manual
invalidation.

### 2.2 HTTP/2 (or HTTP/3) multiplexing

A single chart pan fires dozens of tile requests. Over HTTP/1.1 (6-connection cap + a TLS
handshake each) that's visibly slow on a Pi. **HTTP/2 multiplexes them over one connection** —
one handshake, many concurrent tiles. This is the biggest single perceived-smoothness win and
should be in from day one.

### 2.3 Server-side tile cache + priority render queue

The engine renders S-52 on the main thread (CPU-bound on a Pi). So:

- **Render once, serve many.** A disk/memory tile cache keyed by the §2.1 ETag serves all
  clients and all future pans from one render. Fan-out to 3 displays costs ~1 render.
- **Visible-first priority.** The render queue prioritizes tiles inside requesting clients'
  `viewport` over speculative ones.
- **Pre-render the route corridor.** When a route loads, render tiles along the corridor at
  nav zooms at idle, so the client can **bulk-prefetch them for offline** (the selected-region
  offline-cache flow, applied to the thin client). Expose as `GET /prefetch?route=…` → a tile
  manifest the client downloads.

### 2.4 Compositing & the future vector path

- Serve **NODTA (no-data grey) as transparent PNG** so ENC composites *over* satellite (the
  "depth on satellite" vision) — already on the engine's next-increment list.
- **Later:** S-52 as **vector tiles (MVT) styled client-side** is far more bandwidth-efficient
  and resolution-independent than raster PNG — but that rides the clean-room/MapLibre-vector
  path ([ADR-0002](decisions/0002-enc-engine.md)). Raster is correct and proven for now; note
  vector as the bandwidth optimization, not a day-one requirement.

---

## 3. Alarms — the reliability tier (this is where lives are)

Anchor drag, depth, CPA/TCPA, MOB. These are **not** best-effort `nav` deltas. They get a
stronger contract:

- **Persisted until acknowledged.** The server holds an active alarm and **re-sends it on
  every (re)connect** until a client ACKs. A WiFi blip must not lose an anchor-drag alarm.
- **Explicit client ACK.** `{ "t":"ack", "alarm":"anchor-drag", "id":"a-9912" }`. Unacked
  alarms keep firing; the server tracks per-alarm state, not fire-and-forget.
- **Reaches a sleeping phone via APNs.** A foreground WebSocket can't wake a backgrounded /
  locked iPhone. Critical alarms (anchor drag, MOB, depth) are **also** pushed via Apple Push
  Notification service as **Critical Alerts** (bypass silent/Do-Not-Disturb — needs the Apple
  critical-alert entitlement). The boat server holds the device push tokens registered at
  pairing. This is the part that makes "anchor watch on your phone in your bunk" actually
  safe.
- **Local fallback.** If the server can't reach APNs (offline at anchor — the common case!),
  the *client that's currently connected* still alarms locally + schedules a local
  notification. APNs is the wake-a-sleeping-device path, not the only path.

```jsonc
{ "t":"alarm", "id":"a-9912", "kind":"anchor-drag", "sev":"critical", "seq":1101,
  "ts":1750000600.0, "msg":"Dragging — 38 m from set point (limit 30 m)",
  "data":{"setPoint":{"lat":24.55,"lon":-81.78},"radius_m":30,"now_m":38}, "needsAck":true }
```

---

## 4. Discovery — `_helm._tcp` over Bonjour/mDNS

No typing IP addresses. The server advertises a Bonjour service; the client browses and
connects:

- Server: advertise `_helm._tcp.local` (TXT: `v=1`, `name=Helm Demo`, `tls=1`,
  `fp=<cert-fingerprint>`). On macOS/Pi this is `dns-sd`/Avahi.
- Client: `NWBrowser` (Network.framework) lists boats; tap to connect. `helm.local` as the
  friendly host.
- **Fallbacks:** last-known address pinned in client storage (reconnect instantly on the same
  boat without a browse); manual `host:port` entry for routed/VPN setups.

---

## 5. Security & pairing (mandatory on a shared marina network)

iOS App Transport Security blocks plaintext HTTP/WS anyway, so we lean into TLS:

- **TLS with TOFU pin.** Server generates a self-signed cert on first boot. **Pairing** is
  trust-on-first-use: the server shows a **QR code** (or a 6-digit PIN); the client scans it,
  receives the cert fingerprint + a bearer token, and **pins** the cert. No CA, works fully
  offline. (Bonjour TXT carries the fingerprint so the client can verify the browse result
  matches the paired cert.)
- **Bearer token per client** on `/nav`, `/chart`, `/catalog`. `/health` stays open and tiny.
  A stranger on the marina WiFi gets nothing without pairing — and crucially **cannot inject a
  fake MOB/anchor alarm**.
- **ATS:** prefer the pinned-TLS path so no global ATS exception is needed; if a plain-HTTP
  local-dev mode exists, scope the ATS exception to `.local` only and never ship it as the
  default.
- **Roles (later):** a "view-only" guest token vs. an "owner" token that can activate routes /
  ack alarms / change the active waypoint.

---

## 6. The iOS client stack (the other half of "world-class")

The protocol is half the experience; the iOS client is the other half.

- **First proof, today:** the existing [web/](../web/) UI in a `WKWebView` pointed at
  `https://helm.local`. It already runs in a plain browser and is fully decoupled — change the
  two URLs in [web/style.json](../web/style.json) / `nav-source.js` from `127.0.0.1` to the
  Bonjour host and an iPad renders real S-52 under live nav with **zero new code**. Ship this
  to prove the path before investing in native.
- **Production posture:** web-first. The shared [web/](../web/) client remains the product UI across
  desktop, iPad, and phone: MapLibre GL JS for map composition, WebGPU where the browser can carry
  dense weather/field/particle layers, and explicit WebGL/server-raster fallbacks where it cannot.
  The native iOS shell owns OS integration and evidence gathering, not a second chart UI:
  - `NWBrowser` for Bonjour discovery + pairing.
  - `WKWebView` loading the boat-server origin and reporting WebGPU/WebGL/MapLibre/service-worker
    capability so we know when the web path is enough.
  - `NWPathMonitor`, background alarm plumbing, APNs critical alerts, and token/cert storage later.
  - Keep the GPL engine off the device — the client links **no** OpenCPN code (the arm's-length
    boundary from [ADR-0006](decisions/0006-server-client-thin-display.md)).
  Native **SwiftUI + MapLibre-iOS/Metal** is an escalation path only if the WKWebView/WebGPU gate
  proves a hard product limit that the shared web client cannot solve.

---

## 7. Latency budget — what it should *feel* like

| Action | Target (boat LAN) | How |
|--------|-------------------|-----|
| GPS fix → ownship moves on screen | < 250 ms | small `nav` delta push + cheap render |
| Pan to already-viewed area | instant | immutable on-disk tile cache |
| Pan to fresh area | tiles stream visible-first | HTTP/2 multiplex + server cache; satellite/cached basemap underneath so **never blank** |
| Reconnect after a WiFi blip | < 2 s to LIVE | backoff + `lastSeq` snapshot resume |
| Anchor-drag alarm → buzzing phone in your bunk | seconds | APNs critical alert + persisted/re-sent until ACK |

Guiding rule: **on a good link it's indistinguishable from running locally; on a bad link it
degrades visibly and honestly, and it never lies about position.**

---

## 8. Build order (incremental, each step shippable)

1. **One TLS origin + Bonjour.** Merge the two ports behind TLS; advertise `_helm._tcp`;
   `WKWebView` client connects by name. *(Proves the boat-server path end-to-end.)*
2. **Snapshot/delta + seq + staleness.** Reframe the existing 1 Hz blob; add the LIVE/STALE/
   OFFLINE indicator. *(Biggest safety + bandwidth win.)*
3. **Reconnect/resume + latest-wins backpressure.** Survive boat WiFi.
4. **Immutable tile caching + HTTP/2 + server tile cache.** Smooth pan + cheap fan-out on a Pi.
5. **Channels + bbox-culled AIS.** Battery/bandwidth scaling; busy-harbor AIS.
6. **Alarms reliability tier + APNs critical alerts.** Anchor watch you can sleep through.
7. **Pairing/TLS-pin + tokens.** Safe on a shared marina network.
8. **iPad web-render capability gate.** Prove the WKWebView path reports MapLibre/WebGPU/WebGL,
   safe-area, service-worker, and viewport readiness before considering native MapLibre/Metal.
9. **Route-corridor prefetch / offline bundles.** Leave-the-boat resilience.
10. **Native SwiftUI/MapLibre client only if proven necessary.** Escalate after evidence, not by
    default.

Steps 1–4 already turn the proven Phase 2 engine into a genuinely usable iPad chartplotter
over boat WiFi; 5–9 make the web-first client world-class.
