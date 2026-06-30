#!/usr/bin/env node
// contract-channels-smoke.js — CONTRACT-owned proof of the channels/subscriptions + client-chosen
// nav-rate contract (CONTRACT-7), exercised against the REAL web/nav-client.js.
//
//   node engine/contract-channels-smoke.js
//
// Dependency-free. Loads web/nav-client.js (a browser IIFE) in Node behind a fake window + fake
// WebSocket we drive by hand, then asserts the client's hello declares its channels + rate, runtime
// setRate/subscribe/unsubscribe send sub.update frames, sub.ack updates the effective config, desired
// state survives reconnect, and bad input is surfaced (fail-fast). The assertions ARE the contract the
// ENGINE/CHART server side implements (filtering + pacing). See docs/CONTRACT-CHANNELS.md.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'nav-client.js'), 'utf8');

let WS_REGISTRY = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; WS_REGISTRY.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose(); }
  _open() { this.readyState = 1; this.onopen && this.onopen(); }
  _msg(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
}
const ep = { navUrl: () => 'ws://127.0.0.1:0/nav', describe: () => '127.0.0.1:0' };

function makeClient(extraOpts) {
  WS_REGISTRY = [];
  const win = { HelmEndpoint: ep };
  new Function('window', 'WebSocket', 'HelmEndpoint', SRC)(win, FakeWS, ep);
  const ev = { states: [], statuses: [], commands: [], subs: [] };
  const opts = Object.assign({
    simGraceMs: 1e9,
    scheduleFrame: cb => cb(),
    onCommand: m => ev.commands.push(m),
    onSub: e => ev.subs.push(e),
  }, extraOpts || {});
  const client = win.HelmNavClient(
    s => ev.states.push(s),
    st => ev.statuses.push(st),
    opts);
  const ws = () => WS_REGISTRY[WS_REGISTRY.length - 1];
  return { client, ws, ev };
}

let failures = 0, passes = 0;
function ok(cond, label) { if (cond) { passes++; console.log('  ✓ ' + label); } else { failures++; console.error('  ✗ FAIL: ' + label); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hello = ws => ws.sent.find(f => f.t === 'hello');
const lastSubUpdate = ws => [...ws.sent].reverse().find(f => f.t === 'sub.update');
const eqSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(x => b.indexOf(x) >= 0);

async function run() {
  console.log('\n[1] hello DECLARES the default channel set (nav forced in) and omits rate by default');
  {
    const h = makeClient({});
    h.ws()._open();
    const hi = hello(h.ws());
    ok(hi && eqSet(hi.subscribe, ['nav', 'route', 'alarms', 'ais', 'track', 'conns']), 'default subscribe = the full known channel set');
    ok(hi && hi.subscribe.indexOf('nav') >= 0, '"nav" (safety core) is always present');
    ok(hi && hi.rate === undefined, 'no rate ⇒ accept the server default (field omitted)');
    h.client.stop();
  }

  console.log('\n[2] opts.rate + opts.subscribe are honored; rate is range-validated (fail-fast)');
  {
    const h = makeClient({ rate: 4, subscribe: ['nav', 'ais'] });
    h.ws()._open();
    const hi = hello(h.ws());
    ok(hi.rate === 4, 'opts.rate:4 → hello.rate === 4');
    ok(eqSet(hi.subscribe, ['nav', 'ais']), 'opts.subscribe is sent as-is');
    h.client.stop();
  }
  {
    const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try {
      const h = makeClient({ rate: 9 });   // out of [1..4]
      h.ws()._open();
      ok(hello(h.ws()).rate === 4, 'opts.rate:9 is clamped to 4 (max)');
      ok(warns.some(w => /coerced to 4 Hz/.test(w)), '...and the clamp is surfaced loudly');
      h.client.stop();
    } finally { console.warn = realWarn; }
  }

  console.log('\n[3] runtime setRate sends a sub.update and is reflected in subscriptions().desired');
  {
    const h = makeClient({ subscribe: ['nav'] });
    h.ws()._open();
    const ret = h.client.setRate(2);
    ok(ret === 2, 'setRate(2) returns the effective desired rate 2');
    const su = lastSubUpdate(h.ws());
    ok(su && su.rate === 2 && eqSet(su.subscribe, ['nav']), 'a sub.update{subscribe,rate:2} was sent');
    ok(h.client.subscriptions().desired.rate === 2, 'subscriptions().desired.rate === 2');
    h.client.stop();
  }

  console.log('\n[4] subscribe/unsubscribe mutate the desired set and send sub.update; "nav" is undroppable');
  {
    const h = makeClient({ subscribe: ['nav'] });
    h.ws()._open();
    h.client.subscribe(['ais', 'track']);
    ok(eqSet(lastSubUpdate(h.ws()).subscribe, ['nav', 'ais', 'track']), 'subscribe(["ais","track"]) adds them and re-sends');
    h.client.unsubscribe(['ais']);
    ok(eqSet(lastSubUpdate(h.ws()).subscribe, ['nav', 'track']), 'unsubscribe(["ais"]) removes it');
    const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try {
      h.client.unsubscribe(['nav']);
      ok(warns.some(w => /cannot be unsubscribed/.test(w)), 'unsubscribe(["nav"]) is refused + surfaced');
      ok(lastSubUpdate(h.ws()).subscribe.indexOf('nav') >= 0, '..."nav" stays subscribed');
    } finally { console.warn = realWarn; }
    h.client.stop();
  }

  console.log('\n[5] sub.ack updates the EFFECTIVE config (→ onSub + onCommand), never touches nav staleness');
  {
    const h = makeClient({ rate: 4, subscribe: ['nav', 'ais', 'track', 'conns'] });
    h.ws()._open();
    // a real fix first, so we can prove sub.ack does NOT refresh staleness
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 1, lon: 2 }, sog: 5 });
    const statusesBefore = h.ev.statuses.length;
    // server clamps rate 4→2 and drops 'track' (e.g. not available)
    h.ws()._msg({ t: 'sub.ack', subscribe: ['nav', 'ais', 'conns'], rate: 2 });
    ok(h.ev.subs.length === 1 && h.ev.subs[0].rate === 2, 'onSub fired with the effective rate (2, server-clamped)');
    ok(eqSet(h.client.subscriptions().effective.subscribe, ['nav', 'ais', 'conns']), 'subscriptions().effective reflects the server-dropped channel');
    ok(h.client.subscriptions().desired.rate === 4, '...while desired stays what the client asked (4)');
    ok(h.ev.commands.some(m => m.t === 'sub.ack'), 'sub.ack is also surfaced on the command plane (onCommand)');
    ok(h.ev.statuses.length === statusesBefore, 'sub.ack emitted NO nav status change (not a nav frame — staleness untouched)');
    ok(h.ev.states.length === 1, 'sub.ack did NOT produce an onState');
    h.client.stop();
  }

  console.log('\n[6] desired channels + rate PERSIST across reconnect (re-sent in the new hello)');
  {
    const h = makeClient({ subscribe: ['nav'] });
    h.ws()._open();
    h.ws()._msg({ t: 'snapshot', seq: 1, sources: { pos: 'gps' }, pos: { lat: 0, lon: 0 }, sog: 1 }); // everEngine=true ⇒ a drop reconnects
    h.client.setRate(3);
    h.client.subscribe(['ais']);
    h.ws().close();                                   // WiFi flap
    let tries = 0; while (WS_REGISTRY.length < 2 && tries++ < 40) { await sleep(50); }
    ok(WS_REGISTRY.length >= 2, 'reconnected after the drop');
    h.ws()._open();
    const hi2 = hello(h.ws());
    ok(hi2 && hi2.rate === 3 && eqSet(hi2.subscribe, ['nav', 'ais']), 'the reconnect hello re-declares the runtime-chosen rate(3) + channels(nav,ais)');
    h.client.stop();
  }

  console.log('\n[7] fail-fast input handling');
  {
    const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try {
      const h = makeClient({ subscribe: ['nav', 'frobnicate'] });   // unknown channel
      h.ws()._open();
      ok(warns.some(w => /unknown channel "frobnicate"/.test(w)), 'an unknown channel is surfaced (but forwarded — forward-compat)');
      ok(hello(h.ws()).subscribe.indexOf('frobnicate') >= 0, '...and still forwarded to the server');
      warns.length = 0;
      ok(h.client.setRate('abc') === null || h.client.subscriptions().desired.rate == null, 'setRate("abc") does not set a bogus rate');
      ok(warns.some(w => /not a number/.test(w)), '...and is surfaced');
      warns.length = 0;
      h.client.setRate(2.5);
      ok(h.client.subscriptions().desired.rate === 3 && warns.some(w => /coerced to 3 Hz/.test(w)), 'setRate(2.5) is rounded to 3 and surfaced');
      h.client.stop();
    } finally { console.warn = realWarn; }
  }

  console.log('\n[8] CONTRACT-8 bbox: hello carries opts.bbox; setBbox throttles a sub.update; sub.ack bbox → effective');
  {
    const h = makeClient({ subscribe: ['nav', 'ais'], bbox: [177, -18, 178, -17] });
    h.ws()._open();
    const hi = hello(h.ws());
    ok(Array.isArray(hi.bbox) && hi.bbox.length === 4 && hi.bbox[0] === 177, 'opts.bbox is declared in the hello');
    h.client.setBbox([170, -20, 175, -15]);
    ok(h.client.subscriptions().desired.bbox[0] === 170, 'setBbox updates desired bbox immediately');
    ok(!lastSubUpdate(h.ws()), 'setBbox is throttled — no sub.update sent synchronously');
    await sleep(380);
    const su = lastSubUpdate(h.ws());
    ok(su && Array.isArray(su.bbox) && su.bbox[0] === 170, 'after the throttle window a sub.update with the new bbox is sent');
    h.ws()._msg({ t: 'sub.ack', subscribe: ['nav', 'ais'], rate: 1, bbox: [170, -20, 175, -15] });
    ok(h.client.subscriptions().effective.bbox && h.client.subscriptions().effective.bbox[2] === 175, 'sub.ack bbox → subscriptions().effective.bbox');
    h.client.setBbox(null);
    const suc = lastSubUpdate(h.ws());
    ok(suc && suc.bbox === null, 'setBbox(null) sends an explicit bbox:null to clear the viewport');
    ok(h.client.subscriptions().desired.bbox === null, 'desired bbox cleared');
    const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try { h.client.setBbox([1, 2, 3]); ok(warns.some(w => /bbox must be/.test(w)), 'an invalid bbox is surfaced (fail-fast) and ignored'); } finally { console.warn = realWarn; }
    h.client.stop();
  }

  console.log('\n' + (failures ? '❌ ' : '✅ ') + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}
run().catch(e => { console.error('harness threw:', e); process.exit(2); });
