// HelmAisHub — AIS-10: one boat icon, one panel for ALL of AIS.
//
// Before this, every AIS surface registered its OWN left-rail icon: the boat (a bare layer
// show/hide toggle), the target list, the guard zone (◎), the vector overlay (➢). Four icons for
// one subsystem. This module collapses them into a single boat icon that opens ONE panel whose body
// is a tab strip — Targets · Vectors · Guard (· more as epics add them) — with a master "show
// vessels" toggle in the header.
//
// HOW IT STAYS IN-LANE: the hub owns NOTHING about what each tab does. Each existing AIS module keeps
// its own render function and simply calls HelmAisHub.registerTab({...}) instead of
// HelmShell.registerPanel({...}). If the hub script ever fails to load, every module falls back to
// its old standalone rail panel (see the `registerAisSurface` shims) — so a missing hub degrades to
// the previous UI, never to a dead button. No feature logic moved; this is pure information
// architecture.
//
// SAFE TRANSITION: registerTab is idempotent (dedupes by id) and handles LATE registration — a tab
// that registers after the panel is already open mounts its button live. The hub panel's onOpen
// re-fires the active tab's onShow so live data (the target list, guard status) refreshes on open,
// exactly like the per-panel onOpen did before.
(function () {
  if (!(window.HelmShell && HelmShell.registerPanel)) return;   // no shell → nothing to hang the hub on

  // The same hull+mast+yard glyph the old built-in AIS rail button used, so the icon doesn't move
  // visually — only what it opens changes (a layer toggle → this hub).
  var BOAT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 13h18l-2 5H5z"/><path d="M12 3v10"/><path d="M8 8h8"/></svg>';

  var tabs = [];          // { id, title, render, onShow, _btn, _pane, _rendered }
  var tabBar = null, paneWrap = null, ctxRef = null, activeId = null;

  // Preferred left-to-right tab order (Targets first = the default tab), independent of the order
  // modules happen to register in (ais-vectors/ais-guard self-wire at load; collision registers
  // later from its map factory). Unknown ids sort to the end so new tabs append gracefully.
  var ORDER = ['helm-ais-list', 'helm-ais-vectors', 'helm-ais-guard'];
  function rank(id) { var i = ORDER.indexOf(id); return i < 0 ? 999 : i; }

  function byId(id) { for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i]; return null; }

  // ---- scoped styles (injected once; all selectors under #helm-ais so we stay out of the shell) ----
  (function () {
    var css = document.createElement('style');
    css.textContent =
      '#helm-ais{width:316px}' +
      '#helm-ais .aish-hd{display:flex;align-items:center;gap:9px;font-size:12.5px;color:#e6eef5;' +
        'padding:2px 0 10px;margin-bottom:8px;border-bottom:.5px solid var(--line2,rgba(255,255,255,.07))}' +
      '#helm-ais .aish-hd input{accent-color:#43d17d;width:15px;height:15px;flex:0 0 auto}' +
      '#helm-ais .aish-hd .lbl{flex:1;cursor:pointer;user-select:none}' +
      '#helm-ais .aish-hd .cnt{font-size:10px;letter-spacing:.04em;color:var(--cdim,#9bb0c0)}' +
      '#helm-ais .aish-mode{margin:0 0 11px}' +
      '#helm-ais .aish-mlbl{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--cdim,#9bb0c0);margin:0 0 5px;display:flex;justify-content:space-between}' +
      '#helm-ais .aish-mlbl .anch{color:#7fd0ff;text-transform:none;letter-spacing:0}' +
      '#helm-ais .aish-seg{display:flex;gap:5px}' +
      '#helm-ais .aish-seg button{flex:1;font:500 11px/1 inherit;padding:7px 4px;border-radius:8px;' +
        'border:.5px solid var(--line,rgba(255,255,255,.13));background:transparent;color:var(--cdim,#9bb0c0);cursor:pointer}' +
      '#helm-ais .aish-seg button.on{background:rgba(67,209,125,.16);border-color:rgba(67,209,125,.6);color:#a4f4c1}' +
      '#helm-ais .aish-msub{font-size:10px;color:var(--cdim,#9bb0c0);margin-top:5px;font-variant-numeric:tabular-nums}' +
      '#helm-ais .aish-tabs{display:flex;gap:3px;margin:0 0 10px}' +
      '#helm-ais .aish-tabs button{flex:1;font:500 11.5px/1 inherit;padding:8px 4px;background:transparent;' +
        'border:none;border-bottom:2px solid transparent;color:var(--cdim,#9bb0c0);cursor:pointer}' +
      '#helm-ais .aish-tabs button:hover{color:#cdd9e3}' +
      '#helm-ais .aish-tabs button.on{color:#e6eef5;border-bottom-color:#43d17d}' +
      '#helm-ais .aish-pane[hidden]{display:none}';
    document.head.appendChild(css);
  })();

  function showTab(id) {
    var t = byId(id); if (!t) return;
    activeId = id;
    for (var i = 0; i < tabs.length; i++) {
      var x = tabs[i];
      if (x._btn) x._btn.classList.toggle('on', x === t);
      if (x._pane) x._pane.hidden = (x !== t);
    }
    if (!t._rendered) {
      try { t.render(t._pane, ctxRef || {}); }
      catch (e) { console.error('[AIS hub] tab "' + t.id + '" render failed:', e && e.message); }
      t._rendered = true;
    }
    if (t.onShow) { try { t.onShow(t._pane, ctxRef || {}); } catch (e) { console.warn('[AIS hub] tab "' + t.id + '" onShow failed:', e && e.message); } }
  }

  function mountTab(t) {           // build a tab's button + (empty) pane once the hub body exists
    if (!tabBar || t._btn) return;
    var b = document.createElement('button'); b.type = 'button'; b.textContent = t.title; b.title = t.title + ' tab';
    b.addEventListener('click', function () { showTab(t.id); });
    tabBar.appendChild(b); t._btn = b;
    var p = document.createElement('div'); p.className = 'aish-pane'; p.hidden = true;
    paneWrap.appendChild(p); t._pane = p;
  }

  // Public: an AIS module registers its surface as a tab instead of a standalone rail panel.
  function registerTab(spec) {
    if (!spec || !spec.id || typeof spec.render !== 'function') { console.warn('[AIS hub] registerTab needs {id, render()}'); return null; }
    if (byId(spec.id)) return { id: spec.id };                       // idempotent
    var t = { id: spec.id, title: spec.title || spec.id, render: spec.render, onShow: spec.onShow || spec.onOpen, _btn: null, _pane: null, _rendered: false };
    tabs.push(t);
    if (tabBar) { mountTab(t); if (!activeId) showTab(t.id); }       // hub already built → add live
    return { id: spec.id };
  }

  // The single AIS panel: header (master toggle) + tab strip + pane stack.
  function renderHub(body, ctx) {
    ctxRef = ctx || {};
    var hd = document.createElement('div'); hd.className = 'aish-hd';
    var cb = document.createElement('input'); cb.type = 'checkbox';
    var lbl = document.createElement('label'); lbl.className = 'lbl'; lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' Show vessels on chart'));
    // The master toggle is a thin proxy over the existing Layers-drawer AIS checkbox (the one source
    // of truth for layer visibility), so the two stay in sync and the quick toggle still works.
    function layerCb() { return document.querySelector('.row input[data-layer="ais"]'); }
    var lc = layerCb(); cb.checked = lc ? lc.checked : true;
    cb.addEventListener('change', function () { var l = layerCb(); if (l && l.checked !== cb.checked) { l.checked = cb.checked; l.dispatchEvent(new Event('change')); } });
    if (lc) lc.addEventListener('change', function () { cb.checked = lc.checked; });
    hd.appendChild(lbl);
    body.appendChild(hd);

    // Collision-profile selector (Harbor / Bay / Open ocean) — Cortex-style. Switching re-bands CPA/
    // TCPA across the whole AIS surface (chart colours, cones, alarm). Only shown if the profiles API
    // is present. When the boat is anchored we auto-tighten to Harbor and say so.
    if (window.HelmAisRisk && HelmAisRisk.profiles && HelmAisRisk.setProfile) {
      var mode = document.createElement('div'); mode.className = 'aish-mode';
      var ml = document.createElement('div'); ml.className = 'aish-mlbl';
      var mlt = document.createElement('span'); mlt.textContent = 'Collision profile';
      var anch = document.createElement('span'); anch.className = 'anch';
      ml.appendChild(mlt); ml.appendChild(anch); mode.appendChild(ml);
      var seg = document.createElement('div'); seg.className = 'aish-seg'; mode.appendChild(seg);
      var sub = document.createElement('div'); sub.className = 'aish-msub'; mode.appendChild(sub);
      // Underway override — shown only when the boat reads as anchored. Lets a hove-to / drifting skipper
      // keep the WIDE bands instead of the auto-tighten (their stationary SOG isn't "safely parked").
      var uwLab = document.createElement('label');
      uwLab.style.cssText = 'display:none;align-items:center;gap:5px;font-size:10.5px;color:var(--cdim,#9bb0c0);cursor:pointer;margin-top:5px';
      var uwCb = document.createElement('input'); uwCb.type = 'checkbox'; uwCb.style.cssText = 'width:13px;height:13px;accent-color:#5dd0b0';
      uwCb.addEventListener('change', function () { HelmAisRisk.setUnderwayOverride(uwCb.checked); });   // paint() re-runs via the risk-profile event
      uwLab.appendChild(uwCb); uwLab.appendChild(document.createTextNode('Treat as underway (hove-to / drifting)'));
      mode.appendChild(uwLab);
      function trim(x) { return (Math.round(x * 10) / 10).toString().replace(/\.0$/, ''); }
      function paint() {
        var cur = HelmAisRisk.profile();           // effective (anchored-aware); .id = selected
        Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('on', b.getAttribute('data-id') === cur.id); });
        sub.textContent = 'CPA ' + trim(cur.cpa) + ' NM · ' + Math.round(cur.tcpa) + ' min · vessels ≥ ' + trim(cur.minTargetSog) + ' kn';
        anch.textContent = cur.tightened ? '⚓ anchored → tightened' : (cur.anchored ? '⚓ anchored · treated as underway' : '');
        uwLab.style.display = cur.anchored ? 'flex' : 'none';
        uwCb.checked = !!cur.underway;
      }
      HelmAisRisk.profiles().forEach(function (p) {
        var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-id', p.id); b.textContent = p.label; b.title = 'Collision-risk profile: ' + p.label;
        b.addEventListener('click', function () { HelmAisRisk.setProfile(p.id); });   // paint() runs via the event below
        seg.appendChild(b);
      });
      paint();
      try { window.addEventListener('helm:ais-risk-profile', paint); } catch (e) {}     // selector + anchored auto-tighten both fire this
      body.appendChild(mode);
    }

    tabBar = document.createElement('div'); tabBar.className = 'aish-tabs'; body.appendChild(tabBar);
    paneWrap = document.createElement('div'); paneWrap.className = 'aish-panes'; body.appendChild(paneWrap);

    tabs.sort(function (a, b) { return rank(a.id) - rank(b.id); });
    for (var i = 0; i < tabs.length; i++) mountTab(tabs[i]);
    showTab(activeId || (tabs[0] && tabs[0].id));
  }

  // Register the one boat panel. The shell creates its rail button (boat glyph) + drawer for us.
  HelmShell.registerPanel({
    id: 'helm-ais', epic: 'AIS', title: 'AIS', icon: BOAT,
    render: renderHub,
    onOpen: function () { var t = byId(activeId); if (t && t.onShow) { try { t.onShow(t._pane, ctxRef || {}); } catch (e) {} } }
  });

  // Open the hub (optionally jumping to a tab) — used by the ⌘K commands the modules keep.
  function open(tabId) {
    var h = HelmShell.panel && HelmShell.panel('helm-ais'); if (h) h.open();
    if (tabId) showTab(tabId);
  }

  window.HelmAisHub = { registerTab: registerTab, show: showTab, open: open };
})();
