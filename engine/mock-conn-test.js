// mock-conn-test.js — proves engine/mock-engine.js speaks the conn.* command-plane that
// web/connections.js (the CONN epic's Connections UI) consumes, so the UI can be built and
// smoke-tested with NO C++ build. Drives the full round-trip and asserts the wire contract:
//
//   • the snapshot (and every nav frame) carries conns[] incl the seeded local-nmea
//   • conn.list            → {t:'conn.list', conns:[…]}
//   • conn.upsert signalk  → {t:'conn.ack', ok:true, id}  (CONN-5 build-ahead — see mock-engine.js)
//   • invalid type         → {t:'conn.ack', ok:false, error:'type must be …'}
//   • conn.delete          → ack ok, then gone from conn.list
//   • the per-connection lifecycle (connecting → connected, sentences ticking) rides nav frames
//
// Usage:  HELM_PORT=8076 node engine/mock-engine.js &   then   node engine/mock-conn-test.js 8076
const http = require('http'), crypto = require('crypto');
const PORT = +(process.argv[2] || process.env.HELM_PORT || 8090);
let pass = 0, fail = 0; const P = m => { console.log('  PASS ' + m); pass++; }; const F = m => { console.log('  FAIL ' + m); fail++; };
let sock, buf = Buffer.alloc(0), step = 0, sigId = null, frames = [];
function sendMasked(obj) {
  const p = Buffer.from(JSON.stringify(obj)); const mask = crypto.randomBytes(4); const m = Buffer.from(p);
  for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  let head; if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  sock.write(Buffer.concat([head, mask, m]));
}
function onMsg(o) {
  frames.push(o);
  if (o.t === 'snapshot' && step === 0) {
    step = 1; const c = (o.conns || []).find(x => x.id === 'local-nmea');
    c ? P('snapshot carries conns[] incl seeded local-nmea (' + c.status + ')') : F('snapshot missing seeded conn / conns[]');
    sendMasked({ t: 'conn.list' });
  } else if (o.t === 'conn.list' && step === 1) {
    step = 2; Array.isArray(o.conns) ? P('conn.list → {conns:[…]} (' + o.conns.length + ')') : F('conn.list malformed');
    sendMasked({ t: 'conn.upsert', conn: { name: 'Pi SignalK', type: 'signalk', address: 'pi.local', port: 3000 } });
  } else if (o.t === 'conn.ack' && step === 2) {
    step = 3; o.ok ? P('conn.upsert signalk → conn.ack ok (id=' + o.id + ')  [CONN-5 build-ahead]') : F('mock rejected signalk: ' + o.error); sigId = o.id;
  } else if (o.t === 'conn.list' && step === 3) {
    step = 4; const sk = (o.conns || []).find(x => x.id === sigId);
    (sk && sk.type === 'signalk') ? P('signalk connection now in conn.list') : F('signalk missing from list');
    sendMasked({ t: 'conn.upsert', conn: { name: 'Bad', type: 'bogus', port: 1 } });
  } else if (o.t === 'conn.ack' && step === 4) {
    step = 5; (!o.ok && /type must be/.test(o.error || '')) ? P('invalid type → conn.ack ok:false + validation error') : F('invalid type not rejected');
    sendMasked({ t: 'conn.delete', id: sigId });
  } else if (o.t === 'conn.ack' && step === 5) {
    step = 6; o.ok ? P('conn.delete → conn.ack ok') : F('delete failed');
  } else if (o.t === 'conn.list' && step === 6) {
    step = 7; const gone = !(o.conns || []).some(x => x.id === sigId);
    gone ? P('deleted connection gone from conn.list') : F('still present after delete');
    setTimeout(() => {
      const last = frames.filter(f => f.conns).pop(); const c = (last.conns || []).find(x => x.id === 'local-nmea');
      (c && c.status === 'connected' && c.sentences > 0) ? P('live status rides nav frames: local-nmea connected, sentences=' + c.sentences) : F('seeded conn never went live (' + (c ? c.status : '?') + ')');
      console.log(fail ? '\n  FAILED (' + fail + ')' : '\n  ALL PASS'); process.exit(fail ? 1 : 0);
    }, 2500);
  }
}
const key = crypto.randomBytes(16).toString('base64');
const req = http.request({ host: '127.0.0.1', port: PORT, path: '/nav', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
req.on('upgrade', (res, socket, head) => {
  sock = socket; buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  function parse() { while (buf.length >= 2) { let len = buf[1] & 0x7f, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + len) return; const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len); let o; try { o = JSON.parse(p); } catch (e) { continue; } if (o.t === 'ping') continue; onMsg(o); } }
  socket.on('data', d => { buf = Buffer.concat([buf, d]); parse(); }); parse();
});
req.on('error', e => { console.log('  ERR ' + e.message + ' (is the mock running on :' + PORT + '?)'); process.exit(2); }); req.end();
setTimeout(() => { console.log('  timeout at step ' + step); process.exit(3); }, 12000);
