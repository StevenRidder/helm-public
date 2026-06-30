const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/#12/-17.68169/177.38424');
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(),
    null,
    { timeout: 30000 }
  );
  await page.waitForSelector('.ri[data-rail="weather"]', { timeout: 10000 });
}

async function clickRail(page, rail) {
  const box = await page.locator(`.ri[data-rail="${rail}"]`).boundingBox();
  expect(box, `${rail} rail button has a visible box`).toBeTruthy();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
  });
});

test('weather gateway serves marine tiles and transparency controls them', async ({ page, baseURL }) => {
  test.setTimeout(120000);

  const appUrl = new URL(baseURL || 'http://127.0.0.1:8080');
  const gateway = `${appUrl.protocol}//${appUrl.hostname}:8093`;
  let health;
  try {
    health = await fetch(`${gateway}/health`);
  } catch (e) {
    test.skip(true, `${gateway}/health is not running; start services/wx to run this gateway spec`);
  }
  test.skip(!health.ok, `${gateway}/health returned ${health.status}; start services/wx to run this gateway spec`);

  await boot(page);
  await clickRail(page, 'weather');
  await page.locator('#wx button[data-wx="current"]').click();

  await page.waitForFunction(
    () => window.map && window.map.getLayer && window.map.getLayer('helm-wx-grib'),
    null,
    { timeout: 90000 }
  );

  await expect.poll(async () => page.evaluate(() => window.map.getPaintProperty('helm-wx-grib', 'raster-opacity')), {
    timeout: 10000,
  }).toBeCloseTo(0.72, 2);

  await page.locator('#wxopacity').evaluate((el) => {
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect.poll(async () => page.evaluate(() => window.map.getPaintProperty('helm-wx-grib', 'raster-opacity')), {
    timeout: 10000,
  }).toBeCloseTo(0.20, 2);
});
