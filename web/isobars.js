// HelmIsobars — smooth pressure isobars, the Windy way, client-side off the live field.
//
// Revives the old isolines.js (marching squares + stitch + Chaikin), but fixes the reason it
// was shelved — the 14x14 weather grid was too coarse, so isobars came out jagged. We now
// bilinearly UPSAMPLE + lightly smooth the grid before contouring, and pick the contour
// interval adaptively, so even a near-flat pressure field renders a few clean isobars.
// Regenerated each forecast frame, so it animates with the scrubber. Offline, no worker.
//
//   const iso = HelmIsobars(map, { beforeId: 'route-line' });
//   iso.load('data/field-pressure.json');   // Promise; draws + labels the isobars (hPa)
//   iso.setVisible(true|false);
(function (global) {
  'use strict';
  var SRC = 'helm-isobar', LBL = 'helm-isobar-lbl';

  // marching-squares segments per case (bits: tl=8 tr=4 br=2 bl=1). Edges: T R B Lf.
  var CASES = {
    1: [['Lf', 'B']], 2: [['B', 'R']], 3: [['Lf', 'R']], 4: [['T', 'R']],
    5: [['T', 'Lf'], ['B', 'R']], 6: [['T', 'B']], 7: [['T', 'Lf']],
    8: [['T', 'Lf']], 9: [['T', 'B']], 10: [['T', 'R'], ['B', 'Lf']],
    11: [['T', 'R']], 12: [['Lf', 'R']], 13: [['B', 'R']], 14: [['Lf', 'B']]
  };

  // ---- grid prep: bilinear upsample + light box-blur (smooth the coarse field) ----
  function upsample(field, f) {
    var nx = field.nx, ny = field.ny, v = field.values;
    var NX = (nx - 1) * f + 1, NY = (ny - 1) * f + 1, out = new Float64Array(NX * NY);
    for (var j = 0; j < NY; j++) {
      var gy = j / f, j0 = Math.min(ny - 2, Math.floor(gy)), ty = gy - j0;
      for (var i = 0; i < NX; i++) {
        var gx = i / f, i0 = Math.min(nx - 2, Math.floor(gx)), tx = gx - i0;
        var a = v[j0 * nx + i0], b = v[j0 * nx + i0 + 1], c = v[(j0 + 1) * nx + i0], d = v[(j0 + 1) * nx + i0 + 1];
        out[j * NX + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
    return clone(field, NX, NY, out);
  }
  function blur(field, passes) {
    var nx = field.nx, ny = field.ny, v = field.values;
    for (var p = 0; p < passes; p++) {
      var out = new Float64Array(v.length);
      for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
        var s = 0, n = 0;
        for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
          var jj = j + dj, ii = i + di; if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
          s += v[jj * nx + ii]; n++;
        }
        out[j * nx + i] = s / n;
      }
      v = out;
    }
    return clone(field, nx, ny, v);
  }
  function clone(field, nx, ny, values) {
    return { nx: nx, ny: ny, values: values, west: field.west, east: field.east,
             north: field.north, south: field.south, vmin: field.vmin, vmax: field.vmax, unit: field.unit };
  }
  // contour interval (hPa): smallest "nice" step giving a handful of isobars over the range
  function pickInterval(range) {
    var opts = [0.5, 1, 2, 4, 8, 10, 20, 50];
    for (var k = 0; k < opts.length; k++) if (range / opts[k] <= 7) return opts[k];
    return 100;
  }

  // ---- stitch 2-point segments into continuous polylines ----
  function key(p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); }
  function stitch(segs) {
    var ends = {};
    for (var si = 0; si < segs.length; si++) for (var e = 0; e < 2; e++) {
      var k = key(segs[si][e]); (ends[k] || (ends[k] = [])).push({ si: si, e: e });
    }
    var used = new Array(segs.length), polys = [];
    function grow(poly, fwd) {
      for (;;) {
        var tip = fwd ? poly[poly.length - 1] : poly[0], cands = ends[key(tip)] || [], nx = null;
        for (var c = 0; c < cands.length; c++) if (!used[cands[c].si]) { nx = cands[c]; break; }
        if (!nx) break;
        used[nx.si] = true;
        var other = segs[nx.si][nx.e === 0 ? 1 : 0];
        if (fwd) poly.push(other); else poly.unshift(other);
      }
    }
    for (var s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = true;
      var poly = [segs[s][0], segs[s][1]]; grow(poly, true); grow(poly, false); polys.push(poly);
    }
    return polys;
  }
  // Chaikin corner-cutting -> smooth flowing curves
  function chaikin(pts, iters) {
    for (var it = 0; it < iters; it++) {
      if (pts.length < 3) break;
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      out.push(pts[pts.length - 1]); pts = out;
    }
    return pts;
  }

  function contour(field, interval) {
    var nx = field.nx, ny = field.ny, v = field.values;
    var dx = (field.east - field.west) / (nx - 1), dy = (field.north - field.south) / (ny - 1);
    function lon(gx) { return field.west + gx * dx; }
    function lat(gy) { return field.north - gy * dy; }
    var lines = [], labels = [];
    var lo = Math.ceil(field.vmin / interval) * interval;
    for (var L = lo; L <= field.vmax; L += interval) {
      var segs = [];
      for (var j = 0; j < ny - 1; j++) for (var i = 0; i < nx - 1; i++) {
        var tl = v[j * nx + i], tr = v[j * nx + i + 1], bl = v[(j + 1) * nx + i], br = v[(j + 1) * nx + i + 1];
        var idx = (tl >= L ? 8 : 0) | (tr >= L ? 4 : 0) | (br >= L ? 2 : 0) | (bl >= L ? 1 : 0);
        var cs = CASES[idx]; if (!cs) continue;
        var pt = {
          T: function () { return [lon(i + (L - tl) / (tr - tl || 1e-9)), lat(j)]; },
          B: function () { return [lon(i + (L - bl) / (br - bl || 1e-9)), lat(j + 1)]; },
          Lf: function () { return [lon(i), lat(j + (L - tl) / (bl - tl || 1e-9))]; },
          R: function () { return [lon(i + 1), lat(j + (L - tr) / (br - tr || 1e-9))]; }
        };
        for (var s = 0; s < cs.length; s++) segs.push([pt[cs[s][0]](), pt[cs[s][1]]()]);
      }
      var polys = stitch(segs);
      var lvl = Math.round(L * 10) / 10, major = (Math.round(L) % 4 === 0);
      for (var p = 0; p < polys.length; p++) {
        if (polys[p].length < 3) continue;
        var sm = chaikin(polys[p], 4);
        lines.push({ type: 'Feature', properties: { level: lvl, major: major },
                     geometry: { type: 'LineString', coordinates: sm } });
        if (polys[p].length >= 6) labels.push({ type: 'Feature', properties: { level: lvl },
          geometry: { type: 'Point', coordinates: sm[Math.floor(sm.length / 2)] } });
      }
    }
    return { lines: { type: 'FeatureCollection', features: lines },
             labels: { type: 'FeatureCollection', features: labels } };
  }

  function HelmIsobars(map, opts) {
    if (!(this instanceof HelmIsobars)) return new HelmIsobars(map, opts);
    this.map = map; this.beforeId = (opts && opts.beforeId) || null;
  }
  HelmIsobars.prototype.load = function (url) {
    var self = this;
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (field) {
      if (!field || !field.values) return null;
      var prepped = blur(upsample(field, 6), 2);            // finer grid -> smooth isobars
      var c = contour(prepped, pickInterval(field.vmax - field.vmin)), map = self.map;
      if (map.getSource(SRC)) {
        map.getSource(SRC).setData(c.lines); map.getSource(LBL).setData(c.labels);
        self.setVisible(true);
      } else {
        var before = (self.beforeId && map.getLayer(self.beforeId)) ? self.beforeId : undefined;
        map.addSource(SRC, { type: 'geojson', data: c.lines });
        map.addSource(LBL, { type: 'geojson', data: c.labels });
        map.addLayer({ id: SRC, type: 'line', source: SRC,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': 'rgba(255,255,255,0.7)',
                   'line-width': ['case', ['get', 'major'], 1.4, 0.8], 'line-blur': 0.3 } }, before);
        map.addLayer({ id: LBL, type: 'symbol', source: LBL,
          layout: { 'text-field': ['to-string', ['get', 'level']], 'text-font': ['Noto Sans Regular'],
                    'text-size': 10, 'symbol-placement': 'point', 'text-allow-overlap': false },
          paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(13,19,27,0.85)', 'text-halo-width': 1.2 } }, before);
      }
      return field;
    }).catch(function (e) { console.warn('[HelmIsobars] failed', e && e.message); return null; });
  };
  HelmIsobars.prototype.setVisible = function (v) {
    var vis = v ? 'visible' : 'none';
    if (this.map.getLayer(SRC)) this.map.setLayoutProperty(SRC, 'visibility', vis);
    if (this.map.getLayer(LBL)) this.map.setLayoutProperty(LBL, 'visibility', vis);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = HelmIsobars;
  else global.HelmIsobars = HelmIsobars;
})(typeof window !== 'undefined' ? window : this);
