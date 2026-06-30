// OFFLINE-4: the BYO chart-pack selector discovers a local catalog and wires
// the chosen pack into MapLibre as a dynamic raster source/layer.
const { test, expect } = require('@playwright/test');

const PACK_ID = 'Fiji Test Navionics Z8-16,18';
const PMTILES_ID = 'Fiji Test PMTiles';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

async function bootWithPackPort(page) {
  await page.goto('/?basemapPort=9101#9/-17.75/178.12');
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded() && !!window.HelmOfflinePacks,
    null,
    { timeout: 20000 }
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
  });

  await page.route(/https?:\/\/[^/]+:8093\/.*/, route => route.fulfill({ status: 503, body: 'weather gateway intentionally offline in test' }));
  await page.route(/https?:\/\/[^/]+:9101\/(?!catalog$).*/, route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
    body: PNG_1X1
  }));
  await page.route(/\/chart\/\d+\/\d+\/\d+\.png$/, route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: PNG_1X1
  }));
  await page.route(/https?:\/\/[^/]+:9101\/catalog$/, route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      [PACK_ID]: {
        id: PACK_ID,
        title: 'Fiji Test Navionics',
        kind: 'chart',
        format: 'png',
        extension: 'png',
        minzoom: 7,
        maxzoom: 17,
        bounds: '176.8,-19.2,180.0,-16.0',
        bounds_array: [176.8, -19.2, 180.0, -16.0],
        size_bytes: 2750000000,
        license: 'local-user-owned'
      },
      [PMTILES_ID]: {
        id: PMTILES_ID,
        title: 'Fiji Test PMTiles',
        kind: 'chart',
        container: 'pmtiles',
        format: 'png',
        extension: 'png',
        minzoom: 7,
        maxzoom: 17,
        bounds: '176.8,-19.2,180.0,-16.0',
        bounds_array: [176.8, -19.2, 180.0, -16.0],
        size_bytes: 2450000000,
        pmtiles_url: 'http://127.0.0.1:9101/fiji.pmtiles',
        protocol_url: 'pmtiles://http://127.0.0.1:9101/fiji.pmtiles',
        license: 'local-user-owned'
      }
    })
  }));
});

test('selects a local MBTiles pack and persists the dynamic raster layer', async ({ page }) => {
  await bootWithPackPort(page);
  await page.evaluate(() => window.HelmShell.panel('helm-offline-packs').open());
  await expect(page.locator('#helm-offline-packs')).toContainText('2 local packs');
  await expect(page.locator('#helm-offline-packs')).toContainText('Fiji Test Navionics');

  await page.locator('input[name="helm-offline-pack"]').first().check();

  await expect.poll(async () => page.evaluate(() => {
    const map = window.map;
    const source = map.getStyle().sources['helm-offline-active-pack'];
    return {
      activeId: window.HelmOfflinePacks.state.activeId,
      stored: localStorage.getItem('helm.offline.activePack'),
      layerPresent: !!map.getLayer('helm-offline-active-pack'),
      sourcePresent: !!map.getSource('helm-offline-active-pack'),
      navionicsVisibility: map.getLayer('navionics') ? map.getLayoutProperty('navionics', 'visibility') : 'missing',
      radioChecked: !!document.querySelector('input[name="basemap"]:checked'),
      selectorError: window.HelmOfflinePacks.state.error,
      tiles: source && source.tiles
    };
  })).toMatchObject({
    activeId: PACK_ID,
    stored: JSON.stringify(PACK_ID),
    layerPresent: true,
    sourcePresent: true,
    navionicsVisibility: 'none',
    radioChecked: false,
    selectorError: '',
    tiles: [expect.stringContaining('Fiji%20Test%20Navionics%20Z8-16%2C18')]
  });
});

test('selects a local PMTiles pack through the vendored protocol', async ({ page }) => {
  await bootWithPackPort(page);
  await page.evaluate(() => window.HelmShell.panel('helm-offline-packs').open());
  await expect(page.locator('#helm-offline-packs')).toContainText('Fiji Test PMTiles');

  await page.locator('input[name="helm-offline-pack"]').nth(1).check();

  await expect.poll(async () => page.evaluate(() => {
    const map = window.map;
    const source = map.getStyle().sources['helm-offline-active-pack'];
    return {
      activeId: window.HelmOfflinePacks.state.activeId,
      layerPresent: !!map.getLayer('helm-offline-active-pack'),
      sourcePresent: !!map.getSource('helm-offline-active-pack'),
      sourceTiles: (source && source.tiles) || null
    };
  })).toMatchObject({
    activeId: PMTILES_ID,
    layerPresent: true,
    sourcePresent: true,
    sourceTiles: ['pmtiles://http://127.0.0.1:9101/fiji.pmtiles/{z}/{x}/{y}']
  });
});
