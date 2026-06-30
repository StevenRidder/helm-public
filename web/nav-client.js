// HelmNavClient — the robust live-nav client. ONE code path, local or remote.
//
// Connects to HelmEndpoint.navUrl() (see server-endpoint.js) and feeds the cockpit the
// SAME flat state shape the in-browser sim (nav-source.js / HelmNav) emits — so the UI
// rendering code is identical for real, simulated, local, and remote nav.
//
// What makes it world-class over flaky boat WiFi:
//   • snapshot + delta   — first frame is a full snapshot; later frames carry only what
//     changed (merged here). Legacy full frames (no `t`) are also accepted, so this client
//     works against the current engine unchanged.
//   • AGE WATCHDOG       — staleness is judged by how long since the last frame, NOT by
//     socket state. A half-open WiFi socket reports "open" while no data arrives; we treat
//     LIVE(<3s) / LAGGING(3–10s) / STALE(>10s) purely on frame age. This is the safety rule.
//   • reconnect+resume   — exponential backoff with jitter; on reconnect we send lastSeq so
//     the server can snapshot us immediately.
//   • latest-wins coalescing (CONTRACT-9) — under backpressure (a WiFi stall releasing a
//     burst of queued frames) we merge every nav frame but render onState at most once per
//     animation frame, so the UI never thrashes through stale intermediate fixes. Only
//     snapshot/delta are coalescable; alarms, command replies and ping bypass it verbatim.
//   • reliable alarms (CONTRACT-10) — see the FROZEN ALARM WIRE SCHEMA below.
//   • channels + client-chosen rate (CONTRACT-7) — the client declares which named streams it wants
//     (nav/route/alarms/ais/track/conns) and a nav update rate (1–4 Hz) in the hello, re-negotiable at
//     runtime via setRate()/subscribe()/unsubscribe(); the server filters + paces and echoes the
//     effective config (opts.onSub). Wire contract: docs/CONTRACT-CHANNELS.md.
//   • never fakes position — if a real feed drops we go STALE/OFFLINE and say so; we never
//     silently swap in the simulator presenting a plausible fake fix. The sim is used ONLY
//     when no engine was ever reached (honest prototype mode).
//
// onState(flatState)   — called with the merged, UI-shaped state (coalesced, latest-wins).
// onStatus({phase,...})— called whenever the connection phase changes. phase ∈
//     connecting | live | simpos | lagging | stale | offline | sim
//   (NOTE: alarms NO LONGER ride onStatus phase:'alarm'; they have their own reliable path —
//    see opts.onAlarm / opts.onAlarmClear and the legacy fallback below.)
//
// ===========================================================================================
// CONTRACT-10 — FROZEN ALARM WIRE SCHEMA (v1).  CONTRACT is the SINGLE owner of this contract;
// the full spec + examples + engine-side handoff live in docs/CONTRACT-ALARM-SCHEMA.md. This
// client (nav-client.js) is the singly-owned DECODE + reliability point. Consumers subscribe to
// typed events and never parse alarm frames themselves.
//
// FRAME TYPES (all share the "alarm" prefix → a single cheap coalescer/router test):
//   t="alarm"        server→client  one ACTIVE alarm record (op="raise"|"update"). One per frame.
//   t="alarm.clear"  server→client  one alarm REMOVED (condition resolved/expired/superseded).
//   t="alarm.ack"    client→server  transport-ACK and/or user-ACK; batchable.
//
// t="alarm" REQUIRED: { t, op, id, rev, kind, sev, msg }
//   op    "raise"|"update"   (unknown op ⇒ treat as update; update on an unseen id ⇒ a raise)
//   id    string             STABLE server-minted identity; "<kind>" or "<kind>:<scope>".
//                            THE dedup + ACK + banner key.
//   rev   integer ≥ 1        monotonic per (id,gen); FULL-STATE revision (not a diff).
//   kind  string             legacy alarm class (depth|anchor|xte|arrival|mob|guardzone|sart|
//                            dsc|boundary|tile|…). Back-compat with alarms.js fromEngine.
//   sev   "critical"|"warning"|"info"
//   msg   string             server-rendered banner text.
//  OPTIONAL/ADDITIVE: gen(int≥0, default 0 — generation/epoch; (gen,rev) lexicographic ordering),
//   seq(advisory, NOT written to lastSeq), prio, raisedTs, ts, lat, lon, silenceable(default true),
//   expiresTs, apns, replay(bool), data{flat well-known keys; unknown keys MUST be ignored}.
// t="alarm.clear" REQUIRED: { t, id }   OPTIONAL: reason, rev, gen, kind, msg, seq, ts.
// t="alarm.ack"   REQUIRED: { t, acks:[{id, rev, gen?, user?}] }   OPTIONAL: ts, alarm(single-entry shim).
//
// CLIENT RELIABILITY (this file). State: Map<id,{gen,rev,sev,acked}>. Ordering cmp := (gen,rev) lex.
//  On EVERY alarm / alarm.clear frame:
//   1. ALWAYS enqueue a transport-ack for (id,gen,rev) — duplicates, replays AND clears included
//      (batched ≤250ms; one ack per id at the highest seen (gen,rev)).  → a re-sent alarm is re-ACKed.
//   2. alarm.clear → delete map[id]; remove banner. Server-authoritative removal (≠ user-ACK).
//   3. alarm with (gen,rev) ≤ seen → dup/resend/reorder: do NOT re-render, re-beep, or touch acked.
//   4. alarm, id UNSEEN (or update on unseen) → NEW: fire banner; map[id]={gen,rev,acked:false}.
//   5. alarm, (gen,rev) > seen → UPDATE: re-render; PRESERVE acked when sev unchanged, RESET acked
//      on escalation to "critical" (the alarms.js beep is a poll over !acked && critical).
//  THREE INDEPENDENT SIGNALS: receive (transport-ACK, automatic) ≠ silence (user-ACK, manual,
//  never stops resends) ≠ resolve (server alarm.clear).
//  SAFETY INVARIANT: alarm handling returns BEFORE the everEngine/lastFrameAt/lastSeq nav block and
//  never calls onState/classify — an alarm burst can NEVER make a dead nav feed read LIVE.
//
// COALESCING EXEMPTION (CONTRACT-9): only nav-state frames (snapshot/delta + legacy full frames)
//  reach emitState() and are coalesced latest-wins; alarms/commands/ping return earlier in onFrame
//  and pass through verbatim. The egress-coalescer wire predicate — isCoalescable(f) := f.t ∈
//  {"snapshot","delta"} — is documented in docs/CONTRACT-ALARM-SCHEMA.md §6.
//
// FAIL-FAST: nav-client is the decode boundary, so a non-conformant alarm frame is logged LOUDLY
// (which REQUIRED field is missing/invalid) the moment it arrives — never silently coerced behind a
// default. A renderable alarm is still processed (a safety client must not DROP an alarm), but the
// weak link is surfaced immediately so the producer can be fixed.
// BACK-COMPAT: a minimal {t:"alarm",kind,sev,msg} frame still renders (id defaults to "<kind>"),
// flagged non-conformant. If a richer consumer wires opts.onAlarm/opts.onAlarmClear (SHELL/ALARM
// tasks) it gets the full id-keyed lifecycle; otherwise this client falls back to the legacy onStatus
// phase:'alarm' path (deduped), so today's index.html → __alarms.fromEngine() keeps working with ZERO
// change to those files.
// ===========================================================================================
(function () {
  function mergeState(base, patch) {
    // CLIENT-9: shallow copy-on-write instead of a per-frame deep clone (JSON.parse(JSON.stringify))
    // that re-serialised the WHOLE state — including the full AIS array — on every snapshot/delta.
    // The loop below already isolates each PATCHED key (a fresh object for nested merges, replacement
    // for arrays/primitives), so `base` is never mutated; unchanged branches are shared by reference,
    // which is safe because every consumer (applyNav → ownship/collision/alarms) only READS the state.
    const out = base ? Object.assign({}, base) : {};
    for (const k in patch) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = Object.assign({}, out[k], v);     // one-level deep (wind, active, sources)
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  const realPos = s => {
    const p = (s && s.sources && s.sources.pos) || (s && s.posSource);
    return !!p && p !== 'simulated' && p !== 'sim';
  };
  window.HelmNavClient = function (onState, onStatus, opts) {
    opts = opts || {};
    const LIVE_MS = 3000, STALE_MS = 10000;        // age thresholds
    const BACKOFF_CAP = 8000, BACKOFF_BASE = 400;  // reconnect schedule
    const ACK_DEBOUNCE_MS = 250;                   // batch transport-acks into one frame (CONTRACT-10)
    // latest-wins render coalescing (CONTRACT-9). Default on; one render per animation frame.
    // Overridable: opts.coalesce===false restores synchronous onState; opts.scheduleFrame for tests.
    const coalesce = opts.coalesce !== false;
    // rAF gives smooth foreground rendering, but rAF is SUSPENDED in a hidden tab — fall back to a
    // timer there so coalesced nav state (and the client-side alarm/CPA evaluation applyNav drives
    // off it) keeps flushing while backgrounded. The 500ms watchdog is a second safety net for the
    // visible→hidden transition. Override via opts.scheduleFrame (tests pass a manual flusher).
    const scheduleFrame = opts.scheduleFrame || (cb => {
      if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) requestAnimationFrame(cb);
      else setTimeout(cb, 16);
    });
    const status = (phase, extra) => {
      const ep = window.HelmEndpoint ? HelmEndpoint.describe() : '(unresolved)';
      try { onStatus && onStatus(Object.assign({ phase, endpoint: ep }, extra)); }
      catch (e) { console.error('HelmNavClient: onStatus handler threw:', e); }   // surface, don't swallow
    };

    let state = null;          // last merged full state
    let lastSeq = 0;
    let lastFrameAt = 0;       // ms of last frame (Date.now)
    let everEngine = false;    // did we ever receive an engine frame?
    let ws = null, attempt = 0, reconnectTimer = null, watchdog = null, closed = false;
    let sim = null;            // sim interval id, if running
    let emitPending = false;   // a coalesced onState flush is scheduled
    let stateDirty = false;    // state merged but not yet delivered to onState (drives the watchdog safety-flush)

    // ---- reliable-alarm state (CONTRACT-10) ----
    const alarmState = new Map();   // id -> { gen, rev, sev, acked }
    const ackQ = new Map();         // id -> { gen, rev, user }  (highest-seen, flushed ≤ACK_DEBOUNCE_MS)
    let ackTimer = null;
    let warnedNoClear = false;      // one-shot warn: alarm.clear arrived but no onAlarmClear wired
    const alarmCmp = (g1, r1, g2, r2) => (g1 !== g2 ? g1 - g2 : r1 - r2);

    // ---- channels/subscriptions + client-chosen nav rate (CONTRACT-7) ----
    // The client DECLARES which named channels it wants and a nav update rate (1–4 Hz); the server
    // filters frame content by subscription and paces nav deltas to that rate (alarms/commands are
    // exempt — always immediate). Desired state persists across reconnect (re-sent in the hello) and
    // can be re-negotiated at runtime via a sub.update frame; the server echoes the EFFECTIVE config
    // back in sub.ack. Wire contract: docs/CONTRACT-CHANNELS.md. (Server filtering/pacing is a
    // CHART/ENGINE-lane consuming task — this is the client half + the frozen contract.)
    const KNOWN_CHANNELS = ['nav', 'route', 'alarms', 'ais', 'track', 'conns'];
    const RATE_MIN = 1, RATE_MAX = 4;
    const clampRate = hz => {                       // fail-fast: surface a bad rate, never silently accept it
      const n = +hz;
      if (!isFinite(n)) { console.warn('HelmNavClient: nav rate "' + hz + '" is not a number — ignoring'); return null; }
      const r = Math.max(RATE_MIN, Math.min(RATE_MAX, Math.round(n)));
      if (r !== n) console.warn('HelmNavClient: nav rate ' + hz + ' Hz coerced to ' + r + ' Hz (allowed integer ' + RATE_MIN + '..' + RATE_MAX + ')');
      return r;
    };
    const normChannels = chs => {
      const out = [];
      (chs || []).forEach(c => {
        if (typeof c !== 'string' || !c || out.indexOf(c) >= 0) return;
        if (KNOWN_CHANNELS.indexOf(c) < 0) console.warn('HelmNavClient: unknown channel "' + c + '" (known: ' + KNOWN_CHANNELS.join(', ') + ') — forwarding anyway');
        out.push(c);
      });
      return out;
    };
    // 'nav' (position/instruments) is the safety core — always subscribed, never droppable.
    let subChannels = normChannels(opts.subscribe || KNOWN_CHANNELS);
    if (subChannels.indexOf('nav') < 0) subChannels.unshift('nav');
    let navRate = opts.rate != null ? clampRate(opts.rate) : null;   // null ⇒ accept the server default
    let effSub = null;   // server-echoed effective {subscribe, rate, bbox} (from sub.ack); null until acked
    // CONTRACT-8: optional AIS viewport. [w,s,e,n] culls the 'ais' channel to that lat/lon box server-side;
    // null streams all targets. The caller (map-move handler) sets it via setBbox(); rapid moves coalesce
    // into one sub.update per BBOX_THROTTLE_MS so panning never floods the socket.
    const BBOX_THROTTLE_MS = 300;
    const normBbox = b => {
      if (!Array.isArray(b) || b.length !== 4 || !b.every(n => typeof n === 'number' && isFinite(n))) {
        console.warn('HelmNavClient: bbox must be [w,s,e,n] of 4 finite numbers — ignoring', b); return undefined;
      }
      return [b[0], b[1], b[2], b[3]];
    };
    let navBbox = opts.bbox != null ? (normBbox(opts.bbox) || null) : null;   // invalid ⇒ null (no viewport)
    let bboxTimer = null;
    function withCfg(f) {                              // attach desired channels/rate/bbox to a hello/sub.update
      f.subscribe = subChannels.slice();
      if (navRate != null) f.rate = navRate;
      if (navBbox) f.bbox = navBbox.slice();
      return f;
    }
    function sendSubUpdate(extra) {
      const f = withCfg({ t: 'sub.update' });
      if (extra) Object.assign(f, extra);             // e.g. { bbox: null } to explicitly clear the viewport
      return sendRaw(f);   // false if not open — the next hello re-sends current state, so it converges
    }

    const startSim = () => { if (opts.sim && !sim && !everEngine) { sim = opts.sim(onState); status('sim'); } };
    const stopSim = () => { if (sim) { clearInterval(sim); sim = null; } };

    // Low-level send over the nav socket. Returns false if not open (the server's resend loop will
    // redeliver any alarm, and we re-ack on the next receipt — so a dropped ack self-heals).
    function sendRaw(obj) {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(obj)); return true; }
        catch (e) { console.warn('HelmNavClient: send failed:', e && e.message); }
      }
      return false;
    }

    // ---- transport/user ACK batcher: one alarm.ack per window, highest (gen,rev) per id ----
    function flushAcks() {
      ackTimer = null;
      if (!ackQ.size) return;
      const acks = [];
      ackQ.forEach((v, id) => { const e = { id, rev: v.rev }; if (v.gen) e.gen = v.gen; if (v.user) e.user = true; acks.push(e); });
      ackQ.clear();
      const frame = { t: 'alarm.ack', acks };
      if (acks.length === 1) frame.alarm = acks[0].id;   // back-compat shim for single-entry ack
      sendRaw(frame);
    }
    function enqueueAck(id, gen, rev, user) {
      const cur = ackQ.get(id);
      if (!cur || alarmCmp(gen, rev, cur.gen, cur.rev) > 0) ackQ.set(id, { gen, rev, user: !!user || (cur && cur.user) || false });
      else if (user && cur) cur.user = true;             // newer rev already queued; just mark user-silenced
      if (!ackTimer && !closed) ackTimer = setTimeout(flushAcks, ACK_DEBOUNCE_MS);
    }

    // ---- the single alarm decode + reliability point (frozen schema above) ----
    function handleAlarm(msg) {
      // FAIL-FAST at the decode boundary (nav-client is the singly-owned alarm decoder): surface a
      // non-conformant producer LOUDLY the moment it appears instead of silently coercing it behind a
      // default. A safety client still PROCESSES a renderable alarm — dropping one is worse than
      // rendering it — but the weak link is logged immediately so it can be fixed, never masked.
      const id = msg.id != null ? msg.id : msg.kind;   // singleton convention: id defaults to "<kind>"
      if (id == null) { console.warn('HelmNavClient: alarm frame has neither id nor kind — unrenderable, dropping:', msg); return; }
      const bad = [];
      if (msg.id == null) bad.push('id REQUIRED (defaulted to kind "' + id + '")');
      if (msg.t === 'alarm') {                                  // required set for an active record (§2)
        if (msg.op !== 'raise' && msg.op !== 'update') bad.push('op="' + msg.op + '" (expect raise|update)');
        if (typeof msg.rev !== 'number' || msg.rev < 1 || (msg.rev | 0) !== msg.rev) bad.push('rev=' + msg.rev + ' (expect integer 1..2^31-1)');
        if (typeof msg.kind !== 'string' || !msg.kind) bad.push('kind REQUIRED');
        if (msg.sev !== 'critical' && msg.sev !== 'warning' && msg.sev !== 'info') bad.push('sev="' + msg.sev + '" (expect critical|warning|info)');
        if (typeof msg.msg !== 'string') bad.push('msg REQUIRED');
      }
      if (bad.length) console.warn('HelmNavClient: NON-CONFORMANT alarm frame (id=' + id + ') — ' + bad.join('; ') + '. See docs/CONTRACT-ALARM-SCHEMA.md §2.', msg);
      const gen = msg.gen | 0, rev = msg.rev | 0;
      enqueueAck(id, gen, rev, false);                          // STEP 1: ALWAYS transport-ack
      if (msg.t === 'alarm.clear') {                            // STEP 2: server-authoritative removal
        alarmState.delete(id);
        if (opts.onAlarmClear) { try { opts.onAlarmClear(id, msg); } catch (e) { console.error('HelmNavClient: onAlarmClear handler threw:', e); } }
        else if (!warnedNoClear) { warnedNoClear = true; console.warn('HelmNavClient: alarm.clear for "' + id + '" dropped — no opts.onAlarmClear wired, so the legacy banner cannot be auto-removed. Wire onAlarm/onAlarmClear per docs/CONTRACT-ALARM-SCHEMA.md §9.'); }
        return;
      }
      const seen = alarmState.get(id);
      if (seen && alarmCmp(gen, rev, seen.gen, seen.rev) <= 0) return;   // STEP 3: dup/resend/reorder — no re-fire
      const escalated = !!(seen && msg.sev === 'critical' && seen.sev !== 'critical');
      alarmState.set(id, { gen, rev, sev: msg.sev, acked: (seen && !escalated) ? seen.acked : false });
      const meta = { isNew: !seen, escalated };                 // STEP 4 (new) / STEP 5 (update)
      if (opts.onAlarm) {
        try { opts.onAlarm(msg, meta); } catch (e) { console.error('HelmNavClient: onAlarm handler threw:', e); }
      } else {
        // Legacy fallback (deduped): today's index.html routes phase:'alarm' → __alarms.fromEngine(msg),
        // which reads {kind,sev,msg}. We only reach here on a raise/true-update, so re-sends never re-fire.
        status('alarm', { alarm: msg, meta: meta });
      }
    }

    // ---- coalesced render (CONTRACT-9): merge every frame, emit onState at most once per frame ----
    function deliverState() {
      if (closed || !state) return;
      stateDirty = false;
      try { onState(state); } catch (e) { console.error('HelmNavClient: onState handler threw:', e); }
    }
    function flushState() { emitPending = false; if (stateDirty) deliverState(); }
    function emitState() {
      if (!coalesce) { deliverState(); return; }
      stateDirty = true;
      if (emitPending) return;                       // a flush is already scheduled — latest-wins
      emitPending = true;
      scheduleFrame(flushState);
    }

    function classify() {
      if (!everEngine) return;                     // sim/connecting phases are driven elsewhere
      const age = Date.now() - lastFrameAt;
      if (age < LIVE_MS) status(realPos(state) ? 'live' : 'simpos', { age, seq: lastSeq });
      else if (age < STALE_MS) status('lagging', { age, seq: lastSeq });
      else status('stale', { age, seq: lastSeq });
    }

    function onFrame(msg) {
      if (closed) return;                                          // stop() quiesces every inbound path
      if (msg.t === 'ping') { lastFrameAt = Date.now(); return; }   // heartbeat keeps us LIVE
      // Alarm class — reliable, coalescing-exempt, and MUST stay above the nav block so it never
      // touches lastFrameAt/everEngine/lastSeq (the age-based staleness safety rule). PREFIX-CONSUMING:
      // the WHOLE alarm.* family returns here, so a stray or future alarm.* subtype can never fall
      // through to the nav block and fake LIVE.
      if (msg.t === 'alarm' || (typeof msg.t === 'string' && msg.t.indexOf('alarm.') === 0)) {
        if (msg.t === 'alarm' || msg.t === 'alarm.clear') handleAlarm(msg);
        return;
      }
      if (msg.t === 'sub.ack') {   // CONTRACT-7/8: server's EFFECTIVE channel/rate/bbox config (possibly clamped)
        effSub = { subscribe: Array.isArray(msg.subscribe) ? msg.subscribe.slice() : subChannels.slice(), rate: msg.rate != null ? msg.rate : navRate, bbox: Array.isArray(msg.bbox) ? msg.bbox.slice() : null };
        try { opts.onSub && opts.onSub(effSub); } catch (e) { console.error('HelmNavClient: onSub handler threw:', e); }
        try { opts.onCommand && opts.onCommand(msg); } catch (e) { console.error('HelmNavClient: onCommand handler threw:', e); }
        return;
      }
      if (typeof msg.t === 'string' && (msg.t.indexOf('conn.') === 0 || msg.t.indexOf('route.') === 0 || msg.t.indexOf('track.') === 0 || msg.t.indexOf('sub.') === 0 || msg.t.indexOf('nmea.') === 0)) {
        try { opts.onCommand && opts.onCommand(msg); } catch (e) { console.error('HelmNavClient: onCommand handler threw:', e); }   // command-plane replies (incl. CONN-7 nmea.monitor.ack / nmea.raw)
        return;   // not nav state — do not merge or reset the staleness watchdog
      }
      everEngine = true; attempt = 0; stopSim();
      lastFrameAt = Date.now();
      if (typeof msg.seq === 'number') lastSeq = msg.seq;
      // snapshot replaces; delta merges; a legacy full frame (no t) replaces.
      if (msg.t === 'delta') {
        if (!state) {                          // no baseline yet — refuse the partial, surface it, await a snapshot
          console.warn('HelmNavClient: delta seq ' + msg.seq + ' arrived before any snapshot — awaiting baseline (server should send snapshot first)');
          classify(); return;
        }
        state = mergeState(state, msg);
      } else {
        state = mergeState(msg.t === 'snapshot' ? {} : state, msg);
      }
      emitState();   // latest-wins coalesced onState (CONTRACT-9)
      classify();
    }

    function connect() {
      if (closed) return;
      if (!window.HelmEndpoint) {
        // Hard wiring error: server-endpoint.js didn't load. Do NOT fabricate a localhost URL
        // and pretend — surface it loudly and stop (reconnecting can't fix a missing module).
        console.error('HelmNavClient: HelmEndpoint missing (server-endpoint.js not loaded). Cannot resolve the engine; not connecting.');
        status('offline', { error: 'no-endpoint' });
        return;
      }
      status('connecting');
      const url = HelmEndpoint.navUrl();
      try { ws = new WebSocket(url); }
      catch (e) { console.error('HelmNavClient: WebSocket(' + url + ') failed to construct:', e && e.message); scheduleReconnect(); return; }

      ws.onopen = () => {
        // Resume hint: lastSeq for nav delta-since; lastAlarmAck (additive/optional) lets the server
        // skip re-asserting alarms we already hold (omitting it ⇒ full re-assert, the safe default).
        const hello = withCfg({ t: 'hello', lastSeq });   // CONTRACT-7/8: declare channels + rate + bbox
        if (alarmState.size) { const la = []; alarmState.forEach((v, id) => la.push({ id, gen: v.gen, rev: v.rev })); hello.lastAlarmAck = la; }
        try { ws.send(JSON.stringify(hello)); }
        catch (e) { console.warn('HelmNavClient: hello send failed:', e && e.message); }
      };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); }
        catch (x) { console.error('HelmNavClient: dropping unparseable frame from engine:', x && x.message); return; }
        onFrame(m);
      };
      ws.onerror = () => { /* close handler drives reconnect / sim */ };
      ws.onclose = () => {
        ws = null;
        if (closed) return;
        if (everEngine) { status('offline', { seq: lastSeq }); scheduleReconnect(); }   // had a feed → keep trying, stay honest
        else if (attempt === 0) { /* very first attempt: give the sim a grace window */ }
        else { scheduleReconnect(); }
      };
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer) return;
      const delay = Math.min(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2, attempt)) * (0.7 + 0.6 * pseudoJitter(attempt));
      attempt++;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    }
    // deterministic-ish jitter without Math.random (varies by attempt)
    function pseudoJitter(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }

    // First-connect grace: if we haven't reached an engine shortly after load, fall back to
    // the honest sim (prototype mode) — but keep trying to connect underneath.
    const graceMs = opts.simGraceMs != null ? opts.simGraceMs : 1500;
    setTimeout(() => { if (!everEngine) startSim(); }, graceMs);

    watchdog = setInterval(() => {
      classify();
      // Safety net: if a coalesced flush is owed but the frame scheduler is starved (hidden tab → rAF
      // suspended), force-deliver so client-side alarm/CPA evaluation (applyNav → alarms.onNav /
      // collision.update) never silently stops while the badge still reads LIVE.
      if (coalesce && stateDirty && !closed) deliverState();
    }, 500);
    connect();

    return {
      stop() {
        closed = true;
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
        if (bboxTimer) { clearTimeout(bboxTimer); bboxTimer = null; }
        ackQ.clear(); alarmState.clear();
        stopSim();
      },
      endpoint() { return HelmEndpoint.describe(); },
      // Send a command to the engine over the SAME nav socket (control-plane: conn.upsert/delete/list,
      // and routes/waypoints next). Returns false if the socket isn't open. Replies arrive via opts.onCommand.
      send(obj) { return sendRaw(obj); },
      // USER-ACK (CONTRACT-10): the skipper silenced these alarm ids. Marks them user-acked on the wire
      // (user:true) so the helm + remote phones stop beeping; never stops the server resend loop and
      // never removes the alarm (only a server alarm.clear does). No-op for unknown ids.
      ackAlarms(ids) {
        (ids || []).forEach(id => { const s = alarmState.get(id); if (s) { s.acked = true; enqueueAck(id, s.gen, s.rev, true); } });
      },
      // Read-only view of the live alarm set (for consumers/tests). Never the source of truth for the banner.
      alarms() { const o = {}; alarmState.forEach((v, id) => { o[id] = { gen: v.gen, rev: v.rev, sev: v.sev, acked: v.acked }; }); return o; },
      // CONTRACT-7: channel subscriptions + client-chosen nav rate (1–4 Hz). Desired state persists
      // across reconnect (re-sent in the hello); a runtime change sends a sub.update and the server
      // echoes the effective config via opts.onSub. Each returns the new DESIRED state; the send is
      // false-tolerant (re-sent on reconnect) so changes converge over a flaky link.
      setRate(hz) { const r = clampRate(hz); if (r != null) { navRate = r; sendSubUpdate(); } return navRate; },
      subscribe(channels) { normChannels(channels).forEach(c => { if (subChannels.indexOf(c) < 0) subChannels.push(c); }); sendSubUpdate(); return subChannels.slice(); },
      unsubscribe(channels) {
        (channels || []).forEach(c => {
          if (c === 'nav') { console.warn('HelmNavClient: "nav" is the safety-core position/instrument stream and cannot be unsubscribed'); return; }
          const i = subChannels.indexOf(c); if (i >= 0) subChannels.splice(i, 1);
        });
        sendSubUpdate(); return subChannels.slice();
      },
      // CONTRACT-8: set/clear the AIS viewport bbox [w,s,e,n] (null clears → all targets). Rapid map-moves
      // are throttled into one sub.update; persists across reconnect (re-sent in the hello). Returns desired bbox.
      setBbox(b) {
        if (b === null) { navBbox = null; if (bboxTimer) { clearTimeout(bboxTimer); bboxTimer = null; } sendSubUpdate({ bbox: null }); return null; }
        const nb = normBbox(b); if (nb === undefined) return navBbox ? navBbox.slice() : null;   // invalid → unchanged (surfaced)
        navBbox = nb;
        if (!bboxTimer) bboxTimer = setTimeout(() => { bboxTimer = null; sendSubUpdate(); }, BBOX_THROTTLE_MS);
        return navBbox.slice();
      },
      subscriptions() { return { desired: { subscribe: subChannels.slice(), rate: navRate, bbox: navBbox ? navBbox.slice() : null }, effective: effSub ? { subscribe: effSub.subscribe.slice(), rate: effSub.rate, bbox: effSub.bbox ? effSub.bbox.slice() : null } : null }; }
    };
  };
})();
