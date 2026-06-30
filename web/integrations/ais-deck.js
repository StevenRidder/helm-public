/*
 * Helm — integrations/ais-deck.js   ·   deck.gl (@deck.gl/mapbox)
 * --------------------------------------------------------------------------
 * AIS at scale. The style.json renders a handful of vessels as symbol layers —
 * fine for the sample, but hundreds/thousands of targets (icons + CPA colour +
 * density) is deck.gl's home turf. We composite a MapboxOverlay over MapLibre
 * and draw the fleet as a ScatterplotLayer + an optional HeatmapLayer.
 *
 * To make the "at scale" point feel real we jitter the sample into ~2,000
 * synthetic targets around the region. Swap the data for a live AIS feed and
 * the layers are unchanged.
 *
 * https://deck.gl  ·  https://deck.gl/docs/api-reference/mapbox/mapbox-overlay
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';

let overlay = null;

function fleet(center) {
  const [lon, lat] = center, out = [];
  for (let i = 0; i < 2000; i++) {
    const r = Math.random();
    out.push({
      position: [lon + (Math.random() - 0.5) * 0.9, lat + (Math.random() - 0.5) * 0.7],
      cpa: r < 0.04 ? Math.random() * 0.2 : r < 0.12 ? 0.2 + Math.random() * 0.3 : 1 + Math.random() * 5,
      sog: +(Math.random() * 18).toFixed(1),
    });
  }
  return out;
}

const colorByCpa = d => d.cpa < 0.2 ? [228, 86, 79] : d.cpa < 0.5 ? [242, 180, 65] : [91, 192, 255];

// Load the real-format AIS fleet pack (pipeline/gen_demo_data.py). Each feature
// carries mmsi/name/sog/cog/cpa_nm — the same shape a decoded NMEA/AIS feed
// produces — so swapping in a live feed leaves the layers untouched. Falls back
// to a synthetic jitter if the pack isn't present.
async function loadFleet(ctx) {
  try {
    const fc = await fetch(ctx.aisUrl || 'data/ais-fleet.geojson').then(r => {
      if (!r.ok) throw new Error(String(r.status)); return r.json();
    });
    return fc.features.map(f => ({
      position: f.geometry.coordinates,
      cpa: f.properties.cpa_nm, sog: f.properties.sog, name: f.properties.name,
    }));
  } catch (e) {
    return fleet(ctx.region.center);  // offline fallback
  }
}

export async function enable(map, ctx) {
  const data = await loadFleet(ctx);
  const synthetic = !data[0] || data[0].name === undefined;
  const layers = [
    new HeatmapLayer({
      id: 'helm-ais-heat', data, getPosition: d => d.position, getWeight: 1,
      radiusPixels: 40, intensity: 1, threshold: 0.05, opacity: 0.35,
    }),
    new ScatterplotLayer({
      id: 'helm-ais-scatter', data, getPosition: d => d.position,
      getFillColor: colorByCpa, getRadius: 60, radiusMinPixels: 2, radiusMaxPixels: 6,
      stroked: true, getLineColor: [13, 19, 27], lineWidthMinPixels: 0.5, pickable: true,
    }),
  ];
  if (!overlay) { overlay = new MapboxOverlay({ interleaved: true, layers }); map.addControl(overlay); }
  else overlay.setProps({ layers });
  ctx.notify(`deck.gl: ${data.length} AIS targets${synthetic ? ' (synthetic)' : ''} — scatter + heatmap`, 'ok');
}

export function disable(map) {
  // Fully DETACH the deck overlay (frees its GL resources + picking machinery) instead of just
  // clearing its layers, and null the ref so the next enable() builds a FRESH MapboxOverlay —
  // sidestepping deck.gl's "re-add renders nothing" gotcha and the prior reuse-a-cleared-overlay leak.
  if (overlay) { try { map.removeControl(overlay); } catch (e) {} overlay = null; }
}
