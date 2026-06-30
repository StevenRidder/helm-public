/*
 * Helm — integrations/temporal.js   ·   maplibre-gl-temporal-control (mug-jp)
 * --------------------------------------------------------------------------
 * A ready-made time slider + play/pause that animates a stack of layers by
 * fading them in/out frame-by-frame. We feed it the RainViewer precipitation
 * nowcast (past frames + forecast), giving a real temporal animation that
 * complements radar.js and shows the control we'd reuse across every weather
 * layer's time dimension.
 *
 * NOTE: the plugin only toggles opacity of layers that ALREADY exist (it never
 * calls addSource/addLayer). So we add each frame's raster source+layer here
 * (hidden at opacity 0) and pass it specs whose paint carries the *visible*
 * opacity the control restores when a frame becomes active.
 *
 * https://github.com/mug-jp/maplibre-gl-temporal-control
 */
import TemporalControl from 'maplibre-gl-temporal-control';

let control = null;
let layerIds = [];

export async function enable(map, ctx) {
  if (control) return;

  // Prefer the LOCAL offline radar pack (pipeline/gen_demo_data.py); fall back to
  // the live RainViewer nowcast when online. Both yield the same frame shape, so
  // the layer/control code below is source-agnostic.
  let frames = [];
  try {
    const m = await fetch('data/radar/manifest.json').then(r => { if (!r.ok) throw 0; return r.json(); });
    const base = new URL('data/radar/', location.href).href;
    frames = m.frames.map(fr => ({
      title: (fr.minutes <= 0 ? '' : '+') + fr.minutes + ' min',
      tiles: [`${base}${fr.id}/{z}/{x}/{y}.png`],
      minzoom: m.minzoom, maxzoom: m.maxzoom, attribution: 'Helm offline radar pack',
    }));
  } catch (e) {
    try {
      const index = await fetch('https://api.rainviewer.com/public/weather-maps.json').then(r => r.json());
      const radar = [...(index.radar.past || []), ...(index.radar.nowcast || [])];
      frames = radar.map(f => ({
        title: new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        tiles: [`${index.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`], attribution: 'RainViewer',
      }));
    } catch (e2) {
      ctx.notify('Temporal: no local radar pack and RainViewer unreachable', 'warn');
      return;
    }
  }
  if (!frames.length) { ctx.notify('No radar frames available', 'warn'); return; }

  const temporalFrames = frames.map((fr, i) => {
    const id = `helm-temporal-${i}`;
    const srcId = `${id}-src`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: 'raster', tiles: fr.tiles, tileSize: 256,
        ...(fr.minzoom != null ? { minzoom: fr.minzoom, maxzoom: fr.maxzoom } : {}),
        bounds: ctx.region.bbox, attribution: fr.attribution,
      });
    }
    if (!map.getLayer(id)) {
      // add hidden; the control fades the active frame up to its paint opacity
      map.addLayer({ id, type: 'raster', source: srcId, paint: { 'raster-opacity': 0 } }, ctx.beforeId);
    }
    layerIds.push(id);
    return { title: fr.title, layers: [{ id, type: 'raster', paint: { 'raster-opacity': 0.75 } }] };
  });

  control = new TemporalControl(temporalFrames, { interval: 600, position: 'top-right' });
  map.addControl(control);
  ctx.notify('Temporal control wired to radar frames — press play', 'ok');
}

export function disable(map) {
  if (control) { try { map.removeControl(control); } catch (e) { /* noop */ } control = null; }
  layerIds.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id + '-src')) map.removeSource(id + '-src'); });
  layerIds = [];
}
