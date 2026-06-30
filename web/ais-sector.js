// ais-sector.js — AIS-13: the "safe-course sector" drawn around ownship. A ring of headings — green
// where you'd clear your CPA limit, red where you'd close inside it — scored against EVERY danger
// target at once (HelmAisAdvisor.safeSector, the same relative-motion sweep the card advice uses). It
// only appears when there's an actual threat + you're making way; it shares the evasion-advisor toggle.
// Namespaced helm-ais-sector layers, drawn under the vessel symbols; the chart itself stays 1:1.
(function () {
  'use strict';
  if (!window.HelmShell) return;
  var SRC = 'helm-ais-sector';
  var GREEN = '#3bd17d', RED = '#ff5a52', WHITE = '#eaf2f8';
  var M_PER_NM = 1852, M_PER_DEG = 111320, DEG = Math.PI / 180;
  var map = null, raf = 0, built = false;

  function project(lon, lat, brg, distNM) {
    var d = distNM * M_PER_NM, b = brg * DEG, cl = Math.max(Math.abs(Math.cos(lat * DEG)), 0.01);
    return [lon + (d * Math.sin(b)) / (M_PER_DEG * cl), lat + (d * Math.cos(b)) / M_PER_DEG];
  }
  function nmPerPx(lat, zoom) { return (156543.03392 * Math.abs(Math.cos(lat * DEG)) / Math.pow(2, zoom)) / M_PER_NM; }

  function ensure() {
    if (built) return true;
    if (!map || !map.getStyle || !map.getStyle() || !map.getSource) return false;
    try { if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }); }
    catch (e) { return false; }
    var before = map.getLayer('helm-ais-vessel-tri') ? 'helm-ais-vessel-tri' : undefined;
    if (!map.getLayer('helm-ais-sector-fill'))
      map.addLayer({ id: 'helm-ais-sector-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'arc'], paint: { 'fill-color': ['get', 'col'], 'fill-opacity': 0.22 } }, before);
    if (!map.getLayer('helm-ais-sector-cog'))
      map.addLayer({ id: 'helm-ais-sector-cog', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'cog'], paint: { 'line-color': WHITE, 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } }, before);
    built = true;
    return true;
  }

  function dangerTargets() {
    var out = [], seen = {};
    try {
      var fs = map.querySourceFeatures('ais') || [];
      for (var i = 0; i < fs.length; i++) {
        var p = fs[i].properties || {};
        if (p.mmsi != null) { if (seen[p.mmsi]) continue; seen[p.mmsi] = 1; }
        if (window.HelmAisRisk && HelmAisRisk.isDanger && HelmAisRisk.isDanger(p)) out.push(p);
      }
    } catch (e) {}
    return out;
  }

  function build() {
    if (!ensure()) return;
    var src = map.getSource(SRC); if (!src) return;
    var on = window.HelmAisAdvisor && HelmAisAdvisor.isEnabled && HelmAisAdvisor.isEnabled();
    var sec = on && HelmAisAdvisor.safeSector ? HelmAisAdvisor.safeSector(dangerTargets()) : null;
    if (!sec || sec.lon == null || sec.lat == null) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    var lon = sec.lon, lat = sec.lat, step = sec.step;
    var rpx = nmPerPx(lat, map.getZoom()), Rin = 95 * rpx, Rout = 132 * rpx;

    // merge contiguous same-safe headings into arcs (with wrap-around across 0°)
    var hs = sec.headings, arcs = [], cur = null;
    for (var i = 0; i < hs.length; i++) {
      if (!cur || cur.safe !== hs[i].safe) { cur = { safe: hs[i].safe, from: hs[i].deg, to: hs[i].deg }; arcs.push(cur); }
      else cur.to = hs[i].deg;
    }
    if (arcs.length > 1 && arcs[0].safe === arcs[arcs.length - 1].safe) { arcs[0].from = arcs[arcs.length - 1].from - 360; arcs.pop(); }

    var feats = [];
    arcs.forEach(function (a) {
      var outer = [], inner = [];
      for (var h = a.from; h <= a.to + step + 0.01; h += step) { outer.push(project(lon, lat, h, Rout)); inner.push(project(lon, lat, h, Rin)); }
      var ring = outer.concat(inner.reverse()); ring.push(ring[0]);
      feats.push({ type: 'Feature', properties: { kind: 'arc', col: a.safe ? GREEN : RED }, geometry: { type: 'Polygon', coordinates: [ring] } });
    });
    feats.push({ type: 'Feature', properties: { kind: 'cog' }, geometry: { type: 'LineString', coordinates: [project(lon, lat, sec.cog, Rin * 0.25), project(lon, lat, sec.cog, Rout * 1.12)] } });
    src.setData({ type: 'FeatureCollection', features: feats });
  }

  function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; build(); }); }

  // window.map is assigned mid-load and may briefly be a not-yet-ready object, so require a REAL map
  // (has .on + .getSource) before wiring — never throw, just wait for the next tick.
  function mapReady() { var m = window.map; return (m && typeof m.on === 'function' && typeof m.getSource === 'function') ? m : null; }
  var wired = false;
  function wire() {
    if (wired) return; var m = mapReady(); if (!m) return;
    wired = true; map = m;
    m.on('sourcedata', function (e) { if (e.sourceId === 'ais' && e.isSourceLoaded) schedule(); });
    m.on('moveend', schedule); m.on('zoomend', schedule);
    m.on('styledata', function () { built = false; schedule(); });
    try { HelmShell.onNav(function () { schedule(); }); } catch (e) {}
    try { window.addEventListener('helm:ais-advisor', schedule); } catch (e) {}
    schedule();
  }
  var iv = setInterval(function () { if (mapReady()) { clearInterval(iv); wire(); } }, 250);
  wire();
  window.HelmAisSector = { redraw: schedule };
})();
