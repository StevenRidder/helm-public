// mock-engine.js — a dependency-free stand-in for the Helm Engine's NETWORK surface.
//
// It is NOT the real engine (that links OpenCPN's GPL model/ + s57chart — see engine/README.md).
// It speaks the SAME wire contract so the client (web/server-endpoint.js + web/nav-client.js)
// can be built and proven end-to-end WITHOUT the heavy C++ build — and, crucially, so we can
// prove the "behaves the same local or remote" property: it binds 0.0.0.0 on ONE origin, and
// the client reaches it identically whether you address it as localhost or a LAN IP.
//
//   ONE ORIGIN (default 0.0.0.0:8090):
//     WS  /nav                         snapshot + delta @ 2 Hz (each carries live conns[]), seq, ping;
//                                       command-plane in: conn.list / conn.upsert / conn.delete
//                                       → conn.ack + conn.list  (the Connections-UI contract)
//     GET /chart/{z}/{x}/{y}.png       S-52 stand-in tile, immutable cache + ETag
//     GET /health                      liveness/version (unauthenticated)
//     GET /catalog                     chart cells available (stub)
//
//   run:  node engine/mock-engine.js                 # 0.0.0.0:8090
//         HELM_PORT=9000 node engine/mock-engine.js  # custom port
//   then open web/index.html served from anywhere; the client resolves this origin.
const http = require('http'), crypto = require('crypto'), zlib = require('zlib');

const HOST = process.env.HELM_HOST || '0.0.0.0';
const PORT = +(process.env.HELM_PORT || process.argv[2] || 8090);

// ---------- nav sim (Key West approach — mirrors web/nav-source.js geometry) ----------
const R = 3440.065, toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
const ROUTE = [
  { lat: 24.458, lon: -81.808, name: 'WP1 · start' },
  { lat: 24.485, lon: -81.800, name: 'WP2 · sea buoy' },
  { lat: 24.515, lon: -81.793, name: 'WP3 · channel' },
  { lat: 24.540, lon: -81.786, name: 'WP4 · pass' },
  { lat: 24.557, lon: -81.781, name: 'WP5 · marina' }
];
function dist(a, b) {
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function brg(a, b) {
  const y = Math.sin(toR(b.lon - a.lon)) * Math.cos(toR(b.lat));
  const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) - Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(toR(b.lon - a.lon));
  return (toD(Math.atan2(y, x)) + 360) % 360;
}
const interp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
function fmtPos(p) {
  const f = (v, pos, neg) => { const h = v >= 0 ? pos : neg; v = Math.abs(v); const d = Math.floor(v), m = ((v - d) * 60).toFixed(1); return d + '°' + m + '′' + h; };
  return f(p.lat, 'N', 'S') + ' · ' + f(p.lon, 'E', 'W');
}
const fmtNM = nm => (nm < 1 ? Math.round(nm * 100) / 100 : Math.round(nm * 10) / 10) + ' NM';
const legLen = []; let total = 0;
for (let i = 0; i < ROUTE.length - 1; i++) { const L = dist(ROUTE[i], ROUTE[i + 1]); legLen.push(L); total += L; }
let along = 0; const t0 = Date.now();
function navState() {
  const t = Date.now();
  const sog = 5.6 + Math.sin((t - t0) / 9000) * 0.9;
  along += sog / 3600 * 0.5;                         // 2 Hz → half a second of travel per tick
  if (along >= total) along = 0;
  let acc = 0, li = 0;
  while (li < legLen.length - 1 && acc + legLen[li] < along) { acc += legLen[li]; li++; }
  const f = legLen[li] ? (along - acc) / legLen[li] : 0;
  const A = ROUTE[li], B = ROUTE[li + 1], pos = interp(A, B, f);
  const cog = Math.round(brg(A, B)), hdg = (cog + Math.round(Math.sin(t / 7000) * 4) + 360) % 360;
  const dtw = dist(pos, B); let dtg = dtw; for (let k = li + 1; k < legLen.length; k++) dtg += legLen[k];
  const d13 = dist(A, pos) / R, th13 = toR(brg(A, pos)), th12 = toR(brg(A, B));
  const xteM = Math.round(Math.abs(Math.asin(Math.sin(d13) * Math.sin(th13 - th12)) * R) * 1852);
  const etaDate = new Date(t + (dtg / Math.max(0.1, sog)) * 3600 * 1000);
  const eta = etaDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ttgMin = Math.round((dtg / Math.max(0.1, sog)) * 60);
  const ttg = ttgMin < 60 ? ttgMin + 'm' : Math.floor(ttgMin / 60) + 'h ' + String(ttgMin % 60).padStart(2, '0') + 'm';
  const vmg = (sog * Math.cos(toR(brg(pos, B) - cog))).toFixed(1) + ' kn';
  const windSpd = 14 + Math.sin(t / 11000) * 3, windDir = Math.round((95 + Math.sin(t / 13000) * 10 + 360) % 360);
  const depth = 6 + (1 - f) * 8 + Math.sin(t / 5000) * 0.6;
  const legs = [];
  for (let k = li + 1; k < ROUTE.length; k++) { const from = k === li + 1 ? pos : ROUTE[k - 1]; legs.push({ name: ROUTE[k].name, brg: Math.round(brg(from, ROUTE[k])) + '°', active: k === li + 1 }); }
  return {
    pos, posStr: fmtPos(pos), sog, cog, hdg, depth,
    wind: { spd: windSpd, dir: windDir, range: Math.round(windSpd - 4) + '–' + Math.round(windSpd + 8) + ' kt' },
    // mock declares position "nmea" so the UI badges it LIVE — the mock is standing in for a real feed
    sources: { pos: 'nmea', sog: 'nmea', cog: 'nmea', hdg: 'simulated', depth: 'nmea', wind: 'simulated' },
    active: { name: 'Route to Marina', eta, ttg, vmg, dtg: fmtNM(dtg), xte: xteM + ' m', legs, nextWp: ROUTE[li + 1].name.split(' · ')[0] + ' · ' + fmtNM(dtw) }
  };
}

// ---------- connections command-plane (mirrors helm_server.cpp conn.* — for the CONN UI) ----------
// The real engine OWNS + persists ~/.helm/connections.json and streams live per-connection
// status in EVERY nav frame (s.conns). This in-memory stand-in speaks the identical wire shapes
// so web/connections.js can be built + smoke-tested with NO C++ build:
//   conn.list                 -> {t:'conn.list', conns:[ {id,name,type,address,port,enabled,
//                                  status,ageSec,sentences,error?} … ]}
//   conn.upsert {conn:{…}}     -> {t:'conn.ack', ok, id, error?}  then a fresh conn.list
//   conn.delete {id}           -> {t:'conn.ack', ok, id}          then a fresh conn.list
// and it embeds the same `conns` array in every snapshot/delta. Writes honor HELM_OWNER_TOKEN
// if set (matching the engine's owner-token gate).
//
// Accepted types match the engine — tcp-client | tcp-server | udp | signalk. The real
// helm-server now also accepts 'signalk' (CONN-5 / PR #16), so the mock and the engine agree;
// this lets web/connections.js (incl. the SignalK affordance) be built + smoke-tested offline
// with no C++ build. (Earlier the mock ran ahead of the engine — that gap is now closed.)
const OWNER_TOKEN = process.env.HELM_OWNER_TOKEN || '';
const CONN_TYPES = ['tcp-client', 'tcp-server', 'udp', 'signalk', 'serial', 'nmea2000', 'internet-ais'];   // CONN-5/8/9/10 — all accepted by the engine
let connCounter = 0;
const connMap = new Map();   // id -> { cfg, rt:{ status, sentences, lastRx, since } }
function seedConn(cfg) { connMap.set(cfg.id, { cfg, rt: { status: 'connecting', sentences: 0, lastRx: 0, since: Date.now() } }); }
// mirror the engine's seeded default (helm_server.cpp) so the list isn't empty on first load
seedConn({ id: 'local-nmea', name: 'Local NMEA (relay)', type: 'tcp-server', address: '127.0.0.1', port: 10110, enabled: true, dataProtocol: 'nmea0183', comment: '', priority: 0 });

const connSlug = s => { let o = ''; for (const ch of (s || '')) { if (/[a-z0-9]/i.test(ch)) o += ch.toLowerCase(); else if (o && o.slice(-1) !== '-') o += '-'; } return o.replace(/-+$/, '').slice(0, 24); };
function connFromJson(v) {   // mirror conn_from_json validation; → { cfg } or { err }
  const gs = k => (typeof v[k] === 'string' ? v[k] : '');
  const cfg = { id: gs('id'), name: gs('name'), type: gs('type'), address: gs('address'),
    dataProtocol: gs('dataProtocol') || 'nmea0183', comment: gs('comment'),
    port: (typeof v.port === 'number' ? v.port : (parseInt(v.port, 10) || 0)),
    priority: (typeof v.priority === 'number' ? v.priority : (parseInt(v.priority, 10) || 0)),   // CONN-6
    enabled: (typeof v.enabled === 'boolean' ? v.enabled : true) };
  if (!CONN_TYPES.includes(cfg.type)) return { err: 'type must be one of: ' + CONN_TYPES.join(' | ') };
  const urlAddr = /^wss?:\/\//.test(cfg.address);                                              // ws providers carry the port in the URL
  if (!urlAddr && (cfg.port < 1 || cfg.port > 65535)) return { err: 'port must be 1-65535' + (cfg.type === 'serial' ? ' (serial: this is the baud rate)' : '') };
  if (['tcp-client', 'signalk', 'serial', 'nmea2000', 'internet-ais'].includes(cfg.type) && !cfg.address) return { err: 'address required for ' + cfg.type };
  if (!cfg.id) { const b = connSlug(cfg.name || cfg.type) || 'conn'; cfg.id = b + '-' + (++connCounter); }
  return { cfg };
}
function connStatusArray() {
  const now = Math.floor(Date.now() / 1000);
  return [...connMap.values()].map(({ cfg, rt }) => {
    const status = !cfg.enabled ? 'disabled' : rt.status;
    const o = { id: cfg.id, name: cfg.name, type: cfg.type, address: cfg.address, port: cfg.port,
      enabled: cfg.enabled, priority: cfg.priority || 0, status, ageSec: rt.lastRx ? now - rt.lastRx : -1, sentences: rt.sentences };
    if (rt.error) o.error = rt.error;
    return o;
  });
}
// simulate each connection's lifecycle so the UI shows live status: enabled → connecting →
// (after ~1.5 s) connected, then sentence counts tick up and age stays fresh; disabled → disabled.
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const { cfg, rt } of connMap.values()) {
    if (!cfg.enabled) { rt.status = 'disabled'; continue; }
    if (rt.status === 'disabled') { rt.status = 'connecting'; rt.since = Date.now(); }
    if (rt.status === 'connecting' && Date.now() - rt.since > 1500) rt.status = 'connected';
    if (rt.status === 'connected') { rt.sentences += 3 + Math.floor(Math.random() * 4); rt.lastRx = now; }
  }
}, 1000);
// handle one conn.* command from a client; returns true if it was a conn.* verb. `send` is the
// per-client sender. Replies match the engine: conn.ack (+ a fresh conn.list) for writes.
function handleConnCmd(send, m) {
  if (typeof m.t !== 'string' || !m.t.startsWith('conn.')) return false;
  if (OWNER_TOKEN && m.token !== OWNER_TOKEN) { send({ t: 'conn.ack', ok: false, id: '', error: 'unauthorized' }); return true; }
  if (m.t === 'conn.list') { send({ t: 'conn.list', conns: connStatusArray() }); return true; }
  if (m.t === 'conn.upsert' && m.conn && typeof m.conn === 'object') {
    const r = connFromJson(m.conn);
    if (r.err) { send({ t: 'conn.ack', ok: false, id: '', error: r.err }); return true; }
    const prev = connMap.get(r.cfg.id);
    connMap.set(r.cfg.id, { cfg: r.cfg, rt: prev ? prev.rt : { status: 'connecting', sentences: 0, lastRx: 0, since: Date.now() } });
    send({ t: 'conn.ack', ok: true, id: r.cfg.id }); send({ t: 'conn.list', conns: connStatusArray() }); return true;
  }
  if (m.t === 'conn.delete' && typeof m.id === 'string') {
    connMap.delete(m.id); send({ t: 'conn.ack', ok: true, id: m.id }); send({ t: 'conn.list', conns: connStatusArray() }); return true;
  }
  return true;   // a conn.* verb with bad args — swallow, like the engine
}

// CONN-7 raw-NMEA monitor (mock): when a client subscribes via nmea.monitor{on:true}, stream
// synthetic NMEA so the raw-data-monitor UI can be built + smoke-tested offline. Mirrors the engine
// contract: nmea.monitor → {t:'nmea.monitor.ack', on} and {t:'nmea.raw', lines:[{conn,ts,line}]}.
const mockMonitors = new Set();     // per-client send fns currently monitoring
const nmeaCsum = body => { let c = 0; for (const ch of body) c ^= ch.charCodeAt(0); return '$' + body + '*' + c.toString(16).toUpperCase().padStart(2, '0'); };
let rawTick = 0;
setInterval(() => {
  if (!mockMonitors.size) return;
  const ts = Math.floor(Date.now() / 1000); rawTick++;
  const lines = [
    { conn: 'local-nmea', ts, line: nmeaCsum(`GPRMC,${String(120000 + rawTick).slice(-6)},A,2429.10,N,08148.00,W,5.${rawTick % 9},015.0,250625,,`) },
    { conn: 'local-nmea', ts, line: nmeaCsum(`SDDBT,${(20 + rawTick % 5)}.0,f,${(6 + (rawTick % 5) * 0.3).toFixed(1)},M,${(3 + rawTick % 3)}.0,F`) },
  ];
  for (const s of mockMonitors) s({ t: 'nmea.raw', lines });
}, 1000);
function handleMonitor(send, m) {   // nmea.monitor {on:bool} → ack (+ the periodic stream above)
  if (m.on) mockMonitors.add(send); else mockMonitors.delete(send);
  send({ t: 'nmea.monitor.ack', on: !!m.on });
}

// ---------- WebSocket (server-side framing, dependency-free) ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function accept(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }
function frame(str) {                                  // server→client text frame, unmasked
  const p = Buffer.from(str, 'utf8'); let head;
  if (p.length < 126) { head = Buffer.from([0x81, p.length]); }
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([head, p]);
}
function readClientFrames(buf, onText, onClose) {      // minimal masked-frame reader (hello/ack/close)
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask; if (masked) { if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    const data = buf.slice(off, off + len); buf = buf.slice(off + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    if (opcode === 0x8) { onClose && onClose(); break; }       // client close
    if (opcode === 0x1) { try { onText(data.toString('utf8')); } catch (e) {} } // text only (ignore ping/pong/binary)
  }
  return buf;
}

// ---- CONTRACT-10 producer (mock parity): headless anchor-drag alarm over the frozen schema ----
let mockAnchor = null;                                    // { lat, lon, radiusM }
const mockAlarms = {};                                    // id -> { id,kind,sev,msg,gen,rev,active,hasPos,lat,lon,clearedAt }
const ALARM_GEN = Math.floor(Date.now() / 1000);
let dragOver = 0;
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function alarmRaise(id, kind, sev, msg, hasPos, lat, lon) {
  const a = mockAlarms[id];
  if (!a || !a.active) mockAlarms[id] = { id, kind, sev, msg, gen: ALARM_GEN, rev: 1, active: true, hasPos, lat, lon, clearedAt: 0 };
  else { if (a.sev !== sev || a.msg !== msg) { a.sev = sev; a.msg = msg; a.rev++; } a.kind = kind; a.hasPos = hasPos; a.lat = lat; a.lon = lon; }
}
function alarmClearId(id) { const a = mockAlarms[id]; if (a && a.active) { a.active = false; a.rev++; a.clearedAt = Date.now(); } }
function alarmEval() {
  const o = navState().pos;
  if (mockAnchor && o) {
    const dM = haversineM(o.lat, o.lon, mockAnchor.lat, mockAnchor.lon);
    if (dM > mockAnchor.radiusM) { if (dragOver < 1000) dragOver++; } else dragOver = 0;
    if (dragOver >= 4) alarmRaise('anchor', 'anchor', 'critical', 'Anchor dragging — beyond ' + Math.round(mockAnchor.radiusM) + ' m watch circle', true, mockAnchor.lat, mockAnchor.lon);
    else if (dM <= mockAnchor.radiusM) alarmClearId('anchor');
  } else { dragOver = 0; alarmClearId('anchor'); }
  const now = Date.now();
  for (const id of Object.keys(mockAlarms)) { const a = mockAlarms[id]; if (!a.active && now - a.clearedAt > 20000) delete mockAlarms[id]; }
}
function alarmFrame(a) { const f = { t: 'alarm', op: a.rev <= 1 ? 'raise' : 'update', id: a.id, rev: a.rev, gen: a.gen, kind: a.kind, sev: a.sev, msg: a.msg, silenceable: true }; if (a.hasPos) { f.lat = a.lat; f.lon = a.lon; } return f; }
function alarmClearFrame(a) { return { t: 'alarm.clear', id: a.id, gen: a.gen, rev: a.rev, reason: 'resolved' }; }

let clients = 0;
function handleWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n');
  const id = ++clients; let seq = 0, frames = 0; let buf = Buffer.alloc(0);
  console.log('[nav] client #' + id + ' connected (' + req.socket.remoteAddress + ')');

  const send = o => { try { socket.write(frame(JSON.stringify(o))); } catch (e) {} };
  const snapshot = () => send(Object.assign({ t: 'snapshot', seq: ++seq, ts: Date.now() / 1000 }, navState(), { conns: connStatusArray() }));
  snapshot();                                           // full state on connect

  const alarmAcked = {};                                 // CONTRACT-10: alarm id -> "gen.rev" this client transport-ACKed
  const tick = setInterval(() => {
    alarmEval();                                         // CONTRACT-10 producer: anchor-drag watch, resend until ACK
    for (const aid of Object.keys(mockAlarms)) { const a = mockAlarms[aid]; const tok = a.gen + '.' + a.rev;
      if (alarmAcked[aid] === tok) continue; send(a.active ? alarmFrame(a) : alarmClearFrame(a)); }
    const s = navState(); frames++;
    if (frames % 30 === 0) { send(Object.assign({ t: 'snapshot', seq: ++seq, ts: Date.now() / 1000 }, s, { conns: connStatusArray() })); return; } // keyframe
    // delta: only the fields that move each tick (wind every ~5th tick). conns ride every frame, like the engine.
    const d = { t: 'delta', seq: ++seq, ts: Date.now() / 1000, pos: s.pos, posStr: s.posStr, sog: s.sog, cog: s.cog, hdg: s.hdg, depth: s.depth,
      conns: connStatusArray(),
      active: { dtg: s.active.dtg, xte: s.active.xte, eta: s.active.eta, ttg: s.active.ttg, vmg: s.active.vmg, nextWp: s.active.nextWp } };
    if (frames % 5 === 0) d.wind = s.wind;
    send(d);
  }, 500);
  const heart = setInterval(() => send({ t: 'ping', ts: Date.now() / 1000 }), 2000);

  socket.on('data', d => { buf = readClientFrames(Buffer.concat([buf, d]), txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.t === 'hello' || m.t === 'sub.update') {            // CONTRACT-7: ack the subscription with the EFFECTIVE {subscribe, rate}
      const KNOWN = ['nav', 'route', 'alarms', 'ais', 'track', 'conns'];
      const NAV_SOURCE_HZ = 1;                                // mirror helm_server.cpp: never stream faster than the ~1 Hz nav source
      let chans = Array.isArray(m.subscribe) && m.subscribe.length
        ? m.subscribe.filter(c => KNOWN.includes(c)) : KNOWN.slice();   // absent ⇒ all known channels (like the real server)
      if (!chans.includes('nav')) chans.push('nav');         // safety core is never droppable
      chans = [...new Set(chans)].sort();                    // canonical (sorted) order, like the server's std::set
      const reqRate = Math.max(1, Math.min(4, Math.round(+m.rate) || 1));   // clamp the request to the 1–4 Hz band
      const rate = Math.min(reqRate, NAV_SOURCE_HZ);         // effective = min(requested, source Hz) = 1 today
      send({ t: 'sub.ack', subscribe: chans, rate });
      console.log('[nav] #' + id + ' ' + m.t + ' subscribe=' + chans.join(',') + ' rate=' + rate + (m.t === 'hello' ? ' lastSeq=' + m.lastSeq : ''));
      if (m.t === 'hello' && m.lastSeq) snapshot();          // resume hint → re-send a fresh snapshot
    }
    else if (m.t === 'ack') console.log('[nav] #' + id + ' ack ' + m.alarm);   // legacy single-ack log
    else if (m.t === 'alarm.ack' && Array.isArray(m.acks)) { for (const e of m.acks) if (e && e.id) alarmAcked[e.id] = (e.gen | 0) + '.' + (e.rev | 0); }   // CONTRACT-10 transport-ACK
    else if (m.t === 'anchor.set' && typeof m.lat === 'number' && typeof m.lon === 'number') { mockAnchor = { lat: m.lat, lon: m.lon, radiusM: (typeof m.radius === 'number' ? m.radius : 40) }; dragOver = 0; send({ t: 'anchor.ack', set: true }); console.log('[anchor] #' + id + ' set @ ' + m.lat.toFixed(5) + ',' + m.lon.toFixed(5)); }
    else if (m.t === 'anchor.clear') { mockAnchor = null; dragOver = 0; alarmClearId('anchor'); send({ t: 'anchor.ack', set: false }); console.log('[anchor] #' + id + ' cleared'); }
    else if (typeof m.t === 'string' && m.t.indexOf('conn.') === 0) { handleConnCmd(send, m); console.log('[conn] #' + id + ' ' + m.t + (m.conn ? ' (' + (m.conn.type || '?') + ')' : (m.id ? ' ' + m.id : ''))); }
    else if (m.t === 'nmea.monitor') { handleMonitor(send, m); console.log('[conn] #' + id + ' nmea.monitor ' + (m.on ? 'on' : 'off')); }
  }); });
  const done = () => { clearInterval(tick); clearInterval(heart); mockMonitors.delete(send); console.log('[nav] client #' + id + ' gone'); };
  socket.on('close', done); socket.on('error', done);
}

// ---------- a visible S-52 stand-in tile (real engine renders true S-52; this proves transport) ----------
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function png(w, h, r, g, b, a) {
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { let o = y * (1 + w * 4); raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = png(256, 256, 40, 90, 160, 90);           // translucent blue, like a depth area
const TILE_ETAG = '"mock.enc.v1"';

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.url === '/health') { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)); return res.end(JSON.stringify({ status: 'ok', engine: 'mock', clients, ts: Date.now() / 1000 })); }
  if (req.url === '/catalog') { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)); return res.end(JSON.stringify({ cells: [{ id: 'US5FL96M', name: 'Key West', edition: 7, bbox: [-81.85, 24.43, -81.76, 24.57] }] })); }
  if (/^\/chart\/\d+\/\d+\/\d+\.png$/.test(req.url)) {
    if (req.headers['if-none-match'] === TILE_ETAG) { res.writeHead(304, cors); return res.end(); }
    res.writeHead(200, Object.assign({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'ETag': TILE_ETAG }, cors));
    return res.end(TILE);
  }
  res.writeHead(404, cors); res.end('not found');
});
server.on('upgrade', (req, socket) => { if (req.url === '/nav') handleWs(req, socket); else socket.destroy(); });
server.listen(PORT, HOST, () => {
  console.log('Helm mock engine — ONE origin on ' + HOST + ':' + PORT);
  console.log('  ws   /nav                     snapshot+delta @ 2 Hz (+ live conns[]), ping heartbeat');
  console.log('  ws   /nav  command-plane      conn.list / conn.upsert / conn.delete  (types: ' + CONN_TYPES.join(' | ') + ')');
  console.log('                                signalk is accepted by the real engine too (CONN-5)');
  console.log('  GET  /chart/{z}/{x}/{y}.png   immutable tile (ETag ' + TILE_ETAG + ')');
  console.log('  GET  /health  /catalog');
  console.log('Reach it the SAME way local or remote:  http://localhost:' + PORT + '   or   http://<lan-ip>:' + PORT);
});
