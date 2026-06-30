// alarms.smoke.js — dependency-free unit smoke for web/alarms.js (ALARM epic).
//
// Focuses on the safety-critical feed-loss / no-fix alarm (ALARM-9 / ALARM-10): when a REAL nav
// feed goes STALE/OFFLINE the previously-silent honesty badge must become AUDIBLE — but only after
// a feed actually existed, and only on a SUSTAINED loss (never on a brief reconnect blip or in
// honest no-engine mode). No browser, no deps: stubs a minimal DOM + a counting AudioContext +
// a controllable clock, loads alarms.js, and drives transitions deterministically via _tick().
//
//   Usage:  node web/alarms.smoke.js   (exit 0 = all green)

'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

// ---- controllable clock ----
let NOW = 1_000_000;
const clock = () => NOW;
const advance = ms => { NOW += ms; };

// ---- counting WebAudio stub (beep() → osc.start() once per beep) ----
let audioStarts = 0;
function FakeAudioContext() {
  this.state = 'running';
  this.currentTime = 0;
  this.destination = {};
  this.resume = () => {};
  this.createOscillator = () => ({ type: '', frequency: { value: 0 }, connect() {}, start() { audioStarts++; }, stop() {} });
  this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
}

// ---- minimal DOM ----
function mkEl() {
  const el = {
    style: {}, _attrs: {}, offsetParent: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { return c; }, addEventListener() {}, removeEventListener() {}, remove() {},
    setAttribute(k, v) { this._attrs[k] = v; }, removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return k in this._attrs; },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
    querySelector() { return mkEl(); },
  };
  el.style.cssText = '';
  return el;
}
const documentStub = {
  body: mkEl(),
  createElement: () => mkEl(),
  createTextNode: () => mkEl(),
  addEventListener() {},
  querySelector() { return null; },        // no CPA banner present
  querySelectorAll() { return []; },
};
// in-memory HelmStore stub (TOOLS-7) so we can test ALARM-11 persistence
const memStore = {};
const HelmStoreStub = {
  get: (k, d) => (k in memStore ? memStore[k] : d),
  set: (k, v) => { memStore[k] = v; return true; },
  remove: (k) => { delete memStore[k]; }, keys: () => Object.keys(memStore), available: () => true,
};
function resetStore() { Object.keys(memStore).forEach(k => delete memStore[k]); }
const windowStub = { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext, HelmStore: HelmStoreStub };

// ---- fake maplibre map (only the seams alarms.js touches at construction) ----
const mapStub = {
  getSource: () => null, addSource() {}, addLayer() {}, getLayer: () => null, addControl() {},
  // #66 (ALARM/CONTRACT-10) added anchor-ring radius dragging — alarms.js enableRadiusDrag() now
  // wires pointer handlers + cursor at construction, so the stub must mock these seams too.
  on() {}, off() {}, dragPan: { enable() {}, disable() {} }, getCanvas: () => ({ style: {} }),
};

// ---- sandbox + load alarms.js ----
const warnings = [];                        // capture the fail-loud console.warn() surfacing
const capturingConsole = Object.assign(Object.create(console), { warn: (...a) => { warnings.push(a.join(' ')); } });
const sandbox = {
  window: windowStub, document: documentStub, maplibregl: { Marker: function () { return { setLngLat() { return this; }, addTo() { return this; }, remove() {} }; } },
  setInterval: () => 0,                     // tests drive ticks via _tick(), not the wall clock
  clearInterval: () => {},
  console: capturingConsole, Math,
  Date: Object.assign(function () {}, { now: clock }),   // Date.now() → our clock
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, 'alarms.js'), 'utf8');
vm.runInContext(src, sandbox, { filename: 'alarms.js' });

// ---- assertions ----
let pass = 0, fail = 0;
const P = m => { console.log('  \x1b[32mPASS\x1b[0m  ' + m); pass++; };
const F = m => { console.log('  \x1b[31mFAIL\x1b[0m  ' + m); fail++; };
const ok = (c, m) => c ? P(m) : F(m);
const mk = () => windowStub.AudioContext && sandbox.window.HelmAlarms(mapStub);
const has = (a, k) => a._state().active.indexOf(k) >= 0;

// 1. clean construction — quiet, fresh, no feed yet
{
  const a = mk(); const s = a._state();
  ok(s.fresh === true && !s.hadFeed && !has(a, 'nofix'), '1. construct: fresh, no feed, no no-fix alarm');
}

// 2. a real feed flows → hadFeed latches, stays fresh & quiet
{
  const a = mk(); a.onSource('live', { age: 200 });
  ok(a._state().hadFeed && a._state().fresh && !has(a, 'nofix'), '2. live feed: hadFeed latched, fresh, silent');
}

// 3. feed drops to OFFLINE → holds (not fresh) but does NOT blare immediately (debounce)
{
  const a = mk(); a.onSource('live', { age: 200 });
  a.onSource('offline', {});
  ok(a._state().fresh === false && !has(a, 'nofix'), '3. offline: holds evaluation, no immediate alarm (debounce)');
}

// 4. SUSTAINED offline past debounce → no-fix fires AND is audible despite !fresh
{
  const a = mk(); a.onSource('live', { age: 200 });
  audioStarts = 0; a.onSource('offline', {});
  advance(6000); a._tick();
  ok(has(a, 'nofix'), '4a. sustained offline (>5s): no-fix alarm raised');
  ok(audioStarts >= 1, '4b. no-fix beeps even though feed is not fresh (the ALARM-9/10 fix)');
}

// 5. feed returns → no-fix clears, evaluation resumes
{
  const a = mk(); a.onSource('live', { age: 200 });
  a.onSource('offline', {}); advance(6000); a._tick();
  a.onSource('live', { age: 100 });
  ok(!has(a, 'nofix') && a._state().fresh === true, '5. recovery: no-fix cleared, fresh again');
}

// 6. STALE with a real 10s+ frame age → fires immediately (no extra wait; it IS a genuine no-fix)
{
  const a = mk(); a.onSource('live', { age: 200 });
  a.onSource('stale', { age: 12000 });
  ok(has(a, 'nofix'), '6. stale w/ age 12s: no-fix fires immediately (age past STALE_HOLD_MS)');
}

// 7. GATING: a loss before any real feed (hadFeed=false) must NEVER alarm or beep
{
  const a = mk();
  audioStarts = 0; a.onSource('offline', {});
  advance(6000); a._tick();
  ok(!has(a, 'nofix'), '7a. no prior feed: offline never raises no-fix (honest no-engine mode)');
  ok(audioStarts === 0, '7b. no prior feed: silent (no spurious beep)');
}

// 8. RECONNECT FLAP: 'connecting' interleaved with the outage must not reset the loss timer
{
  const a = mk(); a.onSource('live', { age: 200 });
  a.onSource('offline', {});            // loss begins at NOW
  advance(1000); a.onSource('connecting', {});   // neutral mid-outage — must NOT reset
  advance(5000); a._tick();             // 6s total since loss began
  ok(has(a, 'nofix'), '8. reconnect flap: connecting does not reset the loss timer; alarm still fires');
}

// 9. RE-ARM: recover, then lose again → fires again (ack/clear lifecycle is clean)
{
  const a = mk(); a.onSource('live', { age: 200 });
  a.onSource('offline', {}); advance(6000); a._tick(); a.onSource('live', { age: 100 });   // first loss + recover
  a.onSource('offline', {}); advance(6000); a._tick();
  ok(has(a, 'nofix'), '9. second loss after recovery re-arms the no-fix alarm');
}

// ---- guard zone / watchdog (ALARM-7) ----
const C = { lat: 0, lon: 0 };           // ~1.11 km per 0.01° lon at the equator (> 500 m default radius)

// 10. KEEP-IN: inside is quiet; leaving trips only after the debounce
{
  const a = mk();
  a.dropGuard(C, 'in');
  a.onNav({ pos: C, sources: {} });
  ok(!has(a, 'guard') && a._state().guard && a._state().guardMode === 'in', '10a. keep-in: armed, inside → quiet');
  a.onNav({ pos: { lat: 0, lon: 0.01 }, sources: {} });          // breach begins (~1.1 km out)
  ok(!has(a, 'guard'), '10b. keep-in: just-left → no alarm yet (debounce)');
  advance(6000); a.onNav({ pos: { lat: 0, lon: 0.01 }, sources: {} });
  ok(has(a, 'guard'), '10c. keep-in: sustained outside → guard alarm');
}

// 11. KEEP-OUT: outside is quiet; entering trips after the debounce
{
  const a = mk();
  a.dropGuard(C, 'out');
  a.onNav({ pos: { lat: 0, lon: 0.01 }, sources: {} });
  ok(!has(a, 'guard') && a._state().guardMode === 'out', '11a. keep-out: armed, outside → quiet');
  a.onNav({ pos: C, sources: {} });                               // entered the keep-out zone
  ok(!has(a, 'guard'), '11b. keep-out: just-entered → no alarm yet (debounce)');
  advance(6000); a.onNav({ pos: C, sources: {} });
  ok(has(a, 'guard'), '11c. keep-out: sustained inside → guard alarm');
}

// 12. clearing the zone removes the alarm and disarms
{
  const a = mk();
  a.dropGuard(C, 'in');
  a.onNav({ pos: { lat: 0, lon: 0.01 }, sources: {} }); advance(6000); a.onNav({ pos: { lat: 0, lon: 0.01 }, sources: {} });
  ok(has(a, 'guard'), '12a. (precondition) guard breached');
  a.clearGuard();
  ok(!has(a, 'guard') && !a._state().guard, '12b. clearGuard: alarm cleared + disarmed');
}

// ---- MOB go-to + drift search-area estimate (ALARM-6) ----
// 13. mark → critical; message carries elapsed, steer range/bearing, and a growing search-area est.
{
  const a = mk();
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: {} });   // sets lastPos so markMOB has a fix
  a.markMOB();
  ok(has(a, 'mob'), '13a. MOB marked → critical alarm');
  advance(125000);                                      // 2:05 elapsed
  a.onNav({ pos: { lat: 0, lon: 0.005 }, sources: {} });   // ~556 m away
  const m = a._msg('mob') || '';
  ok(/MAN OVERBOARD/.test(m) && /2:05 ago/.test(m), '13b. message shows elapsed time (2:05 ago)');
  ok(/steer/.test(m) && /brg/.test(m), '13c. message shows go-to steer range + bearing');
  ok(/search ~\d+ m \(drift est\., no current feed\)/.test(m), '13d. search-area surfaces the MISSING current data (drift est., no current feed)');
}

// 14. search radius grows with elapsed time (datum-uncertainty expansion)
{
  const a = mk();
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: {} }); a.markMOB();
  a.onNav({ pos: { lat: 0, lon: 0.001 }, sources: {} });
  const r0 = +(a._msg('mob').match(/search ~(\d+) m/) || [])[1];
  advance(600000);                                      // +10 min
  a.onNav({ pos: { lat: 0, lon: 0.001 }, sources: {} });
  const r1 = +(a._msg('mob').match(/search ~(\d+) m/) || [])[1];
  ok(r1 > r0, '14. search radius grows with elapsed time (' + r0 + ' m → ' + r1 + ' m)');
}

// ---- safety-contour check (ALARM-8) ----
// A charted 2 m contour as a horizontal line along the equator, lon −0.01..0.01.
const CONTOUR = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { VALDCO: 2 }, geometry: { type: 'LineString', coordinates: [[-0.01, 0], [0.01, 0]] } },
] };
const REAL = { pos: 'gps' }, SIM = { pos: 'simulated' };

// 15. POSITION proximity on a REAL fix → warns when near the charted shoal contour
{
  const a = mk(); a._loadContours(CONTOUR);
  ok(a._state().contourSegs === 1, '15a. charted contour ingested (1 shallow segment)');
  advance(3000); a.onNav({ pos: { lat: 0.0003, lon: 0 }, sources: REAL });   // ~33 m N of the contour
  ok(has(a, 'contour') && /Near charted 2 m contour/.test(a._msg('contour') || ''), '15b. real fix near 2 m contour → warning');
  advance(3000); a.onNav({ pos: { lat: 0.01, lon: 0 }, sources: REAL });      // ~1.1 km away
  ok(!has(a, 'contour'), '15c. moved clear of the contour → cleared');
}

// 16. POSITION proximity is real-source guarded — a SIMULATED fix never cries "near shoal"
{
  const a = mk(); a._loadContours(CONTOUR);
  advance(3000); a.onNav({ pos: { lat: 0.0003, lon: 0 }, sources: SIM });
  ok(!has(a, 'contour'), '16. simulated position near contour → no alarm (real-source guarded)');
}

// 17. ROUTE crossing → its own 'route-shoal' alarm (independent of position; runs on any pos source)
{
  const a = mk(); a._loadContours(CONTOUR);
  advance(3000);
  a.onNav({ pos: { lat: 0.5, lon: 0.5 }, sources: SIM, route: { coords: [[0, 0.001], [0, -0.001]] } });   // crosses the contour at lon 0
  ok(has(a, 'route-shoal') && /Route crosses charted 2 m contour/.test(a._msg('route-shoal') || ''), '17a. route crossing a 2 m contour → warning');
  advance(3000);
  a.onNav({ pos: { lat: 0.5, lon: 0.5 }, sources: SIM, route: { coords: [[0.2, 0.2], [0.3, 0.3]] } });     // route well clear
  ok(!has(a, 'route-shoal'), '17b. route re-routed clear → cleared');
}

// 17.5 REGRESSION (review HIGH): an INTERIOR-waypoint edit across a shoal must NOT be missed.
// Endpoints + waypoint count held fixed → the old count+endpoints cache key collided and went stale.
{
  const a = mk(); a._loadContours(CONTOUR);
  advance(3000);
  a.onNav({ pos: { lat: 0.5, lon: 0.5 }, sources: SIM, route: { coords: [[-0.005, 0.002], [0, 0.002], [0.005, 0.002]] } });  // all above the contour
  ok(!has(a, 'route-shoal'), '17c. route fully clear of the contour → no crossing');
  advance(3000);
  a.onNav({ pos: { lat: 0.5, lon: 0.5 }, sources: SIM, route: { coords: [[-0.005, 0.002], [0, -0.002], [0.005, 0.002]] } });  // only the MIDDLE wp dragged below
  ok(has(a, 'route-shoal'), '17d. interior waypoint dragged across the contour → detected (no stale cache)');
}

// 18. no charted data loaded → check is silently unavailable (never fakes)
{
  const a = mk();   // no _loadContours
  advance(3000); a.onNav({ pos: { lat: 0.0003, lon: 0 }, sources: REAL });
  ok(!has(a, 'contour') && a._state().contourSegs === 0, '18. no contour data → silently unavailable');
}

// ---- FAIL-LOUD: a failed safety check must be SURFACED, never silently swallowed ----
// 19. malformed safety-contour data → check stays INACTIVE (no fabricated segments) AND is surfaced
{
  warnings.length = 0;
  const a = mk();
  a._loadContours({ features: 'not-an-array' });   // forEach throws → caught
  ok(a._state().contourSegs === 0, '19a. malformed contour data → ALARM-8 inactive (no fabricated segments)');
  ok(warnings.some(w => /malformed.*INACTIVE/i.test(w)), '19b. malformed contour data is SURFACED (console.warn), not swallowed');
}

// 20. an unrecognised nav-source phase is surfaced once (contract-drift early warning), then deduped
{
  warnings.length = 0;
  const a = mk();
  a.onSource('teleporting', {});                   // not a defined phase
  ok(warnings.some(w => /unrecognised nav-source state.*teleporting/i.test(w)), '20a. unknown nav-source state is SURFACED');
  const n = warnings.length;
  a.onSource('teleporting', {});
  ok(warnings.length === n, '20b. surfaced once per unknown state (deduped, not spammed)');
}

// 21. the KNOWN neutral phases must stay quiet (no false fail-loud noise)
{
  warnings.length = 0;
  const a = mk();
  a.onSource('connecting', {}); a.onSource('sim', {});
  ok(!warnings.some(w => /unrecognised/i.test(w)), '21. known neutral phases (connecting/sim) do NOT warn');
}

// ---- alarm settings: enable / mute / thresholds + persistence (ALARM-11) ----
// 22. per-alarm enable — a disabled alarm never fires; re-enabling restores it
{
  resetStore();
  const a = mk();
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: { depth: 'nmea' }, depth: 1.0 });   // 1 m < 3 m limit, real source
  ok(has(a, 'depth'), '22a. (precondition) shallow depth fires');
  a.setEnabled('depth', false);
  ok(!has(a, 'depth'), '22b. disabling an alarm clears it');
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: { depth: 'nmea' }, depth: 1.0 });
  ok(!has(a, 'depth'), '22c. a disabled alarm does not re-fire');
  a.setEnabled('depth', true);
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: { depth: 'nmea' }, depth: 1.0 });
  ok(has(a, 'depth'), '22d. re-enabling restores the alarm');
}

// 23. master mute — banner still fires but no beep; unmuting resumes the beep
{
  resetStore();
  const a = mk();
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: {} }); a.markMOB();   // a critical alarm
  audioStarts = 0; a.setMuted(true); a._tick();
  ok(has(a, 'mob') && audioStarts === 0, '23a. muted: critical alarm shows but does NOT beep');
  a.setMuted(false); a._tick();
  ok(audioStarts >= 1, '23b. unmuting resumes the beep');
}

// 24. thresholds are settable and re-evaluate immediately
{
  resetStore();
  const a = mk();
  a.onNav({ pos: { lat: 0, lon: 0 }, sources: { depth: 'nmea' }, depth: 4.0 });   // 4 m > 3 m default → quiet
  ok(!has(a, 'depth'), '24a. depth 4 m under the 3 m default → no alarm');
  a.setDepthLimit(5);
  ok(a._state().depthLimit === 5 && has(a, 'depth'), '24b. raising the limit to 5 m re-evaluates → alarm fires now');
}

// 25. settings persist via HelmStore and seed a fresh instance (survive reload)
{
  resetStore();
  const a = mk();
  a.setDepthLimit(7); a.setEnabled('xte', false); a.setMuted(true);
  ok(memStore['alarm.prefs'] && memStore['alarm.prefs'].depthLimit === 7, '25a. a setting is written to HelmStore');
  const b = mk();   // a fresh instance seeds from the persisted prefs
  ok(b._state().depthLimit === 7 && b._state().enabled.xte === false && b._state().muted === true,
     '25b. a fresh instance restores persisted thresholds + enable + mute');
}

// 26. status() surfaces the fail-loud signals (contour data ready vs unavailable)
{
  resetStore();
  const a = mk();
  a._loadContours({ features: [{ properties: { VALDCO: 2 }, geometry: { type: 'LineString', coordinates: [[-0.01, 0], [0.01, 0]] } }] });
  ok(a.status().contour.state === 'ready' && a.status().contour.segments === 1, '26a. status: contour data ready + segment count');
  const a2 = mk(); a2._loadContours({ features: 'broken' });
  ok(a2.status().contour.state === 'unavailable', '26b. status: contour data UNAVAILABLE on malformed data');
}

// 27. changing the safety depth re-filters the already-loaded contour data
{
  resetStore();
  const a = mk();
  a._loadContours({ features: [
    { properties: { VALDCO: 2 }, geometry: { type: 'LineString', coordinates: [[-0.01, 0], [0.01, 0]] } },
    { properties: { VALDCO: 8 }, geometry: { type: 'LineString', coordinates: [[-0.01, 1], [0.01, 1]] } }] });
  ok(a._state().contourSegs === 1, '27a. at safety 5 m only the 2 m contour is indexed (8 m excluded)');
  a.setSafetyDepth(10);
  ok(a._state().contourSegs === 2, '27b. raising safety to 10 m re-filters → both contours indexed');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
