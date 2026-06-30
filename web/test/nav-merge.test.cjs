'use strict';
// nav-merge.test.cjs — unit test for nav-client.js mergeState (CLIENT-9). mergeState is a private,
// PURE function inside the HelmNavClient IIFE, so we extract its source by name (brace-balanced) and
// compile it standalone. Key property: a delta that doesn't touch a branch REUSES it by reference (no
// per-frame deep clone). That property FAILS under the old JSON.parse(JSON.stringify) — so this test
// catches a revert.   Run: node web/test/nav-merge.test.cjs
const fs = require('fs'), path = require('path');

function extractMergeState() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'nav-client.js'), 'utf8');
  const lines = src.split('\n');
  const i0 = lines.findIndex((l) => l.includes('function mergeState('));
  if (i0 < 0) throw new Error('mergeState not found in nav-client.js');
  let depth = 0; const body = [];
  for (let i = i0; i < lines.length; i++) {
    body.push(lines[i]);
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (i > i0 && depth === 0) break;
  }
  return new Function('return (' + body.join('\n') + ')')();   // pure fn: only base/patch/Object/Array/typeof
}

const mergeState = extractMergeState();
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };

// 1. snapshot from a null base
{
  const out = mergeState(null, { pos: { lat: 1 }, sog: 5, ais: [{ mmsi: 1 }] });
  ok(out.sog === 5 && out.pos.lat === 1 && out.ais.length === 1, '1. snapshot merges all fields');
}
// 2. delta: patched key updates; UNCHANGED branches are reused BY REFERENCE (no per-frame deep clone)
{
  const base = { sog: 5, ais: [{ mmsi: 1, lat: 10 }], wind: { spd: 3, dir: 90 } };
  const out = mergeState(base, { sog: 6 });
  ok(out.sog === 6, '2a. patched primitive updates');
  ok(out.ais === base.ais, '2b. unchanged ais array REUSED by reference (fails under a deep clone)');
  ok(out.wind === base.wind, '2c. unchanged nested object reused by reference');
  ok(base.sog === 5, '2d. base is never mutated');
}
// 3. nested one-level merge (wind/active/sources): copy + overlay, base untouched
{
  const base = { wind: { spd: 3, dir: 90 } };
  const out = mergeState(base, { wind: { spd: 7 } });
  ok(out.wind.spd === 7 && out.wind.dir === 90, '3a. nested object shallow-merges (keeps dir)');
  ok(out.wind !== base.wind && base.wind.spd === 3, '3b. nested merge does NOT mutate base.wind');
}
// 4. arrays are replaced, not merged
{
  const out = mergeState({ ais: [1] }, { ais: [2, 3] });
  ok(out.ais.length === 2 && out.ais[0] === 2, '4. a new ais array replaces the old one');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'nav-merge: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
