// HelmMeasure — range/bearing planning lines with explicit DRAW and EDIT modes.
//
// DRAW mode: tap the chart to drop points; ⏎ or double-tap finishes a line — it stays, with per-leg
//   range·bearing labels. Draw as many as you like. Backspace drops the last point.
// EDIT mode: tap a line to select it; drag any vertex to move it; Delete removes the selected line.
//   "Clear all" wipes every line. No new points are added in EDIT mode.
// Switch with the Draw/Edit toggle in the HUD. Lines persist across reloads (HelmStore) and stay drawn
// when the tool is closed. Units: nautical miles + degrees true (great-circle).
(function () {
  const R = 3440.065;
  const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
  function dist(a, b) {
    const dLat = toR(b[1] - a[1]), dLon = toR(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function brg(a, b) {
    const y = Math.sin(toR(b[0] - a[0])) * Math.cos(toR(b[1]));
    const x = Math.cos(toR(a[1])) * Math.sin(toR(b[1])) - Math.sin(toR(a[1])) * Math.cos(toR(b[1])) * Math.cos(toR(b[0] - a[0]));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }
  const mid = (a, b) => [a[0] + (b[0] - a[0]) / 2, a[1] + (b[1] - a[1]) / 2];
  const fmtNM = nm => (nm < 1 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM';
  const fmtBrg = d => String(Math.round(d) % 360).padStart(3, '0') + '°';

  window.HelmMeasure = function (map, opts) {
    opts = opts || {};
    const onChange = opts.onChange || function () {};
    const COL = opts.color || '#5bc0ff', HI = '#9fe0ff', STORE = 'measure.lines';

    let active = false, mode = 'draw';            // tool open?  ·  'draw' | 'edit'
    let lines = [];                               // [{ id, pts:[[lng,lat], …] }]
    let cur = null;                               // selected / drawing line id, or null
    let drawing = false, cursor = null, drag = null, justDragged = false;
    let _seq = 0; const uid = () => 'm' + (++_seq);
    const lineById = id => lines.find(l => l.id === id);

    function persist() { try { if (window.HelmStore) HelmStore.set(STORE, lines.map(l => l.pts)); } catch (e) {} }
    function load() {
      try { const raw = window.HelmStore ? (HelmStore.get(STORE, []) || []) : [];
        return raw.filter(a => Array.isArray(a) && a.length >= 2).map(pts => ({ id: uid(), pts: pts.slice() }));
      } catch (e) { return []; }
    }

    // ---- HUD ----
    const st = document.createElement('style');
    st.textContent =
      '.measure-hud .mseg{display:inline-flex;border:.5px solid var(--line);border-radius:8px;overflow:hidden;flex:none}' +
      '.measure-hud .mmode{border:0;background:transparent;color:var(--cdim);font:inherit;font-size:12px;padding:5px 11px;cursor:pointer}' +
      '.measure-hud .mmode+.mmode{border-left:.5px solid var(--line)}' +
      '.measure-hud .mmode.on{background:var(--accent);color:#05121d;font-weight:600}' +
      '.measure-hud .mbody{min-width:108px}' +
      '.measure-hud .mbtn{border:.5px solid var(--line);background:transparent;color:var(--ctext);font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;flex:none}' +
      '.measure-hud .mbtn:disabled{opacity:.38;cursor:default}' +
      '.measure-hud .mbtn:hover:not(:disabled){background:var(--glass2)}';
    document.head.appendChild(st);

    const hud = document.createElement('div');
    hud.className = 'measure-hud glass'; hud.hidden = true;
    hud.innerHTML =
      '<div class="mseg"><button class="mmode" id="measure-m-draw">✏ Draw</button><button class="mmode" id="measure-m-edit">Edit</button></div>' +
      '<div class="mbody"><div class="mt" id="measure-total">0 NM</div><div class="ms" id="measure-sub">Tap the chart to start</div></div>' +
      '<button class="mbtn" id="measure-del" title="Delete the selected line">Delete</button>' +
      '<button class="mbtn" id="measure-clearall" title="Delete every line">Clear all</button>' +
      '<div class="mx" id="measure-close" title="Close measure">✕</div>';
    document.body.appendChild(hud);
    const elTotal = hud.querySelector('#measure-total'), elSub = hud.querySelector('#measure-sub');
    const elDraw = hud.querySelector('#measure-m-draw'), elEdit = hud.querySelector('#measure-m-edit');
    const elDel = hud.querySelector('#measure-del'), elClear = hud.querySelector('#measure-clearall');
    elDraw.addEventListener('click', () => setMode('draw'));
    elEdit.addEventListener('click', () => setMode('edit'));
    elDel.addEventListener('click', deleteCur);
    elClear.addEventListener('click', clearAll);
    hud.querySelector('#measure-close').addEventListener('click', () => setActive(false));

    // ---- map source + layers ----
    function ensureLayers() {
      if (!map.getStyle || !map.getStyle() || map.getSource('measure')) return;
      map.addSource('measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'measure-line', type: 'line', source: 'measure', filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['get', 'sel'], HI, COL], 'line-width': ['case', ['get', 'sel'], 3.5, 2.5] }
      });
      map.addLayer({
        id: 'measure-preview', type: 'line', source: 'measure', filter: ['==', ['get', 'kind'], 'preview'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': COL, 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [1.5, 1.5] }
      });
      map.addLayer({
        id: 'measure-points', type: 'circle', source: 'measure', filter: ['==', ['get', 'kind'], 'vertex'],
        paint: {
          'circle-radius': ['case', ['get', 'sel'], 6.5, 4.5], 'circle-color': ['case', ['get', 'sel'], HI, COL],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5
        }
      });
      map.addLayer({
        id: 'measure-labels', type: 'symbol', source: 'measure', filter: ['==', ['get', 'kind'], 'label'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -0.9], 'text-allow-overlap': true },
        paint: { 'text-color': '#eef4f9', 'text-halo-color': 'rgba(5,8,12,0.9)', 'text-halo-width': 1.4 }
      });
      map.on('mouseenter', 'measure-points', () => { if (active && !(mode === 'draw' && drawing)) map.getCanvas().style.cursor = 'grab'; });
      map.on('mouseleave', 'measure-points', () => { if (active) map.getCanvas().style.cursor = (mode === 'draw') ? 'crosshair' : ''; });
      map.on('mouseenter', 'measure-line', () => { if (active && mode === 'edit') map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'measure-line', () => { if (active && mode === 'edit') map.getCanvas().style.cursor = ''; });
      ['mousedown', 'touchstart'].forEach(ev => map.on(ev, 'measure-points', startDrag));
    }

    // ---- render ----
    function build() {
      ensureLayers();
      const feats = [];
      lines.forEach(L => {
        const sel = (L.id === cur);
        if (L.pts.length >= 2) feats.push({ type: 'Feature', properties: { kind: 'line', sel, lid: L.id }, geometry: { type: 'LineString', coordinates: L.pts } });
        for (let i = 0; i < L.pts.length - 1; i++) feats.push({
          type: 'Feature', properties: { kind: 'label', label: fmtNM(dist(L.pts[i], L.pts[i + 1])) + ' · ' + fmtBrg(brg(L.pts[i], L.pts[i + 1])) },
          geometry: { type: 'Point', coordinates: mid(L.pts[i], L.pts[i + 1]) }
        });
        L.pts.forEach((p, idx) => feats.push({ type: 'Feature', properties: { kind: 'vertex', sel, lid: L.id, idx }, geometry: { type: 'Point', coordinates: p } }));
      });
      if (active && mode === 'draw' && drawing && cur != null && cursor) {
        const L = lineById(cur);
        if (L && L.pts.length >= 1) feats.push({ type: 'Feature', properties: { kind: 'preview' }, geometry: { type: 'LineString', coordinates: [L.pts[L.pts.length - 1], cursor] } });
      }
      const src = map.getSource('measure'); if (src) src.setData({ type: 'FeatureCollection', features: feats });
      updateHud();
    }

    function updateHud() {
      if (!active) { hud.hidden = true; return; }
      hud.hidden = false;
      elDraw.classList.toggle('on', mode === 'draw');
      elEdit.classList.toggle('on', mode === 'edit');
      const L = cur != null ? lineById(cur) : null;
      if (L) {
        let leg = null, legBrg = null, extra = 0;
        if (mode === 'draw' && drawing && cursor && L.pts.length >= 1) { leg = dist(L.pts[L.pts.length - 1], cursor); legBrg = brg(L.pts[L.pts.length - 1], cursor); extra = leg; }
        else if (L.pts.length >= 2) { leg = dist(L.pts[L.pts.length - 2], L.pts[L.pts.length - 1]); legBrg = brg(L.pts[L.pts.length - 2], L.pts[L.pts.length - 1]); }
        let t = 0; for (let i = 0; i < L.pts.length - 1; i++) t += dist(L.pts[i], L.pts[i + 1]); t += extra;
        elTotal.textContent = fmtNM(t);
        elSub.textContent = mode === 'draw'
          ? (leg != null ? 'leg ' + fmtNM(leg) + ' · ' + fmtBrg(legBrg) + 'T · ⏎ to finish' : 'Tap to add · ⏎ or double-tap to finish')
          : 'Selected · drag a point to move · Delete to remove';
      } else {
        elTotal.textContent = lines.length ? (lines.length + (lines.length === 1 ? ' line' : ' lines')) : '0 NM';
        elSub.textContent = mode === 'draw' ? 'Tap the chart to start a line'
          : (lines.length ? 'Tap a line to select it' : 'No lines — switch to Draw to make one');
      }
      elDel.disabled = (cur == null);
      elClear.disabled = (lines.length === 0);
    }

    // pick a saved line (or its vertex) under a click, with a generous tolerance
    function pickLine(pt) {
      try { const b = 9;
        const box = [[pt.x - b, pt.y - b], [pt.x + b, pt.y + b]];
        let fs = map.queryRenderedFeatures(box, { layers: ['measure-line'] });
        if (fs && fs.length) return fs[0].properties.lid;
        fs = map.queryRenderedFeatures(box, { layers: ['measure-points'] });
        return (fs && fs.length) ? fs[0].properties.lid : null;
      } catch (e) { return null; }
    }

    // ---- interaction ----
    function onClick(e) {
      if (!active || justDragged) { justDragged = false; return; }
      if (mode === 'edit') { cur = e.point ? pickLine(e.point) : null; build(); return; }   // select / deselect only
      const p = [e.lngLat.lng, e.lngLat.lat];
      if (!drawing) { const L = { id: uid(), pts: [p] }; lines.push(L); cur = L.id; drawing = true; }
      else lineById(cur).pts.push(p);
      persist(); build();
    }
    function onMove(e) { if (!active || mode !== 'draw' || !drawing || cur == null) return; cursor = [e.lngLat.lng, e.lngLat.lat]; build(); }
    function finish() {
      if (cur != null) { const L = lineById(cur); if (L && L.pts.length < 2) lines = lines.filter(x => x.id !== cur); }
      drawing = false; cursor = null; cur = null; persist(); build();
    }
    function onDbl(e) {
      if (!active || mode !== 'draw') return; if (e && e.preventDefault) e.preventDefault();
      if (cur != null && drawing) { const L = lineById(cur); if (L) L.pts.pop(); }
      finish();
    }
    function deleteCur() {
      if (cur == null) return;
      lines = lines.filter(x => x.id !== cur); cur = null; drawing = false; cursor = null; persist(); build();
    }
    function clearAll() {
      if (!lines.length && cur == null) return;
      lines = []; cur = null; drawing = false; cursor = null; persist(); build();
    }
    function onKey(e) {
      if (!active) return;
      if (e.key === 'Escape') { if (mode === 'draw' && drawing) finish(); else setActive(false); }
      else if (e.key === 'Enter') { if (mode === 'draw' && drawing) finish(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (mode === 'draw' && drawing && cur != null) {
          const L = lineById(cur);
          if (L && L.pts.length) { L.pts.pop(); if (!L.pts.length) { lines = lines.filter(x => x.id !== cur); cur = null; drawing = false; } persist(); build(); }
        } else if (mode === 'edit' && cur != null) { deleteCur(); }   // Delete key removes the selected line
      }
    }

    // ---- drag a vertex (mouse + touch) — only when not actively drawing ----
    function startDrag(e) {
      if (!active || (mode === 'draw' && drawing)) return;
      const f = e.features && e.features[0]; if (!f) return;
      e.preventDefault();
      cur = f.properties.lid; drag = { id: f.properties.lid, idx: f.properties.idx };
      const touch = e.type === 'touchstart';
      const mv = touch ? 'touchmove' : 'mousemove', up = touch ? 'touchend' : 'mouseup';
      map.dragPan.disable();
      const move = (ev) => { if (!drag) return; const L = lineById(drag.id); if (L) { L.pts[drag.idx] = [ev.lngLat.lng, ev.lngLat.lat]; build(); } };
      const end = () => { map.off(mv, move); drag = null; justDragged = true; map.dragPan.enable(); persist(); };
      map.on(mv, move); map.once(up, end);
      build();
    }

    function setMode(m) {
      if (!active || m === mode) return;
      if (mode === 'draw' && drawing) finish();     // leaving draw → commit any in-progress line first
      mode = m; drawing = false; cursor = null;
      map.getCanvas().style.cursor = (m === 'draw') ? 'crosshair' : '';
      build();
    }
    function setActive(on) {
      if (on === active) return;
      active = on;
      if (on) { mode = 'draw'; cur = null; drawing = false; cursor = null; map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair'; }
      else { map.doubleClickZoom.enable(); drawing = false; cur = null; cursor = null; map.getCanvas().style.cursor = ''; lines = lines.filter(l => l.pts.length >= 2); persist(); }
      build(); onChange(active);
    }

    lines = load();
    map.on('click', onClick);
    map.on('mousemove', onMove);
    map.on('dblclick', onDbl);
    document.addEventListener('keydown', onKey);
    if (map.isStyleLoaded && map.isStyleLoaded()) build(); else map.once('load', build);

    const api = {
      toggle: () => setActive(!active),
      setActive, active: () => active,
      setMode, mode: () => mode,
      deleteSel: deleteCur, clear: deleteCur,        // delete the selected line
      clearAll, count: () => lines.length, selected: () => cur
    };
    window.__helmMeasure = api;
    return api;
  };
})();
