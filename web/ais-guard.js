// HelmAisGuard — AIS-5: AIS guard zone / proximity alarm.
//
// A user-armed proximity ring around ownship: when any AIS target comes within the set radius, raise
// a guard-zone alarm (banner + beep + chart highlight), and clear it when the target leaves. This is
// the OpenCPN "guard zone / proximity" alarm — distinct from the CPA alarm (collision.js), which is
// about closest approach on current courses; this is about a target being physically NEAR you NOW.
//
// SAFETY / FAIL-LOUD (per the fail-and-fix-early policy):
//   • Fed EVERY nav frame via HelmShell.onNav (ungated on position) with the FULL engine target list —
//     NOT map.querySourceFeatures (viewport-limited) and NOT gated behind `if (s.pos)` (a position
//     dropout while AIS streams is exactly when proximity matters; the guard must still run and SAY
//     it has no fix rather than go dark).
//   • An armed zone that can't actually watch never reads "all clear": it surfaces an explicit notice
//     for (a) no position fix, (b) a confirmed AIS feed offline, (c) no nav frames at all (watchdog,
//     even if it was never fed since arming). `everLive` latches like collision.js so a connection-
//     status blip with live targets present does NOT suppress detection.
//   • A missing input never ERASES an active breach: the moving-only filter only gates NEW entries
//     with a known SOG, and a confirmed-offline feed freezes the last-known breach set rather than
//     wiping it.
//
// CONTRACT: alarms are modelled in the FROZEN CONTRACT-10 schema (docs/CONTRACT-ALARM-SCHEMA.md §8):
//   id "guardzone:<zoneId>:<mmsi>", kind "guardzone", sev "warning",
//   data { mmsi, zoneId, name, rangeM, bearingDeg, sog, cog, cpaNM, tcpaMin }.
// Computed CLIENT-SIDE today (the engine emits no alarm frames yet — §10 handoff) and rendered here,
// exactly as collision.js renders CPA client-side. `rev` bumps only on a MATERIAL change so it stays a
// true state-revision; activeAlarms() exposes the set in schema shape so the future engine-pushed /
// alarms.js id-keyed path is a drop-in.
(function () {
  'use strict';

  var M_PER_NM = 1852, DEG = Math.PI / 180;
  var HYST_NM = 0.1;          // exit hysteresis (clear at radius+HYST) so a target on the boundary can't flap
  var MOVING_KTS = 0.5;       // "moving only" filter threshold
  var WATCHDOG_MS = 12000;    // armed but no nav frame this long → surface (engine/feed went silent)
  var NOSRC_GRACE_MS = 8000;  // armed + never any AIS evidence this long → surface "no AIS source"

  // ---- persisted prefs ----
  var PREF = {
    on:      load('helm.ais.guard.on', false),
    radius:  load('helm.ais.guard.radius', 1.0),   // NM
    moving:  load('helm.ais.guard.moving', false)  // alarm on moving targets only (declutter anchorages)
  };
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function persist() {
    try {
      localStorage.setItem('helm.ais.guard.on', JSON.stringify(PREF.on));
      localStorage.setItem('helm.ais.guard.radius', JSON.stringify(PREF.radius));
      localStorage.setItem('helm.ais.guard.moving', JSON.stringify(PREF.moving));
    } catch (e) { /* private mode — in-memory only */ }
  }

  // ---- geo ----
  function num(v) { return (v == null || v === '') ? null : (isFinite(+v) ? +v : null); }
  function haversineNM(a, b) {
    var dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
    var la1 = a.lat * DEG, la2 = b.lat * DEG;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));   // 3440.065 NM = earth radius
  }
  function bearingDeg(a, b) {
    var la1 = a.lat * DEG, la2 = b.lat * DEG, dLon = (b.lon - a.lon) * DEG;
    var y = Math.sin(dLon) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    var d = Math.atan2(y, x) / DEG; return (d + 360) % 360;
  }
  function circle(lat, lon, radiusNM, steps) {
    steps = steps || 64;
    var cosLat = Math.max(Math.abs(Math.cos(lat * DEG)), 0.01);
    var dLat = radiusNM / 60, dLon = radiusNM / (60 * cosLat);   // 1 NM = 1/60 deg lat
    var ring = [];
    for (var i = 0; i <= steps; i++) { var th = (i / steps) * 2 * Math.PI; ring.push([lon + dLon * Math.sin(th), lat + dLat * Math.cos(th)]); }
    return { type: 'Polygon', coordinates: [ring] };
  }
  var fmtNM = function (nm) { return (nm < 1 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM'; };
  var nameOf = function (t) { var n = String(t.name == null ? '' : t.name).replace(/@+/g, '').trim(); return (n && !/^unknown$/i.test(n)) ? n : ('MMSI ' + (t.mmsi != null ? t.mmsi : '?')); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ============================================================================================
  function build() {
    var ZONE_ID = 'ownship-ring';
    var breaching = {};          // mmsi -> frozen-schema alarm object (currently-active breaches)
    var lastSig = {};            // mmsi -> last material signature (for rev: bump only on real change)
    var ackedMmsi = {};          // mmsi -> 1 once the user has silenced it (cleared when it leaves)
    var everLive = false;        // have we ever seen the AIS feed live (connected, or targets present)?
    var pulse = null, actx = null;
    // Seed the timers to NOW (like collision.js) so a guard armed from persisted prefs on page load
    // gets a full grace window before the watchdog / no-source notice fire — and so an armed-but-never-
    // fed guard still surfaces after the grace rather than firing instantly (lastUpdateAt=0) or never.
    // lastFeedOkAt = the last frame the AIS feed was confirmed working (the grace anchor for "no data").
    var lastUpdateAt = Date.now(), lastFeedOkAt = Date.now(), watchWarned = false, lastOwn = null;

    // ---- banner (matches the CPA alarm's glass aesthetic; injected scoped CSS) ----
    var css = document.createElement('style');
    css.textContent =
      '.guard-alarm{position:absolute;top:60px;left:50%;transform:translateX(-50%);z-index:8;max-width:420px;' +
        'border-radius:13px;padding:10px 12px;display:flex;gap:11px;align-items:flex-start;' +
        'background:var(--glass,rgba(20,28,38,.82));backdrop-filter:blur(12px);' +
        'border:.5px solid rgba(245,196,81,.55);box-shadow:0 18px 60px -20px rgba(0,0,0,.85),0 0 0 1px rgba(245,196,81,.25)}' +
      '.guard-alarm[hidden]{display:none}' +
      '.guard-ic{font-size:19px;line-height:1.1;flex:none;color:#f5c451}' +
      '.guard-body{flex:1;min-width:0}' +
      '.guard-ttl{font-size:12.5px;font-weight:600;color:#fff;margin-bottom:2px}' +
      '.guard-tgt{font-size:11px;color:var(--cdim,#9bb0c0);font-variant-numeric:tabular-nums;line-height:1.4}' +
      '.guard-more{font-size:10.5px;color:#f5c451;margin-top:3px}' +
      '.guard-disc{font-size:9.5px;color:var(--cdim2,#6f8597);margin-top:5px;line-height:1.3;border-top:.5px solid var(--line2,rgba(255,255,255,.07));padding-top:5px}' +
      '.guard-btns{display:flex;flex-direction:column;gap:5px;flex:none}' +
      '.guard-btn{cursor:pointer;width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--glass2,rgba(255,255,255,.06));font-size:12px;color:var(--cdim,#9bb0c0)}' +
      '.guard-btn:hover{color:var(--ctext,#cdd9e3)}';
    document.head.appendChild(css);
    var el = document.createElement('div');
    el.className = 'guard-alarm glass'; el.hidden = true;
    document.body.appendChild(el);

    function beep() {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = 760; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, actx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.13, actx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.4);
        o.start(); o.stop(actx.currentTime + 0.45);
      } catch (e) { /* audio needs a user gesture; banner still shows */ }
    }

    // ---- chart layers (SECONDARY): every op resolves the LIVE window.map and bails safely, so the
    // breach detection + banner never depend on the chart rendering or a stale/recreated map. ----
    var built = false;
    function liveMap() { var m = window.map; return (m && typeof m.getSource === 'function' && m.getStyle && m.getStyle()) ? m : null; }
    function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
    function setData(id, fc) { var m = liveMap(); if (!m) return; var s = m.getSource(id); if (s) s.setData(fc); }
    function ensureLayers() {
      if (built) return;
      var map = liveMap(); if (!map) return;
      try {
        if (!map.getSource('helm-ais-guard-zone')) map.addSource('helm-ais-guard-zone', { type: 'geojson', data: emptyFC() });
        if (!map.getSource('helm-ais-guard-breach')) map.addSource('helm-ais-guard-breach', { type: 'geojson', data: emptyFC() });
        var before = map.getLayer('ais-vessels') ? 'ais-vessels' : (map.getLayer('helm-ais-symbol') ? 'helm-ais-symbol' : undefined);
        function addL(spec) { if (!map.getLayer(spec.id)) map.addLayer(spec, before); }
        addL({ id: 'helm-ais-guard-fill', type: 'fill', source: 'helm-ais-guard-zone', paint: { 'fill-color': '#f5c451', 'fill-opacity': 0.05 } });
        addL({ id: 'helm-ais-guard-ring', type: 'line', source: 'helm-ais-guard-zone', paint: { 'line-color': '#f5c451', 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } });
        addL({ id: 'helm-ais-guard-breach', type: 'circle', source: 'helm-ais-guard-breach', paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#f5c451', 'circle-stroke-width': 2.5 } });
        built = true;
      } catch (e) { console.error('[AIS] guard-zone layer build failed:', e && e.message); }   // surface, don't swallow
    }
    function startPulse() { if (pulse) return; var on = true; pulse = setInterval(function () { var m = liveMap(); on = !on; if (m && m.getLayer('helm-ais-guard-breach')) m.setPaintProperty('helm-ais-guard-breach', 'circle-stroke-opacity', on ? 0.95 : 0.3); }, 600); }
    function stopPulse() { if (pulse) { clearInterval(pulse); pulse = null; } }
    function clearChart() { setData('helm-ais-guard-zone', emptyFC()); setData('helm-ais-guard-breach', emptyFC()); stopPulse(); }
    function hideAll() { el.hidden = true; clearChart(); }
    function drawRing(own) { setData('helm-ais-guard-zone', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: circle(own.lat, own.lon, +PREF.radius) }] }); }

    // ---- fail-loud notice banner (an armed zone that can't watch must SAY so). Does NOT touch the
    // breach chart source — callers decide whether to freeze or clear the highlights. ----
    function notice(title, body) {
      el.className = 'guard-alarm glass';
      el.innerHTML =
        '<div class="guard-ic">⚠</div>' +
        '<div class="guard-body"><div class="guard-ttl">' + esc(title) + '</div>' +
        '<div class="guard-tgt">' + esc(body) + '</div>' +
        '<div class="guard-disc">This is NOT "all clear" — keep a visual lookout.</div></div>';
      el.hidden = false; stopPulse();
    }

    // ---- frozen-schema alarm object for a breach (CONTRACT-10 §8); rev bumps only on material change ----
    function alarmFor(own, t, rangeNM) {
      var brg = Math.round(bearingDeg(own, t));
      var sog = num(t.sog), cog = num(t.cog), cpa = num(t.cpa), tcpa = num(t.tcpa);
      var name = nameOf(t), rangeM = Math.round(rangeNM * M_PER_NM);
      var sig = rangeM + '|' + brg + '|' + (sog == null ? '' : sog.toFixed(1));   // material state
      var prev = breaching[t.mmsi];
      var changed = !prev || lastSig[t.mmsi] !== sig;
      lastSig[t.mmsi] = sig;
      return {
        t: 'alarm', op: prev ? 'update' : 'raise',
        id: 'guardzone:' + ZONE_ID + ':' + t.mmsi,
        rev: prev ? (changed ? prev.rev + 1 : prev.rev) : 1,     // monotonic per id, +1 only on real change
        kind: 'guardzone', sev: 'warning',
        msg: 'Guard zone — ' + name + ' ' + fmtNM(rangeNM) + ', brg ' + brg + '°' + (sog != null ? ', ' + sog.toFixed(1) + ' kn' : ''),
        lat: t.lat, lon: t.lon,
        data: { mmsi: t.mmsi, zoneId: ZONE_ID, name: name, rangeM: rangeM, bearingDeg: brg, sog: sog, cog: cog, cpaNM: cpa, tcpaMin: tcpa }
      };
    }

    // ---- main: one nav frame → detect breaches over the FULL list ----
    function update(own, list, feedAlive) {
      lastUpdateAt = Date.now(); watchWarned = false; lastOwn = own;
      if (!PREF.on) { hideAll(); breaching = {}; lastSig = {}; ackedMmsi = {}; return; }
      ensureLayers();
      var arr = Array.isArray(list) ? list : [];
      // Is the AIS feed CONFIRMED working THIS frame? connected source, or at least one target arriving.
      // (feedAlive is connection status, not data presence — so targets-present also counts.) We only
      // trust the list (detect + clear-departed) when this is true; otherwise an empty list is "no data",
      // NOT "zone clear", and we must not wipe an active breach.
      var feedOk = (feedAlive === true) || (arr.length > 0);
      if (feedOk) { everLive = true; lastFeedOkAt = Date.now(); }

      // FAIL-LOUD: no position fix → can't measure proximity at all. Clear (positions untrustworthy).
      if (!own || own.lon == null || own.lat == null || !isFinite(+own.lon) || !isFinite(+own.lat)) {
        clearChart(); breaching = {}; lastSig = {}; ackedMmsi = {};
        notice('Guard zone — no position fix', 'Cannot measure proximity without ownship position.'); return;
      }

      drawRing(own);   // we have a fix → always show the armed ring on the boat

      // FAIL-LOUD: feed not confirmed working. FREEZE the last-known breach set (never wiped) and the
      // ring; do NOT run detection (an empty/partial list here is missing data, not a clear zone). Past
      // the grace window, surface an explicit notice so an empty ring can never read as "all clear" —
      // "offline" if the feed worked earlier this session, "no AIS source" if it never has. Within the
      // grace window we stay quiet (startup / a one-frame blip) without flapping the banner or beep.
      if (!feedOk) {
        if (Date.now() - lastFeedOkAt > NOSRC_GRACE_MS) {
          if (everLive) notice('Guard zone — AIS feed offline', 'Proximity monitoring is paused; no AIS data is arriving from the source.');
          else notice('Guard zone — no AIS targets', 'Armed, but no AIS source is providing targets. Check that an AIS feed is connected.');
        }
        return;
      }

      var seen = {}, newUnacked = false, breachFeats = [];
      var R = +PREF.radius;
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (t == null || t.mmsi == null) continue;
        var lon = num(t.lon != null ? t.lon : (t.geometry && t.geometry.coordinates && t.geometry.coordinates[0]));
        var lat = num(t.lat != null ? t.lat : (t.geometry && t.geometry.coordinates && t.geometry.coordinates[1]));
        if (lon == null || lat == null) continue;
        var tt = { mmsi: t.mmsi, name: t.name, lon: lon, lat: lat, sog: t.sog, cog: t.cog, cpa: t.cpa, tcpa: t.tcpa };
        var prev = breaching[tt.mmsi];
        // moving-only filter: declutter anchored boats — but ONLY skip a NEW target with a KNOWN slow
        // speed. Absent SOG = "unknown, keep watching"; an already-active breach is NEVER dropped here.
        if (!prev && PREF.moving && num(tt.sog) != null && num(tt.sog) < MOVING_KTS) continue;
        var range = (num(t.range) != null) ? num(t.range) : haversineNM(own, tt);
        var inside = prev ? (range <= R + HYST_NM) : (range < R);   // hysteresis on exit
        if (!inside) continue;
        seen[tt.mmsi] = 1;
        if (!prev && !ackedMmsi[tt.mmsi]) newUnacked = true;        // a genuinely new, un-silenced target
        breaching[tt.mmsi] = alarmFor(own, tt, range);
        breachFeats.push({ type: 'Feature', properties: { mmsi: tt.mmsi }, geometry: { type: 'Point', coordinates: [tt.lon, tt.lat] } });
      }
      // drop breaches that left the zone / fell off the feed (and forget their ack + signature)
      for (var k in breaching) if (!seen[k]) { delete breaching[k]; delete lastSig[k]; delete ackedMmsi[k]; }

      var active = Object.keys(breaching).map(function (m) { return breaching[m]; }).sort(function (a, b) { return a.data.rangeM - b.data.rangeM; });
      if (!active.length) { el.hidden = true; setData('helm-ais-guard-breach', emptyFC()); stopPulse(); return; }

      setData('helm-ais-guard-breach', { type: 'FeatureCollection', features: breachFeats });
      startPulse();
      if (newUnacked) beep();                                       // beep only for a genuinely-new, un-acked target
      var unacked = active.filter(function (a) { return !ackedMmsi[a.data.mmsi]; });
      renderBanner(active);
      el.hidden = (unacked.length === 0);                           // hidden only when every active breach is silenced
    }

    function renderBanner(active) {
      var worst = active[0];
      var cpa = document.querySelector('.cpa-alarm');               // stack below the CPA banner if it's up
      el.style.top = (cpa && !cpa.hidden && cpa.offsetHeight) ? (cpa.offsetTop + cpa.offsetHeight + 8) + 'px' : '60px';
      el.className = 'guard-alarm glass';
      el.innerHTML =
        '<div class="guard-ic">◎</div>' +
        '<div class="guard-body">' +
          '<div class="guard-ttl">Guard zone breach · ' + fmtNM(+PREF.radius) + ' ring</div>' +
          '<div class="guard-tgt">' + esc(worst.data.name) + ' · ' + fmtNM(worst.data.rangeM / M_PER_NM) + ' · brg ' + worst.data.bearingDeg + '°' +
            (worst.data.sog != null ? ' · ' + worst.data.sog.toFixed(1) + ' kn' : '') + '</div>' +
          (active.length > 1 ? '<div class="guard-more">+' + (active.length - 1) + ' more target' + (active.length > 2 ? 's' : '') + ' in the zone</div>' : '') +
          '<div class="guard-disc">Proximity alert — verify visually; keep a lookout.</div>' +
        '</div>' +
        '<div class="guard-btns"><div class="guard-btn" data-act="ack" title="Silence">✕</div></div>';
      el.querySelector('[data-act="ack"]').onclick = function () { active.forEach(function (a) { ackedMmsi[a.data.mmsi] = 1; }); el.hidden = true; };
    }

    // ---- watchdog: armed + no nav frame for WATCHDOG_MS (even if never fed since arming) → surface ----
    setInterval(function () {
      if (PREF.on && !watchWarned && Date.now() - lastUpdateAt > WATCHDOG_MS) {
        watchWarned = true; breaching = {}; lastSig = {}; ackedMmsi = {};   // stalled: can't assert any breach
        notice('Guard zone — no data', 'No nav frames; proximity monitoring is stalled. Check the engine/AIS link.');
      }
    }, 5000);

    function syncPanel() { try { var h = window.HelmShell && HelmShell.panel('helm-ais-guard'); if (h && h.isOpen && h.isOpen() && h.el()._grdSync) h.el()._grdSync(); } catch (e) { console.warn('HelmAisGuard: panel re-sync failed:', e && e.message); } }

    return {
      // public per-frame entry (also called directly by tests). The live wiring is HelmShell.onNav below.
      update: update,
      onFrame: function (s) {
        if (!s) return;
        var own = (s.pos && isFinite(+s.pos.lon) && isFinite(+s.pos.lat)) ? { cog: +s.cog, sog: +s.sog, lon: +s.pos.lon, lat: +s.pos.lat } : null;
        var aisAlive = Array.isArray(s.conns) ? s.conns.some(function (c) { return c && c.status === 'connected'; }) : undefined;
        update(own, Array.isArray(s.ais) ? s.ais : [], aisAlive);
      },
      setOn: function (v) { PREF.on = !!v; persist(); if (!PREF.on) { hideAll(); breaching = {}; lastSig = {}; ackedMmsi = {}; } else { lastFeedOkAt = lastUpdateAt = Date.now(); watchWarned = false; if (lastOwn) update(lastOwn, []); } syncPanel(); },
      setRadius: function (v) { PREF.radius = Math.max(0.1, +v); persist(); if (PREF.on && lastOwn) drawRing(lastOwn); syncPanel(); },
      setMoving: function (v) { PREF.moving = !!v; persist(); syncPanel(); },
      prefs: function () { return { on: PREF.on, radius: PREF.radius, moving: PREF.moving }; },
      activeAlarms: function () { return Object.keys(breaching).map(function (m) { var a = breaching[m]; return { t: a.t, op: a.op, id: a.id, rev: a.rev, kind: a.kind, sev: a.sev, msg: a.msg, lat: a.lat, lon: a.lon, data: a.data }; }); },
      toggle: function () { this.setOn(!PREF.on); return PREF.on; }
    };
  }

  // ---- bootstrap + live nav wiring ----
  (function boot() {
    if (window.HelmShell && HelmShell.onNav) {
      window.HelmAisGuard = window.__aisGuard = build();
      HelmShell.onNav(function (s) { window.HelmAisGuard.onFrame(s); });   // every frame, ungated on position
    } else { setTimeout(boot, 60); }
  })();

  // ---- SHELL controls (panel + ⌘K) ----
  function inst() { return window.HelmAisGuard; }
  if (window.HelmShell && HelmShell.registerPanel) {
    // AIS-10: a tab in the consolidated AIS hub when present; else a standalone rail panel.
    (window.HelmAisHub && HelmAisHub.registerTab ? HelmAisHub.registerTab : HelmShell.registerPanel)({
      id: 'helm-ais-guard', epic: 'AIS', title: 'Guard zone', icon: '◎',
      render: function (body) {
        body.innerHTML =
          '<div class="sub" style="margin-bottom:10px;color:var(--cdim,#8aa)">Proximity alarm: a ring around your boat that alerts when any AIS target comes inside it. Distinct from the CPA alarm — this is about a target being physically near you now. Watches the full target list, not just what is on screen.</div>' +
          '<label class="row" style="display:flex;align-items:center;gap:8px;margin:8px 0"><input type="checkbox" id="grd-on"> <b>Arm guard zone</b></label>' +
          '<div class="lbl" style="margin:10px 0 4px;font-size:11px;letter-spacing:.04em;color:var(--cdim,#8aa)">RADIUS</div>' +
          '<div id="grd-radius" class="seg" style="display:flex;gap:4px"></div>' +
          '<label class="row" style="display:flex;align-items:center;gap:8px;margin:12px 0 2px"><input type="checkbox" id="grd-moving"> Moving targets only (ignore anchored)</label>' +
          '<div class="sub" style="margin-top:10px;font-size:10.5px;color:var(--cdim2,#678)">An armed zone with a dead feed or no fix shows an explicit notice — it never reads as &ldquo;all clear&rdquo;.</div>';
        var mkSeg = function (host, opts, get, pick) {
          host.innerHTML = '';
          opts.forEach(function (o) {
            var b = document.createElement('button'); b.textContent = o.label; b.dataset.val = o.val;
            b.style.cssText = 'flex:1;padding:5px 0;border:.5px solid var(--line,#2a3742);border-radius:7px;background:transparent;color:var(--ctext,#cdd9e3);cursor:pointer;font-size:12px';
            b.onclick = function () { pick(o.val); paint(); }; host.appendChild(b);
          });
          function paint() { var cur = String(get()); Array.prototype.forEach.call(host.children, function (b) { var on = b.dataset.val === cur; b.style.background = on ? 'var(--accent,#5bc0ff)' : 'transparent'; b.style.color = on ? '#0b1118' : 'var(--ctext,#cdd9e3)'; b.style.fontWeight = on ? '700' : '400'; }); }
          paint(); return paint;
        };
        var on = body.querySelector('#grd-on'), mv = body.querySelector('#grd-moving');
        on.onchange = function () { if (inst()) inst().setOn(on.checked); };
        mv.onchange = function () { if (inst()) inst().setMoving(mv.checked); };
        var paintR = mkSeg(body.querySelector('#grd-radius'),
          [{ label: '0.25', val: 0.25 }, { label: '0.5', val: 0.5 }, { label: '1', val: 1 }, { label: '2 NM', val: 2 }],
          function () { return inst() ? inst().prefs().radius : PREF.radius; },
          function (v) { if (inst()) inst().setRadius(v); });
        body._grdSync = function () { var p = inst() ? inst().prefs() : PREF; on.checked = !!p.on; mv.checked = !!p.moving; paintR(); };
        body._grdSync();
      },
      onOpen: function (body) { if (body._grdSync) body._grdSync(); }
    });
    HelmShell.registerCommand({
      id: 'helm-ais-guard-toggle', epic: 'AIS', title: 'Toggle AIS guard zone',
      subtitle: 'Proximity alarm ring around ownship', keywords: ['ais', 'guard', 'zone', 'proximity', 'alarm', 'ring'],
      group: 'AIS', run: function () { if (inst()) inst().toggle(); }
    });
  }
})();
