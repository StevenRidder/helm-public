/*
 * Helm — integrations/pmtiles.js   ·   PMTiles (protomaps)
 * --------------------------------------------------------------------------
 * The modern, serverless container for our offline charts. CHART-PIPELINE.md
 * currently packs `.mbtiles` (SQLite); PMTiles is a SINGLE file read over HTTP
 * range requests with ZERO server — and it sidesteps the mbtiles TMS Y-flip
 * footgun the pipeline doc calls out. Identical web <-> native, which fits the
 * "two-thirds reuse" thesis.
 *
 * Demo: loads web/data/<region>-sat.pmtiles as a raster source. Produce it with
 *   bash pipeline/make_pmtiles.sh           (mbtiles -> pmtiles, off-the-shelf)
 * If the file isn't there yet we surface a notice instead of failing silently.
 *
 * https://github.com/protomaps/PMTiles
 */
import { Protocol } from 'pmtiles';

const SRC = 'helm-pmtiles', LYR = 'helm-pmtiles';
let protocolReady = false;

function protocolHandler(protocol) {
  const handler = protocol && (protocol.tile || protocol.tilev4);
  if (typeof handler !== 'function') throw new Error('PMTiles protocol handler unavailable');
  return handler.bind(protocol);
}

export async function enable(map, ctx) {
  if (!protocolReady) {
    const protocol = new Protocol();
    try {
      ctx.maplibregl.addProtocol('pmtiles', protocolHandler(protocol));
    } catch (e) {
      if (!/already|exist|registered/i.test(String((e && e.message) || e))) throw e;
    }
    protocolReady = true;
  }
  if (map.getLayer(LYR)) { map.setLayoutProperty(LYR, 'visibility', 'visible'); return; }

  const file = ctx.pmtilesUrl || `data/${ctx.region.name}-sat.pmtiles`;
  // Probe first so a missing file becomes a helpful message, not a console wall.
  try {
    const head = await fetch(file, { method: 'GET', headers: { Range: 'bytes=0-16' } });
    if (!head.ok) throw new Error(String(head.status));
  } catch (e) {
    ctx.notify(`PMTiles demo needs ${file} — run pipeline/make_pmtiles.sh`, 'warn');
    return;
  }

  map.addSource(SRC, { type: 'raster', url: `pmtiles://${new URL(file, location.href).href}`, tileSize: 256 });
  map.addLayer({ id: LYR, type: 'raster', source: SRC,
    paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 500 } } }, ctx.beforeId);
  requestAnimationFrame(() => { if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'raster-opacity', 0.85); });
  ctx.notify('PMTiles offline raster loaded (single-file, no server)', 'ok');
}

export function disable(map) {
  if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'none');
}
