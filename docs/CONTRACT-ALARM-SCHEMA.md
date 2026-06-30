# CONTRACT-10 — Frozen Alarm Wire Schema (v1)

> **Status:** FROZEN. Owned by the **CONTRACT** epic. The required field set below will not change;
> every new alarm type adds only new `id`/`kind` conventions and new `data.*` keys. This is the
> contract the blocked tasks build onto: **AIS-5** (guard-zone), **AIS-7** (SART/DSC), **ALARM-6**
> (MOB), **ALARM-7** (geo boundary), **BOARD-4** (per-tile threshold), **CONTRACT-16** (APNs).
>
> The **decode + client reliability path** lives in [`web/nav-client.js`](../web/nav-client.js) — the
> singly-owned alarm decode point. Consumers subscribe to typed events; they never parse alarm frames.
> The **engine-side emit + persist + resend-until-ACK** is a separate consuming concern (ENGINE/ALARM)
> — see [§7 Engine-side handoff](#7-engine-side-handoff). **LANDED** (ENGINE/ALARM): `helm_server.cpp`
> now generates alarms server-side over this schema — **anchor-drag** (from a persisted `anchor.set`
> setpoint, so the boat keeps watch with no phone connected) and **depth** (real-source-gated) — with a
> per-connection active set, `gen`/`rev` revisions, resend-until-`alarm.ack`, and `alarm.clear` on
> resolve; `mock-engine.js` mirrors it for offline client dev; SHELL/ALARM wire `onAlarm`/`onAlarmClear`
> → banner/beep. Proven by `engine/alarm-producer-smoke.js` (raise→resend→ack→clear) + a live one-origin
> run. An executable spec + 42 assertions live in
> [`engine/contract-alarm-smoke.js`](../engine/contract-alarm-smoke.js) (`node engine/contract-alarm-smoke.js`).

## 0. Why a reliability tier

Alarms ride the same `/nav` WebSocket as nav frames, but a missed anchor-drag or SART must never be
silently lost over flaky boat WiFi, and a re-sent alarm must never re-blast a banner the skipper
already silenced. So the alarm channel is **persist + resend-until-ACK**, **idempotent on the client**,
and **exempt from the latest-wins coalescer** (CONTRACT-9). Three signals are kept independent:

| signal | who | effect | stops resend? | removes alarm? |
|---|---|---|---|---|
| **transport-ACK** | client, automatic, every frame | server stops resending that `(id,gen,rev)` | yes | no |
| **user-ACK** (`user:true`) | skipper taps ACK | silences beep/animation locally | **no** | no |
| **server clear** (`alarm.clear`) | engine | removes the alarm | n/a | **yes** |

`receive ≠ silence ≠ resolve`.

## 1. Frame types

All three share the `"alarm"` prefix → one cheap string test routes them and exempts them from
coalescing. None collide with `snapshot|delta|ping` or `conn.*|route.*|track.*`.

| `t` | direction | meaning |
|---|---|---|
| `"alarm"` | server → client | one ACTIVE alarm record (`op:"raise"|"update"`). **One alarm per frame, never an array.** |
| `"alarm.clear"` | server → client | one alarm REMOVED (resolved/expired/superseded). |
| `"alarm.ack"` | client → server | transport-ACK and/or user-ACK; **batchable**. |

## 2. `t:"alarm"` (server → client)

**Required (the freeze surface):** `{ t, op, id, rev, kind, sev, msg }`

| field | type | meaning |
|---|---|---|
| `t` | `"alarm"` | discriminator. |
| `op` | `"raise"\|"update"` | lifecycle verb. Unknown op ⇒ treat as `update`. `update` on an **unseen** id ⇒ treat as a raise (a lost raise + delivered update must not no-op). |
| `id` | string | **stable** server-minted identity, unique for the condition's life; stable across raise→update and reconnect re-assert. `"<kind>"` for singletons, `"<kind>:<scope>"` for multi-instance. **The dedup + ACK + banner key.** Any numeric scope embedded in an id is **epoch seconds**. |
| `rev` | int ≥ 1 | monotonic per `(id,gen)`; 1 on raise, +1 per update. **FULL-STATE** revision, not a diff. |
| `kind` | string | legacy alarm class for `alarms.js` (`depth\|anchor\|xte\|arrival\|mob\|guardzone\|sart\|dsc\|boundary\|tile\|…`). Identity is `id`; `kind` drives icon/sort/legacy-fallback. New kinds additive. |
| `sev` | `"critical"\|"warning"\|"info"` | superset of today's `critical\|warning` (`fromEngine` reads `sev\|\|'warning'`, so `info` is non-breaking). |
| `msg` | string | server-rendered banner text — the only field the generic banner must render. |

**Optional / additive** (default to safe behavior when omitted; future consumers add fields **here**,
never to the required set):

| field | type | meaning |
|---|---|---|
| `gen` | int ≥ 0 | generation/epoch (process or navobj-reload counter). Ordering is **lexicographic `(gen,rev)`** so a fresh `rev=1` after an engine restart / id reuse is never shadowed by a stale higher rev. Absent ⇒ `0`. |
| `seq` | int | same global stream counter as snapshot/delta. **Advisory only** — does NOT gate idempotency (`(gen,rev)` does) and is **not** written to the client's `lastSeq`. |
| `prio` | int (lower=urgent) | ordering within a sev tier. Absent ⇒ derive from sev (10/50/90). Anchors: mob=0, sart/dsc=5, cpa=10, anchor=20. |
| `raisedTs` | epoch s | when the condition first went active; constant across revs. |
| `ts` | epoch s | server send time of this frame. |
| `lat`,`lon` | number | one representative position (MOB fix / breach / SART). **Absent ⇒ no chart mark** — never render a marker at 0,0. |
| `silenceable` | bool (default true) | `false` ⇒ user-ACK may NOT stop the beep; only a server clear removes it (MOB/SART). → APNs `.critical` that pierces mute. |
| `expiresTs` | epoch s \| null | if set, the client MAY locally expire it when the socket is dead past it. null/absent ⇒ sticky until `alarm.clear`. |
| `apns` | `"critical"\|"time-sensitive"\|"passive"` | explicit APNs override (CONTRACT-16). Absent ⇒ derived from sev. |
| `replay` | bool (default false) | set on reconnect re-assert; **cosmetic** (client MAY suppress a beep-storm). Correctness does not depend on it. |
| `data` | object (flat) | typed payload for specialized consumers. The generic banner **never** reads it. **Unknown keys MUST be ignored.** `data.op` (a BOARD-4 comparator) is namespaced and distinct from the top-level `op` verb. |

## 3. `t:"alarm.clear"` (server → client)

**Required:** `{ t, id }`. Optional: `reason`(`"resolved"|"expired"|"superseded"`, default `resolved`),
`rev`, `gen`, `kind`, `msg` (transient toast text), `seq`, `ts`. Clearing an absent id is a no-op.
Client: remove the banner **and** drop `id` from the dedup map. Server-authoritative removal, distinct
from user-ACK.

## 4. `t:"alarm.ack"` (client → server)

**Required:** `{ t, acks:[ {id, rev, gen?, user?} ] }`. Optional: `ts`, `alarm` (single-entry shim — a
one-alarm ack SHOULD also set `alarm:"<id>"`). Batchable so a reconnecting client acks everything in
one frame.

- Every entry is implicitly a **transport-ACK** — sent automatically on receipt of **every**
  alarm/clear frame, including dedup'd duplicates, replays, and clears.
- `user:true` marks it **also** a user-ACK (implies transport-ACK); never stops resends, never removes.
- **Debounce (frozen):** the client batches ≤ 250 ms and emits **one** transport-ack per id for the
  **highest seen `(gen,rev)`** (not one per rev) — a burst of updates yields a single converging ack.

## 5. Client reliability rules (implemented in `nav-client.js`)

State: `Map<id,{gen,rev,sev,acked}>`; ordering `cmp := (gen,rev)` lexicographic. On every alarm/clear
frame:

1. **Always** enqueue a transport-ack for `(id,gen,rev)` — duplicates, replays, clears included.
2. `alarm.clear` → delete `map[id]`; remove banner. Done.
3. `(gen,rev) ≤ seen` → **dup/resend/reorder**: do not re-render, re-beep, or touch `acked`.
4. id **unseen** (or update-on-unseen) → **new**: fire; `map[id]={gen,rev,acked:false}`.
5. `(gen,rev) > seen` → **update**: re-render; **preserve `acked`** when sev unchanged; **reset
   `acked`** on escalation to `critical` (the `alarms.js` beep is a poll over `!acked && critical`).

**Safety invariant:** alarm handling returns *before* the `everEngine/lastFrameAt/lastSeq` nav block
and never calls `onState`/`classify` — an alarm burst can never make a dead nav feed read LIVE.

## 6. Coalescing exemption (CONTRACT-9)

```
isCoalescable(f) := (f.t === "snapshot" || f.t === "delta")
```

Only nav state is coalesced latest-wins. Everything else — any `t` starting with `"alarm"`, plus
`ping`/`conn.*`/`route.*`/`track.*` — passes through verbatim, in order, never dropped, never merged.
One alarm per frame means no naive merge can fold two alarms; the only permitted reduction is same-id
newest-`(gen,rev)`. Even a dropped alarm is redelivered by resend-until-ACK.

## 7. Reconnect / replay & APNs

- `hello` is unchanged: `{t:"hello", lastSeq, subscribe:[…,"alarms"]}`. **Additive-optional:** the
  client includes `lastAlarmAck:[{id,gen,rev},…]` for alarms it already holds so the server may skip
  re-asserting them; omitting it ⇒ full re-assert (the safe default; servers must tolerate absence).
- On `hello` the server sends a fresh nav snapshot, then **re-asserts every currently-active alarm** as
  `op:"raise"` at its **current** `(gen,rev)`, original `raisedTs`, fresh `seq`, `replay:true`. Alarm
  state is a **set** (active-now), not a log — missed raises and missed clears both converge. The client
  uses the **same idempotent path**: unseen ⇒ fire; `≤ seen` ⇒ dedup.
- **APNs (CONTRACT-16):** from `apns` if present, else derived from sev — `critical+silenceable:false`
  → `.critical` (pierces mute); `critical` → `.critical`; `warning` → `.time-sensitive`; `info` →
  `.passive`. Use `id` as `apns-collapse-id` and carry `(id,gen,rev)` in the push so a pushed critical
  dedups against a live-socket raise; a phone user-ACK round-trips as `alarm.ack user:true`.

## 8. Consumer conventions (no future breaking change)

`kind+sev+msg` are always present (legacy `fromEngine` renders the degenerate case). Structured fields
live flat under `data.*` with standardized key names: `pos{lat,lon}`, `mmsi`, `zoneId`, `rangeM`,
`bearingDeg`, `value`, `threshold`, `hysteresis`, `path`.

| consumer | `id` | `kind` | key `data.*` |
|---|---|---|---|
| depth (existing) | `depth` | `depth` | `value, threshold, hysteresis` |
| anchor (existing) | `anchor` | `anchor` | `driftM, radiusM, bearingDeg, setPos{lat,lon}` |
| xte / arrival | `xte`, `arrival:<wpId>` | `xte`/`arrival` | `xteM,limitM,side` / `wpId,wpName,dtgNM` |
| **ALARM-6** MOB | `mob` (singleton) | `mob` | `markedTs,rangeM,bearingDeg,set,drift,elapsedS` · `sev:critical, silenceable:false, prio:0`, top-level `lat/lon` |
| **AIS-5** guard-zone | `guardzone:<zoneId>:<mmsi>` | `guardzone` | `mmsi,zoneId,name,rangeM,bearingDeg,sog,cog,cpaNM,tcpaMin` |
| **AIS-7** SART/DSC | `sart:<mmsi>` \| `dsc:<mmsi>` | `sart`/`dsc` | `mmsi,distressType,nature,receivedTs` · `sev:critical, silenceable:false, apns:critical` |
| **ALARM-7** boundary | `boundary:<zoneId>` | `boundary` | `zoneId, geometryRef, event, pos{lat,lon}, distanceM` |
| **BOARD-4** per-tile | `tile:<signalkPath>` | `tile` | `path,value,unit,threshold,op,hysteresis,tileId` |

> **CPA (collision.js) is NOT on the alarm channel in v1** — it is computed client-side from `s.ais`;
> routing it here would double-source the banner. `id:"cpa:<mmsi>"` / `kind:"cpa"` is **reserved**
> additive-only for a future engine-pushed path (`collision.fromAlarm`).

## 9. How consumers adopt it (SHELL / ALARM follow-ups — out of CONTRACT scope)

`nav-client.js` is back-compat **today** (the legacy `onStatus phase:'alarm' → __alarms.fromEngine`
path keeps working, now deduped). To get the full id-keyed lifecycle (multi-instance ids, server clear,
escalation re-beep, user-ACK on the wire), the shell wires the new callbacks (a **SHELL** edit to
`index.html`) and `alarms.js` is re-keyed from `kind` to `id` (an **ALARM** edit):

> ⚠️ **Partial-adoption hazard — `alarm.clear` does NOT work on the legacy path.** The legacy
> `fromEngine` is fire-only; it has no removal verb. So if an engine starts emitting `alarm.clear`
> **before** `onAlarmClear` is wired, the client transport-ACKs the clear (the server stops resending)
> but the banner stays up — a permanently sticky alarm. `nav-client.js` logs a one-shot `console.warn`
> when this happens. **Prerequisite:** wire `onAlarm`/`onAlarmClear` (SHELL) + add `clearById` (ALARM)
> **before** pointing a clear-emitting engine at the shipping client. Until then, an engine should emit
> only raises/updates (which the legacy path renders correctly).

```js
window.__navClient = HelmNavClient(applyNav,
  st => setSource(st.phase, st),                       // the phase:'alarm' branch becomes dead
  { onCommand: …,
    onAlarm:      (msg, meta) => __alarms.fromAlarm(msg, meta),  // fireById(msg.id, …); reset acked on meta.escalated
    onAlarmClear: (id)        => __alarms.clearById(id) });
// ACK button → __navClient.ackAlarms([...unacked ids])   (emits alarm.ack user:true)
```

`alarms.js`: re-key `active{}` from kind to `active[id]`; add `fromAlarm(msg,meta)` + `clearById(id)`;
keep `fromEngine` as a thin legacy fallback (`fireById(a.id||a.kind, a.kind, a.sev||'warning', a.msg||a.kind)`).

## 10. Engine-side handoff (ENGINE / ALARM — emit + persist + resend)

The server is the source of truth for the active alarm **set** and owns persist + resend-until-ACK.
Implement onto this frozen schema; do not alter required fields. The mock at `engine/mock-engine.js`
(ENGINE-owned) and the real engines currently emit **no** alarm frames — wiring them is the remaining
half of CONTRACT-10's reliability tier:

- **Emit:** raise with a stable id, `gen=<process/navobj generation>`, `rev=1`; on any change to a live
  condition, same id, `rev+1`, `op:"update"`, full state; on resolution, `alarm.clear` with the id (+
  `rev`/`gen` for the resend loop).
- **Persist + resend:** keep active alarms keyed by id with their current `(gen,rev)` and a per-rev
  "transport-acked?" flag. Resend the current `(gen,rev)` of every not-yet-acked alarm on a timer
  (~1–2 s, backing off) until its transport-ACK arrives; an update re-arms; clears resend until acked,
  then leave the set. **user-ACK never stops resends.**
- **Read acks:** parse `t:"alarm.ack"`, iterate `acks[]` (fall back to the single-entry `alarm` shim).
  `engine/mock-engine.js` currently matches `m.t==='ack'` (literal) — it must learn `'alarm.ack'` and
  iterate `m.acks` or the resend loop never converges in the mock.
- **Reconnect:** on `hello`, after the nav snapshot, re-assert the full active set as `op:"raise"` at
  current `(gen,rev)`, `replay:true` (honor `lastAlarmAck` if present).
- **gen:** bump on engine restart / navobj reload so `rev` can reset to 1 safely.
- **Coalescing/APNs:** apply latest-wins only to snapshot/delta; map APNs per §7.
