/*
 * Helm — integrations/cog.js   ·   maplibre-cog-protocol (geomatico)
 * --------------------------------------------------------------------------
 * Load a Cloud Optimized GeoTIFF straight into MapLibre via a `cog://` custom
 * protocol — no tiler, no mbtiles repack, just HTTP range reads off a static
 * .tif. This is the cheap path for BOTH halves of Helm: GRIB->COG is a one-step
 * GDAL convert (weather), and depth/imagery COGs stream the same way.
 *
 * The protocol also supports a `#color:...` URL fragment that colorizes a
 * value-encoded single-band COG client-side (the Mercator-style idea, applied
 * to a file instead of a tile pyramid).
 *
 * TWO requirements verified the hard way, both true of any real COG host:
 *   - the COG must be EPSG:3857 (Web Mercator). geotiff.js reads a 4326 file's
 *     coords AS METRES and lands it at the wrong place. pipeline/make_geotiff.py
 *     authors data/key-west-depth.tif in 3857.
 *   - the server must support HTTP Range requests (206). geotiff.js streams the
 *     COG with ranges; a server that returns the full file (e.g. a bare
 *     python -m http.server) errors "Server responded with full file".
 *
 * Local default below is that 3857 depth COG; swap for any COG (e.g. a GFS field
 * exported with `gdal_translate -of COG`). If it 404s the layer simply doesn't
 * draw — non-fatal.
 *
 * https://github.com/geomatico/maplibre-cog-protocol
 */
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';

const SRC = 'helm-cog', LYR = 'helm-cog';
// Public geomatico demo COG — used only if no local file is available.
const DEMO_COG = 'cog://https://geomatico.github.io/maplibre-cog-protocol/sample/dem.tif#color:BrewerSpectral9,0,4000';
let protocolReady = false;

// Local depth GeoTIFF (pipeline/make_geotiff.py), single-band float32, colorized
// client-side by the #color: fragment — the value-encoded-file pattern, offline.
// Production: a true COG (gdal_translate -of COG) streamed via HTTP range reads.
function localCog() {
  return 'cog://' + new URL('data/key-west-depth.tif', location.href).href +
    '#color:BrewerSpectral9,-120,5';
}

export async function enable(map, ctx) {
  if (!protocolReady) { ctx.maplibregl.addProtocol('cog', cogProtocol); protocolReady = true; }
  if (map.getLayer(LYR)) { map.setLayoutProperty(LYR, 'visibility', 'visible'); return; }

  // Prefer the local depth COG; fall back to the public demo if it's missing.
  let url = ctx.cogUrl || localCog();
  try {
    const probe = await fetch('data/key-west-depth.tif', { method: 'GET', headers: { Range: 'bytes=0-3' } });
    if (!probe.ok) throw new Error(String(probe.status));
  } catch (e) { url = DEMO_COG; }

  map.addSource(SRC, { type: 'raster', url, tileSize: 256 });
  map.addLayer({ id: LYR, type: 'raster', source: SRC,
    paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 500 } } }, ctx.beforeId);
  requestAnimationFrame(() => { if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'raster-opacity', 0.8); });
  ctx.notify('COG depth overlay via cog:// protocol (no tiler)', 'ok');
}

export function disable(map) {
  if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'none');
}


/* ============================================================================================
 * WX-10 — VALUE-ENCODED (Mercator) weather tiles.
 * --------------------------------------------------------------------------------------------
 * The depth-COG path above streams ONE static value-encoded COG. This section is the general
 * weather contract: a Web-Mercator XYZ pyramid of value-encoded tiles (pipeline/make_value_tiles.py,
 * encoding "helm-wxv1" in web/wx-value-codec.js) decoded + colourised CLIENT-SIDE via a custom
 * `helmwx://` MapLibre protocol — and the SAME tiles answer a deterministic sample(lat,lon,t) probe
 * (the face ROUTING-3's spacetime probe and AI-5's layer sample() consume). One source of truth:
 * the heatmap you see and the number the probe reads are decoded from identical pixels.
 *
 * Honesty: NODATA pixels (alpha<128) are transparent and sample as a null value
 * with a "verify locally" note — Helm never fakes a value to fill a gap; every sample carries its
 * model name + valid-time + horizon/confidence so a consumer can show provenance.
 * ============================================================================================ */

const WXP = 'helmwx';                  // custom protocol scheme: helmwx://<setId>/<frame>/{z}/{x}/{y}
const WX_SRC = 'helm-wx-grib', WX_LYR = 'helm-wx-grib';
const RAW_CACHE_MAX = 96;              // bound decoded-tile memory (per set)
let wxProtoReady = false;
let wxActiveKey = null;
const wxSets = Object.create(null);    // setId -> { cfg, baseDir, rawCache:Map<string,{values,w,h}|null>, order:[] }
let _transparent = null;

function codec() { return (typeof globalThis !== 'undefined' ? globalThis : self).HelmWxCodec; }
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function decodeImageData(blob) {
  const bmp = await createImageBitmap(blob);
  const cv = makeCanvas(bmp.width, bmp.height), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const id = cx.getImageData(0, 0, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  return id;
}
async function transparentTile() {
  if (_transparent) return _transparent;
  try { _transparent = await createImageBitmap(makeCanvas(256, 256)); }     // a fully-transparent tile (no data here)
  catch (e) { try { _transparent = await createImageBitmap(makeCanvas(1, 1)); } catch (e2) { /* terminal memory — let MapLibre retry */ } }
  return _transparent;
}
let _bmpWarned = 0;
// A single tile we can't rasterise (e.g. "ImageBitmap could not be allocated" under memory
// pressure, or a zero-dimension tile) must DEGRADE to transparent — never bubble up as a
// chart-wide error (MapLibre map.on('error') -> the "Chart error" surface). Log the first few with
// size + url so a real recurrence is diagnosable (memory vs bad tile) instead of a silent crash.
function bmpFail(e, w, h, url) {
  if (_bmpWarned++ < 3) { try { console.warn('[helmwx] tile rasterise failed (' + w + 'x' + h + '), using transparent: ' + (e && e.message) + (url ? ' @ ' + url : '')); } catch (_) {} }
}
function effFrame(cfg, frame) {                 // the clamped, in-range frame index (used for BOTH key + path)
  if (!cfg.times || !cfg.times.length) return null;
  return Math.max(0, Math.min(cfg.times.length - 1, frame | 0));
}
function touch(set, key) {                       // move-to-end → true LRU recency on a hit
  const i = set.order.indexOf(key);
  if (i >= 0) set.order.splice(i, 1);
  set.order.push(key);
}

// Fetch + decode ONE raw value tile into a flat values grid (NaN = NODATA). Cached per set so the
// colourising protocol and the sample() probe share decoded pixels. In-flight requests are de-duped
// (a worldline of probe points hitting the same tile fetches once). A genuine absence (HTTP 404 =
// outside the baked pyramid) is cached as a real gap; a TRANSIENT failure (offline/abort) is NOT
// cached, so connectivity recovery re-probes instead of poisoning the region with false "no data".
async function wxFetchRaw(set, frame, z, x, y, signal) {
  const f = effFrame(set.cfg, frame);
  const key = f + '/' + z + '/' + x + '/' + y;
  if (set.rawCache.has(key)) { touch(set, key); return set.rawCache.get(key); }
  if (set.inflight.has(key)) return set.inflight.get(key);
  const sub = f == null ? '' : 't' + f + '/';
  const url = set.baseDir + sub + z + '/' + x + '/' + y + '.png';
  const p = (async () => {
    let tile = null, cacheable = true;
    try {
      const r = await fetch(url, signal ? { signal } : undefined);
      if (r.ok) {
        const id = await decodeImageData(await r.blob());
        const C = codec(), cfg = set.cfg, d = id.data, n = id.width * id.height;
        const values = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const v = C.decodeRGBA(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3], cfg.scale, cfg.offset);
          values[i] = v == null ? NaN : v;   // NODATA -> NaN (bilinear + colourise treat as a gap)
        }
        tile = { values, w: id.width, h: id.height };
      } else if (r.status !== 404) {
        cacheable = false;                     // 5xx/etc — transient, allow a later retry
      }                                        // 404 → genuine absence (outside the pyramid) → cache the gap
    } catch (e) {
      cacheable = false;                       // offline / AbortError — transient, do not poison the cache
    }
    set.inflight.delete(key);
    if (cacheable) {
      set.rawCache.set(key, tile); set.order.push(key);
      while (set.order.length > RAW_CACHE_MAX) { const ev = set.order.shift(); if (set.order.indexOf(ev) < 0) set.rawCache.delete(ev); }
    }
    return tile;
  })();
  set.inflight.set(key, p);
  return p;
}

// The custom protocol: MapLibre asks for helmwx://setId/frame/z/x/y; we fetch the raw value tile,
// decode each pixel's value, paint it through the layer's colour ramp, and hand back the image.
// MapLibre 5.x passes (requestParameters, abortController); we thread the abort signal so stale
// tiles (fast pan / frame scrub) stop fetching + decoding.
async function wxProtocol(params, abortController) {
  const m = /^helmwx:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) { if (!wxProtocol._warned) { wxProtocol._warned = true; console.warn('[helmwx] malformed tile url: ' + params.url); } return { data: await transparentTile() }; }
  const set = wxSets[m[1]];
  if (!set) return { data: await transparentTile() };
  let tile;
  try { tile = await wxFetchRaw(set, +m[2], +m[3], +m[4], +m[5], abortController && abortController.signal); }
  catch (e) { if (e && e.name === 'AbortError') throw e; return { data: await transparentTile() }; }
  if (!tile) return { data: await transparentTile() };
  const C = codec(), ramp = set.cfg.ramp, vals = tile.values;
  if (!tile.w || !tile.h) return { data: await transparentTile() };          // zero-dim / empty tile
  try {
    const cv = makeCanvas(tile.w, tile.h), cx = cv.getContext('2d');
    const img = cx.createImageData(tile.w, tile.h), d = img.data;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null || !isFinite(v)) { d[i * 4 + 3] = 0; continue; }   // NODATA -> transparent
      const c = C.rampColor(ramp, v);
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3];
    }
    cx.putImageData(img, 0, 0);
    return { data: await createImageBitmap(cv) };
  } catch (e) {                                                              // e.g. ImageBitmap could not be allocated
    bmpFail(e, tile.w, tile.h, params.url);
    return { data: await transparentTile() };
  }
}

function provenanceClass(source) {
  // LayerSample.source ∈ open|owned|rag|nfl|engine (+ extensions). Public
  // weather MODELS (GFS/ECMWF/ICON/Open-Meteo) are 'open'. The synthetic offline demo is NOT a real
  // feed — it must NOT share the trusted-model 'open' class, so it gets its own 'synthetic' token
  // (a consumer that only trusts the known enum fails closed on it). The authoritative not-for-nav
  // signal is the explicit `notForNavigation` flag below.
  return source === 'demo-synthetic' ? 'synthetic' : 'open';
}
const SOURCE_URL = {
  'open-meteo': 'https://open-meteo.com', 'gfs': 'https://nomads.ncep.noaa.gov',
  'ecmwf-ifs': 'https://www.ecmwf.int/en/forecasts/datasets/open-data', 'icon': 'https://opendata.dwd.de',
};
const NFN = /NOT FOR NAVIGATION/i;
function layerSample(cfg, value, frame, note) {
  const validTime = cfg.times && cfg.times.length ? cfg.times[Math.max(0, Math.min(cfg.times.length - 1, frame | 0))] : null;
  const notForNav = cfg.source === 'demo-synthetic' || NFN.test(cfg.model || '') || NFN.test(cfg.disclaimer || '');
  return {
    layer: cfg.layer, value: value == null ? null : Math.round(value * 100) / 100, unit: cfg.unit,
    source: provenanceClass(cfg.source),
    sourceRef: { title: cfg.model || cfg.source, url: SOURCE_URL[cfg.source] || null, provenance: cfg.source },
    // freshness = data-age (when the model was issued/fetched), NOT the forecast valid-time — those
    // are separate fields. validTime is returned distinctly below.
    freshness: cfg.fetchedAt || (cfg.source === 'demo-synthetic' ? 'synthetic' : 'forecast'),
    confidence: cfg.confidence || 'fair', horizon: cfg.horizon || null,
    validTime: validTime, encoding: cfg.encoding,
    notForNavigation: notForNav, disclaimer: cfg.disclaimer || undefined,
    note: note || (value == null ? 'no data here — verify locally' : undefined),
  };
}

// PUBLIC — enable a value-encoded weather tile set. ctx: { maplibregl, manifestUrl, beforeId?,
// opacity?, frame?, notify? }. Returns the resolved manifest (or null on load failure — surfaced,
// never silently empty).
export async function enableWxTiles(map, ctx) {
  const C = codec();
  if (!C) { ctx.notify && ctx.notify('weather value-codec not loaded (web/wx-value-codec.js)', 'warn'); return null; }
  if (!wxProtoReady) { ctx.maplibregl.addProtocol(WXP, wxProtocol); wxProtoReady = true; }
  let cfg;
  try {
    const r = await fetch(ctx.manifestUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    cfg = await r.json();
  } catch (e) {
    ctx.notify && ctx.notify('weather tiles unavailable: ' + (e.message || e), 'warn');
    return null;
  }
  if (cfg.encoding !== C.ENCODING) {            // a contract bump must fail loud, not mis-decode silently
    ctx.notify && ctx.notify('unsupported tile encoding "' + cfg.encoding + '" (need ' + C.ENCODING + ')', 'warn');
    return null;
  }
  const setId = cfg.layer || 'wx';
  wxSets[setId] = { cfg, baseDir: ctx.manifestUrl.replace(/manifest\.json$/, ''), rawCache: new Map(), inflight: new Map(), order: [] };
  wxActiveKey = setId;
  const frame = ctx.frame | 0;
  const opacity = Math.max(0, Math.min(1, ctx.opacity == null ? 0.82 : ctx.opacity));
  disableWxTiles(map, true);
  var srcDef = {
    type: 'raster', tiles: ['helmwx://' + setId + '/' + frame + '/{z}/{x}/{y}'],
    tileSize: 256, minzoom: cfg.minzoom || 0, maxzoom: cfg.maxzoom || 7,
    attribution: 'Helm value-encoded weather · ' + (cfg.model || cfg.source),
  };
  // A regional pack restricts requests to its bbox; a GLOBAL source (the helm-wx gateway) must NOT set
  // bounds, or MapLibre clips world-copy wrapping at the antimeridian — the dateline gap right at Fiji.
  if (cfg.bbox && !cfg.global) srcDef.bounds = cfg.bbox;
  map.addSource(WX_SRC, srcDef);
  map.addLayer({
    id: WX_LYR, type: 'raster', source: WX_SRC,
    paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 280 },   // keep+crossfade old tiles while new zooms bake -> Windy-style "fills the screen", no blank flash
  }, (ctx.beforeId && map.getLayer(ctx.beforeId)) ? ctx.beforeId : undefined);
  ctx.notify && ctx.notify('Value-encoded ' + setId + ' tiles (' + (cfg.model || cfg.source) + ') — decoded client-side', 'ok');
  return cfg;
}

export function disableWxTiles(map, keep) {
  if (map.getLayer(WX_LYR)) map.removeLayer(WX_LYR);
  if (map.getSource(WX_SRC)) map.removeSource(WX_SRC);
  if (!keep) wxActiveKey = null;
}
export function setWxOpacity(map, o) {
  if (map.getLayer(WX_LYR)) map.setPaintProperty(WX_LYR, 'raster-opacity', Math.max(0, Math.min(1, o)));
}
export function setWxFrame(map, frame) {
  if (!wxActiveKey) return;
  const set = wxSets[wxActiveKey], src = map.getSource(WX_SRC);
  const f = set ? (effFrame(set.cfg, frame) ?? 0) : (frame | 0);   // clamp so the URL frame matches the cache key
  if (src && src.setTiles) src.setTiles(['helmwx://' + wxActiveKey + '/' + f + '/{z}/{x}/{y}']);
}

// PUBLIC PROBE — the deterministic weather sample face. Returns a LayerSample
// { layer, value, unit, source, sourceRef, freshness, confidence,
// horizon, validTime, note? }. value is DECODED from the value tiles (never invented); null +
// "verify locally" when the point is outside coverage or NODATA.
//   NOTE on argument order: keep this public probe sample(lat, lon, t) — lat FIRST — which
//   differs from web/wind-layer.js's sample(lon, lat).
export async function sampleWx(lat, lon, t, opts) {
  const C = codec(); if (!C) return null;
  const setId = (opts && opts.layer) || wxActiveKey;
  const set = wxSets[setId];
  if (!set) return null;                                  // no active value-tile layer
  const cfg = set.cfg, b = cfg.bbox;                      // [w,s,e,n]
  const frame = cfg.times ? C.pickFrame(cfg.times, t) : 0;
  // lon coverage handles an antimeridian-crossing bbox (west > east, e.g. around 180° near Fiji).
  const lonIn = b[0] <= b[2] ? (lon >= b[0] && lon <= b[2]) : (lon >= b[0] || lon <= b[2]);
  if (!lonIn || lat < b[1] || lat > b[3]) return layerSample(cfg, null, frame, 'outside coverage — verify locally');
  const z = C.sampleZoom(cfg, cfg.maxzoom);
  const p = C.lonLatToPixel(lon, lat, z, cfg.tileSize || 256);
  const tile = await wxFetchRaw(set, frame, z, p.x, p.y);
  if (!tile) return layerSample(cfg, null, frame, 'no data here — verify locally');
  const v = C.bilinear(tile.values, tile.w, tile.h, p.px, p.py);
  return layerSample(cfg, (v == null || !isFinite(v)) ? null : v, frame);
}

// Active set introspection (for the panel readout / legend).
export function activeWx() { const s = wxSets[wxActiveKey]; return s ? s.cfg : null; }


/* ============================================================================================
 * WX-11 — ENSEMBLE GFS-vs-ECMWF confidence / spread.
 * --------------------------------------------------------------------------------------------
 * Multi-model honesty: when we show GFS vs ECMWF, say which and show spread/agreement;
 * disagreement between models is itself decision-relevant. This decodes TWO
 * value-tile sets (the same layer from two models) and renders the per-pixel SPREAD |A−B| through a
 * ramp that is transparent where the models agree and reddens where they diverge — so the map
 * literally highlights "the forecast is uncertain here". sampleEnsemble(lat,lon,t) returns both
 * model values + the spread + an agreement/confidence label. Reuses the WX-10 decode + cache.
 * ============================================================================================ */

const ENSP = 'helmwxspread';
const ENS_SRC = 'helm-wx-spread', ENS_LYR = 'helm-wx-spread';
let ensProtoReady = false;
let ensState = null;   // { layer, unit, setA, setB, labelA, labelB, range, spreadStops, times, bbox, minzoom, maxzoom, notForNav }

function makeSet(cfg, manifestUrl) {
  return { cfg, baseDir: manifestUrl.replace(/manifest\.json$/, ''), rawCache: new Map(), inflight: new Map(), order: [] };
}
// spread ramp (in the layer's own units) — transparent where models agree, amber→red as they diverge.
function spreadStops(range) {
  const u = Math.max(1e-6, range);
  return [[0, [0, 0, 0, 0]], [0.06 * u, [90, 200, 120, 0.30]], [0.16 * u, [240, 200, 70, 0.62]],
          [0.32 * u, [232, 90, 55, 0.85]], [0.5 * u, [200, 30, 60, 0.95]]];
}
async function ensFetchPair(st, frame, z, x, y, signal) {   // `st` captured by the caller so a mid-flight disable can't null it
  return Promise.all([wxFetchRaw(st.setA, frame, z, x, y, signal),
                      wxFetchRaw(st.setB, frame, z, x, y, signal)]);
}
async function ensProtocol(params, abortController) {
  const m = /^helmwxspread:\/\/e\/(\d+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  const st = ensState;                                       // snapshot — survives a disable during the await below
  if (!m || !st) return { data: await transparentTile() };
  let ta, tb;
  try { [ta, tb] = await ensFetchPair(st, +m[1], +m[2], +m[3], +m[4], abortController && abortController.signal); }
  catch (e) { if (e && e.name === 'AbortError') throw e; return { data: await transparentTile() }; }
  if (!ta || !tb) return { data: await transparentTile() };   // need BOTH members to assess spread
  const C = codec(), stops = st.spreadStops, w = ta.w, h = ta.h, va = ta.values, vb = tb.values;
  if (!w || !h) return { data: await transparentTile() };                    // zero-dim / empty tile
  try {
    const cv = makeCanvas(w, h), cx = cv.getContext('2d');
    const img = cx.createImageData(w, h), d = img.data;
    for (let i = 0; i < va.length; i++) {
      const a = va[i], b = vb[i];
      if (a == null || !isFinite(a) || b == null || !isFinite(b)) { d[i * 4 + 3] = 0; continue; }
      const c = C.rampColor(stops, Math.abs(a - b));
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3];
    }
    cx.putImageData(img, 0, 0);
    return { data: await createImageBitmap(cv) };
  } catch (e) {                                                              // e.g. ImageBitmap could not be allocated
    bmpFail(e, w, h, params.url);
    return { data: await transparentTile() };
  }
}


// PUBLIC — enable the ensemble spread layer. ctx: { maplibregl, manifestA, manifestB, labelA?,
// labelB?, layer?, beforeId?, opacity?, frame?, notify? }. Returns ensState (or null on failure).
export async function enableEnsemble(map, ctx) {
  const C = codec();
  if (!C) { ctx.notify && ctx.notify('weather codec not loaded', 'warn'); return null; }
  if (!ensProtoReady) { ctx.maplibregl.addProtocol(ENSP, ensProtocol); ensProtoReady = true; }
  let mA, mB;
  try {
    [mA, mB] = await Promise.all([fetch(ctx.manifestA).then(r => { if (!r.ok) throw new Error('A ' + r.status); return r.json(); }),
                                  fetch(ctx.manifestB).then(r => { if (!r.ok) throw new Error('B ' + r.status); return r.json(); })]);
  } catch (e) { ctx.notify && ctx.notify('ensemble tiles unavailable: ' + (e.message || e), 'warn'); return null; }
  if (mA.encoding !== C.ENCODING || mB.encoding !== C.ENCODING) { ctx.notify && ctx.notify('unsupported ensemble encoding', 'warn'); return null; }
  // The two members are compared frame-by-INDEX, so their valid-times must line up or the spread
  // would compare different forecast hours. Surface a mismatch rather than silently comparing apples.
  if (JSON.stringify(mA.times || null) !== JSON.stringify(mB.times || null))
    ctx.notify && ctx.notify('ensemble members have different valid-times — spread may be misaligned', 'warn');
  const bbox = [Math.max(mA.bbox[0], mB.bbox[0]), Math.max(mA.bbox[1], mB.bbox[1]),   // coverage intersection
                Math.min(mA.bbox[2], mB.bbox[2]), Math.min(mA.bbox[3], mB.bbox[3])];
  const range = Math.max(mA.vmax, mB.vmax) - Math.min(mA.vmin, mB.vmin);
  ensState = {
    layer: ctx.layer || mA.layer, unit: mA.unit,
    setA: makeSet(mA, ctx.manifestA), setB: makeSet(mB, ctx.manifestB),
    labelA: ctx.labelA || mA.model || mA.source, labelB: ctx.labelB || mB.model || mB.source,
    range, spreadStops: spreadStops(range), times: mA.times,
    minzoom: Math.max(mA.minzoom || 0, mB.minzoom || 0), maxzoom: Math.min(mA.maxzoom || 7, mB.maxzoom || 7), bbox,
    notForNav: [mA, mB].some(m => m.source === 'demo-synthetic' || NFN.test(m.model || '') || NFN.test(m.disclaimer || '')),
  };
  const frame = ctx.frame | 0;
  const opacity = Math.max(0, Math.min(1, ctx.opacity == null ? 0.85 : ctx.opacity));
  disableEnsemble(map, true);
  map.addSource(ENS_SRC, {
    type: 'raster', tiles: ['helmwxspread://e/' + frame + '/{z}/{x}/{y}'], tileSize: 256,
    minzoom: ensState.minzoom, maxzoom: ensState.maxzoom, bounds: bbox,
    attribution: 'Helm ensemble spread · ' + ensState.labelA + ' vs ' + ensState.labelB,
  });
  map.addLayer({
    id: ENS_LYR, type: 'raster', source: ENS_SRC,
    paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 280 },   // keep+crossfade old tiles while new zooms bake -> Windy-style "fills the screen", no blank flash
  }, (ctx.beforeId && map.getLayer(ctx.beforeId)) ? ctx.beforeId : undefined);
  ctx.notify && ctx.notify('Ensemble spread (' + ensState.labelA + ' vs ' + ensState.labelB + ') — red = models disagree', 'ok');
  return ensState;
}

export function disableEnsemble(map, keep) {
  if (map.getLayer(ENS_LYR)) map.removeLayer(ENS_LYR);
  if (map.getSource(ENS_SRC)) map.removeSource(ENS_SRC);
  if (!keep) ensState = null;
}
export function setEnsembleOpacity(map, o) {
  if (map.getLayer(ENS_LYR)) map.setPaintProperty(ENS_LYR, 'raster-opacity', Math.max(0, Math.min(1, o)));
}
export function setEnsembleFrame(map, frame) {
  if (!ensState) return;
  const f = effFrame(ensState.setA.cfg, frame) ?? 0;
  const src = map.getSource(ENS_SRC);
  if (src && src.setTiles) src.setTiles(['helmwxspread://e/' + f + '/{z}/{x}/{y}']);
}

// PUBLIC PROBE — the ensemble sample face. Returns both model values + spread + agreement/confidence
// (the multi-model honesty payload): { layer, unit, mean (value), spread, agreement, confidence,
// models:{<labelA>,<labelB>}, validTime, notForNavigation, note? }. Decoded, never invented.
export async function sampleEnsemble(lat, lon, t) {
  const C = codec(); const st = ensState; if (!C || !st) return null;   // snapshot so a mid-call disable is safe
  const b = st.bbox, frame = st.times ? C.pickFrame(st.times, t) : 0;
  const validTime = st.times ? st.times[Math.max(0, Math.min(st.times.length - 1, frame))] : null;
  const base = { layer: st.layer, unit: st.unit, models: {}, validTime: validTime, notForNavigation: st.notForNav };
  const inLon = b[0] <= b[2] ? (lon >= b[0] && lon <= b[2]) : (lon >= b[0] || lon <= b[2]);
  if (!inLon || lat < b[1] || lat > b[3])
    return { ...base, value: null, mean: null, spread: null, agreement: 'no-data', confidence: 'low', note: 'outside coverage — verify locally' };
  const z = C.sampleZoom(st, st.maxzoom), p = C.lonLatToPixel(lon, lat, z, st.setA.cfg.tileSize || 256);
  const [ta, tb] = await ensFetchPair(st, frame, z, p.x, p.y);
  const va = ta ? C.bilinear(ta.values, ta.w, ta.h, p.px, p.py) : null;
  const vb = tb ? C.bilinear(tb.values, tb.w, tb.h, p.px, p.py) : null;
  if (va == null || !isFinite(va) || vb == null || !isFinite(vb))
    return { ...base, value: null, mean: null, spread: null, agreement: 'no-data', confidence: 'low', note: 'no data here — verify locally' };
  const spread = Math.abs(va - vb), frac = spread / Math.max(1e-6, st.range);
  const agreement = frac < 0.08 ? 'agree' : (frac < 0.2 ? 'marginal' : 'diverge');
  const confidence = agreement === 'agree' ? 'good' : (agreement === 'marginal' ? 'fair' : 'low');
  const r2 = x => Math.round(x * 100) / 100;
  base.models[st.labelA] = r2(va); base.models[st.labelB] = r2(vb);
  return { ...base, value: r2((va + vb) / 2), mean: r2((va + vb) / 2), spread: r2(spread), agreement, confidence };
}
export function activeEnsemble() { return ensState; }
