// WX-23 unit test: frame-bracketing date math in wx-scene.js (no browser/bundle needed).
// Run: node web/tests/wx-scene-bracket.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'wx-scene.js'), 'utf8');
const ctx = { window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, Object, Array, Promise, isFinite, parseInt, parseFloat,
  Blob: function () {}, fetch: function () { return Promise.resolve(); } };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const S = ctx.window.HelmWxScene;

const F = ['2026-06-30T00:00:00Z', '2026-06-30T03:00:00Z', '2026-06-30T06:00:00Z'];
const man = { run: { validTimes: F, frameIdByValidTime: { [F[0]]: 'f0', [F[1]]: 'f3', [F[2]]: 'f6' } } };
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

eq('single-frame -> null', S._bracket({ run: { validTimes: [F[0]], frameIdByValidTime: { [F[0]]: 'f0' } } }, '2026-06-30T01:30:00Z'), null);
eq('exact lower frame -> null', S._bracket(man, F[0]), null);
eq('exact middle frame -> null', S._bracket(man, F[1]), null);
eq('exact upper frame -> null', S._bracket(man, F[2]), null);
eq('midway 01:30 -> f0/f3 @0.5', S._bracket(man, '2026-06-30T01:30:00Z'), { aIso: F[0], bIso: F[1], aId: 'f0', bId: 'f3', frac: 0.5 });
const b = S._bracket(man, '2026-06-30T04:00:00Z');
eq('04:00 -> f3/f6 ids', [b && b.aId, b && b.bId], ['f3', 'f6']);
eq('04:00 -> frac~0.333', b && Math.round(b.frac * 1000) / 1000, 0.333);
eq('before range -> null', S._bracket(man, '2026-06-29T23:00:00Z'), null);
eq('after range -> null', S._bracket(man, '2026-06-30T09:00:00Z'), null);
eq('validTimesSorted from unordered map', S._validTimesSorted({ run: { frameIdByValidTime: { [F[2]]: 'f6', [F[0]]: 'f0', [F[1]]: 'f3' } } }), F);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
