// routes.js — saved-route management UI. Lists the routes the engine persists in OpenCPN's
// navobj.db and lets the helm ACTIVATE or DELETE them over the same nav WebSocket command-plane
// (route.list / route.activate / route.delete). Mirrors connections.js; the engine owns the data.
//
// No-engine / web-only preview (ROUTE-10): saved routes live in the engine, so with no client we
// can't list/persist them — but we DON'T look broken. We show a calm hint explaining the engine is
// the source of truth for SAVED routes, and we surface the currently-drawn in-session route (read
// live from the map's `route` source) as an unsaved entry so the panel isn't blank in preview mode.
(function () {
  let client = null, listEl, msgEl, routes = [], msgTimer = null, online = false, editMounted = false, curTab = 'saved';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
  // The nav-client's send() returns true ONLY when the WebSocket is open (ws.readyState === 1), so
  // it's our live connectivity signal — `client` itself always exists (index.html ~1144), even with
  // no engine behind the page. We can't ask the engine "are you there?" passively, so we treat a
  // successful send as proof we're online and a failed one as proof we're not.
  function trySend(o) { const ok = !!(client && client.send && client.send(o)); online = ok; return ok; }
  // Fire a command for an action the user actually took (activate/delete). If we're offline the send
  // fails silently at the socket; surface a calm hint instead of looking broken, and re-render so the
  // panel switches to its no-engine state.
  function send(o) {
    if (trySend(o)) return;
    flash('Connect to the boat engine to manage saved routes.', true);
    render();
  }
  function flash(t, bad) {
    if (!msgEl) return;
    msgEl.textContent = t; msgEl.style.color = bad ? 'var(--danger)' : 'var(--ok)';
    clearTimeout(msgTimer); msgTimer = setTimeout(() => { msgEl.textContent = ''; }, 4500);
  }
  function refresh() {
    // Ask the engine for its persisted routes. trySend() updates `online` from the socket state, so
    // even when no engine is behind the page this is harmless (no flash) and render() then shows the
    // calm no-engine hint + any in-session route rather than a blank/“Not connected” panel.
    trySend({ t: 'route.list' });
    render();
  }

  // The route currently drawn on the chart (driven into the `route` map source live by
  // index.html's updateRouteFromEngine; the source starts empty — no hardcoded demo route). We read
  // it back so the drawer can show it as an UNSAVED in-session entry without owning any engine call.
  function liveRoute() {
    try {
      const map = window.map; if (!map || !map.getSource) return null;
      const src = map.getSource('route'); if (!src || typeof src.serialize !== 'function') return null;
      const data = src.serialize().data; if (!data || !Array.isArray(data.features)) return null;
      // Prefer the full-route feature (leg:'all'); fall back to the first LineString.
      let f = data.features.find(x => x && x.properties && x.properties.leg === 'all');
      if (!f) f = data.features.find(x => x && x.geometry && x.geometry.type === 'LineString');
      const coords = f && f.geometry && f.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return null;
      return { name: (f.properties && f.properties.name) || 'Current route', points: coords.length };
    } catch (e) { return null; }
  }

  function routeRow(r) {
    const on = !!r.active;
    const row = document.createElement('div'); row.className = 'conn-row';
    const tag = on ? ' <span style="color:var(--ok);font-size:9px;letter-spacing:.04em">ACTIVE</span>'
                   : (r.unsaved ? ' <span style="color:var(--cdim);font-size:9px;letter-spacing:.04em">UNSAVED</span>' : '');
    row.innerHTML =
      '<div class="conn-dot" style="color:' + (on ? 'var(--ok)' : 'var(--cdim)') + ';background:' + (on ? 'var(--ok)' : 'var(--cdim)') + '"></div>' +
      '<div class="conn-main">' +
        '<div class="conn-name">' + esc(r.name || 'Route') + tag + '</div>' +
        '<div class="conn-meta">' + (r.points || 0) + ' waypoint' + (r.points === 1 ? '' : 's') + (r.unsaved ? ' · on the chart, not yet saved to the boat' : '') + '</div>' +
      '</div>' +
      '<button class="conn-icon" data-act="edit" title="Edit this route (opens the Edit tab)">✎</button>' +
      (r.unsaved ? '' : ((on ? '' : '<button class="conn-icon" data-act="go" title="Activate (navigate this route)">▸</button>') +
        '<button class="conn-icon" data-act="del" title="Delete route">✕</button>'));
    const ed = row.querySelector('[data-act="edit"]');
    if (ed) ed.addEventListener('click', () => editRoute(r));
    const go = row.querySelector('[data-act="go"]');
    if (go) go.addEventListener('click', () => send({ t: 'route.activate', guid: r.guid }));
    const del = row.querySelector('[data-act="del"]');
    if (del) del.addEventListener('click', () => {
      if (window.confirm('Delete route "' + (r.name || 'Route') + '"? This removes it from the boat.')) send({ t: 'route.delete', guid: r.guid });
    });
    return row;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const live = liveRoute();

    // Saved routes from the engine (the source of truth for persistence).
    routes.forEach(r => listEl.appendChild(routeRow(r)));

    // The currently-drawn in-session route, shown as an unsaved entry — but skip it if the engine
    // already lists a saved route of the same name + size to avoid a confusing duplicate.
    if (live && !routes.some(r => r.points === live.points && (r.name || '') === live.name))
      listEl.appendChild(routeRow({ name: live.name, points: live.points, unsaved: true }));

    // Helper / empty states.
    if (!online) {
      const hint = document.createElement('div'); hint.className = 'hint'; hint.style.margin = '8px 0';
      hint.innerHTML = (routes.length || live)
        ? 'Saved routes are stored on the boat — connect the engine to activate, delete, or save routes.'
        : 'Connect to the boat engine to manage saved routes. Draw a route on the chart and it appears here; connect the engine to save it.';
      listEl.appendChild(hint);
    } else if (!routes.length && !live) {
      const hint = document.createElement('div'); hint.className = 'hint'; hint.style.margin = '8px 0';
      hint.textContent = 'No saved routes yet — draw one with the route tool, then it appears here.';
      listEl.appendChild(hint);
    }
  }

  function onCommand(msg) {
    // A route.list reply can only come from a live engine, so it also confirms we're online.
    if (msg.t === 'route.list' && Array.isArray(msg.routes)) { online = true; routes = msg.routes; render(); }
    else if (msg.t === 'route.ack') {
      if (msg.ok === false) flash('Error: ' + (msg.error || 'rejected'), true);
      else { flash(msg.deleted ? 'Route deleted ✓' : (msg.name ? 'Now navigating ' + msg.name + ' ✓' : 'Saved ✓')); refresh(); }
    }
  }
  // ── Saved | Edit tabs (consolidated single Routes drawer) ───────────────────────────────────────
  // One rail button → this drawer. "Saved" is the library above; "Edit" hosts the direct-manipulation
  // editor (route-edit.js), mounted lazily into #route-edit-host the first time the Edit tab opens.
  function host() { return document.getElementById('route-edit-host'); }
  function showTab(tab) {
    tab = (tab === 'edit') ? 'edit' : 'saved';
    curTab = tab;
    const drawer = document.getElementById('drawer-routes'); if (!drawer) return;
    drawer.querySelectorAll('.rtab').forEach(b => {
      const sel = b.getAttribute('data-rtab') === tab;
      b.classList.toggle('on', sel); b.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
    drawer.querySelectorAll('.rpane').forEach(p => { p.hidden = p.getAttribute('data-rpane') !== tab; });
    if (tab === 'edit') {
      const h = host();
      if (h && window.HelmRouteEdit) {
        if (!editMounted && HelmRouteEdit.mount) { HelmRouteEdit.mount(h, { map: window.map }); editMounted = true; }
        if (HelmRouteEdit.onShow) HelmRouteEdit.onShow();   // re-sync to the live route each time
      }
    } else {
      refresh();                                            // back to the library → re-pull saved routes
    }
  }
  // Open the Routes drawer (reusing the built-in rail wiring) and land on the Edit tab.
  function openEditor() {
    const d = document.getElementById('drawer-routes');
    if (d && d.hidden) { const b = document.querySelector('.ri[data-rail="routes"]'); if (b) b.click(); }
    showTab('edit');
  }
  // "Pick/edit a saved route → jump to Edit." Activating makes it the live route the editor adopts —
  // edits commit via route.create, which REPLACES the active route, so the edited one must be active.
  function editRoute(r) {
    if (r && r.guid && !r.active) send({ t: 'route.activate', guid: r.guid });   // offline → calm hint; still opens the editor
    openEditor();
    // the activated geometry rides back on the next nav frame; re-adopt once it lands (guarded on !dirty)
    setTimeout(() => { if (curTab === 'edit' && window.HelmRouteEdit && HelmRouteEdit.onShow) HelmRouteEdit.onShow(); }, 700);
  }

  function init(opts) {
    client = opts && opts.client;
    listEl = document.getElementById('route-list');
    msgEl = document.getElementById('route-msg');
    const drawer = document.getElementById('drawer-routes');
    if (drawer && !drawer._rtabsWired) {                    // wire the Saved | Edit tab buttons once
      drawer._rtabsWired = true;
      drawer.querySelectorAll('.rtab').forEach(b => b.addEventListener('click', () => showTab(b.getAttribute('data-rtab'))));
    }
    if (!listEl) return;
    refresh();
  }
  window.HelmRoutes = { init, onCommand, refresh, showTab, openEditor };
})();
