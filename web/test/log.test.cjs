'use strict';
// log.test.cjs — HelmLog (web/log.js, CLIENT-18). Loads the IIFE in a vm sandbox with a stub
// window/console/HelmStore and checks level filtering, the always-on ring buffer, scope tagging, and
// persisted-level behaviour.   Run: node web/test/log.test.cjs
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'log.js'), 'utf8');

function loadLog(store) {
  const logs = [];
  const rec = (lvl) => (...a) => logs.push([lvl, ...a]);
  const win = {};
  if (store) win.HelmStore = store;
  const sandbox = { window: win, console: { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') }, Date };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { HelmLog: win.HelmLog, logs };
}

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };

{ const { HelmLog, logs } = loadLog();
  HelmLog.debug('d'); HelmLog.info('i'); HelmLog.warn('w'); HelmLog.error('e');
  ok(logs.length === 3 && !logs.some(l => l[0] === 'debug'), '1. default "info" suppresses debug, prints info/warn/error'); }

{ const { HelmLog, logs } = loadLog();
  HelmLog.setLevel('warn'); HelmLog.debug('d'); HelmLog.info('i'); HelmLog.warn('w'); HelmLog.error('e');
  ok(logs.length === 2 && logs.every(l => l[0] === 'warn' || l[0] === 'error'), '2. setLevel("warn") prints only warn+error'); }

{ const { HelmLog, logs } = loadLog();
  HelmLog.setLevel('silent'); HelmLog.error('e');
  ok(logs.length === 0, '3. setLevel("silent") prints nothing'); }

{ const { HelmLog } = loadLog();
  HelmLog.setLevel('silent'); HelmLog.debug('a'); HelmLog.error('b');
  const r = HelmLog.recent(10);
  ok(r.length === 2 && r[0].level === 'debug' && r[1].level === 'error', '4. ring buffer captures all entries even when silent'); }

{ const { HelmLog, logs } = loadLog();
  HelmLog.scope('ais').warn('hi');
  ok(logs.length === 1 && logs[0][1] === '[ais]', '5. scope("ais") tags output [ais]'); }

{ const saved = {};
  const store = { get: (k, d) => saved[k] != null ? saved[k] : d, set: (k, v) => { saved[k] = v; } };
  const { HelmLog } = loadLog(store);
  HelmLog.setLevel('error');
  ok(saved['ui.logLevel'] === 'error' && HelmLog.getLevel() === 'error', '6. setLevel persists to HelmStore + getLevel reflects it'); }

{ const store = { get: (k, d) => (k === 'ui.logLevel' ? 'error' : d), set: () => {} };
  const { HelmLog, logs } = loadLog(store);
  HelmLog.info('i'); HelmLog.error('e');
  ok(logs.length === 1 && logs[0][0] === 'error', '7. persisted level "error" honoured at load (info suppressed)'); }

{ const { HelmLog } = loadLog();
  ok(HelmLog.setLevel('bogus') === false && HelmLog.getLevel() === 'info', '8. setLevel rejects an unknown level'); }

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'log: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
