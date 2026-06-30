// ais-buddy.js — AIS-9: buddy / named-MMSI tagging.
//
// A client-side, user-managed list of "known" vessels — a buddy boat on passage, your other hull, a
// friend in the anchorage. Tagging a target (★ in the tap card) gives it a distinct cyan ring + an
// optional custom name on the chart, a ★ badge wherever the target is listed, and the tag persists in
// localStorage. No engine round-trip: OpenCPN's AIS_GPSG_BUDDY flag is an optional future nicety; the
// useful 90% (a personal, portable buddy list) is purely client-side, so it works on any feed.
//
// IN-LANE: reads the SAME live `ais` map source via querySourceFeatures (no edit to the nav loop),
// draws into its own namespaced helm-ais-buddy-* layers, and exposes window.HelmAisBuddy for the card.
(function () {
  'use strict';
  var KEY = 'helm.ais.buddies';
  var CYAN = '#37c7ff';
  var buddies = load();                    // { "<mmsi>": "<custom name or ''>" }

  function load() { try { var v = localStorage.getItem(KEY); var o = v ? JSON.parse(v) : {}; return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(buddies)); } catch (e) { /* private mode */ } fire(); redraw(); }
  function fire() { try { if (window.dispatchEvent && window.CustomEvent) window.dispatchEvent(new CustomEvent('helm:ais-buddy')); } catch (e) {} }

  function key(mmsi) { return String(mmsi); }
  function isBuddy(mmsi) { return mmsi != null && Object.prototype.hasOwnProperty.call(buddies, key(mmsi)); }
  function nameOf(mmsi) { return (mmsi != null && buddies[key(mmsi)]) || ''; }
  function set(mmsi, name) { if (mmsi == null) return; buddies[key(mmsi)] = (name == null ? (buddies[key(mmsi)] || '') : String(name).slice(0, 40)); persist(); }
  function remove(mmsi) { if (mmsi == null) return; delete buddies[key(mmsi)]; persist(); }
  function toggle(mmsi, name) { if (isBuddy(mmsi)) remove(mmsi); else set(mmsi, name || ''); return isBuddy(mmsi); }
  function list() { return Object.keys(buddies).map(function (m) { return { mmsi: +m, name: buddies[m] }; }); }
  function shortAisName(n) { return n ? String(n).replace(/@+/g, '').trim() : ''; }

  // ---- chart overlay: a cyan ring + name on each buddy target (drawn like ais-sector / ais-select) ----
  var SRC = 'helm-ais-buddy', map = null, raf = 0, built = false;
  // window.map is assigned mid-load and may briefly be a not-yet-ready object — require a REAL map.
  function mapReady() { var m = window.map; return (m && typeof m.on === 'function' && typeof m.getSource === 'function') ? m : null; }
  function ensure() {
    if (built) return true;
    if (!map || !map.getStyle || !map.getStyle() || !map.getSource) return false;
    try { if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }); }
    catch (e) { return false; }
    var underTri = map.getLayer('helm-ais-vessel-tri') ? 'helm-ais-vessel-tri' : (map.getLayer('ais-vessels') ? 'ais-vessels' : undefined);
    if (!map.getLayer('helm-ais-buddy-ring'))
      map.addLayer({ id: 'helm-ais-buddy-ring', type: 'circle', source: SRC,
        paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': CYAN, 'circle-stroke-width': 2.2, 'circle-stroke-opacity': 0.9 } }, underTri);
    if (!map.getLayer('helm-ais-buddy-label'))   // label on top (no `before`)
      map.addLayer({ id: 'helm-ais-buddy-label', type: 'symbol', source: SRC,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -1.7], 'text-anchor': 'bottom', 'text-allow-overlap': true },
        paint: { 'text-color': CYAN, 'text-halo-color': 'rgba(7,12,18,0.95)', 'text-halo-width': 1.8 } });
    built = true; return true;
  }
  function build() {
    if (!ensure()) return;
    var src = map.getSource(SRC); if (!src) return;
    var feats = [];
    try {
      var fs = map.querySourceFeatures('ais'), seen = {};
      for (var i = 0; i < fs.length; i++) {
        var p = fs[i].properties || {}, c = fs[i].geometry && fs[i].geometry.coordinates;
        if (!c || p.mmsi == null || seen[p.mmsi] || !isBuddy(p.mmsi)) continue;
        seen[p.mmsi] = 1;
        var label = '★ ' + (nameOf(p.mmsi) || shortAisName(p.name) || ('MMSI ' + p.mmsi));
        feats.push({ type: 'Feature', properties: { label: label }, geometry: { type: 'Point', coordinates: [c[0], c[1]] } });
      }
    } catch (e) { /* style not ready this tick */ }
    src.setData({ type: 'FeatureCollection', features: feats });
  }
  function redraw() { if (!map || raf) return; raf = requestAnimationFrame(function () { raf = 0; build(); }); }

  var iv = setInterval(function () {
    var m = mapReady(); if (!m) return; clearInterval(iv); map = m;
    m.on('sourcedata', function (e) { if (e.sourceId === 'ais' && e.isSourceLoaded) redraw(); });
    m.on('moveend', redraw); m.on('zoomend', redraw);
    m.on('styledata', function () { built = false; redraw(); });
    try { if (window.HelmShell && HelmShell.onNav) HelmShell.onNav(function () { redraw(); }); } catch (e) {}
    redraw();
  }, 250);

  window.HelmAisBuddy = { isBuddy: isBuddy, name: nameOf, set: set, remove: remove, toggle: toggle, list: list, redraw: redraw };
})();
