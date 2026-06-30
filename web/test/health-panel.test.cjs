'use strict';
// CLIENT-20 unit test: health-panel snapshots must be sourced from real client/engine signals.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const registered = { panels: [], commands: [], navListeners: [] };
const elements = Object.create(null);
function el(id) {
  return elements[id] || (elements[id] = {
    id,
    hidden: true,
    textContent: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    querySelector() { return null; },
    insertAdjacentHTML() {},
  });
}
elements['degraded-banner'] = Object.assign(el('degraded-banner'), { hidden: false });
elements['dg-ttl'] = Object.assign(el('dg-ttl'), { textContent: 'A feature failed' });
elements['dg-msg'] = Object.assign(el('dg-msg'), { textContent: 'synthetic failure' });

const context = {
  console,
  Date,
  JSON,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  navigator: { onLine: true, serviceWorker: { controller: {} }, clipboard: { writeText: () => Promise.resolve() } },
  document: {
    head: { appendChild() {} },
    addEventListener() {},
    createElement(tag) { return el(tag + Math.random()); },
    getElementById(id) { return elements[id] || null; },
  },
  window: {
    addEventListener() {},
    HelmShell: {
      registerPanel(spec) { registered.panels.push(spec); return { open() {}, isOpen() { return false; } }; },
      registerCommand(spec) { registered.commands.push(spec); return { remove() {} }; },
      onNav(fn) { registered.navListeners.push(fn); },
      panel() { return { open() {} }; },
    },
    HelmEndpoint: {
      describe: () => 'http://boat.local:8080',
      healthUrl: () => 'http://boat.local:8080/health',
      token: () => 'owner-token',
      fingerprint: () => 'abc123',
    },
    HelmLog: {
      recent: () => [
        { level: 'warn', msg: ['low'] },
        { level: 'error', msg: ['boom'] },
      ],
    },
    __activeWx: 'wind',
    HelmWxScene: {},
    HelmWxLive: {},
    HelmWxCodec: {},
    HelmWxRamp: {},
  },
};
context.window.window = context.window;
context.window.document = context.document;
context.window.navigator = context.navigator;
context.global = context.window;
context.HelmShell = context.window.HelmShell;
context.HelmEndpoint = context.window.HelmEndpoint;
context.HelmLog = context.window.HelmLog;

const src = fs.readFileSync(path.join(__dirname, '..', 'health-panel.js'), 'utf8');
vm.runInNewContext(src, context, { filename: 'health-panel.js' });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(registered.panels.length === 1, 'registers one HelmShell panel');
assert(registered.panels[0].id === 'helm-client-health', 'panel id is namespaced');
assert(registered.commands.some(c => c.id === 'helm-client-health-open'), 'registers command palette entry');
assert(registered.navListeners.length === 1, 'subscribes to HelmShell nav frames');

context.window.HelmHealthPanel.onStatus({ phase: 'live', seq: 12, age: 100 });
context.window.HelmHealthPanel.onNav({
  conns: [{ id: 'vesper', name: 'Vesper AIS', type: 'tcp-client', status: 'connected', sentences: 44, ageSec: 1 }],
  ais: [{ mmsi: 1 }, { mmsi: 2 }],
});
context.window.HelmHealthPanel._state.health = {
  status: 'ok',
  engine: 'helm-server',
  version: 'test-sha',
  chart_loaded: true,
  chart_status: 'loaded',
  runtime: {
    s57data: '/tmp/s57data',
    enc: '/tmp/enc/US5FL4CR.000',
    senc: '/tmp/senc',
  },
  nav: { fix_status: 'live', reason: 'ok', required: ['pos', 'sog', 'cog'], missing: [], fields: { posAgeSec: 0, sogAgeSec: 0, cogAgeSec: 0 } },
};
context.window.HelmHealthPanel._state.healthAt = Date.now();

const snap = context.window.HelmHealthPanel.snapshot();
assert(snap.subsystems.nav.label === 'live', 'nav status comes from HelmNavClient phase');
assert(snap.subsystems.ais.label === 'connected', 'AIS status comes from nav frame conns/targets');
assert(snap.runtime.s57data === '/tmp/s57data', 'runtime s57data is extracted from /health');
assert(snap.runtime.enc.endsWith('US5FL4CR.000'), 'runtime enc is extracted from /health');
assert(snap.degraded.visible === true && snap.degraded.title === 'A feature failed', 'degraded banner state is captured');
assert(snap.logs.error === 1 && snap.logs.warn === 1, 'log ring warning/error counts are captured');

console.log('health-panel: snapshot contract passed');
