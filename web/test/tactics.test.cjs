'use strict';
// tactics.test.cjs — pure opposite-tack math (web/tactics.js, HelmTactics.oppositeTack).
// twa is WX-13's signed true-wind angle; twaSide 'S'/'P' = the side the wind is on. BOTH ways to the
// other tack are returned: tack = up through the wind, gybe = away through downwind — opposite turns
// that sum to 360°; the shorter is recommended.
const T = require('../tactics.js');
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };
const opp = T.oppositeTack;

ok((() => { const r = opp({ twd: 0, twa: 45, twaSide: 'S' });
  return r.oppHeading === 45 && r.recommend === 'tack' && r.newTack === 'port'
    && r.tack.dir === 'right' && r.tack.turn === 90 && r.gybe.dir === 'left' && r.gybe.turn === 270;
})(), '1. close-hauled stbd (45°) → recommend TACK right 90° to 045°; alt GYBE left 270°; onto port');

ok((() => { const r = opp({ twd: 0, twa: -120, twaSide: 'P' });   // the broad-reach case
  return r.oppHeading === 240 && r.recommend === 'gybe' && r.newTack === 'starboard'
    && r.gybe.dir === 'right' && r.gybe.turn === 120 && r.tack.dir === 'left' && r.tack.turn === 240;
})(), '2. broad reach port (120°) → recommend GYBE right 120° to 240°; alt TACK left 240° (long way); onto stbd');

ok((() => { const r = opp({ twd: 0, twa: -77, twaSide: 'P' });    // the user's verbiage example
  return r.oppHeading === 283 && r.recommend === 'tack'
    && r.tack.dir === 'left' && r.tack.turn === 154 && r.gybe.dir === 'right' && r.gybe.turn === 206;
})(), '3. "TACK left 154° to BEARING 283°" / "GYBE right 206°" — same bearing, opposite turns');

ok((() => { const r = opp({ twd: 30, twa: 100, twaSide: 'S' });
  return r.tack.turn + r.gybe.turn === 360 && r.tack.dir !== r.gybe.dir;
})(), '4. the two turns always sum to 360° and turn opposite ways');

ok((() => { const r = opp({ twd: 0, twa: 3, twaSide: 'S' }); return r && r.irons === true; })(),
  '5. ~head to wind → irons (no clean other tack)');

ok(opp(null) === null && opp({ twd: 0 }) === null, '6. missing wind → null');

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'tactics: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
