#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const web = path.join(repo, 'web');
const swPath = path.join(web, 'sw.js');
const indexPath = path.join(web, 'index.html');
const sw = fs.readFileSync(swPath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');

function expectContains(haystack, needle, label = needle) {
  assert.ok(haystack.includes(needle), `missing ${label}`);
}

expectContains(index, 'navigator.serviceWorker.register', 'service worker registration');
expectContains(index, "new URL('sw.js', location.href).href", 'relative sw.js registration URL');
expectContains(index, "{ scope: './' }", 'relative registration scope');

expectContains(sw, "const SHELL_CACHE = 'helm-shell-' + CACHE_VERSION", 'versioned shell cache');
expectContains(sw, "const TILE_CACHE = 'helm-tiles-' + CACHE_VERSION", 'versioned tile cache');
expectContains(sw, "self.addEventListener('install'", 'install handler');
expectContains(sw, "self.addEventListener('fetch'", 'fetch handler');
expectContains(sw, 'networkFirstNavigation', 'navigation fallback handler');
expectContains(sw, 'cacheFirst(request, TILE_CACHE', 'cache-first tile/glyph strategy');
expectContains(sw, 'staleWhileRevalidate(request, RUNTIME_CACHE', 'runtime shell strategy');
expectContains(sw, 'caches.open(TILE_CACHE), caches.open(RUNTIME_CACHE)', 'install creates runtime cache buckets');
expectContains(sw, 'refresh failed, serving cached asset', 'offline revalidate catch');

for (const asset of [
  './index.html',
  './manifest.webmanifest',
  './icons/helm-180.png',
  './icons/helm-192.png',
  './icons/helm-512.png',
  './vendor/maplibre-gl/maplibre-gl.css',
  './vendor/maplibre-gl/maplibre-gl.js',
  './style/manifest.json',
  './style/helm-base.json',
  './data/depare.geojson',
  './data/soundg.geojson',
  './fonts/Noto Sans Regular/0-255.pbf',
]) {
  expectContains(sw, `'${asset}'`, `precache asset ${asset}`);
}

expectContains(sw, 'client12-v1', 'CLIENT-12 cache version');
expectContains(sw, 'webmanifest', 'manifest runtime cache extension');

for (const prefix of [
  '/health',
  '/nav',
  '/ais',
  '/alarm',
  '/alarms',
  '/route',
  '/routes',
  '/tides',
  '/query',
  '/catalog',
  '/api',
  '/wx',
  '/weather',
]) {
  expectContains(sw, `'${prefix}'`, `network-only prefix ${prefix}`);
}

for (const tilePath of ['/chart', '/data/sat', '/data/dem', '/data/relief', '/data/radar']) {
  expectContains(sw, `matchesPrefix(path, '${tilePath}')`, `tile cache path ${tilePath}`);
}

assert.ok(!/NETWORK_ONLY_PREFIXES[\s\S]*'\/routes\.js'/.test(sw), 'routes.js must remain cacheable as app shell');
assert.ok(!/NETWORK_ONLY_PREFIXES[\s\S]*'\/alarms\.js'/.test(sw), 'alarms.js must remain cacheable as app shell');

console.log('client11-service-worker ok');
