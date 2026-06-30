// true-wind.js — derive TRUE wind (TWS/TWD/TWA) from APPARENT wind + boat motion.
// WX epic · WX-13. Pure, shell-free, framework-free. The live wiring (calling this per nav
// frame) and the instrument readout hook into the shell's nav-listener / panel API once SHELL
// lands — this file is just the math + a clean consumer API, fully unit-tested on its own.
//
// Ground-referenced: boat motion is taken from SOG/COG (over ground), so TWD is a true compass
// bearing and TWS is the wind over ground. (A water-referenced TWA would use speed-through-water;
// we don't have STW yet — documented, not guessed.)
//
// API:
//   computeTrueWind({awa, aws, sog, cog, hdg}) -> {tws, twd, twa, twaSide} | null
//     awa  apparent wind angle off the bow, deg (signed -180..180 or 0..360; normalized here)
//     aws  apparent wind speed (same unit as sog; returned tws is in that unit)
//     sog  speed over ground;  cog  course over ground (deg true);  hdg  heading (deg true)
//   fromNav(state, {apparent=true}) -> same, deriving awa = wind.dir - hdg from a nav frame.
(function (root) {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function signed180(d) { d = norm360(d); return d > 180 ? d - 360 : d; }
  function num(x) { return typeof x === 'number' && isFinite(x); }

  // Compass bearing (deg, 0=N, 90=E) of an east/north vector — the direction it points TOWARD.
  function bearingOf(e, n) { return norm360(Math.atan2(e, n) * R2D); }

  function computeTrueWind(o) {
    o = o || {};
    if (!num(o.awa) || !num(o.aws)) return null;
    var sog = num(o.sog) ? o.sog : 0;
    var cog = num(o.cog) ? o.cog : (num(o.hdg) ? o.hdg : 0);
    var hdg = num(o.hdg) ? o.hdg : 0;
    var aws = o.aws;

    // Apparent wind blows FROM compass (hdg + awa); the air moves TOWARD that + 180.
    var awTo = norm360(hdg + o.awa + 180);
    var appE = aws * Math.sin(awTo * D2R), appN = aws * Math.cos(awTo * D2R);
    // Boat velocity over ground (the air's frame shifts by the boat's motion).
    var boatE = sog * Math.sin(cog * D2R), boatN = sog * Math.cos(cog * D2R);
    // True wind = apparent (air motion relative to boat) + boat motion.
    var twE = appE + boatE, twN = appN + boatN;

    var tws = Math.hypot(twE, twN);
    var twd = norm360(bearingOf(twE, twN) + 180);   // FROM-direction (opposite of air's travel)
    var twa = signed180(twd - hdg);
    return { tws: tws, twd: twd, twa: twa, twaSide: twa >= 0 ? 'S' : 'P' };
  }

  // Derive from a Helm nav frame. By default the frame's `wind` is treated as APPARENT, with
  // wind.dir a compass FROM-bearing; awa = wind.dir - hdg. If the source already gives TRUE wind,
  // pass {apparent:false} and this returns it unchanged (no boat-motion correction).
  function fromNav(state, opts) {
    if (!state || !state.wind || !num(state.wind.spd) || !num(state.wind.dir)) return null;
    var hdg = num(state.hdg) ? state.hdg : (num(state.cog) ? state.cog : 0);
    if (opts && opts.apparent === false) {
      return { tws: state.wind.spd, twd: norm360(state.wind.dir),
               twa: signed180(state.wind.dir - hdg), twaSide: signed180(state.wind.dir - hdg) >= 0 ? 'S' : 'P' };
    }
    return computeTrueWind({
      awa: signed180(state.wind.dir - hdg), aws: state.wind.spd,
      sog: state.sog, cog: state.cog, hdg: hdg
    });
  }

  var api = { computeTrueWind: computeTrueWind, fromNav: fromNav, _norm360: norm360, _signed180: signed180 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node / tests
  root.HelmTrueWind = api;                                                     // browser
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));


// ---- self-test: `node web/true-wind.js --test` ----------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  var TW = module.exports, fails = 0;
  function near(a, b, eps, msg) {
    var ok = Math.abs(a - b) <= (eps == null ? 0.1 : eps);
    if (!ok) { fails++; console.log('  FAIL', msg, '=> got', a.toFixed(2), 'want', b.toFixed(2)); }
    else console.log('  ok  ', msg, '=', a.toFixed(2));
  }
  var c;
  // 1) No boat motion -> true == apparent.
  c = TW.computeTrueWind({ awa: 90, aws: 20, sog: 0, cog: 0, hdg: 0 });
  near(c.tws, 20, 0.05, 'stationary: TWS=AWS'); near(c.twd, 90, 0.1, 'stationary: TWD=hdg+awa'); near(c.twa, 90, 0.1, 'stationary: TWA=AWA');
  // 2) Head to wind -> TWS = AWS - SOG.
  c = TW.computeTrueWind({ awa: 0, aws: 20, sog: 5, cog: 0, hdg: 0 });
  near(c.tws, 15, 0.05, 'head-to-wind: TWS=AWS-SOG'); near(c.twa, 0, 0.1, 'head-to-wind: TWA=0');
  // 3) Dead run -> TWS = AWS + SOG, TWA=180.
  c = TW.computeTrueWind({ awa: 180, aws: 10, sog: 6, cog: 0, hdg: 0 });
  near(c.tws, 16, 0.05, 'run: TWS=AWS+SOG'); near(Math.abs(c.twa), 180, 0.1, 'run: |TWA|=180');
  // 4) Beam reach (stbd) -> true wind veers AFT of apparent.
  c = TW.computeTrueWind({ awa: 90, aws: 20, sog: 5, cog: 0, hdg: 0 });
  near(c.tws, Math.hypot(20, 5), 0.05, 'beam: TWS=hypot(AWS,SOG)'); if (c.twa <= 90) { fails++; console.log('  FAIL beam: TWA should be aft of 90, got', c.twa.toFixed(1)); } else console.log('  ok   beam: TWA aft of apparent =', c.twa.toFixed(1)); near(c.twaSide === 'S' ? 1 : 0, 1, 0.1, 'beam: starboard side');
  // 5) Port close-hauled -> true aft of apparent, port side.
  c = TW.computeTrueWind({ awa: -45, aws: 18, sog: 6, cog: 0, hdg: 0 });
  if (!(c.twa < -45 && c.twaSide === 'P')) { fails++; console.log('  FAIL port-CH: want TWA<-45 & port, got', c.twa.toFixed(1), c.twaSide); } else console.log('  ok   port-CH: TWA aft & port =', c.twa.toFixed(1), c.twaSide);
  // 6) Heading rotation invariance: same apparent on hdg=270 just rotates TWD by 270.
  c = TW.computeTrueWind({ awa: 90, aws: 20, sog: 0, cog: 270, hdg: 270 });
  near(c.twd, 0, 0.1, 'rotated: TWD = hdg+awa (mod 360)');
  // 7) fromNav: apparent wind from 045 @ 15kn, hdg 000, sog 0 -> TWA 45.
  c = TW.fromNav({ wind: { spd: 15, dir: 45 }, hdg: 0, sog: 0, cog: 0 });
  near(c.twa, 45, 0.1, 'fromNav: TWA from wind.dir-hdg');
  console.log(fails ? ('\nTRUE-WIND TESTS: ' + fails + ' FAILED') : '\nTRUE-WIND TESTS: all passed');
  process.exit(fails ? 1 : 0);
}
