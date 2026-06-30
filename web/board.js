// board.js — BOARD-1 composable Smart Board substrate.
// Registers a HelmShell panel that owns the board layout state: multiple boards,
// draggable/resizable tiles, arbitrary SignalK/nav paths, sparklines, alarms,
// mode boards, automation rules, and persisted cockpit layouts.
(function () {
  'use strict';

  var STORE = 'board.state.v1';
  var PANEL_ID = 'helm-board-panel';
  var lastNav = null;
  var panelEl = null;
  var boardSelect = null;
  var modeSelect = null;
  var nameInput = null;
  var gridEl = null;
  var addSelect = null;
  var customPathInput = null;
  var customTitleInput = null;
  var customUnitInput = null;
  var rulePathInput = null;
  var ruleOpSelect = null;
  var ruleValueInput = null;
  var ruleActionSelect = null;
  var ruleListEl = null;
  var dragId = null;

  function warn(msg) { try { console.warn('[HelmBoard] ' + msg); } catch (e) {} }
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function clamp(n, lo, hi) { n = Number(n) || lo; return Math.max(lo, Math.min(hi, n)); }
  function has(v) { return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)); }
  function dash(v) { return v == null || v === '' ? '—' : String(v); }
  function sourceOf(s, key) { return (s && s.sources && s.sources[key]) ? s.sources[key] : ''; }
  function missing(s, key) { return sourceOf(s, key) === 'missing'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtPathTitle(path) {
    return String(path || '').split('.').filter(Boolean).slice(-2).join(' ') || 'SignalK path';
  }
  function parseNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    var m = String(v == null ? '' : v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  var MODES = ['Underway', 'Anchor', 'Engine', 'Racing', 'Night', 'Docking'];
  var OPS = ['>', '>=', '<', '<=', '=', '!='];
  var HISTORY_MAX = 32;

  var CATALOG = [
    { key: 'sog', title: 'SOG', unit: 'kn', source: 'sog', path: 'navigation.speedOverGround', read: function (s) {
      return missing(s, 'sog') || !has(s && s.sog) ? null : Number(s.sog).toFixed(1);
    }},
    { key: 'cog', title: 'COG', unit: '°', source: 'cog', path: 'navigation.courseOverGroundTrue', read: function (s) {
      return missing(s, 'cog') || !has(s && s.cog) ? null : Math.round(Number(s.cog));
    }},
    { key: 'heading', title: 'Heading', unit: '°', source: 'hdg', path: 'navigation.headingTrue', read: function (s) {
      return missing(s, 'hdg') || !has(s && s.hdg) ? null : Math.round(Number(s.hdg));
    }},
    { key: 'depth', title: 'Depth', unit: 'm', source: 'depth', path: 'environment.depth.belowTransducer', read: function (s) {
      return missing(s, 'depth') || !has(s && s.depth) ? null : Number(s.depth).toFixed(1);
    }},
    { key: 'wind-speed', title: 'Wind Speed', unit: 'kt', source: 'wind', path: 'environment.wind.speedTrue', read: function (s) {
      return missing(s, 'wind') || !has(s && s.wind && s.wind.spd) ? null : Math.round(Number(s.wind.spd));
    }},
    { key: 'wind-dir', title: 'Wind Dir', unit: '°', source: 'wind', path: 'environment.wind.directionTrue', read: function (s) {
      return missing(s, 'wind') || !has(s && s.wind && s.wind.dir) ? null : Math.round(Number(s.wind.dir));
    }},
    { key: 'position', title: 'Position', unit: '', source: 'pos', path: 'navigation.position', wide: true, read: function (s) {
      return (s && s.posStr) ? s.posStr : null;
    }},
    { key: 'next', title: 'Next Waypoint', unit: '', source: 'route', path: 'active.nextWp', wide: true, read: function (s) {
      return s && s.active && s.active.nextWp ? s.active.nextWp : null;
    }},
    { key: 'dtg', title: 'DTG', unit: 'NM', source: 'route', path: 'active.dtg', read: function (s) {
      return s && s.active && s.active.dtg ? String(s.active.dtg).replace(/\s*NM$/i, '') : null;
    }},
    { key: 'xte', title: 'XTE', unit: 'NM', source: 'route', path: 'active.xte', read: function (s) {
      return s && s.active && s.active.xte ? String(s.active.xte).replace(/\s*NM$/i, '') : null;
    }}
  ];
  var byKey = CATALOG.reduce(function (m, c) { m[c.key] = c; return m; }, {});
  var SIZE_STEPS = [[1, 1], [2, 1], [2, 2], [3, 2], [4, 2]];

  function defaultTile(key, w, h, extra) {
    var c = byKey[key] || CATALOG[0];
    var t = {
      id: uid('tile'),
      key: c.key,
      title: c.title,
      path: c.path || c.key,
      unit: c.unit || '',
      w: w || (c.wide ? 2 : 1),
      h: h || 1
    };
    if (extra) Object.keys(extra).forEach(function (k) { t[k] = extra[k]; });
    return t;
  }
  function defaultBoard(mode) {
    mode = mode || 'Underway';
    return {
      id: mode.toLowerCase(),
      name: mode,
      mode: mode,
      tiles: mode === 'Underway'
        ? [
          defaultTile('sog'), defaultTile('cog'), defaultTile('wind-speed'), defaultTile('wind-dir'),
          defaultTile('depth'), defaultTile('position', 2, 1)
        ]
        : []
    };
  }
  function defaultState() {
    return {
      activeId: 'underway',
      mode: 'Underway',
      boards: [defaultBoard('Underway')],
      rules: []
    };
  }

  function storeGet(key, fallback) {
    try {
      if (window.HelmStore) return window.HelmStore.get(key, fallback);
      var raw = localStorage.getItem('helm.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      warn('read failed, using default: ' + (e && e.message));
      return fallback;
    }
  }
  function storeSet(key, value) {
    try {
      if (window.HelmStore) return window.HelmStore.set(key, value);
      localStorage.setItem('helm.' + key, JSON.stringify(value));
      return true;
    } catch (e) {
      warn('write failed — board layout was NOT persisted: ' + (e && e.message));
      return false;
    }
  }

  function normalizeAlarm(raw) {
    if (!raw || typeof raw !== 'object') return { enabled: false, op: '>', threshold: '', hysteresis: 0 };
    var op = OPS.indexOf(raw.op) >= 0 ? raw.op : '>';
    return { enabled: !!raw.enabled, op: op, threshold: raw.threshold == null ? '' : raw.threshold, hysteresis: Math.max(0, Number(raw.hysteresis) || 0) };
  }
  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var path = String(raw.path || '').trim();
    if (!path) return null;
    return {
      id: raw.id || uid('rule'),
      path: path,
      op: OPS.indexOf(raw.op) >= 0 ? raw.op : '>',
      value: raw.value == null ? '' : raw.value,
      action: String(raw.action || 'notify'),
      active: false
    };
  }
  function normalize(raw) {
    var s = raw && typeof raw === 'object' ? raw : defaultState();
    if (!Array.isArray(s.boards) || !s.boards.length) s = defaultState();
    s.mode = MODES.indexOf(s.mode) >= 0 ? s.mode : 'Underway';
    s.boards = s.boards.map(function (b, i) {
      var id = b.id || ('board-' + i);
      var mode = MODES.indexOf(b.mode) >= 0 ? b.mode : (i === 0 ? 'Underway' : s.mode);
      var tiles = Array.isArray(b.tiles) ? b.tiles : [];
      return {
        id: id,
        name: String(b.name || ('Board ' + (i + 1))).slice(0, 28),
        mode: mode,
        tiles: tiles.filter(function (t) {
          return t && (byKey[t.key] || t.key === 'custom' || t.path);
        }).map(function (t) {
          var c = byKey[t.key] || null;
          var path = String(t.path || (c && c.path) || t.key || '').trim();
          return {
            id: t.id || uid('tile'),
            key: c ? c.key : 'custom',
            title: String(t.title || (c && c.title) || fmtPathTitle(path)).slice(0, 36),
            path: path,
            unit: String(t.unit != null ? t.unit : ((c && c.unit) || '')).slice(0, 12),
            w: clamp(t.w, 1, 4),
            h: clamp(t.h, 1, 3),
            alarm: normalizeAlarm(t.alarm),
            _history: Array.isArray(t._history) ? t._history.slice(-HISTORY_MAX) : [],
            _alarmActive: false,
            _alarmRev: 0
          };
        })
      };
    });
    if (!s.boards.some(function (b) { return b.id === s.activeId; })) s.activeId = s.boards[0].id;
    s.rules = (Array.isArray(s.rules) ? s.rules : []).map(normalizeRule).filter(Boolean);
    return s;
  }

  var state = normalize(storeGet(STORE, null));
  function cleanState() {
    return {
      activeId: state.activeId,
      mode: state.mode,
      boards: state.boards.map(function (b) {
        return {
          id: b.id, name: b.name, mode: b.mode,
          tiles: b.tiles.map(function (t) {
            return { id: t.id, key: t.key, title: t.title, path: t.path, unit: t.unit, w: t.w, h: t.h, alarm: normalizeAlarm(t.alarm) };
          })
        };
      }),
      rules: state.rules.map(function (r) { return { id: r.id, path: r.path, op: r.op, value: r.value, action: r.action }; })
    };
  }
  function save() { storeSet(STORE, cleanState()); }
  function activeBoard() {
    return state.boards.find(function (b) { return b.id === state.activeId; }) || state.boards[0];
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, title) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }

  function mappedPath(s, path) {
    var p = String(path || '').trim();
    if (!p) return null;
    var aliases = {
      'navigation.speedOverGround': 'sog',
      'navigation.courseOverGroundTrue': 'cog',
      'navigation.headingTrue': 'hdg',
      'navigation.position': 'posStr',
      'navigation.position.latitude': 'pos.lat',
      'navigation.position.longitude': 'pos.lon',
      'environment.depth.belowTransducer': 'depth',
      'environment.wind.speedApparent': 'wind.spd',
      'environment.wind.speedTrue': 'wind.spd',
      'environment.wind.directionTrue': 'wind.dir',
      'performance.velocityMadeGood': 'active.vmg',
      'navigation.distanceToNextWaypoint': 'active.dtg',
      'navigation.crossTrackError': 'active.xte'
    };
    return aliases[p] || p.replace(/^vessels\.self\./, '');
  }
  function getPathValue(s, path) {
    if (!s) return null;
    var p = mappedPath(s, path);
    if (!p) return null;
    if (p.indexOf('.') < 0 && Object.prototype.hasOwnProperty.call(s, p)) return s[p];
    var cur = s;
    p.split('.').forEach(function (part) { if (cur != null) cur = cur[part]; });
    return cur == null ? null : cur;
  }
  function readTile(tile, s) {
    var c = byKey[tile.key];
    if (c && tile.path === c.path && !tile.titleChanged) return c.read(s || {});
    var v = getPathValue(s || {}, tile.path);
    if (v && typeof v === 'object') {
      if (v.lat != null && (v.lon != null || v.lng != null)) return Number(v.lat).toFixed(4) + ', ' + Number(v.lon != null ? v.lon : v.lng).toFixed(4);
      return JSON.stringify(v);
    }
    return v;
  }
  function compareValue(actual, op, threshold, hysteresis, wasActive) {
    actual = parseNumber(actual);
    threshold = parseNumber(threshold);
    hysteresis = Math.max(0, Number(hysteresis) || 0);
    if (actual == null || threshold == null) return false;
    var t = threshold;
    if (wasActive) {
      if (op === '>' || op === '>=') t = threshold - hysteresis;
      if (op === '<' || op === '<=') t = threshold + hysteresis;
    }
    if (op === '>') return actual > t;
    if (op === '>=') return actual >= t;
    if (op === '<') return actual < t;
    if (op === '<=') return actual <= t;
    if (op === '=') return Math.abs(actual - t) <= Math.max(hysteresis, 0.000001);
    if (op === '!=') return Math.abs(actual - t) > Math.max(hysteresis, 0.000001);
    return false;
  }
  function tileAlarmId(tile) {
    return 'tile:' + String(tile.path || tile.id).trim().replace(/\s+/g, '_');
  }
  function emitTileAlarm(id, op, rev, msg, data, haptic) {
    try {
      if (haptic && navigator.vibrate) navigator.vibrate([80, 40, 80]);
      if (window.__alarms && window.__alarms.fromAlarm) {
        window.__alarms.fromAlarm({ t: 'alarm', op: op || 'raise', id: id, kind: 'tile', gen: 0, rev: rev || 1, sev: 'critical', msg: msg, silenceable: true, data: data || {} });
      }
    } catch (e) { warn('alarm raise failed: ' + (e && e.message)); }
  }
  function clearAlarm(id) {
    try { if (window.__alarms && window.__alarms.clearById) window.__alarms.clearById(id); } catch (e) {}
  }
  function evaluateTileAlarm(tile, raw) {
    var a = normalizeAlarm(tile.alarm);
    var id = tileAlarmId(tile);
    var active = a.enabled && compareValue(raw, a.op, a.threshold, a.hysteresis, tile._alarmActive);
    var value = parseNumber(raw);
    var threshold = parseNumber(a.threshold);
    var msg = tile.title + ' ' + a.op + ' ' + a.threshold + (tile.unit ? ' ' + tile.unit : '') + ' — now ' + dash(raw);
    if (active && (!tile._alarmActive || Math.abs((tile._alarmLastValue == null ? value : tile._alarmLastValue) - value) > 0.000001 || tile._alarmLastMsg !== msg)) {
      tile._alarmRev = (tile._alarmRev || 0) + 1;
      emitTileAlarm(id, tile._alarmActive ? 'update' : 'raise', tile._alarmRev, msg, {
        path: tile.path, value: value, unit: tile.unit, threshold: threshold,
        op: a.op, hysteresis: a.hysteresis, tileId: tile.id
      }, !tile._alarmActive);
      tile._alarmLastValue = value;
      tile._alarmLastMsg = msg;
    } else if (!active && tile._alarmActive) {
      clearAlarm(id);
      tile._alarmLastValue = null;
      tile._alarmLastMsg = '';
    }
    tile._alarmActive = active;
  }
  function trend(tile) {
    var h = tile._history || [];
    if (h.length < 2) return { label: 'trend —', up: false, down: false };
    var d = h[h.length - 1] - h[0];
    return { label: (d > 0 ? '↑ ' : (d < 0 ? '↓ ' : '→ ')) + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0), up: d > 0, down: d < 0 };
  }
  function sparkline(tile) {
    var h = tile._history || [];
    if (h.length < 2) return '';
    var min = Math.min.apply(null, h), max = Math.max.apply(null, h), span = max - min || 1;
    var pts = h.map(function (v, i) {
      var x = (i / Math.max(1, h.length - 1)) * 100;
      var y = 24 - ((v - min) / span) * 22 - 1;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '"/></svg>';
  }

  function fitRail() {
    if (!document.getElementById('helm-board-rail-style')) {
      var css = document.createElement('style');
      css.id = 'helm-board-rail-style';
      css.textContent = [
        // BOARD-1 adds one more registered rail panel. On 720px-tall tablets/laptops the legacy
        // settings icon otherwise slips under the bottom instrument bar, so compact only short
        // non-mobile rails by a couple of pixels instead of changing the shell contract.
        '@media (min-width:561px) and (max-height:760px){',
        '.rail.helm-board-rail-dense{gap:3px}',
        '.rail.helm-board-rail-dense .ri{width:34px;height:34px}',
        '.rail.helm-board-rail-dense .ri svg{width:19px;height:19px}',
        '.rail.helm-board-rail-dense .sep{margin:2px 0}',
        '}'
      ].join('\n');
      document.head.appendChild(css);
    }
    var rail = document.querySelector('.rail');
    if (rail) rail.classList.add('helm-board-rail-dense');
  }

  function ensureStyles() {
    if (document.getElementById('helm-board-style')) return;
    var css = document.createElement('style');
    css.id = 'helm-board-style';
    css.textContent = [
      '.helm-board-drawer{width:336px}',
      '.helm-board-top{display:flex;gap:7px;align-items:center;margin:8px 0 9px}',
      '.helm-board-top select,.helm-board-top input,.helm-board-add select,.helm-board-add input,.helm-board-rule input,.helm-board-rule select,.helm-board-alarm input,.helm-board-alarm select{min-width:0;background:rgba(0,0,0,.24);color:var(--ctext);border:.5px solid var(--line);border-radius:8px;padding:7px 8px;font:12px -apple-system,sans-serif;outline:none}',
      '.helm-board-top select{flex:1.1}.helm-board-top input{flex:1}',
      '.helm-board-btn{background:rgba(255,255,255,.06);color:var(--ctext);border:.5px solid var(--line);border-radius:8px;padding:7px 9px;font:12px -apple-system,sans-serif;cursor:pointer}',
      '.helm-board-btn:hover{background:rgba(255,255,255,.12)}',
      '.helm-board-add,.helm-board-custom,.helm-board-rule{display:flex;gap:7px;margin:0 0 10px}.helm-board-add select,.helm-board-custom input,.helm-board-rule input{flex:1}.helm-board-custom input:nth-child(3){flex:.5}',
      '.helm-board-mode{flex:.85!important}',
      '.helm-board-section{font-size:9.5px;color:var(--cdim2);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin:10px 0 5px}',
      '.helm-board-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px}',
      '.helm-board-tile{position:relative;min-width:0;border:.5px solid var(--line);border-radius:12px;background:rgba(255,255,255,.045);padding:9px;box-sizing:border-box;cursor:grab;transition:transform .12s ease,background .12s ease,border-color .12s ease}',
      '.helm-board-tile:active{cursor:grabbing}.helm-board-tile.drag-over{border-color:var(--accent);background:rgba(91,192,255,.10)}',
      '.helm-board-thead{display:flex;align-items:center;gap:5px;margin-bottom:5px}',
      '.helm-board-grip{color:var(--cdim2);font-size:13px;line-height:1}.helm-board-title{font-size:9.5px;color:var(--cdim2);letter-spacing:.08em;text-transform:uppercase;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.helm-board-actions{margin-left:auto;display:flex;gap:3px}.helm-board-actions button{width:22px;height:22px;border-radius:7px;border:0;background:rgba(255,255,255,.06);color:var(--cdim);cursor:pointer;font-size:11px}.helm-board-actions button:hover{color:var(--ctext);background:rgba(255,255,255,.14)}',
      '.helm-board-value{font-size:22px;line-height:1.12;color:var(--ctext);font-variant-numeric:tabular-nums;font-weight:560;letter-spacing:-.018em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.helm-board-unit{font-size:10.5px;color:var(--cdim);font-weight:400;margin-left:3px}.helm-board-meta,.helm-board-trend{font-size:9.5px;color:var(--cdim2);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.helm-board-trend.up{color:#7bdc97}.helm-board-trend.down{color:#ffb36a}',
      '.helm-board-spark{height:24px;margin-top:6px}.helm-board-spark svg{width:100%;height:24px}.helm-board-spark polyline{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke;opacity:.78}',
      '.helm-board-alarm{display:grid;grid-template-columns:18px 1fr 1fr 1fr;gap:4px;align-items:center;margin-top:7px}.helm-board-alarm input[type=checkbox]{width:14px;height:14px;padding:0;accent-color:var(--accent)}.helm-board-alarm input,.helm-board-alarm select{padding:4px 5px;font-size:10.5px}',
      '.helm-board-rules{border:.5px solid var(--line2);border-radius:10px;padding:7px;margin-bottom:10px}.helm-board-rule-list{font-size:10.5px;color:var(--cdim);line-height:1.45}.helm-board-rule-list button{float:right;border:0;border-radius:6px;background:rgba(255,255,255,.08);color:var(--cdim);cursor:pointer}',
      '.helm-board-empty{grid-column:1/-1;border:.5px dashed var(--line);border-radius:12px;color:var(--cdim);font-size:12px;padding:18px;text-align:center}',
      '.helm-board-foot{font-size:10.5px;color:var(--cdim2);line-height:1.42;margin-top:10px;border-top:.5px solid var(--line2);padding-top:9px}',
      '@media (max-width:560px){.helm-board-drawer{width:auto}.helm-board-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.helm-board-tile{grid-column:span 1!important}.helm-board-top{flex-wrap:wrap}.helm-board-top select,.helm-board-top input{flex:1 1 120px}}'
    ].join('\n');
    document.head.appendChild(css);
  }

  function renderPanel(body) {
    ensureStyles();
    panelEl = body;
    body.classList.add('helm-board-drawer');
    body.appendChild(el('p', 'sub', 'Drag tiles to reorder, resize the cockpit blocks, and keep multiple persisted board layouts. SignalK paths, history, alarms, and modes build on this substrate.'));

    var top = el('div', 'helm-board-top');
    boardSelect = document.createElement('select');
    boardSelect.setAttribute('aria-label', 'Active Smart Board');
    boardSelect.addEventListener('change', function () { state.activeId = boardSelect.value; save(); renderAll(); });
    modeSelect = document.createElement('select');
    modeSelect.className = 'helm-board-mode';
    modeSelect.setAttribute('aria-label', 'Smart Board mode');
    MODES.forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m; modeSelect.appendChild(o);
    });
    modeSelect.addEventListener('change', function () { setMode(modeSelect.value); });
    nameInput = document.createElement('input');
    nameInput.maxLength = 28;
    nameInput.placeholder = 'Board name';
    nameInput.addEventListener('change', function () {
      activeBoard().name = (nameInput.value || 'Board').slice(0, 28);
      save(); renderAll();
    });
    var addBoard = button('helm-board-btn', '+', 'Add board');
    addBoard.addEventListener('click', function () {
      var b = { id: uid('board'), name: state.mode + ' ' + (state.boards.length + 1), mode: state.mode, tiles: [] };
      state.boards.push(b); state.activeId = b.id; save(); renderAll();
    });
    var delBoard = button('helm-board-btn', '−', 'Delete board');
    delBoard.addEventListener('click', function () {
      if (state.boards.length <= 1) return;
      var b = activeBoard();
      state.boards = state.boards.filter(function (x) { return x.id !== b.id; });
      state.activeId = state.boards[0].id;
      save(); renderAll();
    });
    top.appendChild(boardSelect); top.appendChild(modeSelect); top.appendChild(nameInput); top.appendChild(addBoard); top.appendChild(delBoard);
    body.appendChild(top);

    body.appendChild(el('div', 'helm-board-section', 'Catalog tiles'));
    var add = el('div', 'helm-board-add');
    addSelect = document.createElement('select');
    addSelect.className = 'helm-board-add-select';
    CATALOG.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.key; o.textContent = c.title; addSelect.appendChild(o);
    });
    var addTileBtn = button('helm-board-btn helm-board-add-btn', 'Add tile', 'Add selected tile');
    addTileBtn.addEventListener('click', function () { addTile(addSelect.value); });
    var resetBtn = button('helm-board-btn', 'Reset', 'Reset active board to defaults');
    resetBtn.addEventListener('click', function () {
      var fresh = defaultState().boards[0];
      var b = activeBoard();
      b.name = b.name || fresh.name;
      b.tiles = fresh.tiles;
      save(); renderAll();
    });
    add.appendChild(addSelect); add.appendChild(addTileBtn); add.appendChild(resetBtn);
    body.appendChild(add);

    body.appendChild(el('div', 'helm-board-section', 'Any SignalK / nav path'));
    var custom = el('div', 'helm-board-custom');
    customPathInput = document.createElement('input');
    customPathInput.className = 'helm-board-path-input';
    customPathInput.placeholder = 'navigation.speedOverGround or wind.spd';
    customTitleInput = document.createElement('input');
    customTitleInput.className = 'helm-board-title-input';
    customTitleInput.placeholder = 'Title';
    customUnitInput = document.createElement('input');
    customUnitInput.className = 'helm-board-unit-input';
    customUnitInput.placeholder = 'unit';
    var addPathBtn = button('helm-board-btn helm-board-add-path-btn', 'Add path', 'Add an arbitrary path tile');
    addPathBtn.addEventListener('click', function () {
      addPathTile(customPathInput.value, customTitleInput.value, customUnitInput.value);
    });
    custom.appendChild(customPathInput); custom.appendChild(customTitleInput); custom.appendChild(customUnitInput); custom.appendChild(addPathBtn);
    body.appendChild(custom);

    body.appendChild(el('div', 'helm-board-section', 'Automation rules'));
    var rules = el('div', 'helm-board-rules');
    var rule = el('div', 'helm-board-rule');
    rulePathInput = document.createElement('input');
    rulePathInput.className = 'helm-board-rule-path';
    rulePathInput.placeholder = 'trigger path';
    ruleOpSelect = document.createElement('select');
    OPS.forEach(function (op) { var o = document.createElement('option'); o.value = op; o.textContent = op; ruleOpSelect.appendChild(o); });
    ruleValueInput = document.createElement('input');
    ruleValueInput.className = 'helm-board-rule-value';
    ruleValueInput.placeholder = 'value';
    ruleActionSelect = document.createElement('select');
    [['notify', 'Notify'], ['switch:Anchor', 'Switch Anchor'], ['switch:Night', 'Switch Night'], ['switch:Racing', 'Switch Racing']].forEach(function (p) {
      var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; ruleActionSelect.appendChild(o);
    });
    var addRuleBtn = button('helm-board-btn helm-board-add-rule-btn', 'Add rule', 'Add trigger → condition → action rule');
    addRuleBtn.addEventListener('click', addRule);
    rule.appendChild(rulePathInput); rule.appendChild(ruleOpSelect); rule.appendChild(ruleValueInput); rule.appendChild(ruleActionSelect); rule.appendChild(addRuleBtn);
    rules.appendChild(rule);
    ruleListEl = el('div', 'helm-board-rule-list');
    rules.appendChild(ruleListEl);
    body.appendChild(rules);

    gridEl = el('div', 'helm-board-grid');
    gridEl.addEventListener('dragover', onDragOver);
    gridEl.addEventListener('drop', onDrop);
    gridEl.addEventListener('dragleave', function (e) {
      var tile = e.target && e.target.closest && e.target.closest('.helm-board-tile');
      if (tile) tile.classList.remove('drag-over');
    });
    body.appendChild(gridEl);
    body.appendChild(el('div', 'helm-board-foot', 'BOARD-1: persisted multi-board cockpit layouts, arbitrary nav/SignalK path tiles, history sparklines, per-tile threshold alarms, mode boards, and simple trigger → condition → action rules.'));
    renderAll();
  }

  function renderAll() {
    if (!gridEl) return;
    var b = activeBoard();
    boardSelect.innerHTML = '';
    state.boards.forEach(function (board) {
      var o = document.createElement('option');
      o.value = board.id; o.textContent = board.name + ' · ' + board.mode;
      boardSelect.appendChild(o);
    });
    boardSelect.value = b.id;
    state.mode = b.mode || state.mode || 'Underway';
    if (modeSelect) modeSelect.value = state.mode;
    nameInput.value = b.name;
    renderRules();
    gridEl.innerHTML = '';
    if (!b.tiles.length) {
      gridEl.appendChild(el('div', 'helm-board-empty', 'This board is empty. Add tiles from the picker above.'));
      return;
    }
    b.tiles.forEach(function (tile) { gridEl.appendChild(renderTile(tile)); });
    updateValues();
  }

  function renderTile(tile) {
    var card = el('article', 'helm-board-tile');
    card.draggable = true;
    card.dataset.tileId = tile.id;
    card.style.gridColumn = 'span ' + clamp(tile.w, 1, 4);
    card.style.minHeight = (74 + (clamp(tile.h, 1, 3) - 1) * 42) + 'px';
    card.addEventListener('dragstart', function (e) {
      dragId = tile.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tile.id);
    });
    card.addEventListener('dragend', function () {
      dragId = null;
      gridEl.querySelectorAll('.drag-over').forEach(function (n) { n.classList.remove('drag-over'); });
    });

    var head = el('div', 'helm-board-thead');
    head.appendChild(el('span', 'helm-board-grip', '⋮⋮'));
    head.appendChild(el('span', 'helm-board-title', tile.title || (byKey[tile.key] && byKey[tile.key].title) || fmtPathTitle(tile.path)));
    var actions = el('span', 'helm-board-actions');
    var resize = button('helm-board-size', '↔', 'Cycle tile size');
    resize.addEventListener('click', function (e) { e.stopPropagation(); cycleSize(tile.id); });
    var remove = button('helm-board-remove', '×', 'Remove tile');
    remove.addEventListener('click', function (e) { e.stopPropagation(); removeTile(tile.id); });
    actions.appendChild(resize); actions.appendChild(remove);
    head.appendChild(actions);
    card.appendChild(head);
    card.appendChild(el('div', 'helm-board-value', '—'));
    card.appendChild(el('div', 'helm-board-spark'));
    card.appendChild(el('div', 'helm-board-trend', 'trend —'));
    card.appendChild(el('div', 'helm-board-meta', 'waiting for nav frame'));
    var alarm = el('div', 'helm-board-alarm');
    var enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'helm-board-alarm-enabled';
    enabled.title = 'Enable tile threshold alarm';
    enabled.checked = !!(tile.alarm && tile.alarm.enabled);
    var op = document.createElement('select');
    op.className = 'helm-board-alarm-op';
    OPS.forEach(function (x) { var o = document.createElement('option'); o.value = x; o.textContent = x; op.appendChild(o); });
    op.value = (tile.alarm && tile.alarm.op) || '>';
    var threshold = document.createElement('input');
    threshold.className = 'helm-board-alarm-threshold';
    threshold.placeholder = 'threshold';
    threshold.value = tile.alarm && tile.alarm.threshold != null ? tile.alarm.threshold : '';
    var hysteresis = document.createElement('input');
    hysteresis.className = 'helm-board-alarm-hysteresis';
    hysteresis.placeholder = 'hyst';
    hysteresis.value = tile.alarm && tile.alarm.hysteresis != null ? tile.alarm.hysteresis : '0';
    function saveAlarm() {
      tile.alarm = normalizeAlarm({ enabled: enabled.checked, op: op.value, threshold: threshold.value, hysteresis: hysteresis.value });
      if (!tile.alarm.enabled) { tile._alarmActive = false; clearAlarm(tileAlarmId(tile)); }
      save();
    }
    [enabled, op, threshold, hysteresis].forEach(function (n) {
      n.addEventListener('change', saveAlarm);
      n.addEventListener('click', function (e) { e.stopPropagation(); });
    });
    alarm.appendChild(enabled); alarm.appendChild(op); alarm.appendChild(threshold); alarm.appendChild(hysteresis);
    card.appendChild(alarm);
    return card;
  }

  function onDragOver(e) {
    var tile = e.target && e.target.closest && e.target.closest('.helm-board-tile');
    if (!tile || !dragId || tile.dataset.tileId === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    gridEl.querySelectorAll('.drag-over').forEach(function (n) { if (n !== tile) n.classList.remove('drag-over'); });
    tile.classList.add('drag-over');
  }
  function onDrop(e) {
    var tile = e.target && e.target.closest && e.target.closest('.helm-board-tile');
    if (!tile || !dragId || tile.dataset.tileId === dragId) return;
    e.preventDefault();
    tile.classList.remove('drag-over');
    moveAfter(dragId, tile.dataset.tileId);
  }

  function addTile(key) {
    if (!byKey[key]) return;
    activeBoard().tiles.push(defaultTile(key));
    save(); renderAll();
  }
  function addPathTile(path, title, unit) {
    path = String(path || '').trim();
    if (!path) return;
    activeBoard().tiles.push({
      id: uid('tile'),
      key: 'custom',
      path: path,
      title: String(title || fmtPathTitle(path)).slice(0, 36),
      unit: String(unit || '').slice(0, 12),
      w: 2,
      h: 1,
      alarm: normalizeAlarm(null),
      _history: [],
      _alarmActive: false,
      _alarmRev: 0
    });
    if (customPathInput) customPathInput.value = '';
    if (customTitleInput) customTitleInput.value = '';
    if (customUnitInput) customUnitInput.value = '';
    save(); renderAll();
  }
  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'Underway';
    state.mode = mode;
    var b = state.boards.find(function (x) { return x.mode === mode; });
    if (!b) {
      b = defaultBoard(mode);
      b.id = uid('board');
      state.boards.push(b);
    }
    state.activeId = b.id;
    save(); renderAll();
  }
  function addRule() {
    var path = String(rulePathInput && rulePathInput.value || '').trim();
    if (!path) return;
    state.rules.push(normalizeRule({
      path: path,
      op: ruleOpSelect ? ruleOpSelect.value : '>',
      value: ruleValueInput ? ruleValueInput.value : '',
      action: ruleActionSelect ? ruleActionSelect.value : 'notify'
    }));
    if (rulePathInput) rulePathInput.value = '';
    if (ruleValueInput) ruleValueInput.value = '';
    save(); renderRules();
  }
  function removeRule(id) {
    clearAlarm('rule:' + id);
    state.rules = state.rules.filter(function (r) { return r.id !== id; });
    save(); renderRules();
  }
  function renderRules() {
    if (!ruleListEl) return;
    if (!state.rules.length) {
      ruleListEl.textContent = 'No rules yet. Add a path trigger above.';
      return;
    }
    ruleListEl.innerHTML = state.rules.map(function (r) {
      return '<div data-rule-id="' + esc(r.id) + '"><button type="button" data-remove-rule="' + esc(r.id) + '">×</button>' +
        esc(r.path) + ' ' + esc(r.op) + ' ' + esc(r.value) + ' → ' + esc(r.action) + '</div>';
    }).join('');
    ruleListEl.querySelectorAll('[data-remove-rule]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeRule(btn.getAttribute('data-remove-rule')); });
    });
  }
  function removeTile(id) {
    var b = activeBoard();
    var t = b.tiles.find(function (x) { return x.id === id; });
    if (t) clearAlarm(tileAlarmId(t));
    b.tiles = b.tiles.filter(function (t) { return t.id !== id; });
    save(); renderAll();
  }
  function cycleSize(id) {
    var t = activeBoard().tiles.find(function (x) { return x.id === id; });
    if (!t) return;
    var idx = SIZE_STEPS.findIndex(function (s) { return s[0] === t.w && s[1] === t.h; });
    var next = SIZE_STEPS[(idx + 1) % SIZE_STEPS.length];
    t.w = next[0]; t.h = next[1];
    save(); renderAll();
  }
  function moveAfter(id, afterId) {
    var tiles = activeBoard().tiles;
    var from = tiles.findIndex(function (t) { return t.id === id; });
    var to = tiles.findIndex(function (t) { return t.id === afterId; });
    if (from < 0 || to < 0 || from === to) return;
    var item = tiles.splice(from, 1)[0];
    to = tiles.findIndex(function (t) { return t.id === afterId; });
    tiles.splice(to + 1, 0, item);
    save(); renderAll();
  }
  function moveToIndex(id, index) {
    var tiles = activeBoard().tiles;
    var from = tiles.findIndex(function (t) { return t.id === id; });
    if (from < 0) return;
    var item = tiles.splice(from, 1)[0];
    tiles.splice(clamp(index, 0, tiles.length), 0, item);
    save(); renderAll();
  }

  function updateNav(s) {
    lastNav = s || lastNav;
    updateValues();
  }
  function updateValues() {
    if (!gridEl) return;
    var b = activeBoard();
    b.tiles.forEach(function (tile) {
      var card = gridEl.querySelector('[data-tile-id="' + tile.id + '"]');
      var c = byKey[tile.key];
      if (!card) return;
      var raw = readTile(tile, lastNav || {});
      var value = card.querySelector('.helm-board-value');
      var meta = card.querySelector('.helm-board-meta');
      var spark = card.querySelector('.helm-board-spark');
      var trendEl = card.querySelector('.helm-board-trend');
      value.textContent = dash(raw);
      if (raw != null && tile.unit) {
        var u = document.createElement('span');
        u.className = 'helm-board-unit';
        u.textContent = tile.unit;
        value.appendChild(u);
      }
      var num = parseNumber(raw);
      if (num != null) {
        tile._history = tile._history || [];
        if (!tile._history.length || Math.abs(tile._history[tile._history.length - 1] - num) > 0.000001) tile._history.push(num);
        tile._history = tile._history.slice(-HISTORY_MAX);
      }
      if (spark) spark.innerHTML = sparkline(tile);
      if (trendEl) {
        var tr = trend(tile);
        trendEl.textContent = tr.label;
        trendEl.classList.toggle('up', tr.up);
        trendEl.classList.toggle('down', tr.down);
      }
      evaluateTileAlarm(tile, raw);
      var src = c && c.source === 'route' ? (lastNav && lastNav.route ? 'route' : 'no active route') : (c ? (sourceOf(lastNav, c.source) || 'waiting') : tile.path);
      meta.textContent = src;
    });
    evaluateRules(lastNav || {});
  }
  function evaluateRules(s) {
    (state.rules || []).forEach(function (r) {
      var raw = getPathValue(s, r.path);
      var active = compareValue(raw, r.op, r.value, 0, r.active);
      var id = 'rule:' + r.id;
      if (active && !r.active) {
        r.active = true;
        if (r.action && r.action.indexOf('switch:') === 0) setMode(r.action.split(':')[1]);
        else raiseAlarm(id, 'Board rule — ' + r.path + ' ' + r.op + ' ' + r.value + ' (now ' + dash(raw) + ')', {
          path: r.path, value: parseNumber(raw), threshold: parseNumber(r.value), op: r.op, ruleId: r.id
        });
      } else if (!active && r.active) {
        r.active = false;
        clearAlarm(id);
      }
    });
  }

  function reset() {
    state.boards.forEach(function (b) { b.tiles.forEach(function (t) { clearAlarm(tileAlarmId(t)); }); });
    state.rules.forEach(function (r) { clearAlarm('rule:' + r.id); });
    state = normalize(defaultState());
    save();
    renderAll();
  }

  if (!window.HelmShell) { warn('HelmShell missing; Smart Board not registered'); return; }
  window.HelmShell.registerPanel({
    id: PANEL_ID,
    epic: 'BOARD',
    title: 'Smart Board',
    icon: '▦',
    render: renderPanel,
    onOpen: function () { renderAll(); }
  });
  window.HelmShell.registerCommand({
    id: 'helm-board-open',
    epic: 'BOARD',
    title: 'Open Smart Board',
    subtitle: 'Composable instrument dashboard',
    keywords: ['dashboard', 'board', 'instrument', 'tiles'],
    group: 'Board',
    run: function () {
      var p = window.HelmShell.panel(PANEL_ID);
      if (p) p.open();
    }
  });
  window.HelmShell.onNav(updateNav);
  fitRail();
  document.addEventListener('helm:shell-ready', fitRail);

  window.HelmBoard = {
    addPathTile: addPathTile,
    addTile: addTile,
    catalog: function () { return CATALOG.map(function (c) { return { key: c.key, title: c.title, unit: c.unit }; }); },
    modes: function () { return MODES.slice(); },
    moveTile: moveToIndex,
    open: function () { var p = window.HelmShell.panel(PANEL_ID); if (p) p.open(); },
    reset: reset,
    setMode: setMode,
    addRule: function (path, op, value, action) {
      state.rules.push(normalizeRule({ path: path, op: op, value: value, action: action || 'notify' }));
      save(); renderRules();
    },
    setActive: function (id) { if (state.boards.some(function (b) { return b.id === id; })) { state.activeId = id; save(); renderAll(); } },
    setTileAlarm: function (id, alarm) {
      var t = activeBoard().tiles.find(function (x) { return x.id === id; });
      if (t) { t.alarm = normalizeAlarm(alarm); save(); renderAll(); }
    },
    setTileSize: function (id, w, h) {
      var t = activeBoard().tiles.find(function (x) { return x.id === id; });
      if (t) { t.w = clamp(w, 1, 4); t.h = clamp(h, 1, 3); save(); renderAll(); }
    },
    state: function () { return clone(state); },
    update: updateNav
  };
})();
