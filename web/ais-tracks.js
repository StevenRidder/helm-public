// ais-tracks.js — AIS target trails ("wakes"). Client-side accumulation, the mirror of the ownship
// breadcrumb (track.js) but for EVERY AIS target: keep a short rolling history of each vessel's
// position from the live feed and draw one fading line per MMSI. OpenCPN keeps a full per-target
// m_ptrack server-side; here we accumulate display-only from the streamed AIS list (no engine change),
// so it works today and composes with the speed-scaled predictor. Toggle + trail length live in the
// AIS hub "Tracks" tab. Default OFF — trails are opt-in so the chart stays clean until you want them.
(function () {
  if (!window.HelmShell) return;
  var SRC = 'helm-ais-tracks', LAYER = 'helm-ais-tracks-line';
  var trails = new Map();                 // mmsi -> { pts: [[lon,lat,ts], ...], risk }
  var map = null, enabled = false, maxMin = 30, MAX_PTS = 300, MAX_TRAILS = 400;
  var PREF = 'helm.ais.tracks';

  function loadPrefs() { try { var o = JSON.parse(localStorage.getItem(PREF) || '{}'); if (typeof o.enabled === 'boolean') enabled = o.enabled; if (o.maxMin) maxMin = +o.maxMin; } catch (e) {} }
  function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify({ enabled: enabled, maxMin: maxMin })); } catch (e) {} }

  // ~>6 m of travel (in NM, cos-corrected) before we drop a new breadcrumb — keeps trails light.
  function moved(a, b) { var dx = (a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180), dy = a[1] - b[1]; return Math.hypot(dx, dy) * 60 > 0.0033; }

  function ensureLayer() {
    if (!map || map.getSource(SRC)) return;
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    var below = map.getLayer('helm-ais-vessel-tri') ? 'helm-ais-vessel-tri' : undefined;   // trails UNDER the vessels
    map.addLayer({
      id: LAYER, type: 'line', source: SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': enabled ? 'visible' : 'none' },
      paint: {
        // a dangerous vessel's wake stands out red; everything else is a quiet teal so it reads as history
        'line-color': ['case', ['==', ['get', 'risk'], 'danger'], '#ff5a52', ['==', ['get', 'risk'], 'caution'], '#f5c451', '#5dd0b0'],
        'line-width': 1.6, 'line-opacity': 0.5,
      },
    }, below);
  }

  function rebuild() {
    if (!map) { return; }
    var now = Date.now(), feats = [];
    trails.forEach(function (tr, mmsi) {
      var pts = tr.pts.filter(function (p) { return now - p[2] < maxMin * 60000; });
      tr.pts = pts;
      if (pts.length >= 2) feats.push({ type: 'Feature', properties: { mmsi: mmsi, risk: tr.risk || 'normal' },
        geometry: { type: 'LineString', coordinates: pts.map(function (p) { return [p[0], p[1]]; }) } });
    });
    try { var s = map.getSource(SRC); if (s) s.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {}
  }

  function onNav(s) {
    if (!enabled || !s || !Array.isArray(s.ais)) return;
    var now = Date.now();
    for (var i = 0; i < s.ais.length; i++) {
      var t = s.ais[i]; if (!t || !isFinite(t.lon) || !isFinite(t.lat)) continue;
      var tr = trails.get(t.mmsi); if (!tr) { if (trails.size >= MAX_TRAILS) continue; tr = { pts: [] }; trails.set(t.mmsi, tr); }
      tr.risk = t.risk;
      var last = tr.pts[tr.pts.length - 1], p = [t.lon, t.lat, now];
      if (!last || moved(p, last)) { tr.pts.push(p); if (tr.pts.length > MAX_PTS) tr.pts.shift(); }
    }
    rebuild();
  }

  function setEnabled(on) {
    enabled = !!on; savePrefs();
    try { ensureLayer(); if (map && map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', enabled ? 'visible' : 'none'); } catch (e) {}
    if (enabled) rebuild();
  }
  function setMaxMin(m) { maxMin = +m || 30; savePrefs(); rebuild(); }
  function clearAll() { trails.clear(); rebuild(); }

  // ---- AIS-hub "Tracks" tab: master toggle + trail-length slider + clear ----
  function renderTab(pane) {
    pane.innerHTML = '';
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:9px;font-size:12.5px;color:#e6eef5;cursor:pointer;margin:2px 0 12px';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = enabled;
    cb.style.cssText = 'accent-color:#5dd0b0;width:15px;height:15px';
    cb.addEventListener('change', function () { setEnabled(cb.checked); });
    row.appendChild(cb); row.appendChild(document.createTextNode(' Show vessel trails'));
    pane.appendChild(row);

    var lbl = document.createElement('div'); lbl.className = 'aish-mlbl';
    lbl.innerHTML = '<span>Trail length</span><span class="anch" id="aistk-len"></span>';
    pane.appendChild(lbl);
    var sl = document.createElement('input'); sl.type = 'range'; sl.min = '5'; sl.max = '120'; sl.step = '5'; sl.value = String(maxMin);
    sl.style.cssText = 'width:100%';
    var out = function () { var e = pane.querySelector('#aistk-len'); if (e) e.textContent = maxMin + ' min'; };
    sl.addEventListener('input', function () { setMaxMin(sl.value); out(); });
    pane.appendChild(sl); out();

    var clr = document.createElement('button'); clr.type = 'button'; clr.textContent = 'Clear all trails'; clr.title = 'Remove all AIS target trails';
    clr.style.cssText = 'margin-top:12px;width:100%;font:500 11.5px/1 inherit;padding:8px;border-radius:8px;border:.5px solid rgba(255,255,255,.16);background:transparent;color:#cdd9e3;cursor:pointer';
    clr.addEventListener('click', clearAll);
    pane.appendChild(clr);

    var note = document.createElement('div');
    note.style.cssText = 'margin-top:10px;font-size:10px;color:#7e93a4;line-height:1.5';
    note.textContent = 'Trails accumulate live from the AIS feed while Helm is open (display only). A red wake = a vessel currently flagged dangerous.';
    pane.appendChild(note);
  }

  function init(opts) {
    map = opts && opts.map; if (!map) return;
    loadPrefs();
    if (map.isStyleLoaded && map.isStyleLoaded()) ensureLayer(); else map.on('load', ensureLayer);
    map.on('styledata', ensureLayer);   // re-add after a basemap switch
  }

  HelmShell.onNav(onNav);               // self-wire: accumulate from every nav frame that carries AIS
  (window.HelmAisHub && HelmAisHub.registerTab ? HelmAisHub.registerTab : HelmShell.registerPanel)(
    { id: 'helm-ais-tracks', title: 'Tracks', render: renderTab });
  window.HelmAisTracks = { init: init, onNav: onNav, setEnabled: setEnabled, clearAll: clearAll };
})();
