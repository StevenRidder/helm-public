#!/usr/bin/env node
// conn-smoke.js — exercise the helm-server CONNECTIONS command-plane over the nav WebSocket.
//   node engine/conn-smoke.js                 # list connections + print a few nav frames
//   node engine/conn-smoke.js <host> <port>   # upsert a tcp-client to host:port and watch it go live
// Dependency-free (raw WS with masked client frames). Target: ws://127.0.0.1:8080/nav
// (override with HELM_HOST / HELM_PORT). Proves the bidirectional contract native clients inherit.
const http = require('http'), crypto = require('crypto');
const HOST = process.env.HELM_HOST || '127.0.0.1';
const PORT = +(process.env.HELM_PORT || 8080);
const addHost = process.argv[2], addPort = process.argv[3];
const upsert = addHost && addPort ? JSON.stringify({ t: 'conn.upsert', conn: {
  name: `Test ${addHost}:${addPort}`, type: 'tcp-client', address: addHost, port: +addPort,
  dataProtocol: 'nmea0183', enabled: true } }) : null;

function sendText(sock, str) {                       // RFC6455 client frame (must be masked)
  const pl = Buffer.from(str, 'utf8'), len = pl.length, mask = crypto.randomBytes(4);
  let hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = 0x80 | len; }
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  hdr[0] = 0x81;                                      // FIN + text
  const m = Buffer.alloc(len); for (let i = 0; i < len; i++) m[i] = pl[i] ^ mask[i % 4];
  sock.write(Buffer.concat([hdr, mask, m]));
}
const key = crypto.randomBytes(16).toString('base64');
const req = http.request({ host: HOST, port: PORT, path: '/nav', headers: {
  Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
req.on('upgrade', (res, sock, head) => {
  console.log(`handshake OK (HTTP ${res.statusCode}) -> ws://${HOST}:${PORT}/nav`);
  sendText(sock, JSON.stringify({ t: 'conn.list' }));
  if (upsert) setTimeout(() => { console.log(`-> conn.upsert tcp-client ${addHost}:${addPort}`); sendText(sock, upsert); }, 400);
  let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0), navN = 0, done = false;
  const finish = (code, msg) => { if (done) return; done = true; console.log(msg); try { sock.end(); } catch (e) {} process.exit(code); };
  function parse() {
    while (buf.length >= 2) {                         // server->client frames are unmasked
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
      let o; try { o = JSON.parse(p); } catch (e) { continue; }
      if (o.t === 'conn.ack') { console.log('<- conn.ack', JSON.stringify(o)); if (o.ok === false) finish(1, 'FAIL: command rejected'); continue; }
      if (o.t === 'conn.list') { console.log('<- conns:', (o.conns || []).map(c => `${c.name}[${c.status}${c.sentences ? '/' + c.sentences + 'sent' : ''}]`).join(', ') || '(none)'); continue; }
      if (o.pos || o.sources) {
        navN++;
        const conns = (o.conns || []).map(c => `${c.name}:${c.status}${c.sentences ? '/' + c.sentences : ''}${c.error ? '(' + c.error + ')' : ''}`).join(' | ');
        console.log(`nav#${navN} ${o.t} pos=${o.posStr} src.pos=${o.sources && o.sources.pos} ais=${(o.ais || []).length} | conns: ${conns}`);
        const live = (o.conns || []).find(c => c.status === 'connected' && c.sentences > 0);
        if (upsert && live) finish(0, `\nSUCCESS: "${live.name}" connected, ${live.sentences} sentences parsed; pos source=${o.sources && o.sources.pos}, AIS targets=${(o.ais || []).length}`);
        if (!upsert && navN >= 3) finish(0, '\n(listed connections + 3 nav frames; pass <host> <port> to add a live connection)');
      }
    }
  }
  sock.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
  parse();
});
req.on('error', e => { console.log('ERR', e.message); process.exit(1); });
req.end();
setTimeout(() => { console.log('\ntimeout (20s)'); process.exit(2); }, 20000);
