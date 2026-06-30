/*
 * Helm — integrations/contour.js   ·   maplibre-contour (onthegomap)
 * --------------------------------------------------------------------------
 * On-the-fly contour lines from a terrain-RGB DEM, computed in a worker. This
 * is the off-the-shelf replacement for our hand-rolled isolines.js (marching
 * squares + polyline stitching): point it at a value-encoded DEM and get
 * labelled isolines for free.
 *
 * We use the public Terrarium DEM (AWS open data), which encodes BATHYMETRY
 * (negative elevations) as well as land — so around Key West this draws real
 * depth contours under the chart. For weather isobars, feed it a pressure
 * field exported as terrain-RGB instead (same code path).
 *
 * https://github.com/onthegomap/maplibre-contour
 */
import mlcontour from 'maplibre-contour';

const DEM = 'helm-dem', CONT = 'helm-contours', LINE = 'helm-contour-line', LBL = 'helm-contour-label';
let demSource = null;

export async function enable(map, ctx) {
  if (map.getLayer(LINE)) {
    [LINE, LBL].forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
    return;
  }
  if (!demSource) {
    demSource = new mlcontour.DemSource({
      // ABSOLUTE url: maplibre-contour's Web Worker can't resolve a relative path (no
      // document base), so resolve against the page origin. LOCAL terrarium DEM
      // (pipeline/fetch_dem.py) — offline-first, no CDN.
      url: new URL('data/dem/', document.baseURI).href + '{z}/{x}/{y}.png',
      encoding: 'terrarium',
      maxzoom: 12,
      worker: true,
    });
    demSource.setupMaplibre(ctx.maplibregl);
  }

  map.addSource(CONT, {
    type: 'vector',
    tiles: [demSource.contourProtocolUrl({
      // metres, per display zoom — coarse (regional) through fine (close-in). [minor, index].
      thresholds: {
        6: [500, 2000], 7: [200, 1000], 8: [100, 500],
        9: [50, 250], 10: [50, 250], 11: [20, 100], 12: [5, 25],
      },
      subsampleBelow: 13,     // upsample DEM before contouring -> smoother lines
      elevationKey: 'ele',
      levelKey: 'level',
      contourLayer: 'contours',
    })],
    maxzoom: 12,              // generate at native DEM zooms; MapLibre vector-over-zooms for closer display (any zoom)
  });

  map.addLayer({
    id: LINE, type: 'line', source: CONT, 'source-layer': 'contours',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#46a0c4',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        8, ['match', ['get', 'level'], 1, 0.8, 0.4], 14, ['match', ['get', 'level'], 1, 1.7, 0.8]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 11, 0.7, 14, 0.85],
      'line-blur': 0.4,
    },
  }, ctx.beforeId);

  map.addLayer({
    id: LBL, type: 'symbol', source: CONT, 'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['concat', ['number-format', ['abs', ['get', 'ele']], {}], ' m'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
    },
    paint: { 'text-color': '#1e5066', 'text-halo-color': '#fff', 'text-halo-width': 1.1 },
  }, ctx.beforeId);

  ctx.notify('Contours from DEM (worker) — replaces isolines.js', 'ok');
}

export function disable(map) {
  [LINE, LBL].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
}
