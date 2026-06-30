/*
 * Helm — integrations/mercator.js   ·   Mercator-style value-encoded tiles
 * --------------------------------------------------------------------------
 * Mercator (mercator.blue) serves gridded earth data — weather, ocean,
 * elevation — as VALUE-ENCODED Web Mercator raster tiles: each pixel's RGB
 * encodes a real measurement, decoded/colourised client-side. That's exactly
 * the shape WEATHER.md wants, and a cleaner contract than our bespoke
 * field-<layer>.json image source (which is one fixed-bbox blob, not a
 * pan/zoomable pyramid).
 *
 * mercator.blue is a hosted service (key/account); rather than gate this demo
 * behind a signup, we demonstrate the PATTERN live with a public value-encoded
 * raster — the Terrarium DEM — rendered as MapLibre native hillshade + a
 * colour-relief band. Same family as a Mercator weather tile; swap the source
 * + colour ramp for wind/SST/pressure in production. See docs.
 */
const DEM = 'helm-mercator-dem', HILL = 'helm-mercator-hill';

export async function enable(map, ctx) {
  if (map.getLayer(HILL)) { map.setLayoutProperty(HILL, 'visibility', 'visible'); return; }

  if (!map.getSource(DEM)) {
    map.addSource(DEM, {
      type: 'raster-dem',
      // Local value-encoded raster pack (pipeline/gen_demo_data.py) — each pixel's
      // RGB encodes a real measurement (here: depth/elevation), decoded on the GPU.
      // Same contract as a mercator.blue weather tile; swap source + ramp for
      // wind/SST/pressure in production.
      tiles: [new URL('data/dem/', location.href).href + '{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 12,
      attribution: 'Helm offline DEM pack · value-encoded (Mercator pattern)',
    });
  }

  map.addLayer({
    id: HILL, type: 'hillshade', source: DEM,
    paint: {
      'hillshade-exaggeration': 0.6,
      'hillshade-shadow-color': '#0b2233',
      'hillshade-highlight-color': '#bfe2f0',
      'hillshade-accent-color': '#2f6f8f',
    },
  }, ctx.beforeId);

  ctx.notify('Value-encoded raster decoded client-side (Mercator pattern)', 'ok');
}

export function disable(map) {
  if (map.getLayer(HILL)) map.setLayoutProperty(HILL, 'visibility', 'none');
}
