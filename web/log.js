'use strict';
// log.js — HelmLog: one leveled, level-filtered logger for the web client (CLIENT-18). Replaces ad-hoc
// console.* with a single namespaced logger whose threshold is configurable + persisted (HelmStore),
// and which keeps a small ring buffer of recent entries so the degraded banner / a future log view can
// show what just happened. Levels: debug < info < warn < error < silent. Default 'info' (or persisted).
//
//   HelmLog.warn('msg', obj)              -> "[helm] msg {…}"  (if level <= warn)
//   const log = HelmLog.scope('ais');     -> log.error(...)    -> "[ais] …"
//   HelmLog.setLevel('warn')              -> persisted via HelmStore (ui.logLevel)
//   HelmLog.recent(20)                    -> last N entries {t,level,scope,msg} (always captured)
(function () {
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  var DEFAULT = 'info';
  var RING_MAX = 200;
  var ring = [];
  var threshold = LEVELS[DEFAULT];

  function persistedLevel() {
    try { var v = window.HelmStore && window.HelmStore.get('ui.logLevel', DEFAULT); return LEVELS[v] != null ? v : DEFAULT; }
    catch (e) { return DEFAULT; }
  }
  function setLevel(name) {
    if (LEVELS[name] == null) return false;
    threshold = LEVELS[name];
    try { if (window.HelmStore) window.HelmStore.set('ui.logLevel', name); } catch (e) {}
    return true;
  }
  function getLevel() { for (var k in LEVELS) if (LEVELS[k] === threshold) return k; return DEFAULT; }

  function emit(level, scope, args) {
    var msg = Array.prototype.slice.call(args);
    ring.push({ t: Date.now(), level: level, scope: scope, msg: msg });
    if (ring.length > RING_MAX) ring.shift();
    if (LEVELS[level] < threshold) return;                 // below the threshold: captured, not printed
    var tag = scope ? '[' + scope + ']' : '[helm]';
    var fn = level === 'error' ? console.error
           : level === 'warn' ? console.warn
           : level === 'debug' ? (console.debug || console.log)
           : (console.info || console.log);
    try { fn.apply(console, [tag].concat(msg)); } catch (e) {}
  }

  function make(scope) {
    return {
      debug: function () { emit('debug', scope, arguments); },
      info:  function () { emit('info',  scope, arguments); },
      warn:  function () { emit('warn',  scope, arguments); },
      error: function () { emit('error', scope, arguments); },
      scope: function (s) { return make(scope ? scope + ':' + s : s); }
    };
  }

  var root = make('');
  root.setLevel = setLevel;
  root.getLevel = getLevel;
  root.levels = function () { return Object.keys(LEVELS); };
  root.recent = function (n) { return ring.slice(n ? -n : 0); };
  root.LEVELS = LEVELS;

  threshold = LEVELS[persistedLevel()];   // honour a persisted preference at load (best-effort)
  window.HelmLog = root;
})();
