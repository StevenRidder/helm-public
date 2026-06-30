#!/usr/bin/env node
// run.mjs — the one command that runs Helm's web-client test suite (CLIENT epic, CLIENT-17).
//
// Aggregates every web test into a single pass/fail + exit code, so CI (and humans) run them as ONE
// suite instead of remembering to `node` each file by hand. It picks up:
//   • the existing-but-unwired tests — persist.smoke.js, alarms.smoke.js, and the inline node
//     self-tests in true-wind.js & wx-value-codec.js (they already pass; they just weren't a suite);
//   • every web/test/*.test.cjs unit test (auto-discovered — drop a new one in and it joins).
// Each suite is a standalone node script that exits 0 (green) / non-zero (red); we just run it and
// tally. No dependencies, no build — works on a bare `node`.
//   node web/test/run.mjs            # run all, print a summary
//   node web/test/run.mjs --verbose  # also print each suite's own output
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));   // web/test
const WEB = resolve(HERE, '..');                        // web
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

// Existing tests that already pass but weren't runnable as a suite — now wired in.
const WIRED = [
  { name: 'persist (HelmStore / TOOLS-7)', file: join(WEB, 'persist.smoke.js') },
  { name: 'alarms', file: join(WEB, 'alarms.smoke.js') },
  { name: 'true-wind (TWS/TWD/TWA)', file: join(WEB, 'true-wind.js') },
  { name: 'wx-value-codec (encode/decode/tiles)', file: join(WEB, 'wx-value-codec.js') },
];
// New unit tests — auto-discovered so future *.test.cjs join the suite with no edit here.
const UNIT = readdirSync(HERE)
  .filter(f => f.endsWith('.test.cjs')).sort()
  .map(f => ({ name: f.replace(/\.test\.cjs$/, '') + ' (unit)', file: join(HERE, f) }));

const SUITES = [...WIRED, ...UNIT];

const tty = process.stdout.isTTY;
const C = {
  g: s => tty ? `\x1b[32m${s}\x1b[0m` : s, r: s => tty ? `\x1b[31m${s}\x1b[0m` : s,
  d: s => tty ? `\x1b[2m${s}\x1b[0m` : s, b: s => tty ? `\x1b[1m${s}\x1b[0m` : s,
};

console.log(C.b('\nHelm web-client test suite') + C.d(`  (${SUITES.length} suites)\n`));
let failed = 0;
for (const s of SUITES) {
  const res = spawnSync(process.execPath, [s.file], { encoding: 'utf8' });
  const okk = res.status === 0;
  if (!okk) failed++;
  console.log(`  ${okk ? C.g('✓ PASS') : C.r('✗ FAIL')}  ${s.name}`);
  if (!okk || verbose) {
    const out = (res.stdout || '') + (res.error ? String(res.error) + '\n' : '') + (res.stderr || '');
    console.log(out.replace(/\n$/, '').split('\n').map(l => '        ' + l).join('\n'));
  }
}

const summary = `${SUITES.length - failed}/${SUITES.length} suites passed`;
console.log('\n' + (failed ? C.r('✗ ' + summary) : C.g('✓ ' + summary)));
if (!failed) console.log(C.d('  note: collision.js classify() (COLREGs role) is module-private — unit coverage pending an AIS export. See web/test/README.md.'));
process.exit(failed ? 1 : 0);
