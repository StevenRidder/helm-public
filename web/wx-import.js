// wx-import.js — DEVICE-LOCAL PredictWind GPX / GRIB import.  WX epic · WX-12.
// ----------------------------------------------------------------------------------------------
// PredictWind has no public API (docs/WEATHER.md): the only path is for the user to EXPORT a GPX
// route / GRIB from their own logged-in PredictWind app and IMPORT the file here. This registers a
// HelmShell panel with a file picker, parses the file ENTIRELY ON-DEVICE (web/wx-grib2.js for GRIB,
// DOMParser for GPX), and overlays it distinctly, labelled honestly as imported.
//
// HONESTY / LICENSE (docs/WEATHER.md, docs/ARCHITECTURE.md): imported PredictWind
// GRIB is ECMWF/AROME/UKMO-derived ("internal use only"), so it is kept **device-local** — it is
// never uploaded, never sent to the engine/backend, never persisted server-side, and is **excluded
// from any cloud-sync/share path**. We hold it only in page memory + map layers (ids helm-wx-import-*)
// and read no PredictWind credentials. The overlay carries a permanent "imported · device-local ·
// not for navigation" label.
(function () {
  'use strict';
  var GPX_SRC = 'helm-wx-import-gpx', GRIB_SRC = 'helm-wx-import-grib';
  var st = { map: null, items: [], gribField: null, notifyFn: null };

  // wind ramp in m/s (GRIB wind is m/s) — Windy-style calm→storm.
  var WIND_MS = [[0, [98, 113, 183]], [3, [57, 131, 168]], [6, [52, 171, 151]], [9, [123, 183, 80]],
                 [12, [225, 200, 60]], [16, [232, 130, 50]], [21, [214, 70, 74]], [28, [150, 60, 150]]];

  function notify(msg, level) { if (st.notifyFn) st.notifyFn(msg, level); }

  // ---- GPX ------------------------------------------------------------------------------------
  function tags(node, name) { return Array.prototype.slice.call(node.getElementsByTagNameNS('*', name)); }
  function nameOf(node) { var t = tags(node, 'name')[0]; return t ? t.textContent.trim() : ''; }
  function parseGpx(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('not valid XML/GPX');
    var feats = [];
    function ll(p) { return [parseFloat(p.getAttribute('lon')), parseFloat(p.getAttribute('lat'))]; }
    tags(doc, 'rte').forEach(function (rte) {
      var pts = tags(rte, 'rtept');
      var coords = pts.map(ll).filter(function (c) { return isFinite(c[0]) && isFinite(c[1]); });
      if (coords.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'route', name: nameOf(rte) || 'route' } });
      pts.forEach(function (p) { var nm = nameOf(p), c = ll(p); if (nm && isFinite(c[0]) && isFinite(c[1])) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'rtept', name: nm } }); });
    });
    tags(doc, 'trk').forEach(function (trk) {
      tags(trk, 'trkseg').forEach(function (seg) {
        var coords = tags(seg, 'trkpt').map(ll).filter(function (c) { return isFinite(c[0]) && isFinite(c[1]); });
        if (coords.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'track', name: nameOf(trk) || 'track' } });
      });
    });
    tags(doc, 'wpt').forEach(function (p) { feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(p) }, properties: { kind: 'wpt', name: nameOf(p) || 'wpt' } }); });
    if (!feats.length) throw new Error('GPX had no routes/tracks/waypoints');
    return { type: 'FeatureCollection', features: feats };
  }

  function renderGpx(fc, label) {
    var map = st.map;
    if (map.getSource(GPX_SRC)) map.getSource(GPX_SRC).setData(fc);
    else {
      map.addSource(GPX_SRC, { type: 'geojson', data: fc, attribution: 'Imported (PredictWind, device-local) — NOT FOR NAVIGATION' });
      map.addLayer({ id: GPX_SRC + '-line', type: 'line', source: GPX_SRC, filter: ['in', ['get', 'kind'], ['literal', ['route', 'track']]],
        paint: { 'line-color': '#c678dd', 'line-width': 3, 'line-dasharray': [2, 1.2] } });
      map.addLayer({ id: GPX_SRC + '-pt', type: 'circle', source: GPX_SRC, filter: ['in', ['get', 'kind'], ['literal', ['rtept', 'wpt']]],
        paint: { 'circle-radius': 4, 'circle-color': '#c678dd', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
      map.addLayer({ id: GPX_SRC + '-label', type: 'symbol', source: GPX_SRC, filter: ['in', ['get', 'kind'], ['literal', ['rtept', 'wpt']]],
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
        paint: { 'text-color': '#e7c6ff', 'text-halo-color': '#10141b', 'text-halo-width': 1.2 } });
    }
    // fit to the imported geometry
    var b = null;
    fc.features.forEach(function (f) {
      var cs = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates;
      cs.forEach(function (c) { b = b ? [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])] : [c[0], c[1], c[0], c[1]]; });
    });
    if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 12, duration: 600 });
    notify('Imported GPX · ' + label + ' (device-local, not synced)', 'ok');
  }

  // ---- GRIB -----------------------------------------------------------------------------------
  function gribToImage(field, W, H) {
    var C = window.HelmWxCodec, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var cx = cv.getContext('2d'), img = cx.createImageData(W, H), d = img.data;
    for (var y = 0; y < H; y++) {
      var fy = y / (H - 1) * (field.ny - 1);
      for (var x = 0; x < W; x++) {
        var fx = x / (W - 1) * (field.nx - 1);
        var v = C.bilinear(field.values, field.nx, field.ny, fx, fy);
        var o = (y * W + x) * 4;
        if (v == null || !isFinite(v)) { d[o + 3] = 0; continue; }   // NODATA -> transparent
        var c = C.rampColor(WIND_MS, v);
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = Math.round(0.78 * 255);
      }
    }
    cx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  function renderGrib(buf, label) {
    var G = window.HelmGrib2; if (!G) { notify('GRIB reader not loaded', 'warn'); return; }
    if (!window.HelmWxCodec) { notify('weather codec not loaded (wx-value-codec.js)', 'warn'); return; }
    var parsed = G.parseGrib2(buf);
    if (!parsed.messages.length) { notify('no GRIB messages found in file', 'warn'); return; }
    // pick the first lat/lon simple-packed message we can render
    var msg = parsed.messages.find(function (m) { return m.values && m.grid; });
    var unsupported = parsed.messages.filter(function (m) { return m.unsupported; }).map(function (m) { return m.unsupported; });
    if (!msg) {
      notify('GRIB header read, but ' + (unsupported[0] || 'no renderable field') + ' — values not shown (never faked)', 'warn');
      return;
    }
    var field = G.messageToField(msg);
    st.gribField = field;
    var W = Math.max(2, (field.nx - 1) * 6), Hh = Math.max(2, (field.ny - 1) * 6);
    var url = gribToImage(field, W, Hh);
    var coords = [[field.west, field.north], [field.east, field.north], [field.east, field.south], [field.west, field.south]];
    var map = st.map;
    if (map.getSource(GRIB_SRC)) map.getSource(GRIB_SRC).updateImage({ url: url, coordinates: coords });
    else {
      // NB: MapLibre `image` sources don't accept `attribution` — the imported/device-local/
      // NOT-FOR-NAVIGATION provenance is carried by the panel notice + status label instead.
      map.addSource(GRIB_SRC, { type: 'image', url: url, coordinates: coords });
      map.addLayer({ id: GRIB_SRC, type: 'raster', source: GRIB_SRC, paint: { 'raster-opacity': 0.78, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } },
        map.getLayer('route-line') ? 'route-line' : undefined);
    }
    map.fitBounds([[field.west, field.south], [field.east, field.north]], { padding: 60, maxZoom: 11, duration: 600 });
    var rng = field.values.filter(function (v) { return isFinite(v); });
    var span = rng.length ? '[' + Math.min.apply(null, rng).toFixed(1) + '–' + Math.max.apply(null, rng).toFixed(1) + ' ' + field.unit + ']'
      : '(no valid data points)';
    notify('Imported GRIB · ' + (field.param || msg.param.name) + ' ' + field.nx + '×' + field.ny + ' ' + span + ' (device-local)' +
      (unsupported.length ? ' · ' + unsupported.length + ' msg(s) unsupported' : ''), 'ok');
  }

  // ---- import dispatch (device-local; the file never leaves the page) -------------------------
  // PUBLIC — importFile(file, map, notifyFn). Called by the unified Weather panel (wx-controls.js).
  function importFile(file, map, notifyFn) {
    st.map = map || window.map; st.notifyFn = notifyFn || st.notifyFn;
    notify('reading ' + file.name + ' …');
    var lower = (file.name || '').toLowerCase();
    var reader = new FileReader();
    reader.onerror = function () { notify('could not read file', 'warn'); };
    if (/\.gpx$/.test(lower)) {
      reader.onload = function () { try { var fc = parseGpx(reader.result); st.items.push({ name: file.name, kind: 'gpx' }); renderGpx(fc, file.name); } catch (e) { notify('GPX error: ' + e.message, 'warn'); } };
      reader.readAsText(file);
    } else {
      // GRIB (or unknown binary): sniff the "GRIB" magic, else try GPX-as-text fallback.
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        if (bytes[0] === 0x47 && bytes[1] === 0x52 && bytes[2] === 0x49 && bytes[3] === 0x42) {
          try { st.items.push({ name: file.name, kind: 'grib' }); renderGrib(reader.result, file.name); } catch (e) { notify('GRIB error: ' + e.message, 'warn'); }
        } else if (bytes[0] === 0x3C) { // '<' -> XML/GPX
          try { var fc = parseGpx(new TextDecoder().decode(bytes)); st.items.push({ name: file.name, kind: 'gpx' }); renderGpx(fc, file.name); } catch (e) { notify('GPX error: ' + e.message, 'warn'); }
        } else { notify('unrecognised file — expected a PredictWind .gpx or .grib', 'warn'); }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function removeAll(map) {
    var m = map || st.map; if (!m) return;
    [GPX_SRC + '-line', GPX_SRC + '-pt', GPX_SRC + '-label', GRIB_SRC].forEach(function (id) { if (m.getLayer(id)) m.removeLayer(id); });
    [GPX_SRC, GRIB_SRC].forEach(function (id) { if (m.getSource(id)) m.removeSource(id); });
    st.items = []; st.gribField = null; notify('imports cleared');
  }

  // PUBLIC engine for wx-controls.js (no rail icon / panel of its own anymore).
  window.HelmImport = { importFile: importFile, removeAll: removeAll, items: function () { return st.items.slice(); } };

  // Sample the imported GRIB at a point (device-local probe). Honest provenance: source 'imported',
  // deviceLocal + notForNavigation true; null outside coverage.
  window.__helmImportSample = function (lat, lon) {
    var f = st.gribField, C = window.HelmWxCodec; if (!f || !C) return null;
    if (lon < f.west || lon > f.east || lat < f.south || lat > f.north)
      return { value: null, source: 'imported', deviceLocal: true, notForNavigation: true, note: 'outside imported coverage' };
    var fx = (lon - f.west) / ((f.east - f.west) || 1) * (f.nx - 1);
    var fy = (f.north - lat) / ((f.north - f.south) || 1) * (f.ny - 1);
    var v = C.bilinear(f.values, f.nx, f.ny, fx, fy);
    return { layer: f.param, value: (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100, unit: f.unit,
             source: 'imported', sourceRef: { title: 'PredictWind import (device-local)' }, deviceLocal: true,
             notForNavigation: true, note: (v == null || !isFinite(v)) ? 'no data here — verify locally' : undefined };
  };
})();
