// Verifies the real local Helm UI surface. Run against the live app with:
// HELM_E2E_URL=http://127.0.0.1:8080 HELM_E2E_PORT=8080 npm run test:e2e -- e2e/verified-local-ui.spec.js
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/#11/24.52/-81.77');
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(),
    null,
    { timeout: 20000 }
  );
  await page.waitForFunction(
    () => !!document.querySelector('.ri[data-rail="settings"]') && !!document.querySelector('#drawer-settings'),
    null,
    { timeout: 10000 }
  );
}

async function clickRail(page, rail) {
  const box = await page.locator(`.ri[data-rail="${rail}"]`).boundingBox();
  expect(box, `${rail} rail button has a visible box`).toBeTruthy();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function wxOpacityStyle(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#wxopacity');
    const cs = getComputedStyle(el);
    return {
      appearance: cs.appearance,
      webkitAppearance: cs.webkitAppearance,
      fill: cs.getPropertyValue('--wx-fill').trim(),
      accentColor: cs.accentColor,
      height: el.getBoundingClientRect().height,
    };
  });
}

async function wxLiveOpacity(page) {
  return page.evaluate(() => {
    if (!window.map || !window.map.getLayer || !window.map.getLayer('helm-wx-live')) return null;
    return window.map.getPaintProperty('helm-wx-live', 'raster-opacity');
  });
}

function mockedWeatherNodes(urlText) {
  const u = new URL(urlText);
  const latCount = (u.searchParams.get('latitude') || '').split(',').filter(Boolean).length || 144;
  const current = {};
  const vars = (u.searchParams.get('current') || 'wind_speed_10m,wind_direction_10m').split(',');
  for (const name of vars) current[name] = name.includes('direction') ? 135 : 18;
  return Array.from({ length: latCount }, () => ({ current }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
  });
  await page.route(/https?:\/\/[^/]+:8093\/.*/, route => route.fulfill({ status: 503, body: 'weather gateway intentionally offline in test' }));
  await page.route('https://api.open-meteo.com/**', route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(mockedWeatherNodes(route.request().url())),
  }));
});

test('settings rail opens the drawer and the drawer scrolls on the live app', async ({ page }) => {
  await boot(page);

  const hit = await page.waitForFunction(() => {
    const btn = document.querySelector('.ri[data-rail="settings"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      clear: !!(top && top.closest && top.closest('.ri[data-rail="settings"]')),
      tag: top && top.tagName,
      cls: top && top.className,
      text: top && top.textContent && top.textContent.trim().slice(0, 40),
    };
  }, null, { timeout: 10000 });
  expect(await hit.jsonValue()).toMatchObject({ clear: true });

  await clickRail(page, 'settings');
  const drawerBox = await page.locator('#drawer-settings').boundingBox();
  expect(drawerBox, 'settings drawer has a visible box').toBeTruthy();
  await page.mouse.move(drawerBox.x + drawerBox.width / 2, drawerBox.y + drawerBox.height / 2);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(150);

  const drawerState = await page.evaluate(() => {
    const d = document.querySelector('#drawer-settings');
    return {
      hidden: d.hidden,
      scrollTop: d.scrollTop,
      scrollHeight: d.scrollHeight,
      clientHeight: d.clientHeight,
      text: d.innerText,
    };
  });

  expect(drawerState.hidden).toBe(false);
  expect(drawerState.scrollHeight).toBeGreaterThan(drawerState.clientHeight);
  expect(drawerState.scrollTop).toBeGreaterThan(100);
  expect(drawerState.text).toContain('Card text size');
});

test('weather transparency changes the live weather layer opacity', async ({ page }) => {
  await boot(page);

  await clickRail(page, 'weather');
  await expect.poll(async () => wxOpacityStyle(page)).toMatchObject({
    appearance: 'none',
    webkitAppearance: 'none',
    fill: '28%',
  });

  const scrubberState = await page.evaluate(() => {
    const time = document.querySelector('#time');
    const slider = document.querySelector('#tslider');
    const label = document.querySelector('#tlabel');
    return {
      display: getComputedStyle(time).display,
      max: slider.max,
      label: label.textContent,
      text: document.querySelector('#drawer-weather').innerText,
    };
  });
  expect(scrubberState.display).toBe('none');
  expect(scrubberState.max).toBe('0');
  expect(scrubberState.label).toBe('');
  expect(scrubberState.text).not.toContain('Thu 12:00 PM');

  await page.locator('#wx button[data-wx="wind"]').click();
  await page.waitForFunction(
    () => window.map && window.map.getLayer && window.map.getLayer('helm-wx-live'),
    null,
    { timeout: 20000 }
  );

  await expect.poll(async () => wxLiveOpacity(page))
    .toBeCloseTo(0.72, 2);

  await page.locator('#wxopacity').evaluate((el) => {
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await wxOpacityStyle(page)).fill).toBe('80%');

  await expect.poll(async () => wxLiveOpacity(page))
    .toBeCloseTo(0.20, 2);
});

test.describe('mobile chromium', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  });

  test('weather transparency slider keeps the explicit filled track on Android-style browsers', async ({ page }) => {
    await boot(page);
    await clickRail(page, 'weather');

    await expect.poll(async () => wxOpacityStyle(page)).toMatchObject({
      appearance: 'none',
      webkitAppearance: 'none',
      fill: '28%',
    });

    await page.locator('#wxopacity').evaluate((el) => {
      el.value = '80';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(async () => (await wxOpacityStyle(page)).fill).toBe('80%');
  });
});
