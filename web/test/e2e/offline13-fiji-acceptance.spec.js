// OFFLINE-13: opt-in Fiji cockpit acceptance proof.
//
// This test intentionally uses real local BYO packs and private local services.
// It is skipped by default because the Fiji MBTiles are user-owned and must not
// be committed or assumed in CI.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ENABLED = !!process.env.HELM_OFFLINE13;
const PACKD_ORIGIN = process.env.HELM_OFFLINE13_PACKD_URL || 'http://127.0.0.1:9127';
const FIJI_HASH = process.env.HELM_OFFLINE13_HASH || '#9/-17.75/178.12';
const EVIDENCE_DIR = process.env.HELM_OFFLINE13_EVIDENCE_DIR || '';
const PRIVATE_PATH_PATTERN = new RegExp(['/Users/', 'CloudStorage', 'Drop' + 'box', 'COS/Charts', 'steve' + 'ridder'].join('|'), 'i');

test.skip(!ENABLED, 'Set HELM_OFFLINE13=1 and provide local Fiji packs to run the OFFLINE-13 acceptance proof.');

function asJsonText(obj) {
  return JSON.stringify(obj, null, 2);
}

function localOnly(urlText) {
  const u = new URL(urlText);
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
}

function evidencePath(name) {
  if (!EVIDENCE_DIR) return '';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

async function screenshot(page, name) {
  const out = evidencePath(name);
  if (out) await page.screenshot({ path: out, fullPage: false });
}

async function packdJson(request, pathname) {
  const resp = await request.get(PACKD_ORIGIN + pathname);
  expect(resp.ok(), `${pathname} responds from local helm-packd`).toBeTruthy();
  return resp.json();
}

test('Fiji local packs survive offline pan/zoom/layer/tap acceptance', async ({ page, request }) => {
  const catalog = await packdJson(request, '/catalog');
  const catalogText = asJsonText(catalog);
  expect(catalogText, 'catalog must not leak private filesystem paths').not.toMatch(PRIVATE_PATH_PATTERN);

  const packs = Object.values(catalog || {});
  const navPack = packs.find(p => /navionics/i.test(`${p.id || ''} ${p.title || ''}`));
  const satPack = packs.find(p => /(bing|google|arcgis).*sat|sat.*(bing|google|arcgis)|BingSat|GoogleSat/i.test(`${p.id || ''} ${p.title || ''}`));
  expect(navPack, 'Navionics Fiji pack is visible in /catalog').toBeTruthy();
  expect(satPack, 'satellite Fiji pack is visible in /catalog').toBeTruthy();

  const layers = await packdJson(request, '/layers');
  const layersText = asJsonText(layers);
  expect(layersText, '/layers must not leak private filesystem paths').not.toMatch(PRIVATE_PATH_PATTERN);
  const navLayer = (layers.layers || []).find(l => l.component_id === `pack:${navPack.id}` || /navionics/i.test(`${l.dataset_name || ''} ${l.component_id || ''}`));
  expect(navLayer, 'Navionics pack appears in /layers inventory').toBeTruthy();
  expect(navLayer.inspection.semantic_objects, 'raster pack must not pretend to expose objects').toBe('unavailable');
  expect(navLayer.inspection.tap_action, 'raster tap action is explicit').toBe('show_pack_source_metadata');

  const bundle = await packdJson(request, '/bundle?bbox=176.8,-19.2,180.0,-16.0&minzoom=7&maxzoom=12&include_tiles=0');
  expect(bundle.schema).toBe('helm.region_bundle.manifest.v1');
  const prefetch = await packdJson(request, '/prefetch?bbox=176.8,-19.2,180.0,-16.0&minzoom=7&maxzoom=8&include_tiles=0');
  expect(prefetch.schema).toBe('helm.prefetch.manifest.v1');

  const externalRequests = [];
  const failedRequests = [];
  const packResponses = [];
  const consoleLines = [];

  await page.route('**/*', route => {
    const url = route.request().url();
    if (!localOnly(url)) {
      externalRequests.push(url);
      return route.abort('blockedbyclient');
    }
    // The legacy static basemap style points at :8091; OFFLINE-13 must prove the
    // selected pack path through the private C++ helm-packd port instead.
    if (/\/\/(?:127\.0\.0\.1|localhost):8091\//.test(url)) {
      failedRequests.push({ url, error: 'blocked legacy :8091 static style request' });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure() && req.failure().errorText }));
  page.on('response', resp => {
    if (resp.url().startsWith(PACKD_ORIGIN + '/')) {
      packResponses.push({
        url: resp.url(),
        status: resp.status(),
        bytes: Number(resp.headers()['content-length'] || 0),
        type: resp.headers()['content-type'] || ''
      });
    }
  });
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleLines.push({ type: msg.type(), text: msg.text() });
  });

  await page.goto('/?basemapPort=' + new URL(PACKD_ORIGIN).port + FIJI_HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded() && !!window.HelmOfflinePacks,
    null,
    { timeout: 30000 }
  );

  await page.evaluate(() => window.HelmShell.panel('helm-offline-packs').open());
  await page.waitForFunction(
    () => window.HelmOfflinePacks.state.packs.some(p => /navionics/i.test(`${p.id || ''} ${p.title || ''}`)),
    null,
    { timeout: 10000 }
  );
  await expect(page.locator('#helm-offline-packs')).toContainText(/local pack/);

  await page.evaluate(() => {
    const pack = window.HelmOfflinePacks.state.packs.find(p => /navionics/i.test(`${p.id || ''} ${p.title || ''}`));
    window.HelmOfflinePacks.activate(pack.id, { fit: false });
  });
  await page.waitForFunction(() => !!window.map.getLayer('helm-offline-active-pack') && !!window.map.getSource('helm-offline-active-pack'));
  await page.waitForFunction(() => window.HelmOfflinePacks.state.activeId && /navionics/i.test(window.HelmOfflinePacks.state.activeId), null, { timeout: 5000 });
  await page.waitForTimeout(1800);
  await screenshot(page, 'offline13-01-fiji-navionics.png');

  const navState = await page.evaluate(() => {
    const map = window.map;
    const source = map.getStyle().sources['helm-offline-active-pack'];
    return {
      activeId: window.HelmOfflinePacks.state.activeId,
      source,
      layerPresent: !!map.getLayer('helm-offline-active-pack'),
      radioChecked: !!document.querySelector('input[name="basemap"]:checked'),
      center: map.getCenter().toArray(),
      zoom: map.getZoom()
    };
  });
  expect(navState.layerPresent).toBe(true);
  expect(navState.radioChecked, 'dynamic pack clears static basemap radios').toBe(false);
  expect(navState.source.maxzoom, 'source maxzoom is the real pack max for overzoom').toBe(navPack.maxzoom);
  expect(navState.source.tiles[0], 'dynamic source uses private helm-packd port').toContain(PACKD_ORIGIN);

  await expect.poll(() => packResponses.filter(r => r.status === 200 && r.bytes > 1000).length, {
    message: 'at least one real Fiji pack tile loaded from helm-packd',
    timeout: 10000
  }).toBeGreaterThan(0);

  await page.evaluate(() => window.map.jumpTo({ center: [178.12, -17.75], zoom: 19 }));
  await page.waitForTimeout(1200);
  const deepZoom = await page.evaluate(() => ({
    zoom: window.map.getZoom(),
    maxzoom: window.map.getStyle().sources['helm-offline-active-pack'].maxzoom
  }));
  expect(deepZoom.zoom).toBeGreaterThan(18.5);
  expect(deepZoom.maxzoom).toBe(navPack.maxzoom);
  await screenshot(page, 'offline13-02-overzoom-z19.png');

  await page.evaluate(() => window.map.jumpTo({ center: [179.2, -17.65], zoom: 12 }));
  await page.waitForTimeout(1200);
  await screenshot(page, 'offline13-03-pan-inside-coverage.png');
  await expect(page.locator('#helm-coverage-badge')).toBeHidden();

  await page.evaluate(() => {
    const pack = window.HelmOfflinePacks.state.packs.find(p => /(BingSat|GoogleSat|ArcGIS|sat)/i.test(`${p.id || ''} ${p.title || ''}`));
    window.HelmOfflinePacks.activate(pack.id, { fit: false });
  });
  await page.waitForTimeout(1200);
  const satState = await page.evaluate(() => window.HelmOfflinePacks.state.activeId);
  expect(satState).toMatch(/BingSat|GoogleSat|ArcGIS|sat/i);
  await screenshot(page, 'offline13-04-satellite-pack.png');

  const layerSwitch = await page.evaluate(() => {
    const map = window.map;
    function toggle(selector, checked) {
      const el = document.querySelector(selector);
      if (!el) return 'missing';
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }
    const results = {
      depthOff: toggle('input[data-layer="depare-fill"]', false),
      depthOn: toggle('input[data-layer="depare-fill"]', true),
      soundingsOff: toggle('input[data-layer="soundg-text"]', false),
      soundingsOn: toggle('input[data-layer="soundg-text"]', true),
      routeOff: toggle('input[data-layer="route-line"]', false),
      routeOn: toggle('input[data-layer="route-line"]', true),
      aisOff: toggle('input[data-layer="ais"]', false),
      aisOn: toggle('input[data-layer="ais"]', true)
    };
    results.layers = {
      depth: map.getLayer('depare-fill') && map.getLayoutProperty('depare-fill', 'visibility'),
      soundings: map.getLayer('soundg-text') && map.getLayoutProperty('soundg-text', 'visibility'),
      route: map.getLayer('route-line') && map.getLayoutProperty('route-line', 'visibility'),
      aisVessels: map.getLayer('ais-vessels') && map.getLayoutProperty('ais-vessels', 'visibility')
    };
    return results;
  });
  expect(layerSwitch).toMatchObject({
    depthOff: 'ok', depthOn: 'ok',
    soundingsOff: 'ok', soundingsOn: 'ok',
    routeOff: 'ok', routeOn: 'ok',
    aisOff: 'ok', aisOn: 'ok'
  });
  expect(layerSwitch.layers.depth || 'visible').toBe('visible');
  expect(layerSwitch.layers.soundings || 'visible').toBe('visible');
  expect(layerSwitch.layers.route || 'visible').toBe('visible');
  expect(layerSwitch.layers.aisVessels || 'visible').toBe('visible');

  await page.mouse.click(640, 380);
  await expect(page.locator('.helm-raster-inspect')).toContainText(/Raster packs contain pixels only|object inspection is unavailable/i);
  const inspect = await page.evaluate(() => window.HelmOfflinePacks.state.lastInspect);
  expect(inspect.semantic_objects).toBe('unavailable');
  expect(inspect.mode).toBe('raster_metadata');
  expect(inspect.inside_coverage).toBe(true);
  await screenshot(page, 'offline13-05-raster-tap-metadata.png');

  await page.evaluate(() => window.map.jumpTo({ center: [178.2, -24.5], zoom: 8 }));
  await page.waitForTimeout(700);
  await expect(page.locator('#helm-coverage-badge')).toContainText('Outside offline chart coverage');
  await page.mouse.click(640, 380);
  await expect(page.locator('.helm-raster-inspect')).toContainText('outside the selected offline pack coverage');
  const outsideInspect = await page.evaluate(() => window.HelmOfflinePacks.state.lastInspect);
  expect(outsideInspect.inside_coverage).toBe(false);
  await screenshot(page, 'offline13-06-outside-coverage.png');

  const evidence = {
    packd: PACKD_ORIGIN,
    selected_chart_pack: navPack.id,
    selected_sat_pack: satState,
    pack_responses: packResponses.slice(0, 30),
    failed_requests: failedRequests.slice(0, 30),
    external_requests: externalRequests,
    console: consoleLines.slice(0, 30),
    inspection: inspect,
    outside_inspection: outsideInspect,
    bundle_summary: bundle.summary || null,
    prefetch_totals: prefetch.totals || null
  };
  const jsonOut = evidencePath('offline13-evidence.json');
  if (jsonOut) fs.writeFileSync(jsonOut, asJsonText(evidence));

  expect(externalRequests, 'browser was run with internet requests blocked; app should not need them').toEqual([]);
  expect(packResponses.some(r => r.status === 200 && r.bytes > 1000), 'packd supplied real local tiles').toBe(true);
  expect(consoleLines.filter(c => /TypeError|ReferenceError|Unhandled|failed to load style/i.test(c.text)), 'no fatal console errors').toEqual([]);
});
