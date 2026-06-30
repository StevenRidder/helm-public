// Shared helpers for the Helm Tier-1 E2E specs.
const { expect } = require('@playwright/test');

// Boot the app and wait until the map + error surface + ownship are wired and the style is loaded.
async function boot(page) {
  await page.goto('/');
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && typeof window.__helmDegrade === 'function' && !!window.__ownship,
    null, { timeout: 20000 });
  await page.waitForFunction(() => window.map.isStyleLoaded(), null, { timeout: 20000 });
}

// Feed the ownship module a fix directly (deterministic; independent of the SIM cadence).
async function feedFix(page, lat, lon, cog, sog) {
  await page.evaluate(({ lat, lon, cog, sog }) =>
    window.__ownship.update({ pos: { lat, lon }, cog, sog }), { lat, lon, cog, sog });
}

// Wrap a geojson source's setData ONCE so a test can count rebuilds. Counts into window.__sd[id].
async function watchSetData(page, sourceId) {
  await page.evaluate((id) => {
    window.__sd = window.__sd || {};
    const s = window.map.getSource(id);
    if (!s) { window.__sd[id] = -1; return; }     // -1 => source not present
    window.__sd[id] = 0;
    if (!s.__counted) { const o = s.setData.bind(s); s.setData = (d) => { window.__sd[id]++; return o(d); }; s.__counted = true; }
  }, sourceId);
}
const resetCount = (page, id) => page.evaluate((i) => { window.__sd[i] = 0; }, id);
const getCount = (page, id) => page.evaluate((i) => window.__sd[i], id);

module.exports = { boot, feedFix, watchSetData, resetCount, getCount };
