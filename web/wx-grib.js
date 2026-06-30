// wx-grib.js — WX probe faces for ROUTING-3 / AI-5.  WX epic.
// ----------------------------------------------------------------------------------------------
// The value-encoded / ensemble / import weather UI now lives INSIDE the unified Weather drawer
// (web/wx-controls.js) instead of three standalone rail icons. This file no longer registers a
// panel; it only exposes the deterministic probe faces that the spacetime probe (ROUTING-3) and
// the AI layer-sample faces (AI-5) consume. Rendering + sampling logic lives in integrations/cog.js.
(function () {
  'use strict';
  var cogP = null;
  function cog() { return cogP || (cogP = import('./integrations/cog.js')); }

  // sample(lat, lon, t) -> LayerSample (value-encoded weather tiles). Keep the public probe lat-first.
  window.__helmWxSample = function (lat, lon, t, opts) { return cog().then(function (m) { return m.sampleWx(lat, lon, t, opts); }); };
  // ensemble sample -> { value/mean, spread, agreement, confidence, models, ... }.
  window.__helmWxEnsemble = function (lat, lon, t) { return cog().then(function (m) { return m.sampleEnsemble(lat, lon, t); }); };
})();
