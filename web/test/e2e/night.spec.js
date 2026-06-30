// TOOLS-5 — night mode. Verifies the whole-shell dark palette swap, that EVERY raster basemap dims
// (not a hardcoded id list), that the night hue is 0 (the old 205° pushed toward blue — worst for night
// vision/sleep), and that the brilliance control shows + persists.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

const isNight = (page) => page.evaluate(() => document.documentElement.classList.contains('theme-night'));
const rasters = (page) => page.evaluate(() => {
  const m = window.map, rs = (m.getStyle().layers || []).filter((l) => l.type === 'raster');
  const bmax = rs.map((l) => { const v = m.getPaintProperty(l.id, 'raster-brightness-max'); return v == null ? 1 : v; });
  const hue = rs.map((l) => m.getPaintProperty(l.id, 'raster-hue-rotate') || 0);
  return { n: rs.length, maxBmax: bmax.length ? Math.max(...bmax) : 1, hueAllZero: hue.every((h) => h === 0) };
});
const cvar = (page, n) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase(), n);

test.describe('TOOLS-5 — night mode (whole-shell dark + basemap dim + brilliance)', () => {
  test('day default: no night class, brilliance hidden, basemaps at full brightness', async ({ page }) => {
    await boot(page);
    expect(await isNight(page)).toBe(false);
    expect(await page.locator('#bril-wrap').isHidden()).toBe(true);
    const r = await rasters(page);
    expect(r.n, 'has raster basemap layers').toBeGreaterThan(0);
    expect(r.maxBmax).toBe(1);
  });

  test('night: shell palette swaps + EVERY raster dims + zero blue hue + brilliance shows', async ({ page }) => {
    await boot(page);
    await page.click('#theme-seg span[data-theme="night"]');
    expect(await isNight(page)).toBe(true);
    expect(await cvar(page, '--ctext'), 'text colour no longer the day white').not.toBe('#eef4f9');
    const r = await rasters(page);
    expect(r.maxBmax, 'all rasters dimmed below 1').toBeLessThan(1);
    expect(r.hueAllZero, 'no blue hue-rotate at night').toBe(true);
    expect(await page.locator('#bril-wrap').isVisible()).toBe(true);
  });

  test('brilliance slider persists + drives the red film', async ({ page }) => {
    await boot(page);
    await page.click('#theme-seg span[data-theme="night"]');
    await page.$eval('#bril', (el) => { el.value = 90; el.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(Number(await page.evaluate(() => window.HelmStore.get('ui.nightBrilliance', -1)))).toBe(90);
    expect(await page.evaluate(() => document.getElementById('night-film').style.background)).toMatch(/rgba\(24, ?6, ?3/);
  });

  test('back to day restores brightness + hides brilliance', async ({ page }) => {
    await boot(page);
    await page.click('#theme-seg span[data-theme="night"]');
    await page.click('#theme-seg span[data-theme="day"]');
    expect(await isNight(page)).toBe(false);
    expect((await rasters(page)).maxBmax).toBe(1);
    expect(await page.locator('#bril-wrap').isHidden()).toBe(true);
  });
});
