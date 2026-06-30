const http = require('http'), crypto = require('crypto');
const key = crypto.randomBytes(16).toString('base64');
const req = http.request({ host: '127.0.0.1', port: 8081, path: '/', headers: {
  'Connection': 'Upgrade', 'Upgrade': 'websocket',
  'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
req.on('upgrade', (res, socket, head) => {
  console.log('handshake OK (HTTP ' + res.statusCode + ')');
  let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0), msgs = 0;
  function parse() {
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
      let o; try { o = JSON.parse(p); } catch (e) { continue; }
      msgs++;
      console.log(`msg ${msgs}: ${o.posStr} | SOG ${o.sog} COG ${o.cog} Depth ${o.depth} | ETA ${o.active.eta} DTG ${o.active.dtg} XTE ${o.active.xte} | next ${o.active.nextWp}`);
      if (msgs === 1) console.log('RAW:', p);
      if (msgs >= 3) { socket.end(); process.exit(0); }
    }
  }
  socket.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
  parse();
});
req.on('error', e => { console.log('ERR', e.message); process.exit(1); });
req.end();
setTimeout(() => { console.log('timeout'); process.exit(2); }, 7000);
