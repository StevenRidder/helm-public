#!/usr/bin/env node
// contract-channels-server-smoke.js — CONTRACT-7 SERVER end-to-end check against a running
// helm-server (one-origin). Proves the server honors the frozen channels/rate contract: it filters
// frame content to a client's subscription, paces nav to the effective rate, replies sub.ack, and
// re-negotiates via sub.update — while a no-hello client still gets ALL channels (back-compat).
//
//   node engine/contract-channels-server-smoke.js              # default 127.0.0.1:8099
//   HELM_HOST=… HELM_PORT=… node engine/contract-channels-server-smoke.js
//
// Dependency-free (raw masked WS client frames), same style as conn-smoke.js. Needs a running
// helm-server with the CONTRACT-7 server changes. See docs/CONTRACT-CHANNELS.md.
const http = require('http'), crypto = require('crypto');
const HOST = process.env.HELM_HOST || '127.0.0.1';
const PORT = +(process.env.HELM_PORT || 8099);

function sendText(sock, str) {
  const pl = Buffer.from(str, 'utf8'), len = pl.length, mask = crypto.randomBytes(4); let hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = 0x80 | len; }
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  hdr[0] = 0x81; const m = Buffer.alloc(len); for (let i = 0; i < len; i++) m[i] = pl[i] ^ mask[i % 4];
  sock.write(Buffer.concat([hdr, mask, m]));
}
// Open a /nav WS; deliver each parsed server frame to onFrame(obj, sock). Returns nothing.
function open(hello, onFrame, onErr) {
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({ host: HOST, port: PORT, path: '/nav', headers: {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
  req.on('upgrade', (res, sock, head) => {
    if (hello) sendText(sock, JSON.stringify(hello));
    let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
    (function parse() {
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
        let o; try { o = JSON.parse(p); } catch (e) { continue; }
        onFrame(o, sock);
      }
    });
    sock.on('data', d => { buf = Buffer.concat([buf, d]); // re-enter parser
      (function parse() { while (buf.length >= 2) { let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
        let o; try { o = JSON.parse(p); } catch (e) { continue; } onFrame(o, sock); } })();
    });
  });
  req.on('error', e => onErr(e));
  req.end();
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.error('  ✗ FAIL: ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNav = o => o.t === 'snapshot' || o.t === 'delta';

async function run() {
  // ---- Client A: subset subscriber {nav, alarms} at requested rate 4 ----
  const a = { acks: [], navs: [] }; let aSock = null;
  open({ t: 'hello', subscribe: ['nav', 'alarms'], rate: 4 }, (o, sock) => {
    aSock = sock; if (o.t === 'sub.ack') a.acks.push(o); else if (isNav(o)) a.navs.push(o);
  }, e => { console.error('A err', e.message); process.exit(1); });
  await sleep(2600);
  ok(a.acks.length >= 1, 'A: server replied sub.ack');
  ok(a.acks[0] && a.acks[0].subscribe.indexOf('nav') >= 0 && a.acks[0].subscribe.indexOf('alarms') >= 0 && a.acks[0].subscribe.indexOf('ais') < 0, 'A: sub.ack echoes the {nav,alarms} subset (no ais)');
  ok(a.acks[0] && a.acks[0].rate === 1, 'A: effective rate clamped to 1 (the ~1Hz source), not the requested 4');
  ok(a.navs.length >= 2, 'A: received nav frames');
  const fa = a.navs[a.navs.length - 1];
  ok(fa.pos && typeof fa.sog !== 'undefined', 'A: nav-core (pos/sog) present');
  ok(['ais', 'conns', 'route', 'track', 'trackAdd'].every(k => typeof fa[k] === 'undefined'), 'A: ais/conns/route/track FILTERED OUT for a {nav,alarms} subscriber');

  // ---- A re-negotiates: sub.update {nav, ais} ----
  a.navs.length = 0; sendText(aSock, JSON.stringify({ t: 'sub.update', subscribe: ['nav', 'ais'] }));
  await sleep(2600);
  const fa2 = a.navs[a.navs.length - 1];
  ok(fa2 && typeof fa2.ais !== 'undefined', 'A: after sub.update[nav,ais], ais is NOW delivered');
  ok(fa2 && typeof fa2.conns === 'undefined', 'A: ...and conns stays filtered out');
  try { aSock.end(); } catch (e) {}

  // ---- Client B: no hello → default ALL channels (back-compat) ----
  const b = { navs: [] }; let bSock = null;
  open(null, (o, sock) => { bSock = sock; if (isNav(o)) b.navs.push(o); }, e => { console.error('B err', e.message); process.exit(1); });
  await sleep(2600);
  const fb = b.navs[b.navs.length - 1];
  ok(fb && typeof fb.ais !== 'undefined' && typeof fb.conns !== 'undefined' && typeof fb.route !== 'undefined', 'B: a no-hello client defaults to ALL channels (ais+conns+route present)');
  try { bSock.end(); } catch (e) {}

  // ---- Client C: bbox-culled AIS (CONTRACT-8) — a far bbox yields zero targets; widening streams them ----
  const c = { navs: [] }; let cSock = null;
  open({ t: 'hello', subscribe: ['nav', 'ais'], bbox: [0, 0, 1, 1] }, (o, sock) => { cSock = sock; if (isNav(o)) c.navs.push(o); }, e => { console.error('C err', e.message); process.exit(1); });
  await sleep(2400);
  const fc = c.navs[c.navs.length - 1];
  ok(fc && Array.isArray(fc.ais) && fc.ais.length === 0, 'C: a bbox far from any target yields an EMPTY ais array (culled)');
  c.navs.length = 0; sendText(cSock, JSON.stringify({ t: 'sub.update', subscribe: ['nav', 'ais'], bbox: [170, -20, 179, -15] }));
  await sleep(2400);
  const fc2 = c.navs[c.navs.length - 1];
  ok(fc2 && Array.isArray(fc2.ais) && fc2.ais.length > 0, 'C: widening the bbox to cover the live targets streams them again');
  ok(fc2 && fc2.ais.every(t => t.lon >= 170 && t.lon <= 179 && t.lat >= -20 && t.lat <= -15), 'C: every streamed target is inside the bbox');
  try { cSock.end(); } catch (e) {}

  console.log('\n' + (fail ? '❌ ' : '✅ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
run();
setTimeout(() => { console.log('timeout (30s)'); process.exit(2); }, 30000);
