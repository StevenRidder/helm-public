// track.js — ownship breadcrumb trail (DISPLAY ONLY). Always-on automatic recording lives in the
// ENGINE (helm_server.cpp records the displayed fix whenever the boat moves — distance-gated like
// OpenCPN; owns the trail as the single source of truth). This module just draws the line MapLibre-
// side from the streamed track (full in snapshots, appended in deltas). No on-screen control —
// recording just happens. (Clear/pause remain available over the command-plane: track.clear / track.arm.)
(function () {
  const SRC = 'helm-track';
  const MAX_TRACK_POINTS = 3000;   // mirror the engine's kTrackCap — never let the client trail grow unbounded
  let map = null, coords = [];

  function lineGeo() {
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.length >= 2 ? coords : [] } };
  }
  function ensureLayer() {
    if (!map || map.getSource(SRC)) return;
    map.addSource(SRC, { type: 'geojson', data: lineGeo() });
    map.addLayer({
      id: 'helm-track-line', type: 'line', source: SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#5bc0ff', 'line-width': 2, 'line-opacity': 0.85 },
    });
  }
  function redraw() { try { ensureLayer(); const s = map && map.getSource(SRC); if (s) s.setData(lineGeo()); } catch (e) {} }

  function cap() { if (coords.length > MAX_TRACK_POINTS) coords = coords.slice(coords.length - MAX_TRACK_POINTS); }
  function onState(s) {
    if (!s) return;
    if (Array.isArray(s.track)) { coords = s.track.map(p => [p[1], p[0]]); cap(); redraw(); }                       // snapshot: full trail (capped)
    else if (Array.isArray(s.trackAdd) && s.trackAdd.length) { for (const p of s.trackAdd) coords.push([p[1], p[0]]); cap(); redraw(); }  // delta: append (capped)
  }

  function init(opts) {
    map = opts && opts.map;
    if (!map) return;
    if (map.isStyleLoaded && map.isStyleLoaded()) ensureLayer(); else map.on('load', ensureLayer);
  }
  window.HelmTrack = { init, onState };
})();
