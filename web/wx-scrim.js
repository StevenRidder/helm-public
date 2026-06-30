// web/wx-scrim.js — Windy-parity "weather scrim".
// ------------------------------------------------------------------------------------------------
// When a weather overlay (rain / wind / temp / …) is active, gently DIM + DESATURATE the raster
// basemap (the bright Navionics/sat/ENC chart) so the weather layer pops — the way Windy mutes its
// map so precip reads. The chart stays visible underneath; nav overlays (route/AIS/ownship/depth
// vectors) are untouched. Reverts the instant weather is turned Off.
//
// Self-contained: hooks the weather toggle buttons + reconciles to window.__activeWx (the single
// source of truth wx-controls.js maintains). Never dims the weather raster itself. Fail-open.
(function () {
  'use strict';
  // Tuned for "rain pops, chart still legible". brightness-max darkens, saturation mutes the
  // colour competition (chart-blue vs rain-blue), a touch of negative contrast flattens it.
  var DIM  = { 'raster-brightness-max': 0.42, 'raster-saturation': -0.7, 'raster-contrast': -0.12 };
  var NORM = { 'raster-brightness-max': 1,    'raster-saturation': 0,    'raster-contrast': 0 };
  var WX_RASTER = { 'helm-wx-grib': 1, 'helm-radar': 1, 'helm-wx-live': 1 };  // never dim the weather itself

  function setDim(on) {
    var m = window.map;
    if (!m || !m.getStyle) return;
    var layers;
    try { layers = (m.getStyle().layers) || []; } catch (e) { return; }
    layers.forEach(function (l) {
      if (l.type !== 'raster' || WX_RASTER[l.id]) return;
      var p = on ? DIM : NORM;
      Object.keys(p).forEach(function (k) { try { m.setPaintProperty(l.id, k, p[k]); } catch (e) {} });
    });
  }
  function weatherOn() { var a = window.__activeWx; return !!(a && a !== 'off'); }
  function reconcile() { setDim(weatherOn()); }

  function wire() {
    // Every weather toggle button → re-assert after wx-controls applies the change.
    document.querySelectorAll('[data-wx]').forEach(function (b) {
      b.addEventListener('click', function () { setTimeout(reconcile, 240); });
    });
    reconcile();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  document.addEventListener('helm:shell-ready', reconcile);   // map exists by now
  window.HelmWxScrim = { setDim: setDim, reconcile: reconcile };
})();
