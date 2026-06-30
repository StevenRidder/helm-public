// persist.smoke.js — dependency-free unit smoke for web/persist.js (HelmStore, TOOLS-7).
// Verifies namespaced get/set/remove/keys AND the FAIL-LOUD behaviour: a write that can't persist
// (quota / unavailable storage) returns false + warns rather than silently pretending it saved.
//   Usage:  node web/persist.smoke.js   (exit 0 = all green)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

let warnings = [];
const cap = Object.assign(Object.create(console), { warn: (...a) => warnings.push(a.join(' ')) });

function makeLS(opts) {
  opts = opts || {};
  const m = new Map();
  return {
    _map: m,
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      if (opts.throwReal && k.indexOf('__probe__') < 0) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem(k) { m.delete(k); },
  };
}

// mode: an LS stub object, or the string 'throwAccess' (property access itself throws)
function loadStore(mode) {
  warnings = [];
  const win = {};
  Object.defineProperty(win, 'localStorage', {
    configurable: true,
    get() { if (mode === 'throwAccess') throw new Error('storage blocked'); return mode; },
  });
  const sandbox = { window: win, console: cap };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'persist.js'), 'utf8'), sandbox, { filename: 'persist.js' });
  return win.HelmStore;
}

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };

// 1. happy path — namespaced round-trip + default + keys + remove
{
  const ls = makeLS(), S = loadStore(ls);
  ok(S.set('ui.theme', 'night') === true, '1a. set returns true when persisted');
  ok(S.get('ui.theme', 'day') === 'night', '1b. get returns the persisted value');
  ok(ls._map.get('helm.ui.theme') === '"night"', '1c. stored under the helm.* namespace as JSON');
  ok(S.get('missing', 'fallback') === 'fallback', '1d. get returns default for an unset key');
  ok(S.keys().indexOf('ui.theme') >= 0, '1e. keys() lists helm.* keys without the prefix');
  S.remove('ui.theme');
  ok(S.get('ui.theme', 'day') === 'day', '1f. remove forgets the key');
  ok(S.available() === true && warnings.length === 0, '1g. available() true, no spurious warnings');
}

// 2. FAIL-LOUD: quota / write failure → set returns false AND warns (never pretends it saved)
{
  const S = loadStore(makeLS({ throwReal: true }));   // probe succeeds, real writes throw quota
  ok(S.available() === true, '2a. storage probes as available');
  ok(S.set('ui.theme', 'night') === false, '2b. a failed write returns FALSE (not a silent success)');
  ok(warnings.some(w => /FAILED.*NOT persisted/.test(w)), '2c. the write failure is SURFACED (console.warn)');
}

// 3. FAIL-LOUD: storage entirely unavailable (private mode / sandbox) → surfaced once
{
  const S = loadStore('throwAccess');
  ok(S.available() === false, '3a. available() is false when storage is unreachable');
  ok(S.set('x', 1) === false, '3b. set returns false');
  ok(warnings.some(w => /UNAVAILABLE.*will NOT survive reload/i.test(w)), '3c. unavailable storage is SURFACED');
}

// 4. corrupt stored value → surfaced + default returned (not silently masked)
{
  const ls = makeLS(); ls._map.set('helm.bad', '{not valid json');
  const S = loadStore(ls);
  warnings = [];
  ok(S.get('bad', 'safe') === 'safe', '4a. a corrupt value falls back to the default');
  ok(warnings.some(w => /unreadable/.test(w)), '4b. the corrupt value is SURFACED, not silently swallowed');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
