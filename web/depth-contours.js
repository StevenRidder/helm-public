/*
 * Helm — depth-contours.js   ·   PRODUCTION smooth depth contours
 * --------------------------------------------------------------------------
 * Renders pipeline/make_depth_contours.py output (web/data/depth-contours.geojson):
 * bathymetry contours precomputed at BUILD time — the DEM surface gaussian-smoothed,
 * marching-squared at navigation depth levels, then Chaikin-smoothed into flowing
 * curves — drawn as a plain MapLibre line layer. This is how Windy does it (precompute
 * smooth isolines, render as map lines), so the contours are SMOOTH at ANY zoom (vector
 * geometry, native over-zoom), offline, and need no runtime worker.
 *
 * (Replaces the earlier maplibre-contour approach, which ran marching-squares on the raw
 * DEM in a Web Worker at runtime -> blocky stair-steps + over-zoom that died past z12.
 * The Lab still keeps integrations/contour.js to demo maplibre-contour itself.)
 *
 * ESM, lazy-imported from index.html the first time the Layers toggle is switched on.
 */
const SRC = 'helm-depth-contours';
const LINE = 'helm-depth-contour-line', LBL = 'helm-depth-contour-label';

async function firstAvailable(urls) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (r && r.ok) return url;
    } catch (e) {}
  }
  return urls[urls.length - 1];
}

export async function enable(map, ctx = {}) {
  const beforeId = (ctx.beforeId && map.getLayer(ctx.beforeId)) ? ctx.beforeId : undefined;

  if (map.getLayer(LINE)) {                       // re-enable: just show
    [LINE, LBL].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'visible'));
    return;
  }

  if (!map.getSource(SRC)) {
    // MapLibre loads this (its own loader resolves the relative URL fine) and tiles it
    // internally, so the smooth lines over-zoom natively to any display zoom.
    const data = await firstAvailable(['user-data/depth-contours.geojson', 'data/depth-contours.geojson']);
    map.addSource(SRC, { type: 'geojson', data });
  }

  map.addLayer({
    id: LINE, type: 'line', source: SRC,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#46a0c4',                    // teal that reads on dark-water satellite
      'line-width': ['interpolate', ['linear'], ['zoom'],   // thinner zoomed out; index lines bolder
        8,  ['case', ['get', 'major'], 0.9, 0.4],
        14, ['case', ['get', 'major'], 2.0, 0.9]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 11, 0.78, 14, 0.92],
      'line-blur': 0.3,
    },
  }, beforeId);

  map.addLayer({
    id: LBL, type: 'symbol', source: SRC,
    minzoom: 11,                                   // labels only once they're readable
    filter: ['get', 'major'],                      // label index (major) contours only
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 240,
      'text-field': ['concat', ['number-format', ['abs', ['get', 'depth']], {}], ' m'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
    },
    paint: { 'text-color': '#bfe2f0', 'text-halo-color': 'rgba(13,19,27,0.85)', 'text-halo-width': 1.1 },
  }, beforeId);
}

export function disable(map) {
  [LINE, LBL].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
}
