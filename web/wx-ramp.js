// wx-ramp.js — single source of truth for weather colour ramps (CLIENT-14).
//
// Before this, the wind ramp lived in THREE non-identical places — WINDY_WIND (index.html),
// LAYERS[*].stops (wx-live.js) and RAMP (wind-layer.js) — so the animated particles and the
// scalar field could paint DIFFERENT colours for the same wind speed. Now every path reads its
// stops from here, so a value maps to one colour everywhere by construction.
//
// `stops` shape matches HelmWxCodec / fetch_weather.py: [[value, [r,g,b]] | [value, [r,g,b,a]], ...].
// Pure + framework-free; self-contained interpolation so it works regardless of script load order.
// Prefers the tile manifest's ramp when one is registered (setManifestRamp), so service tiles,
// particles and the probe converge on whatever the gateway actually baked. Forward-compat for WX-19.
(function (global) {
  'use strict';

  // Canonical Windy-aligned stops per layer (knots / °C / mm / % / hPa / J·kg⁻¹). This IS the
  // wx-live palette — the most graduated, Windy-matched set — now shared by the particles too.
  var RAMPS = {
    wind:     [[0, [98, 113, 183]], [5, [57, 131, 168]], [10, [52, 171, 151]], [16, [123, 183, 80]], [22, [225, 200, 60]], [30, [232, 130, 50]], [40, [214, 70, 74]], [55, [150, 60, 150]]],
    gust:     [[0, [56, 189, 248]], [10, [45, 212, 191]], [20, [250, 204, 21]], [30, [249, 115, 22]], [42, [239, 68, 68]], [60, [217, 33, 154]]],
    rain:     [[0, [80, 160, 220, 0]], [0.2, [90, 180, 255, 0.55]], [2, [40, 120, 235, 0.8]], [6, [120, 90, 235, 0.85]], [15, [175, 60, 200, 0.9]]],
    temp:     [[-10, [70, 90, 200]], [0, [80, 180, 235]], [10, [70, 200, 130]], [20, [245, 205, 60]], [30, [240, 120, 40]], [42, [210, 40, 40]]],
    clouds:   [[0, [150, 170, 190, 0]], [40, [200, 210, 222, 0.4]], [80, [235, 240, 246, 0.75]], [100, [250, 252, 255, 0.9]]],
    pressure: [[980, [120, 80, 200]], [1000, [80, 160, 230]], [1013, [120, 205, 140]], [1025, [240, 200, 80]], [1040, [230, 110, 55]]],
    cape:     [[0, [56, 160, 200, 0]], [300, [120, 200, 120, 0.5]], [1000, [245, 205, 60, 0.8]], [2500, [240, 120, 40, 0.9]], [4000, [220, 40, 40, 0.95]]]
  };

  // Per-layer override registered from a loaded tile manifest (cog.js → setManifestRamp). The
  // gateway's baked ramp wins, so the field tiles, the particles and the probe all match it.
  var overrides = {};

  function stopsFor(layer) { return overrides[layer] || RAMPS[layer] || RAMPS.wind; }

  // Interpolate stops at value v → [r, g, b, a(0..255)]. Identical math to HelmWxCodec.rampColor;
  // kept self-contained so wx-ramp has no load-order dependency (wind-layer loads before the codec).
  function rampColor(layer, v) {
    var stops = stopsFor(layer);
    if (!stops || !stops.length) return [255, 255, 255, 255];
    function out(c) { return [c[0] | 0, c[1] | 0, c[2] | 0, Math.round((c.length > 3 ? c[3] : 1) * 255)]; }
    if (v <= stops[0][0]) return out(stops[0][1]);
    for (var i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], t = (v - a[0]) / ((b[0] - a[0]) || 1), ca = a[1], cb = b[1];
        function lerp(x, y) { return x + (y - x) * t; }
        return [Math.round(lerp(ca[0], cb[0])), Math.round(lerp(ca[1], cb[1])), Math.round(lerp(ca[2], cb[2])),
                Math.round(lerp(ca.length > 3 ? ca[3] : 1, cb.length > 3 ? cb[3] : 1) * 255)];
      }
    }
    return out(stops[stops.length - 1][1]);
  }

  // CSS string for canvas/DOM (particles). Always rgba so layer alpha (rain/clouds/cape) is honoured.
  function rampCss(layer, v) {
    var c = rampColor(layer, v > 0 || v < 0 ? v : 0);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(3) + ')';
  }

  function setManifestRamp(layer, stops) { if (layer && stops && stops.length) overrides[layer] = stops; }
  function clearManifestRamp(layer) { if (layer) delete overrides[layer]; else overrides = {}; }

  global.HelmWxRamp = {
    RAMPS: RAMPS,
    stopsFor: stopsFor,
    rampColor: rampColor,
    rampCss: rampCss,
    setManifestRamp: setManifestRamp,
    clearManifestRamp: clearManifestRamp
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.HelmWxRamp;
})(typeof window !== 'undefined' ? window : this);
