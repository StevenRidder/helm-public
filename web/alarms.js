// HelmAlarms — safety alarms + banner, computed client-side off the live nav stream.
//
// The OpenCPN backend doesn't emit alarm frames yet, so depth / anchor-watch / MOB /
// off-course / arrival are evaluated here from the nav feed; the same banner also displays
// engine `t:"alarm"` frames (via fromEngine) once the engine sends them.
//
// FAIL-FAST honesty: data alarms are only (re)evaluated on FRESH nav data. When the feed goes
// stale/offline (onSource) we HOLD evaluation — we neither raise new data alarms nor clear active
// ones from data we can't trust — with ONE deliberate exception: a lost feed is ITSELF the no-fix
// alarm below. Nothing is fabricated; per-field source tags are respected (depth is NOT alarmed
// while it reads simulated).
//
//   • Anchor — drop at the current fix, set a swing radius (−/+), live drift readout, and a
//              DEBOUNCED critical alarm so a single GPS jitter fix can't false-trip it.
//   • Depth  — warns when REAL depth < threshold (default 3.0 m), with hysteresis.
//   • Off-course — XTE beyond a limit while a route is actively being navigated.
//   • Arrival — within the arrival radius of the next waypoint.
//   • MOB    — drops a man-overboard mark; critical alarm with live range/bearing.
//   • No-fix — when a real nav feed goes STALE/OFFLINE (engine lost) the honesty badge stops
//              being silent: a critical, ack-able feed-loss alarm sounds. Only ever after a real
//              feed existed (never in honest no-engine mode) and only on a SUSTAINED loss (rides
//              out a brief reconnect blip) — see onSource. [ALARM-9 / ALARM-10]
//   • CPA/TCPA — from the engine's LIVE AIS via collision.js (not duplicated here).
window.HelmAlarms = function (map, opts) {
  opts = opts || {};
  // ---- persisted alarm settings (ALARM-11) — defaults ← saved (HelmStore) ← opts override ----
  const PREF_KEY = 'alarm.prefs';
  const _saved = (window.HelmStore && window.HelmStore.get(PREF_KEY, null)) || {};
  const _pick = (k, dflt) => (opts[k] != null ? opts[k] : (_saved[k] != null ? _saved[k] : dflt));
  let depthLimit = _pick('depthLimit', 3.0);    // metres
  let depthClear = depthLimit + 0.3;            // hysteresis
  let anchorRadius = _pick('anchorRadius', 40); // metres (settable)
  let xteLimit = _pick('xteLimit', 100);        // metres off track
  let arrivalNM = _pick('arrivalNM', 0.10);     // NM to next wp
  const ENABLED_DEFAULT = { depth: true, xte: true, arrival: true, nofix: true, contour: true, anchor: true, guard: true, mob: true };
  const enabled = Object.assign({}, ENABLED_DEFAULT, _saved.enabled || {});   // per-alarm on/off
  let muted = !!_saved.muted;                   // master audio mute (banner still shows; just no beep)
  const ONROUTE_NM = 60;        // only judge XTE/arrival when plausibly ON the route (guards a stale demo route)
  const DRAG_DEBOUNCE_MS = 8000; // must stay outside the circle this long before the drag alarm trips
  function savePrefs() {        // persist the live config so it survives reload (TOOLS-7 / HelmStore)
    if (window.HelmStore) window.HelmStore.set(PREF_KEY, { depthLimit, xteLimit, arrivalNM, anchorRadius, safetyDepth, muted, enabled });
  }

  // ---- alarm state ----
  const active = {};            // id -> { id, kind, sev, msg, acked }
  let fresh = true;             // false when feed stale/offline → hold (don't evaluate)
  let lastNav = null;           // last nav frame (so a settings change can re-evaluate at once)
  const num = v => { const m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

  // ---- feed-loss / no-fix state (ALARM-9 / ALARM-10) ----
  let hadFeed = false;          // true once a REAL feed has flowed — only then is losing it alarm-worthy
  let feedState = null;         // current lost-state string ('stale'|'lost'|'offline') while armed, else null
  let feedInfo = null;          // last source info ({ age, endpoint, … }) for an accurate readout
  let feedLostSince = null;     // ms (Date.now) when the current loss began — our own debounce clock
  const STALE_HOLD_MS = 10000;  // a real frame age past this is already a genuine no-fix (mirrors nav-client STALE_MS)
  const NOFIX_DEBOUNCE_MS = 5000; // …or this much SUSTAINED loss on our own clock (rides out a reconnect blip)
  const warnedStates = new Set(); // dedupe the fail-loud warning for unrecognised nav-source states

  // ---- distance / bearing (metres, degrees) ----
  const R = 6371000, toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
  function distM(a, b) {
    const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(toR(b.lon - a.lon)) * Math.cos(toR(b.lat));
    const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) - Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(toR(b.lon - a.lon));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }

  // ---- audible alert (WebAudio); browsers need a user gesture to start audio ----
  let ac = null, audioWarned = false;
  document.addEventListener('pointerdown', () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {} }, { once: false });
  function beep() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = 'square'; o.frequency.value = 920;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.24);
      audioWarned = false;          // audio is sounding again
    } catch (e) {
      // FAIL LOUD: a critical alarm you can't HEAR is the weakest link. Surface once per failure
      // streak (re-armed on the next successful beep). Actionable: a tap unlocks gesture-blocked audio.
      if (!audioWarned) { audioWarned = true; console.warn('HelmAlarms: alarm audio is NOT sounding (the visual banner still shows) — tap the screen once to enable audio, or check the output device:', e && e.message); }
    }
  }
  // Periodic alarm tick. Two jobs: (1) ARM the feed-loss alarm on a SUSTAINED outage even when no
  // new source events arrive, and (2) beep any unacked critical alarm. Critically, beeping is gated
  // on `fresh` so we don't blare stale-derived alarms — EXCEPT the no-fix alarm itself, which exists
  // precisely because the feed is NOT fresh, so it (and anything still active alongside it) must
  // still sound. That `|| active.nofix` is the whole point of ALARM-9/10: an audible feed loss.
  function beepTick() {
    evalFeedLoss();
    if (!muted && (fresh || active.nofix) && Object.values(active).some(a => !a.acked && a.sev === 'critical')) beep();
    syncSettingsPanel();   // keep the open Alarms panel's live status (audio/contour) fresh
  }
  setInterval(beepTick, 1600);

  // ---- banner ----
  const banner = document.createElement('div');
  banner.id = 'alarm-banner';
  banner.style.cssText = 'position:fixed;top:calc(64px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);' +
    'z-index:9;display:none;min-width:240px;max-width:min(560px,92vw);box-sizing:border-box;padding:10px 12px;border-radius:12px;' +
    'font:600 13px -apple-system,system-ui;color:#fff;align-items:center;gap:10px;box-shadow:0 10px 40px -10px rgba(0,0,0,.7);' +
    '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);';
  banner.innerHTML = '<span id="alarm-ico" style="font-size:16px">⚠︎</span>' +
    '<span id="alarm-txt" style="flex:1;line-height:1.25"></span>' +
    '<button id="alarm-ack" title="Acknowledge — silence the audible alarm (the banner stays while the condition holds)" style="flex:none;border:0;border-radius:7px;padding:6px 11px;font:600 12px system-ui;' +
    'background:rgba(255,255,255,.92);color:#111;cursor:pointer;touch-action:manipulation">ACK</button>';
  document.body.appendChild(banner);
  banner.querySelector('#alarm-ack').addEventListener('click', () => {
    Object.values(active).forEach(a => a.acked = true);   // silence; banner stays while the condition holds
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (e) {}
    render();
  });
  // keep out from under collision.js's CPA banner (both are top-centre) — stack below it when shown
  function positionBanner() {
    if (banner.style.display === 'none') return;
    const cpa = document.querySelector('.cpa-alarm');
    const vis = cpa && !cpa.hasAttribute('hidden') && cpa.offsetParent !== null;
    banner.style.top = vis ? (Math.round(cpa.getBoundingClientRect().bottom) + 8) + 'px' : 'calc(64px + env(safe-area-inset-top))';
  }
  function render() {
    const list = Object.values(active);
    if (!list.length) { banner.style.display = 'none'; return; }
    list.sort((a, b) => (a.sev === 'critical' ? -1 : 1) - (b.sev === 'critical' ? -1 : 1));
    const top = list[0], crit = top.sev === 'critical', unacked = list.some(a => !a.acked);
    banner.style.display = 'flex';
    positionBanner();
    banner.style.background = crit ? 'rgba(200,30,40,.94)' : 'rgba(190,120,20,.94)';
    banner.style.animation = (crit && unacked) ? 'srcpulse 1s infinite' : 'none';
    banner.querySelector('#alarm-ico').textContent = top.kind === 'mob' ? '🛟' : (top.kind === 'anchor' ? '⚓' : (top.kind === 'arrival' ? '🏁' : (top.kind === 'nofix' ? '📡' : (top.kind === 'guard' || top.kind === 'guardzone' ? '🛡' : (top.kind === 'contour' || top.kind === 'route-shoal' ? '🌊' : '⚠︎')))));
    banner.querySelector('#alarm-txt').textContent = top.msg + (list.length > 1 ? '   (+' + (list.length - 1) + ' more)' : '');
    const ack = banner.querySelector('#alarm-ack'); ack.style.display = unacked ? '' : 'none';
  }
  function fireById(id, kind, sev, msg, resetAck) {
    id = id || kind;
    if (enabled[kind] === false) { clear(id); return; }   // this alarm type is disabled in settings (ALARM-11)
    const prev = active[id];
    active[id] = { id, kind, sev, msg, acked: (prev && !resetAck) ? prev.acked : false };   // keep ack across message updates unless the decoder reports an escalation
    render();
  }
  function fire(kind, sev, msg) { fireById(kind, kind, sev, msg, false); }
  function clear(id) { if (active[id]) { delete active[id]; render(); } }

  // ---- feed-loss / no-fix alarm (ALARM-9 / ALARM-10) -------------------------------------------
  // index.html's setSource() already classifies the live nav feed (live / simpos / lagging / stale /
  // lost / offline) and drives the honesty badge. We consume that SAME truth here and make the
  // STALE/OFFLINE/ENGINE-LOST states AUDIBLE — the one gap the badge had. Policy lives here (ALARM
  // owns alarms.js); index.html just forwards the state it already computed.
  //
  //   • A loss is only alarm-worthy once a REAL feed has flowed (hadFeed) — honest no-engine /
  //     prototype mode (sim) never alarms, because there was never a feed to lose.
  //   • It must be SUSTAINED: a real frame age past STALE_HOLD_MS (a genuine 10s+ no-fix), OR our
  //     own debounce clock past NOFIX_DEBOUNCE_MS (covers 'offline', which has no frame age) — so a
  //     brief reconnect blip can't false-trip it.
  //   • Reconnect flapping ('connecting' interleaved with 'stale'/'offline') must NOT reset the
  //     loss timer or clear the alarm — only an actually-good feed does.
  function onSource(state, info) {
    const lost = (state === 'stale' || state === 'lost' || state === 'offline');
    const good = (state === 'live' || state === 'simpos' || state === 'lagging');
    if (good) {                          // real data is flowing again — resume + silence any loss alarm
      hadFeed = true; fresh = true;
      feedState = null; feedInfo = null; feedLostSince = null;
      clear('nofix');
      return;
    }
    if (lost) {                          // arm + hold ONLY once a real feed has existed to lose
      if (hadFeed) {
        fresh = false;                   // hold evaluation on a feed we can't trust
        feedState = state; feedInfo = info || null;
        if (!feedLostSince) feedLostSince = Date.now();
        evalFeedLoss();                  // fire now if the loss is already sustained (e.g. stale = 10s+)
      }
      return;                            // pre-feed lost (e.g. no-endpoint before any feed): nothing to hold/alarm
    }
    // neutral ('connecting' / 'sim'): never disturb an in-progress loss; only un-hold when there is
    // no loss underway (honest pre-feed / no-engine mode evaluates normally and stays quiet).
    // FAIL LOUD on a phase the contract doesn't define — likely producer/contract drift — once each.
    if (state && state !== 'connecting' && state !== 'sim' && !warnedStates.has(state)) {
      warnedStates.add(state);
      console.warn('HelmAlarms.onSource: unrecognised nav-source state "' + state + '" — treating as neutral. If this is a new contract phase, classify it in the good/lost sets (alarms.js).');
    }
    if (!feedLostSince) fresh = true;
  }
  function evalFeedLoss() {
    if (!feedState || !feedLostSince) return;
    const ageMs = feedInfo && feedInfo.age != null ? feedInfo.age : 0;
    if (ageMs < STALE_HOLD_MS && Date.now() - feedLostSince < NOFIX_DEBOUNCE_MS) return;   // not sustained yet
    // One honest message for every cause. We deliberately do NOT word this by feedState: nav-client's
    // 500ms watchdog re-emits 'stale' (with a frame age) within half a second of a socket 'offline',
    // so a cause-specific 'engine offline / reconnecting…' line would be effectively dead and imply
    // behaviour that never reaches the banner. The honesty badge already shows STALE vs OFFLINE
    // visually; the alarm's job is to make the loss AUDIBLE and say how long it has lasted.
    const secs = feedInfo && feedInfo.age != null ? Math.round(feedInfo.age / 1000)
                                                  : Math.round((Date.now() - feedLostSince) / 1000);
    fire('nofix', 'critical', 'Nav feed lost — no position fix for ' + secs + 's');   // critical + ack-able; beepTick sounds it despite !fresh
  }

  // ---- anchor watch (map circle + set-point + live drift readout + radius control) ----
  let anchor = null, dragSince = null;
  function ensureAnchorLayers() {
    if (map.getSource('helm-anchor')) return;
    map.addSource('helm-anchor', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'helm-anchor-fill', type: 'fill', source: 'helm-anchor', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ff6b6b', 'fill-opacity': 0.10 } });
    map.addLayer({ id: 'helm-anchor-line', type: 'line', source: 'helm-anchor', filter: ['==', '$type', 'Polygon'], paint: { 'line-color': '#ff6b6b', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'helm-anchor-pt', type: 'circle', source: 'helm-anchor', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ff6b6b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  }
  function anchorCircle(c, rM) {
    const pts = [], dLat = rM / 111320, dLon = rM / (111320 * Math.cos(toR(c.lat)));
    for (let i = 0; i <= 48; i++) { const a = toR(i * 7.5); pts.push([c.lon + dLon * Math.sin(a), c.lat + dLat * Math.cos(a)]); }
    return { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] } }
    ] };
  }
  function redrawAnchor() { try { ensureAnchorLayers(); map.getSource('helm-anchor').setData(anchorCircle(anchor, anchorRadius)); } catch (e) {} }
  function dropAnchor(pos) {
    if (!pos) return;
    anchor = { lat: pos.lat, lon: pos.lon }; dragSince = null;
    redrawAnchor(); pill.style.display = 'flex'; updatePill(0); paintCtl();
    if (opts && opts.onAnchor) opts.onAnchor(true, anchor, anchorRadius);   // CONTRACT-10: hand the watch to the ENGINE so it watches headless (phone off)
  }
  function weighAnchor() {
    anchor = null; dragSince = null; clear('anchor'); pill.style.display = 'none';
    try { if (map.getSource('helm-anchor')) map.getSource('helm-anchor').setData({ type: 'FeatureCollection', features: [] }); } catch (e) {}
    paintCtl();
    if (opts && opts.onAnchor) opts.onAnchor(false);
  }
  function setRadius(delta) {
    anchorRadius = Math.max(10, Math.min(300, anchorRadius + delta));
    savePrefs();   // ALARM-11: the chosen anchor-watch radius persists as the default
    if (anchor) {
      redrawAnchor(); updatePill(lastPos ? distM(lastPos, anchor) : 0);
      if (opts && opts.onAnchor) opts.onAnchor(true, anchor, anchorRadius);   // keep the ENGINE watch radius in sync (−/+ buttons, like the drag)
    }
  }

  // ---- drag the circle's edge to resize the swing radius (desktop + touch) ----
  (function enableRadiusDrag() {
    let dragging = false, hovering = false;
    const ringPx = () => {                                  // current ring radius, in screen pixels
      const c = map.project([anchor.lon, anchor.lat]);
      const edge = map.project([anchor.lon, anchor.lat + anchorRadius / 111320]);
      return Math.hypot(edge.x - c.x, edge.y - c.y);
    };
    const nearRing = pt => {                                // cursor within ~14 px of the ring band
      if (!anchor) return false;
      const c = map.project([anchor.lon, anchor.lat]);
      return Math.abs(Math.hypot(pt.x - c.x, pt.y - c.y) - ringPx()) < 14;
    };
    const apply = ll => {                                   // radius = distance from the set-point to the cursor
      anchorRadius = Math.max(10, Math.min(300, Math.round(distM({ lat: ll.lat, lon: ll.lng }, anchor))));
      redrawAnchor(); updatePill(lastPos ? distM(lastPos, anchor) : 0);
    };
    const end = () => {
      if (!dragging) return;
      dragging = false; map.dragPan.enable(); map.getCanvas().style.cursor = ''; hovering = false;
      savePrefs();                                          // ALARM-11: new radius becomes the default
      if (opts && opts.onAnchor) opts.onAnchor(true, anchor, anchorRadius);   // CONTRACT-10: push the new radius to the ENGINE watch
    };
    map.on('mousedown', e => { if (anchor && nearRing(e.point)) { dragging = true; map.dragPan.disable(); e.preventDefault(); } });
    map.on('mousemove', e => {
      if (dragging) { apply(e.lngLat); e.preventDefault(); return; }
      if (!anchor) return;
      const near = nearRing(e.point);
      if (near && !hovering) { hovering = true; map.getCanvas().style.cursor = 'ew-resize'; }
      else if (!near && hovering) { hovering = false; map.getCanvas().style.cursor = ''; }
    });
    map.on('mouseup', end);
    map.on('touchstart', e => { if (anchor && e.points && e.points.length === 1 && nearRing(e.point)) { dragging = true; map.dragPan.disable(); } });
    map.on('touchmove', e => { if (dragging) { apply(e.lngLat); e.preventDefault(); } });
    map.on('touchend', end); map.on('touchcancel', end);
  })();

  // anchor status pill (live drift / radius + radius control), bottom-centre, only while anchored
  const pill = document.createElement('div');
  pill.id = 'anchor-pill';
  pill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:8;display:none;align-items:center;gap:8px;' +
    'padding:5px 8px;border-radius:11px;font:600 12px -apple-system,system-ui;color:#eef4f9;background:rgba(13,19,27,.82);' +
    '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:.5px solid rgba(255,255,255,.14);box-shadow:0 12px 40px -16px rgba(0,0,0,.8)';
  const mkPillBtn = (t, title) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (title) b.title = title;
    b.style.cssText = 'width:22px;height:22px;border:0;border-radius:7px;background:rgba(255,255,255,.12);color:#eef4f9;font:700 14px system-ui;cursor:pointer;touch-action:manipulation'; return b; };
  const pillMinus = mkPillBtn('−', 'Decrease the anchor swing radius'), pillTxt = document.createElement('span'), pillPlus = mkPillBtn('+', 'Increase the anchor swing radius');
  pillTxt.style.cssText = 'min-width:118px;text-align:center;font-variant-numeric:tabular-nums';
  pill.appendChild(document.createTextNode('⚓')); pill.appendChild(pillMinus); pill.appendChild(pillTxt); pill.appendChild(pillPlus);
  document.body.appendChild(pill);
  pillMinus.addEventListener('click', () => setRadius(-5));
  pillPlus.addEventListener('click', () => setRadius(+5));
  function updatePill(d) {
    const ratio = d / anchorRadius;
    const col = !anchor ? '#eef4f9' : (ratio > 1 ? '#ff6b6b' : ratio > 0.85 ? '#ffc06a' : '#46e0a0');
    pillTxt.innerHTML = '<b style="color:' + col + '">' + Math.round(d) + '</b> / ' + anchorRadius + ' m';
  }

  // ---- MOB (mark + go-to guidance + drift search-area estimate, ALARM-6) ----
  let mob = null, mobMarker = null, mobTime = null;
  // Search-area growth: an HONEST datum-uncertainty estimate. We have NO surface-current source and
  // wind is not a real feed here, so we do NOT fabricate a drift DIRECTION (which would bias the
  // search the wrong way). Instead the last-known position is the datum and the search RADIUS grows
  // with elapsed time at an assumed total drift — the standard SAR datum expansion — clearly '(est.)'.
  const MOB_SEARCH_BASE_M = 50, MOB_DRIFT_KT = 0.75, KT_TO_MS = 0.514444;
  function mobSearchRadius(elapsedSec) { return MOB_SEARCH_BASE_M + MOB_DRIFT_KT * KT_TO_MS * Math.max(0, elapsedSec); }
  function ensureMobLayers() {
    if (map.getSource('helm-mob')) return;
    map.addSource('helm-mob', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'helm-mob-search-fill', type: 'fill', source: 'helm-mob', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'helm-mob-search-line', type: 'line', source: 'helm-mob', filter: ['==', '$type', 'Polygon'], paint: { 'line-color': '#ff3b30', 'line-width': 1.2, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'helm-mob-steer', type: 'line', source: 'helm-mob', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#ff3b30', 'line-width': 2 } });
  }
  function redrawMOB(ownship) {   // steer-to line (go-to) + growing search-area circle around the datum
    if (!mob) return;
    try {
      ensureMobLayers();
      const elapsed = mobTime ? (Date.now() - mobTime) / 1000 : 0;
      const feats = [anchorCircle(mob, mobSearchRadius(elapsed)).features[0]];   // search-area polygon
      if (ownship) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[ownship.lon, ownship.lat], [mob.lon, mob.lat]] } });
      map.getSource('helm-mob').setData({ type: 'FeatureCollection', features: feats });
    } catch (e) {}
  }
  function markMOB(pos) {
    if (!pos) return;
    mob = { lat: pos.lat, lon: pos.lon }; mobTime = Date.now();
    try {
      const el = document.createElement('div');
      el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#ff3b30;border:2px solid #fff;box-shadow:0 0 8px rgba(255,59,48,.9)';
      mobMarker = new maplibregl.Marker({ element: el }).setLngLat([mob.lon, mob.lat]).addTo(map);
    } catch (e) {}
    fire('mob', 'critical', 'MAN OVERBOARD');
    redrawMOB(lastPos);          // initial steer-to + search-area circle (grows as onNav re-draws)
    paintCtl();
  }
  function cancelMOB() {
    mob = null; mobTime = null;
    if (mobMarker) { try { mobMarker.remove(); } catch (e) {} mobMarker = null; }
    try { if (map.getSource('helm-mob')) map.getSource('helm-mob').setData({ type: 'FeatureCollection', features: [] }); } catch (e) {}
    clear('mob'); paintCtl();
  }

  // ---- generic geographic guard zone / boundary watchdog (ALARM-7) -----------------------------
  // A user-placed circular zone with two modes: keep-IN (alarm when ownship LEAVES — e.g. a
  // mooring/anchorage boundary) or keep-OUT (alarm when ownship ENTERS — e.g. a restricted/foul
  // area). Distinct from the anchor watch (which is specifically the boat's own swing circle).
  // DEBOUNCED like the anchor drag so a single GPS jitter fix can't false-trip the breach.
  const GUARD_MIN_M = 100, GUARD_MAX_M = 20000, GUARD_DEBOUNCE_MS = 5000;
  let guard = null, guardRadius = 500, guardMode = 'in', guardBreachSince = null, placing = false, guardClickHandler = null;
  function ensureGuardLayers() {
    if (map.getSource('helm-guard')) return;
    map.addSource('helm-guard', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'helm-guard-fill', type: 'fill', source: 'helm-guard', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#3bd6c6', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'helm-guard-line', type: 'line', source: 'helm-guard', filter: ['==', '$type', 'Polygon'], paint: { 'line-color': '#3bd6c6', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'helm-guard-pt', type: 'circle', source: 'helm-guard', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#3bd6c6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  }
  function redrawGuard() { try { ensureGuardLayers(); map.getSource('helm-guard').setData(anchorCircle(guard, guardRadius)); } catch (e) {} }
  function dropGuard(pos, mode) {
    if (!pos) return;
    guard = { lat: pos.lat, lon: pos.lon }; if (mode) guardMode = mode; guardBreachSince = null;
    redrawGuard(); guardPill.style.display = 'flex'; updateGuardPill(0, true); paintCtl();
  }
  function clearGuard() {
    guard = null; guardBreachSince = null; clear('guard'); guardPill.style.display = 'none';
    try { if (map.getSource('helm-guard')) map.getSource('helm-guard').setData({ type: 'FeatureCollection', features: [] }); } catch (e) {}
    paintCtl();
  }
  function setGuardRadius(delta) {
    const step = guardRadius >= 2000 ? 250 : 50;
    guardRadius = Math.max(GUARD_MIN_M, Math.min(GUARD_MAX_M, guardRadius + delta * step));
    if (guard) { redrawGuard(); updateGuardPill(lastPos ? distM(lastPos, guard) : 0, lastPos ? distM(lastPos, guard) <= guardRadius : true); }
  }
  function setGuardMode(m) { guardMode = (m === 'out' ? 'out' : 'in'); guardBreachSince = null; if (guard) { clear('guard'); updateGuardPill(lastPos ? distM(lastPos, guard) : 0, lastPos ? distM(lastPos, guard) <= guardRadius : true); } paintCtl(); }
  // arm placement: the next map tap drops the zone centre (falls back to the current fix if no map)
  function endGuardPlacement() {                          // detach the pending placement click + reset chrome
    placing = false;
    if (guardClickHandler && map && map.off) { try { map.off('click', guardClickHandler); } catch (e) {} }
    guardClickHandler = null;
    try { map.getCanvas().style.cursor = ''; } catch (e) {}
  }
  function armGuardPlacement() {
    if (guard) { clearGuard(); return; }
    if (placing) { endGuardPlacement(); paintCtl(); return; }   // second tap ABORTS the armed placement
    if (!map || !map.on) { dropGuard(lastPos); return; }
    placing = true; paintCtl();
    try { map.getCanvas().style.cursor = 'crosshair'; } catch (e) {}
    guardClickHandler = e => { endGuardPlacement(); dropGuard({ lat: e.lngLat.lat, lon: e.lngLat.lng }); };
    map.on('click', guardClickHandler);                  // explicit on+off (not once) so abort/clear can detach it
  }

  // guard status pill (mode toggle + live distance/radius + radius control), bottom-centre above anchor pill
  const guardPill = document.createElement('div');
  guardPill.id = 'guard-pill';
  guardPill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:140px;z-index:8;display:none;align-items:center;gap:8px;' +
    'padding:5px 8px;border-radius:11px;font:600 12px -apple-system,system-ui;color:#eef4f9;background:rgba(13,19,27,.82);' +
    '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:.5px solid rgba(255,255,255,.14);box-shadow:0 12px 40px -16px rgba(0,0,0,.8)';
  const guardModeBtn = document.createElement('button'); guardModeBtn.type = 'button'; guardModeBtn.title = 'Switch keep-in (alarm on leaving) ↔ keep-out (alarm on entering)';
  guardModeBtn.style.cssText = 'border:0;border-radius:6px;padding:3px 7px;font:700 11px system-ui;background:rgba(59,214,198,.18);color:#7ff0e2;cursor:pointer;touch-action:manipulation';
  const guardMinus = mkPillBtn('−', 'Decrease the guard-zone radius'), guardTxt = document.createElement('span'), guardPlus = mkPillBtn('+', 'Increase the guard-zone radius'), guardClear = mkPillBtn('✕', 'Clear the guard zone');
  guardTxt.style.cssText = 'min-width:110px;text-align:center;font-variant-numeric:tabular-nums';
  guardPill.appendChild(document.createTextNode('🛡')); guardPill.appendChild(guardModeBtn);
  guardPill.appendChild(guardMinus); guardPill.appendChild(guardTxt); guardPill.appendChild(guardPlus); guardPill.appendChild(guardClear);
  document.body.appendChild(guardPill);
  guardModeBtn.addEventListener('click', () => setGuardMode(guardMode === 'in' ? 'out' : 'in'));
  guardMinus.addEventListener('click', () => setGuardRadius(-1));
  guardPlus.addEventListener('click', () => setGuardRadius(+1));
  guardClear.addEventListener('click', clearGuard);
  function updateGuardPill(d, inside) {
    guardModeBtn.textContent = guardMode === 'in' ? 'KEEP IN' : 'KEEP OUT';
    const breach = guardMode === 'in' ? !inside : inside;
    const col = breach ? '#ff6b6b' : '#46e0a0';
    const r = guardRadius >= 1852 ? (guardRadius / 1852).toFixed(2) + ' NM' : guardRadius + ' m';
    guardTxt.innerHTML = '<b style="color:' + col + '">' + Math.round(d) + ' m</b> / ' + r;
  }

  // ---- safety-contour check (ALARM-8) ----------------------------------------------------------
  // Warn when the active ROUTE crosses, or the boat's POSITION nears, a CHARTED depth contour
  // shallower than the safety depth — read from the real S-57 DEPCNT data (data/depcnt.geojson,
  // VALDCO = contour depth in metres) the chart already ships. Distinct from the sounder depth
  // alarm (ALARM-2, live echo-sounder): this is "standing into charted shoal water".
  //
  // REAL-SOURCE honesty: the POSITION proximity warning only fires on a real position fix (never a
  // simulated one). The ROUTE-crossing check runs on the route geometry itself (real regardless of
  // live position). If the contour file isn't present (offline / outside coverage), the check is
  // silently unavailable — never faked.
  let safetyDepth = _pick('safetyDepth', 5.0);   // m — charted contour ≤ this is unsafe (ALARM-11 settable)
  const CONTOUR_PROXIMITY_M = 60, CONTOUR_THROTTLE_MS = 2000;
  let shallowSegs = null, contourAt = 0, contourRaw = null, contourState = 'loading';   // 'loading'|'ready'|'unavailable'
  function ingestContours(geojson) {
    try {
      contourRaw = geojson;       // kept so a safety-depth change can re-filter without re-fetching
      const segs = [];
      (geojson && geojson.features || []).forEach(f => {
        const p = f.properties || {}, depth = p.VALDCO != null ? p.VALDCO : p.depth;
        if (depth == null || depth > safetyDepth) return;
        const g = f.geometry; if (!g) return;
        const lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
        lines.forEach(c => { for (let i = 0; i < c.length - 1; i++) segs.push({ a: c[i], b: c[i + 1], depth }); });
      });
      shallowSegs = segs; contourState = 'ready';
    } catch (e) {
      shallowSegs = null; contourState = 'unavailable';
      console.warn('HelmAlarms: safety-contour data (depcnt) is malformed — the safety-contour alarm (ALARM-8) is INACTIVE:', e && e.message);
    }
  }
  // FAIL LOUD: if the charted contours can't load, ALARM-8 is silently absent. Say so rather than let
  // the operator assume shoal-warning coverage they don't have. Behaviour is unchanged (the check is
  // simply unavailable without data) — only the silence is removed.
  (function loadContours() {
    try {
      fetch('data/depcnt.geojson')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => ingestContours(j))
        .catch(e => { contourState = 'unavailable'; console.warn('HelmAlarms: safety-contour data (data/depcnt.geojson) failed to load — the safety-contour alarm (ALARM-8) is INACTIVE until it loads:', e && e.message); });
    } catch (e) { contourState = 'unavailable'; console.warn('HelmAlarms: could not start the safety-contour data load — ALARM-8 INACTIVE:', e && e.message); }
  })();
  // local-metres geometry (equirectangular about the query point — exact enough at chart scales)
  function pointSegM(p, a, b) {
    const mx = 111320 * Math.cos(toR(p[1])), my = 110540;
    const ax = (a[0] - p[0]) * mx, ay = (a[1] - p[1]) * my, bx = (b[0] - p[0]) * mx, by = (b[1] - p[1]) * my;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? ((-ax) * dx + (-ay) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  // proper (strict) segment intersection. KNOWN LIMITATION: a route vertex landing EXACTLY on a
  // contour (collinear / T-junction touch) is not counted — but exact float coincidence with real
  // S-57 coordinates is unreachable, and any route that genuinely PASSES THROUGH the shoal is caught.
  function segsIntersect(p1, p2, p3, p4) {
    const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  const bboxFarPt = (p, sg, d) => Math.min(sg.a[0], sg.b[0]) > p[0] + d || Math.max(sg.a[0], sg.b[0]) < p[0] - d || Math.min(sg.a[1], sg.b[1]) > p[1] + d || Math.max(sg.a[1], sg.b[1]) < p[1] - d;
  const bboxFarSeg = (r1, r2, sg) => Math.min(r1[0], r2[0]) > Math.max(sg.a[0], sg.b[0]) || Math.max(r1[0], r2[0]) < Math.min(sg.a[0], sg.b[0]) || Math.min(r1[1], r2[1]) > Math.max(sg.a[1], sg.b[1]) || Math.max(r1[1], r2[1]) < Math.min(sg.a[1], sg.b[1]);
  function routeCrossesShallow(coords) {
    for (let i = 0; i < coords.length - 1; i++)
      for (let j = 0; j < shallowSegs.length; j++) {
        const sg = shallowSegs[j];
        if (bboxFarSeg(coords[i], coords[i + 1], sg)) continue;
        if (segsIntersect(coords[i], coords[i + 1], sg.a, sg.b)) return sg.depth;
      }
    return null;
  }
  function evalContour(s) {
    if (!shallowSegs || !shallowSegs.length || !s.pos) return;
    const now = Date.now(); if (now - contourAt < CONTOUR_THROTTLE_MS) return; contourAt = now;
    // ROUTE crossing — recomputed EVERY throttled tick (bbox-rejected; negligible even vs ~1900
    // segments), so an interior-waypoint edit can never leave a stale verdict. A SEPARATE alarm from
    // the position warning below, so neither one masks the other.
    let routeDepth = null;
    if (s.route && Array.isArray(s.route.coords) && s.route.coords.length >= 2) routeDepth = routeCrossesShallow(s.route.coords);
    if (routeDepth != null) fire('route-shoal', 'warning', 'Route crosses charted ' + routeDepth + ' m contour (safety ' + safetyDepth + ' m)');
    else clear('route-shoal');
    // POSITION proximity — independent live alarm, only on a REAL fix (never "near shoal" off a sim position)
    const src = s.sources || {}, realPos = src.pos && src.pos !== 'simulated' && src.pos !== 'sim';
    if (realPos) {
      const p = [s.pos.lon, s.pos.lat];
      let nearest = Infinity, nd = null;
      for (let i = 0; i < shallowSegs.length; i++) { const sg = shallowSegs[i]; if (bboxFarPt(p, sg, 0.02)) continue; const dd = pointSegM(p, sg.a, sg.b); if (dd < nearest) { nearest = dd; nd = sg.depth; } }
      if (nearest <= CONTOUR_PROXIMITY_M) fire('contour', 'warning', 'Near charted ' + nd + ' m contour — ' + Math.round(nearest) + ' m (safety ' + safetyDepth + ' m)');
      else clear('contour');
    } else { clear('contour'); }
  }

  // ---- controls (maplibre group, bottom-left, away from zoom/ownship) ----
  const group = document.createElement('div');
  group.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  const mkBtn = (label, title, color) => { const b = document.createElement('button'); b.type = 'button'; b.title = title; b.textContent = label; b.style.cssText = 'font:700 12px system-ui;color:' + (color || '#cfe6ff') + ';touch-action:manipulation'; return b; };
  const anchorBtn = mkBtn('⚓', 'Drop / weigh anchor watch');
  const guardBtn = mkBtn('🛡', 'Guard zone — tap to place a keep-in / keep-out boundary');
  const mobBtn = mkBtn('MOB', 'Man overboard', '#ff6b6b');
  group.appendChild(anchorBtn); group.appendChild(guardBtn); group.appendChild(mobBtn);
  map.addControl({ onAdd() { return group; }, onRemove() { group.remove(); } }, 'bottom-left');
  let lastPos = null;
  anchorBtn.addEventListener('click', () => { anchor ? weighAnchor() : dropAnchor(lastPos); });
  guardBtn.addEventListener('click', armGuardPlacement);
  mobBtn.addEventListener('click', () => { mob ? cancelMOB() : markMOB(lastPos); });
  function paintCtl() {
    anchorBtn.style.color = anchor ? '#ff6b6b' : '#cfe6ff';
    guardBtn.style.color = placing ? '#ffd166' : (guard ? '#3bd6c6' : '#cfe6ff');
    mobBtn.textContent = mob ? '✕MOB' : 'MOB';
  }

  // ---- evaluate alarms from each fresh nav frame ----
  function onNav(s) {
    if (!s || !s.pos) return;
    lastPos = s.pos; lastNav = s;        // kept so a settings change can re-evaluate immediately (ALARM-11)
    if (!fresh) return;                  // hold on stale feed — never (re)evaluate from data we can't trust
    positionBanner();                    // track collision.js's CPA banner so the two never overlap
    const src = s.sources || {};

    // depth (only on a REAL depth feed — never alarm on the simulated fill or a 'missing' 0.0; hysteresis avoids flapping)
    if (typeof s.depth === 'number' && src.depth && src.depth !== 'simulated' && src.depth !== 'sim' && src.depth !== 'missing') {
      if (s.depth < depthLimit) fire('depth', 'warning', 'Shallow water — ' + s.depth.toFixed(1) + ' m (limit ' + depthLimit.toFixed(1) + ' m)');
      else if (s.depth >= depthClear) clear('depth');
    } else { clear('depth'); }

    // anchor watch — live drift readout + DEBOUNCED drag alarm (a single jitter fix can't trip it)
    if (anchor) {
      const d = distM(s.pos, anchor);
      updatePill(d);
      if (d > anchorRadius) {
        if (!dragSince) dragSince = Date.now();
        if (Date.now() - dragSince >= DRAG_DEBOUNCE_MS) {
          const b = Math.round(bearing(anchor, s.pos));
          fire('anchor', 'critical', 'Anchor dragging — ' + Math.round(d) + ' m from set point (limit ' + anchorRadius + ' m), bearing ' + b + '°');
        }
      } else { dragSince = null; clear('anchor'); }
    }

    // guard zone / watchdog — keep-in (alarm on leaving) or keep-out (alarm on entering), debounced
    if (guard) {
      const d = distM(s.pos, guard), inside = d <= guardRadius;
      updateGuardPill(d, inside);
      const breach = guardMode === 'in' ? !inside : inside;
      if (breach) {
        if (!guardBreachSince) guardBreachSince = Date.now();
        if (Date.now() - guardBreachSince >= GUARD_DEBOUNCE_MS) {
          const b = Math.round(bearing(guard, s.pos));
          fire('guard', 'critical', guardMode === 'in'
            ? 'Guard zone — left the keep-in zone (' + Math.round(d) + ' m from centre, limit ' + guardRadius + ' m), bearing ' + b + '°'
            : 'Guard zone — entered the keep-out zone (' + Math.round(d) + ' m inside, radius ' + guardRadius + ' m)');
        }
      } else { guardBreachSince = null; clear('guard'); }
    }

    // off-course (XTE) + arrival — only while a REAL route is active and plausibly being navigated.
    // No active route → no route metrics, so a dtg=0 default must not fire a phantom 'Arriving'
    // (and a stale far-away demo route is still guarded by the ONROUTE_NM distance gate below).
    const navRoute = s.route && Array.isArray(s.route.coords) && s.route.coords.length >= 2;
    if (navRoute && s.active && s.active.nextWp) {
      const dtgNM = num(s.active.dtg), xteM = num(s.active.xte);
      if (isFinite(dtgNM) && dtgNM < ONROUTE_NM) {
        if (isFinite(dtgNM) && dtgNM <= arrivalNM) fire('arrival', 'warning', 'Arriving — ' + s.active.nextWp);
        else clear('arrival');
        if (isFinite(xteM) && xteM > xteLimit) fire('xte', 'warning', 'Off course — ' + Math.round(xteM) + ' m cross-track (limit ' + xteLimit + ' m)');
        else clear('xte');
      } else { clear('arrival'); clear('xte'); }
    }

    // MOB — live go-to range/bearing + elapsed + growing search-area estimate (alarm holds until cancelled)
    if (mob) {
      const d = distM(s.pos, mob), b = Math.round(bearing(s.pos, mob));
      const elapsed = mobTime ? (Date.now() - mobTime) / 1000 : 0;
      const mmss = Math.floor(elapsed / 60) + ':' + String(Math.floor(elapsed % 60)).padStart(2, '0');
      const sr = Math.round(mobSearchRadius(elapsed));
      const fmt = m => m < 1852 ? Math.round(m) + ' m' : (m / 1852).toFixed(2) + ' NM';
      redrawMOB(s.pos);          // steer-to line to the datum + search-area circle that grows with time
      fire('mob', 'critical', 'MAN OVERBOARD — ' + mmss + ' ago · steer ' + fmt(d) + ', brg ' + b + '° · search ~' + fmt(sr) + ' (drift est., no current feed)');
    }

    // safety-contour check — route crosses / position nears a charted shoal contour (throttled, real-pos guarded)
    evalContour(s);
    // CPA/TCPA is owned by collision.js (richer COLREGs guidance + audio); not duplicated here.
  }

  // ---- settings (ALARM-11): mutable thresholds + per-alarm enable + mute, persisted via HelmStore ----
  function _reEval() { if (lastNav) onNav(lastNav); }      // re-run detection at once after a threshold change
  function setDepthLimit(v) { v = +v; if (isFinite(v) && v > 0)  { depthLimit = v; depthClear = v + 0.3; savePrefs(); _reEval(); } }
  function setXteLimit(v)   { v = +v; if (isFinite(v) && v > 0)  { xteLimit = v;  savePrefs(); _reEval(); } }
  function setArrivalNM(v)  { v = +v; if (isFinite(v) && v > 0)  { arrivalNM = v; savePrefs(); _reEval(); } }
  function setSafetyDepth(v){ v = +v; if (isFinite(v) && v >= 0) { safetyDepth = v; if (contourRaw) ingestContours(contourRaw); contourAt = 0; savePrefs(); _reEval(); } }
  function setEnabled(kind, on) { enabled[kind] = !!on; if (!on) clear(kind); savePrefs(); render(); }
  function setMuted(m) { muted = !!m; savePrefs(); }
  function settings() { return { depthLimit, xteLimit, arrivalNM, safetyDepth, anchorRadius, muted, enabled: Object.assign({}, enabled) }; }
  function status() {   // fail-loud signals the panel surfaces to the helm (per PR #34)
    const audio = muted ? 'muted' : (audioWarned ? 'blocked' : (!ac ? 'idle' : (ac.state === 'running' ? 'on' : (ac.state === 'suspended' ? 'tap' : ac.state))));
    return { audio, contour: { state: contourState, segments: shallowSegs ? shallowSegs.length : 0, safetyDepth } };
  }

  // ---- Alarms settings panel (SHELL-registered) ----
  let _panelBody = null;
  function syncSettingsPanel() { try { const h = window.HelmShell && HelmShell.panel('helm-alarm-settings'); if (_panelBody && _panelBody._alarmSync && h && h.isOpen && h.isOpen()) _panelBody._alarmSync(); } catch (e) {} }
  (function registerSettingsPanel() {
    if (!(window.HelmShell && HelmShell.registerPanel)) return;
    const ALARMS = [['depth', 'Shallow water (depth)'], ['xte', 'Off-course (XTE)'], ['arrival', 'Arrival'],
      ['nofix', 'Feed-loss / no-fix'], ['contour', 'Safety-contour (charted shoal)'],
      ['anchor', 'Anchor drag'], ['guard', 'Guard zone'], ['mob', 'MOB']];
    const dim = 'color:var(--cdim,#8aa)';
    HelmShell.registerPanel({
      id: 'helm-alarm-settings', epic: 'ALARM', title: 'Alarms', icon: '⚠',
      render: function (body) {
        _panelBody = body;
        const numRow = (id, label, val, step, min, unit) =>
          '<label class="row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0">' +
          '<span>' + label + '</span><span><input type="number" id="' + id + '" value="' + val + '" step="' + step + '" min="' + min + '" ' +
          'style="width:64px;text-align:right;background:transparent;border:.5px solid var(--line,#2a3742);border-radius:6px;color:var(--ctext,#cdd9e3);padding:3px 6px"> ' + unit + '</span></label>';
        const enRow = (k, label) =>
          '<label class="row" style="display:flex;align-items:center;gap:8px;margin:5px 0"><input type="checkbox" id="al-en-' + k + '"> ' + label + '</label>';
        body.innerHTML =
          '<div class="sub" style="margin-bottom:10px;' + dim + '">Per-alarm enable, audible mute, and thresholds — all persist across reload.</div>' +
          '<div class="lbl" style="margin:10px 0 4px;font-size:11px;letter-spacing:.04em;' + dim + '">THRESHOLDS</div>' +
          numRow('al-depth', 'Shallow depth', depthLimit, '0.5', '0.5', 'm') +
          numRow('al-xte', 'Off-course XTE', xteLimit, '10', '10', 'm') +
          numRow('al-safety', 'Safety contour', safetyDepth, '1', '0', 'm') +
          '<div class="lbl" style="margin:14px 0 4px;font-size:11px;letter-spacing:.04em;' + dim + '">ALARMS</div>' +
          ALARMS.map(a => enRow(a[0], a[1])).join('') +
          '<label class="row" style="display:flex;align-items:center;gap:8px;margin:10px 0 2px"><input type="checkbox" id="al-mute"> <b>Mute all alarm audio</b> <span style="' + dim + ';font-size:10.5px">(banner still shows)</span></label>' +
          '<div class="lbl" style="margin:14px 0 4px;font-size:11px;letter-spacing:.04em;' + dim + '">STATUS</div>' +
          '<div id="al-st-audio" style="font-size:12px;margin:3px 0"></div>' +
          '<div id="al-st-contour" style="font-size:12px;margin:3px 0"></div>';
        const g = id => body.querySelector(id);
        g('#al-depth').onchange = e => setDepthLimit(e.target.value);
        g('#al-xte').onchange = e => setXteLimit(e.target.value);
        g('#al-safety').onchange = e => setSafetyDepth(e.target.value);
        g('#al-mute').onchange = e => setMuted(e.target.checked);
        ALARMS.forEach(a => { g('#al-en-' + a[0]).onchange = e => setEnabled(a[0], e.target.checked); });
        body._alarmSync = function () {
          g('#al-depth').value = depthLimit; g('#al-xte').value = xteLimit; g('#al-safety').value = safetyDepth;
          g('#al-mute').checked = muted;
          ALARMS.forEach(a => { g('#al-en-' + a[0]).checked = enabled[a[0]] !== false; });
          const st = status();
          const A = { on: ['● audio working', 'var(--ok,#46e0a0)'], tap: ['● tap the chart once to enable audio', 'var(--warn,#ffc06a)'],
            blocked: ['▲ ALARM AUDIO BLOCKED — you will not hear alarms', 'var(--danger,#ff6b6b)'],
            muted: ['● audio muted (by you)', 'var(--cdim,#8aa)'], idle: ['○ audio idle (not yet sounded)', 'var(--cdim,#8aa)'] }[st.audio] || ['audio: ' + st.audio, 'var(--cdim,#8aa)'];
          const ae = g('#al-st-audio'); ae.textContent = A[0]; ae.style.color = A[1];
          const c = st.contour, ce = g('#al-st-contour');
          if (c.state === 'ready') { ce.textContent = '● safety-contour data loaded (' + c.segments + ' seg ≤ ' + c.safetyDepth + ' m)'; ce.style.color = 'var(--ok,#46e0a0)'; }
          else if (c.state === 'unavailable') { ce.textContent = '▲ SAFETY-CONTOUR DATA UNAVAILABLE — shoal alarm inactive here'; ce.style.color = 'var(--danger,#ff6b6b)'; }
          else { ce.textContent = '○ loading safety-contour data…'; ce.style.color = 'var(--cdim,#8aa)'; }
        };
        body._alarmSync();
      },
      onOpen: function (body) { if (body._alarmSync) body._alarmSync(); }
    });
    if (HelmShell.registerCommand) HelmShell.registerCommand({
      id: 'helm-alarm-settings-open', epic: 'ALARM', title: 'Alarm settings',
      subtitle: 'Thresholds, mute, per-alarm enable', keywords: ['alarm', 'settings', 'threshold', 'mute', 'depth', 'xte', 'contour'],
      group: 'Alarms', run: function () { const h = HelmShell.panel('helm-alarm-settings'); if (h && h.open) h.open(); }
    });
  })();

  return {
    onNav,
    setDepthLimit, setXteLimit, setArrivalNM, setSafetyDepth, setEnabled, setMuted, settings, status,   // ALARM-11 settings API
    onSource,                                            // feed state in → hold + audible no-fix/feed-loss alarm (ALARM-9/10)
    setActive(f) { fresh = !!f; },                       // legacy hold/resume w/o source detail — superseded by onSource
    fromEngine(a) { if (a && (a.id || a.kind)) fireById(a.id || a.kind, a.kind || a.id, a.sev || 'warning', a.msg || a.kind || a.id, false); },  // legacy {kind,sev,msg}, id-aware when present
    fromAlarm(a, meta) { if (a && (a.id || a.kind)) fireById(a.id || a.kind, a.kind || a.id, a.sev || 'warning', a.msg || a.kind || a.id, !!(meta && meta.escalated)); },  // CONTRACT-10 raise/update: id is identity; kind is icon/class
    clearById(id) { if (id) clear(id); },                // CONTRACT-10 alarm.clear (via onAlarmClear)
    dropAnchor: p => dropAnchor(p || lastPos), markMOB: () => markMOB(lastPos), setRadius,
    dropGuard: (p, mode) => dropGuard(p || lastPos, mode), clearGuard, setGuardMode, setGuardRadius,   // guard zone (ALARM-7)
    _state: () => ({ active: Object.keys(active), anchor: !!anchor, radius: anchorRadius, mob: !!mob, fresh, feedState, hadFeed,
                     guard: !!guard, guardMode, guardRadius, contourSegs: shallowSegs ? shallowSegs.length : 0,
                     muted, depthLimit, xteLimit, safetyDepth, contourState, enabled: Object.assign({}, enabled) }),  // for tests
    _loadContours: ingestContours,                       // inject charted-contour geojson (tests)
    _msg: k => active[k] && active[k].msg,               // current message for an active alarm (tests)
    _tick: beepTick                                      // drive one alarm tick deterministically (tests)
  };
};
