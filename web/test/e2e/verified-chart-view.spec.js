// Opt-in live chart diagnostic. It intentionally checks the user's actual chart view, not just
// app chrome. Run with HELM_VERIFY_CHART=1 so the normal suite does not depend on local chart packs.
const { test, expect } = require('@playwright/test');

const HASH = process.env.HELM_E2E_HASH || '#11/24.52/-81.77';

test.skip(!process.env.HELM_VERIFY_CHART, 'Set HELM_VERIFY_CHART=1 to verify a live chart view.');

function hashCenter(hash) {
  const m = String(hash || '').match(/^#?([0-9.]+)\/(-?[0-9.]+)\/(-?[0-9.]+)/);
  if (!m) throw new Error(`Bad Helm hash: ${hash}`);
  return { zoom: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
}

function inside(bbox, lon, lat) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

test('current view has visible chart or basemap backing', async ({ page, request }) => {
  const failedRequests = [];
  const chartTiles = [];
  const fillTiles = [];
  const mbtilesTiles = [];
  const mbtilesFailures = [];

  page.on('requestfailed', req => {
    const url = req.url();
    if (url.includes(':8091/')) mbtilesFailures.push(url);
    failedRequests.push({ url, error: req.failure() && req.failure().errorText });
  });
  page.on('response', resp => {
    const url = resp.url();
    const len = Number(resp.headers()['content-length'] || 0);
    if (url.includes('/chart/')) chartTiles.push({ url, status: resp.status(), bytes: len });
    if (url.includes(':8095/basemap/')) fillTiles.push({ url, status: resp.status(), bytes: len });
    if (url.includes(':8091/')) mbtilesTiles.push({ url, status: resp.status(), bytes: len });
  });

  const center = hashCenter(HASH);
  const catalogResp = await request.get('/catalog');
  expect(catalogResp.ok(), '/catalog responds').toBeTruthy();
  const catalog = await catalogResp.json();
  const centerInCatalog = !!(catalog.cells || []).find(cell => inside(cell.bbox, center.lon, center.lat));

  await page.goto('/' + HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(),
    null,
    { timeout: 20000 }
  );
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    const map = window.map;
    const vis = id => {
      if (!map || !map.getLayer(id)) return 'missing';
      return map.getLayoutProperty(id, 'visibility') || 'visible';
    };
    const center = map.getCenter();
    return {
      degradedHidden: document.querySelector('#degraded-banner')?.hidden,
      center: { lat: center.lat, lon: center.lng, zoom: map.getZoom() },
      visible: {
        navionics: vis('navionics'),
        onlineFill: vis('helm-chart-online-fill'),
        encChart: vis('enc-chart'),
        noaaCharts: vis('charts'),
      },
      canvasPresent: !!document.querySelector('#map canvas.maplibregl-canvas'),
    };
  });

  const usableEnc = state.visible.encChart !== 'none' && centerInCatalog &&
    chartTiles.some(t => t.status === 200 && t.bytes > 1000);
  const usableFill = state.visible.onlineFill !== 'none' &&
    fillTiles.some(t => t.status === 200 && t.bytes > 1000);
  const usableMbtiles = state.visible.navionics !== 'none' &&
    mbtilesTiles.some(t => t.status === 200 && t.bytes > 1000);
  const usable = usableEnc || usableFill || usableMbtiles;

  expect(Math.abs(state.center.lat - center.lat), `map latitude honors ${HASH}`).toBeLessThan(0.15);
  expect(Math.abs(state.center.lon - center.lon), `map longitude honors ${HASH}`).toBeLessThan(0.15);
  expect(Math.abs(state.center.zoom - center.zoom), `map zoom honors ${HASH}`).toBeLessThan(0.75);
  expect(usable, [
    `No visible map backing for ${HASH}.`,
    `Center in loaded ENC catalog: ${centerInCatalog}.`,
    `Visible layers: ${JSON.stringify(state.visible)}.`,
    `Chart tiles: ${JSON.stringify(chartTiles.slice(0, 6))}.`,
    `Online fill tiles: ${JSON.stringify(fillTiles.slice(0, 6))}.`,
    `8091 tiles: ${JSON.stringify(mbtilesTiles.slice(0, 6))}.`,
    `8091 failures: ${mbtilesFailures.length}.`,
    `Catalog: ${JSON.stringify(catalog)}.`,
  ].join('\n')).toBeTruthy();
  expect(state.degradedHidden, 'degraded banner hidden').toBe(true);
  expect(state.canvasPresent, 'map canvas present').toBe(true);
});
