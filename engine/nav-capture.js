// nav-capture.js — dependency-free nav-frame capture for tests.
// Connects to the engine's nav WebSocket, prints each received frame as one JSON
// line on stdout (snapshot/delta), then exits. Pings are skipped.
//
// Usage:  node engine/nav-capture.js [host] [port] [nframes] [path]
//   defaults: 127.0.0.1 8081 1 /        (helm-engine speaks at "/"; helm-server at "/nav")
const http = require('http'), crypto = require('crypto');
const host = process.argv[2] || '127.0.0.1';
const port = +(process.argv[3] || 8081);
const N    = +(process.argv[4] || 1);
const path = process.argv[5] || '/';

const key = crypto.randomBytes(16).toString('base64');
const req = http.request({ host, port, path, headers: {
  Connection: 'Upgrade', Upgrade: 'websocket',
  'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });

let got = 0;
req.on('upgrade', (res, socket, head) => {
  if (res.statusCode !== 101) { console.error('handshake HTTP ' + res.statusCode); process.exit(1); }
  let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  function parse() {
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
      let o; try { o = JSON.parse(p); } catch (e) { continue; }
      if (o.t === 'ping') continue;
      console.log(p);
      if (++got >= N) { socket.end(); process.exit(0); }
    }
  }
  // send a hello like a real client (harmless if the server ignores it)
  const h = Buffer.from(JSON.stringify({ t: 'hello', lastSeq: 0, subscribe: ['nav'] }), 'utf8');
  const mask = crypto.randomBytes(4); const m = Buffer.from(h);
  for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | h.length]), mask, m]));
  socket.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
  parse();
});
req.on('error', e => { console.error('ERR ' + e.message); process.exit(1); });
req.end();
setTimeout(() => { console.error('timeout'); process.exit(2); }, 8000);
