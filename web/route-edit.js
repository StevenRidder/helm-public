// route-edit.js — ROUTE-3 · direct-manipulation route/waypoint editor.
// ------------------------------------------------------------------------------------------------
// The interactive VERBS that close the single biggest functional gap: tap-to-add, long-press-insert,
// drag-a-waypoint-with-live-recompute, delete, reverse, split — plus drop-by-lat/lon (ROUTE-5). It
// lives in its OWN file (per the ROUTE epic's ownership), NOT in nav-source.js (that's only the sim).
//
// ── HOW IT COMMITS (the contract) ───────────────────────────────────────────────────────────────
// The Helm engine's command-plane (CONTRACT's dispatch seam, helm_server.cpp) speaks exactly four
// route verbs: route.create / route.list / route.activate / route.delete. There is NO server-side
// move/insert/split — and there shouldn't be: route.create is defined as "create/replace the ACTIVE
// route" (it swaps the live ROUTE, persists it to navobj.db, and streams the new geometry straight
// back). So EVERY structural edit here is expressed by manipulating geometry locally with live
// recompute, then committing the whole route with ONE route.create — the same verb ROUTE-1's draw
// tool already uses (see integrations/draw.js). points are [[lat,lon],…]; the engine reads p[0]=lat.
//
// Replies (route.ack / route.list) arrive on the nav socket and are dispatched to onCommand by
// index.html → we expose HelmRouteEdit.onCommand(msg) so the shell can fan replies to us too. The
// edited geometry then rides back on the next nav frame as s.route and re-renders via the existing
// updateRouteFromEngine() — one round-trip, one source of truth (the engine).
//
// ── WIRING ──────────────────────────────────────────────────────────────────────────────────────
//   • The EDIT TAB of the consolidated Routes drawer — controls + the live waypoint list. This
//     module exposes mount()/onShow(); routes.js hosts the single "Routes" rail button + Saved|Edit
//     tabs and surfaces this workspace into #route-edit-host (no separate rail button anymore).
//   • Two ⌘K COMMANDS    (helm-route-edit-*)       — toggle editing, reverse the route.
//   • A STYLE FRAGMENT   (helm-route-edit-*)       — the draggable vertex + insert-ghost handles.
// All ids namespaced helm-route-*.
(function () {
  'use strict';
  if (!window.HelmShell) { console.warn('[route-edit] HelmShell missing — not loading'); return; }

  // ── great-circle math (mirrors nav-source.js / OpenCPN Routeman so the readouts match) ──────────
  var R = 3440.065;                                  // earth radius, nautical miles
  var toR = function (d) { return d * Math.PI / 180; }, toD = function (r) { return r * 180 / Math.PI; };
  function distNM(a, b) {                             // a,b = [lon,lat]
    var dLat = toR(b[1] - a[1]), dLon = toR(b[0] - a[0]);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {                            // initial bearing a→b, degrees
    var y = Math.sin(toR(b[0] - a[0])) * Math.cos(toR(b[1]));
    var x = Math.cos(toR(a[1])) * Math.sin(toR(b[1])) -
            Math.sin(toR(a[1])) * Math.cos(toR(b[1])) * Math.cos(toR(b[0] - a[0]));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }
  function fmtNM(nm) { return (nm < 10 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM'; }
  function fmtLatLon(c) {                             // c = [lon,lat]
    function f(v, pos, neg) { var h = v >= 0 ? pos : neg; v = Math.abs(v); var d = Math.floor(v); return d + '°' + ((v - d) * 60).toFixed(2) + '′' + h; }
    return f(c[1], 'N', 'S') + ' ' + f(c[0], 'E', 'W');
  }
  // total length of a [[lon,lat],…] polyline
  function totalNM(pts) { var t = 0; for (var i = 0; i < pts.length - 1; i++) t += distNM(pts[i], pts[i + 1]); return t; }
  // index of the polyline SEGMENT nearest to a click, plus the squared pixel distance to it. We
  // compare in projected pixels (via map.project) so "nearest leg" matches what the eye sees.
  function nearestSegment(map, pts, lngLat) {
    if (pts.length < 2) return { seg: -1, d2: Infinity };
    var P = map.project(lngLat), best = -1, bestD2 = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var A = map.project({ lng: pts[i][0], lat: pts[i][1] });
      var B = map.project({ lng: pts[i + 1][0], lat: pts[i + 1][1] });
      var d2 = segDist2(P, A, B);
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return { seg: best, d2: bestD2 };
  }
  function segDist2(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y, wx = p.x - a.x, wy = p.y - a.y;
    var len2 = vx * vx + vy * vy;
    var t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    var dx = a.x + t * vx - p.x, dy = a.y + t * vy - p.y;
    return dx * dx + dy * dy;
  }
  function nearestVertex(map, pts, lngLat, tolPx) {   // returns vertex index within tolPx, else -1
    var P = map.project(lngLat), best = -1, bestD2 = tolPx * tolPx;
    for (var i = 0; i < pts.length; i++) {
      var V = map.project({ lng: pts[i][0], lat: pts[i][1] });
      var dx = V.x - P.x, dy = V.y - P.y, d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }

  // ── module state ────────────────────────────────────────────────────────────────────────────
  var map = null;                  // set on first panel render (ctx.map)
  var pts = [];                    // WORKING geometry while editing — [[lon,lat],…] (source of truth).
                                   //   each element MAY carry a `.name` (custom waypoint name) — array
                                   //   element objects preserve it across reverse/splice/slice.
  var routeName = 'Route';
  var editing = false;             // is edit mode armed?
  var dirty = false;               // local edits not yet committed to the engine
  var dragIdx = -1;                // vertex being dragged, or -1
  var lpTimer = null, lpLngLat = null;   // long-press detection
  var listEl = null, msgEl = null, statusEl = null, btnEdit = null, countEl = null, lenEl = null, routeNameInput = null;
  var msgTimer = null;
  var VERTEX_TOL = 14;             // px hit-radius for grabbing a vertex
  var LEG_TOL = 16;                // px hit-radius for inserting on a leg
  var LP_MS = 480;                 // long-press threshold

  // ── editor handle layers (own style fragment, namespaced helm-route-*) ──────────────────────────
  // A geojson source the editor drives directly. The active route LINE is still owned by ROUTE-2's
  // `route` source / route-line layer; these are just the grab handles painted on top while editing.
  HelmShell.registerStyleFragment('ROUTE', {
    sources: {
      'helm-route-edit-pts': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'helm-route-edit-line': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
    },
    layers: [
      // a dashed preview line so dragging feels live even before the engine echoes geometry back
      { id: 'helm-route-edit-line', type: 'line', source: 'helm-route-edit-line',
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: { 'line-color': '#5bc0ff', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } },
      // vertex handles — big tappable dots, numbered by the symbol layer below
      { id: 'helm-route-edit-pts', type: 'circle', source: 'helm-route-edit-pts',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['case', ['get', 'drag'], 9, 7],
          'circle-color': ['case', ['get', 'first'], '#46e0a0', ['get', 'last'], '#ff6b6b', '#5bc0ff'],
          'circle-stroke-width': 2, 'circle-stroke-color': '#05121d'
        } },
      { id: 'helm-route-edit-labels', type: 'symbol', source: 'helm-route-edit-pts',
        layout: { visibility: 'none', 'text-field': ['get', 'n'], 'text-size': 10,
                  'text-font': ['Noto Sans Regular'], 'text-offset': [0, -1.2], 'text-allow-overlap': true },
        paint: { 'text-color': '#eef4f9', 'text-halo-color': '#05121d', 'text-halo-width': 1.2 } }
    ]
  });

  function flash(t, kind) {
    if (!msgEl) return;
    msgEl.textContent = t;
    msgEl.style.color = kind === 'bad' ? 'var(--danger)' : kind === 'warn' ? 'var(--warn)' : 'var(--ok)';
    clearTimeout(msgTimer); msgTimer = setTimeout(function () { msgEl.textContent = ''; }, 4500);
  }
  function send(o) {
    var ok = !!(window.__navClient && window.__navClient.send && window.__navClient.send(o));
    if (!ok) flash('Engine not connected — change kept locally, not saved to the boat.', 'warn');
    return ok;
  }

  // ── seed the working geometry from whatever the engine is currently showing ────────────────────
  // updateRouteFromEngine() (index.html) keeps the `route` map source live from s.route. Reading it
  // back is awkward across MapLibre versions: getData() is a PROMISE in v4+, and _data is the SOURCE
  // SPEC ({type,data}) not the GeoJSON. So we (a) extract synchronously from anything FC-shaped we can
  // reach, and (b) provide an async path that resolves the promise and adopts the result via a cb.
  function pluckLine(data) {                          // data = a FeatureCollection-ish object
    if (!data || !data.features) return null;
    for (var i = 0; i < data.features.length; i++) {
      var g = data.features[i].geometry;
      if (g && g.type === 'LineString' && g.coordinates && g.coordinates.length >= 2)
        return g.coordinates.map(function (c) { return [c[0], c[1]]; });
    }
    return null;
  }
  function seedSync() {                                // best-effort synchronous read; may return null
    try {
      var src = map && map.getSource('route'); if (!src) return null;
      // _data is usually the source spec; its .data may hold the inline FeatureCollection.
      var raw = src._data;
      var fc = raw && (raw.features ? raw : (raw.data && raw.data.features ? raw.data : null));
      return pluckLine(fc);
    } catch (e) { return null; }
  }
  function seedAsync(cb) {                             // resolves getData()'s promise, then cb(coords|null)
    try {
      var src = map && map.getSource('route');
      if (src && typeof src.getData === 'function') {
        var r = src.getData();
        if (r && typeof r.then === 'function') { r.then(function (d) { cb(pluckLine(d)); }, function () { cb(null); }); return; }
        cb(pluckLine(r)); return;
      }
    } catch (e) {}
    cb(null);
  }

  // ── rendering ──────────────────────────────────────────────────────────────────────────────────
  function setLayerVisibility(v) {
    if (!map) return;
    ['helm-route-edit-pts', 'helm-route-edit-labels', 'helm-route-edit-line'].forEach(function (id) {
      if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'); } catch (e) {} }
    });
  }
  function renderHandles() {
    if (!map) return;
    var ptsSrc = map.getSource('helm-route-edit-pts'), lineSrc = map.getSource('helm-route-edit-line');
    if (!ptsSrc || !lineSrc) return;
    var feats = pts.map(function (c, i) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: c },
        properties: { n: String(i + 1), first: i === 0, last: i === pts.length - 1, drag: i === dragIdx } };
    });
    try { ptsSrc.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {}
    try {
      lineSrc.setData(pts.length >= 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} }] }
        : { type: 'FeatureCollection', features: [] });
    } catch (e) {}
  }
  // Mirror the working geometry onto the real `route` source too, so the magenta route-line tracks
  // the edit live (before the engine round-trips). The engine's next s.route frame overwrites this.
  function renderWorkingRouteLine() {
    if (!map) return;
    var src = map.getSource('route'); if (!src) return;
    try {
      src.setData(pts.length >= 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { leg: 'all' }, geometry: { type: 'LineString', coordinates: pts } }] }
        : { type: 'FeatureCollection', features: [] });
    } catch (e) {}
  }

  function renderList() {
    if (!listEl) return;
    if (countEl) countEl.textContent = pts.length + ' waypoint' + (pts.length === 1 ? '' : 's');
    if (lenEl) lenEl.textContent = pts.length >= 2 ? fmtNM(totalNM(pts)) : '—';
    if (statusEl) {
      statusEl.textContent = !editing ? 'Editing off' : dirty ? 'Unsaved edits' : 'In sync';
      statusEl.style.color = dirty ? 'var(--warn)' : editing ? 'var(--ok)' : 'var(--cdim)';
    }
    if (!pts.length) {
      listEl.innerHTML = '<div class="hint" style="margin:6px 0">No waypoints yet. Turn on editing, then tap the chart to drop them — or use “Add by lat/lon”.</div>';
      return;
    }
    listEl.innerHTML = '';
    pts.forEach(function (c, i) {
      var legTxt = '';
      if (i < pts.length - 1) legTxt = '→ ' + Math.round(bearing(c, pts[i + 1])) + '° · ' + fmtNM(distNM(c, pts[i + 1]));
      var col = i === 0 ? 'var(--ok)' : i === pts.length - 1 ? 'var(--danger)' : 'var(--accent)';
      var row = document.createElement('div'); row.className = 'conn-row';
      row.innerHTML =
        '<div class="conn-dot" style="color:' + col + ';background:' + col + '"></div>' +
        '<div class="conn-main">' +
          '<div class="conn-name"></div>' +
          '<div class="conn-meta">' + fmtLatLon(c) + (legTxt ? ' · ' + legTxt : '') + '</div>' +
        '</div>' +
        '<button class="conn-icon" data-act="up" title="Center map here">◎</button>' +
        '<button class="conn-icon" data-act="split" title="Split route here (keep first part)">⋔</button>' +
        '<button class="conn-icon" data-act="del" title="Delete this waypoint">✕</button>';
      // editable waypoint name (XSS-safe: DOM .value, never innerHTML). Custom name shows; the auto
      // "WPn" the engine assigns to unnamed points is treated as the default → shown as placeholder.
      var wpIn = document.createElement('input'); wpIn.className = 'wp-name'; wpIn.placeholder = 'WP' + (i + 1);
      wpIn.title = 'Name this waypoint — saved to the boat (OpenCPN RoutePoint)';
      wpIn.value = (c.name && c.name !== 'WP' + (i + 1)) ? c.name : '';
      wpIn.addEventListener('change', function () { renameWp(i, wpIn.value); });
      wpIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') wpIn.blur(); });
      row.querySelector('.conn-name').appendChild(wpIn);
      row.querySelector('[data-act="up"]').addEventListener('click', function () { map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 12) }); });
      row.querySelector('[data-act="split"]').addEventListener('click', function () { splitAt(i); });
      row.querySelector('[data-act="del"]').addEventListener('click', function () { deleteAt(i); });
      listEl.appendChild(row);
    });
  }
  function renderAll() { renderHandles(); renderWorkingRouteLine(); renderList(); }

  // ── edit verbs (all operate on the local working geometry, then commit via route.create) ────────
  function markDirty() { dirty = true; renderAll(); }

  function addWaypoint(lngLat) {                       // tap-to-add — append at the end
    pts.push([lngLat.lng, lngLat.lat]); markDirty();
  }
  function insertWaypoint(seg, lngLat) {               // long-press-insert — split a leg
    pts.splice(seg + 1, 0, [lngLat.lng, lngLat.lat]); markDirty();
  }
  function deleteAt(i) {
    if (i < 0 || i >= pts.length) return;
    pts.splice(i, 1); markDirty();
    if (pts.length >= 2) commit('Deleted waypoint'); else flash('Route needs ≥2 waypoints to save.', 'warn');
  }
  function reverse() {
    if (pts.length < 2) { flash('Nothing to reverse.', 'warn'); return; }
    pts.reverse(); markDirty(); commit('Reversed');
  }
  function splitAt(i) {                                // keep waypoints 1..i+1 as the route; drop the tail
    if (i <= 0 || i >= pts.length - 1) { flash('Pick an interior waypoint to split at.', 'warn'); return; }
    pts = pts.slice(0, i + 1); markDirty(); commit('Split — kept first ' + pts.length + ' WPs');
  }
  function clearRoute() { pts = []; dragIdx = -1; markDirty(); }
  // rename a waypoint (fires on blur/Enter of its name input). Empty → clears back to the auto "WPn".
  function renameWp(i, name) {
    if (i < 0 || i >= pts.length) return;
    var v = (name || '').trim();
    if (v) pts[i].name = v; else delete pts[i].name;
    markDirty();
    if (pts.length >= 2) commit('Renamed waypoint');
  }
  function syncNameInput() { if (routeNameInput) routeNameInput.value = (routeName && routeName !== 'Route') ? routeName : ''; }

  // ── commit: the ONE engine verb. Sends the whole geometry; engine persists + activates + echoes. ─
  function commit(verb) {
    if (pts.length < 2) { flash('Route needs ≥2 waypoints to save.', 'warn'); return; }
    var points = pts.map(function (c) { return [c[1], c[0], c.name || '']; });   // [lon,lat] → [lat,lon,name] for the engine (blank → engine auto-names WPn)
    var ok = send({ t: 'route.create', name: routeName, points: points });
    if (ok) { dirty = false; flash((verb || 'Saved') + ' — ' + points.length + ' waypoints sent to the boat ✓'); }
    renderList();
  }

  // ── map interaction wiring (installed once, gated on `editing`) ──────────────────────────────────
  var wired = false;
  function wireMap() {
    if (wired || !map) return; wired = true;

    map.on('mousedown', function (e) {
      if (!editing) return;
      var vi = nearestVertex(map, pts, e.lngLat, VERTEX_TOL);
      if (vi >= 0) {                                   // grab a vertex → drag
        dragIdx = vi; e.preventDefault();
        map.dragPan.disable(); map.getCanvas().style.cursor = 'grabbing';
        renderHandles();
      }
    });
    map.on('mousemove', function (e) {
      if (!editing) return;
      if (dragIdx >= 0) {                              // live drag-with-recompute
        var _nm = pts[dragIdx].name;                   // drag replaces the element → carry the name across
        pts[dragIdx] = [e.lngLat.lng, e.lngLat.lat]; if (_nm) pts[dragIdx].name = _nm;
        dirty = true; renderHandles(); renderWorkingRouteLine(); renderList();
        return;
      }
      // hover affordance: grab cursor over a vertex, crosshair over open chart
      var over = nearestVertex(map, pts, e.lngLat, VERTEX_TOL) >= 0;
      map.getCanvas().style.cursor = over ? 'grab' : 'crosshair';
    });
    map.on('mouseup', function () {
      if (dragIdx >= 0) {
        dragIdx = -1; map.dragPan.enable(); map.getCanvas().style.cursor = 'crosshair';
        renderHandles(); commit('Moved waypoint');     // settle → one route.create
      }
    });

    // long-press to INSERT on a leg (touch + mouse). A press that doesn't move for LP_MS, over a leg.
    function pressStart(lngLat) {
      if (!editing) return;
      lpLngLat = lngLat;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(function () {
        if (dragIdx >= 0) return;
        var near = nearestSegment(map, pts, lpLngLat);
        if (near.seg >= 0 && near.d2 <= LEG_TOL * LEG_TOL) { insertWaypoint(near.seg, lpLngLat); commit('Inserted waypoint'); }
      }, LP_MS);
    }
    function pressCancel() { clearTimeout(lpTimer); lpTimer = null; }
    map.on('mousedown', function (e) { pressStart(e.lngLat); });
    map.on('touchstart', function (e) { if (e.lngLat) pressStart(e.lngLat); });
    map.on('mousemove', pressCancel);
    map.on('touchmove', pressCancel);
    map.on('mouseup', pressCancel);
    map.on('touchend', pressCancel);

    // plain tap (click) in edit mode, when NOT grabbing a vertex → add a waypoint. If the tap lands
    // on an interior leg, insert there; otherwise append at the end.
    map.on('click', function (e) {
      if (!editing) return;
      if (nearestVertex(map, pts, e.lngLat, VERTEX_TOL) >= 0) return;   // a vertex tap is for drag, not add
      var near = nearestSegment(map, pts, e.lngLat);
      if (pts.length >= 2 && near.seg >= 0 && near.d2 <= LEG_TOL * LEG_TOL) { insertWaypoint(near.seg, e.lngLat); commit('Inserted waypoint'); }
      else { addWaypoint(e.lngLat); commit('Added waypoint'); }
    });
  }

  // adopt the engine's currently-shown route into the working geometry, unless we're mid-edit.
  // Prefer window.__route (the engine's route channel) — it carries the route name + per-waypoint
  // names; the map `route` source is geometry-only. Fall back to the map source for the geometry.
  function adoptLiveRoute() {
    ensureMap();
    if (dirty) return;                                 // never clobber un-saved edits
    var er = window.__route;                           // { coords:[[lon,lat]…], names:[…], name }
    if (er && Array.isArray(er.coords) && er.coords.length >= 2) {
      pts = er.coords.map(function (c, i) { var p = [c[0], c[1]]; var nm = er.names && er.names[i]; if (nm) p.name = nm; return p; });
      if (er.name) routeName = er.name;
      syncNameInput(); renderAll(); return;
    }
    var s = seedSync();
    if (s) { pts = s; syncNameInput(); renderAll(); return; }
    seedAsync(function (coords) { if (coords && !dirty) { pts = coords; syncNameInput(); renderAll(); } });
  }

  function setEditing(on) {
    ensureMap();
    editing = !!on;
    if (editing) {
      if (!pts.length || !dirty) adoptLiveRoute();     // adopt/re-sync the live route unless mid-edit
      wireMap();
      if (map) map.getCanvas().style.cursor = 'crosshair';
    } else {
      dragIdx = -1; try { if (map) map.dragPan.enable(); } catch (e) {}
      if (map) map.getCanvas().style.cursor = '';
    }
    setLayerVisibility(editing);
    if (btnEdit) {
      btnEdit.textContent = editing ? 'Editing on — tap chart to add' : 'Start editing';
      btnEdit.classList.toggle('primary', editing);
    }
    renderAll();
  }

  // ── drop-by-lat/lon (ROUTE-5) ────────────────────────────────────────────────────────────────
  // Accepts decimal "lat, lon" or "lat lon". Appends a waypoint and commits.
  function parseLatLon(s) {
    if (!s) return null;
    var m = s.trim().split(/[\s,]+/).map(Number).filter(function (n) { return isFinite(n); });
    if (m.length < 2) return null;
    var lat = m[0], lon = m[1];
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lon, lat];
  }

  // ── command-plane replies (forwarded from index.html's onCommand fan-out) ───────────────────────
  function onCommand(msg) {
    if (!msg) return;
    if (msg.t === 'route.ack' && msg.ok === false) flash('Engine rejected: ' + (msg.error || 'error'), 'bad');
  }

  // ── panel ───────────────────────────────────────────────────────────────────────────────────
  // ── editor workspace — mounted into the consolidated Routes drawer's "Edit" tab ────────────────
  // ROUTE consolidation: the editor no longer owns its own rail button. routes.js hosts ONE "Routes"
  // drawer with Saved | Edit tabs and calls mount() (once, lazily) + onShow() (each time the Edit tab
  // is shown) to surface this workspace into #route-edit-host. (Was: HelmShell.registerPanel.)
  var mounted = false;
  function ensureMap() { if (!map) map = window.map; return map; }   // map is global once HelmShell.boot ran
  function mount(body, ctx) {
      if (mounted) return; mounted = true;
      map = (ctx && ctx.map) || window.map;

      var sub = document.createElement('p'); sub.className = 'sub';
      sub.textContent = 'Direct-manipulation editor. Tap the chart to add, drag a dot to move, long-press a leg to insert. Every change is saved to the boat (route.create) and navigated.';
      body.appendChild(sub);

      // route name (editable) — persisted via route.create's `name`; shows in the Saved list + OpenCPN.
      var nameWrap = document.createElement('div'); nameWrap.className = 'conn-actions';
      nameWrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin:2px 0 8px';
      var nameLbl = document.createElement('span'); nameLbl.className = 'lbl'; nameLbl.style.cssText = 'margin:0;flex:0 0 auto'; nameLbl.textContent = 'Name';
      routeNameInput = document.createElement('input'); routeNameInput.type = 'text'; routeNameInput.placeholder = 'Route name';
      routeNameInput.title = 'Name this route — saved to the boat (OpenCPN) and shown in the Saved list';
      routeNameInput.style.cssText = 'flex:1;min-width:0;padding:6px 8px;border:.5px solid var(--line);border-radius:8px;background:rgba(255,255,255,.05);color:var(--ctext);font:inherit;font-size:12px';
      routeNameInput.value = (routeName && routeName !== 'Route') ? routeName : '';
      function commitName() { routeName = routeNameInput.value.trim() || 'Route'; if (pts.length >= 2) commit('Renamed route'); else renderList(); }
      routeNameInput.addEventListener('change', commitName);
      routeNameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') routeNameInput.blur(); });
      nameWrap.appendChild(nameLbl); nameWrap.appendChild(routeNameInput);
      body.appendChild(nameWrap);

      // edit toggle
      btnEdit = document.createElement('button'); btnEdit.className = 'conn-btn'; btnEdit.style.width = '100%';
      btnEdit.title = 'Toggle direct route editing: tap the chart to add waypoints, drag to move, long-press a leg to insert';
      btnEdit.textContent = 'Start editing';
      btnEdit.addEventListener('click', function () { setEditing(!editing); });
      body.appendChild(btnEdit);

      // summary line (count · length · sync status)
      var summ = document.createElement('div'); summ.className = 'row'; summ.style.justifyContent = 'space-between'; summ.style.cursor = 'default'; summ.style.marginTop = '8px';
      summ.innerHTML = '<span><span id="helm-route-edit-count">0 waypoints</span> · <span id="helm-route-edit-len">—</span></span><span id="helm-route-edit-status" style="font-size:10.5px"></span>';
      body.appendChild(summ);
      countEl = summ.querySelector('#helm-route-edit-count');
      lenEl = summ.querySelector('#helm-route-edit-len');
      statusEl = summ.querySelector('#helm-route-edit-status');

      // action buttons: reverse / clear
      var actions = document.createElement('div'); actions.className = 'conn-actions'; actions.style.display = 'flex'; actions.style.gap = '6px'; actions.style.marginTop = '8px';
      var bRev = document.createElement('button'); bRev.className = 'conn-btn'; bRev.style.flex = '1'; bRev.textContent = 'Reverse'; bRev.title = 'Reverse the active route (swap start ↔ end)';
      bRev.addEventListener('click', function () { reverse(); });
      var bClr = document.createElement('button'); bClr.className = 'conn-btn'; bClr.style.flex = '1'; bClr.textContent = 'Clear'; bClr.title = 'Clear all waypoints from the route being edited';
      bClr.addEventListener('click', function () { if (!pts.length || window.confirm('Clear all waypoints? (Not saved until you add ≥2 again.)')) clearRoute(); });
      actions.appendChild(bRev); actions.appendChild(bClr);
      body.appendChild(actions);

      // drop-by-lat/lon (ROUTE-5)
      var lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = 'Add by lat / lon';
      body.appendChild(lbl);
      var llRow = document.createElement('div'); llRow.className = 'conn-actions'; llRow.style.display = 'flex'; llRow.style.gap = '6px';
      var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = '-17.70, 177.40';
      inp.style.cssText = 'flex:1;min-width:0;padding:6px 8px;border:.5px solid var(--line);border-radius:8px;background:rgba(255,255,255,.05);color:var(--ctext);font:inherit;font-size:12px';
      var bAdd = document.createElement('button'); bAdd.className = 'conn-btn'; bAdd.textContent = 'Add'; bAdd.title = 'Add a waypoint at the entered latitude / longitude';
      function doAdd() {
        var c = parseLatLon(inp.value);
        if (!c) { flash('Enter decimal “lat, lon”, e.g. -17.70, 177.40', 'warn'); return; }
        pts.push(c); markDirty(); commit('Added by lat/lon'); inp.value = '';
        if (map) map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 11) });
      }
      bAdd.addEventListener('click', doAdd);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });
      llRow.appendChild(inp); llRow.appendChild(bAdd);
      body.appendChild(llRow);

      // waypoint list
      var lbl2 = document.createElement('div'); lbl2.className = 'lbl'; lbl2.textContent = 'Waypoints';
      body.appendChild(lbl2);
      listEl = document.createElement('div'); listEl.className = 'conn-list';
      body.appendChild(listEl);

      msgEl = document.createElement('div'); msgEl.className = 'conn-msg';
      body.appendChild(msgEl);

      renderAll();
  }
  // re-sync to the engine's current route each time the Edit tab is shown, unless mid-edit.
  function onShow() { ensureMap(); adoptLiveRoute(); renderAll(); }

  // ── ⌘K commands ─────────────────────────────────────────────────────────────────────────────
  HelmShell.registerCommand({
    id: 'helm-route-edit-toggle', epic: 'ROUTE',
    title: 'Edit route — direct manipulation', subtitle: 'Tap to add · drag to move · long-press to insert',
    keywords: ['route', 'edit', 'waypoint', 'move', 'drag', 'insert', 'delete'], group: 'Route',
    run: function () {
      if (window.HelmRoutes && HelmRoutes.openEditor) HelmRoutes.openEditor();   // open the Routes drawer → Edit tab (mounts the editor)
      setEditing(true);
    }
  });
  HelmShell.registerCommand({
    id: 'helm-route-edit-reverse', epic: 'ROUTE',
    title: 'Reverse active route', subtitle: 'Swap start ↔ end',
    keywords: ['route', 'reverse', 'flip', 'return'], group: 'Route',
    run: function () {
      ensureMap();
      if (pts.length >= 2) { reverse(); return; }      // already have geometry → reverse now
      var s = seedSync(); if (s) { pts = s; reverse(); return; }
      seedAsync(function (coords) { if (coords) { pts = coords; reverse(); } });
    }
  });

  // expose for index.html's onCommand fan-out + tests
  window.HelmRouteEdit = {
    onCommand: onCommand,
    mount: mount, onShow: onShow,                       // surfaced by routes.js into the Routes drawer's Edit tab
    setEditing: setEditing,
    isEditing: function () { return editing; },
    reverse: reverse,
    points: function () { return pts.slice(); },
    // pure helpers (unit-testable without a map)
    _math: { distNM: distNM, bearing: bearing, totalNM: totalNM, parseLatLon: parseLatLon }
  };
})();
