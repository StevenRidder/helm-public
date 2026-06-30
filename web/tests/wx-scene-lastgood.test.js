// WX-24 unit test: the last-good texture cache is a bounded LRU (no unbounded memory growth).
// Run: node web/tests/wx-scene-lastgood.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'wx-scene.js'), 'utf8');
const ctx = { window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, Object, Array, Promise, isFinite, parseInt, parseFloat,
  Blob: function () {}, fetch: function () { return Promise.resolve(); } };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const S = ctx.window.HelmWxScene;

let pass = 0, fail = 0;
function ok(name, cond) { console.log((cond ? '  PASS ' : '  FAIL ') + name); cond ? pass++ : fail++; }

for (let i = 0; i < 700; i++) S._cacheGood('wind|3/' + i + '/4', {});   // insert 700, cap is 600
const keys = S._lastGoodKeys();
ok('cache bounded to <= 600 (got ' + keys.length + ')', keys.length === 600);
ok('evicts oldest (wind|3/0/4 gone)', keys.indexOf('wind|3/0/4') === -1);
ok('retains newest (wind|3/699/4 kept)', keys.indexOf('wind|3/699/4') !== -1);
S._cacheGood('wind|3/699/4', {});                                       // re-touch existing key
ok('re-touch does not grow the cache', S._lastGoodKeys().length === 600);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
