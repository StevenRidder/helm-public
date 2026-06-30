// shell.js — Helm's shared-shell registration seam (SHELL epic, owns index.html + style.json).
// ----------------------------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES
//   index.html used to be an ~85 KB monolith: every UI epic (OWNSHIP, AIS, ROUTE, CONN, WX, …)
//   had to hand-edit the shell body to add a side panel, a ⌘K command, or a map layer. Twelve
//   epics editing one file = constant merge conflicts. SHELL is the keystone that de-fangs it.
//
// WHAT THIS GIVES YOU (an epic agent)
//   A tiny global `HelmShell` that lets your OWN module file register, with NO edit to index.html:
//
//     1. HelmShell.registerPanel({ id, epic, title, icon, render })   ← a left-rail drawer
//     2. HelmShell.registerCommand({ id, epic, title, run, … })       ← a ⌘K / toolbar entry
//     3. HelmShell.registerStyleFragment(epic, fragmentUrlOrObject)   ← per-domain map layers
//
//   See web/SHELL.md for the full convention. The three rules in one breath:
//     • Namespace everything `helm-<epic>-*` (panel id, layer id, command id) so two epics never
//       collide on the same key.  • Register from your own file — never touch the shell body.
//     • Registration is order-independent and works whether you load before or after shell.js.
//
// HOW THE SHELL CONSUMES IT
//   index.html calls HelmShell.boot({ map, railEl }) once the map exists. boot() drains every
//   queued registration, builds the drawers/commands, and from then on registrations apply live.
//   Style fragments are merged BEFORE the map is constructed (see HelmShell.buildStyle), so the
//   rendered map is byte-equivalent to the old single style.json.
// ----------------------------------------------------------------------------------------------
(function () {
  'use strict';

  // ---- registries (filled by register*(), even before boot) -------------------------------
  var panels   = [];                 // { id, epic, title, icon, render, _el, _rendered }
  var commands = [];                 // { id, epic, title, subtitle, keywords, group, run }
  var fragments = [];                // { epic, src }  (src = url string or style-object)
  var booted = false;
  var ctx = null;                    // { map, railEl }  set by boot()
  var legacyCloser = null;           // closes the shell's built-in (pre-migration) drawers — set by index.html

  function warn(m) { try { console.warn('[HelmShell] ' + m); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ============================================================================================
  //  1. PANELS  — a left-rail icon + its slide-out drawer, owned by your module file
  // ============================================================================================
  // registerPanel({
  //   id:    'helm-ais-targets',     // REQUIRED, unique, namespaced helm-<epic>-*
  //   epic:  'AIS',                  // your epic tag (for the EPIC:XXX provenance comment)
  //   title: 'AIS targets',          // drawer heading + rail tooltip
  //   icon:  '<svg …>' | 'A',        // rail glyph: an inline SVG string or a short text label
  //   render(body, { map }) { … },   // called ONCE, lazily, the first time the panel opens.
  //                                  // `body` is the empty drawer <div> — fill it however you like.
  //   onOpen(body,{map}) {}          // OPTIONAL, called every time it opens (refresh live data)
  // })
  //   Returns a handle: { open(), close(), toggle(), el, isOpen() }.
  function registerPanel(spec) {
    if (!spec || !spec.id) { warn('registerPanel needs an {id}'); return noopHandle(); }
    if (byId(panels, spec.id)) { warn('panel "' + spec.id + '" already registered — ignoring'); return byId(panels, spec.id)._handle; }
    var p = {
      id: spec.id, epic: spec.epic || '?', title: spec.title || spec.id,
      icon: spec.icon || (spec.title ? spec.title[0] : '•'),
      render: spec.render, onOpen: spec.onOpen,
      _el: null, _rail: null, _rendered: false
    };
    p._handle = makePanelHandle(p);
    panels.push(p);
    if (booted) mountPanel(p);                 // live registration after boot
    return p._handle;
  }

  function makePanelHandle(p) {
    return {
      id: p.id, el: function () { return p._el; },
      isOpen: function () { return !!(p._el && !p._el.hidden); },
      open:  function () { openPanel(p); },
      close: function () { if (p._el) p._el.hidden = true; if (p._rail) p._rail.classList.remove('on'); },
      toggle: function () { (p._el && !p._el.hidden) ? this.close() : this.open(); }
    };
  }

  function closeAllPanels() {
    panels.forEach(function (q) { if (q._el) q._el.hidden = true; if (q._rail) q._rail.classList.remove('on'); });
  }

  function openPanel(p) {
    if (!booted) { warn('openPanel before boot'); return; }
    var wasOpen = p._el && !p._el.hidden;
    closeAllPanels();
    if (legacyCloser) { try { legacyCloser(); } catch (e) {} }   // also close the shell's built-in drawers (mutual exclusion)
    if (wasOpen) return;                        // toggle-off
    if (!p._rendered) {                         // lazy first render
      try { if (p.render) p.render(p._el, ctx); } catch (e) { warn('panel "' + p.id + '" render failed: ' + e); }
      p._rendered = true;
    }
    p._el.hidden = false;
    if (p._rail) p._rail.classList.add('on');
    try { if (p.onOpen) p.onOpen(p._el, ctx); } catch (e) { warn('panel "' + p.id + '" onOpen failed: ' + e); }
  }

  // Build the drawer <div> + rail button for one panel and wire the click.
  function mountPanel(p) {
    if (p._el) return;
    var d = document.createElement('div');
    d.className = 'drawer glass';
    d.id = p.id;                                // namespaced id IS the dom id
    d.hidden = true;
    d.setAttribute('data-epic', p.epic);
    // <!-- EPIC:XXX --> provenance marker so the shell body stays self-documenting
    d.appendChild(document.createComment(' EPIC:' + p.epic + ' panel:' + p.id + ' '));
    var h = document.createElement('h2'); h.textContent = p.title; d.appendChild(h);
    document.body.appendChild(d);
    p._el = d;

    if (ctx.railEl) {
      var r = document.createElement('div');
      r.className = 'ri'; r.setAttribute('data-rail', p.id); r.title = p.title;
      r.innerHTML = isSvg(p.icon) ? p.icon
        : '<span style="font:600 15px system-ui">' + esc(p.icon) + '</span>';
      r.addEventListener('click', function () { openPanel(p); });
      ctx.railEl.appendChild(r);
      p._rail = r;
    }
  }
  function isSvg(s) { return typeof s === 'string' && /^\s*<svg/i.test(s); }

  // ============================================================================================
  //  2. COMMANDS  — ⌘K palette entries (and the seam a toolbar/quick-action can reuse)
  // ============================================================================================
  // registerCommand({
  //   id:       'helm-ownship-follow',  // REQUIRED, unique, namespaced
  //   epic:     'OWNSHIP',
  //   title:    'Center on boat',       // shown in the palette
  //   subtitle: 'Follow ownship',       // OPTIONAL dim second line
  //   keywords: ['center','follow'],    // OPTIONAL extra fuzzy-match terms
  //   group:    'Ownship',              // OPTIONAL section label
  //   run({ map }) { … }                // invoked on pick; palette closes first
  // })
  //   Returns { id, remove() }.  TOOLS-3/AI-6 own the palette UX; this is the stable hook they
  //   render from — list with HelmShell.commands(), run with HelmShell.runCommand(id).
  function registerCommand(spec) {
    if (!spec || !spec.id || typeof spec.run !== 'function') { warn('registerCommand needs {id, run()}'); return { id: spec && spec.id, remove: function () {} }; }
    if (byId(commands, spec.id)) { warn('command "' + spec.id + '" already registered — ignoring'); }
    else {
      commands.push({
        id: spec.id, epic: spec.epic || '?', title: spec.title || spec.id,
        subtitle: spec.subtitle || '', keywords: spec.keywords || [],
        group: spec.group || (spec.epic || ''), run: spec.run
      });
      notifyCommandListeners();
    }
    return { id: spec.id, remove: function () { var i = indexById(commands, spec.id); if (i >= 0) { commands.splice(i, 1); notifyCommandListeners(); } } };
  }
  function commandList() { return commands.slice(); }
  function runCommand(id) {
    var c = byId(commands, id); if (!c) { warn('runCommand: no command "' + id + '"'); return false; }
    try { c.run(ctx); return true; } catch (e) { warn('command "' + id + '" failed: ' + e); return false; }
  }
  // Palette renderers (TOOLS-3 / AI-6) subscribe so they re-render when epics add commands late.
  var commandListeners = [];
  function onCommandsChanged(fn) { if (typeof fn === 'function') { commandListeners.push(fn); fn(commandList()); } }
  function notifyCommandListeners() { commandListeners.forEach(function (fn) { try { fn(commandList()); } catch (e) {} }); }

  // ============================================================================================
  //  3. STYLE FRAGMENTS  — per-domain map layers, merged into one style before the map builds
  // ============================================================================================
  // Two ways to contribute layers without editing style.json:
  //   (a) Build time / load time: drop a fragment file in web/style/ and list it in the manifest
  //       (web/style/manifest.json). buildStyle() fetches + deep-merges them. This is the path
  //       the split base uses today (helm-base + helm-chart-* + helm-ais-* + …).
  //   (b) Runtime: call HelmShell.registerStyleFragment('AIS', objOrUrl) BEFORE buildStyle(), or
  //       add layers imperatively from your module via map.addLayer() after the map loads.
  // A fragment is a partial MapLibre style: { sources?: {...}, layers?: [...] }. Namesake rule:
  //   every source id and layer id MUST be `helm-<epic>-*` (or a documented legacy id) so two
  //   epics never write the same JSON object. mergeStyle() refuses to clobber an existing id.
  function registerStyleFragment(epic, src) {
    fragments.push({ epic: epic || '?', src: src });
  }

  // Merge a base style object with N fragment objects. Pure + side-effect-free → easy to test.
  // Conflicting source/layer ids are dropped with a warning (first writer wins) so a mis-namespaced
  // fragment can never silently overwrite another epic's layer. Layer ORDER is base-first, then
  // fragments in manifest order — which is why the manifest lists chart→overlay→symbol domains
  // in draw order (see web/style/manifest.json).
  function mergeStyle(base, frags) {
    var out = JSON.parse(JSON.stringify(base || {}));
    out.sources = out.sources || {};
    out.layers = out.layers || [];
    var haveLayer = {}; out.layers.forEach(function (l) { haveLayer[l.id] = true; });
    (frags || []).forEach(function (f) {
      if (!f) return;
      if (f.sources) Object.keys(f.sources).forEach(function (sid) {
        if (out.sources[sid]) { warn('duplicate source "' + sid + '" — keeping first'); return; }
        out.sources[sid] = f.sources[sid];
      });
      if (Array.isArray(f.layers)) f.layers.forEach(function (l) {
        if (!l || !l.id) return;
        if (haveLayer[l.id]) { warn('duplicate layer "' + l.id + '" — keeping first'); return; }
        haveLayer[l.id] = true; out.layers.push(l);
      });
    });
    return out;
  }

  // Fetch the base + every manifest fragment + every runtime-registered fragment, merge, return
  // the resolved style OBJECT. index.html passes this object straight to `new maplibregl.Map`.
  // Falls back to the monolithic style.json if the split manifest isn't present (zero-risk rollout).
  async function buildStyle(opts) {
    opts = opts || {};
    var dir = opts.styleDir || 'style';
    var manifestUrl = dir + '/manifest.json';
    var manifest;
    try { manifest = await (await fetch(manifestUrl)).json(); }
    catch (e) {
      warn('no ' + manifestUrl + ' — falling back to monolithic ' + (opts.fallback || 'style.json'));
      return await (await fetch(opts.fallback || 'style.json')).json();
    }
    var baseUrl = dir + '/' + (manifest.base || 'helm-base.json');
    var base = await (await fetch(baseUrl)).json();
    var fragUrls = (manifest.fragments || []).map(function (f) { return dir + '/' + f; });
    var loaded = await Promise.all(fragUrls.map(async function (u) {
      try { return await (await fetch(u)).json(); }
      catch (e) { warn('style fragment failed: ' + u); return null; }
    }));
    // runtime-registered fragments: resolve any URL strings too
    var runtime = await Promise.all(fragments.map(async function (f) {
      if (typeof f.src === 'string') { try { return await (await fetch(f.src)).json(); } catch (e) { warn('runtime fragment failed: ' + f.src); return null; } }
      return f.src;
    }));
    // carry top-level keys the base sets (version/name/glyphs/center/zoom) — mergeStyle keeps them.
    return mergeStyle(base, loaded.concat(runtime));
  }

  // ============================================================================================
  //  4. NAV LISTENERS  — per-frame nav hook so a consumer subscribes from its OWN file (SHELL-5)
  // ============================================================================================
  // Before this, every new nav consumer (e.g. WX-13 true-wind) had to hand-add a line to
  // index.html's applyNav() — the last residual shared-file contention the seam was meant to kill.
  //   HelmShell.onNav(fn)      ← register a nav-frame listener; returns { remove() }.
  //   HelmShell.dispatchNav(s) ← fan one nav frame to every registered listener (called once from
  //                              applyNav). A throwing listener is isolated so it can't break the
  //                              others or the rest of applyNav.
  // Registration is order-independent (subscribe before or after boot); listeners only start firing
  // once applyNav begins dispatching frames.
  var navListeners = [];
  function onNav(fn) {
    if (typeof fn !== 'function') { warn('onNav needs a function'); return { remove: function () {} }; }
    navListeners.push(fn);
    return { remove: function () { var i = navListeners.indexOf(fn); if (i >= 0) navListeners.splice(i, 1); } };
  }
  function dispatchNav(s) {
    for (var i = 0; i < navListeners.length; i++) {
      try { navListeners[i](s); } catch (e) { warn('onNav listener failed: ' + e); }
    }
  }

  // ============================================================================================
  //  BOOT  — index.html calls this once `map` exists. Drains queued registrations.
  // ============================================================================================
  function boot(opts) {
    if (booted) { warn('boot() called twice'); return; }
    ctx = { map: opts && opts.map, railEl: opts && opts.railEl };
    booted = true;
    panels.forEach(mountPanel);
    document.dispatchEvent(new CustomEvent('helm:shell-ready', { detail: { shell: window.HelmShell } }));
  }

  // ---- tiny helpers ----
  function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function indexById(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i; return -1; }
  function noopHandle() { return { id: null, el: function () {}, isOpen: function () { return false; }, open: function () {}, close: function () {}, toggle: function () {} }; }

  window.HelmShell = {
    // registration (call these from your epic's own module)
    registerPanel: registerPanel,
    registerCommand: registerCommand,
    registerStyleFragment: registerStyleFragment,
    // command introspection (palette renderers — TOOLS-3 / AI-6)
    commands: commandList,
    runCommand: runCommand,
    onCommandsChanged: onCommandsChanged,
    // panels introspection
    panel: function (id) { var p = byId(panels, id); return p ? p._handle : null; },
    closeAllPanels: closeAllPanels,
    // bridge so the shell's built-in (legacy) drawers and registered panels stay mutually exclusive
    setLegacyCloser: function (fn) { legacyCloser = (typeof fn === 'function') ? fn : null; },
    // nav listeners (subscribe to per-frame nav from your own module; applyNav fans frames here)
    onNav: onNav,
    dispatchNav: dispatchNav,
    // style assembly (called by the shell before the map is built; pure mergeStyle exposed for tests)
    buildStyle: buildStyle,
    mergeStyle: mergeStyle,
    // lifecycle
    boot: boot,
    isBooted: function () { return booted; }
  };
})();
