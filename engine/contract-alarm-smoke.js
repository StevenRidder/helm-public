#!/usr/bin/env node
// contract-alarm-smoke.js — CONTRACT-owned executable proof of the FROZEN ALARM WIRE SCHEMA (v1)
// and the latest-wins coalescer (CONTRACT-9), exercised against the REAL web/nav-client.js.
//
//   node engine/contract-alarm-smoke.js
//
// Dependency-free. Loads web/nav-client.js (a browser IIFE) in Node behind a fake window +
// fake WebSocket we fully control, then drives raise/update/clear/resend/replay/ack frames and
// asserts the client's reliability behaviour. Because the assertions ARE the schema, this file is
// also the unambiguous spec the ENGINE/ALARM team implements the server emit + resend-until-ACK
// loop against. See docs/CONTRACT-ALARM-SCHEMA.md for the prose contract.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'nav-client.js'), 'utf8');

// ---------- fake WebSocket we drive by hand (deterministic, no real sockets) ----------
let WS_REGISTRY = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; WS_REGISTRY.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose(); }
  _open() { this.readyState = 1; this.onopen && this.onopen(); }
  _msg(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
}
const ep = { navUrl: () => 'ws://127.0.0.1:0/nav', describe: () => '127.0.0.1:0' };

// Build a fresh HelmNavClient bound to its own fake window/socket.
function makeClient(extraOpts) {
  WS_REGISTRY = [];
  const win = { HelmEndpoint: ep };
  new Function('window', 'WebSocket', 'HelmEndpoint', SRC)(win, FakeWS, ep);
  const ev = { states: [], statuses: [], alarms: [], clears: [], frames: [] };
  // deterministic coalescing flush: collect rAF callbacks, run them on demand
  const frameCbs = [];
  const flushFrames = () => { const cbs = frameCbs.splice(0); cbs.forEach(cb => cb()); };
  const opts = Object.assign({
    simGraceMs: 1e9,                              // never fall back to sim during the test
    scheduleFrame: cb => frameCbs.push(cb),       // we flush manually → coalescing is deterministic
  }, extraOpts || {});
  const client = win.HelmNavClient(
    s => ev.states.push(JSON.parse(JSON.stringify(s))),
    st => ev.statuses.push(st),
    opts);
  const ws = () => WS_REGISTRY[WS_REGISTRY.length - 1];
  return { client, ws, ev, flushFrames, opts, frameCbs };
}

// ---------- tiny assert harness ----------
let failures = 0, passes = 0;
function ok(cond, label) { if (cond) { passes++; console.log('  ✓ ' + label); } else { failures++; console.error('  ✗ FAIL: ' + label); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ACK_WAIT = 320;   // > ACK_DEBOUNCE_MS (250) so the batched alarm.ack has flushed
const lastAck = ws => [...ws.sent].reverse().find(f => f.t === 'alarm.ack');
const alarmAcks = ws => ws.sent.filter(f => f.t === 'alarm.ack');

function raise(o) { return Object.assign({ t: 'alarm', op: 'raise', rev: 1, kind: 'anchor', sev: 'critical', msg: 'm' }, o); }

async function run() {
  // ============================================================================================
  console.log('\n[1] BACK-COMPAT: existing snapshot/delta/ping contract + coalescing latest-wins');
  {
    const h = makeClient({});
    h.ws()._open();
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 10, lon: 20 }, sog: 5, cog: 90 });
    h.ws()._msg({ t: 'delta', seq: 2, sog: 6 });
    h.ws()._msg({ t: 'delta', seq: 3, cog: 95 });            // burst of 3 nav frames, no flush yet
    ok(h.ev.states.length === 0, 'nav frames are COALESCED — no onState until the frame flush');
    h.flushFrames();
    ok(h.ev.states.length === 1, 'a burst of 3 nav frames collapses to ONE onState (latest-wins)');
    const s = h.ev.states[0];
    ok(s && s.sog === 6 && s.cog === 95 && s.pos.lat === 10, 'the single delivered state is the merged LATEST (sog6/cog95, snapshot pos kept)');
    h.ws()._msg({ t: 'ping' });                              // heartbeat — not a nav frame
    h.flushFrames();
    ok(h.ev.states.length === 1, 'ping does not produce an onState');
    ok(h.ev.statuses.some(x => x.phase === 'live'), 'classifies LIVE (real pos, fresh age)');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[2] coalesce:false restores synchronous per-frame onState');
  {
    const h = makeClient({ coalesce: false });
    h.ws()._open();
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 1, lon: 2 }, sog: 1 });
    h.ws()._msg({ t: 'delta', seq: 2, sog: 2 });
    ok(h.ev.states.length === 2, 'with coalesce:false every frame delivers synchronously (2 onState)');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[3] ALARM raise → fires once, transport-ACKed; resend → re-ACKed, NOT re-fired');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }), onAlarmClear: id => h.ev.clears.push(id) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging 47m' }));
    ok(h.ev.alarms.length === 1 && h.ev.alarms[0].meta.isNew === true, 'raise → onAlarm fired once, isNew:true');
    ok(h.ev.states.length === 0, 'alarm did NOT produce an onState (alarm ≠ nav)');
    // resend the SAME (id,gen,rev) twice
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging 47m' }));
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging 47m' }));
    ok(h.ev.alarms.length === 1, 'resend of same (id,gen,rev) does NOT re-fire onAlarm (idempotent)');
    await sleep(ACK_WAIT);
    const acks = alarmAcks(h.ws());
    ok(acks.length >= 1, 'at least one batched alarm.ack was sent');
    const flat = acks.flatMap(a => a.acks);
    ok(flat.some(e => e.id === 'anchor' && e.rev === 1), 'transport-ack carries {id:"anchor",rev:1} (stops the resend) — re-sends are still ACKed');
    ok(acks[0].acks.length === 1 && acks[0].alarm === 'anchor', 'single-entry ack also sets the back-compat alarm=<id> shim');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[4] ALARM update (rev++) re-renders; preserves user-ack; escalation resets ack');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'depth', gen: 0, rev: 1, kind: 'depth', sev: 'warning', msg: '2.9m' }));
    ok(h.ev.alarms.length === 1, 'warning raise fired');
    h.client.ackAlarms(['depth']);                                  // user silences it
    ok(h.client.alarms().depth.acked === true, 'user-ack set acked=true locally');
    h.ws()._msg(raise({ id: 'depth', gen: 0, rev: 2, op: 'update', kind: 'depth', sev: 'warning', msg: '2.7m' }));
    ok(h.ev.alarms.length === 2 && h.ev.alarms[1].meta.escalated === false, 'same-sev update re-renders (escalated:false)');
    ok(h.client.alarms().depth.acked === true, 'acked PRESERVED across a same-sev update (stays silent)');
    h.ws()._msg(raise({ id: 'depth', gen: 0, rev: 3, op: 'update', kind: 'depth', sev: 'critical', msg: '1.9m!' }));
    ok(h.ev.alarms[2].meta.escalated === true, 'warning→critical update reports escalated:true');
    ok(h.client.alarms().depth.acked === false, 'escalation RESETS acked → the critical-beep poll re-alerts');
    // update on an UNSEEN id is treated as a raise (lost-raise recovery)
    h.ws()._msg(raise({ id: 'xte', gen: 0, rev: 5, op: 'update', kind: 'xte', sev: 'warning', msg: 'off course' }));
    ok(h.ev.alarms.length === 4 && h.ev.alarms[3].meta.isNew === true, 'update on an unseen id is handled as a raise (isNew:true)');
    await sleep(ACK_WAIT);
    const flat = alarmAcks(h.ws()).flatMap(a => a.acks);
    ok(flat.some(e => e.id === 'depth' && e.rev === 3), 'ack converges to the HIGHEST rev (depth rev3), not one ack per rev');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[5] CLEAR removes the alarm + is transport-ACKed; gen bump beats a stale higher rev');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }), onAlarmClear: id => h.ev.clears.push(id) });
    h.ws()._open();
    // 5a — clear-ack in isolation (raise, let its ack flush, THEN clear, let that ack flush)
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging' }));
    ok(h.client.alarms().anchor !== undefined, 'anchor alarm present');
    await sleep(ACK_WAIT);                              // flush the raise-ack so it can't mask the clear-ack
    h.ws()._msg({ t: 'alarm.clear', id: 'anchor', gen: 0, rev: 2, reason: 'resolved' });
    ok(h.ev.clears.length === 1 && h.ev.clears[0] === 'anchor', 'alarm.clear → onAlarmClear(id) fired');
    ok(h.client.alarms().anchor === undefined, 'cleared alarm removed from the live set');
    await sleep(ACK_WAIT);
    const flat = alarmAcks(h.ws()).flatMap(a => a.acks);
    ok(flat.some(e => e.id === 'anchor' && e.rev === 2), 'the CLEAR is transport-ACKed (rev2) — a missed clear cannot leave a phantom banner');
    // 5b — a stale in-flight (gen0,rev9) must NOT shadow a fresh post-restart raise (gen1,rev1)
    h.ws()._msg(raise({ id: 'g', gen: 1, rev: 1, msg: 'fresh after restart' }));
    ok(h.client.alarms().g && h.client.alarms().g.gen === 1, 'fresh raise (gen1,rev1) accepted');
    h.ws()._msg(raise({ id: 'g', gen: 0, rev: 9, msg: 'STALE pre-restart' }));
    ok(h.client.alarms().g.gen === 1 && h.client.alarms().g.rev === 1, '(gen1,rev1) is NOT shadowed by a stale (gen0,rev9) — lexicographic (gen,rev)');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[6] COALESCING EXEMPTION: an alarm in a nav burst is delivered IMMEDIATELY, never dropped');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 0, lon: 0 }, sog: 1 });
    h.ws()._msg({ t: 'delta', seq: 2, sog: 2 });
    h.ws()._msg(raise({ id: 'sart:271041234', gen: 0, rev: 1, kind: 'sart', sev: 'critical', silenceable: false, msg: 'SART DISTRESS' }));
    h.ws()._msg({ t: 'delta', seq: 3, sog: 3 });
    ok(h.ev.alarms.length === 1, 'the alarm fired SYNCHRONOUSLY, mid-burst, WITHOUT waiting for the nav flush (exempt from coalescing)');
    ok(h.ev.states.length === 0, 'the surrounding nav deltas are still coalesced (no onState yet)');
    h.flushFrames();
    ok(h.ev.states.length === 1 && h.ev.states[0].sog === 3, 'after flush the nav burst collapses to one latest state (sog3) — alarm never disturbed it');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[7] SAFETY INVARIANT: alarms NEVER refresh the staleness clock (the #1 marine-safety rule)');
  {
    // 7a — alarms-only feed never classifies live/simpos/lagging
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging' }));
    h.ws()._msg(raise({ id: 'depth', gen: 0, rev: 1, kind: 'depth', sev: 'warning', msg: 'shallow' }));
    ok(h.ev.alarms.length === 2, 'alarms-only feed: handled');
    ok(!h.ev.statuses.some(x => ['live', 'simpos', 'lagging'].includes(x.phase)), 'alarms-only feed never classifies live/simpos/lagging');
    h.client.stop();
  }
  {
    // 7b — the realistic regression: LIVE, then the nav feed DIES while the engine keeps RESENDING a
    // critical alarm. The badge MUST go STALE; an alarm resend must not refresh lastFrameAt or lastSeq.
    // (This is the scenario a vacuous everEngine=false test cannot exercise — it drives the real
    // setInterval(classify,500) watchdog with the clock advanced past STALE_MS.)
    const realNow = Date.now;
    const h = makeClient({ onAlarm: (m) => h.ev.alarms.push(m) });
    h.ws()._open();
    h.ws()._msg({ t: 'snapshot', seq: 5, sources: { pos: 'gps' }, pos: { lat: 10, lon: 20 }, sog: 5 }); // everEngine=true, lastFrameAt=now
    h.flushFrames();
    ok(h.ev.statuses.some(x => x.phase === 'live'), 'starts LIVE on a real fix');
    const base = realNow();
    global.Date.now = () => base + 20000;                          // feed dies: clock jumps 20s past the last fix
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 7, seq: 999, msg: 'dragging (resend over a dead nav feed)' }));
    ok(h.ev.alarms.length === 1, 'the alarm resend over the dead feed was still handled');
    await sleep(620);                                              // let the real 500ms watchdog tick classify()
    const last = h.ev.statuses[h.ev.statuses.length - 1];
    ok(last && last.phase === 'stale', 'feed dead 20s ⇒ classify reports STALE despite alarm resends (got ' + (last && last.phase) + ') — alarms cannot fake LIVE');
    ok(last && last.seq === 5, 'lastSeq stayed at the snapshot (5); the alarm seq:999 never advanced it (got ' + (last && last.seq) + ')');
    global.Date.now = realNow;
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[8] LEGACY FALLBACK: no onAlarm wired → alarms ride onStatus phase:"alarm", deduped');
  {
    const h = makeClient({});   // NO onAlarm/onAlarmClear — exactly today's index.html wiring
    h.ws()._open();
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, kind: 'anchor', sev: 'critical', msg: 'dragging 47m' }));
    const alarmStatuses = () => h.ev.statuses.filter(x => x.phase === 'alarm');
    ok(alarmStatuses().length === 1, 'raise surfaces via onStatus phase:"alarm" (legacy index.html → __alarms.fromEngine)');
    const a = alarmStatuses()[0].alarm;
    ok(a && a.kind === 'anchor' && a.sev === 'critical' && a.msg === 'dragging 47m', 'legacy payload carries {kind,sev,msg} — fromEngine renders it unchanged');
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, kind: 'anchor', sev: 'critical', msg: 'dragging 47m' }));   // resend
    ok(alarmStatuses().length === 1, 'a re-sent alarm does NOT re-fire the legacy path (deduped in nav-client) — fixes fromEngine non-idempotency');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[9] RECONNECT: hello re-includes held alarms (lastAlarmAck); replay dedups, new fires');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    const hello1 = h.ws().sent.find(f => f.t === 'hello');
    ok(hello1 && hello1.lastAlarmAck === undefined, 'first hello has NO lastAlarmAck (nothing held yet)');
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 0, lon: 0 }, sog: 1 }); // everEngine=true → a drop reconnects
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 2, msg: 'dragging' }));
    h.ws()._msg(raise({ id: 'sart:1', gen: 0, rev: 1, kind: 'sart', sev: 'critical', msg: 'SART' }));
    ok(h.ev.alarms.length === 2, 'two alarms held before the drop');
    h.ws().close();                                   // WiFi flap (socket onclose → reconnect)
    // wait for the backoff reconnect to spin up a new socket
    let tries = 0; while (WS_REGISTRY.length < 2 && tries++ < 40) { await sleep(50); }
    ok(WS_REGISTRY.length >= 2, 'client reconnected (new socket) after the drop');
    h.ws()._open();
    const hello2 = [...h.ws().sent].reverse().find(f => f.t === 'hello');
    ok(hello2 && Array.isArray(hello2.lastAlarmAck) && hello2.lastAlarmAck.length === 2, 'reconnect hello carries lastAlarmAck for both held alarms');
    ok(hello2.lastAlarmAck.some(e => e.id === 'anchor' && e.rev === 2), 'lastAlarmAck reports the held (id,rev) so the server can skip re-asserting them');
    // server re-asserts: anchor at the SAME (gen,rev) (replay) → dedup; a NEW id → fires
    const before = h.ev.alarms.length;
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 2, op: 'raise', replay: true, msg: 'dragging' }));
    ok(h.ev.alarms.length === before, 'replay of an already-held alarm at the same (gen,rev) does NOT re-fire');
    h.ws()._msg(raise({ id: 'mob', gen: 0, rev: 1, op: 'raise', replay: true, kind: 'mob', sev: 'critical', msg: 'MOB' }));
    ok(h.ev.alarms.length === before + 1, 'a re-asserted alarm the client had MISSED still fires (idempotent recovery)');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[10] user-ack frame shape');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'dragging' }));
    await sleep(ACK_WAIT);                              // let the auto transport-ack flush first
    h.client.ackAlarms(['anchor']);                    // skipper taps ACK
    await sleep(ACK_WAIT);
    const userAck = alarmAcks(h.ws()).flatMap(a => a.acks).find(e => e.id === 'anchor' && e.user === true);
    ok(!!userAck && userAck.rev === 1, 'ackAlarms emits an alarm.ack entry with user:true at the current rev');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[11] ack frame SHAPE: multi-id batches into ONE frame, no single-entry shim; additive keys pass through');
  {
    const h = makeClient({ onAlarm: (m) => h.ev.alarms.push(m) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'anchor', gen: 0, rev: 1, msg: 'drag' }));
    h.ws()._msg(raise({ id: 'depth', gen: 0, rev: 1, kind: 'depth', sev: 'info', msg: 'note', silenceable: false, expiresTs: 123, data: { value: 2.9, foo: 'x' } }));
    ok(h.ev.alarms.length === 2 && h.ev.alarms[1].sev === 'info', 'an "info" severity raise is accepted and fires (superset of critical|warning)');
    const got = h.ev.alarms[1];
    ok(got.silenceable === false && got.expiresTs === 123 && got.data && got.data.foo === 'x', 'additive/unknown fields (silenceable/expiresTs/data.*) pass through to onAlarm intact');
    await sleep(ACK_WAIT);
    const acks = alarmAcks(h.ws());
    ok(acks.length === 1, 'two ids acked in ONE batched alarm.ack frame (not one frame per id)');
    ok(acks[0].acks.length === 2, 'the batch carries both entries');
    ok(acks[0].alarm === undefined, 'the single-entry alarm=<id> shim is ABSENT on a multi-entry ack');
    h.client.stop();
  }

  // ============================================================================================
  console.log('\n[12] critical→critical update preserves user-ack; a frame after stop() is ignored');
  {
    const h = makeClient({ onAlarm: (m, meta) => h.ev.alarms.push({ m, meta }) });
    h.ws()._open();
    h.ws()._msg(raise({ id: 'mob', gen: 0, rev: 1, kind: 'mob', sev: 'critical', msg: 'MOB' }));
    h.client.ackAlarms(['mob']);
    ok(h.client.alarms().mob.acked === true, 'user-acked a critical');
    h.ws()._msg(raise({ id: 'mob', gen: 0, rev: 2, op: 'update', kind: 'mob', sev: 'critical', msg: 'MOB 120m' }));
    ok(h.client.alarms().mob.acked === true, 'critical→critical update PRESERVES acked (no spurious re-alert)');
    const before = h.ev.alarms.length;
    h.client.stop();
    h.ws()._msg(raise({ id: 'late', gen: 0, rev: 1, msg: 'after stop' }));   // late frame on the torn-down client
    ok(h.ev.alarms.length === before, 'a frame arriving after stop() fires no onAlarm (closed guard)');
  }

  // ============================================================================================
  console.log('\n[13] FAIL-FAST: non-conformant alarm frames are surfaced LOUDLY, not silently coerced or dropped');
  {
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warns.push(a.map(x => typeof x === 'string' ? x : '').join(' ')); };
    try {
      const h = makeClient({ onAlarm: (m) => h.ev.alarms.push(m) });
      h.ws()._open();
      // missing rev (REQUIRED) — must WARN but still render (surface AND continue, never drop a safety alarm)
      h.ws()._msg({ t: 'alarm', op: 'raise', id: 'depth', kind: 'depth', sev: 'warning', msg: 'shallow' });
      ok(warns.some(w => /NON-CONFORMANT/.test(w) && /rev/.test(w)), 'a missing rev is surfaced as NON-CONFORMANT');
      ok(h.ev.alarms.length === 1, '...but the renderable alarm is NOT dropped');
      // missing id — defaults to kind, warns, renders (no silent drop of a safety alarm)
      h.ws()._msg({ t: 'alarm', op: 'raise', rev: 1, kind: 'anchor', sev: 'critical', msg: 'drag' });
      ok(warns.some(w => /defaulted to kind "anchor"/.test(w)), 'a missing id is surfaced and defaulted to kind');
      ok(h.client.alarms().anchor !== undefined, '...and the alarm is keyed under the kind-derived id');
      // out-of-enum sev + out-of-range rev are surfaced
      warns.length = 0;
      h.ws()._msg(raise({ id: 'bad', gen: 0, rev: 2147483648, sev: 'meh', msg: 'bad' }));
      ok(warns.some(w => /sev="meh"/.test(w)), 'an out-of-enum sev is surfaced');
      ok(warns.some(w => /rev=2147483648/.test(w)), 'an out-of-int32-range rev is surfaced (not silently wrapped by |0)');
      // a fully conformant frame produces ZERO noise (no false positives)
      warns.length = 0;
      h.ws()._msg(raise({ id: 'clean', gen: 0, rev: 1, msg: 'ok' }));
      ok(warns.length === 0, 'a conformant frame produces zero warnings');
      h.client.stop();
    } finally { console.warn = realWarn; }
  }

  // ---------- report ----------
  console.log('\n' + (failures ? '❌ ' : '✅ ') + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error('harness threw:', e); process.exit(2); });
