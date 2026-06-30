// HelmAisRisk — single source of truth for AIS collision-risk tiers + palette across the app.
//
// "Is this target dangerous?" was previously defined SIX different ways with three threshold
// families: the CPA alarm, the tap-card popup/list/moored-suppression guard, and the chart symbol
// colour. On safety software that is unacceptable: one vessel must not be red on one surface and
// boring-blue on another.
//
// Now every surface routes through this module:
//   • JS:        tier(t) / isDanger(t) / color(t)
//   • MapLibre:  dangerExpr() / riskColorExpr() / riskIconExpr()
//
// Cortex-style profiles: Vesper/Garmin's Cortex groups collision alarm settings into profiles that
// change CPA, TCPA, and target-speed suppression together. We mirror that idea here: Harbor is noisy
// and suppresses slow targets aggressively, Bay is the everyday middle ground, and Open ocean extends
// the CPA/TCPA horizon. CAUTION is a wider pre-alarm "watch" band; DANGER is the active profile's CPA
// alarm predicate exactly, so a target the alarm fires on is red EVERYWHERE.
//
// AUTHORITATIVE & FORWARD-COMPATIBLE: cpa/tcpa/cpaValid come from the engine and are never recomputed
// here. If the engine ever emits a per-target `risk` string, tier() and the expressions PREFER it —
// so the thresholds can later move into the core without touching a single client.
(function (global) {
  'use strict';

  var PROFILE_KEY = 'helm.ais.risk.profile';
  var DEFAULT_PROFILE = 'bay';
  var PROFILES = {
    harbor: { id: 'harbor', label: 'Harbor', cpa: 2.0, tcpa: 10.0, minTargetSog: 5.0 },
    bay: { id: 'bay', label: 'Bay', cpa: 2.0, tcpa: 30.0, minTargetSog: 2.0 },   // DEFAULT — matches the engine's g_CPAWarn_NM/g_TCPA_Max (single source of truth)
    ocean: { id: 'ocean', label: 'Open ocean', cpa: 4.0, tcpa: 60.0, minTargetSog: 0.5 }
  };
  var CAUTION_MULT = 2.0;                       // pre-alarm "watch" band — 2x the active profile
  // Anchored auto-tighten: when OWN ship is effectively stationary, a target passing far off isn't
  // closing on us, so cap the CPA/TCPA bands at Harbor-tight — never looser. Fed by the live ownship
  // SOG (HelmShell.onNav, wired at the bottom). Close targets are still flagged (a boat could drift
  // onto an anchored hull); only the distant "noise" is dropped.
  var ANCHORED_KTS = 0.5;
  var ownSog = null, anchored = false;
  // Hard-CPA floor (SAFETY): a near-certain hit must read DANGER even when it's OUTSIDE the active
  // profile's TCPA window. Anchored auto-tightening caps the window at 10 min, so an 8 kn boat dead-on
  // at 0.02 NM but 14 min out would otherwise read only "caution". Below HIT_CPA_NM and still closing
  // within HIT_TCPA_MAX we escalate to danger regardless of the band — and regardless of an engine
  // 'caution'/'normal' (a stricter CLIENT policy on the engine's authoritative cpa/tcpa; never a downgrade).
  var HIT_CPA_NM = 0.1, HIT_TCPA_MAX = 30.0;
  // Underway override: the anchored auto-tighten assumes "stationary == safely parked" — wrong for
  // hove-to / drifting / fishing, where you want the WIDER bands + earlier warning. This lets the
  // skipper say "treat me as underway" so a low SOG no longer tightens the profile.
  var UNDERWAY_KEY = 'helm.ais.risk.underway';
  function loadUnderway() { try { return !!(global.localStorage && global.localStorage.getItem(UNDERWAY_KEY) === '1'); } catch (e) { return false; } }
  var underwayOverride = loadUnderway();
  // Canonical palette in ONE place. danger/caution/normal for the risk tiers; lost/sart for the
  // symbology overrides (a SART is always distress-pink; a lost/aged target is always grey).
  var COL = { danger: '#ff5a52', caution: '#f5c451', normal: '#43d17d', lost: '#7d8a98', sart: '#ff3b8b' };

  function n(v) { return (v == null || v === '') ? null : (isFinite(+v) ? +v : null); }
  function clone(p) { return { id: p.id, label: p.label, cpa: p.cpa, tcpa: p.tcpa, minTargetSog: p.minTargetSog }; }
  function loadProfile() {
    try {
      var id = global.localStorage && global.localStorage.getItem(PROFILE_KEY);
      return PROFILES[id] ? id : DEFAULT_PROFILE;
    } catch (e) { return DEFAULT_PROFILE; }
  }
  var activeProfile = loadProfile();
  function baseProfile() { return PROFILES[activeProfile] || PROFILES[DEFAULT_PROFILE]; }
  // The EFFECTIVE profile drives EVERY threshold (tier + all expressions). When anchored we cap to
  // Harbor-tight so distant targets stop reading as a threat — but we keep the selected profile's id
  // (for the UI) and target-speed gate.
  function settings() {
    var b = baseProfile();
    if (!anchored || underwayOverride) return b;      // hove-to/drifting: skipper kept the wide bands
    var h = PROFILES.harbor;
    return { id: b.id, label: b.label, cpa: Math.min(b.cpa, h.cpa), tcpa: Math.min(b.tcpa, h.tcpa), minTargetSog: b.minTargetSog };
  }
  function profile() { var s = settings(); return { id: s.id, label: s.label, cpa: s.cpa, tcpa: s.tcpa, minTargetSog: s.minTargetSog, anchored: anchored, underway: underwayOverride, tightened: anchored && !underwayOverride }; }
  function profiles() {
    return Object.keys(PROFILES).map(function (id) { return clone(PROFILES[id]); });
  }
  // Push the EFFECTIVE (anchored-aware) profile thresholds to the engine, so its authoritative per-target
  // risk tier + CPA alarm re-band live. The client PREFERS the engine's risk, so without this the
  // Harbor/Bay/Ocean selector wouldn't change anything on live data (engine risk would stay at startup).
  function pushToEngine() {
    try {
      var s = settings();
      if (global.__navClient && global.__navClient.send) global.__navClient.send({ t: 'ais.risk', cpa: s.cpa, tcpa: s.tcpa, minSog: s.minTargetSog });
    } catch (e) {}
  }
  function fireChanged() {
    try { if (global.dispatchEvent && global.CustomEvent) global.dispatchEvent(new global.CustomEvent('helm:ais-risk-profile', { detail: profile() })); } catch (e) {}
    pushToEngine();
  }
  function setProfile(id) {
    if (!PROFILES[id]) return profile();
    activeProfile = id;
    try { if (global.localStorage) global.localStorage.setItem(PROFILE_KEY, id); } catch (e) {}
    fireChanged();                              // selected profile changed → consumers re-apply
    return profile();
  }
  // "Treat me as underway" — disable the anchored auto-tighten for hove-to / drifting / fishing.
  function setUnderwayOverride(v) {
    var nv = !!v;
    if (nv === underwayOverride) return profile();
    underwayOverride = nv;
    try { if (global.localStorage) global.localStorage.setItem(UNDERWAY_KEY, nv ? '1' : '0'); } catch (e) {}
    fireChanged();                              // tightening toggled → re-band engine + re-apply chart exprs
    return profile();
  }
  // Live ownship speed → anchored detection. Crossing the threshold re-fires the change event so the
  // STATIC chart colour/icon expressions get re-applied (collision.js listens); per-frame consumers
  // (ais-vectors cones, the list) already re-read settings() each tick.
  function setOwnSpeed(s) {
    var v = n(s); var now = (v != null && v < ANCHORED_KTS);
    if (now !== anchored) { anchored = now; fireChanged(); }
  }
  // Missing SOG stays alarm-eligible (fail safe). Known slow/stationary targets are suppressed by
  // the active profile's target-speed threshold.
  function targetSpeedOK(t, p) {
    var sog = n(t && t.sog);
    return sog == null || sog >= p.minTargetSog;
  }
  function targetSpeedOkExpr(p) {
    return ['any',
      ['!', ['has', 'sog']],
      ['>=', ['coalesce', ['get', 'sog'], 999], p.minTargetSog]];
  }
  // Hard-CPA floor as a MapLibre predicate (chart symbol/cone parity with tier()'s floor).
  function hardHitExpr(p) {
    return ['all',
      ['!=', ['get', 'cpaValid'], false],
      targetSpeedOkExpr(p),
      ['<', ['coalesce', ['get', 'cpa'], 99], HIT_CPA_NM],
      ['>', ['coalesce', ['get', 'tcpa'], -999], 0],
      ['<', ['coalesce', ['get', 'tcpa'], 99], HIT_TCPA_MAX]];
  }

  // tier(t) → 'danger' | 'caution' | 'normal', from the engine's authoritative cpa/tcpa.
  function tier(t) {
    if (!t) return 'normal';
    var cpa = n(t.cpa), tcpa = n(t.tcpa), p = settings();
    // Hard-CPA floor FIRST: a near-certain hit still closing within the window is DANGER, overriding an
    // engine/profile 'caution'/'normal'. Uses the engine's authoritative cpa/tcpa; never a downgrade.
    if ((t.cpaValid !== false && t.cpaValid !== 'false') && targetSpeedOK(t, p)
        && cpa != null && cpa < HIT_CPA_NM && tcpa != null && tcpa > 0 && tcpa < HIT_TCPA_MAX) return 'danger';
    if (t.risk === 'danger' || t.risk === 'caution' || t.risk === 'normal') return t.risk;   // engine wins (below the hard floor)
    if (t.cpaValid === false || t.cpaValid === 'false') return 'normal';      // no valid CPA solution
    if (cpa == null) return 'normal';
    if (!targetSpeedOK(t, p)) return 'normal';                                // profile speed gate
    if (tcpa == null) return cpa < p.cpa ? 'caution' : 'normal';              // no tcpa: can't assert closing → cap at caution
    if (tcpa <= 0) return 'normal';                                           // opening / past CPA — not a threat
    if (cpa < p.cpa && tcpa < p.tcpa) return 'danger';                        // == active profile's CPA alarm
    if (cpa < p.cpa * CAUTION_MULT && tcpa < p.tcpa * CAUTION_MULT) return 'caution';
    return 'normal';
  }
  function isDanger(t) { return tier(t) === 'danger'; }
  function color(t) { return COL[tier(t)] || COL.normal; }

  // ---- MapLibre data-driven expressions, built from the SAME active profile (raw feature props) ----
  // Boolean: is this feature in the danger band? Mirrors isDanger() / the alarm.
  function dangerExpr() {
    var p = settings();
    var localDanger = ['all',
      ['!=', ['get', 'cpaValid'], false],
      targetSpeedOkExpr(p),
      ['<', ['coalesce', ['get', 'cpa'], 99], p.cpa],
      ['>', ['coalesce', ['get', 'tcpa'], -999], 0],
      ['<', ['coalesce', ['get', 'tcpa'], 99], p.tcpa]];
    // Top-level 'any': engine risk='danger', OR (when the engine emits no risk field) the local
    // geometry falls inside the active profile's danger band. Engine caution/normal still wins —
    // the local clause is gated on the risk field being ABSENT — preserving engine authority.
    return ['any',
      ['==', ['get', 'risk'], 'danger'],
      hardHitExpr(p),                                            // hard-CPA floor — escalates over an engine downgrade
      ['all', ['!', ['has', 'risk']], localDanger]];
  }
  function tierExprValue(dangerValue, cautionValue, normalValue) {
    var p = settings();
    var cpa = ['coalesce', ['get', 'cpa'], 99];
    var tcpa = ['coalesce', ['get', 'tcpa'], -999];
    var speedOK = targetSpeedOkExpr(p);
    var danger = ['all', speedOK, ['<', cpa, p.cpa], ['>', tcpa, 0], ['<', tcpa, p.tcpa]];
    var caution = ['all', speedOK, ['<', cpa, p.cpa * CAUTION_MULT], ['>', tcpa, 0], ['<', tcpa, p.tcpa * CAUTION_MULT]];
    var cautionNoTcpa = ['all', speedOK, ['!', ['has', 'tcpa']], ['<', cpa, p.cpa]];
    return ['case',
      hardHitExpr(p), dangerValue,                              // hard-CPA floor first — overrides an engine downgrade
      ['==', ['get', 'risk'], 'danger'], dangerValue,
      ['==', ['get', 'risk'], 'caution'], cautionValue,
      ['==', ['get', 'risk'], 'normal'], normalValue,
      ['==', ['get', 'cpaValid'], false], normalValue,
      ['!', ['has', 'cpa']], normalValue,
      danger, dangerValue,
      caution, cautionValue,
      cautionNoTcpa, cautionValue,
      normalValue];
  }
  // Colour expression mirroring tier()→color for the danger/caution/normal tiers. Callers layer
  // SART / lost overrides on top (those are symbology concepts, not risk tiers).
  function riskColorExpr() {
    return tierExprValue(COL.danger, COL.caution, COL.normal);
  }
  // Icon expression mirroring tier() for layers that use generated ship icons instead of text colour.
  function riskIconExpr(icon) {
    icon = icon || {};
    return tierExprValue(icon.danger || '', icon.caution || '', icon.normal || '');
  }

  global.HelmAisRisk = {
    tier: tier, isDanger: isDanger, color: color,
    dangerExpr: dangerExpr, riskColorExpr: riskColorExpr, riskIconExpr: riskIconExpr,
    profile: profile, profiles: profiles, setProfile: setProfile, setOwnSpeed: setOwnSpeed, setUnderwayOverride: setUnderwayOverride,
    PROFILE_KEY: PROFILE_KEY, DEFAULT_PROFILE: DEFAULT_PROFILE, CAUTION_MULT: CAUTION_MULT, COL: COL,
    // Compatibility aliases for older callers. They reflect the active profile at load time only;
    // new code should call profile(), dangerExpr(), riskColorExpr(), or riskIconExpr().
    CPA_WARN: settings().cpa, TCPA_MAX: settings().tcpa,
    CPA_CAUTION: settings().cpa * CAUTION_MULT, TCPA_CAUTION: settings().tcpa * CAUTION_MULT
  };

  // Auto-feed the live ownship SOG so "anchored" is detected with no caller wiring. ais-risk.js loads
  // after shell.js, so HelmShell.onNav is available; each nav frame carries the ownship sog.
  try {
    var _pushed = false;
    if (global.HelmShell && global.HelmShell.onNav) global.HelmShell.onNav(function (s) {
      if (!s) return;
      setOwnSpeed(s.sog);
      if (!_pushed) { _pushed = true; pushToEngine(); }   // apply the loaded/active profile to the engine once the nav WS is up
    });
  } catch (e) {}
})(typeof window !== 'undefined' ? window : this);
