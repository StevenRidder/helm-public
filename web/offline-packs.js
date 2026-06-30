// OFFLINE-4: local MBTiles/PMTiles pack selector for the MapLibre cockpit.
// Reads the BYO MBTiles helper catalog and activates a selected local pack as
// a dynamic raster layer. User chart files stay outside git and outside this UI.
(function () {
  'use strict';

  var EPIC = 'OFFLINE';
  var PANEL_ID = 'helm-offline-packs';
  var SOURCE_ID = 'helm-offline-active-pack';
  var LAYER_ID = 'helm-offline-active-pack';
  var STORE_KEY = 'offline.activePack';
  var DEFAULT_PORT = '8091';
  var STATIC_BASEMAPS = ['navionics', 'googlesat', 'bingsat', 'arcgis', 'satellite', 'charts'];
  var state = { body: null, map: null, packs: [], activeId: null, loading: false, error: '', lastInspect: null };
  var log = (window.HelmLog && HelmLog.scope) ? HelmLog.scope('offline-packs') : console;
  var pmtilesReady = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function basemapPort() {
    try {
      var q = new URLSearchParams(location.search);
      return q.get('basemapPort') || window.HELM_BASEMAP_PORT || DEFAULT_PORT;
    } catch (e) {
      return window.HELM_BASEMAP_PORT || DEFAULT_PORT;
    }
  }

  function endpointHost() {
    try {
      if (window.HelmEndpoint && HelmEndpoint.host) return HelmEndpoint.host();
    } catch (e) {}
    return location.hostname || '127.0.0.1';
  }

  function catalogBase() {
    var proto = location.protocol === 'https:' ? 'https:' : 'http:';
    return proto + '//' + endpointHost() + ':' + basemapPort();
  }

  function encodeSegment(s) {
    return encodeURIComponent(String(s == null ? '' : s));
  }

  function tileUrl(pack) {
    return catalogBase() + '/' + encodeSegment(pack.id || pack.name) + '/{z}/{x}/{y}.' + (pack.extension || pack.format || 'png');
  }

  function isPmtilesPack(pack) {
    return !!(pack && (pack.container === 'pmtiles' || pack.pmtiles_url || pack.protocol_url));
  }

  function pmtilesUrl(pack) {
    if (pack.protocol_url) return pack.protocol_url;
    var url = pack.pmtiles_url || pack.url || (catalogBase() + '/' + encodeSegment(pack.id || pack.name) + '.pmtiles');
    return 'pmtiles://' + new URL(url, location.href).href;
  }

  function pmtilesTileUrl(pack) {
    var url = pmtilesUrl(pack);
    if (/\{z\}.*\{x\}.*\{y\}/.test(url)) return url;
    return url.replace(/\/$/, '') + '/{z}/{x}/{y}';
  }

  function pmtilesHandler(protocol) {
    var handler = protocol && (protocol.tile || protocol.tilev4);
    if (typeof handler !== 'function') throw new Error('PMTiles protocol handler unavailable');
    return handler.bind(protocol);
  }

  function ensurePmtilesProtocol() {
    if (window.__helmPmtilesProtocolReady) return window.__helmPmtilesProtocolReady;
    if (pmtilesReady) return pmtilesReady;
    pmtilesReady = import('pmtiles').then(function (mod) {
      var Protocol = mod.Protocol || (mod.default && mod.default.Protocol);
      if (!Protocol) throw new Error('PMTiles Protocol unavailable');
      var protocol = new Protocol();
      if (window.maplibregl && maplibregl.addProtocol) {
        try { maplibregl.addProtocol('pmtiles', pmtilesHandler(protocol)); }
        catch (e) {
          if (!/already|exist|registered/i.test(String((e && e.message) || e))) throw e;
        }
      }
      return protocol;
    });
    window.__helmPmtilesProtocolReady = pmtilesReady;
    return pmtilesReady;
  }

  function fmtBytes(n) {
    n = Number(n || 0);
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i < 2 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }

  function boundsArray(pack) {
    if (Array.isArray(pack.bounds_array) && pack.bounds_array.length === 4) return pack.bounds_array.map(Number);
    if (typeof pack.bounds === 'string') {
      var b = pack.bounds.split(',').map(function (x) { return Number(x.trim()); });
      if (b.length === 4 && b.every(function (x) { return Number.isFinite(x); })) return b;
    }
    return null;
  }

  function lonInside(lon, w, e) {
    if (w <= e) return lon >= w && lon <= e;
    return lon >= w || lon <= e; // antimeridian-crossing coverage
  }

  function pointInBounds(lngLat, b) {
    if (!lngLat || !b) return true;
    return lonInside(lngLat.lng, b[0], b[2]) && lngLat.lat >= b[1] && lngLat.lat <= b[3];
  }

  function viewStatus(pack) {
    var map = state.map || window.map;
    var b = boundsArray(pack);
    if (!map || !b) return '';
    try {
      var c = map.getCenter();
      var inside = pointInBounds(c, b);
      return inside ? 'in view' : 'outside view';
    } catch (e) {
      return '';
    }
  }

  function packLine(pack) {
    var bits = [];
    bits.push((pack.kind || 'raster'));
    if (pack.minzoom != null || pack.maxzoom != null) bits.push('z' + (pack.minzoom || 0) + '-' + (pack.maxzoom || 0));
    if (pack.format) bits.push(String(pack.format).toUpperCase());
    var size = fmtBytes(pack.size_bytes);
    if (size) bits.push(size);
    var vs = viewStatus(pack);
    if (vs) bits.push(vs);
    return bits.join(' | ');
  }

  function firstValue(pack, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = pack && pack[keys[i]];
      if (v != null && v !== '') return v;
    }
    return '';
  }

  function nestedValue(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (!cur || cur[path[i]] == null) return '';
      cur = cur[path[i]];
    }
    return cur == null ? '' : cur;
  }

  function inspectRow(label, value) {
    if (value == null || value === '') return '';
    return '<div><b>' + esc(label) + '</b><span>' + esc(value) + '</span></div>';
  }

  function inspectMessage(pack) {
    return nestedValue(pack, ['inspection', 'message']) ||
      'Raster packs contain pixels only; object inspection is unavailable unless a sidecar metadata layer is present.';
  }

  function popupAnchor(point) {
    try {
      var w = window.innerWidth || 1280;
      return point && point.x > w * 0.55 ? 'right' : 'left';
    } catch (e) {
      return 'left';
    }
  }

  function showRasterInspect(pack, lngLat, point) {
    var map = state.map || window.map;
    if (!map || !pack || !window.maplibregl || !lngLat) return;
    installStyle();
    var b = boundsArray(pack);
    var inside = pointInBounds(lngLat, b);
    var src = pack.source_info || {};
    var fresh = pack.staleness || pack.freshness || {};
    var coverage = pack.coverage || {};
    var inspect = pack.inspection || {};
    var sourceLabel = src.label || pack.source || pack.attribution || 'local pack';
    var license = src.license || pack.license || 'unknown';
    var modified = src.modified || pack.modified || firstValue(pack, ['render_date', 'created', 'updated']);
    var bounds = b ? b.map(function (x) { return Number(x).toFixed(4); }).join(', ') : '';
    var mode = inspect.mode || 'raster_metadata';
    var semantic = inspect.semantic_objects || 'unavailable';
    var html = [
      '<div class="helm-raster-inspect">',
      '<h3>' + esc(pack.title || pack.id || 'Local raster pack') + '</h3>',
      '<p>' + esc(inside ? inspectMessage(pack) : 'This point is outside the selected offline pack coverage.') + '</p>',
      '<div class="helm-raster-inspect-grid">',
      inspectRow('Tap mode', mode),
      inspectRow('Objects', semantic),
      inspectRow('Source', sourceLabel),
      inspectRow('License', license),
      inspectRow('Freshness', fresh.status || 'unknown'),
      inspectRow('Updated', modified),
      inspectRow('Coverage', inside ? (coverage.status || 'inside declared bounds') : 'outside declared bounds'),
      inspectRow('Zooms', 'z' + (pack.minzoom || 0) + '-' + packMaxzoom(pack)),
      inspectRow('Bounds', bounds),
      '</div>',
      '</div>'
    ].join('');
    state.lastInspect = {
      pack_id: pack.id || pack.name || '',
      title: pack.title || '',
      mode: mode,
      semantic_objects: semantic,
      inside_coverage: inside,
      freshness: fresh.status || 'unknown',
      source: sourceLabel
    };
    new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '340px', anchor: popupAnchor(point), offset: [10, 0] })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
  }

  function hideStaticBasemaps() {
    var map = state.map || window.map;
    if (!map) return;
    STATIC_BASEMAPS.forEach(function (id) {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {}
    });
    document.querySelectorAll('input[name="basemap"]').forEach(function (rb) { rb.checked = false; });
  }

  function beforeLayerId(map) {
    return map.getLayer('enc-chart') ? 'enc-chart'
      : map.getLayer('depare-fill') ? 'depare-fill'
      : map.getLayer('route-line') ? 'route-line'
      : undefined;
  }

  function removeDynamicLayer() {
    var map = state.map || window.map;
    if (!map) return;
    try { if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID); } catch (e) {}
    try { if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID); } catch (e) {}
  }

  // ===== CLIENT-22: viewport prefetch + zoom/coverage policy =================
  // No blank edges while panning/zooming inside an active offline pack:
  //  - overzoom: source maxzoom = the pack's REAL max (below) so MapLibre scales the deepest
  //    tile past it instead of requesting tiles that don't exist (404 -> blank).
  //  - prefetch ring: on debounced moveend, warm a 1-tile margin around the viewport FROM THE
  //    LOCAL PACK ONLY, budgeted + deduped, never outside pack bounds, never on the gesture path.
  //  - coverage: when the viewport leaves pack bounds, show an explicit "outside coverage" badge
  //    (the online-fill underlay covers it when present) instead of a silent blank.
  // Reusable by WX-19's Environmental Scene (same overzoom / coverage discipline for the field).
  var PREFETCH_MARGIN = 1;        // tiles of pan-ahead ring beyond the viewport
  var PREFETCH_BUDGET = 96;       // hard cap on tiles warmed per moveend (runaway guard)
  var PREFETCH_SEEN_CAP = 4000;   // cap the dedupe set so it can't grow unbounded
  var prefetchSeen = Object.create(null);
  var prefetchSeenN = 0;
  var moveDebounce = null;
  var moveHookBound = false;
  var rasterTapHookBound = false;

  function packMaxzoom(pack) {
    var mz = Number(pack && pack.maxzoom);
    if (isFinite(mz) && mz > 0) return mz;
    // No maxzoom in the catalog: we can't know the pack's real depth. Fail loud + cap conservatively
    // so we OVERZOOM past the cap rather than silently guessing 22 and 404-blanking on deep zoom.
    if (log && log.warn) log.warn('pack "' + ((pack && (pack.id || pack.name)) || '?') + '" has no maxzoom; capping source at z16 for overzoom');
    return 16;
  }

  function lon2tileX(lon, n) { return Math.floor((lon + 180) / 360 * n); }
  function lat2tileY(lat, n) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  }
  function tileX2lon(x, n) { return x / n * 360 - 180; }
  function tileY2lat(y, n) { var t = Math.PI * (1 - 2 * y / n); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t))); }

  function warmTile(url) { try { var img = new Image(); img.decoding = 'async'; img.src = url; } catch (e) {} }

  function tileInBounds(x, y, n, b) {   // does tile (x,y)@n overlap pack bounds [W,S,E,N]?
    if (!b) return true;
    var w = tileX2lon(x, n), e = tileX2lon(x + 1, n), north = tileY2lat(y, n), south = tileY2lat(y + 1, n);
    return !(e < b[0] || w > b[2] || north < b[1] || south > b[3]);
  }

  function prefetchViewport() {
    var map = state.map || window.map;
    var pack = activePack();
    // PMTiles tiles arrive via the pmtiles:// range protocol from a LOCAL file; the browser's range
    // cache already makes re-pan instant, so only XYZ/HTTP packs need URL prewarming.
    if (!map || !pack || isPmtilesPack(pack)) return;
    if (!(map.getLayer && map.getLayer(LAYER_ID))) return;
    var bounds; try { bounds = map.getBounds(); } catch (e) { return; }
    if (!bounds) return;
    var minz = Number(pack.minzoom || 0), maxz = packMaxzoom(pack);
    var baseZ = Math.round(map.getZoom());
    if (baseZ < minz) baseZ = minz; else if (baseZ > maxz) baseZ = maxz;   // warm real tiles; overzoom covers deeper
    var W = bounds.getWest(), E = bounds.getEast(), N = bounds.getNorth(), S = bounds.getSouth();
    var pb = boundsArray(pack), tmpl = tileUrl(pack), budget = PREFETCH_BUDGET;
    // Warm the current zoom first (priority), then the adjacent levels so a zoom in/out is also
    // populated before it renders -- all within ONE shared tile budget (runaway guard).
    var zooms = [baseZ];
    if (baseZ + 1 <= maxz) zooms.push(baseZ + 1);
    if (baseZ - 1 >= minz) zooms.push(baseZ - 1);
    for (var zi = 0; zi < zooms.length && budget > 0; zi++) {
      var z = zooms[zi], n = Math.pow(2, z);
      var x0 = lon2tileX(W, n) - PREFETCH_MARGIN, x1 = lon2tileX(E, n) + PREFETCH_MARGIN;
      var y0 = lat2tileY(N, n) - PREFETCH_MARGIN, y1 = lat2tileY(S, n) + PREFETCH_MARGIN;
      for (var x = x0; x <= x1 && budget > 0; x++) {
        var tx = ((x % n) + n) % n;                  // wrap longitude across the antimeridian
        for (var y = y0; y <= y1 && budget > 0; y++) {
          if (y < 0 || y >= n) continue;             // latitude does not wrap
          if (!tileInBounds(tx, y, n, pb)) continue; // never warm outside declared coverage
          var key = z + '/' + tx + '/' + y;
          if (prefetchSeen[key]) continue;
          prefetchSeen[key] = 1; prefetchSeenN++; budget--;
          warmTile(tmpl.replace('{z}', z).replace('{x}', tx).replace('{y}', y));
        }
      }
    }
    if (prefetchSeenN > PREFETCH_SEEN_CAP) { prefetchSeen = Object.create(null); prefetchSeenN = 0; }
  }

  function renderCoverageBadge() {
    var map = state.map || window.map, pack = activePack();
    var el = document.getElementById('helm-coverage-badge');
    var b = pack && boundsArray(pack), c = null;
    if (map) { try { c = map.getCenter(); } catch (e) {} }
    var inside = !b || !c || pointInBounds(c, b);
    var onlineFill = false;
    try { onlineFill = !!(map && map.getLayer('helm-chart-online-fill') && map.getLayoutProperty('helm-chart-online-fill', 'visibility') !== 'none'); } catch (e) {}
    if (!pack || inside || onlineFill) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      // Inline styles (not a stylesheet rule): the badge must render correctly even when the Chart
      // Packs panel — which injects the module's <style> — has never opened.
      el = document.createElement('div');
      el.id = 'helm-coverage-badge';
      el.textContent = 'Outside offline chart coverage';
      el.style.cssText = 'position:fixed;top:92px;left:50%;transform:translateX(-50%);z-index:30;padding:5px 12px;border-radius:13px;background:rgba(20,24,30,.9);border:1px solid var(--warn,#e0a23a);color:var(--warn,#e0a23a);font:600 11px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.2px;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      document.body.appendChild(el);
    }
    el.style.display = 'block';
  }

  function onMapMove() {
    if (moveDebounce) clearTimeout(moveDebounce);
    moveDebounce = setTimeout(function () { moveDebounce = null; prefetchViewport(); renderCoverageBadge(); }, 220);
  }
  // Bind moveend ONCE for the life of the map (panel-independent): prefetch + coverage must keep
  // working after the Chart Packs panel is closed, and on page-load restore where it never opened.
  function ensureMoveHook(map) {
    if (moveHookBound || !map || !map.on) return;
    moveHookBound = true;
    map.on('moveend', onMapMove);
  }

  function ensureRasterTapHook(map) {
    if (rasterTapHookBound || !map || !map.on) return;
    rasterTapHookBound = true;
    map.on('click', function (e) {
      var pack = activePack();
      if (!pack || !map.getLayer || !map.getLayer(LAYER_ID)) return;
      try { if (window.__helmMeasure && window.__helmMeasure.active && window.__helmMeasure.active()) return; } catch (ignore) {}
      try {
        var hits = map.queryRenderedFeatures(e.point) || [];
        for (var i = 0; i < hits.length; i++) {
          var f = hits[i], lid = f && f.layer && f.layer.id;
          if (lid && lid !== LAYER_ID) return; // AIS, places, soundings, route editing, etc. own their taps
        }
      } catch (ignore2) {}
      showRasterInspect(pack, e.lngLat, e.point);
    });
  }
  // ===== /CLIENT-22 =========================================================

  function sourceForPack(pack) {
    var src = {
      type: 'raster',
      tileSize: 256,
      minzoom: Number(pack.minzoom || 0),
      maxzoom: packMaxzoom(pack),   // pack's REAL max -> MapLibre overzooms past it (scaled tiles, never a 404-blank)
      attribution: pack.attribution || ''
    };
    if (isPmtilesPack(pack)) src.tiles = [pmtilesTileUrl(pack)];
    else src.tiles = [tileUrl(pack)];
    var b = boundsArray(pack);
    if (b) src.bounds = b;
    return src;
  }

  function installDynamicLayer(pack, attempt) {
    var map = state.map || window.map;
    if (!map || !pack) return;
    if (!(map.getStyle && map.getStyle())) {
      if ((attempt || 0) < 10) setTimeout(function () { installDynamicLayer(pack, (attempt || 0) + 1); }, 100);
      return;
    }
    removeDynamicLayer();
    try {
      map.addSource(SOURCE_ID, sourceForPack(pack));
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: { 'raster-fade-duration': 0, 'raster-opacity': 1 }
      }, beforeLayerId(map));
      applyCurrentThemeTone();
      hideStaticBasemaps();
      ensureMoveHook(map);   // CLIENT-22: keep prefetch+coverage live even with the panel closed
      ensureRasterTapHook(map); // OFFLINE-13: raster taps expose source/freshness/no-object honesty
      onMapMove();           // CLIENT-22: warm the initial viewport ring + set coverage state
    } catch (e) {
      state.error = 'Could not load pack: ' + ((e && e.message) || e);
      if (log && log.warn) log.warn(state.error);
    }
  }

  function addDynamicLayer(pack) {
    if (isPmtilesPack(pack)) {
      ensurePmtilesProtocol()
        .then(function () { installDynamicLayer(pack); })
        .catch(function (e) {
          state.error = 'Could not load PMTiles protocol: ' + ((e && e.message) || e);
          if (log && log.warn) log.warn(state.error);
          renderList();
        });
      return;
    }
    installDynamicLayer(pack);
  }

  function applyCurrentThemeTone() {
    var map = state.map || window.map;
    if (!map || !map.getLayer(LAYER_ID)) return;
    var root = document.documentElement;
    var paint = null;
    if (root.classList.contains('theme-night')) {
      paint = { 'raster-brightness-min': 0, 'raster-brightness-max': 0.3, 'raster-saturation': -0.85, 'raster-contrast': -0.05, 'raster-hue-rotate': 0 };
    } else if (root.classList.contains('theme-dusk')) {
      paint = { 'raster-brightness-min': 0, 'raster-brightness-max': 0.6, 'raster-saturation': -0.32, 'raster-contrast': 0.03, 'raster-hue-rotate': 0 };
    }
    if (!paint) return;
    Object.keys(paint).forEach(function (k) {
      try { map.setPaintProperty(LAYER_ID, k, paint[k]); } catch (e) {}
    });
  }

  function activePack() {
    return state.packs.find(function (p) { return String(p.id) === String(state.activeId); }) || null;
  }

  function persistActive(id) {
    state.activeId = id || null;
    try {
      if (window.HelmStore) {
        if (state.activeId) HelmStore.set(STORE_KEY, state.activeId);
        else HelmStore.remove(STORE_KEY);
      }
    } catch (e) {}
  }

  function activate(id, opts) {
    var pack = state.packs.find(function (p) { return String(p.id) === String(id); });
    if (!pack) return;
    persistActive(pack.id);
    addDynamicLayer(pack);
    renderList();
    if (!opts || opts.fit !== false) fitPack(pack);
  }

  function clearActiveFromStaticChoice() {
    persistActive(null);
    removeDynamicLayer();
    var bd = document.getElementById('helm-coverage-badge'); if (bd) bd.style.display = 'none';   // CLIENT-22
    renderList();
  }

  function fitPack(pack) {
    var map = state.map || window.map;
    var b = boundsArray(pack || activePack());
    if (!map || !b) return;
    try { map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 72, duration: 450 }); } catch (e) {}
  }

  async function fetchCatalog() {
    state.loading = true;
    state.error = '';
    renderList();
    try {
      var r = await fetch(catalogBase() + '/catalog', { cache: 'no-store' });
      if (!r.ok) throw new Error('catalog ' + r.status);
      var json = await r.json();
      state.packs = Object.keys(json || {}).map(function (id) {
        var p = json[id] || {};
        p.id = p.id || id;
        p.title = p.title || id;
        p.extension = p.extension || (p.format === 'jpeg' ? 'jpg' : (p.format || 'png'));
        return p;
      }).sort(function (a, b) {
        return String(a.title || a.id).localeCompare(String(b.title || b.id));
      });
      if (!state.activeId && window.HelmStore) state.activeId = HelmStore.get(STORE_KEY, null);
      if (state.activeId && state.packs.some(function (p) { return String(p.id) === String(state.activeId); })) {
        addDynamicLayer(activePack());
      }
    } catch (e) {
      state.error = 'No local pack catalog on :' + basemapPort();
      state.packs = [];
      if (log && log.info) log.info('catalog unavailable', e && e.message);
    } finally {
      state.loading = false;
      renderList();
    }
  }

  function rowHtml(pack) {
    var active = String(pack.id) === String(state.activeId);
    var status = viewStatus(pack);
    var warn = status === 'outside view' ? '<span class="helm-pack-warn">outside</span>' : '';
    return [
      '<label class="row helm-pack-row' + (active ? ' is-active' : '') + '">',
      '<input type="radio" name="helm-offline-pack" value="' + esc(pack.id) + '"' + (active ? ' checked' : '') + '>',
      '<span class="helm-pack-main"><b>' + esc(pack.title || pack.id) + '</b><i>' + esc(packLine(pack)) + '</i></span>',
      warn,
      '</label>'
    ].join('');
  }

  function renderList() {
    if (!state.body) return;
    var list = state.body.querySelector('[data-pack-list]');
    var status = state.body.querySelector('[data-pack-status]');
    if (!list || !status) return;
    status.textContent = state.loading ? 'Scanning :' + basemapPort() : (state.error || (state.packs.length + ' local pack' + (state.packs.length === 1 ? '' : 's')));
    if (!state.packs.length) {
      list.innerHTML = '<div class="helm-pack-empty">No local packs are visible.</div>';
      return;
    }
    list.innerHTML = state.packs.map(rowHtml).join('');
  }

  function renderPanel(body, ctx) {
    state.body = body;
    state.map = ctx && ctx.map;
    installStyle();
    body.insertAdjacentHTML('beforeend', [
      '<p class="sub">Local chart and basemap packs</p>',
      '<div class="helm-pack-actions">',
      '<button class="conn-btn" type="button" data-pack-refresh>Refresh</button>',
      '<button class="conn-btn" type="button" data-pack-fit>Fit</button>',
      '<span data-pack-status class="helm-pack-status">Scanning</span>',
      '</div>',
      '<div data-pack-list class="helm-pack-list"></div>'
    ].join(''));
    body.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.name === 'helm-offline-pack' && t.checked) activate(t.value);
    });
    body.addEventListener('click', function (e) {
      var refresh = e.target && e.target.closest && e.target.closest('[data-pack-refresh]');
      var fit = e.target && e.target.closest && e.target.closest('[data-pack-fit]');
      if (refresh) fetchCatalog();
      if (fit) fitPack();
    });
    var map = state.map;
    if (map && map.on) {
      map.on('moveend', renderList);
      ensureMoveHook(map);   // CLIENT-22: debounced prefetch ring + coverage badge (bind-once)
      map.on('styledata', function () {
        if (state.activeId && !map.getLayer(LAYER_ID)) addDynamicLayer(activePack());
      });
    }
    fetchCatalog();
  }

  function installStyle() {
    if (document.getElementById('helm-offline-packs-style')) return;
    var style = document.createElement('style');
    style.id = 'helm-offline-packs-style';
    style.textContent = [
      '.helm-pack-actions{display:flex;align-items:center;gap:8px;margin:8px 0 10px}',
      '.helm-pack-status{margin-left:auto;font-size:10px;color:var(--cdim2)}',
      '.helm-pack-list{display:flex;flex-direction:column;gap:6px}',
      '.helm-pack-row{gap:9px;min-height:48px}',
      '.helm-pack-row input{flex:none}',
      '.helm-pack-row.is-active{outline:1px solid rgba(91,192,255,.45);background:rgba(91,192,255,.09)}',
      '.helm-pack-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.helm-pack-main b{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.helm-pack-main i{font-size:10px;color:var(--cdim2);font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.helm-pack-warn{margin-left:auto;font-size:9.5px;color:var(--warn)}',
      '.helm-pack-empty{font-size:11px;color:var(--cdim);padding:10px 0}',
      '.helm-raster-inspect{min-width:250px;max-width:320px;color:var(--ctext,#e8edf2);font:12px/1.35 system-ui,-apple-system,sans-serif}',
      '.helm-raster-inspect h3{font-size:13px;line-height:1.25;margin:0 0 5px;font-weight:700}',
      '.helm-raster-inspect p{margin:0 0 8px;color:var(--cdim,#9ba8b5)}',
      '.helm-raster-inspect-grid{display:grid;grid-template-columns:max-content 1fr;gap:4px 10px}',
      '.helm-raster-inspect-grid div{display:contents}',
      '.helm-raster-inspect-grid b{color:var(--cdim2,#7e8c99);font-weight:600}',
      '.helm-raster-inspect-grid span{min-width:0;overflow-wrap:anywhere}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function bindStaticBasemapFallback() {
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.name === 'basemap' && t.checked) clearActiveFromStaticChoice();
    }, true);
  }

  function register() {
    if (!(window.HelmShell && HelmShell.registerPanel)) return;
    HelmShell.registerPanel({
      id: PANEL_ID,
      epic: EPIC,
      title: 'Chart Packs',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 6h16v12H4z"/><path d="M8 6v12"/><path d="M16 6v12"/><path d="M4 10h16"/><path d="M4 14h16"/></svg>',
      render: renderPanel,
      onOpen: function () { renderList(); }
    });
    if (HelmShell.registerCommand) {
      HelmShell.registerCommand({
        id: 'helm-offline-open-packs',
        epic: EPIC,
        title: 'Open chart packs',
        subtitle: 'Local MBTiles and PMTiles',
        keywords: ['offline', 'mbtiles', 'pmtiles', 'charts', 'basemap'],
        group: 'Layers',
        run: function () { var h = HelmShell.panel(PANEL_ID); if (h) h.open(); }
      });
    }
  }

  bindStaticBasemapFallback();
  register();
  // CLIENT-22: bind the viewport prefetch/coverage hook as soon as the REAL map exists, independent
  // of panel-render or pack-activation timing — both were unreliable (panel may be lazy; restore can
  // run before window.map has .on, see other modules' "map.on is not a function" deferral).
  (function waitForMap(attempt) {
    if (window.map && typeof window.map.on === 'function') { ensureMoveHook(window.map); onMapMove(); return; }
    if ((attempt || 0) < 150) setTimeout(function () { waitForMap((attempt || 0) + 1); }, 100);
  })(0);
  window.HelmOfflinePacks = {
    refresh: fetchCatalog,
    activate: activate,
    fit: fitPack,
    state: state
  };
})();
