'use strict';
// ais-select.js — CLIENT-7: tap-to-select highlight for AIS targets via MapLibre feature-state
// (NOT setData). Tapping a vessel on the chart — or a row in the AIS list — sets {selected:true} on
// that target's feature, keyed by its stable MMSI id (CLIENT-5's promoteId:'mmsi'), and draws a
// selection ring. Selecting another target, or tapping open water, clears the previous one.
//
// Why feature-state and not setData: the highlight is a STYLE-ONLY change. Re-pushing the whole AIS
// FeatureCollection just to mark one target selected would re-serialise every vessel each tick;
// setFeatureState restyles the single feature in place. And because the live `ais` source IS refreshed
// with setData every nav frame, we re-assert the selected state whenever the source updates so the
// ring can't flicker (feature-state can be dropped when GeoJSON data is reloaded).
//
// Self-contained: reads window.map, adds ONE circle layer + a few listeners; touches no AIS-owned
// module. The detail popup (index.html) keeps its own click handler — selection is independent of it.
(function () {
  var map = null;
  var SRC = 'ais';
  var RING = 'helm-ais-selected';
  var TAP_LAYERS = ['helm-ais-vessel-tri', 'helm-ais-symbol', 'ais-vessels'];
  var selected = null;   // currently-selected MMSI (feature id), or null

  // List rows carry a string data-mmsi; the source's promoted id is numeric. Match the type so
  // setFeatureState lands on the same feature whether the tap came from the map or the list.
  function norm(mmsi) {
    if (mmsi == null) return null;
    return (typeof mmsi === 'string' && /^\d+$/.test(mmsi)) ? +mmsi : mmsi;
  }
  function tapLayers() { return TAP_LAYERS.filter(function (l) { return map.getLayer(l); }); }
  function apply(mmsi, v) { try { map.setFeatureState({ source: SRC, id: mmsi }, { selected: v }); } catch (e) {} }

  // The selection ring: a stroked circle on the SAME `ais` source, visible ONLY for the feature whose
  // feature-state.selected is true (every other feature draws a 0-width, 0-opacity stroke = invisible).
  // Placed under helm-ais-vessel-tri so it reads as a halo beneath the vessel ▲.
  function ensureRing() {
    if (!map || !map.getStyle() || !map.getSource(SRC) || map.getLayer(RING)) return;
    var on = ['boolean', ['feature-state', 'selected'], false];
    map.addLayer({
      id: RING, type: 'circle', source: SRC,
      paint: {
        'circle-radius': 16,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#5bc0ff',
        'circle-stroke-width': ['case', on, 3, 0],
        'circle-stroke-opacity': ['case', on, 0.95, 0]
      }
    }, map.getLayer('helm-ais-vessel-tri') ? 'helm-ais-vessel-tri' : undefined);
  }

  function select(mmsi) {
    mmsi = norm(mmsi);
    if (mmsi == null) return;
    ensureRing();
    if (selected != null && selected !== mmsi) apply(selected, false);
    selected = mmsi;
    apply(selected, true);
  }
  function clear() {
    if (selected == null) return;
    apply(selected, false);
    selected = null;
  }

  function init(opts) {
    map = (opts && opts.map) || window.map;
    if (!map) return;
    if (map.isStyleLoaded && map.isStyleLoaded()) ensureRing(); else map.on('load', ensureRing);

    // tap a vessel symbol -> select it (independent of the detail popup's own handler)
    TAP_LAYERS.forEach(function (l) {
      map.on('click', l, function (e) {
        var f = e.features && e.features[0]; if (!f) return;
        select(f.id != null ? f.id : (f.properties && f.properties.mmsi));
      });
    });
    // tap open water (no AIS target under the cursor) -> clear selection
    map.on('click', function (e) {
      var layers = tapLayers();
      if (!layers.length) return;
      if (!map.queryRenderedFeatures(e.point, { layers: layers }).length) clear();
    });
    // tap a row in the AIS list (collision.js #helm-ais-list) -> select that target too. Delegated so
    // it survives the list re-rendering its rows; the row's own onclick (flyTo) still runs.
    document.addEventListener('click', function (e) {
      var row = e.target && e.target.closest && e.target.closest('#helm-ais-list tr.ais-row[data-mmsi]');
      if (row) select(row.getAttribute('data-mmsi'));
    });
    // re-assert the selected state each time the live `ais` source is refreshed (setData per nav frame)
    map.on('sourcedata', function (e) {
      if (selected != null && e.sourceId === SRC && e.isSourceLoaded) apply(selected, true);
    });
  }

  window.HelmAisSelect = { init: init, select: select, clear: clear, get selected() { return selected; } };
})();
