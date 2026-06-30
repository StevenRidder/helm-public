'use strict';
// ais-guard.test.cjs — unit tests for HelmAisGuard (web/ais-guard.js): the AIS proximity / guard-zone
// alarm. Safety-critical — a target physically near you must register, and a feed dropout must NEVER
// read as "all clear". The module is DOM-coupled, so we load it in a vm sandbox with a minimal DOM +
// HelmShell stub. Its update() is documented as "also called directly by tests", and activeAlarms()
// exposes the breach set in the frozen CONTRACT-10 schema for assertions.
//   Run: node web/test/ais-guard.test.cjs   (exit 0 = all green)
const fs = require('fs'), path = require('path'), vm = require('vm');

// a permissive element stub: arbitrary prop assignment + the few DOM methods build()/render() use
function makeEl() {
  return { style: {}, appendChild() {}, querySelector() { return {}; }, querySelectorAll() { return []; } };
}

function loadGuard() {
  const store = new Map();
  // In a browser, `window` IS the global object — so the module's bare `HelmShell` / `document` and
  // its `window.HelmShell` resolve to the same reference. Mirror that: the sandbox global doubles as
  // `window` (a separate window object would make bare `HelmShell` an undefined ReferenceError).
  const sandbox = {
    console,
    document: {
      head: { appendChild() {} }, body: { appendChild() {} },
      createElement() { return makeEl(); }, querySelector() { return null; },
    },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    },
    // no-op timers: prevents boot()'s retry recursion and the watchdog/pulse intervals from firing
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  };
  sandbox.window = sandbox;        // window === global, as in a browser
  sandbox.globalThis = sandbox;
  // HelmShell present so the module's boot() builds the instance (window.HelmAisGuard = build())
  sandbox.HelmShell = { onNav() {}, registerPanel() {}, registerCommand() {}, panel() { return null; } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ais-guard.js'), 'utf8'), sandbox, { filename: 'ais-guard.js' });
  if (!sandbox.HelmAisGuard) throw new Error('ais-guard.js did not attach window.HelmAisGuard');
  return sandbox.HelmAisGuard;
}

const G = loadGuard();
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };
const has = (mmsi) => G.activeAlarms().some(a => a.data.mmsi === mmsi);

const own = { lat: 0, lon: 0 };           // 1° latitude ≈ 60 NM at the equator
ok(G.prefs().radius === 1.0, 'default guard radius is 1.0 NM');

G.setOn(true);
ok(G.prefs().on === true, 'setOn(true) arms the zone');

// 1) a target inside the ring raises a breach, in the frozen CONTRACT-10 schema
G.update(own, [{ mmsi: 111, name: 'NEAR', lat: 0.005, lon: 0 }], true);    // ~0.3 NM north
ok(has(111), 'target ~0.3 NM inside the 1.0 NM ring → breach raised');
{
  const a = G.activeAlarms().find(x => x.data.mmsi === 111) || { data: {} };
  ok(a.kind === 'guardzone' && a.sev === 'warning' && a.id === 'guardzone:ownship-ring:111',
    'breach uses the frozen CONTRACT-10 schema (kind/sev/id)');
  ok(typeof a.data.rangeM === 'number' && typeof a.data.bearingDeg === 'number',
    'breach carries range (m) + bearing (deg)');
}

// 2) leaving the ring (beyond radius + exit hysteresis) clears the breach
G.update(own, [{ mmsi: 111, name: 'NEAR', lat: 0.02, lon: 0 }], true);     // ~1.2 NM > 1.1 NM
ok(!has(111), 'target beyond ring + 0.1 NM hysteresis → breach cleared');

// 3) exit hysteresis: an EXISTING breach is held inside the [R, R+hyst] band (no boundary flapping)
G.update(own, [{ mmsi: 222, lat: 0.005, lon: 0 }], true);                   // 0.3 NM → new breach
G.update(own, [{ mmsi: 222, lat: 0.0175, lon: 0 }], true);                  // ~1.05 NM (R < x < R+hyst)
ok(has(222), 'existing breach held within the exit-hysteresis band');

// 4) FAIL-LOUD: a feed dropout (empty list + not connected) must FREEZE the breach, never wipe it
G.update(own, [{ mmsi: 333, lat: 0.005, lon: 0 }], true);
ok(has(333), 'breach present before feed loss');
G.update(own, [], false);                                                   // feed offline, no targets
ok(has(333), 'feed loss (empty + disconnected) FREEZES the breach — never a false all-clear');

// 5) FAIL-LOUD: no ownship fix → cannot measure proximity → breaches cleared (positions untrustworthy)
G.update(null, [{ mmsi: 333, lat: 0.005, lon: 0 }], true);
ok(!has(333), 'no position fix → breaches cleared (cannot assert proximity without ownship)');

// 6) radius is clamped to a sane floor
G.setRadius(0);
ok(G.prefs().radius >= 0.1, 'setRadius clamps to a >= 0.1 NM floor');

// 7) disarming clears the armed flag
G.setOn(false);
ok(G.prefs().on === false, 'setOn(false) disarms');

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'ais-guard: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
