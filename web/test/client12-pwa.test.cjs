#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const web = path.join(repo, 'web');
const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const manifestText = fs.readFileSync(path.join(web, 'manifest.webmanifest'), 'utf8');
const manifest = JSON.parse(manifestText);
const sw = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
const docs = fs.readFileSync(path.join(repo, 'docs', 'PWA.md'), 'utf8');

function expectContains(haystack, needle, label = needle) {
  assert.ok(haystack.includes(needle), `missing ${label}`);
}

expectContains(index, 'viewport-fit=cover', 'safe-area viewport hint');
expectContains(index, '<link rel="manifest" href="manifest.webmanifest">', 'manifest link');
expectContains(index, '<meta name="theme-color" content="#05080c">', 'theme color');
expectContains(index, '<meta name="mobile-web-app-capable" content="yes">', 'mobile standalone metadata');
expectContains(index, '<meta name="apple-mobile-web-app-capable" content="yes">', 'iOS standalone metadata');
expectContains(index, '<link rel="apple-touch-icon" sizes="180x180" href="icons/helm-180.png">', 'iOS touch icon');

assert.equal(manifest.name, 'Helm');
assert.equal(manifest.short_name, 'Helm');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.background_color, '#05080c');
assert.equal(manifest.theme_color, '#05080c');
assert.ok(Array.isArray(manifest.icons), 'manifest icons must be an array');
assert.ok(manifest.icons.some(icon => icon.src === 'icons/helm-192.png' && icon.sizes === '192x192'), 'missing 192 icon');
assert.ok(manifest.icons.some(icon => icon.src === 'icons/helm-512.png' && icon.sizes === '512x512' && icon.purpose === 'any'), 'missing 512 icon');
assert.ok(manifest.icons.some(icon => icon.src === 'icons/helm-512.png' && icon.purpose === 'maskable'), 'missing maskable icon');

for (const asset of [
  './manifest.webmanifest',
  './icons/helm-180.png',
  './icons/helm-192.png',
  './icons/helm-512.png',
]) {
  expectContains(sw, `'${asset}'`, `precache asset ${asset}`);
}
expectContains(sw, 'client12-v1', 'CLIENT-12 cache version');
expectContains(sw, 'webmanifest', 'runtime manifest caching');

for (const iconPath of ['helm-180.png', 'helm-192.png', 'helm-512.png']) {
  assert.ok(fs.statSync(path.join(web, 'icons', iconPath)).size > 0, `${iconPath} must exist`);
}

expectContains(docs, 'iOS/iPadOS PWA storage', 'iOS storage caveat');
assert.match(docs, /evict cached web\s+data/, 'eviction warning');
expectContains(docs, 'stale/offline/out-of-coverage', 'honest offline states');

console.log('client12-pwa ok');
