'use strict';
// xss.test.cjs — CLIENT-18 innerHTML/XSS hardening. Extracts the canonical escHtml() from index.html
// and proves it neutralises payloads + is null-safe, then asserts each untrusted popup sink actually
// routes through escHtml()/safeUrl() (a regression guard — removing the escaping turns these RED).
// Run: node web/test/xss.test.cjs
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const line = src.split('\n').find((l) => l.includes('const escHtml ='));
if (!line) { console.error('escHtml not found in index.html'); process.exit(1); }
const expr = line.slice(line.indexOf('=') + 1).trim().replace(/;\s*$/, '');
const escHtml = new Function('return (' + expr + ')')();   // the real escaper, lifted from the page

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };
const has = (s) => src.includes(s);

// escaper correctness
ok(escHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', '1. escapes < and >');
ok(escHtml('a & "b"') === 'a &amp; &quot;b&quot;', '2. escapes & and "');
ok(escHtml(null) === '' && escHtml(undefined) === '', '3. null/undefined -> "" (null-safe)');
ok(!/<script>/.test(escHtml('<script>x</script>')), '4. neutralises a <script> payload');

// application at each untrusted sink (regression guards)
ok(has('escHtml(p.name || p.kind)'), '5. places popup escapes the OSM place name');
ok(has('escHtml(p.note || p.kind)'), '6. saved-place popup escapes the user note');
ok(has("escHtml(p.name || '')"), '7. recommender popup escapes the name');
ok(has('safeUrl(p.sourceUrl)') && has('rel="noopener noreferrer"'), '8. saved sourceUrl -> safeUrl (no javascript:) + rel=noopener');
ok(has('aisEsc(name)'), '9. AIS card still escapes the (open-radio) vessel name');

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'xss: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
