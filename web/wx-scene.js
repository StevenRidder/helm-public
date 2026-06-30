// wx-scene.js — WX-19 Environmental Scene renderer.  Phase 1: scalar field from the WX-17/18 bundle.
// ------------------------------------------------------------------------------------------------
// Replaces the old per-renderer soup (field-layer/wx-live/cog image paths) with ONE scene that reads
// the prepared model-run bundle (helm.env.bundle.v1).
//
// CONTRACT-ONLY COUPLING — this is why the planned Python->C++ backend port is invisible here:
//   • we read the prepared-bundle MANIFEST and use ITS urlTemplates / lod / ramp / coverage — we
//     hardcode no endpoint paths and no provider behaviour;
//   • tiles are helm-wxv1 value rasters decoded by HelmWxCodec and coloured by HelmWxRamp (CLIENT-14,
//     so field + particles + probe agree by construction; the manifest ramp wins via setManifestRamp);
//   • LOD / overzoom / parent-fallback / no-blank-edge come from the raster source's min/maxzoom
//     (CLIENT-22 discipline) — MapLibre scales prepared parent/native tiles, never blanks inside coverage;
//   • NO upstream fetch on the gesture path: we only ever GET prepared bundle tiles (the gateway stamps
//     X-Helm-Upstream-Fetch: 0). Materialize/refresh is the gateway's job, not the renderer's.
//
// Phase 2 adds vector particles (wind/current) from the same bundle uv tiles; phase 3 adds time
// interpolation + last-good + stale/missing + probe; phase 4 swaps in the WebGPU render path.
(function (global) {
  'use strict';

  var PROTO = 'helmscene';                      // helmscene://<sceneKey>/{z}/{x}/{y}
  var SRC = 'helm-wx-scene', LYR = 'helm-wx-scene';
  var DEFAULT_SVC = (typeof location !== 'undefined') ? (location.protocol + '//' + location.hostname + ':8093') : '';
  var log = (global.HelmLog && HelmLog.scope) ? HelmLog.scope('wx-scene') : console;

  var scenes = {};          // sceneKey -> { template (abs url with {z}/{x}/{y}), layer, scale, offset }
  var protoBound = false;
  var bmpWarned = false;
  var state = { map: null, region: null, layer: null, validTimeId: null, manifest: null, opacity: 0.82, blend: null, lastGoodServe: 0 };

  function svc() { return global.HELM_WX_SERVICE || DEFAULT_SVC; }
  function codec() { return global.HelmWxCodec; }
  function ramp() { return global.HelmWxRamp; }

  // ---- canvas + degrade-safe transparent fallback (mirrors the cog.js createImageBitmap fix) ------
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  var _blankP = null;
  function transparentBitmap() {                // 1x1 transparent -> MapLibre keeps the parent tile (no blank)
    if (!_blankP) { try { _blankP = createImageBitmap(makeCanvas(1, 1)); } catch (e) { _blankP = Promise.reject(e); } }
    return _blankP.then(function (b) { return { data: b }; }, function () { return { data: new Uint8Array() }; });
  }
  function bmpFail(e) {
    if (bmpWarned) return; bmpWarned = true;
    (log.warn || console.warn).call(log, '[wx-scene] tile colourise failed; transparent fallback: ' + ((e && e.message) || e));
  }

  // ---- helm-wxv1 value tile -> colourised ImageBitmap (decode + shared ramp) ----------------------
  // WebGPU path (phase 4) decodes + colourises on the GPU when available; else the CPU path. Either
  // way MapLibre composites the colourised raster (correct z-order under chart symbols + per-tile LOD).
  function rampDomain(layer) {
    var R = ramp(), st = (R && R.stopsFor) ? R.stopsFor(layer) : null;
    if (!st || !st.length) return [0, 1];
    return [st[0][0], st[st.length - 1][0]];
  }
  function useGPU() { return global.HELM_WX_WEBGPU !== false && global.HelmWxSceneGPU && global.HelmWxSceneGPU.supported(); }

  function colorizeCPU(img, layer, scale, offset) {
    var w = img.width || 256, h = img.height || 256;
    var cv = makeCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    var src;
    try { src = ctx.getImageData(0, 0, w, h); } catch (e) { return transparentBitmap(); }
    var out = ctx.createImageData(w, h), sd = src.data, od = out.data, C = codec(), R = ramp();
    for (var i = 0; i < sd.length; i += 4) {
      var v = C.decodeRGBA(sd[i], sd[i + 1], sd[i + 2], sd[i + 3], scale, offset);
      if (v == null) { od[i + 3] = 0; continue; }        // NODATA -> transparent (honest gap, never invented)
      var c = R.rampColor(layer, v);
      od[i] = c[0]; od[i + 1] = c[1]; od[i + 2] = c[2]; od[i + 3] = c[3];
    }
    ctx.putImageData(out, 0, 0);
    return createImageBitmap(cv).then(function (bmp) { return { data: bmp }; });
  }

  function colorize(buf, layer, scale, offset) {
    return createImageBitmap(new Blob([buf], { type: 'image/png' })).then(function (img) {
      var w = img.width || 256, h = img.height || 256;
      if (!w || !h) return transparentBitmap();
      if (useGPU()) {
        var rng = rampDomain(layer);
        return global.HelmWxSceneGPU.colorizeBitmap(img, layer, scale, offset, rng[0], rng[1])
          .then(function (bmp) { if (img.close) try { img.close(); } catch (e) {} return { data: bmp }; })
          .catch(function () { return colorizeCPU(img, layer, scale, offset); });   // GPU failed -> CPU path
      }
      var r = colorizeCPU(img, layer, scale, offset);
      if (img.close) try { img.close(); } catch (e) {}
      return r;
    });
  }

  // ---- WX-23: two-frame value interpolation (CPU fallback path) -----------------------------------
  // Per-pixel: lerp the decoded VALUE of frame A and frame B by frac, then ramp. NODATA-honest:
  // one frame nodata -> use the other; both nodata -> transparent (never invent a value).
  function colorizeCPUPair(imgA, imgB, frac, layer, scale, offset) {
    var w = imgA.width || 256, h = imgA.height || 256;
    var ca = makeCanvas(w, h), cxa = ca.getContext('2d', { willReadFrequently: true }); cxa.drawImage(imgA, 0, 0);
    var cb = makeCanvas(w, h), cxb = cb.getContext('2d', { willReadFrequently: true }); cxb.drawImage(imgB, 0, 0);
    var sa, sb;
    try { sa = cxa.getImageData(0, 0, w, h); sb = cxb.getImageData(0, 0, w, h); } catch (e) { return transparentBitmap(); }
    var out = cxa.createImageData(w, h), da = sa.data, db = sb.data, od = out.data, C = codec(), R = ramp();
    for (var i = 0; i < da.length; i += 4) {
      var va = C.decodeRGBA(da[i], da[i + 1], da[i + 2], da[i + 3], scale, offset);
      var vb = C.decodeRGBA(db[i], db[i + 1], db[i + 2], db[i + 3], scale, offset);
      var v;
      if (va != null && vb != null) v = va + (vb - va) * frac;     // both -> lerp the value
      else if (va != null) v = va;                                 // B nodata -> A
      else if (vb != null) v = vb;                                 // A nodata -> B
      else { od[i + 3] = 0; continue; }                            // both nodata -> transparent
      var c = R.rampColor(layer, v);
      od[i] = c[0]; od[i + 1] = c[1]; od[i + 2] = c[2]; od[i + 3] = c[3];
    }
    cxa.putImageData(out, 0, 0);
    return createImageBitmap(ca).then(function (bmp) { return { data: bmp }; });
  }

  function colorizePair(bufA, bufB, frac, layer, scale, offset) {
    return Promise.all([
      createImageBitmap(new Blob([bufA], { type: 'image/png' })),
      createImageBitmap(new Blob([bufB], { type: 'image/png' }))
    ]).then(function (imgs) {
      var imgA = imgs[0], imgB = imgs[1], w = imgA.width || 256, h = imgA.height || 256;
      if (!w || !h) return transparentBitmap();
      function done(img) { if (img.close) try { img.close(); } catch (e) {} }
      if (useGPU()) {
        var rng = rampDomain(layer);
        return global.HelmWxSceneGPU.colorizeBitmapPair(imgA, imgB, frac, layer, scale, offset, rng[0], rng[1])
          .then(function (bmp) { done(imgA); done(imgB); return { data: bmp }; })
          .catch(function () { return colorizeCPUPair(imgA, imgB, frac, layer, scale, offset); });
      }
      var r = colorizeCPUPair(imgA, imgB, frac, layer, scale, offset);
      done(imgA); done(imgB);
      return r;
    });
  }

  // ---- WX-24: last-good textures (serve-stale, never blank on frame-change / missing-or-empty tile) ----
  // Cache the value-tile bytes that last rendered WITH DATA, keyed per (layer, z/x/y) — frame-independent.
  // When a new frame's tile is missing (404) or carries no data (empty / not-yet-ready), re-colourise the
  // held bytes instead of flashing blank, and flag the scene stale (honest: shown WITH a "last-good" badge,
  // never silently). Bounded LRU. hasData() is only consulted on a REVISIT (a held tile exists), so
  // first-load tiles pay no extra decode.
  var lastGood = {}, lastGoodOrder = [], LASTGOOD_CAP = 600, lgBadgeTimer = null;
  function cacheGood(key, buf) {
    if (!lastGood[key]) lastGoodOrder.push(key);
    lastGood[key] = { buf: buf, at: Date.now() };
    while (lastGoodOrder.length > LASTGOOD_CAP) { var old = lastGoodOrder.shift(); if (old !== key) delete lastGood[old]; }
  }
  function markLastGoodServe() {
    state.lastGoodServe = Date.now();
    if (lgBadgeTimer) return;
    lgBadgeTimer = setTimeout(function () { lgBadgeTimer = null; try { renderStatusBadge(); } catch (e) {} }, 150);
  }
  function hasData(buf) {                       // helm-wxv1 NODATA = alpha < 128; does any pixel carry data?
    return createImageBitmap(new Blob([buf], { type: 'image/png' })).then(function (img) {
      var w = img.width || 256, h = img.height || 256, cv = makeCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0); if (img.close) try { img.close(); } catch (e) {}
      var d; try { d = cx.getImageData(0, 0, w, h).data; } catch (e) { return true; }
      for (var i = 3; i < d.length; i += 4) if (d[i] >= 128) return true;
      return false;
    }).catch(function () { return true; });     // can't inspect -> assume data (never falsely hold)
  }

  // ---- custom protocol handler: MapLibre substitutes {z}/{x}/{y}, then calls us per tile -----------
  function tileHandler(params, abortController) {
    var rest = params.url.slice((PROTO + '://').length);
    var m = rest.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) return transparentBitmap();
    var sc = scenes[m[1]];
    if (!sc) return transparentBitmap();
    var signal = abortController && abortController.signal;
    var key = sc.layer + '|' + m[2] + '/' + m[3] + '/' + m[4];   // WX-24: frame-independent tile key for last-good
    function holdOrTransparent() {                               // hold last-good (stale) instead of a blank flash
      if (lastGood[key]) { markLastGoodServe(); return colorize(lastGood[key].buf, sc.layer, sc.scale, sc.offset).catch(function (e) { bmpFail(e); return transparentBitmap(); }); }
      return transparentBitmap();
    }
    function renderFresh(buf) { cacheGood(key, buf); return colorize(buf, sc.layer, sc.scale, sc.offset).catch(function (e) { bmpFail(e); return transparentBitmap(); }); }
    if (sc.pair) {                                          // WX-23: time-interpolated blend of two frames
      var ua = sc.templateA.replace('{z}', m[2]).replace('{x}', m[3]).replace('{y}', m[4]);
      var ub = sc.templateB.replace('{z}', m[2]).replace('{x}', m[3]).replace('{y}', m[4]);
      var grab = function (u) {
        return fetch(u, { signal: signal }).then(function (r) {
          if (r.status === 404) return null;                // missing frame tile -> null
          if (!r.ok) throw new Error('wx-scene tile HTTP ' + r.status);
          return r.arrayBuffer();
        });
      };
      return Promise.all([grab(ua), grab(ub)]).then(function (bufs) {
        var ba = bufs[0], bb = bufs[1];
        if (!ba && !bb) return holdOrTransparent();                                   // both frames' tiles missing
        if (!lastGood[key]) {                                                         // first sighting -> render + cache
          if (ba && bb) { cacheGood(key, ba); return colorizePair(ba, bb, sc.frac, sc.layer, sc.scale, sc.offset).catch(function (e) { bmpFail(e); return transparentBitmap(); }); }
          return renderFresh(ba || bb);
        }
        return Promise.all([ba ? hasData(ba) : Promise.resolve(false), bb ? hasData(bb) : Promise.resolve(false)]).then(function (hd) {
          if (!hd[0] && !hd[1]) return holdOrTransparent();                           // new frames carry no data here -> hold last-good
          if (hd[0] && hd[1]) { cacheGood(key, ba); return colorizePair(ba, bb, sc.frac, sc.layer, sc.scale, sc.offset).catch(function (e) { bmpFail(e); return transparentBitmap(); }); }
          return renderFresh(hd[0] ? ba : bb);                                        // only one side has data
        });
      });
    }
    var url = sc.template.replace('{z}', m[2]).replace('{x}', m[3]).replace('{y}', m[4]);
    return fetch(url, { signal: signal }).then(function (r) {
      if (r.status === 404) return holdOrTransparent();                               // missing tile -> hold last-good / parent
      if (!r.ok) throw new Error('wx-scene tile HTTP ' + r.status);
      return r.arrayBuffer().then(function (buf) {
        if (!lastGood[key]) return renderFresh(buf);                                  // first sighting
        return hasData(buf).then(function (has) { return has ? renderFresh(buf) : holdOrTransparent(); });
      });
    });
  }
  function ensureProtocol() {
    if (protoBound || !global.maplibregl || !maplibregl.addProtocol) return;
    try { maplibregl.addProtocol(PROTO, tileHandler); } catch (e) { if (!/already|exist|regist/i.test(String(e && e.message))) throw e; }
    protoBound = true;
  }

  // ---- manifest: the renderer's source of truth (drives URLs/LOD/ramp/coverage; port-agnostic) -----
  function manifestUrl(region) { return svc() + '/bundles/open-meteo/latest/' + encodeURIComponent(region) + '/manifest.json'; }
  function loadManifest(region) {
    return fetch(manifestUrl(region), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('bundle manifest HTTP ' + r.status + ' — materialize region "' + region + '" first');
      return r.json();
    });
  }
  function layerCfg(manifest, layer) { return (manifest && manifest.layers && manifest.layers[layer]) || {}; }
  function frameId(manifest, isoTime) {
    var map = (manifest && manifest.run && manifest.run.frameIdByValidTime) || {};
    if (isoTime && map[isoTime]) return map[isoTime];
    var ids = Object.keys(map).map(function (k) { return map[k]; });
    return ids.length ? ids[0] : 'latest';
  }
  // WX-23: ordered valid-time list (ISO8601 sorts chronologically). Prefer the explicit run.validTimes
  // array (WX-22 contract); else derive from the frameIdByValidTime keys. Single frame -> no interpolation.
  function validTimesSorted(manifest) {
    var run = (manifest && manifest.run) || {};
    if (Array.isArray(run.validTimes) && run.validTimes.length) return run.validTimes.slice().sort();
    if (Array.isArray(run.frames) && run.frames.length) return run.frames.map(function (f) { return f.time || f.validTime; }).filter(Boolean).sort();
    return Object.keys(run.frameIdByValidTime || {}).sort();
  }
  // Given a scrub ISO time, return the bracketing pair {aIso,bIso,aId,bId,frac} or null (single frame,
  // exact-frame hit, or outside the baked range -> caller uses the single-frame hard-switch path).
  function bracket(manifest, isoTime) {
    var vts = validTimesSorted(manifest);
    if (vts.length <= 1 || !isoTime) return null;
    var t = Date.parse(isoTime); if (!isFinite(t)) return null;
    var fm = (manifest.run && manifest.run.frameIdByValidTime) || {};
    if (t <= Date.parse(vts[0]) || t >= Date.parse(vts[vts.length - 1])) return null;   // outside range -> nearest frame
    for (var i = 0; i < vts.length - 1; i++) {
      var ta = Date.parse(vts[i]), tb = Date.parse(vts[i + 1]);
      if (t >= ta && t <= tb && tb > ta) {
        var frac = (t - ta) / (tb - ta);
        if (frac <= 0.0001 || frac >= 0.9999) return null;                               // on a frame (either edge) -> hard single-frame path
        return { aIso: vts[i], bIso: vts[i + 1], aId: fm[vts[i]], bId: fm[vts[i + 1]], frac: frac };
      }
    }
    return null;
  }
  function scaleOffsetFor(manifest, layer) {
    var L = layerCfg(manifest, layer), rng = L.range || (L.fieldTiles && L.fieldTiles.range) || {};
    return codec().scaleOffset(rng.min, rng.max);
  }
  function lodRange(manifest, layer) {
    var ft = layerCfg(manifest, layer).fieldTiles || {};
    if (ft.minzoom != null && ft.maxzoom != null) return { minzoom: ft.minzoom, maxzoom: ft.maxzoom };
    var lv = (manifest.lod && manifest.lod.levels) || {}, los = [], his = [];
    Object.keys(lv).forEach(function (k) { if (isFinite(lv[k].minzoom)) los.push(lv[k].minzoom); if (isFinite(lv[k].maxzoom)) his.push(lv[k].maxzoom); });
    return { minzoom: los.length ? Math.min.apply(null, los) : 0, maxzoom: his.length ? Math.max.apply(null, his) : 8 };
  }
  function coverageBounds(manifest) {
    var b = (manifest.coverage || {}).bbox;
    if (!b || b.crossesAntimeridian) return null;          // wrap-crossing coverage -> let MapLibre wrap (no bounds clamp)
    return [b.west, b.south, b.east, b.north];
  }
  function tileTemplateAbs(manifest, layer, vtId) {
    var ft = layerCfg(manifest, layer).fieldTiles || {};
    var tpl = ft.urlTemplate || '';                        // e.g. /bundles/open-meteo/latest/fiji/layers/wind/scalar/{validTimeId}/{z}/{x}/{y}.png
    return svc() + tpl.replace('{validTimeId}', vtId);     // leaves {z}/{x}/{y} for MapLibre
  }

  function beforeId(m) { return m.getLayer('route-line') ? 'route-line' : (m.getLayer('enc-chart') ? 'enc-chart' : undefined); }
  function remove() {
    var m = state.map; if (!m) return;
    try { if (m.getLayer(LYR)) m.removeLayer(LYR); } catch (e) {}
    try { if (m.getSource(SRC)) m.removeSource(SRC); } catch (e) {}
  }

  // ---- public API --------------------------------------------------------------------------------
  // enableScalar(map, { region, layer, isoTime, opacity }) -> Promise<{layer,validTimeId,lod,bounds,unit,ramp}>
  function enableScalar(map, opts) {
    opts = opts || {};
    state.map = map; ensureProtocol();
    var region = opts.region || state.region || 'fiji';
    var layer = opts.layer || 'wind';
    return loadManifest(region).then(function (manifest) {
      state.manifest = manifest; state.region = region; state.layer = layer;
      var L = layerCfg(manifest, layer);
      if (L.ramp && ramp() && ramp().setManifestRamp) ramp().setManifestRamp(layer, L.ramp);   // CLIENT-14: field/particles/probe agree
      var so = scaleOffsetFor(manifest, layer), lod = lodRange(manifest, layer), bounds = coverageBounds(manifest);
      var br = bracket(manifest, opts.isoTime); state.blend = br; state.lastGoodServe = 0;   // WX-23 blend / WX-24 reset hold-state per frame load
      var vtId = br ? br.aId : frameId(manifest, opts.isoTime); state.validTimeId = vtId;
      var key, scene;
      if (br) {
        key = region + '|' + layer + '|' + br.aId + '~' + br.bId + '@' + br.frac.toFixed(3);
        scene = { pair: true, templateA: tileTemplateAbs(manifest, layer, br.aId), templateB: tileTemplateAbs(manifest, layer, br.bId),
                  frac: br.frac, layer: layer, scale: so.scale, offset: so.offset };
      } else {
        key = region + '|' + layer + '|' + vtId;
        scene = { template: tileTemplateAbs(manifest, layer, vtId), layer: layer, scale: so.scale, offset: so.offset };
      }
      scenes[key] = scene;
      remove();
      var src = { type: 'raster', tiles: [PROTO + '://' + key + '/{z}/{x}/{y}'], tileSize: 256, minzoom: lod.minzoom, maxzoom: lod.maxzoom };
      if (bounds) src.bounds = bounds;
      map.addSource(SRC, src);
      map.addLayer({
        id: LYR, type: 'raster', source: SRC,
        paint: { 'raster-opacity': (opts.opacity != null ? opts.opacity : state.opacity), 'raster-resampling': 'linear', 'raster-fade-duration': 280 }
      }, beforeId(map));
      return { layer: layer, validTimeId: vtId, lod: lod, bounds: bounds, unit: L.unit || '', ramp: L.ramp || null };
    });
  }
  function setOpacity(o) { state.opacity = o; try { if (state.map && state.map.getLayer(LYR)) state.map.setPaintProperty(LYR, 'raster-opacity', o); } catch (e) {} }

  // ============================ PHASE 2: vector particles =========================================
  // Animate wind/current particles from the PREPARED bundle uv tiles (not the gesture-fetching
  // /velocity endpoint) — same bundle/time/coverage as the scalar colour field. We decode the uv
  // component tiles and sample them onto a regular lat/lon grid (mercator-correct: we sample at
  // lat/lon points, reading the right mercator pixel), then feed the existing GPU particle engine
  // (window.__helmWind). Colour stays on the scalar field (Windy-style: coloured field + pale streaks).
  var VGRID_NX = 80, VGRID_NY = 60;             // velocity sample-grid resolution over the viewport
  var pState = { on: false, layer: null, moveHandler: null, debounce: null, token: 0 };
  var valueTileCache = {};                      // url -> Promise<{w,h,vals(Float32, NaN=NODATA)}|null>

  function fetchValueTile(url, scale, offset) {
    if (valueTileCache[url]) return valueTileCache[url];
    var p = fetch(url).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('uv tile HTTP ' + r.status);
      return r.arrayBuffer().then(function (buf) {
        return createImageBitmap(new Blob([buf], { type: 'image/png' })).then(function (img) {
          var w = img.width || 256, h = img.height || 256, cv = makeCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0); if (img.close) try { img.close(); } catch (e) {}
          var d = cx.getImageData(0, 0, w, h).data, vals = new Float32Array(w * h), C = codec();
          for (var i = 0, j = 0; i < d.length; i += 4, j++) {
            var v = C.decodeRGBA(d[i], d[i + 1], d[i + 2], d[i + 3], scale, offset);
            vals[j] = (v == null ? NaN : v);     // honest NODATA -> NaN (not finite -> particle won't advect)
          }
          return { w: w, h: h, vals: vals };
        });
      });
    }).catch(function () { return null; });
    valueTileCache[url] = p; return p;
  }
  function sampleTileSet(tiles, lon, lat, z) {
    var C = codec(), p = C.lonLatToPixel(lon, lat, z, 256), g = tiles[p.x + '/' + p.y];
    if (!g || !g.vals) return NaN;
    var v = C.bilinear(g.vals, g.w, g.h, p.px, p.py);
    return (v == null ? NaN : v);
  }
  function assign(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  // Assemble the GRIB-JSON velocity array (u,v components) the particle engine ingests.
  function buildVelocity(layer) {
    var m = state.map, manifest = state.manifest, C = codec();
    var vf = layerCfg(manifest, layer).vectorField;
    if (!m || !vf || !vf.u || !vf.v) return Promise.resolve(null);
    var lod = lodRange(manifest, layer);
    var z = Math.max(lod.minzoom, Math.min(lod.maxzoom, Math.round(m.getZoom())));
    var b = m.getBounds(), W = b.getWest(), E = b.getEast(), S = b.getSouth(), N = b.getNorth();
    var cov = (manifest.coverage || {}).bbox;
    if (cov && !cov.crossesAntimeridian) { W = Math.max(W, cov.west); E = Math.min(E, cov.east); S = Math.max(S, cov.south); N = Math.min(N, cov.north); }
    if (!(E > W && N > S)) return Promise.resolve(null);          // viewport doesn't overlap coverage
    var list = C.tilesForBbox(z, [W, S, E, N]);
    function url(tpl, t) { return tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y); }
    function gather(tplBase, so, vt) {
      var tpl = svc() + tplBase.replace('{validTimeId}', vt);
      return Promise.all(list.map(function (t) {
        return fetchValueTile(url(tpl, t), so.scale, so.offset).then(function (g) { return { k: t.x + '/' + t.y, g: g }; });
      })).then(function (rows) { var mp = {}; rows.forEach(function (r) { if (r.g) mp[r.k] = r.g; }); return mp; });
    }
    var NX = VGRID_NX, NY = VGRID_NY;
    function gridFor(vt) {                                          // sample u/v onto the lat/lon grid for one frame
      return Promise.all([gather(vf.u.urlTemplate, vf.u, vt), gather(vf.v.urlTemplate, vf.v, vt)]).then(function (sets) {
        var uT = sets[0], vT = sets[1], us = new Array(NX * NY), vs = new Array(NX * NY);
        for (var j = 0; j < NY; j++) {
          var lat = N - (N - S) * (j / (NY - 1));
          for (var i = 0; i < NX; i++) {
            var lon = W + (E - W) * (i / (NX - 1));
            us[j * NX + i] = sampleTileSet(uT, lon, lat, z); vs[j * NX + i] = sampleTileSet(vT, lon, lat, z);
          }
        }
        return { us: us, vs: vs };
      });
    }
    function lerpComp(a, b, f) { var ga = a === a, gb = b === b; if (ga && gb) return a + (b - a) * f; if (ga) return a; if (gb) return b; return NaN; }
    var bl = state.blend;                                          // WX-23: interpolate u/v too, so particles + colour share the SAME time
    var gridP = bl
      ? Promise.all([gridFor(bl.aId), gridFor(bl.bId)]).then(function (gs) {
          var A = gs[0], B = gs[1], us = new Array(NX * NY), vs = new Array(NX * NY);
          for (var k = 0; k < NX * NY; k++) { us[k] = lerpComp(A.us[k], B.us[k], bl.frac); vs[k] = lerpComp(A.vs[k], B.vs[k], bl.frac); }
          return { us: us, vs: vs };
        })
      : gridFor(state.validTimeId);
    return gridP.then(function (G) {
      var us = G.us, vs = G.vs, any = false;
      for (var k = 0; k < NX * NY; k++) { if (us[k] === us[k] && vs[k] === vs[k]) { any = true; break; } }
      if (!any) return null;
      var hdr = { nx: NX, ny: NY, lo1: W, la1: N, lo2: E, la2: S, dx: (E - W) / (NX - 1), dy: (N - S) / (NY - 1) };
      return [{ header: assign({ parameterNumber: 2 }, hdr), data: us }, { header: assign({ parameterNumber: 3 }, hdr), data: vs }];
    });
  }

  function refreshParticles() {
    var w = global.__helmWind; if (!pState.on || !w) return;
    var tok = ++pState.token;
    buildVelocity(pState.layer).then(function (vel) {
      if (tok !== pState.token || !pState.on) return;             // a newer move superseded this build
      if (!vel) { try { w.setVisible(false); } catch (e) {} return; }
      w.setData(vel); w.setVisible(true);
    }).catch(function (e) { if (log.warn) log.warn.call(log, '[wx-scene] particle build failed: ' + ((e && e.message) || e)); });
  }
  function onMove() { clearTimeout(pState.debounce); pState.debounce = setTimeout(refreshParticles, 300); }   // refetch from cache only — no upstream
  function startParticles(map, layer) {
    var w = global.__helmWind; if (!w) return Promise.resolve(false);
    pState.on = true; pState.layer = layer;
    if (!pState.moveHandler) { pState.moveHandler = onMove; map.on('moveend', pState.moveHandler); }
    return buildVelocity(layer).then(function (vel) {
      if (vel && pState.on) { w.setData(vel); w.setVisible(true); }
      return !!vel;
    }).catch(function () { return false; });
  }
  function stopParticles() {
    pState.on = false; pState.layer = null; pState.token++;
    var w = global.__helmWind; if (w) try { w.setVisible(false); } catch (e) {}
    if (pState.moveHandler && state.map) { try { state.map.off('moveend', pState.moveHandler); } catch (e) {} pState.moveHandler = null; }
  }

  // Unified entry: scalar colour field + (vector layers) particles, all from the prepared bundle.
  function enable(map, opts) {
    opts = opts || {};
    return enableScalar(map, opts).then(function (info) {
      info.freshness = manifestFreshness(state.manifest);     // phase 4b: surface forecast age / staleness
      renderStatusBadge(); startStaleWatch();
      var L = layerCfg(state.manifest, info.layer);
      if (L.vectorField || L.kind === 'vector') return startParticles(map, info.layer).then(function (ok) { info.particles = ok; return info; });
      stopParticles(); return info;
    });
  }
  function disable() { stopParticles(); stopStaleWatch(); hideStatusBadge(); remove(); }

  // ---- time-scrub: switch the active valid-time frame (reuses cached tiles; no upstream fetch) ----
  function setValidTime(isoTime) {
    if (!state.manifest || !state.layer) return Promise.resolve(null);
    return enable(state.map, { region: state.region, layer: state.layer, isoTime: isoTime, opacity: state.opacity });
  }

  // ---- probe / sample (helm.layer.sample.v1): read the active layer's value at a point from the bundle ----
  function invFrame(manifest, vtId) {                 // validTimeId -> ISO valid time
    var fm = (manifest && manifest.run && manifest.run.frameIdByValidTime) || {};
    for (var iso in fm) if (fm.hasOwnProperty(iso) && fm[iso] === vtId) return iso;
    return null;
  }
  function sample(lat, lon) {
    var m = state.map, manifest = state.manifest, layer = state.layer, C = codec();
    if (!manifest || !layer) return Promise.resolve(null);
    var L = layerCfg(manifest, layer), lod = lodRange(manifest, layer);
    var z = Math.max(lod.minzoom, Math.min(lod.maxzoom, Math.round(m ? m.getZoom() : lod.maxzoom)));
    var so = scaleOffsetFor(manifest, layer);
    var tplBase = (L.fieldTiles && L.fieldTiles.urlTemplate) || '';
    var p = C.lonLatToPixel(lon, lat, z, 256);
    function frameVal(vtId) {                                       // bilinear value at the point for one frame
      var url = (svc() + tplBase.replace('{validTimeId}', vtId)).replace('{z}', z).replace('{x}', p.x).replace('{y}', p.y);
      return fetchValueTile(url, so.scale, so.offset).then(function (g) {
        var v = g ? C.bilinear(g.vals, g.w, g.h, p.px, p.py) : null;
        return (v == null || v !== v) ? null : v;
      });
    }
    var bl = state.blend;                                          // WX-23: interpolate the probed value where defined
    var valP = bl
      ? Promise.all([frameVal(bl.aId), frameVal(bl.bId)]).then(function (vv) {
          var va = vv[0], vb = vv[1];
          if (va != null && vb != null) return va + (vb - va) * bl.frac;
          return (va != null) ? va : (vb != null ? vb : null);
        })
      : frameVal(state.validTimeId);
    return valP.then(function (v) {
      if (v != null && v !== v) v = null;             // NaN -> honest nodata
      var run = manifest.run || {}, gen = manifest.generatedAt || run.runTime || null;
      var ttl = (manifest.cachePolicy && manifest.cachePolicy.refreshCadenceSeconds) || 0, stale = false;
      try { if (gen && ttl) stale = (Date.now() - Date.parse(gen)) > ttl * 1000; } catch (e) {}
      return {
        schema: 'helm.layer.sample.v1', layer: layer,
        value: (v == null ? null : Math.round(v * 10) / 10), unit: L.unit || '',
        sourceRef: { title: (manifest.title || 'environmental bundle'), model: (run.model || ''), bundleId: manifest.bundleId || null },
        freshness: { generatedAt: gen, validTime: bl ? bl.aIso : invFrame(manifest, state.validTimeId), ttlSeconds: ttl, stale: stale,
                     interpolated: bl ? { fromIso: bl.aIso, toIso: bl.bIso, frac: Math.round(bl.frac * 1000) / 1000 } : null },
        confidence: null,
        coverage: (v == null ? 'nodata' : 'in'),
        advisory: true, notForNavigation: true        // advisory met-ocean — never for navigation
      };
    });
  }

  // ---- phase 4b: freshness / stale indicator ----------------------------------------------------
  // Weather is advisory + time-sensitive. Surface the forecast age + a STALE warning (manifest
  // generatedAt vs cachePolicy.refreshCadenceSeconds) on a standalone, inline-styled map badge so the
  // skipper always knows how current the field is. Honest: shows the age, flags stale, never hides it.
  var staleTimer = null;
  function manifestFreshness(manifest) {
    var run = (manifest && manifest.run) || {};
    var gen = (manifest && manifest.generatedAt) || run.runTime || null;
    var ttl = (manifest && manifest.cachePolicy && manifest.cachePolicy.refreshCadenceSeconds) || 0;
    var ageS = null, stale = false;
    if (gen) { var t = Date.parse(gen); if (isFinite(t)) { ageS = Math.max(0, Math.round((Date.now() - t) / 1000)); if (ttl) stale = ageS > ttl; } }
    return { generatedAt: gen, ageSeconds: ageS, ttlSeconds: ttl, stale: stale };
  }
  function status() {
    if (!state.manifest || !state.layer) return { state: 'off' };
    var f = manifestFreshness(state.manifest);
    var holding = !!state.lastGoodServe && (Date.now() - state.lastGoodServe) < 4000;   // WX-24: recently held last-good
    return { state: (holding || f.stale) ? 'stale' : 'fresh', holdingLastGood: holding, layer: state.layer,
             validTime: invFrame(state.manifest, state.validTimeId),
             generatedAt: f.generatedAt, ageSeconds: f.ageSeconds, ttlSeconds: f.ttlSeconds };
  }
  function fmtAge(s) { if (s == null) return ''; if (s < 3600) return Math.round(s / 60) + ' min'; if (s < 86400) return Math.round(s / 3600) + ' h'; return Math.round(s / 86400) + ' d'; }
  function renderStatusBadge() {
    var el = document.getElementById('helm-wx-scene-status'), st = status();
    if (!st || st.state !== 'stale') { if (el) el.style.display = 'none'; return; }   // show only when stale
    if (!el) {
      el = document.createElement('div'); el.id = 'helm-wx-scene-status';
      el.style.cssText = 'position:fixed;top:122px;left:50%;transform:translateX(-50%);z-index:30;padding:5px 12px;border-radius:13px;background:rgba(20,24,30,.9);border:1px solid var(--warn,#e0a23a);color:var(--warn,#e0a23a);font:600 11px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.2px;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      document.body.appendChild(el);
    }
    el.textContent = st.holdingLastGood
      ? '⚠ ' + st.layer + ' — showing last-good (frame data unavailable)'
      : '⚠ ' + st.layer + ' forecast ' + fmtAge(st.ageSeconds) + ' old — refresh the bundle';
    el.style.display = 'block';
  }
  function hideStatusBadge() { var el = document.getElementById('helm-wx-scene-status'); if (el) el.style.display = 'none'; }
  function startStaleWatch() { if (staleTimer) return; try { staleTimer = setInterval(renderStatusBadge, 60000); } catch (e) {} }
  function stopStaleWatch() { if (staleTimer) { try { clearInterval(staleTimer); } catch (e) {} staleTimer = null; } }

  global.HelmWxScene = {
    enable: enable, enableScalar: enableScalar, setValidTime: setValidTime, sample: sample, status: status,
    disable: disable, setOpacity: setOpacity, loadManifest: loadManifest, state: state,
    _bracket: bracket, _validTimesSorted: validTimesSorted,       // WX-23 test seam (frame-bracketing is unit-tested)
    _cacheGood: cacheGood, _lastGoodKeys: function () { return Object.keys(lastGood); }   // WX-24 test seam (bounded LRU)
  };
})(typeof window !== 'undefined' ? window : this);
