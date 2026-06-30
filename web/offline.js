// web/offline.js — OFFLINE-3: the real Download drawer (lasso → size estimate → fetch_tiles handoff)
// ------------------------------------------------------------------------------------------------
// Turns the #drawer-download MOCKUP into a working "cache only the passage corridor" panel:
//   • pick a tile source (real XYZ templates from style.json)
//   • lasso an area on the chart (reuses integrations/draw.js — it already publishes `helm:bbox`),
//     or fall back to the current map view
//   • set zoom caps (sane defaults z9–15, hard-capped so a stray drag can't queue a runaway download)
//   • see a LIVE tile-count + size estimate before committing a byte (deg2num mirrors fetch_tiles.py)
//   • get the exact `pipeline/fetch_tiles.py …` command, copyable — a SAFE handoff with no fetch
//     logic in the frontend. requestDownload() is the single seam a backend POST /tiles can replace
//     later without touching the UI.
//
// Stays in-lane: fills the EXISTING legacy download drawer (its rail button + opener are already
// wired in index.html) rather than registering a second rail icon. All CSS scoped under
// #drawer-download. Owns no shell plumbing.
(function () {
  'use strict';
  var EL = document.getElementById('drawer-download');
  if (!EL) { console.warn('[offline] #drawer-download missing — OFFLINE-3 UI not mounted'); return; }

  // ---- tile sources: real XYZ templates (web/style.json). NOAA ENC is the public-internet one and
  //      the sensible default (fetch_tiles.py can reach it headless); the rest need a local server. ----
  var SOURCES = [
    { id: 'noaa',      label: 'NOAA ENC charts',       url: 'https://tileservice.charts.noaa.gov/tiles/50000_1/{z}/{x}/{y}.png', fmt: 'png', kb: 12, note: 'public · free' },
    { id: 'eox',       label: 'Sentinel-2 (EOX)',      url: 'http://localhost:8095/basemap/eox/{z}/{x}/{y}.jpg',                 fmt: 'jpg', kb: 26, note: 'needs :8095 online-fill' },
    { id: 'navionics', label: 'Navionics (proxy)',     url: 'http://localhost:8091/navionics/{z}/{x}/{y}.png',                  fmt: 'png', kb: 22, note: 'needs :8091 basemap' },
    { id: 'googlesat', label: 'Google satellite',      url: 'http://localhost:8091/googlesat/{z}/{x}/{y}.jpg',                  fmt: 'jpg', kb: 30, note: 'personal use' },
    { id: 'custom',    label: 'Custom {z}/{x}/{y}…',    url: '',                                                                  fmt: 'png', kb: 20, note: 'paste an XYZ template below' }
  ];

  // Zoom caps — charts rarely render past ~16; the hard cap stops a deep span from queuing millions
  // of tiles. SOFT_TILES warns; HARD_TILES blocks the command (fail-loud, never a silent runaway).
  var ZMIN_FLOOR = 1, ZMAX_CEIL = 16, SOFT_TILES = 40000, HARD_TILES = 250000;

  // ---- tile math — mirrors pipeline/fetch_tiles.deg2num so the estimate matches what gets fetched ----
  function deg2num(lon, lat, z) {
    var n = Math.pow(2, z);
    var x = Math.floor((lon + 180) / 360 * n);
    var y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    var clamp = function (v) { return Math.max(0, Math.min(n - 1, v)); };
    return [clamp(x), clamp(y)];
  }
  function tileCount(bbox, zmin, zmax) {
    if (!bbox || zmax < zmin) return 0;
    var w = bbox[0], s = bbox[1], e = bbox[2], nn = bbox[3], total = 0;
    for (var z = zmin; z <= zmax; z++) {
      var nw = deg2num(w, nn, z), se = deg2num(e, s, z);
      total += (Math.abs(se[0] - nw[0]) + 1) * (Math.abs(se[1] - nw[1]) + 1);
    }
    return total;
  }
  function human(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
  function humanMB(kb) { return kb >= 1024 ? (kb / 1024).toFixed(1) + ' GB' : Math.max(1, Math.round(kb)) + ' MB'; }

  // ---- scoped styles (one injection; every selector under #drawer-download) ----
  (function () {
    var css = document.createElement('style');
    css.textContent =
      '#drawer-download{width:316px}' +
      '#drawer-download .dl-fld{margin:10px 0 4px;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--cdim,#9bb0c0)}' +
      '#drawer-download select,#drawer-download input[type=text]{width:100%;box-sizing:border-box;font:12px/1.3 inherit;color:#e6eef5;' +
        'background:rgba(255,255,255,.05);border:.5px solid var(--line,rgba(255,255,255,.14));border-radius:8px;padding:7px 9px}' +
      '#drawer-download .dl-src-note{font-size:10px;color:var(--cdim,#9bb0c0);margin-top:4px}' +
      '#drawer-download .dl-row{display:flex;gap:8px;align-items:center;margin-top:6px}' +
      '#drawer-download .dl-row button{flex:1;font:500 11.5px/1 inherit;padding:8px 6px;border-radius:8px;cursor:pointer;' +
        'border:.5px solid var(--line,rgba(255,255,255,.14));background:transparent;color:#cdd9e3}' +
      '#drawer-download .dl-row button.pri{background:rgba(67,209,125,.16);border-color:rgba(67,209,125,.55);color:#a4f4c1}' +
      '#drawer-download .dl-bbox{font:11px/1.4 ui-monospace,Menlo,monospace;color:#cdd9e3;background:rgba(255,255,255,.04);' +
        'border:.5px solid var(--line,rgba(255,255,255,.1));border-radius:7px;padding:6px 8px;margin-top:6px;word-break:break-all}' +
      '#drawer-download .dl-bbox.none{color:var(--cdim,#9bb0c0)}' +
      '#drawer-download .dl-zooms{display:flex;gap:10px;margin-top:4px}' +
      '#drawer-download .dl-zooms label{flex:1;font-size:10.5px;color:var(--cdim,#9bb0c0)}' +
      '#drawer-download .dl-zooms input{width:100%;box-sizing:border-box;font:12px inherit;color:#e6eef5;text-align:center;' +
        'background:rgba(255,255,255,.05);border:.5px solid var(--line,rgba(255,255,255,.14));border-radius:8px;padding:6px}' +
      '#drawer-download .dl-est{margin-top:10px;font-size:12.5px;color:#e6eef5;display:flex;justify-content:space-between;align-items:baseline}' +
      '#drawer-download .dl-est b{font-variant-numeric:tabular-nums}' +
      '#drawer-download .dl-est .warn{color:var(--warn,#ffc06a)}' +
      '#drawer-download .dl-est .danger{color:var(--danger,#ff6a6a)}' +
      '#drawer-download .dl-cmd{margin-top:9px;font:10.5px/1.4 ui-monospace,Menlo,monospace;color:#bfe9cf;white-space:pre-wrap;word-break:break-all;' +
        'background:rgba(8,14,20,.7);border:.5px solid var(--line,rgba(255,255,255,.1));border-radius:8px;padding:8px 9px;max-height:120px;overflow:auto}' +
      '#drawer-download .dl-copy{margin-top:7px;width:100%;font:500 11.5px/1 inherit;padding:8px;border-radius:8px;cursor:pointer;' +
        'border:.5px solid var(--line,rgba(255,255,255,.14));background:transparent;color:#cdd9e3}' +
      '#drawer-download .dl-copy:disabled{opacity:.4;cursor:not-allowed}';
    document.head.appendChild(css);
  })();

  // ---- state ----
  var bbox = (Array.isArray(window.__helmBbox) ? window.__helmBbox : null);
  var sourceId = 'noaa';
  var customUrl = '';

  // ---- build the panel body (keeps the existing <h2> the drawer already has) ----
  EL.querySelectorAll(':scope > *:not(h2)').forEach(function (n) { n.remove(); });  // strip any mock remnants

  var sub = el('p', 'sub', 'Cache only what you need · lasso an area, then run the on-device tiler.');
  EL.appendChild(sub);

  EL.appendChild(el('div', 'dl-fld', 'Source'));
  var sel = document.createElement('select');
  SOURCES.forEach(function (s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.label; sel.appendChild(o); });
  EL.appendChild(sel);
  var srcNote = el('div', 'dl-src-note', '');
  EL.appendChild(srcNote);
  var customWrap = document.createElement('input'); customWrap.type = 'text';
  customWrap.placeholder = 'https://…/{z}/{x}/{y}.png'; customWrap.style.marginTop = '6px'; customWrap.hidden = true;
  EL.appendChild(customWrap);

  EL.appendChild(el('div', 'dl-fld', 'Area'));
  var rowArea = el('div', 'dl-row');
  var btnLasso = btn('▢ Select area', 'pri'); var btnView = btn('Use current view');
  rowArea.appendChild(btnLasso); rowArea.appendChild(btnView); EL.appendChild(rowArea);
  var bboxEl = el('div', 'dl-bbox none', 'No area selected — lasso a box or use the current view.');
  EL.appendChild(bboxEl);

  EL.appendChild(el('div', 'dl-fld', 'Zoom range (detail)'));
  var zooms = el('div', 'dl-zooms');
  var zmin = numIn('min', 9), zmax = numIn('max', 15);
  zooms.appendChild(zlabel('min zoom', zmin)); zooms.appendChild(zlabel('max zoom', zmax));
  EL.appendChild(zooms);

  var est = el('div', 'dl-est'); est.innerHTML = '<span>Estimate</span><b>—</b>'; EL.appendChild(est);
  var cmd = el('div', 'dl-cmd', '# select an area to generate the fetch command'); EL.appendChild(cmd);
  var copy = document.createElement('button'); copy.className = 'dl-copy'; copy.textContent = 'Copy command'; copy.disabled = true; EL.appendChild(copy);
  EL.appendChild(el('div', 'hint', 'Safe handoff — runs pipeline/fetch_tiles.py (no fetch logic in the browser). See docs/CHART-PIPELINE.md.'));

  // ---- helpers to build elements ----
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function btn(txt, cls) { var b = document.createElement('button'); b.type = 'button'; b.textContent = txt; if (cls) b.classList.add(cls); return b; }
  function numIn(name, val) { var i = document.createElement('input'); i.type = 'number'; i.value = val; i.min = ZMIN_FLOOR; i.max = ZMAX_CEIL; i.step = 1; return i; }
  function zlabel(txt, input) { var l = document.createElement('label'); l.textContent = txt; l.appendChild(input); return l; }

  function source() { var s = SOURCES.filter(function (x) { return x.id === sourceId; })[0] || SOURCES[0]; return s; }
  function slug() { return source().id + '-' + (bbox ? bbox.join('_').replace(/[.\-]/g, function (c) { return c === '-' ? 'm' : 'p'; }) : 'area'); }

  // ---- the one seam a backend POST /tiles could replace later ----
  function fetchCommand(s, b, lo, hi) {
    return 'python3 pipeline/fetch_tiles.py \\\n' +
      '  --source "' + (s.id === 'custom' ? (customUrl || '{z}/{x}/{y}.png') : s.url) + '" \\\n' +
      '  --bbox "' + b.join(',') + '" \\\n' +
      '  --minzoom ' + lo + ' --maxzoom ' + hi + ' --fmt ' + s.fmt + ' \\\n' +
      '  --out web/data/' + slug() + '.mbtiles \\\n' +
      '  --name "' + s.label + ' ' + b.join(',') + '"';
  }

  // ---- recompute estimate + command on any change ----
  function clampZoom() {
    var lo = Math.max(ZMIN_FLOOR, Math.min(ZMAX_CEIL, parseInt(zmin.value, 10) || 9));
    var hi = Math.max(ZMIN_FLOOR, Math.min(ZMAX_CEIL, parseInt(zmax.value, 10) || 15));
    if (hi < lo) hi = lo;
    if (String(lo) !== zmin.value) zmin.value = lo;
    if (String(hi) !== zmax.value) zmax.value = hi;
    return [lo, hi];
  }
  function refresh() {
    var s = source(); var z = clampZoom();
    srcNote.textContent = s.note + (s.id === 'custom' ? '' : '  ·  ' + s.url.replace('{z}/{x}/{y}', '{z}/{x}/{y}'));
    customWrap.hidden = (s.id !== 'custom');
    if (!bbox) {
      bboxEl.className = 'dl-bbox none'; bboxEl.textContent = 'No area selected — lasso a box or use the current view.';
      est.innerHTML = '<span>Estimate</span><b>—</b>'; cmd.textContent = '# select an area to generate the fetch command';
      copy.disabled = true; return;
    }
    bboxEl.className = 'dl-bbox'; bboxEl.textContent = 'bbox  ' + bbox.join(', ');
    var tiles = tileCount(bbox, z[0], z[1]);
    var mb = tiles * s.kb / 1024;
    var cls = tiles > HARD_TILES ? 'danger' : tiles > SOFT_TILES ? 'warn' : '';
    var note = tiles > HARD_TILES ? ' · too large — tighten zoom/area' : tiles > SOFT_TILES ? ' · large' : '';
    est.innerHTML = '<span>Estimate</span><b class="' + cls + '">~' + human(tiles) + ' tiles · ~' + humanMB(mb) + note + '</b>';
    if (tiles > HARD_TILES) {
      cmd.textContent = '# ' + human(tiles) + ' tiles exceeds the safety cap (' + human(HARD_TILES) + ').\n# Tighten the area or lower max zoom before downloading.';
      copy.disabled = true;
    } else {
      cmd.textContent = fetchCommand(s, bbox, z[0], z[1]); copy.disabled = false;
    }
  }

  // ---- area selection ----
  function setBbox(b) { if (Array.isArray(b) && b.length === 4) { bbox = b.map(function (n) { return +(+n).toFixed(4); }); refresh(); } }
  btnLasso.addEventListener('click', function () {
    var map = window.map;
    import('./integrations/draw.js')
      .then(function (m) { m.lasso(map, { notify: toast }); toast('Drag a rectangle over the area to cache', 'info'); })
      .catch(function (e) { console.error('[offline] draw load failed', e); toast('Could not start area select', 'warn'); });
  });
  btnView.addEventListener('click', function () {
    var map = window.map; if (!map || !map.getBounds) { toast('Map not ready', 'warn'); return; }
    var b = map.getBounds();
    setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  });
  window.addEventListener('helm:bbox', function (e) { setBbox(e.detail); });

  // copy
  copy.addEventListener('click', function () {
    var text = cmd.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Command copied', 'ok'); }, function () { toast('Copy failed', 'warn'); });
    } else { toast('Clipboard unavailable', 'warn'); }
  });

  // input wiring
  sel.addEventListener('change', function () { sourceId = sel.value; refresh(); });
  customWrap.addEventListener('input', function () { customUrl = customWrap.value.trim(); refresh(); });
  zmin.addEventListener('input', refresh); zmax.addEventListener('input', refresh);
  zmin.addEventListener('change', refresh); zmax.addEventListener('change', refresh);

  // a tiny toast (independent of lab.js so this panel stands alone)
  function toast(msg, kind) {
    var host = document.getElementById('helm-toast');
    if (!host) { host = document.createElement('div'); host.id = 'helm-toast';
      host.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:20;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none';
      document.body.appendChild(host); }
    var colors = { ok: '#46e0a0', warn: '#ffc06a', info: '#5bc0ff' };
    var e = document.createElement('div'); e.textContent = msg;
    e.style.cssText = 'font:12px/1.3 -apple-system,sans-serif;color:#eef4f9;background:rgba(13,19,27,.86);border:.5px solid ' + (colors[kind] || colors.info) + ';border-radius:10px;padding:7px 13px;opacity:0;transition:opacity .25s';
    host.appendChild(e); requestAnimationFrame(function () { e.style.opacity = '1'; });
    setTimeout(function () { e.style.opacity = '0'; setTimeout(function () { e.remove(); }, 300); }, 3600);
  }

  refresh();
  console.info('[offline] OFFLINE-3 download drawer ready');
})();
