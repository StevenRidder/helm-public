# CONTRACT-7 — Channels / subscriptions + client-chosen nav rate

> **Status:** SHIPPED end-to-end. Client in [`web/nav-client.js`](../web/nav-client.js); server
> filtering + rate pacing + `sub.ack` in [`engine/vendor/cli/helm_server.cpp`](../engine/vendor/cli/helm_server.cpp)
> (CONTRACT touches it as a transport seam). Owned by **CONTRACT**. Verified by
> [`engine/contract-channels-smoke.js`](../engine/contract-channels-smoke.js) (client, 27 assertions) +
> [`engine/contract-channels-server-smoke.js`](../engine/contract-channels-server-smoke.js) (server
> end-to-end vs a running helm-server, 9 assertions). Gates **CONTRACT-8** (bbox-culled AIS).

## Why

One nav stream serves everything from a phone watching at anchor to a chartplotter underway. A client
should pay only for what it renders (bandwidth/battery over boat WiFi) and choose how fast it updates.
So the client **declares** the named channels it wants and a nav update **rate**; the server filters
frame content to the subscription and paces nav deltas to the rate.

## Channels

Named streams the client subscribes to. Known vocabulary (forward-compatible — unknown names are
forwarded with a warning):

| channel | frame content it gates |
|---|---|
| `nav` | core position/SOG/COG/HDG/depth/wind — **always subscribed, never droppable** (safety core) |
| `route` | active-route geometry + inspector (`active`, legs, ETA/DTG/XTE) |
| `alarms` | `t:"alarm"` / `alarm.clear` frames (CONTRACT-10) |
| `ais` | AIS targets array (`ais[]`) — the big one; bbox-culling rides this (CONTRACT-8). Each target carries a server-computed `risk` tier (ENGINE-13) |
| `track` | own-ship breadcrumb trail |
| `conns` | per-connection live status |

A frame includes a channel's fields only if that channel is subscribed. **Absent `subscribe` ⇒ all
channels** (back-compat: a client that says nothing gets everything, as today).

### AIS target `risk` tier (ENGINE-13)

Each `ais[]` row carries `risk: "danger" | "caution" | "normal"` — the collision-risk tier **computed
server-side** from the same authoritative thresholds the engine owns (`g_CPAWarn_NM` = 2.0 NM,
`g_TCPA_Max` = 30 min; caution = the 2× pre-alarm watch band). The rule (mirrors `web/ais-risk.js`):

- **`normal`** if CPA is not effectively valid (no real-speed/CPA solution) or `tcpa ≤ 0` (opening / past CPA)
- **`danger`** if `cpa < g_CPAWarn_NM && tcpa < g_TCPA_Max` (== the CPA alarm band)
- **`caution`** if `cpa < 2·g_CPAWarn_NM && tcpa < 2·g_TCPA_Max`
- **`normal`** otherwise

Clients **prefer `risk` over recomputing locally** (`web/ais-risk.js` `tier()` returns it verbatim), so
the thresholds live in ONE authoritative place and every surface (alarm / chart symbol / list / card /
overlay) classifies identically. `risk` is a UI gradient layered under the symbology overrides
(SART/lost are not risk tiers). Additive, non-breaking — the field set is otherwise unchanged.

## Nav rate

Integer **1–4 Hz**, the cadence the server emits nav `delta` frames at (keyframe/snapshot cadence and
the alarm/command planes are independent and **not** rate-paced — alarms are always immediate). The
client clamps out-of-range/non-numeric values and **surfaces** the coercion (fail-fast). **Absent
`rate` ⇒ the server default** (~1 Hz).

## AIS viewport bbox (CONTRACT-8)

An optional `bbox: [w, s, e, n]` (lat/lon degrees) narrows **only the `ais` channel** to that box: the
server omits AIS targets outside it. nav core, alarms, route, track and conns are **never**
bbox-filtered. This lets deck.gl render a busy harbour at scale by streaming only in-view targets
(AIS-8). The client typically sends the map's `getBounds()` expanded by a small margin so panning
shows targets just outside view; the server filters to exactly the box (and wraps the antimeridian if
`w > e`). **Absent `bbox` ⇒ all targets** (back-compat). `bbox: null` on a `sub.update` clears the
viewport. Rapid map-moves coalesce into one `sub.update` (~300 ms throttle). Invalid bbox (not 4
finite numbers) is surfaced and ignored (fail-fast).

## Wire contract

**`hello`** (client → server, on connect/reconnect) — unchanged shape, two additive fields:
```json
{ "t": "hello", "lastSeq": 4810, "subscribe": ["nav","route","alarms","ais","track","conns"],
  "rate": 2, "lastAlarmAck": [ ... ] }
```
- `subscribe` — desired channels (always includes `nav`). Omit ⇒ all.
- `rate` — desired nav Hz (1–4). Omit ⇒ server default.

**`sub.update`** (client → server, runtime re-negotiation without reconnect):
```json
{ "t": "sub.update", "subscribe": ["nav","ais"], "rate": 3 }
```
Sent by `setRate()`/`subscribe()`/`unsubscribe()`. Send is false-tolerant — if the socket is down the
change still takes effect on the next `hello` (state persists), so it converges over a flaky link.

**`sub.ack`** (server → client) — the **effective** config the server applied (it MAY clamp the rate
or drop unavailable channels):
```json
{ "t": "sub.ack", "subscribe": ["nav","ais","conns"], "rate": 2 }
```
The client records it as `effective` and fires `opts.onSub(effective)`; it is **also** surfaced on the
command plane (`opts.onCommand`). It is **not** a nav frame — it never touches the age/staleness clock.

## Client API (`web/nav-client.js`)

```js
const c = HelmNavClient(applyNav, setSource, {
  subscribe: ['nav','ais','alarms'],   // optional; default = all known channels
  rate: 2,                              // optional; 1–4 Hz; default = server default
  bbox: [w,s,e,n],                      // optional; AIS viewport (CONTRACT-8); default = all targets
  onSub: eff => { /* eff = { subscribe:[...], rate, bbox } the server actually applied */ },
});
c.setRate(4);                 // → sends sub.update; returns the clamped desired rate
c.subscribe(['track']);       // add channels → sub.update; returns desired subscribe[]
c.unsubscribe(['ais']);       // remove channels ('nav' is refused) → sub.update
c.setBbox([w,s,e,n]);         // CONTRACT-8: AIS viewport (throttled); setBbox(null) clears it
c.subscriptions();            // { desired:{subscribe,rate,bbox}, effective:{subscribe,rate,bbox}|null }
```

Desired state persists across reconnects (re-sent in `hello`). All sends are false-tolerant.

## Server implementation (`engine/vendor/cli/helm_server.cpp`)

Implemented onto the frozen contract (per-connection `ClientCfg` in `helm_server.cpp`):
1. **Parse `subscribe` + `rate`** from `hello` and `sub.update`; stored per-connection (keyed by the
   `ix::WebSocket*`, reconciled against live clients each tick). Absent `subscribe` ⇒ all channels;
   absent `rate` ⇒ default. `nav` is forced into every subscription (safety core).
2. **Filter frame content** by subscription — each channel is built once as a JSON fragment
   (`ais` / `conns` / `track` / `route`) and only spliced into a client's frame when subscribed; the
   `nav` core (pos/sog/cog/hdg/depth/wind/`active`) is always sent. (Note: the route *nav* fields ride
   the `nav` core; the `route` channel gates the route *geometry*.)
3. **Rate pacing** is per-client (`lastSentTick` + `everyN = NAV_SOURCE_HZ / rate`). **Effective rate
   is `min(requested, NAV_SOURCE_HZ)`** — and `NAV_SOURCE_HZ` is the ~1 Hz nav loop. The server
   **deliberately never streams faster than its data source**: upsampling would mean repeating or
   interpolating fixes, i.e. faking position between real samples — against Helm's honesty rule. So a
   client requesting 4 Hz honestly gets `sub.ack rate:1` today; wire a faster source/loop and higher
   effective rates follow with **no contract change**. (Snapshots/keyframes and the alarm/command
   planes are never rate-paced.)
4. **Reply `sub.ack`** with the effective `{subscribe, rate, bbox}` on `hello` and every `sub.update`.
5. **CONTRACT-8 bbox cull** (shipped): `ClientCfg.inBbox()` filters the per-target AIS vector to the
   client's `bbox` (antimeridian-aware); echoed in `sub.ack`. AIS is built once as a `{lat,lon,json}`
   vector per tick, then each client gets the full set or only the in-box targets.

**Remaining (additive):**
- A higher `NAV_SOURCE_HZ` (faster loop, time-based sim cadence) would make 2–4 Hz effective — only
  worth it with a sub-second-rate position source.
