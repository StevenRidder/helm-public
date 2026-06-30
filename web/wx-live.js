// wx-live.js — fetch-on-pan LIVE weather (the Windy-style full-bleed mode).  WX epic · weather-ux.
// ----------------------------------------------------------------------------------------------
// The legacy weather overlay paints one fixed-bbox image around your start point, so zooming out
// shows a tiny rectangle. This mode instead fetches Open-Meteo for WHATEVER IS IN VIEW and repaints
// (debounced) as you pan — so weather fills the screen everywhere you look, the way Windy does.
//
// HONESTY: weather is fetched live; if the network is unreachable (offshore / no link) it surfaces
// a clear notice and renders NOTHING — it never fabricates a field to fill the gap.
// Provenance is always Open-Meteo (named); for offline coverage, bake Tier-2 tiles for your area.
(function () {
  'use strict';
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var SRC = 'helm-wx-live', LYR = 'helm-wx-live';

  // layer -> Open-Meteo current variable + display unit + colour ramp (knots/°C/hPa/… ). Mirrors
  // pipeline/fetch_weather.py so Live and the pipeline agree. Marine layers (waves/swell/sst/current)
  // use a different endpoint and stay on Standard for now.
  var LAYERS = {
    wind:     { v: 'wind_speed_10m', dir: 'wind_direction_10m', vector: true, unit: 'kn' },
    gust:     { v: 'wind_gusts_10m', unit: 'kn' },
    rain:     { v: 'precipitation', unit: 'mm' },
    temp:     { v: 'temperature_2m', unit: '°C' },
    clouds:   { v: 'cloud_cover', unit: '%' },
    pressure: { v: 'pressure_msl', unit: 'hPa' },
    cape:     { v: 'cape', unit: 'J/kg' },
  };
  // Stops come from the single shared ramp (web/wx-ramp.js) -- not a local copy -- so Live and the
  // particles agree by construction (CLIENT-14). Degrade to no-stops if wx-ramp.js is somehow absent.
  Object.keys(LAYERS).forEach(function (k) { if (window.HelmWxRamp) LAYERS[k].stops = HelmWxRamp.stopsFor(k); });
  function supports(layer) { return !!LAYERS[layer]; }

  var st = { map: null, on: false, layer: 'wind', token: 0, field: null, opacity: 0.72, notify: function () {}, onState: null, handler: null, debounce: null, lastKey: '' };

  function codec() { return window.HelmWxCodec; }

  // The grid covers the VIEWPORT + a 50% margin on each side, so the rendered field runs PAST the
  // visible edges (fills the screen with REAL fetched data — not a box, and not a stretched raster).
  function viewBbox(map) {
    var b = map.getBounds(), w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    if (e < w) e += 360;                                   // viewport crosses the antimeridian (Fiji!) — keep lon CONTINUOUS
    var mw = (e - w) * 0.5, mh = (n - s) * 0.5;
    w -= mw; e += mw;
    if (e - w > 90) { var c = (w + e) / 2; w = c - 45; e = c + 45; }  // a 12×12 grid past ~90° is too coarse to be meaningful
    return [w, Math.max(-84, s - mh), e, Math.min(84, n + mh)];        // lon stays continuous (may exceed ±180); wrapped only for the API
  }
  function wrapLon(x) { x = ((x + 180) % 360 + 360) % 360 - 180; return +x.toFixed(4); }
  function covers(field, map) {                            // does the rendered overlay still span the view?
    if (!field) return false;
    var b = map.getBounds();
    return field.west <= b.getWest() && field.east >= b.getEast() && field.south <= b.getSouth() && field.north >= b.getNorth();
  }
  function clearLayer(map) { if (map.getLayer(LYR)) map.removeLayer(LYR); if (map.getSource(SRC)) map.removeSource(SRC); st.field = null; }

  function grid(bbox, nx, ny) {
    var lats = [], lons = [], qlat = [], qlon = [];
    for (var j = 0; j < ny; j++) lats.push(bbox[3] - (bbox[3] - bbox[1]) * j / (ny - 1));
    for (var i = 0; i < nx; i++) lons.push(bbox[0] + (bbox[2] - bbox[0]) * i / (nx - 1));
    for (var a = 0; a < lats.length; a++) for (var c = 0; c < lons.length; c++) { qlat.push(+lats[a].toFixed(4)); qlon.push(+lons[c].toFixed(4)); }
    return { nx: nx, ny: ny, lats: lats, lons: lons, qlat: qlat, qlon: qlon };
  }

  function url(g, layer, model) {
    var L = LAYERS[layer];
    var cur = L.v + (L.dir ? ',' + L.dir : '');             // vector layers also fetch direction (for particles)
    var qlon = g.qlon.map(wrapLon);                         // Open-Meteo wants lon in [-180,180]; the grid may run continuously past the dateline
    var p = 'latitude=' + g.qlat.join(',') + '&longitude=' + qlon.join(',') + '&current=' + cur;
    if (layer === 'wind' || layer === 'gust') p += '&wind_speed_unit=kn';
    if (model && model !== 'gfs_seamless') p += '&models=' + model;
    return FORECAST + '?' + p;
  }

  // Build a leaflet-velocity grid (the format HelmWind.setData/build expects) from speed+direction,
  // so the GPU particle layer fills the viewport. u/v point WHERE THE WIND BLOWS TO (FROM-dir + 180).
  function buildVelocity(nodes, g, L) {
    var us = [], vs = [], D2R = Math.PI / 180;
    for (var k = 0; k < g.qlat.length; k++) {
      var node = Array.isArray(nodes) ? nodes[k] : nodes, c = node && node.current;
      var spd = c && typeof c[L.v] === 'number' ? c[L.v] : 0;
      var dir = c && typeof c[L.dir] === 'number' ? c[L.dir] : 0;
      us.push(-spd * Math.sin(dir * D2R));                  // FROM-direction -> motion vector (negated)
      vs.push(-spd * Math.cos(dir * D2R));
    }
    var hdr = { nx: g.nx, ny: g.ny, lo1: g.lons[0], la1: g.lats[0], lo2: g.lons[g.lons.length - 1],
               la2: g.lats[g.lats.length - 1], dx: (g.lons[g.lons.length - 1] - g.lons[0]) / (g.nx - 1),
               dy: (g.lats[0] - g.lats[g.lats.length - 1]) / (g.ny - 1) };
    return [{ header: Object.assign({ parameterNumber: 2 }, hdr), data: us },
            { header: Object.assign({ parameterNumber: 3 }, hdr), data: vs }];
  }

  // turn Open-Meteo's per-point response into a field-<layer> grid (row-major N->S).
  function toField(nodes, g, layer) {
    var L = LAYERS[layer], vals = [];
    for (var k = 0; k < g.qlat.length; k++) {
      var node = Array.isArray(nodes) ? nodes[k] : nodes;
      var v = node && node.current ? node.current[L.v] : null;
      vals.push(typeof v === 'number' ? v : NaN);
    }
    var valid = vals.filter(function (x) { return isFinite(x); });
    return { layer: layer, unit: L.unit, nx: g.nx, ny: g.ny,
             west: g.lons[0], east: g.lons[g.lons.length - 1], north: g.lats[0], south: g.lats[g.lats.length - 1],
             vmin: valid.length ? Math.min.apply(null, valid) : 0, vmax: valid.length ? Math.max.apply(null, valid) : 1,
             stops: L.stops, values: vals };
  }

  // PUBLIC (also used by tests): colourise a field full-bleed over its bbox as a MapLibre image source.
  function renderField(map, field) {
    var C = codec(); if (!C) return;
    st.field = field;
    var up = 10, W = Math.max(2, (field.nx - 1) * up), H = Math.max(2, (field.ny - 1) * up);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var cx = cv.getContext('2d'), img = cx.createImageData(W, H), d = img.data;
    for (var y = 0; y < H; y++) {
      var fy = y / (H - 1) * (field.ny - 1);
      for (var x = 0; x < W; x++) {
        var fx = x / (W - 1) * (field.nx - 1);
        var v = C.bilinear(field.values, field.nx, field.ny, fx, fy);
        var o = (y * W + x) * 4;
        if (v == null || !isFinite(v)) { d[o + 3] = 0; continue; }
        var col = C.rampColor(field.stops, v);
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = col[3];
      }
    }
    cx.putImageData(img, 0, 0);
    var urlData = cv.toDataURL('image/png');
    var coords = [[field.west, field.north], [field.east, field.north], [field.east, field.south], [field.west, field.south]];
    if (map.getSource(SRC)) {
      map.getSource(SRC).updateImage({ url: urlData, coordinates: coords });
      if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'raster-opacity', st.opacity);
    }
    else {
      map.addSource(SRC, { type: 'image', url: urlData, coordinates: coords });
      map.addLayer({ id: LYR, type: 'raster', source: SRC, paint: { 'raster-opacity': st.opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } },
        map.getLayer('route-line') ? 'route-line' : undefined);
    }
  }

  async function fetchPoints(u) {
    var r = await fetch(u);
    if (r.status === 429) { cooldownUntil = nowMs() + 5 * 60 * 1000; var e = new Error('Open-Meteo hourly limit'); e.code = 429; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---- caching: be a good Open-Meteo client -------------------------------------------------
  // Snap the fetch area to a per-zoom grid so nearby pans/zooms reuse ONE fetch; cache the result
  // (in-memory LRU + localStorage, short TTL) and coalesce concurrent identical fetches. Net effect:
  // you can zoom in/out all day and we only touch the network when you move into a genuinely new area.
  var TILE_TTL = 15 * 60 * 1000;          // a fetched view stays reusable for 15 min (current conditions)
  var TILE_MAX = 120;                     // in-memory LRU cap
  var LS_PREFIX = 'helmwx2:';
  var tiles = new Map();                  // key -> { field, vel, t }
  var inflight = new Map();               // key -> Promise<{field,vel}>  (in-flight dedup)
  var apiCalls = 0;                       // network fetches actually made (for tests / good-citizen check)
  var cooldownUntil = 0;                  // after a 429 we serve cache only until this time — don't hammer Open-Meteo
  function nowMs() { return Date.now(); }

  function zbucket(map) { return Math.round(map.getZoom()); }
  function snapBbox(bb, zb) {
    var step = 360 / Math.pow(2, Math.max(1, Math.min(13, zb)));   // ~one screen-width per cell at this zoom
    var fl = function (x) { return Math.floor(x / step) * step; }, ce = function (x) { return Math.ceil(x / step) * step; };
    return [+fl(bb[0]).toFixed(4), +Math.max(-84, fl(bb[1])).toFixed(4), +ce(bb[2]).toFixed(4), +Math.min(84, ce(bb[3])).toFixed(4)];
  }
  function tileKey(bb, zb, layer, model) { return layer + '|' + (model || 'gfs') + '|z' + zb + '|' + bb.join(','); }

  function getTile(key) {
    var v = tiles.get(key);
    if (v) { if (nowMs() - v.t > TILE_TTL) tiles.delete(key); else return v; }
    try {
      var raw = window.localStorage.getItem(LS_PREFIX + key);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && (nowMs() - o.t) <= TILE_TTL) { var hit = { field: o.field, vel: o.vel, t: o.t }; tiles.set(key, hit); return hit; }
        window.localStorage.removeItem(LS_PREFIX + key);
      }
    } catch (e) {}
    return null;
  }
  function pruneLS() {                     // shed our oldest localStorage rows under quota pressure
    try {
      var ks = [], i, k;
      for (i = 0; i < window.localStorage.length; i++) { k = window.localStorage.key(i); if (k && k.indexOf(LS_PREFIX) === 0) ks.push(k); }
      ks.sort(function (a, b) { try { return (JSON.parse(window.localStorage.getItem(a)).t || 0) - (JSON.parse(window.localStorage.getItem(b)).t || 0); } catch (e) { return 0; } });
      ks.slice(0, Math.ceil(ks.length / 2)).forEach(function (kk) { window.localStorage.removeItem(kk); });
    } catch (e) {}
  }
  function putTile(key, val) {
    var rec = { field: val.field, vel: val.vel, t: nowMs() };
    tiles.set(key, rec);
    if (tiles.size > TILE_MAX) { var oldest = null, ot = Infinity; tiles.forEach(function (v, k) { if (v.t < ot) { ot = v.t; oldest = k; } }); if (oldest) tiles.delete(oldest); }
    try { window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(rec)); }
    catch (e) { pruneLS(); try { window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(rec)); } catch (e2) {} }
  }

  // Best cached tile that fully covers the current view (finest one wins). The graceful fallback when a
  // live fetch fails: show REAL (if slightly stale) weather covering the screen, never the tiny static box.
  function bestCachedFor(map) {
    var b = map.getBounds(), bw = b.getWest(), be = b.getEast(); if (be < bw) be += 360;
    var bs = b.getSouth(), bn = b.getNorth(), best = null, bestArea = Infinity;
    tiles.forEach(function (v) {
      var f = v.field; if (!f || f.layer !== st.layer || (nowMs() - v.t) > TILE_TTL) return;
      if (f.west <= bw && f.east >= be && f.south <= bs && f.north >= bn) {
        var area = (f.east - f.west) * (f.north - f.south); if (area < bestArea) { bestArea = area; best = v; }
      }
    });
    return best;
  }
  // Warm the in-memory cache from localStorage on load, so a reload (even while rate-limited/offline)
  // can still paint real cached weather instead of nothing.
  (function hydrateFromLS() {
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i); if (!k || k.indexOf(LS_PREFIX) !== 0) continue;
        var o = JSON.parse(window.localStorage.getItem(k));
        if (o && (nowMs() - o.t) <= TILE_TTL) tiles.set(k.slice(LS_PREFIX.length), { field: o.field, vel: o.vel, t: o.t });
        else window.localStorage.removeItem(k);
      }
    } catch (e) {}
  })();

  async function doFetch(bb, layer, model) {
    apiCalls++;
    var g = grid(bb, 12, 12);
    var nodes = await fetchPoints(url(g, layer, model === 'gfs_seamless' ? null : model));
    var L = LAYERS[layer], field = toField(nodes, g, layer);
    if (!field.values.some(function (v) { return isFinite(v); })) throw new Error('no data for area');
    return { field: field, vel: L.vector ? buildVelocity(nodes, g, L) : null };
  }

  function applyTile(val) {
    // particlesOnly: the FIELD comes from the helm-wx service tiles (cog.js); wx-live only drives the
    // animated particles. Otherwise (service down / fallback) wx-live paints its own colourised field.
    if (!st.particlesOnly) renderField(st.map, val.field);   // sets st.field + paints over the (snapped) area
    if (window.__helmWind) {
      if (val.vel) { window.__helmWind.setData(val.vel); window.__helmWind.setVisible(true); }
      else window.__helmWind.setVisible(false);   // scalar layers (temp/pressure/…) have no particles
    }
  }

  async function refresh() {
    if (!st.on || !st.map || !supports(st.layer)) return;
    var zb = zbucket(st.map), bb = snapBbox(viewBbox(st.map), zb);
    var key = tileKey(bb, zb, st.layer, st.model);
    if (key === st.lastKey && covers(st.field, st.map)) return;   // same snapped view, still covered -> nothing to do
    st.lastKey = key;
    var my = ++st.token;

    var hit = getTile(key);                 // CACHE HIT -> render instantly, zero network
    if (hit) { applyTile(hit); st.notify('Live ' + st.layer + ' · cached', 'ok'); if (st.onState) st.onState('ok'); return; }

    // Rate-limited recently? Don't hammer Open-Meteo — serve the best cached coverage we have.
    if (nowMs() < cooldownUntil) return serveCachedOrFallback(null, { code: 429 });

    st.notify('Fetching live ' + st.layer + ' for this view …', 'info');
    var p = inflight.get(key);              // coalesce concurrent identical fetches (kills the boot/zoom burst)
    if (!p) {
      p = doFetch(bb, st.layer, st.model).then(function (val) { putTile(key, val); inflight.delete(key); return val; },
                                              function (e) { inflight.delete(key); throw e; });
      inflight.set(key, p);
    }
    try {
      var val = await p;
      if (my !== st.token || !st.on) return; // superseded by a newer view (result is still cached for later)
      applyTile(val);
      st.notify('Live ' + st.layer + ' · Open-Meteo, this view', 'ok');
      if (st.onState) st.onState('ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (my !== st.token || !st.on) return;
      serveCachedOrFallback(e);             // 429 / offline -> cached coverage, not the tiny static box
    }
  }

  // Graceful degradation ladder (shared by cooldown + fetch-failure): keep showing REAL weather over the
  // whole view if we possibly can — a covering cached tile, else the last good render — and only drop to
  // the static local field when we have nothing that covers the screen.
  function serveCachedOrFallback(err) {
    if (!st.map) return;
    var c = bestCachedFor(st.map);
    if (c) {
      applyTile(c);
      st.notify('Live ' + st.layer + (err && err.code === 429 ? ' · cached (Open-Meteo hourly limit — cooling down)' : ' · cached'), 'ok');
      if (st.onState) st.onState('ok');
      return;
    }
    if (covers(st.field, st.map)) { if (st.onState) st.onState('ok'); return; }  // keep the last good Live render
    clearLayer(st.map);
    st.notify(err && err.code === 429
      ? 'Live weather paused — Open-Meteo hourly limit reached; showing your local field.'
      : 'Live weather needs a connection — showing your cached local field.', 'warn');
    if (st.onState) st.onState('offline');
  }

  function onMove() { clearTimeout(st.debounce); st.debounce = setTimeout(function () { refresh().catch(function () {}); }, 450); }

  function enable(map, opts) {
    opts = opts || {};
    st.map = map; st.layer = opts.layer || st.layer; st.model = opts.model || 'gfs_seamless';
    if (opts.opacity != null) setOpacity(map, opts.opacity);
    st.notify = opts.notify || st.notify; st.onState = opts.onState || null; st.on = true; st.lastKey = '';
    st.particlesOnly = !!opts.particlesOnly;             // field handled by helm-wx service tiles; we do particles
    if (st.particlesOnly && st.map) clearLayer(st.map);  // drop any wx-live image; the service layer owns the field
    if (!st.handler) { st.handler = onMove; map.on('moveend', st.handler); }
    refresh().catch(function () {});
  }
  function disable(map) {
    st.on = false;
    if (st.handler) { (map || st.map).off('moveend', st.handler); st.handler = null; }
    var m = map || st.map; if (m) { if (m.getLayer(LYR)) m.removeLayer(LYR); if (m.getSource(SRC)) m.removeSource(SRC); }
    st.field = null; st.lastKey = '';
  }
  function setLayer(layer) { st.layer = layer; st.lastKey = ''; if (st.on) refresh().catch(function () {}); }
  function setModel(model) { st.model = model; st.lastKey = ''; if (st.on) refresh().catch(function () {}); }
  function setOpacity(map, opacity) {
    st.opacity = Math.max(0, Math.min(1, opacity == null ? st.opacity : opacity));
    var m = map || st.map;
    if (m && m.getLayer && m.getLayer(LYR)) m.setPaintProperty(LYR, 'raster-opacity', st.opacity);
  }
  function sampleAt(lat, lon) {
    var f = st.field, C = codec(); if (!f || !C) return null;
    if (lon < f.west || lon > f.east || lat < f.south || lat > f.north) return { value: null, source: 'open', note: 'outside live view' };
    var fx = (lon - f.west) / ((f.east - f.west) || 1) * (f.nx - 1), fy = (f.north - lat) / ((f.north - f.south) || 1) * (f.ny - 1);
    var v = C.bilinear(f.values, f.nx, f.ny, fx, fy);
    return { layer: f.layer, value: (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100, unit: f.unit, source: 'open', sourceRef: { title: 'Open-Meteo (live)' } };
  }

  window.HelmWxLive = { enable: enable, disable: disable, setLayer: setLayer, setModel: setModel, setOpacity: setOpacity, sampleAt: sampleAt, renderField: renderField, supports: supports, _toField: toField, _viewBbox: viewBbox, _grid: grid,
    _stats: function () { return { apiCalls: apiCalls, cached: tiles.size, inflight: inflight.size, cooldown: cooldownUntil > nowMs() }; },
    _snapBbox: snapBbox, _seedTile: function (key, field, vel) { putTile(key, { field: field, vel: vel }); },
    _forceCooldown: function (ms) { cooldownUntil = nowMs() + (ms || 300000); } };
})();
