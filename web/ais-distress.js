// HelmAisDistress — AIS-7: SART / DSC distress reception surfacing.
//
// Surfaces the most safety-critical AIS event there is: an AIS-SART / MOB / EPIRB (or, when the
// engine ever provides it, a DSC distress) as a CRITICAL, persistent, non-silenceable alarm — banner
// + distinct audible + chart highlight + "centre on it". Distress is the top of the alarm stack.
//
// Mirrors the AIS-5 guard module (web/ais-guard.js): HelmShell.onNav-fed, the FULL engine target list
// (never a viewport query), fail-loud, and modelled in the FROZEN CONTRACT-10 schema (docs/
// CONTRACT-ALARM-SCHEMA.md §8: id "sart:<mmsi>"/"dsc:<mmsi>", kind "sart"/"dsc", sev "critical",
// silenceable:false, apns:"critical", data{mmsi,distressType,nature,receivedTs,...}). Computed
// client-side today (the engine emits no alarm frames yet); activeAlarms() returns the set in schema
// shape so the future engine-pushed / alarms.js id-keyed path is a drop-in.
//
// SAFETY / FAIL-LOUD (fail-and-fix-early policy):
//   • A detected distress is NEVER silently removed. When its target stops arriving (or ages out past
//     LOST_AGE_S) it transitions to LOST with last-known position/time and STAYS on screen — a SART
//     going dark is itself SAR-significant. Only an explicit operator Dismiss (LOST only) clears it.
//   • silenceable:false — ACK quiets the audio but the banner + chart flag persist.
//   • No ownship fix → the distress banner STILL shows ("range unknown"), never suppressed.
//   • A confirmed-offline AIS feed FREEZES the distress set (an offline link is "no data", NOT
//     "distress ended") and says monitoring is stalled — it never wipes a live distress.
//   • DSC is read forward-compatibly but NEVER faked: with no engine DSC field, no DSC is emitted.
//   • SART test vs live can't be told from this feed → always surfaced, labelled honestly, never
//     downgraded in severity.
(function () {
  'use strict';

  var DEG = Math.PI / 180, M_PER_NM = 1852;
  var LOST_AGE_S = 360;       // unheard 6 min → LOST (AIS-SART bursts ~1/min; tolerate several misses)
  var NODATA_GRACE_MS = 8000; // armed-equivalent: feed unconfirmed this long → "monitoring stalled"
  var TRIAD_MS = 2500;        // distress audible repeats every 2.5 s while an unacked ACTIVE exists
  var PINK = '#ff3b8b';

  function num(v) { return (v == null || v === '') ? null : (isFinite(+v) ? +v : null); }
  function haversineNM(a, b) {
    var dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG, la1 = a.lat * DEG, la2 = b.lat * DEG;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingDeg(a, b) {
    var la1 = a.lat * DEG, la2 = b.lat * DEG, dLon = (b.lon - a.lon) * DEG;
    var y = Math.sin(dLon) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }
  var fmtNM = function (nm) { return (nm < 1 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM'; };
  function fmtDM(v, neg, pos) { var h = v < 0 ? neg : pos; v = Math.abs(v); var d = Math.floor(v); return d + '°' + ((v - d) * 60).toFixed(2) + '′' + h; }
  var nameOf = function (t) { var n = String(t.name == null ? '' : t.name).replace(/@+/g, '').trim(); return (n && !/^unknown$/i.test(n)) ? n : ('MMSI ' + (t.mmsi != null ? t.mmsi : '?')); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ---- distress classification from the raw AIS fields (same triggers as HelmAisMeta.symbolKind,
  //      so chart symbol + alarm never disagree). 97x MMSI prefix is the most specific → wins. ----
  function distressOf(t) {
    var m = String(t.mmsi == null ? '' : t.mmsi);
    if (/^970/.test(m)) return { type: 'sart', label: 'AIS-SART', full: 'Search & Rescue Transponder' };
    if (/^972/.test(m)) return { type: 'mob', label: 'AIS-MOB', full: 'Man-Overboard beacon' };
    if (/^974/.test(m)) return { type: 'epirb', label: 'AIS-EPIRB', full: 'Emergency beacon (EPIRB)' };
    if (+t.class === 6 || +t.navStatus === 14) return { type: 'sart', label: 'Distress (AIS)', full: 'Distress transmission' };
    return null;
  }
  // DSC: ONLY if the engine actually populates a field — never synthesised. Absent on every frame today.
  function dscOf(t) {
    var d = t.dsc || t.distress;
    if (!d || typeof d !== 'object') return null;
    return { type: 'dsc', label: 'DSC distress', nature: (typeof d.nature === 'string' && d.nature) || 'undesignated' };
  }
  // SART self-test is indistinguishable on this feed → default to real; label honestly if the engine
  // ever says so. Test NEVER downgrades severity / hides the banner / auto-clears (§4).
  function isTest(t) { return t.sartTest === true || (typeof t.statusText === 'string' && /test/i.test(t.statusText)); }

  // ============================================================================================
  function build() {
    var tracked = {};            // id -> CONTRACT-10 alarm object (carries data.lost / lastSeenTs / test)
    var sigOf = {};              // id -> material signature (rev bumps only on real change)
    var ackedId = {};            // id -> 1 once the user silenced audio (banner/chart stay; cleared on Dismiss)
    var lastUpdateAt = Date.now(), lastFeedOkAt = Date.now(), watchWarned = false, lastOwn = null;
    var pulse = null, actx = null, triadTimer = null;

    // ---- banner (CRITICAL pink glass, top of the alarm stack) ----
    var css = document.createElement('style');
    css.textContent =
      '.distress-alarm{position:absolute;top:60px;left:50%;transform:translateX(-50%);z-index:11;max-width:440px;' +
        'border-radius:13px;padding:11px 13px;display:flex;gap:11px;align-items:flex-start;' +
        'background:var(--glass,rgba(22,12,20,.9));backdrop-filter:blur(12px);' +
        'border:.5px solid rgba(255,59,139,.7);box-shadow:0 18px 60px -20px rgba(0,0,0,.9),0 0 0 1px rgba(255,59,139,.4);' +
        'animation:distresspulse 1.1s infinite}' +
      '@keyframes distresspulse{0%,100%{box-shadow:0 18px 60px -20px rgba(0,0,0,.9),0 0 0 1px rgba(255,59,139,.4)}50%{box-shadow:0 18px 60px -20px rgba(0,0,0,.9),0 0 0 2.5px rgba(255,59,139,.75)}}' +
      '.distress-alarm.lost{animation:none;border-color:rgba(255,59,139,.4)}' +
      '.distress-alarm[hidden]{display:none}' +
      '.distress-ic{font-size:21px;line-height:1.05;flex:none;color:' + PINK + '}' +
      '.distress-body{flex:1;min-width:0}' +
      '.distress-ttl{font-size:13px;font-weight:700;color:#fff;letter-spacing:.02em;margin-bottom:2px}' +
      '.distress-sub{font-size:11px;color:#ffd9ec;font-variant-numeric:tabular-nums;line-height:1.45}' +
      '.distress-badge{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.05em;padding:1px 6px;border-radius:5px;margin-left:6px;background:rgba(255,59,139,.22);color:' + PINK + '}' +
      '.distress-more{font-size:10.5px;color:' + PINK + ';margin-top:3px}' +
      '.distress-disc{font-size:9.5px;color:var(--cdim2,#a98);margin-top:6px;line-height:1.3;border-top:.5px solid rgba(255,59,139,.2);padding-top:5px}' +
      '.distress-btns{display:flex;flex-direction:column;gap:5px;flex:none}' +
      '.distress-btn{cursor:pointer;min-width:26px;height:24px;padding:0 7px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:rgba(255,59,139,.16);font-size:11px;font-weight:600;color:#ffd9ec;white-space:nowrap}' +
      '.distress-btn:hover{background:rgba(255,59,139,.3)}' +
      '.distress-btn.off{opacity:.4;pointer-events:none}';
    document.head.appendChild(css);
    var el = document.createElement('div');
    el.className = 'distress-alarm glass'; el.hidden = true;
    document.body.appendChild(el);

    function tone(freq, t0, dur, peak) {
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.start(t0); o.stop(t0 + dur + 0.02);
    }
    function triad() {   // rising three-note — reserved for distress, distinct from guard/CPA single tone
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        var t0 = actx.currentTime;
        tone(988, t0, 0.18, 0.18); tone(1245, t0 + 0.25, 0.18, 0.18); tone(1480, t0 + 0.5, 0.2, 0.2);
      } catch (e) { /* audio needs a user gesture; banner still shows */ }
    }
    function realert() {   // single re-alert tone on a state transition (ACTIVE→LOST), guards actx like triad()
      try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); tone(740, actx.currentTime, 0.5, 0.16); } catch (e) { /* gesture-gated */ }
    }

    // ---- chart (SECONDARY): resolve the LIVE map each op, never block the alarm on the chart ----
    // No `built` latch: ensureLayers() is fully idempotent (inner getSource/getLayer guards) and runs
    // every frame, so after a basemap/style switch — which drops all custom sources+layers — the
    // distress ring + label SELF-HEAL on the next frame instead of silently vanishing forever.
    function liveMap() { var m = window.map; return (m && typeof m.getSource === 'function' && m.getStyle && m.getStyle()) ? m : null; }
    function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
    function setData(id, fc) { var m = liveMap(); if (!m) return; var s = m.getSource(id); if (s) s.setData(fc); }
    function ensureLayers() {
      var map = liveMap(); if (!map) return;
      try {
        if (!map.getSource('helm-ais-distress')) map.addSource('helm-ais-distress', { type: 'geojson', data: emptyFC() });
        // draw ABOVE the AIS symbols so the distress ring/label sit on top of everything
        function addL(spec) { if (!map.getLayer(spec.id)) map.addLayer(spec); }
        addL({ id: 'helm-ais-distress-ring', type: 'circle', source: 'helm-ais-distress',
          paint: { 'circle-radius': 18, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': PINK, 'circle-stroke-width': 3,
            'circle-stroke-opacity': ['case', ['get', 'lost'], 0.5, 0.95] } });
        addL({ id: 'helm-ais-distress-label', type: 'symbol', source: 'helm-ais-distress',
          layout: { 'text-field': ['get', 'tag'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -2.0], 'text-allow-overlap': true, 'text-ignore-placement': true },
          paint: { 'text-color': PINK, 'text-opacity': ['case', ['get', 'lost'], 0.6, 1], 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.4 } });
      } catch (e) { console.error('[AIS] distress layer build failed:', e && e.message); }   // surface, don't swallow
    }
    function startPulse() { if (pulse) return; var r = 16, up = true; pulse = setInterval(function () { var m = liveMap(); r += up ? 2 : -2; if (r >= 26) up = false; if (r <= 16) up = true; if (m && m.getLayer('helm-ais-distress-ring')) m.setPaintProperty('helm-ais-distress-ring', 'circle-radius', r); }, 110); }
    function stopPulse() { if (pulse) { clearInterval(pulse); pulse = null; } }

    function drawChart() {
      var feats = [];
      for (var id in tracked) {
        var a = tracked[id];
        if (a.lat == null || a.lon == null) continue;   // CONTRACT-10 §2: never a marker at 0,0
        feats.push({ type: 'Feature', properties: { id: id, lost: !!a.data.lost, tag: a.data.lost ? 'DISTRESS · LOST' : 'DISTRESS' }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } });
      }
      setData('helm-ais-distress', { type: 'FeatureCollection', features: feats });
      var anyActivePos = feats.some(function (f) { return !f.properties.lost; });
      if (anyActivePos) startPulse(); else stopPulse();
    }

    // ---- build a CONTRACT-10 §8 alarm object for one distress, bumping rev only on material change ----
    function makeAlarm(id, kind, dt, label, nature, test, t, own, prev, lost) {
      var mmsi = t.mmsi;
      var lat = num(t.lat), lon = num(t.lon);
      var hasPos = lat != null && lon != null && (lat !== 0 || lon !== 0);
      var range = num(t.range), brg = num(t.brg);
      if ((range == null || brg == null) && hasPos && own && own.lat != null) {
        range = haversineNM(own, { lat: lat, lon: lon }); brg = Math.round(bearingDeg(own, { lat: lat, lon: lon }));
      }
      var nowS = Math.floor(Date.now() / 1000);
      var receivedTs = prev ? prev.data.receivedTs : nowS;
      var lastSeenTs = lost ? (prev ? prev.data.lastSeenTs : nowS) : nowS;   // freeze on LOST
      var name = nameOf(t);
      // Material signature for rev: fold in EVERY field that changes msg/data/position (state, range,
      // bearing, test flag, DSC nature, and the raw position — which moves even when range/brg are null
      // for lack of an ownship fix). Otherwise a real change (e.g. SART→TEST, nature undesignated→sinking,
      // position drift with no fix) would not bump rev and the future engine/alarms.js path would dedup it.
      var sig = (lost ? 'lost' : 'active') + '|' + (range == null ? '' : Math.round(range * 10)) + '|' + (brg == null ? '' : brg) +
        '|' + (test ? 'T' : '') + '|' + (nature || '') + '|' + (hasPos ? lat.toFixed(4) + ',' + lon.toFixed(4) : '');
      var changed = !prev || sigOf[id] !== sig; sigOf[id] = sig;
      var posTxt = hasPos ? (fmtDM(lat, 'S', 'N') + ' ' + fmtDM(lon, 'W', 'E')) : 'position unknown';
      var rbTxt = (range != null && brg != null) ? (fmtNM(range) + ' brg ' + brg + '°') : (own && own.lat != null ? 'range unknown' : 'range unknown (no ownship fix)');
      var msg = 'DISTRESS — ' + label + (test ? ' (TEST)' : '') + (nature ? ' (' + nature + ')' : '') + ' · ' + name + ' · ' + (lost ? 'LOST · ' : '') + rbTxt;
      var a = {
        t: 'alarm', op: prev ? 'update' : 'raise',
        id: id, rev: prev ? (changed ? prev.rev + 1 : prev.rev) : 1,
        kind: kind, sev: 'critical', prio: 5, silenceable: false, apns: 'critical',
        msg: msg, raisedTs: receivedTs,
        data: { mmsi: mmsi, distressType: dt, nature: nature || null, receivedTs: receivedTs, lastSeenTs: lastSeenTs,
          lost: !!lost, test: !!test, rangeM: range == null ? null : Math.round(range * M_PER_NM), bearingDeg: brg == null ? null : brg,
          label: label, name: name, posTxt: posTxt, rbTxt: rbTxt }
      };
      if (hasPos) { a.lat = lat; a.lon = lon; }   // ABSENT ⇒ no chart mark
      return a;
    }

    // ---- main: one nav frame ----
    function update(own, list, feedAlive) {
      lastUpdateAt = Date.now(); watchWarned = false; lastOwn = own;
      ensureLayers();
      var arr = Array.isArray(list) ? list : [];
      var feedOk = (feedAlive === true) || (arr.length > 0);
      if (feedOk) { lastFeedOkAt = Date.now(); }

      if (feedOk) {
        // Detect every distress in the trustworthy list. One target may yield BOTH a sart:* and a dsc:*.
        var seen = {};
        for (var i = 0; i < arr.length; i++) {
          var t = arr[i]; if (!t) continue;
          var d = distressOf(t), dsc = dscOf(t);
          if (!d && !dsc) continue;
          // Never drop a real distress purely for a missing MMSI: fall back to a position-derived
          // (else index) key so it still surfaces (labelled "MMSI ?" via nameOf). Engine always emits
          // a numeric mmsi today, so this is a fail-loud backstop for a future beacon/DSC-only source.
          var key = t.mmsi != null ? t.mmsi
            : ('nomid-' + (num(t.lat) != null && num(t.lon) != null ? num(t.lat).toFixed(3) + '_' + num(t.lon).toFixed(3) : i));
          var hits = [];
          if (d) hits.push({ id: 'sart:' + key, kind: 'sart', dt: d.type, label: d.label, nature: null });
          if (dsc) hits.push({ id: 'dsc:' + key, kind: 'dsc', dt: 'dsc', label: dsc.label, nature: dsc.nature });
          for (var h = 0; h < hits.length; h++) {
            var hit = hits[h], prev = tracked[hit.id];
            var aged = num(t.ageSec) != null && +t.ageSec > LOST_AGE_S;   // still listed but gone dark → LOST
            seen[hit.id] = 1;
            var wasLost = prev && prev.data.lost;
            if (!prev || wasLost) { triad(); if (wasLost) delete ackedId[hit.id]; }   // new, or LOST→ACTIVE re-acquire → re-alert
            else if (aged && !prev.data.lost) realert();                              // ACTIVE→LOST in place (aged out) → audible, not silent
            tracked[hit.id] = makeAlarm(hit.id, hit.kind, hit.dt, hit.label, hit.nature, isTest(t), t, own, prev, aged);
          }
        }
        // a tracked distress NOT seen this frame → LOST (NEVER deleted). Freeze last-known.
        for (var id in tracked) {
          if (!seen[id] && !tracked[id].data.lost) {
            var p = tracked[id];
            tracked[id] = makeAlarm(id, p.kind, p.data.distressType, p.data.label, p.data.nature, p.data.test,
              { mmsi: p.data.mmsi, name: p.data.name, lat: p.lat, lon: p.lon, range: p.data.rangeM == null ? null : p.data.rangeM / M_PER_NM, brg: p.data.bearingDeg }, own, p, true);
            realert();   // single re-alert on ACTIVE→LOST (target dropped off the feed)
          }
        }
      }
      // !feedOk → FREEZE (offline link is "no data", not "distress ended"): keep tracked untouched.

      // fail-loud feed-health notice (does NOT clear distress — a stalled feed must not erase a SART)
      var stalled = !feedOk && Date.now() - lastFeedOkAt > NODATA_GRACE_MS;
      render(own, stalled);
    }

    function ackAll() { for (var id in tracked) if (!tracked[id].data.lost) ackedId[id] = 1; render(lastOwn, false); }
    function dismiss(id) { if (tracked[id] && tracked[id].data.lost) { delete tracked[id]; delete sigOf[id]; delete ackedId[id]; render(lastOwn, false); } }
    function center(id) { var a = tracked[id], m = liveMap(); if (a && a.lat != null && m) m.flyTo({ center: [a.lon, a.lat], zoom: Math.max(m.getZoom(), 13), duration: 700 }); }

    function render(own, stalled) {
      drawChart();
      var all = Object.keys(tracked).map(function (id) { return tracked[id]; });
      if (!all.length) { el.hidden = true; restackOthers(false); stopTriad(); return; }
      var active = all.filter(function (a) { return !a.data.lost; });
      var anyUnacked = active.some(function (a) { return !ackedId[a.id]; });
      if (anyUnacked) startTriad(); else stopTriad();

      // primary = nearest ACTIVE, else first LOST. Distress sorts above everything.
      active.sort(function (a, b) { return (a.data.rangeM == null ? 1e9 : a.data.rangeM) - (b.data.rangeM == null ? 1e9 : b.data.rangeM); });
      var primary = active[0] || all[0];
      var lost = !!primary.data.lost, d = primary.data;
      var more = all.length - 1;
      var ls = +d.lastSeenTs, zt = isFinite(ls) ? new Date(ls * 1000).toISOString().substr(11, 8) + 'Z' : '—';   // total render path even if ts ever missing
      el.className = 'distress-alarm glass' + (lost ? ' lost' : '');
      el.innerHTML =
        '<div class="distress-ic">✚</div>' +
        '<div class="distress-body">' +
          '<div class="distress-ttl">' + (lost ? 'DISTRESS SIGNAL LOST' : 'DISTRESS') + ' — ' + esc(d.label) + (d.test ? ' (TEST)' : '') + (d.nature ? ' (' + esc(d.nature) + ')' : '') +
            (!lost && ackedId[primary.id] ? '<span class="distress-badge">ACK’d · still active</span>' : '') + '</div>' +
          '<div class="distress-sub">' + esc(d.name) + '</div>' +
          '<div class="distress-sub">' + esc(d.posTxt) + ' · ' + esc(d.rbTxt) + '</div>' +
          '<div class="distress-sub">' + (lost ? 'Last heard ' : 'Received ') + zt + ' · ' + agoTxt(d.lastSeenTs) + '</div>' +
          (more > 0 ? '<div class="distress-more">+' + more + ' more distress signal' + (more > 1 ? 's' : '') + '</div>' : '') +
          (stalled ? '<div class="distress-more">⚠ AIS feed stalled — distress frozen at last-known; monitoring is NOT confirmed.</div>' : '') +
          '<div class="distress-disc">' + (d.test ? 'Reported as a self-TEST — verify before standing down. ' : 'Cannot confirm test vs live from this feed — treat as real until verified. ') +
            'Alert authorities / DSC / Ch 16 as appropriate.</div>' +
        '</div>' +
        '<div class="distress-btns">' +
          '<div class="distress-btn' + (primary.lat == null ? ' off' : '') + '" data-act="center" title="Centre the chart on the distress position">◎</div>' +
          (lost ? '<div class="distress-btn" data-act="dismiss" data-id="' + esc(primary.id) + '" title="Dismiss this lost signal">Dismiss</div>'
                : '<div class="distress-btn" data-act="ack" title="Silence audio (the alert stays — it is not silenceable)">✕</div>') +
        '</div>';
      var cb = el.querySelector('[data-act="center"]'); if (cb) cb.onclick = function () { center(primary.id); };
      var ab = el.querySelector('[data-act="ack"]'); if (ab) ab.onclick = ackAll;
      var db = el.querySelector('[data-act="dismiss"]'); if (db) db.onclick = function () { dismiss(primary.id); };
      el.hidden = false;
      restackOthers(true);
    }

    // distress is the top anchor; push the CPA + guard banners below it (best-effort; z-index keeps
    // distress readable regardless). Reset their top when distress clears.
    function restackOthers(on) {
      var below = on ? (el.offsetTop + el.offsetHeight + 8) + 'px' : '';
      var cpa = document.querySelector('.cpa-alarm'); if (cpa) cpa.style.top = below;   // reset to '' (CSS 60px) when off
      var g = document.querySelector('.guard-alarm'); if (g) g.style.top = below;       // symmetric reset (was asymmetric)
    }
    function agoTxt(ts) { var s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); return s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; }
    function startTriad() { if (triadTimer) return; triad(); triadTimer = setInterval(function () { var anyUnacked = Object.keys(tracked).some(function (id) { return !tracked[id].data.lost && !ackedId[id]; }); if (anyUnacked) triad(); else stopTriad(); }, TRIAD_MS); }
    function stopTriad() { if (triadTimer) { clearInterval(triadTimer); triadTimer = null; } }

    // watchdog: no nav frames at all for the grace while a distress is tracked → say monitoring stalled
    setInterval(function () {
      if (!watchWarned && Object.keys(tracked).length && Date.now() - lastUpdateAt > NODATA_GRACE_MS) { watchWarned = true; render(lastOwn, true); }
    }, 4000);

    return {
      update: update,
      onFrame: function (s) {
        if (!s) return;
        var own = (s.pos && isFinite(+s.pos.lon) && isFinite(+s.pos.lat)) ? { cog: +s.cog, sog: +s.sog, lon: +s.pos.lon, lat: +s.pos.lat } : null;
        var aisAlive = Array.isArray(s.conns) ? s.conns.some(function (c) { return c && c.status === 'connected'; }) : undefined;
        update(own, Array.isArray(s.ais) ? s.ais : [], aisAlive);
      },
      ackAll: ackAll, dismiss: dismiss, center: center,
      activeAlarms: function () { return Object.keys(tracked).map(function (id) { var a = tracked[id]; var o = { t: a.t, op: a.op, id: a.id, rev: a.rev, kind: a.kind, sev: a.sev, prio: a.prio, silenceable: a.silenceable, apns: a.apns, msg: a.msg, raisedTs: a.raisedTs, data: a.data }; if (a.lat != null) { o.lat = a.lat; o.lon = a.lon; } return o; }); }
    };
  }

  // ---- bootstrap + live nav wiring ----
  (function boot() {
    if (window.HelmShell && HelmShell.onNav) {
      window.HelmAisDistress = window.__aisDistress = build();
      HelmShell.onNav(function (s) { window.HelmAisDistress.onFrame(s); });   // every frame, ungated on position
    } else { setTimeout(boot, 60); }
  })();

  // ---- ⌘K: centre the chart on the nearest active distress ----
  if (window.HelmShell && HelmShell.registerCommand) {
    HelmShell.registerCommand({
      id: 'helm-ais-distress-center', epic: 'AIS', title: 'Centre on AIS distress signal',
      subtitle: 'SART / MOB / EPIRB / DSC', keywords: ['distress', 'sart', 'mob', 'epirb', 'dsc', 'emergency', 'mayday'],
      group: 'AIS', run: function () { var d = window.HelmAisDistress; if (!d) return; var a = d.activeAlarms().filter(function (x) { return !x.data.lost && x.lat != null; }); if (a.length) d.center(a[0].id); }
    });
  }
})();
