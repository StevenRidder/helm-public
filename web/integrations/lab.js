/*
 * Helm — integrations/lab.js   ·   awesome-maplibre integration lab
 * --------------------------------------------------------------------------
 * Entry module for the "Lab" drawer. Each awesome-maplibre integration lives in
 * its own module under web/integrations/ and is LAZILY imported the first time
 * its toggle is switched on — so a slow/unreachable CDN never blocks page load,
 * and one broken integration can't take down the others.
 *
 * The production tracer-bullet UI (chart/weather/routes/AIS) is untouched; this
 * is a side-by-side surface for feeling each library against real Helm data.
 *
 * Toggle contract: each lazy module exports `enable(map, ctx)` / `disable(map)`
 * (a few action modules export named actions, e.g. draw.route).
 */
(function () {
  'use strict';

  const region = {
    name: 'fiji',                       // OFFLINE: ships the Fiji (Viti Levu) offline pack — see pipeline/fiji.env
    center: [177.4, -17.8],
    bbox: [176.9, -18.3, 178.0, -17.2],
  };

  // ---- lightweight toast so integrations can speak without a console ----
  function notify(msg, kind) {
    let host = document.getElementById('helm-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'helm-toast';
      host.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:20;' +
        'display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none';
      document.body.appendChild(host);
    }
    const colors = { ok: '#46e0a0', warn: '#ffc06a', info: '#5bc0ff' };
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'font:12px/1.3 -apple-system,sans-serif;color:#eef4f9;background:rgba(13,19,27,.86);' +
      'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:.5px solid ' + (colors[kind] || colors.info) + ';' +
      'border-radius:10px;padding:7px 13px;box-shadow:0 18px 60px -24px rgba(0,0,0,.85);opacity:0;' +
      'transform:translateY(8px);transition:opacity .28s ease,transform .34s cubic-bezier(.22,1.1,.36,1)';
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(4px)'; setTimeout(() => el.remove(), 300); }, 4200);
  }

  function ctx() {
    return { maplibregl: window.maplibregl, region, beforeId: 'route-line', notify };
  }

  const map = window.map;
  if (!map) { console.error('[helm-lab] window.map missing'); return; }

  // ---- globe projection (MapLibre v5, in-core — no plugin) ----
  function setGlobe(on) {
    try { map.setProjection({ type: on ? 'globe' : 'mercator' }); notify(on ? 'Globe projection on' : 'Back to mercator', 'info'); }
    catch (e) { notify('Globe needs MapLibre v5+', 'warn'); }
  }

  // ---- lazy module registry: data-lab key -> loader + handlers ----
  const FEATURES = {
    pmtiles:  { mod: () => import('./pmtiles.js'),  on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
    cog:      { mod: () => import('./cog.js'),      on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
    contour:  { mod: () => import('./contour.js'),  on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
    mercator: { mod: () => import('./mercator.js'), on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
    measures: { mod: () => import('./measures.js'), on: (m, c) => m.enable(map),    off: (m) => m.disable(map) },
    temporal: { mod: () => import('./temporal.js'), on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
    ais:      { mod: () => import('./ais-deck.js'), on: (m, c) => m.enable(map, c), off: (m) => m.disable(map) },
  };
  const cache = {};

  async function toggle(key, on) {
    if (key === 'globe') return setGlobe(on);
    if (key === 'draw-route' || key === 'draw-lasso') return drawAction(key);
    const f = FEATURES[key];
    if (!f) return;
    try {
      const m = cache[key] || (cache[key] = await f.mod());
      on ? await f.on(m, ctx()) : f.off(m);
    } catch (e) {
      console.error('[helm-lab]', key, e);
      notify(key + ' failed to load — see console', 'warn');
    }
  }

  // draw is action-based (two buttons), not an on/off layer
  let drawMod = null;
  async function drawAction(which) {
    try {
      drawMod = drawMod || await import('./draw.js');
      which === 'draw-route' ? drawMod.route(map, ctx()) : drawMod.lasso(map, ctx());
    } catch (e) { console.error('[helm-lab] draw', e); notify('Terra Draw failed to load', 'warn'); }
  }

  // ---- wire the Lab drawer controls ----
  function wire() {
    document.querySelectorAll('#drawer-lab input[data-lab]').forEach(cb =>
      cb.addEventListener('change', () => toggle(cb.dataset.lab, cb.checked)));
    document.querySelectorAll('#drawer-lab button[data-lab-action]').forEach(btn =>
      btn.addEventListener('click', () => toggle(btn.dataset.labAction, true)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  // surface a lasso bbox into the Download drawer hint (ties draw -> chart pipeline)
  window.addEventListener('helm:bbox', e => {
    const dl = document.querySelector('#drawer-download .hint');
    if (dl) dl.innerHTML = 'Selected bbox <b>' + e.detail.join(', ') + '</b> — in the native app this drives the on-device tiler. See docs/CHART-PIPELINE.md.';
  });

  console.info('[helm-lab] awesome-maplibre integrations ready');
})();
