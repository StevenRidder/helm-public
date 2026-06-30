'use strict';
// ais-risk.test.cjs — unit tests for HelmAisRisk (web/ais-risk.js): the single source of truth for
// AIS collision-risk tiers. Safety-critical — a target the CPA alarm fires on must read "danger"
// EVERYWHERE (chart symbol, tap card, list), so this logic can never silently drift. Previously
// untested. The module attaches to `window` (no module.exports), so we load it in a vm sandbox the
// same way persist.smoke.js does.   Run: node web/test/ais-risk.test.cjs   (exit 0 = all green)
const fs = require('fs'), path = require('path'), vm = require('vm');

function loadRisk() {
  const win = {};
  const sandbox = { window: win, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ais-risk.js'), 'utf8'),
    sandbox, { filename: 'ais-risk.js' });
  if (!win.HelmAisRisk) throw new Error('ais-risk.js did not attach window.HelmAisRisk');
  return win.HelmAisRisk;
}

const R = loadRisk();
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

// --- tier(): the danger / caution / normal matrix ---
eq(R.tier(null), 'normal', 'tier(null) → normal');
eq(R.tier({}), 'normal', 'tier(no cpa) → normal');

// engine-emitted `risk` wins outright (forward-compat: thresholds can later move into the core)
eq(R.tier({ risk: 'danger' }), 'danger', 'engine risk=danger wins');
eq(R.tier({ risk: 'caution' }), 'caution', 'engine risk=caution wins');
eq(R.tier({ risk: 'normal', cpa: 0.1, tcpa: 5 }), 'normal', 'engine risk=normal overrides a scary cpa/tcpa');

// no valid CPA solution → never asserts a threat
eq(R.tier({ cpaValid: false, cpa: 0.1, tcpa: 5 }), 'normal', 'cpaValid=false → normal');
eq(R.tier({ cpaValid: 'false', cpa: 0.1, tcpa: 5 }), 'normal', 'cpaValid="false" (string) → normal');

// no tcpa: can't assert closing → cap at caution (never danger)
eq(R.tier({ cpa: 1.0 }), 'caution', 'cpa<2 & no tcpa → caution (capped, not danger)');
eq(R.tier({ cpa: 3.0 }), 'normal', 'cpa>=2 & no tcpa → normal');

// opening / past CPA (tcpa<=0) is not a threat
eq(R.tier({ cpa: 0.1, tcpa: 0 }), 'normal', 'tcpa=0 → normal');
eq(R.tier({ cpa: 0.1, tcpa: -5 }), 'normal', 'tcpa<0 (opening) → normal');

// DANGER band == cpa < 2.0 && 0 < tcpa < 30  (the CPA alarm predicate, exactly)
eq(R.tier({ cpa: 1.0, tcpa: 10 }), 'danger', 'cpa1.0/tcpa10 → danger');
eq(R.tier({ cpa: 1.99, tcpa: 29 }), 'danger', 'just inside the danger band → danger');
eq(R.tier({ cpa: '1.0', tcpa: '10' }), 'danger', 'string cpa/tcpa coerced → danger');

// CAUTION band == cpa < 4 && tcpa < 60  (and not danger)
eq(R.tier({ cpa: 3.0, tcpa: 45 }), 'caution', 'cpa3/tcpa45 → caution');
eq(R.tier({ cpa: 1.0, tcpa: 45 }), 'caution', 'cpa<2 but tcpa 45 (>30) → caution, not danger');

// NORMAL beyond both bands
eq(R.tier({ cpa: 5, tcpa: 10 }), 'normal', 'cpa>=4 → normal');
eq(R.tier({ cpa: 1, tcpa: 120 }), 'normal', 'tcpa>=60 → normal');

// --- isDanger / color route through tier (so a chart symbol can never disagree with the alarm) ---
ok(R.isDanger({ cpa: 1, tcpa: 10 }) === true, 'isDanger true in the danger band');
ok(R.isDanger({ cpa: 5, tcpa: 10 }) === false, 'isDanger false outside it');
eq(R.color({ cpa: 1, tcpa: 10 }), R.COL.danger, 'color(danger) = palette danger');
eq(R.color({ cpa: 3, tcpa: 45 }), R.COL.caution, 'color(caution) = palette caution');
eq(R.color(null), R.COL.normal, 'color(normal) = palette normal');

// --- the MapLibre data-driven exprs are built from the SAME constants (structure smoke) ---
ok(Array.isArray(R.dangerExpr()) && R.dangerExpr()[0] === 'any', 'dangerExpr() is a MapLibre expression');
ok(Array.isArray(R.riskColorExpr()) && R.riskColorExpr()[0] === 'case', 'riskColorExpr() is a MapLibre expression');
eq(R.CPA_WARN, 2.0, 'CPA_WARN constant exposed (== engine g_CPAWarn_NM)');
eq(R.TCPA_MAX, 30.0, 'TCPA_MAX constant exposed (== engine g_TCPA_Max)');

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'ais-risk: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
