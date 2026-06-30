// alarm-producer-smoke.js — dependency-free check of the CONTRACT-10 engine PRODUCER half:
// the alarm reliability transport over the frozen wire schema (docs/CONTRACT-ALARM-SCHEMA.md).
// Spawns mock-engine.js (the offline reference producer) and proves the full loop:
//   set anchor → engine RAISES anchor-drag → RESENDS until ACK → transport-ACK STOPS resend → weigh → CLEAR.
// The real helm-server implements the identical wire shape (engine/test-engine.sh / a live run covers it).
const http = require('http'), crypto = require('crypto'), { spawn } = require('child_process'), path = require('path');
const PORT = +process.argv[2] || 8612;
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

function wsSend(s, o) { const p = Buffer.from(JSON.stringify(o)), m = crypto.randomBytes(4), x = Buffer.from(p);
  for (let i = 0; i < x.length; i++) x[i] ^= m[i & 3];
  const h = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 0xff]);
  s.write(Buffer.concat([h, m, x])); }
function deframe(buf, cb) { let o = 0; while (buf.length - o >= 2) { let l = buf[o + 1] & 0x7f, off = o + 2;
  if (l === 126) { if (buf.length - o < 4) break; l = buf.readUInt16BE(o + 2); off = o + 4; }
  else if (l === 127) { if (buf.length - o < 10) break; l = Number(buf.readBigUInt64BE(o + 2)); off = o + 10; }
  if (buf.length < off + l) break; try { cb(JSON.parse(buf.slice(off, off + l).toString())); } catch (e) {} o = off + l; } return buf.slice(o); }

const mock = spawn('node', [path.join(__dirname, 'mock-engine.js')], { env: { ...process.env, HELM_PORT: String(PORT) }, stdio: 'ignore' });
const done = code => { try { mock.kill(); } catch (e) {} process.exit(code); };

setTimeout(() => {
  const k = crypto.randomBytes(16).toString('base64');
  const r = http.request({ host: '127.0.0.1', port: PORT, path: '/nav', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': k, 'Sec-WebSocket-Version': '13' } });
  let buf = Buffer.alloc(0), s, own = null, alarms = [];
  r.on('upgrade', (_, sk) => { s = sk; s.on('data', d => { buf = deframe(Buffer.concat([buf, d]), f => {
    if (f.t === 'snapshot' && !own && f.pos) { own = f.pos; wsSend(s, { t: 'anchor.set', lat: own.lat + 0.01, lon: own.lon, radius: 40 }); }
    if (f.t === 'alarm' || f.t === 'alarm.clear') alarms.push({ ...f, _at: Date.now() });
  }); }); wsSend(s, { t: 'hello', subscribe: ['nav', 'alarms'], lastSeq: 0 }); });
  r.end();

  setTimeout(() => {
    const raise = alarms.find(a => a.t === 'alarm' && a.id === 'anchor');
    ok(raise && raise.op === 'raise' && raise.kind === 'anchor' && raise.sev === 'critical' && raise.rev >= 1 && Number.isInteger(raise.gen),
       'engine RAISES a conformant anchor alarm (op=raise kind=anchor sev=critical id/gen/rev)');
    ok(raise && typeof raise.lat === 'number' && typeof raise.lon === 'number', 'raise carries a representative position (chart mark)');
    ok(alarms.filter(a => a.t === 'alarm' && a.id === 'anchor' && Date.now() - a._at < 2500).length >= 2,
       'RESEND-until-ACK: an un-acked alarm is re-sent (not one-shot)');
    if (raise) wsSend(s, { t: 'alarm.ack', acks: [{ id: 'anchor', gen: raise.gen, rev: raise.rev }] });
    const mark = alarms.filter(a => a.t === 'alarm').length;
    setTimeout(() => {
      ok(alarms.filter(a => a.t === 'alarm').length - mark === 0, 'transport-ACK STOPS the resend (loop converges)');
      wsSend(s, { t: 'anchor.clear' });
      setTimeout(() => {
        ok(alarms.some(a => a.t === 'alarm.clear' && a.id === 'anchor'), 'weigh anchor → engine emits alarm.clear');
        console.log(fails ? '\nFAILED (' + fails + ')' : '\nALL PASS'); done(fails ? 1 : 0);
      }, 2000);
    }, 2500);
  }, 6000);
}, 900);
setTimeout(() => { console.log('  FAIL timeout'); done(1); }, 20000);
