// sw.js - Helm offline app-shell cache (CLIENT-11/12).
//
// This is deliberately small and dependency-free. It gives an already-loaded
// Helm client a reloadable shell, local glyphs/style assets, and same-origin
// chart/sat tile reuse during a LAN/server blip. It does NOT cache live nav,
// alarm, health, AIS, route, tide, or query endpoints; those must fail loud so
// the UI can keep showing honest LIVE/STALE/OFFLINE state.

const CACHE_VERSION = 'client12-v1';
const SHELL_CACHE = 'helm-shell-' + CACHE_VERSION;
const TILE_CACHE = 'helm-tiles-' + CACHE_VERSION;
const RUNTIME_CACHE = 'helm-runtime-' + CACHE_VERSION;
const MAX_TILE_ENTRIES = 1800;
const MAX_RUNTIME_ENTRIES = 350;

const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/helm-180.png',
  './icons/helm-192.png',
  './icons/helm-512.png',
  './vendor/maplibre-gl/maplibre-gl.css',
  './vendor/maplibre-gl/maplibre-gl.js',
  './vendor/pmtiles.js',
  './vendor/maplibre-cog-protocol.js',
  './vendor/maplibre-contour.js',
  './vendor/terra-draw.js',
  './vendor/terra-draw-maplibre-gl-adapter.js',
  './vendor/maplibre-gl-measures.js',
  './vendor/maplibre-gl-temporal-control.js',
  './vendor/deck.js',
  './integrations/_maplibre-shim.js',
  './integrations/ais-deck.js',
  './integrations/cog.js',
  './integrations/contour.js',
  './integrations/draw.js',
  './integrations/lab.js',
  './integrations/measures.js',
  './integrations/mercator.js',
  './integrations/pmtiles.js',
  './integrations/temporal.js',
  './shell.js',
  './persist.js',
  './board.js',
  './offline-packs.js',
  './tooltip.js',
  './wind-layer.js',
  './wx-ramp.js',
  './radar.js',
  './isobars.js',
  './wx-value-codec.js',
  './wx-grib.js',
  './wx-grib2.js',
  './wx-import.js',
  './wx-live.js',
  './wx-controls.js',
  './wx-scrim.js',
  './nav-source.js',
  './server-endpoint.js',
  './log.js',
  './nav-client.js',
  './health-panel.js',
  './connections.js',
  './routes.js',
  './route-edit.js',
  './track.js',
  './ownship.js',
  './alarms.js',
  './community.js',
  './measure.js',
  './offline.js',
  './ais-risk.js',
  './ais-hub.js',
  './collision.js',
  './ais-meta.js',
  './ais-vectors.js',
  './ais-guard.js',
  './ais-distress.js',
  './ais-tracks.js',
  './ais-pins.js',
  './tides.js',
  './ui-text.js',
  './ais-advisor.js',
  './ais-sector.js',
  './ais-select.js',
  './ais-buddy.js',
  './true-wind.js',
  './true-wind-ui.js',
  './tactics.js',
  './style.json',
  './style/manifest.json',
  './style/helm-base.json',
  './style/helm-chart-basemaps.json',
  './style/helm-chart-depth.json',
  './style/helm-route-line.json',
  './style/helm-wx-wind.json',
  './style/helm-place-poi.json',
  './style/helm-place-saved.json',
  './style/helm-place-whereto.json',
  './style/helm-ais-targets.json',
  './data/depare.geojson',
  './data/depcnt.geojson',
  './data/soundg.geojson',
  './data/wind_points.geojson',
  './data/places.geojson',
  './data/ais-sample.geojson',
  './data/saved-sample.geojson',
  './data/whereto-empty.geojson',
  './fonts/Noto Sans Regular/0-255.pbf',
  './fonts/Noto Sans Regular/256-511.pbf',
  './fonts/Noto Sans Regular/512-767.pbf',
  './fonts/Noto Sans Regular/8192-8447.pbf',
];

const NETWORK_ONLY_PREFIXES = [
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
  '/context',
  '/briefing',
  '/whereto',
  '/places',
  '/saved',
  '/community',
  '/connections',
  '/api',
  '/wx',
  '/weather',
  '/bundle',
  '/prefetch',
  '/layers',
];

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function isCacheable(response) {
  return response && response.ok && response.type !== 'error';
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isNetworkOnly(url) {
  return NETWORK_ONLY_PREFIXES.some(prefix => matchesPrefix(url.pathname, prefix));
}

function isTileRequest(url) {
  const path = url.pathname;
  if (matchesPrefix(path, '/chart')) return true;
  if (matchesPrefix(path, '/tiles')) return true;
  if (matchesPrefix(path, '/data/sat')) return true;
  if (matchesPrefix(path, '/data/dem')) return true;
  if (matchesPrefix(path, '/data/relief')) return true;
  if (matchesPrefix(path, '/data/radar')) return true;
  return /\/\d+\/\d+\/\d+\.(?:png|jpe?g|webp|pbf|mvt)$/i.test(path);
}

function isGlyphOrSpriteRequest(url) {
  const path = url.pathname;
  return matchesPrefix(path, '/fonts') || /\/sprite(?:@2x)?\.(?:json|png)$/i.test(path);
}

function isShellAsset(url) {
  if (isNetworkOnly(url)) return false;
  return /\.(?:html|js|css|json|webmanifest|geojson|pbf|png|svg|ico|wasm)$/i.test(url.pathname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
}

async function precacheShell() {
  await Promise.all([caches.open(TILE_CACHE), caches.open(RUNTIME_CACHE)]);
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(APP_SHELL_URLS.map(async path => {
    const request = new Request(scopeUrl(path), { cache: 'reload' });
    try {
      const response = await fetch(request);
      if (isCacheable(response)) await cache.put(request, response);
    } catch (err) {
      console.warn('[helm-sw] skipped precache asset:', path, err && err.message);
    }
  }));
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(scopeUrl('./index.html'), response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(scopeUrl('./index.html')) || await caches.match(scopeUrl('./'));
    if (cached) return cached;
    return new Response('Helm is offline and the app shell is not cached yet.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    trimCache(cacheName, maxEntries).catch(err => {
      console.warn('[helm-sw] cache trim failed:', err && err.message);
    });
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(response => {
    if (isCacheable(response)) {
      cache.put(request, response.clone());
      trimCache(cacheName, maxEntries).catch(err => {
        console.warn('[helm-sw] cache trim failed:', err && err.message);
      });
    }
    return response;
  }).catch(err => {
    if (!cached) throw err;
    console.warn('[helm-sw] refresh failed, serving cached asset:', request.url, err && err.message);
    return cached;
  });
  return cached || refresh;
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, TILE_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('helm-') && !keep.has(name)).map(name => caches.delete(name)));
    await Promise.all([caches.open(TILE_CACHE), caches.open(RUNTIME_CACHE)]);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'HELM_SW_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.get('upgrade') === 'websocket') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!/^https?:$/.test(url.protocol)) return;
  if (isNetworkOnly(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isGlyphOrSpriteRequest(url) || isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, MAX_TILE_ENTRIES));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
  }
});
