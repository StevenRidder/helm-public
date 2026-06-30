// HelmAisAdvisor — AIS-12: the "what do I DO about it" advisor for dangerous targets.
//
// The COLREGS brain already exists (collision.js classify → role/rule/action, exposed as window.
// HelmColregs). This module adds the QUANTITY collision.js doesn't: HOW MUCH to turn (or slow) to
// lift the closest approach back to your active CPA limit — so you stop nudging 10° and re-reading.
//
// It's a relative-motion sweep: rotate your own course in small steps at constant speed, recompute
// CPA each step, and find the smallest change on each side that clears. The SAME sweep will drive the
// map "safe-course sector" (AIS-13). The engine's cpa/tcpa stay authoritative for ALARM/colour; this
// is a derived what-if (AIS-14 promotes the what-if into the core so it can never disagree).
//
// ADVISORY ONLY — never an autopilot command. Toggleable (some skippers won't want it); default ON.
(function () {
  'use strict';
  var KEY = 'helm.ais.advisor.on', K_SAIL = 'helm.sail.underSail', K_WIND = 'helm.sail.windFrom', K_KINDS = 'helm.ais.kinds';
  var K_SET = 'helm.water.setDeg', K_DRIFT = 'helm.water.driftKn';
  var enabled = load(KEY, true);
  var ownUnderSail = load(K_SAIL, false);          // skipper's own propulsion mode — default POWER (safe: no sail assumption until opted in; a sailboat motoring IS power-driven)
  var windFrom = load(K_WIND, null);               // skipper-set true-wind FROM° (this boat has no wind instrument)
  var setDeg = load(K_SET, null);                  // current SET — compass direction the water flows TOWARD (°); manual (no current source on this boat)
  var driftKn = load(K_DRIFT, null);               // current DRIFT — its speed (kn)
  var kinds = load(K_KINDS, {}) || {};             // per-MMSI VISUAL propulsion override (sail|power) — your eyes beat the AIS registry
  var own = null, lastNav = null;                  // latest ownship {cog, sog} + full nav frame (for WX-13 true wind)

  function getTargetKind(mmsi) { var k = kinds[String(mmsi)]; return (k === 'sail' || k === 'power') ? k : null; }
  function setTargetKind(mmsi, kind) {
    var key = String(mmsi);
    if (kind === 'sail' || kind === 'power') kinds[key] = kind; else delete kinds[key];
    saveKey(K_KINDS, kinds);
  }

  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function saveKey(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function save() { saveKey(KEY, enabled); }
  function num(v) { return (v == null || v === '' || !isFinite(+v)) ? null : +v; }
  function norm(d) { d %= 360; return d < 0 ? d + 360 : d; }

  // ---- relative-motion geometry (NM + kn + hours). [east, north] components. ----
  function vec(courseDeg, speed) { var r = courseDeg * Math.PI / 180; return [speed * Math.sin(r), speed * Math.cos(r)]; }
  function cpaTcpa(P, Vrel) {
    var v2 = Vrel[0] * Vrel[0] + Vrel[1] * Vrel[1];
    if (v2 < 1e-9) return { cpa: Math.hypot(P[0], P[1]), tcpa: 0 };
    var tcpa = -(P[0] * Vrel[0] + P[1] * Vrel[1]) / v2;
    if (tcpa <= 0) return { cpa: Math.hypot(P[0], P[1]), tcpa: tcpa };   // opening — closest is now
    return { cpa: Math.hypot(P[0] + Vrel[0] * tcpa, P[1] + Vrel[1] * tcpa), tcpa: tcpa };
  }

  // ---- set & drift → course-to-steer (AIS-14) ----
  // A uniform current CANCELS in the relative CPA: both boats ride the same water, and AIS COG/SOG are
  // already ground-referenced — so set & drift never moves the THREAT. It moves STEERING. The sweep's
  // recommended course is a COURSE OVER GROUND; to MAKE THAT GROUND TRACK GOOD you steer a heading that
  // leans into the set. courseToSteer solves the current triangle for that heading (and the resulting SMG).
  function courseToSteer(desiredCog, ownCog, ownSog, set, drift) {
    var g = vec(ownCog, ownSog), c = vec(set, drift);
    var Vw = Math.hypot(g[0] - c[0], g[1] - c[1]);      // |ground − current| = own speed THROUGH THE WATER
    if (Vw < 0.1) return null;                          // no way through the water to aim a heading
    var rel = (set - desiredCog) * Math.PI / 180;
    var arg = -drift * Math.sin(rel) / Vw;              // cross-track set the helm must cancel, as a fraction of Vw
    if (arg > 1 || arg < -1) return null;               // set too strong to make this track good at this speed
    var off = Math.asin(arg);
    var smg = Vw * Math.cos(off) + drift * Math.cos(rel);            // speed made good along the desired track
    return { heading: norm(desiredCog + off * 180 / Math.PI), smg: Math.round(smg * 10) / 10, waterSpeed: Math.round(Vw * 10) / 10 };
  }
  // current set & drift, only when BOTH are present and valid — else null (advice falls back to plain COG)
  function sdNow() {
    var s = (setDeg != null && isFinite(setDeg)) ? norm(setDeg) : null;
    var d = (driftKn != null && isFinite(driftKn) && driftKn > 0) ? +driftKn : null;
    return (s != null && d != null) ? { setDeg: s, driftKn: d } : null;
  }

  // adviceFor(targetProps) → null if not actionable, else the advisory object.
  function adviceFor(t, ownOverride) {
    var o = ownOverride || own;
    if (!enabled || !o || !t) return null;
    var cog = num(o.cog), sog = num(o.sog);
    var tcog = num(t.cog), tsog = num(t.sog), rng = num(t.range), brg = num(t.brg);
    if (cog == null || sog == null || tcog == null || tsog == null || rng == null || brg == null) return null;
    if (sog < 0.2) return null;                     // dead in the water — a course change does nothing

    var limit = (window.HelmAisRisk && HelmAisRisk.profile) ? HelmAisRisk.profile().cpa : 1.0;
    var P = [rng * Math.sin(brg * Math.PI / 180), rng * Math.cos(brg * Math.PI / 180)];   // own→target
    var Vt = vec(tcog, tsog);
    function cpaAtCourse(c) { var Vo = vec(c, sog); return cpaTcpa(P, [Vt[0] - Vo[0], Vt[1] - Vo[1]]); }

    var nowCpa = cpaAtCourse(cog).cpa;              // our reconstruction of the current CPA (sanity vs engine)
    var col = window.HelmColregs ? window.HelmColregs({ cog: cog, sog: sog }, t) : null;

    // Per side: the smallest turn that REACHES the limit (sustained), AND the turn that MAXIMISES CPA —
    // so when the target is already inside the limit (limit unreachable) we still give the best way out.
    function scan(dir) {
      var reached = null, bestDeg = 0, bestScore = -1, bestCpa = nowCpa;
      for (var d = 2; d <= 120; d += 2) {
        var a = cpaAtCourse(norm(cog + dir * d)), open = a.tcpa <= 0, score = open ? 999 : a.cpa;
        if (score > bestScore) { bestScore = score; bestDeg = d; bestCpa = a.cpa; }
        if (reached == null && (a.cpa >= limit || open)) {
          var c2 = cpaAtCourse(norm(cog + dir * (d + 6)));
          if (c2.cpa >= limit * 0.97 || c2.tcpa <= 0) reached = d;
        }
      }
      return { reached: reached, bestDeg: bestDeg, bestCpa: Math.round(bestCpa * 100) / 100 };
    }
    var S = scan(+1), Pt = scan(-1);

    // speed lever: slowest speed on the current course that reaches the limit
    var slowTo = null;
    for (var s = sog - 0.5; s >= 0; s -= 0.5) {
      var Vo = vec(cog, s), r = cpaTcpa(P, [Vt[0] - Vo[0], Vt[1] - Vo[1]]);
      if (r.cpa >= limit || r.tcpa <= 0) { slowTo = Math.round(s * 10) / 10; break; }
    }

    // recommend: stand-on holds; else prefer starboard (COLREGS) unless port clearly reaches with much less.
    var side = 'hold', turnDeg = null, achievable = false, clearBy = null;
    if (!col || col.role !== 'stand-on') {
      var pick;
      if (S.reached != null && (Pt.reached == null || S.reached <= Pt.reached + 12)) pick = { side: 'starboard', s: S };
      else if (Pt.reached != null) pick = { side: 'port', s: Pt };
      else pick = (S.bestCpa >= Pt.bestCpa - 0.05) ? { side: 'starboard', s: S } : { side: 'port', s: Pt };
      side = pick.side;
      achievable = pick.s.reached != null;
      turnDeg = achievable ? pick.s.reached : pick.s.bestDeg;
      clearBy = achievable ? limit : pick.s.bestCpa;
    }
    var newCourse = (side !== 'hold' && turnDeg != null) ? norm(cog + (side === 'starboard' ? 1 : -1) * turnDeg) : null;

    // AIS-14: newCourse is a COURSE OVER GROUND. If the skipper entered set & drift, solve the current
    // triangle for the heading to steer to make that ground track good (null = set too strong at this speed).
    var sd = sdNow();
    var steer = (newCourse != null && sd) ? courseToSteer(newCourse, cog, sog, sd.setDeg, sd.driftKn) : null;

    return {
      type: col && col.type, role: col && col.role, rule: col && col.rule, action: col && col.action,
      sail: !!(col && col.sail), needWind: !!(col && col.needWind),
      side: side, turnDeg: turnDeg, newCourse: newCourse, achievable: achievable, clearBy: clearBy,
      slowToKn: slowTo, limit: limit, nowCpa: Math.round(nowCpa * 100) / 100,
      setDrift: sd, steerHeading: steer ? steer.heading : null, steerSmg: steer ? steer.smg : null,
      makeGoodUnreachable: !!(sd && newCourse != null && !steer)
    };
  }

  // The map "safe-course sector" (AIS-13): for every heading, the WORST CPA across the danger targets —
  // the same relative-motion sweep adviceFor uses. Green where a heading clears the limit, red where it
  // would close inside it. ownOverride for tests / a hypothetical.
  function safeSector(targets, ownOverride, step) {
    var o = ownOverride || own;
    if (!o) return null;
    var cog = num(o.cog), sog = num(o.sog);
    if (cog == null || sog == null || sog < 0.2) return null;
    var limit = (window.HelmAisRisk && HelmAisRisk.profile) ? HelmAisRisk.profile().cpa : 1.0;
    var th = [];
    (targets || []).forEach(function (t) {
      var tcog = num(t.cog), tsog = num(t.sog), rng = num(t.range), brg = num(t.brg);
      if (tcog == null || tsog == null || rng == null || brg == null) return;
      th.push({ P: [rng * Math.sin(brg * Math.PI / 180), rng * Math.cos(brg * Math.PI / 180)], Vt: vec(tcog, tsog) });
    });
    if (!th.length) return null;
    step = step || 3;
    var headings = [];
    for (var h = 0; h < 360; h += step) {
      var Vo = vec(h, sog), worst = Infinity, closing = false;
      for (var i = 0; i < th.length; i++) {
        var r = cpaTcpa(th[i].P, [th[i].Vt[0] - Vo[0], th[i].Vt[1] - Vo[1]]);
        if (r.tcpa > 0) { closing = true; if (r.cpa < worst) worst = r.cpa; }
      }
      headings.push({ deg: h, cpa: closing ? Math.round(worst * 100) / 100 : null, safe: !closing || worst >= limit });
    }
    return { headings: headings, step: step, limit: limit, cog: cog, sog: sog, lon: num(o.lon), lat: num(o.lat) };
  }

  function setEnabled(v) {
    enabled = !!v; save();
    try { if (window.dispatchEvent && window.CustomEvent) window.dispatchEvent(new CustomEvent('helm:ais-advisor', { detail: { on: enabled } })); } catch (e) {}
  }

  // ---- sailing context (Rules 12 & 18): own propulsion mode + the best wind we have ----
  function measuredTwd() {
    try {
      if (!lastNav || (lastNav.sources && lastNav.sources.wind === 'missing')) return null;
      var tw = window.HelmTrueWind && HelmTrueWind.fromNav && HelmTrueWind.fromNav(lastNav);   // WX-13
      return tw && isFinite(tw.twd) ? tw.twd : null;
    } catch (e) { return null; }
  }
  // collision.js classify() reads this. Skipper-set wind wins; else measured WX-13 true wind; else null
  // (Rule 12 then asks for it). Own mode is the skipper's call (a sailboat motoring is power-driven).
  function sailCtx() {
    var w = (windFrom != null && isFinite(windFrom)) ? norm(windFrom) : measuredTwd();
    return { underSail: ownUnderSail === true, twd: (w == null ? null : norm(w)), windSource: windFrom != null ? 'set' : (w != null ? 'measured' : null) };
  }
  function setUnderSail(v) { ownUnderSail = !!v; saveKey(K_SAIL, ownUnderSail); }
  function setWind(deg) { windFrom = (deg == null || deg === '' || !isFinite(+deg)) ? null : norm(+deg); saveKey(K_WIND, windFrom); }
  function setSetDrift(s, d) {
    setDeg = (s == null || s === '' || !isFinite(+s)) ? null : norm(+s);
    driftKn = (d == null || d === '' || !isFinite(+d) || +d < 0) ? null : +d;
    saveKey(K_SET, setDeg); saveKey(K_DRIFT, driftKn);
  }
  window.HelmSailCtx = sailCtx;

  // best-effort toggle in the AIS hub header (works regardless; the flag persists either way)
  function mountToggle() {
    if (document.getElementById('helm-advisor-toggle')) return;
    var hd = document.querySelector('#helm-ais .aish-hd'); if (!hd) return;   // header element; wait if not rendered yet
    try {
      var lab = document.createElement('label');
      lab.id = 'helm-advisor-toggle';
      lab.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--cdim);cursor:pointer;margin-left:auto;white-space:nowrap';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = enabled;
      cb.style.cssText = 'width:13px;height:13px;accent-color:#5dd0b0';
      cb.addEventListener('change', function () { setEnabled(cb.checked); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode('Evasion advisor'));
      hd.style.flexWrap = 'wrap'; hd.style.rowGap = '4px';
      hd.appendChild(lab);
      var sail = document.createElement('label');
      sail.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:var(--cdim);cursor:pointer;white-space:nowrap';
      var scb = document.createElement('input'); scb.type = 'checkbox'; scb.checked = ownUnderSail; scb.style.cssText = 'width:13px;height:13px;accent-color:#5dd0b0';
      scb.addEventListener('change', function () { setUnderSail(scb.checked); });
      sail.appendChild(scb); sail.appendChild(document.createTextNode('Under sail'));
      var wlab = document.createElement('label');
      wlab.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:var(--cdim);white-space:nowrap';
      var wi = document.createElement('input'); wi.type = 'number'; wi.min = '0'; wi.max = '359'; wi.placeholder = '—'; wi.value = (windFrom != null ? windFrom : '');
      wi.style.cssText = 'width:42px;font-size:11px;padding:2px 4px;border:1px solid rgba(255,255,255,.16);border-radius:5px;background:transparent;color:var(--ctext)';
      wi.title = 'True wind FROM direction (°) for the sailing rules — auto from a wind instrument if you have one';
      wi.addEventListener('change', function () { setWind(wi.value); });
      wlab.appendChild(document.createTextNode('Wind')); wlab.appendChild(wi);
      // Set & drift (AIS-14) — manual current; turns the advised ground track into a heading to steer.
      var sdlab = document.createElement('label');
      sdlab.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:var(--cdim);white-space:nowrap';
      var si = document.createElement('input'); si.type = 'number'; si.min = '0'; si.max = '359'; si.placeholder = 'set°'; si.value = (setDeg != null ? setDeg : '');
      si.style.cssText = 'width:40px;font-size:11px;padding:2px 4px;border:1px solid rgba(255,255,255,.16);border-radius:5px;background:transparent;color:var(--ctext)';
      si.title = 'Current SET — the compass direction the water flows TOWARD (°)';
      var di = document.createElement('input'); di.type = 'number'; di.min = '0'; di.step = '0.1'; di.placeholder = 'kn'; di.value = (driftKn != null ? driftKn : '');
      di.style.cssText = 'width:38px;font-size:11px;padding:2px 4px;border:1px solid rgba(255,255,255,.16);border-radius:5px;background:transparent;color:var(--ctext)';
      di.title = 'Current DRIFT — its speed (kn). With set, gives the heading to steer to make the advised ground track good.';
      function pushSD() { setSetDrift(si.value, di.value); }
      si.addEventListener('change', pushSD); di.addEventListener('change', pushSD);
      sdlab.appendChild(document.createTextNode('Set')); sdlab.appendChild(si); sdlab.appendChild(di);
      hd.appendChild(sail); hd.appendChild(wlab); hd.appendChild(sdlab);
    } catch (e) { /* hub mid-render — a later retry catches it */ }
  }
  if (window.HelmShell && HelmShell.onNav) HelmShell.onNav(function (s) { if (s) { lastNav = s; own = { cog: s.cog, sog: s.sog, lat: s.lat, lon: s.lon }; } });
  if (document.readyState !== 'loading') mountToggle(); else document.addEventListener('DOMContentLoaded', mountToggle);
  setTimeout(mountToggle, 1000); setTimeout(mountToggle, 2500);
  // The AIS hub header (#helm-ais .aish-hd) renders LAZILY — it doesn't exist until the hub panel first
  // opens, which is almost always AFTER the early timers above. So those eager attempts find no header
  // and bail, and the controls never appear. Fix: watch the DOM and (re)mount the moment the header
  // shows up — and again if the hub is rebuilt on a later open. mountToggle is idempotent (it returns
  // early once #helm-advisor-toggle exists), so the observer settles to a cheap O(1) no-op after mount.
  try {
    var _mtPending = false;
    var _mtObs = new MutationObserver(function () {
      if (_mtPending || document.getElementById('helm-advisor-toggle')) return;   // mounted or queued → skip
      if (!document.querySelector('#helm-ais .aish-hd')) return;                   // header not up yet
      _mtPending = true; setTimeout(function () { _mtPending = false; mountToggle(); }, 60);
    });
    _mtObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    for (var _t = 4000; _t <= 24000; _t += 4000) setTimeout(mountToggle, _t);      // no MutationObserver → longer polling fallback
  }

  window.HelmAisAdvisor = { adviceFor: adviceFor, safeSector: safeSector, isEnabled: function () { return enabled; }, setEnabled: setEnabled,
    setUnderSail: setUnderSail, setWind: setWind, setSetDrift: setSetDrift, getSetDrift: sdNow, sailCtx: sailCtx,
    getTargetKind: getTargetKind, setTargetKind: setTargetKind };
})();
