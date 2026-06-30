// wx-controls.js — the unified Weather panel.  WX epic · weather-ux.
// ----------------------------------------------------------------------------------------------
// Folds the three former rail icons (value-encoded tiles / ensemble spread / PredictWind import)
// INTO the existing Weather drawer as inline controls, so weather lives in one place and the left
// rail stops overflowing. Injected into #drawer-weather at runtime from this WX-owned file — no edit
// to the shell body. Orchestrates four engines:
//   • legacy field overlay (Standard)        — index.html setWeather()
//   • fetch-on-pan live full-bleed (Live)     — web/wx-live.js
//   • GFS-vs-ECMWF spread (Ensemble)          — web/integrations/cog.js
//   • PredictWind GPX/GRIB import             — web/wx-import.js (window.HelmImport)
(function () {
  'use strict';
  var cogP = null;
  function cog() { return cogP || (cogP = import('./integrations/cog.js')); }
  var S = { map: null, resolution: 'live', model: 'single', els: {}, probeT: null };  // Live (fill-the-view) is the default — Windy-style
  // The helm-wx tile gateway (services/wx). Default: same host, port 8093. Override with window.HELM_WX_SERVICE.
  // NOTE: :8091 is the offline mbtiles BASEMAP server (pipeline/mbtiles_server.py — navionics/googlesat/…);
  // the weather gateway must NOT use it. Squatting :8091 made the navionics basemap 404, exposing the dark
  // depth-area fills as "black ovals". Weather lives on :8093.
  var WX_SERVICE = (typeof window !== 'undefined' && window.HELM_WX_SERVICE) ||
                   (location.protocol + '//' + location.hostname + ':8093');
  function wxOpacity() { var s = document.getElementById('wxopacity'); return s ? Math.max(0, Math.min(1, (100 - (+s.value)) / 100)) : 0.82; }
  function particlesOn() { var p = document.getElementById('particles'); return p ? !!p.checked : true; }

  // LIVE animated wind particles, fed by the helm-wx gateway's /velocity endpoint (keyed server-side,
  // cached) — NOT the rate-capped free API and never the client holding a key. Refetches on pan/zoom and
  // feeds the existing GPU particle layer (window.__helmWind). This is what makes the wind "alive".
  var PD = { on: false, key: '', t: null, handler: null, cache: {}, layer: 'wind' };
  function pdBbox(map) {
    var b = map.getBounds(), w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    if (e < w) e += 360;
    var mw = (e - w) * 0.4, mh = (n - s) * 0.4;
    return [w - mw, Math.max(-84, s - mh), e + mw, Math.min(84, n + mh)];
  }
  async function pdRefresh() {
    var map = S.map; if (!PD.on || !map || !window.__helmWind) return;
    var bb = pdBbox(map), key = PD.layer + '|' + bb.map(function (x) { return x.toFixed(1); }).join(',');
    if (key === PD.key) return; PD.key = key;
    var cached = PD.cache[key];
    if (cached) { window.__helmWind.setData(cached); window.__helmWind.setVisible(true); return; }
    try {
      var u = WX_SERVICE + '/velocity/' + PD.layer + '?w=' + bb[0].toFixed(3) + '&s=' + bb[1].toFixed(3) +
              '&e=' + bb[2].toFixed(3) + '&n=' + bb[3].toFixed(3);
      var vel = await fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      PD.cache[key] = vel;
      if (!PD.on) return;
      window.__helmWind.setData(vel); window.__helmWind.setVisible(true);
    } catch (e) {
      // FAIL LOUD: surface the broken live-particle feed rather than silently freezing stale particles.
      if (window.console) console.warn('[helm-wx] live particle velocity fetch failed (' + PD.layer + '):', e && e.message);
      notify('Live ' + PD.layer + ' particles: live feed unavailable (field still cached)', 'warn');
    }
  }
  function pdMove() { clearTimeout(PD.t); PD.t = setTimeout(function () { pdRefresh().catch(function () {}); }, 400); }
  function startParticles(map, layer) { PD.layer = layer || 'wind'; PD.on = true; if (!PD.handler) { PD.handler = pdMove; map.on('moveend', PD.handler); } pdRefresh().catch(function () {}); }
  function stopParticles(map) { PD.on = false; if (PD.handler) { map.off('moveend', PD.handler); PD.handler = null; } PD.key = ''; }

  function activeLayer() { return window.__activeWx || 'off'; }   // weather defaults OFF until the user picks a layer
  function notify(msg, level) {
    var n = document.getElementById('wx-notice'); if (!n) return;
    n.textContent = msg; n.style.display = 'block';
    n.style.color = level === 'warn' ? 'var(--warn,#e8a13a)' : (level === 'ok' ? 'var(--ok,#5fd08a)' : 'var(--cdim,#8aa)');
    n.style.borderColor = level === 'warn' ? 'var(--warn,#e8a13a)' : 'var(--line,#345)';
  }
  function seg(el, on) { Array.prototype.forEach.call(el.children, function (b) { b.dataset.sel = (b.dataset.val === on) ? '1' : ''; }); }

  function showLegacy(visible) {
    var map = S.map; if (!map) return;
    if (map.getLayer('helm-wxfield')) map.setLayoutProperty('helm-wxfield', 'visibility', visible ? 'visible' : 'none');
    var pc = document.getElementById('particles');
    // particle canvas is driven by the legacy code; just hide its layer if present
    if (map.getLayer('wind-particles')) map.setLayoutProperty('wind-particles', 'visibility', visible ? 'visible' : 'none');
  }

  // WX-19: find a prepared bundle region whose coverage contains the view and that has this layer.
  // Returns the region id, or null to fall back to the older tile/live/legacy paths. Any failure
  // (no bundle gateway, region not materialized, layer absent) -> null -> the old paths run unchanged.
  async function pickSceneRegion(map, layer) {
    if (!window.HelmWxScene || !window.HelmWxScene.loadManifest) return null;
    var region = (typeof window !== 'undefined' && window.HELM_WX_SCENE_REGION) || 'fiji';
    try {
      var man = await window.HelmWxScene.loadManifest(region);
      if (!man || !man.layers || !man.layers[layer]) return null;
      var b = (man.coverage || {}).bbox; if (!b) return region;
      if (b.crossesAntimeridian) return region;                 // wide coverage -> assume it covers the view
      var c = map.getCenter();
      return (c.lng >= b.west && c.lng <= b.east && c.lat >= b.south && c.lat <= b.north) ? region : null;
    } catch (e) { return null; }
  }

  async function apply() {
    var map = S.map; if (!map) return;                  // guard: setWeather()'s hook can fire before build() sets S.map
    var layer = activeLayer(), m = await cog();
    if (window.HelmWxLive) window.HelmWxLive.disable(map);
    if (window.HelmWxScene && window.HelmWxScene.disable) { try { window.HelmWxScene.disable(); } catch (e) {} }   // WX-19: tear down the scene each apply; re-enabled below if chosen
    m.disableEnsemble(map); m.disableWxTiles(map); stopParticles(map);
    if (layer === 'off') { showLegacy(false); setProbe(''); return; }

    if (S.model === 'ensemble') {
      showLegacy(false);
      // GFS-vs-ECMWF spread. Live two-model needs a connection; offline we show the committed demo
      // pack (Key West), clearly labelled — bake your area for a local ensemble.
      try {
        var idx = await fetch('data/wxtiles/ensemble.json').then(function (r) { return r.ok ? r.json() : null; });
        var pair = idx && idx.pairs && (idx.pairs[layer] || idx.pairs.wind);
        if (pair) {
          var mem = Object.keys(pair.members);
          await m.enableEnsemble(map, { maplibregl: window.maplibregl,
            manifestA: 'data/wxtiles/' + pair.members[mem[0]].manifest, manifestB: 'data/wxtiles/' + pair.members[mem[1]].manifest,
            labelA: mem[0].toUpperCase(), labelB: mem[1].toUpperCase(), layer: layer, beforeId: 'route-line', opacity: 0.85, notify: notify, frame: 6 });
          notify('Ensemble spread · GFS vs ECMWF (demo pack — bake your area for local)', 'ok');
        } else notify('No ensemble pack — run pipeline/make_value_tiles.py --demo-ensemble', 'warn');
      } catch (e) { notify('ensemble unavailable: ' + (e.message || e), 'warn'); }
    } else if (S.resolution === 'live') {
      // WX-19: prefer the prepared Environmental Scene (bundle field pyramid) when a bundle covers the
      // view — one renderer for colour + particles, no gesture-path upstream fetch. Falls through to the
      // tile/live/legacy paths below when no bundle gateway/region is reachable (today's default deploy).
      var sceneRegion = await pickSceneRegion(map, layer);
      if (sceneRegion && window.HelmWxScene) {
        try {
          await window.HelmWxScene.enable(map, { region: sceneRegion, layer: layer, opacity: wxOpacity() });
          showLegacy(false);
          notify('Live ' + layer + ' · prepared bundle scene (WX-19)', 'ok');
          probeSoon(); return;
        } catch (e) { try { window.HelmWxScene.disable(); } catch (e2) {} }   // fall through to the paths below
      }
      // Try the gateway for ANY layer (atmospheric AND marine). If it serves a manifest, render server-
      // baked value tiles — cached, overzoom, fill-on-zoom, identical behaviour across every layer. Wind
      // and current also get LIVE particles from /velocity. Gateway down -> direct Open-Meteo (atmos) or
      // the legacy field (marine). This is why all 11 layers now behave the same on global<->local zoom.
      var cfg = null;
      try {
        cfg = await m.enableWxTiles(map, { maplibregl: window.maplibregl,
          manifestUrl: WX_SERVICE + '/' + layer + '/manifest.json',
          beforeId: 'route-line', opacity: wxOpacity(), notify: function () {} });
      } catch (e) { cfg = null; }
      if (cfg) {
        showLegacy(false);
        if ((layer === 'wind' || layer === 'current') && particlesOn()) startParticles(map, layer); else stopParticles(map);
        notify('Live ' + layer + ' · helm-wx server tiles (cached) — Windy-style', 'ok');
      } else if (window.HelmWxLive && window.HelmWxLive.supports(layer)) {
        window.HelmWxLive.enable(map, { layer: layer, opacity: wxOpacity(), notify: notify });   // gateway down -> direct Open-Meteo
        notify('Live ' + layer + ' · direct (helm-wx gateway offline) — start services/wx for tiles', 'info');
      } else {
        // CLIENT-14: legacy field retired. Gateway down + non-atmospheric layer -> no offline field; say so.
        notify('Live ' + layer + ' needs the helm-wx gateway — start services/wx (no offline field for this layer)', 'warn');
      }
    } else {
      showLegacy(true);                                   // Standard + Single → the legacy field handles it
      notify('');
      var nn = document.getElementById('wx-notice'); if (nn) nn.style.display = 'none';
    }
    probeSoon();
  }

  function setProbe(html) { if (S.els.probe) S.els.probe.innerHTML = html || '<span style="color:var(--cdim,#8aa)">move the map to read a value</span>'; }
  function probeSoon() { clearTimeout(S.probeT); S.probeT = setTimeout(function () { probe().catch(function () {}); }, 250); }
  async function probe() {
    var map = S.map; if (!map) return;
    var c = map.getCenter(), m = await cog(), layer = activeLayer();
    if (layer === 'off') return setProbe('');
    var s = null;
    if (S.model === 'ensemble') { var e = await m.sampleEnsemble(c.lat, c.lng); if (e && e.value != null) return setProbe('<b>' + e.mean + ' ' + e.unit + '</b> · spread ' + e.spread + ' · ' + e.agreement); }
    else if (S.resolution === 'live' && window.HelmWxLive) { s = window.HelmWxLive.sampleAt(c.lat, c.lng); }
    if (s && s.value != null) return setProbe('<b>' + s.value + ' ' + s.unit + '</b> @ centre · ' + (s.sourceRef ? s.sourceRef.title : s.source));
    setProbe('');
  }

  function build(drawer, map) {
    S.map = map;
    var box = document.createElement('div');
    box.id = 'wx-plus';
    box.style.cssText = 'margin-top:12px;border-top:.5px solid var(--line,#2a3540);padding-top:11px';
    function label(t) { var d = document.createElement('div'); d.textContent = t; d.style.cssText = 'font-size:11px;color:var(--cdim,#8aa);margin:0 0 5px'; return d; }
    function segctl(opts) {
      var w = document.createElement('div'); w.style.cssText = 'display:flex;border:.5px solid var(--line,#345);border-radius:8px;overflow:hidden;margin-bottom:10px';
      opts.forEach(function (o) {
        var b = document.createElement('button'); b.dataset.val = o.val; b.textContent = o.txt; b.title = o.title || o.txt;
        b.style.cssText = 'flex:1;font-size:12px;padding:7px;border:0;background:transparent;color:var(--cdim,#8aa);cursor:pointer';
        b.addEventListener('mouseenter', function () { if (b.dataset.sel !== '1') b.style.background = 'rgba(255,255,255,.04)'; });
        b.addEventListener('mouseleave', function () { b.style.background = b.dataset.sel === '1' ? 'var(--accent,#39c2c9)' : 'transparent'; });
        w.appendChild(b);
      });
      return w;
    }
    function paintSeg(w, on) { Array.prototype.forEach.call(w.children, function (b) { var sel = b.dataset.val === on; b.dataset.sel = sel ? '1' : ''; b.style.background = sel ? 'var(--accent,#39c2c9)' : 'transparent'; b.style.color = sel ? '#05121d' : 'var(--cdim,#8aa)'; b.style.fontWeight = sel ? '600' : '400'; }); }

    // Resolution + Model controls are hidden for now — hardcoded to Live (fills view) + Single via the S
    // defaults. The segments are still built (just not appended) so the paint/handler lines below stay
    // valid; to expose the toggles again, re-append resSeg/modSeg here.
    var resSeg = segctl([{ val: 'standard', txt: 'Standard' }, { val: 'live', txt: 'Live · fills view' }]);
    var modSeg = segctl([{ val: 'single', txt: 'Single' }, { val: 'ensemble', txt: 'Ensemble spread' }]);

    var probe = document.createElement('div');
    probe.style.cssText = 'font-size:12px;background:rgba(255,255,255,.03);border:.5px solid var(--line,#345);border-radius:8px;padding:8px 10px;margin-bottom:10px;min-height:16px';
    box.appendChild(probe); S.els.probe = probe;

    var imp = document.createElement('div');
    imp.style.cssText = 'border:.5px dashed var(--line,#456);border-radius:8px;padding:8px 10px';
    imp.innerHTML = '<div style="font-size:12px;margin-bottom:4px"><span style="vertical-align:1px">⤓</span> Import PredictWind GPX / GRIB</div>' +
      '<div style="font-size:11px;color:var(--cdim,#8aa);margin-bottom:6px">device-local · never synced</div>';
    var file = document.createElement('input'); file.type = 'file'; file.accept = '.gpx,.grb,.grb2,.grib,.grib2'; file.style.cssText = 'font-size:11px;color:#cdd9e3;width:100%';
    file.addEventListener('change', function () { if (file.files && file.files[0] && window.HelmImport) { window.HelmImport.importFile(file.files[0], map, notify); } file.value = ''; });
    imp.appendChild(file); box.appendChild(imp);

    // insert after the transparency row (#wxopacity), before the legend
    var anchor = drawer.querySelector('#wxopacity');
    anchor = anchor ? (anchor.closest('.row') || anchor) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    else drawer.appendChild(box);

    paintSeg(resSeg, S.resolution); paintSeg(modSeg, S.model);
    resSeg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.resolution = b.dataset.val; paintSeg(resSeg, S.resolution); apply().catch(function () {}); });
    modSeg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.model = b.dataset.val; paintSeg(modSeg, S.model); apply().catch(function () {}); });
    setProbe('');

    // Transparency slider drives the SERVICE TILES too (index.html only wired it to the legacy field).
    // Keep index.html's lighter default (slider 28 ≈ 0.72 opacity) so the chart reads through — forcing a
    // Windy-opaque 0.92 here loaded too "thick" over the chart.
    var op = document.getElementById('wxopacity');
    if (op) {
      var applyTileOpacity = function () {
        if (window.HelmWxLive && HelmWxLive.setOpacity) HelmWxLive.setOpacity(S.map, wxOpacity());
        cog().then(function (m) { if (m.setWxOpacity) m.setWxOpacity(S.map, wxOpacity()); }).catch(function () {});
      };
      op.addEventListener('input', applyTileOpacity);
    }

    // re-apply my mode whenever the user picks a different weather layer
    var wx = document.getElementById('wx');
    if (wx) wx.addEventListener('click', function (e) { if (e.target.closest('button')) setTimeout(function () { apply().catch(function () {}); }, 60); });
    map.on('moveend', probeSoon);
    // Engage the default mode (Live · fills view) ON LOAD — otherwise the legacy static field stays up
    // until the user clicks the drawer, which is why weather looked like a fixed box on first paint.
    setTimeout(function () { if (activeLayer() !== 'off') apply().catch(function () {}); }, 150);
  }

  // Exposed so the shell's setWeather() can re-engage the current mode when the active layer changes
  // programmatically (not via a drawer click) — keeps Live tracking the active layer.
  window.HelmWxControls = { apply: function () { apply().catch(function () {}); } };

  function boot() {
    var map = window.map || (window.HelmShell && HelmShell.panel ? null : null);
    var drawer = document.getElementById('drawer-weather');
    if (!window.map || !drawer) return setTimeout(boot, 300);
    if (document.getElementById('wx-plus')) return;        // already built
    build(drawer, window.map);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 400);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 400); });
})();
