'use strict';
// health-panel.js -- CLIENT-20: skipper-facing status panel for offshore debugging.
//
// This is deliberately a consumer of existing truth sources: HelmEndpoint (/health + resolved
// origin), HelmNavClient status, HelmShell nav frames, HelmLog, the degraded banner, and browser
// offline/service-worker state. It never marks a subsystem healthy by inference when the source is
// missing; the UI says "not reported" so a screenshot stays actionable.
(function () {
  var PANEL_ID = 'helm-client-health';
  var EPIC = 'CLIENT';
  var POLL_MS = 5000;
  var state = {
    navStatus: null,
    lastNav: null,
    lastNavAt: 0,
    health: null,
    healthAt: 0,
    healthError: '',
    pollTimer: null,
    panelBody: null
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function now() { return Date.now(); }
  function ageMs(t) { return t ? Math.max(0, now() - t) : null; }
  function fmtAge(ms) {
    if (ms == null) return 'never';
    var s = Math.round(ms / 1000);
    if (s < 90) return s + 's';
    var m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    return Math.round(m / 60) + 'h';
  }
  function dash(v) { return v == null || v === '' ? 'not reported' : String(v); }
  function valueAt(obj, paths) {
    for (var i = 0; i < paths.length; i++) {
      var cur = obj, parts = paths[i].split('.');
      for (var j = 0; cur != null && j < parts.length; j++) cur = cur[parts[j]];
      if (cur != null && cur !== '') return cur;
    }
    return null;
  }
  function sevClass(sev) { return sev === 'bad' ? 'bad' : sev === 'warn' ? 'warn' : 'ok'; }
  function badge(label, sev) { return '<span class="hp-badge ' + sevClass(sev) + '">' + esc(label) + '</span>'; }
  function row(label, value, sev, detail) {
    return '<div class="hp-row">' +
      '<div class="hp-k">' + esc(label) + '</div>' +
      '<div class="hp-v">' + badge(value, sev) + (detail ? '<span class="hp-d">' + esc(detail) + '</span>' : '') + '</div>' +
      '</div>';
  }
  function section(title, rowsHtml) {
    return '<section class="hp-sec"><h3>' + esc(title) + '</h3>' + rowsHtml + '</section>';
  }

  function endpointSnapshot() {
    var out = { endpoint: 'not reported', healthUrl: 'not reported', token: false, fingerprint: '' };
    try {
      if (window.HelmEndpoint) {
        out.endpoint = HelmEndpoint.describe ? HelmEndpoint.describe() : 'reported';
        out.healthUrl = HelmEndpoint.healthUrl ? HelmEndpoint.healthUrl() : 'not reported';
        out.token = !!(HelmEndpoint.token && HelmEndpoint.token());
        out.fingerprint = HelmEndpoint.fingerprint ? (HelmEndpoint.fingerprint() || '') : '';
      }
    } catch (e) {}
    return out;
  }
  function runtimeSnapshot(h) {
    h = h || {};
    return {
      version: valueAt(h, ['version', 'engine_version', 'build.version', 'build.git', 'git_sha']),
      s57data: valueAt(h, ['runtime.s57data', 'runtime.HELM_S57_DATA', 'paths.s57data', 'paths.HELM_S57_DATA', 'HELM_S57_DATA']),
      enc: valueAt(h, ['runtime.enc', 'runtime.HELM_ENC', 'paths.enc', 'paths.HELM_ENC', 'HELM_ENC', 'chart_path']),
      senc: valueAt(h, ['runtime.senc', 'runtime.senc_dir', 'runtime.HELM_SENC_DIR', 'paths.senc', 'paths.HELM_SENC_DIR', 'HELM_SENC_DIR'])
    };
  }
  function degradedSnapshot() {
    var b = document.getElementById('degraded-banner');
    var visible = !!(b && !b.hidden);
    return {
      visible: visible,
      title: visible && document.getElementById('dg-ttl') ? document.getElementById('dg-ttl').textContent : '',
      detail: visible && document.getElementById('dg-msg') ? document.getElementById('dg-msg').textContent : ''
    };
  }
  function logsSnapshot() {
    try {
      var r = window.HelmLog && HelmLog.recent ? HelmLog.recent(40) : [];
      var warn = 0, err = 0;
      r.forEach(function (x) { if (x.level === 'warn') warn++; else if (x.level === 'error') err++; });
      return { warn: warn, error: err, recent: r.slice(-8) };
    } catch (e) { return { warn: 0, error: 0, recent: [] }; }
  }
  function wxSnapshot() {
    var notice = document.getElementById('wx-notice');
    var active = window.__activeWx || 'off';
    return {
      active: active,
      scene: !!window.HelmWxScene,
      gpu: !!(window.HelmWxSceneGPU && HelmWxSceneGPU.supported && HelmWxSceneGPU.supported()),
      live: !!window.HelmWxLive,
      codec: !!window.HelmWxCodec,
      ramp: !!window.HelmWxRamp,
      notice: notice && notice.style.display !== 'none' ? notice.textContent : ''
    };
  }
  function navSubsystem() {
    var st = state.navStatus || {};
    var phase = st.phase || 'unknown';
    var sev = phase === 'live' || phase === 'simpos' ? 'ok'
      : phase === 'connecting' || phase === 'lagging' || phase === 'sim' ? 'warn'
      : 'bad';
    return { label: phase, sev: sev, detail: 'frame ' + fmtAge(ageMs(state.lastNavAt)) + ' ago' + (st.seq != null ? ' / seq ' + st.seq : '') };
  }
  function aisSubsystem() {
    var s = state.lastNav || {};
    var conns = Array.isArray(s.conns) ? s.conns : [];
    var aisConns = conns.filter(function (c) {
      return c && (String(c.type || '').indexOf('ais') >= 0 || String(c.name || '').toLowerCase().indexOf('ais') >= 0 || c.status === 'connected');
    });
    var connected = aisConns.some(function (c) { return c.status === 'connected'; });
    var err = aisConns.find(function (c) { return c.status === 'error'; });
    var targets = Array.isArray(s.ais) ? s.ais.length : 0;
    if (err) return { label: 'degraded', sev: 'bad', detail: (err.name || err.id || 'source') + ': ' + (err.error || 'error') };
    if (connected || targets) return { label: connected ? 'connected' : 'targets only', sev: 'ok', detail: targets + ' targets / ' + aisConns.length + ' sources' };
    if (conns.length) return { label: 'no AIS data', sev: 'warn', detail: conns.length + ' data sources reported' };
    return { label: 'not reported', sev: 'warn', detail: 'no connection state in latest nav frame' };
  }
  function wxSubsystem() {
    var w = wxSnapshot();
    if (w.notice) return { label: 'degraded', sev: 'warn', detail: w.notice };
    if (w.active && w.active !== 'off') {
      var renderer = w.scene ? 'scene' : w.live ? 'live' : 'renderer missing';
      return { label: w.active, sev: w.scene || w.live ? 'ok' : 'bad', detail: renderer + (w.gpu ? ' / GPU' : '') };
    }
    return { label: 'off', sev: 'ok', detail: (w.codec && w.ramp ? 'weather modules loaded' : 'module status partial') };
  }
  function chartSubsystem() {
    var h = state.health || {};
    if (!state.health && state.healthError) return { label: 'unreachable', sev: 'bad', detail: state.healthError };
    if (!state.health) return { label: 'not checked', sev: 'warn', detail: 'open panel to poll /health' };
    if (h.chart_loaded) return { label: 'loaded', sev: 'ok', detail: h.chart_status || '' };
    return { label: h.chart_status || 'not loaded', sev: 'warn', detail: h.chart_unavailable_reason || 'chart engine reported no chart' };
  }
  function browserSubsystem() {
    var online = typeof navigator === 'undefined' || navigator.onLine !== false;
    var sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    return { label: online ? 'online' : 'offline', sev: online ? 'ok' : 'warn', detail: sw ? 'service worker controlling page' : 'service worker not controlling page' };
  }

  function snapshot() {
    var h = state.health || {};
    return {
      at: new Date().toISOString(),
      endpoint: endpointSnapshot(),
      health: {
        ok: !!state.health,
        age: fmtAge(ageMs(state.healthAt)),
        error: state.healthError,
        payload: h
      },
      runtime: runtimeSnapshot(h),
      degraded: degradedSnapshot(),
      logs: logsSnapshot(),
      navStatus: state.navStatus,
      lastNavAge: fmtAge(ageMs(state.lastNavAt)),
      subsystems: {
        nav: navSubsystem(),
        ais: aisSubsystem(),
        weather: wxSubsystem(),
        chart: chartSubsystem(),
        browser: browserSubsystem()
      }
    };
  }

  function render() {
    if (!state.panelBody) return;
    var snap = snapshot();
    var h = state.health || {};
    var rt = snap.runtime;
    var log = snap.logs;
    var degraded = snap.degraded;
    var subs = snap.subsystems;
    var endpoint = snap.endpoint;
    var nav = h.nav || {};

    var summary =
      row('Navigation', subs.nav.label, subs.nav.sev, subs.nav.detail) +
      row('AIS', subs.ais.label, subs.ais.sev, subs.ais.detail) +
      row('Weather', subs.weather.label, subs.weather.sev, subs.weather.detail) +
      row('Chart engine', subs.chart.label, subs.chart.sev, subs.chart.detail) +
      row('Client', subs.browser.label, subs.browser.sev, subs.browser.detail);
    var engine =
      row('Engine', dash(h.engine), h.engine ? 'ok' : 'warn', 'health ' + snap.health.age + ' ago') +
      row('Version', dash(rt.version), rt.version ? 'ok' : 'warn') +
      row('HELM_S57_DATA', dash(rt.s57data), rt.s57data ? 'ok' : 'warn') +
      row('HELM_ENC', dash(rt.enc), rt.enc ? 'ok' : 'warn') +
      row('HELM_SENC_DIR', dash(rt.senc), rt.senc ? 'ok' : 'warn');
    var navRows =
      row('Health fix', nav.fix_status || 'not reported', nav.fix_status === 'live' ? 'ok' : nav.fix_status ? 'warn' : 'warn', nav.reason || '') +
      row('Required fields', Array.isArray(nav.required) ? nav.required.join(', ') : 'not reported', 'ok') +
      row('Missing fields', Array.isArray(nav.missing) && nav.missing.length ? nav.missing.join(', ') : 'none', Array.isArray(nav.missing) && nav.missing.length ? 'bad' : 'ok') +
      row('Field ages', nav.fields ? ('pos ' + nav.fields.posAgeSec + 's / sog ' + nav.fields.sogAgeSec + 's / cog ' + nav.fields.cogAgeSec + 's') : 'not reported', nav.fields ? 'ok' : 'warn');
    var diag =
      row('App degraded', degraded.visible ? degraded.title : 'clear', degraded.visible ? 'bad' : 'ok', degraded.detail || '') +
      row('Log ring', log.error + ' errors / ' + log.warn + ' warnings', log.error ? 'bad' : log.warn ? 'warn' : 'ok') +
      row('Endpoint', endpoint.endpoint, endpoint.endpoint === 'not reported' ? 'warn' : 'ok', endpoint.token ? 'paired token present' : 'no token') +
      row('Health URL', endpoint.healthUrl, endpoint.healthUrl === 'not reported' ? 'warn' : 'ok');
    var conns = (state.lastNav && Array.isArray(state.lastNav.conns)) ? state.lastNav.conns : [];
    var connRows = conns.length ? conns.map(function (c) {
      var sev = c.status === 'connected' ? 'ok' : c.status === 'error' ? 'bad' : 'warn';
      return row(c.name || c.id || 'source', c.status || 'unknown', sev,
        (c.type || 'source') + (c.sentences != null ? ' / ' + c.sentences + ' msg' : '') + (c.ageSec != null ? ' / ' + c.ageSec + 's age' : '') + (c.error ? ' / ' + c.error : ''));
    }).join('') : row('Sources', 'not reported', 'warn', 'no conns[] in latest nav frame');

    state.panelBody.innerHTML =
      '<div class="hp-actions">' +
        '<button type="button" class="hp-btn" data-act="refresh" title="Refresh engine health">Refresh</button>' +
        '<button type="button" class="hp-btn" data-act="copy" title="Copy status JSON">Copy JSON</button>' +
        '<span class="hp-stamp">Updated ' + esc(new Date().toLocaleTimeString()) + '</span>' +
      '</div>' +
      section('Subsystems', summary) +
      section('Engine Runtime', engine) +
      section('Nav Fix Health', navRows) +
      section('Live Data Sources', connRows) +
      section('Diagnostics', diag);
    state.panelBody.querySelector('[data-act="refresh"]').addEventListener('click', function () { fetchHealth(true); });
    state.panelBody.querySelector('[data-act="copy"]').addEventListener('click', copySnapshot);
  }

  function copySnapshot() {
    var text = JSON.stringify(snapshot(), null, 2);
    var btn = state.panelBody && state.panelBody.querySelector('[data-act="copy"]');
    function mark(ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { btn.textContent = 'Copy JSON'; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { mark(true); }, function () { mark(false); });
    } else mark(false);
  }

  function ensureStyle() {
    if (document.getElementById('helm-client-health-style')) return;
    var style = document.createElement('style');
    style.id = 'helm-client-health-style';
    style.textContent = [
      '#helm-client-health{width:330px;max-height:calc(100vh - 104px)}',
      '#helm-client-health .hp-actions{display:flex;align-items:center;gap:7px;margin:6px 0 10px}',
      '#helm-client-health .hp-btn{background:var(--glass2);border:.5px solid var(--line);border-radius:7px;color:var(--ctext);font:600 11px -apple-system,sans-serif;padding:6px 8px;cursor:pointer}',
      '#helm-client-health .hp-btn:hover{border-color:var(--accent)}',
      '#helm-client-health .hp-stamp{margin-left:auto;font-size:10px;color:var(--cdim2);white-space:nowrap}',
      '#helm-client-health .hp-sec{border-top:.5px solid var(--line);padding:10px 0 4px}',
      '#helm-client-health .hp-sec h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--cdim2);font-weight:700;margin:0 0 7px}',
      '#helm-client-health .hp-row{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;align-items:start;padding:5px 0;border-bottom:.5px solid var(--line2)}',
      '#helm-client-health .hp-k{font-size:11px;color:var(--cdim);line-height:1.35;min-width:0}',
      '#helm-client-health .hp-v{font-size:11.5px;color:var(--ctext);line-height:1.35;min-width:0;overflow-wrap:anywhere}',
      '#helm-client-health .hp-d{display:block;color:var(--cdim2);font-size:10px;margin-top:2px;overflow-wrap:anywhere}',
      '#helm-client-health .hp-badge{display:inline-block;border:.5px solid var(--line);border-radius:6px;padding:1px 6px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
      '#helm-client-health .hp-badge.ok{color:var(--ok);border-color:rgba(70,224,160,.45);background:rgba(70,224,160,.08)}',
      '#helm-client-health .hp-badge.warn{color:var(--warn);border-color:rgba(255,192,106,.5);background:rgba(255,192,106,.09)}',
      '#helm-client-health .hp-badge.bad{color:#fff;border-color:rgba(255,107,107,.65);background:rgba(255,107,107,.18)}',
      '@media(max-width:700px){#helm-client-health{width:auto}#helm-client-health .hp-row{grid-template-columns:84px minmax(0,1fr)}}'
    ].join('\n');
    document.head.appendChild(style);
  }
  function fitRail() {
    if (!document.getElementById('helm-client-health-rail-style')) {
      var css = document.createElement('style');
      css.id = 'helm-client-health-rail-style';
      css.textContent = [
        // CLIENT-20 adds another registered panel; compact short desktop rails enough that the
        // legacy Settings icon stays above the bottom instrument bar.
        '@media (min-width:561px) and (max-height:760px){',
        '.rail.helm-client-health-rail-fit{gap:2px;padding-top:7px;padding-bottom:7px}',
        '.rail.helm-client-health-rail-fit .ri{width:32px;height:32px}',
        '.rail.helm-client-health-rail-fit .ri svg{width:18px;height:18px}',
        '.rail.helm-client-health-rail-fit .ri span{font-size:13px!important}',
        '.rail.helm-client-health-rail-fit .sep{margin:2px 0}',
        '}'
      ].join('\n');
      document.head.appendChild(css);
    }
    var rail = document.querySelector && document.querySelector('.rail');
    if (rail) rail.classList.add('helm-client-health-rail-fit');
  }

  function renderPanel(body) {
    ensureStyle();
    body.insertAdjacentHTML('beforeend', '<div class="sub">Boat-server, feed, runtime, and browser health</div><div class="hp-body"></div>');
    state.panelBody = body.querySelector('.hp-body');
    render();
  }
  function onOpen(body) {
    if (!state.panelBody) state.panelBody = body.querySelector('.hp-body');
    fetchHealth(true);
    startPolling();
    render();
  }
  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () { fetchHealth(false); }, POLL_MS);
  }

  function fetchHealth(force) {
    if (!force && state.healthAt && now() - state.healthAt < POLL_MS - 250) return Promise.resolve(state.health);
    var url = null;
    try { url = window.HelmEndpoint && HelmEndpoint.healthUrl && HelmEndpoint.healthUrl(); } catch (e) {}
    if (!url) {
      state.healthError = 'HelmEndpoint.healthUrl unavailable';
      render();
      return Promise.resolve(null);
    }
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 2500) : null;
    return fetch(url, { cache: 'no-store', signal: controller && controller.signal }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (timer) clearTimeout(timer);
      state.health = j;
      state.healthAt = now();
      state.healthError = '';
      render();
      return j;
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      state.healthError = (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e));
      state.healthAt = now();
      render();
      return null;
    });
  }

  function onStatus(st) {
    state.navStatus = st || null;
    render();
  }
  function onNav(s) {
    state.lastNav = s || null;
    state.lastNavAt = now();
    render();
  }
  function register() {
    if (!window.HelmShell) return;
    fitRail();
    HelmShell.registerPanel({
      id: PANEL_ID,
      epic: EPIC,
      title: 'Status',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/><circle cx="19" cy="5" r="2"/></svg>',
      render: renderPanel,
      onOpen: onOpen
    });
    if (HelmShell.registerCommand) HelmShell.registerCommand({
      id: 'helm-client-health-open',
      epic: EPIC,
      title: 'Open status',
      subtitle: 'Engine, feeds, runtime paths, degraded state',
      keywords: ['status', 'health', 'diagnostics', 'runtime', 'engine', 'client'],
      group: 'Client',
      run: function () { var p = HelmShell.panel(PANEL_ID); if (p) p.open(); }
    });
    if (HelmShell.onNav) HelmShell.onNav(onNav);
  }

  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  register();

  window.HelmHealthPanel = {
    fetch: fetchHealth,
    onStatus: onStatus,
    onNav: onNav,
    render: render,
    snapshot: snapshot,
    _state: state
  };
})();
