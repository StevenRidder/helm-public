// HelmAisVectors — AIS-4: CPA vector cone / tactical overlay + speed-scaled predictor on targets.
//
// OpenCPN draws a COG/SOG "predictor" off every moving AIS target at the SAME weight — which becomes
// an unreadable hairball in a crowded anchorage. We draw the same speed-scaled predictor (LENGTH =
// distance run in N minutes), but TIER IT BY RISK (AIS-16): danger is bold + carries a CPA cone,
// caution is a lighter early-warning line, ambient fast traffic is a faint hairline, and moored/slow
// boats draw nothing — with a density dial (Threats · +Caution · +Traffic) to set how far down we go.
// The eye sorts urgent/developing/ambient at a glance instead of hunting two threats among ninety lines.
//
// IN-LANE / DECOUPLED BY DESIGN: this is a standalone module. It reads the SAME live `ais` map
// source that index.html drives from the engine (querySourceFeatures — no edits to index.html's
// nav loop, no touching collision.js/ais-meta.js), draws into its OWN namespaced `helm-ais-*`
// layers, and registers its controls through HelmShell. So it composes with the AIS symbology
// (AIS-2) and target-list (AIS-3) work without fighting over a file.
//
// HONESTY: the engine's cpa/tcpa/cpaValid are AUTHORITATIVE and never recomputed here — we only
// PROJECT geometry from each target's own lon/lat/cog/sog. A stationary boat (sog < 0.5 kn) gets
// no velocity vector (we don't invent motion). Without a valid future tcpa there is no cone (the
// closest-approach position is uncomputable), and risk colour can never reach "danger" on cpa
// alone. Stale targets (unheard > 120 s) dim and lose their cone — old data isn't a live track.
(function () {
  'use strict';

  // HARD dependency: HelmAisRisk (ais-risk.js) is the single source of truth for risk tier + palette
  // (the SAME bands the alarm, chart symbol, tap card and list use). No silent fallback to a duplicate
  // palette or a "normal" default — a missing dependency is surfaced loudly and the direct calls below
  // throw, so we never quietly mis-classify a target as safe.
  if (!window.HelmAisRisk) console.error('[AIS] ais-vectors.js requires ais-risk.js (HelmAisRisk) — it must load FIRST. Risk colours are unavailable; this is a real failure, not a soft default.');

  // ---- geometry constants ----
  var M_PER_NM = 1852, M_PER_DEG_LAT = 111320, DEG = Math.PI / 180;
  var MIN_COS_LAT = 0.01;        // clamp |cos(lat)| (~89.4°) so dLon can't blow up near the poles
  var MIN_SOG_KN = 0.5;          // below this a target is "moored" — no predictor, no cone
  var STALE_SEC = 120;           // unheard longer than this → grey + dim, drop cone

  // STALE neutralises to grey so a dimmed line can't be misread as a live red threat.
  function COL() { return HelmAisRisk.COL; }
  function tierOf(t) { return HelmAisRisk.tier(t); }
  var STALE_COL = '#7d8a98';

  // ---- persisted user prefs (module-level so the SHELL panel + the map instance share them) ----
  var PREF = {
    on:    load('helm.ais.vectors.on', true),
    min:   load('helm.ais.vectors.min', 6),               // predictor length, minutes (3/6/12/30)
    density: load('helm.ais.vectors.density', 'caution')  // 'threats' | 'caution' | 'all' (+ fast traffic)
  };
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function persist() {
    try {
      localStorage.setItem('helm.ais.vectors.on', JSON.stringify(PREF.on));
      localStorage.setItem('helm.ais.vectors.min', JSON.stringify(PREF.min));
      localStorage.setItem('helm.ais.vectors.density', JSON.stringify(PREF.density));
    } catch (e) { /* private mode — keep running with in-memory prefs */ }
  }

  // ---- AIS-16: tiered vector weighting — threats POP, developing shows lighter, ambient stays faint ----
  // OpenCPN draws every moving target's predictor at the SAME weight → a hairball you can't read in a
  // crowded anchorage. Instead we weight by risk so the eye sorts urgent/developing/ambient instantly,
  // and the density dial controls how far down the tiers we draw at all.
  var FAST_KN = 4;               // a "normal" (green) target needs at least this much way on to earn a faint line
  var TRAFFIC_COL = '#9bb0c0';   // ambient (non-threat) traffic — neutral, deliberately NOT a tier colour
  // Per-tier line weight, or null when the active density says "don't draw this one".
  //   density 'threats' → danger only · 'caution' → + caution · 'all' → + fast-moving normal traffic
  function vectorStyle(tier, sog) {
    if (tier === 'danger')  return { width: 2.6, opacity: 0.95, col: COL().danger };
    if (tier === 'caution' && PREF.density !== 'threats') return { width: 1.5, opacity: 0.8, col: COL().caution };
    if (tier === 'normal'  && PREF.density === 'all' && sog >= FAST_KN) return { width: 0.85, opacity: 0.42, col: TRAFFIC_COL };
    return null;
  }

  // ---- geometry: move a point distanceNM along a true bearing (local equirectangular) ----
  function project(lon, lat, brgDeg, distNM) {
    var d = distNM * M_PER_NM, b = brgDeg * DEG;
    var dN = d * Math.cos(b), dE = d * Math.sin(b);
    var cosLat = Math.max(Math.abs(Math.cos(lat * DEG)), MIN_COS_LAT);
    return [lon + dE / (M_PER_DEG_LAT * cosLat), lat + dN / M_PER_DEG_LAT];
  }
  function num(v) { return (v == null || v === '') ? null : (isFinite(+v) ? +v : null); }
  var fmtNM = function (nm) { return (nm < 1 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM'; };

  var feat = function (geom, props) { return { type: 'Feature', properties: props, geometry: geom }; };
  var ptG = function (c) { return { type: 'Point', coordinates: c }; };
  var lineG = function (cs) { return { type: 'LineString', coordinates: cs }; };
  var polyG = function (rings) { return { type: 'Polygon', coordinates: rings }; };

  var VEC_LAYERS = ['helm-ais-cone-fill', 'helm-ais-cone-outline', 'helm-ais-predictor',
    'helm-ais-cpa-marker', 'helm-ais-cpa-label'];

  // ============================================================================================
  //  Map-bound instance
  // ============================================================================================
  window.HelmAisVectors = function (map) {
    var SRC = 'helm-ais-vectors';
    var raf = 0, built = false;

    function add(spec, before) {
      if (map.getLayer(spec.id)) return;
      try { map.addLayer(spec, before); } catch (e) { try { map.addLayer(spec); } catch (e2) { console.warn('HelmAisVectors: addLayer ' + spec.id + ' failed', e2 && e2.message); } }
    }

    function ensureLayers() {
      if (built) return;
      // Wait until the base `ais` source is present — proves the merged style is loaded enough to
      // mutate. Adding a source/layer before that throws ("style is not done loading"); we retry
      // from the styledata/load driver below, so this just returns until it's safe.
      if (!map.getSource('ais')) return;
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      } catch (e) { return; }   // not ready yet — driver will retry
      // Draw BELOW the vessel triangle + label so glyphs stay on top (guard if the legacy id moves).
      var before = map.getLayer('ais-vessels') ? 'ais-vessels' : undefined;
      add({ id: 'helm-ais-cone-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'cone'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } }, before);
      add({ id: 'helm-ais-cone-outline', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'cone'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] } }, before);
      add({ id: 'helm-ais-predictor', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'predictor'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } }, before);
      add({ id: 'helm-ais-cpa-marker', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'cpa'],
        paint: { 'circle-radius': 5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2 } }, before);
      add({ id: 'helm-ais-cpa-label', type: 'symbol', source: SRC, filter: ['==', ['get', 'kind'], 'cpa'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 13,
          'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': 'rgba(7,12,18,0.95)', 'text-halo-width': 1.9 } }, before);
      built = true;
      applyVisibility();
    }

    // Read the live target list straight off the `ais` source. querySourceFeatures returns only
    // features in loaded/visible tiles (fine — we only draw vectors on visible targets) and can
    // duplicate a point across tile buffers, so we dedupe by mmsi.
    function targets() {
      if (!map.getSource('ais')) return [];
      // Respect the user's AIS layer toggle via its checkbox (the intent), NOT a specific render
      // layer's visibility: AIS-2 symbology hides the legacy ais-vessels and draws helm-ais-symbol
      // instead, so keying off ais-vessels visibility would suppress vectors whenever symbology is on.
      var box = document.querySelector('[data-layer="ais"]');
      if (box && !box.checked) return [];
      var feats;
      try { feats = map.querySourceFeatures('ais'); }
      catch (e) { console.warn('HelmAisVectors: querySourceFeatures("ais") failed — overlay drawing nothing this frame:', e && e.message); return []; }
      var seen = {}, out = [];
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i], p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
        if (!c) continue;
        var id = p.mmsi != null ? String(p.mmsi) : (c[0] + ',' + c[1]);
        if (seen[id]) continue; seen[id] = 1;
        // A geojson source preserves boolean props through querySourceFeatures, but coerce defensively
        // so a string-'false' (some serialization paths) can't promote an invalid CPA out of normal tier.
        var cpaValid = (p.cpaValid === false || p.cpaValid === 'false') ? false : (p.cpaValid == null ? null : true);
        out.push({ mmsi: p.mmsi, lon: +c[0], lat: +c[1], cog: num(p.cog), sog: num(p.sog),
          cpa: num(p.cpa), tcpa: num(p.tcpa), cpaValid: cpaValid, ageSec: num(p.ageSec) });
      }
      return out;
    }

    function build() {
      if (!built) return;
      var list = targets(), out = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.cog == null || t.sog == null || t.sog < MIN_SOG_KN) continue;   // moored / no course → no vector
        var tier = tierOf(t);
        var sty = vectorStyle(tier, t.sog);
        if (!sty) continue;                                              // density dial draws nothing for this tier → skip
        var stale = t.ageSec != null && t.ageSec > STALE_SEC;
        var color = stale ? STALE_COL : sty.col;                         // stale → grey, never a live tier colour
        var opacity = stale ? 0.3 : sty.opacity;
        var width = stale ? Math.min(sty.width, 1.2) : sty.width;        // a stale track never carries a bold live weight
        var apex = [t.lon, t.lat];

        // speed-scaled predictor (factual: solid line, length = distance run in PREF.min at this SOG).
        // Direction reads from the vessel triangle at the apex; weight reads from the risk tier (above).
        var tip = project(t.lon, t.lat, t.cog, t.sog * (PREF.min / 60));
        out.push(feat(lineG([apex, tip]), { kind: 'predictor', mmsi: t.mmsi, color: color, opacity: opacity, width: width }));

        // CPA cone (predicted: dashed) — the URGENT treatment, DANGER only (caution gets a lighter line but
        // no cone, by design). The ±8° half-angle is a FIXED COSMETIC sector for legibility — NOT a
        // positional-uncertainty estimate (the engine provides no error term). Apex at the target, fanning
        // to the predicted closest-approach position (target dead-reckoned along COG by sog·tcpa).
        if (tier === 'danger' && !stale && t.tcpa != null && t.tcpa > 0) {
          var cpaDist = t.sog * (t.tcpa / 60);
          var cpaPos = project(t.lon, t.lat, t.cog, cpaDist);
          var left = project(t.lon, t.lat, t.cog - 8, cpaDist);
          var right = project(t.lon, t.lat, t.cog + 8, cpaDist);
          out.push(feat(polyG([[apex, left, right, apex]]), { kind: 'cone', mmsi: t.mmsi, color: color }));
          out.push(feat(ptG(cpaPos), { kind: 'cpa', mmsi: t.mmsi, color: color,
            label: 'CPA ' + fmtNM(t.cpa) + ' · ' + Math.round(t.tcpa) + ' min' }));
        }
      }
      var src = map.getSource(SRC);
      if (src) src.setData({ type: 'FeatureCollection', features: out });
    }

    function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; build(); }); }

    function applyVisibility() {
      var vis = PREF.on ? 'visible' : 'none';
      for (var i = 0; i < VEC_LAYERS.length; i++) if (map.getLayer(VEC_LAYERS[i])) map.setLayoutProperty(VEC_LAYERS[i], 'visibility', vis);
    }

    var wired = false;
    function wire() {
      if (wired) return; wired = true;
      map.on('sourcedata', function (e) { if (e.sourceId === 'ais' && e.isSourceLoaded) { ensureLayers(); schedule(); } });
      map.on('moveend', schedule);
      map.on('zoomend', schedule);
      // The shell's "AIS" layer checkbox hides ais-vessels/ais-label but not our helm-ais-* layers;
      // targets() reads that visibility to gate the vectors, so rebuild the instant it's toggled
      // (otherwise, with a static/mock feed that emits no further sourcedata, the vectors would
      // linger until the next pan). Read-only attach to the shared control — no edit to the shell.
      var box = document.querySelector('[data-layer="ais"]');
      if (box) box.addEventListener('change', schedule);
    }
    // Robust init: try to add our layers now and on every style/load/source event until it sticks.
    // The map may be mid-load when this module boots; ensureLayers() no-ops until the style is ready.
    function init() { ensureLayers(); if (built) schedule(); }
    wire();
    map.on('styledata', init);
    map.on('load', init);
    init();

    return {
      setOn: function (v) { PREF.on = !!v; persist(); if (built) { applyVisibility(); schedule(); } },
      setMin: function (v) { PREF.min = +v; persist(); schedule(); },
      setDensity: function (v) { PREF.density = v; persist(); schedule(); },
      toggle: function () { this.setOn(!PREF.on); return PREF.on; },
      prefs: function () { return { on: PREF.on, min: PREF.min, density: PREF.density }; },
      refresh: schedule
    };
  };

  // ============================================================================================
  //  Bootstrap + SHELL controls (panel + ⌘K), registered from this file only.
  // ============================================================================================
  (function boot() {
    if (window.map && window.HelmAisVectors) {
      try { window.__aisVectors = window.HelmAisVectors(window.map); }
      catch (e) { console.warn('HelmAisVectors: init deferred —', e && e.message); window.__aisVectors = null; setTimeout(boot, 150); }
    } else { setTimeout(boot, 60); }
  })();

  function inst() { return window.__aisVectors; }

  if (window.HelmShell && HelmShell.registerPanel) {
    // AIS-10: a tab in the consolidated AIS hub when present; else a standalone rail panel.
    (window.HelmAisHub && HelmAisHub.registerTab ? HelmAisHub.registerTab : HelmShell.registerPanel)({
      id: 'helm-ais-vectors',
      epic: 'AIS',
      title: 'AIS vectors',
      icon: '➢',
      render: function (body) {
        body.innerHTML =
          '<div class="sub" style="margin-bottom:10px;color:var(--cdim,#8aa)">Tiered course predictors — threats bold (+ CPA cone), caution lighter, ambient traffic faint — so the dangerous targets pop instead of drowning in lines. Engine CPA/TCPA are authoritative; geometry only is drawn here.</div>' +
          '<label class="row" style="display:flex;align-items:center;gap:8px;margin:8px 0">' +
            '<input type="checkbox" id="aisv-on"> <b>Show vector overlay</b></label>' +
          '<div class="lbl" style="margin:10px 0 4px;font-size:11px;letter-spacing:.04em;color:var(--cdim,#8aa)">PREDICTOR LENGTH</div>' +
          '<div id="aisv-min" class="seg" style="display:flex;gap:4px"></div>' +
          '<div class="lbl" style="margin:12px 0 4px;font-size:11px;letter-spacing:.04em;color:var(--cdim,#8aa)">VECTOR DETAIL</div>' +
          '<div id="aisv-density" class="seg" style="display:flex;gap:4px"></div>' +
          '<div class="sub" style="margin-top:12px;font-size:10.5px;color:var(--cdim2,#678)">Red threats: bold line + CPA cone. Caution: thin amber early-warning line. Traffic: faint line for fast (&ge;4 kn) normal targets. Moored / &lt;0.5 kn never draw a line.</div>';

        var mkSeg = function (host, opts, getCur, onPick) {
          host.innerHTML = '';
          opts.forEach(function (o) {
            var b = document.createElement('button');
            b.textContent = o.label; b.dataset.val = o.val;
            b.style.cssText = 'flex:1;padding:5px 0;border:.5px solid var(--line,#2a3742);border-radius:7px;background:transparent;color:var(--ctext,#cdd9e3);cursor:pointer;font-size:12px';
            b.onclick = function () { onPick(o.val); paint(); };
            host.appendChild(b);
          });
          function paint() {
            var cur = String(getCur());
            Array.prototype.forEach.call(host.children, function (b) {
              var on = b.dataset.val === cur;
              b.style.background = on ? 'var(--accent,#5bc0ff)' : 'transparent';
              b.style.color = on ? '#0b1118' : 'var(--ctext,#cdd9e3)';
              b.style.fontWeight = on ? '700' : '400';
            });
          }
          paint(); return paint;
        };

        var on = body.querySelector('#aisv-on');
        on.onchange = function () { if (inst()) inst().setOn(on.checked); };
        var paintMin = mkSeg(body.querySelector('#aisv-min'),
          [{ label: '3', val: 3 }, { label: '6', val: 6 }, { label: '12', val: 12 }, { label: '30 min', val: 30 }],
          function () { return inst() ? inst().prefs().min : PREF.min; },
          function (v) { if (inst()) inst().setMin(v); });
        var paintDensity = mkSeg(body.querySelector('#aisv-density'),
          [{ label: 'Threats', val: 'threats' }, { label: '+ Caution', val: 'caution' }, { label: '+ Traffic', val: 'all' }],
          function () { return inst() ? inst().prefs().density : PREF.density; },
          function (v) { if (inst()) inst().setDensity(v); });
        // Re-sync controls to the live prefs on every open — they can change via ⌘K or another path
        // while the panel is closed (render() runs once; onOpen runs every open).
        body._aisvSync = function () { var pr = inst() ? inst().prefs() : PREF; on.checked = !!pr.on; paintMin(); paintDensity(); };
        body._aisvSync();
      },
      onOpen: function (body) { if (body._aisvSync) body._aisvSync(); }
    });
  }

  if (window.HelmShell && HelmShell.registerCommand) {
    HelmShell.registerCommand({
      id: 'helm-ais-vectors-toggle',
      epic: 'AIS',
      title: 'Toggle AIS vector overlay',
      subtitle: 'CPA cone + speed-scaled predictor on targets',
      keywords: ['ais', 'cpa', 'predictor', 'vector', 'cone', 'collision'],
      group: 'AIS',
      run: function () { if (inst()) inst().toggle(); }
    });
  }
})();
