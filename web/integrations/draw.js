/*
 * Helm — integrations/draw.js   ·   Terra Draw (+ MapLibre adapter)
 * --------------------------------------------------------------------------
 * Two marine jobs, one library:
 *   1. "Draw route"  — sketch/edit a route as a linestring.
 *   2. "Lasso area"  — drag a rectangle; we turn it into a bbox and hand it to
 *      the Download drawer. That IS the "lasso an area -> fetch charts" gesture
 *      from CHART-PIPELINE.md.
 *
 * Terra Draw owns its own GeoJSON source/layers via the adapter, so it sits
 * cleanly beside our style without touching route-line etc.
 *
 * https://github.com/JamesLMilner/terra-draw
 */
import { TerraDraw, TerraDrawLineStringMode, TerraDrawRectangleMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';

let draw = null;

function ensure(map, ctx) {
  if (draw) return draw;
  draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawLineStringMode(),
      new TerraDrawRectangleMode(),
      new TerraDrawSelectMode({
        flags: {
          linestring: { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } },
          rectangle: { feature: { draggable: true } },
        },
      }),
    ],
  });
  draw.start();

  draw.on('finish', (id) => {
    const f = draw.getSnapshot().find(s => s.id === id);
    if (!f) return;
    // A drawn ROUTE (linestring) → send to the engine to persist (navobj.db) + activate. The engine
    // streams the active route geometry back, so we clear the sketch and let the route-line render it.
    if (f.geometry.type === 'LineString') {
      const coords = f.geometry.coordinates || [];
      if (coords.length < 2) return;
      const points = coords.map(p => [p[1], p[0]]);   // [lon,lat] -> [lat,lon]
      const sent = !!(window.__navClient && window.__navClient.send({ t: 'route.create', name: 'Route', points }));
      ctx.notify(sent ? `Route saved — ${points.length} waypoints` : 'Engine not connected — route not saved', sent ? 'ok' : 'warn');
      try { draw.clear(); } catch (e) {}
      try { draw.setMode('select'); } catch (e) {}
      return;
    }
    // A finished rectangle → derive its bbox and publish it to the Download drawer.
    if (f.geometry.type !== 'Polygon') return;
    // Single-box selection: drop any earlier rectangles so only the most-recent box survives.
    // (Without this a redraw stacks boxes on the map even though the panel only uses the latest.)
    try {
      const stale = draw.getSnapshot()
        .filter(s => s.id !== id && s.geometry && s.geometry.type === 'Polygon')
        .map(s => s.id);
      if (stale.length) draw.removeFeatures(stale);
    } catch (e) { /* non-fatal */ }
    const ring = f.geometry.coordinates[0];
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      .map(n => +n.toFixed(4));
    window.__helmBbox = bbox;
    window.dispatchEvent(new CustomEvent('helm:bbox', { detail: bbox }));
    ctx.notify(`Area selected — bbox ${bbox.join(', ')}`, 'ok');
  });
  return draw;
}

export function route(map, ctx) { ensure(map, ctx).setMode('linestring'); ctx.notify('Click to draw a route; double-click to finish', 'info'); }
export function lasso(map, ctx) {
  const d = ensure(map, ctx);
  // Clear any previous selection box so a new lasso REPLACES it (single-box model) — drawing a
  // new box never stacks; to redo, just zoom/pan and drag again.
  try {
    const boxes = d.getSnapshot().filter(s => s.geometry && s.geometry.type === 'Polygon').map(s => s.id);
    if (boxes.length) d.removeFeatures(boxes);
  } catch (e) { /* non-fatal */ }
  d.setMode('rectangle');
  ctx.notify('Drag a box over the area — zoom first; a new box replaces the old one', 'info');
}
export function select(map, ctx) { ensure(map, ctx).setMode('select'); }

export function disable() {
  if (!draw) return;
  try { draw.setMode('select'); } catch (e) { /* already stopped */ }
}
