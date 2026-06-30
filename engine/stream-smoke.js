// stream-smoke.js — dependency-free end-to-end check of the streaming contract.
// Verifies, against a running mock-engine (or the real engine once it speaks this contract):
//   1. WS /nav sends a `snapshot` first, then `delta` frames, with strictly increasing seq
//   2. the snapshot carries the full UI shape (pos/sog/active…)
//   3. GET /chart/{z}/{x}/{y}.png returns a PNG with immutable caching, and honors If-None-Match (304)
//   4. GET /health is ok
// Usage:  node engine/stream-smoke.js [host] [port]      (default 127.0.0.1 8090)
const http = require('http'), crypto = require('crypto');
const args = process.argv.slice(2).filter(a => a !== '--ws-only');
const WS_ONLY = process.argv.includes('--ws-only');   // nav stream only (e.g. the real engine on 8081; tiles are a separate server)
const HOST = args[0] || '127.0.0.1', PORT = +(args[1] || 8090);
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++; };

function checkWs() {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: HOST, port: PORT, path: '/nav', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    const timer = setTimeout(() => { ok(false, 'WS: timed out waiting for frames'); resolve(); }, 6000);
    req.on('upgrade', (res, socket, head) => {
      ok(res.statusCode === 101, 'WS: handshake (HTTP ' + res.statusCode + ')');
      let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
      const frames = [];
      let subAck = null;                       // CONTRACT-7 sub.ack — captured here, asserted after the framing block
      function parse() {
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
          let o; try { o = JSON.parse(p); } catch (e) { continue; }
          if (o.t === 'ping') continue;                        // heartbeat — not nav state
          if (o.t === 'sub.ack') { subAck = o; continue; }     // CONTRACT-7 control frame — capture for the assertions below, never nav state
          frames.push(o);
          if (frames.filter(f => f.t === 'delta').length >= 3) {
            clearTimeout(timer);
            // CONTRACT-7: the hello/subscribe must be answered with a sub.ack carrying the EFFECTIVE {subscribe, rate}.
            // It races the snapshot on a separate thread, so assert presence (not strict ordering); by 3 deltas it has long arrived.
            ok(subAck && subAck.t === 'sub.ack', 'WS: sub.ack answers the hello (CONTRACT-7 subscription)');
            ok(subAck && Array.isArray(subAck.subscribe) && subAck.subscribe.includes('nav'),
               'WS: sub.ack.subscribe is the effective channel set, always incl nav' + (subAck ? ' (' + JSON.stringify(subAck.subscribe) + ')' : ''));
            ok(subAck && Number.isInteger(subAck.rate) && subAck.rate >= 1 && subAck.rate <= 4,
               'WS: sub.ack.rate is an integer in the negotiated 1–4 Hz band' + (subAck && Number.isInteger(subAck.rate) ? ' (' + subAck.rate + ')' : ''));
            const snap = frames[0];
            ok(snap && snap.t === 'snapshot', 'WS: first frame is a snapshot');
            ok(snap && snap.pos && typeof snap.sog === 'number' && snap.active, 'WS: snapshot has full UI shape (pos/sog/active)');
            const seqs = frames.map(f => f.seq);
            ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'WS: seq strictly increasing (' + seqs.slice(0, 6).join(',') + '…)');
            ok(frames.some(f => f.t === 'delta'), 'WS: receives delta frames');
            socket.end(); resolve();
            return;
          }
        }
      }
      // send a hello like a real client
      const h = Buffer.from(JSON.stringify({ t: 'hello', lastSeq: 0, subscribe: ['nav'] }), 'utf8');
      const mask = crypto.randomBytes(4); const masked = Buffer.from(h); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | h.length]), mask, masked]));
      socket.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
      parse();
    });
    req.on('error', e => { clearTimeout(timer); ok(false, 'WS: ' + e.message); resolve(); });
    req.end();
  });
}

function get(path, headers) {
  return new Promise(resolve => {
    const req = http.request({ host: HOST, port: PORT, path, headers: headers || {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', e => resolve({ status: 0, error: e.message })); req.end();
  });
}

(async () => {
  console.log('stream-smoke → ' + HOST + ':' + PORT + (WS_ONLY ? '  (ws-only)' : ''));
  await checkWs();
  if (WS_ONLY) { console.log(failures ? '\nFAILED (' + failures + ')' : '\nALL PASS (ws-only)'); process.exit(failures ? 1 : 0); }
  const health = await get('/health');
  ok(health.status === 200, 'GET /health → 200');
  const tile = await get('/chart/13/2280/3629.png');
  ok(tile.status === 200 && /image\/png/.test(tile.headers['content-type'] || ''), 'GET /chart tile → 200 image/png');
  ok(/immutable/.test(tile.headers['cache-control'] || ''), 'tile: Cache-Control immutable');
  const etag = tile.headers && tile.headers.etag;
  ok(!!etag, 'tile: has ETag (' + etag + ')');
  if (etag) { const again = await get('/chart/13/2280/3629.png', { 'If-None-Match': etag }); ok(again.status === 304, 'tile: If-None-Match → 304 (cache works)'); }
  console.log(failures ? '\nFAILED (' + failures + ')' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
