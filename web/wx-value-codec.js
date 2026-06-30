// wx-value-codec.js — the VALUE-ENCODED (Mercator) weather-tile contract.  WX epic · WX-10.
// ----------------------------------------------------------------------------------------------
// Helm's Tier-2 weather is served as VALUE-ENCODED Web-Mercator XYZ raster tiles: each pixel's
// RGB encodes a real physical measurement (wind kn, MSLP hPa, °C, mm, …), with the alpha channel
// as a NODATA mask. The value is decoded + colourised CLIENT-SIDE (see web/integrations/cog.js),
// so the SAME tile drives both the heatmap render AND a deterministic sample(lat,lon,t) probe —
// which is exactly what the spacetime probe (ROUTING-3) and the AI sample() faces (AI-5) consume.
// This replaces the fixed-bbox `field-*.json` blob (web/field-layer.js) with a pan/zoomable pyramid.
//
// This module is the ONE place the encoding is defined. The Python baker (pipeline/make_value_tiles.py)
// mirrors `encodeValue`/the tile math byte-for-byte; the browser renderer imports `decodeRGBA`/
// `rampColor`/`sample*` from here. Pure, shell-free, framework-free, node + browser. Self-tested:
//   node web/wx-value-codec.js --test
//
// ENCODING  "helm-wxv1"  (24-bit value + 8-bit NODATA mask, the Mapbox/Mercator terrain-RGB family):
//   n      = clamp(round((value - offset) / scale), 0, 0xFFFFFF)
//   R,G,B  = (n>>16)&255, (n>>8)&255, n&255       A = 255 (valid)  |  A = 0 (NODATA)
//   value  = offset + ((R<<16)|(G<<8)|B) * scale  (only when A >= 128, else NO DATA)
//   `scale`/`offset` are per-LAYER (constant across all time frames so values + colours are
//   comparable along the scrubber) and carried in the tile-set manifest.json — never hardcoded.
//   NODATA (A=0) means "no value here" (land for an ocean-only layer, gap in coverage): it is
//   rendered transparent and sampled as null — Helm never fakes a value to fill a gap.
(function (root) {
  'use strict';

  var ENCODING = 'helm-wxv1';
  var VMAX24 = 0xFFFFFF;              // 16 777 215 levels — effectively lossless for display + probe
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---- value <-> RGBA -------------------------------------------------------------------------
  // Derive a (scale, offset) that maps [min,max] onto the full 24-bit range at maximum resolution.
  // A degenerate (flat) field collapses to scale=1 so decode still round-trips the constant.
  function scaleOffset(min, max) {
    if (!num(min) || !num(max) || max <= min) return { scale: 1, offset: num(min) ? min : 0 };
    return { scale: (max - min) / VMAX24, offset: min };
  }

  // value -> [r,g,b,a]. Pass nodata=true (or a non-finite value) to emit the transparent NODATA pixel.
  function encodeValue(value, scale, offset, nodata) {
    if (nodata || !num(value)) return [0, 0, 0, 0];
    var s = num(scale) && scale > 0 ? scale : 1;
    var n = clamp(Math.round((value - offset) / s), 0, VMAX24);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }

  // [r,g,b,a] -> value, or null for NODATA. (a<128 == NODATA so partial-coverage edge antialiasing
  // never decodes a half-transparent pixel into a real reading.)
  function decodeRGBA(r, g, b, a, scale, offset) {
    if (a < 128) return null;
    var s = num(scale) && scale > 0 ? scale : 1;
    return offset + ((r << 16) | (g << 8) | b) * s;
  }

  // ---- colour ramp ----------------------------------------------------------------------------
  // Interpolate a Windy-style colour ramp `stops = [[value,[r,g,b(,a)]], ...]` (same shape as
  // field-layer.js / fetch_weather.py). Returns [r,g,b,a(0..255)]. Mirrors field-layer.colorAt.
  function rampColor(stops, v) {
    if (!stops || !stops.length) return [255, 255, 255, 255];
    function out(c) { return [c[0] | 0, c[1] | 0, c[2] | 0, Math.round((c.length > 3 ? c[3] : 1) * 255)]; }
    if (v <= stops[0][0]) return out(stops[0][1]);
    for (var i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], t = (v - a[0]) / ((b[0] - a[0]) || 1);
        var ca = a[1], cb = b[1];
        function lerp(x, y) { return x + (y - x) * t; }
        return [Math.round(lerp(ca[0], cb[0])), Math.round(lerp(ca[1], cb[1])), Math.round(lerp(ca[2], cb[2])),
                Math.round(lerp(ca.length > 3 ? ca[3] : 1, cb.length > 3 ? cb[3] : 1) * 255)];
      }
    }
    return out(stops[stops.length - 1][1]);
  }

  // ---- Web-Mercator slippy-tile math (mirrors pipeline/gen_demo_data.py exactly) ---------------
  function lonLatToTile(lon, lat, z) {
    var n = Math.pow(2, z);
    var x = (lon + 180) / 360 * n;
    var lr = lat * D2R;
    var y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
    return { x: x, y: y };
  }
  function tilePixelToLonLat(z, xt, yt, px, py, size) {
    size = size || 256;
    var n = Math.pow(2, z);
    var x = xt + px / size, y = yt + py / size;
    return { lon: x / n * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * R2D };
  }
  function tilesForBbox(z, bbox) {                 // bbox = [west, south, east, north]
    var a = lonLatToTile(bbox[0], bbox[1], z), b = lonLatToTile(bbox[2], bbox[3], z);
    var out = [];
    for (var x = Math.floor(a.x); x <= Math.floor(b.x); x++)
      for (var y = Math.floor(b.y); y <= Math.floor(a.y); y++) out.push({ z: z, x: x, y: y });
    return out;
  }
  // Map a lon/lat to the tile + fractional pixel within it at zoom z (for sampling a value tile).
  function lonLatToPixel(lon, lat, z, size) {
    size = size || 256;
    var t = lonLatToTile(lon, lat, z);
    var xt = Math.floor(t.x), yt = Math.floor(t.y);
    return { z: z, x: xt, y: yt, px: (t.x - xt) * size, py: (t.y - yt) * size };
  }

  // ---- sampling helpers -----------------------------------------------------------------------
  // Bilinear-interpolate a flat row-major grid (nx*ny) at fractional (fx,fy). NODATA-aware: any
  // corner being null collapses to nearest-valid; all-null returns null (honest gap, no fake fill).
  function bilinear(grid, nx, ny, fx, fy) {
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1);
    x0 = clamp(x0, 0, nx - 1); y0 = clamp(y0, 0, ny - 1);
    var gx = fx - x0, gy = fy - y0;
    var v00 = grid[y0 * nx + x0], v10 = grid[y0 * nx + x1];
    var v01 = grid[y1 * nx + x0], v11 = grid[y1 * nx + x1];
    var any = [v00, v10, v01, v11].filter(function (v) { return v != null && isFinite(v); });
    if (!any.length) return null;
    if (any.length < 4) {                          // edge of coverage — nearest valid, don't invent
      var best = null, bd = Infinity, cs = [[v00, x0, y0], [v10, x1, y0], [v01, x0, y1], [v11, x1, y1]];
      for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (c[0] == null || !isFinite(c[0])) continue;
        var d = Math.hypot(c[1] - fx, c[2] - fy); if (d < bd) { bd = d; best = c[0]; } }
      return best;
    }
    function L(a, b, t) { return a + (b - a) * t; }
    return L(L(v00, v10, gx), L(v01, v11, gx), gy);
  }

  // Choose the integer zoom to sample a value-tile set at (clamped to its [minzoom,maxzoom]).
  function sampleZoom(manifest, z) {
    var lo = manifest && num(manifest.minzoom) ? manifest.minzoom : 0;
    var hi = manifest && num(manifest.maxzoom) ? manifest.maxzoom : 14;
    return Math.round(clamp(num(z) ? z : hi, lo, hi));
  }

  // Pick the frame index whose validTime is nearest an ISO time `t` (or 0 if single-frame/no match).
  function pickFrame(times, t) {
    if (!Array.isArray(times) || !times.length) return 0;
    if (!t) return 0;
    var target = Date.parse(t.length <= 19 && t.indexOf('Z') < 0 ? t + 'Z' : t);
    if (!isFinite(target)) return 0;
    var best = 0, bd = Infinity;
    for (var i = 0; i < times.length; i++) {
      var ti = times[i]; var ms = Date.parse(ti && ti.length <= 19 && ti.indexOf('Z') < 0 ? ti + 'Z' : ti);
      if (!isFinite(ms)) continue;
      var d = Math.abs(ms - target); if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  var api = {
    ENCODING: ENCODING, VMAX24: VMAX24,
    scaleOffset: scaleOffset, encodeValue: encodeValue, decodeRGBA: decodeRGBA,
    rampColor: rampColor,
    lonLatToTile: lonLatToTile, tilePixelToLonLat: tilePixelToLonLat,
    tilesForBbox: tilesForBbox, lonLatToPixel: lonLatToPixel,
    bilinear: bilinear, sampleZoom: sampleZoom, pickFrame: pickFrame, clamp: clamp
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node / tests / cog.js import
  root.HelmWxCodec = api;                                                       // browser global
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));


// ---- self-test: `node web/wx-value-codec.js --test` -----------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  var C = module.exports, fails = 0;
  function ok(cond, msg) { if (cond) console.log('  ok   ', msg); else { fails++; console.log('  FAIL ', msg); } }
  function near(a, b, eps, msg) { var d = Math.abs(a - b); if (d <= eps) console.log('  ok   ', msg, '=', a);
    else { fails++; console.log('  FAIL ', msg, '=> got', a, 'want', b, '(d=' + d + ')'); } }

  // 1) encode -> decode round-trips across a layer's range to well under display resolution.
  var so = C.scaleOffset(980, 1040);                         // MSLP hPa
  ok(so.offset === 980 && so.scale > 0, 'scaleOffset: offset=min, scale>0');
  [980, 1000, 1013.2, 1025.7, 1040].forEach(function (v) {
    var p = C.encodeValue(v, so.scale, so.offset);
    var d = C.decodeRGBA(p[0], p[1], p[2], p[3], so.scale, so.offset);
    near(d, v, 0.001, 'roundtrip ' + v + ' hPa');
  });
  // 2) NODATA pixel decodes to null (never a fake value).
  var nd = C.encodeValue(0, so.scale, so.offset, true);
  ok(nd[3] === 0, 'NODATA encodes alpha=0');
  ok(C.decodeRGBA(nd[0], nd[1], nd[2], nd[3], so.scale, so.offset) === null, 'NODATA decodes to null');
  ok(C.decodeRGBA(255, 255, 255, 0, so.scale, so.offset) === null, 'alpha<128 => null even with RGB set');
  // 3) non-finite value -> NODATA (honest gap).
  ok(C.encodeValue(NaN, so.scale, so.offset)[3] === 0, 'NaN value -> NODATA');
  // 4) clamping at the ends never wraps.
  ok(C.encodeValue(2000, so.scale, so.offset)[0] === 255, 'over-range clamps high (R=255)');
  ok(JSON.stringify(C.encodeValue(-5, so.scale, so.offset).slice(0, 3)) === '[0,0,0]', 'under-range clamps low');
  // 5) tile math parity with the python baker (z, a known lon/lat).
  var t = C.lonLatToTile(177.4, -17.7, 10);
  var inv = C.tilePixelToLonLat(10, Math.floor(t.x), Math.floor(t.y), (t.x - Math.floor(t.x)) * 256, (t.y - Math.floor(t.y)) * 256);
  near(inv.lon, 177.4, 1e-6, 'tile<->pixel lon round-trip');
  near(inv.lat, -17.7, 1e-6, 'tile<->pixel lat round-trip');
  ok(C.tilesForBbox(8, [175.9, -19.2, 178.9, -16.2]).length >= 1, 'tilesForBbox covers the Fiji demo bbox');
  // 6) ramp colour interpolates and carries alpha.
  var stops = [[0, [56, 189, 248]], [16, [250, 204, 21]], [48, [217, 33, 154]]];
  var c = C.rampColor(stops, 8); ok(c.length === 4 && c[3] === 255, 'rampColor returns rgba with alpha');
  ok(C.rampColor([[0, [0, 0, 0, 0]], [10, [0, 0, 0, 1]]], 5)[3] === 128, 'rampColor interpolates stop alpha');
  // 7) bilinear is NODATA-aware.
  near(C.bilinear([0, 10, 0, 10], 2, 2, 0.5, 0), 5, 1e-9, 'bilinear midpoint');
  ok(C.bilinear([null, null, null, null], 2, 2, 0.5, 0.5) === null, 'all-NODATA grid -> null');
  near(C.bilinear([5, null, null, null], 2, 2, 0.1, 0.1), 5, 1e-9, 'partial coverage -> nearest valid');
  // 8) frame picking by nearest valid-time.
  var times = ['2026-06-25T00:00', '2026-06-25T06:00', '2026-06-25T12:00'];
  ok(C.pickFrame(times, '2026-06-25T05:00') === 1, 'pickFrame nearest = 06:00');
  ok(C.pickFrame(times, null) === 0, 'pickFrame default = 0');

  console.log(fails ? ('\nWX-CODEC TESTS: ' + fails + ' FAILED') : '\nWX-CODEC TESTS: all passed');
  process.exit(fails ? 1 : 0);
}
