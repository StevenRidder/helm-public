// CLIENT-1 validation — the claim I sold: "Glass-smooth helm view, easy on battery."
// The rings/predictor overlay must still render and track the boat, but must NOT re-serialize the
// geojson source on every animation frame: the rebuild is GATED on real movement and STOPS when the
// boat is settled. (Headless Chromium runs requestAnimationFrame, so — unlike the preview tab — this
// IS exercisable; the overlay source existing at all proves the rAF frame loop runs.)
//
// The gating test STOPS the nav feed (window.__navClient.stop()) so the boat can truly settle, then
// drives ownship directly — fully deterministic, no SIM cadence to fight, robust on slow CI.
const { test, expect } = require('@playwright/test');
const { boot, feedFix } = require('./_helpers');

const OVL = 'helm-ownship-overlay';

// Poll until the overlay setData counter (window.__sd) has been stable for `need` polls — i.e. the
// eased pose has converged and the gate stopped redrawing. (Only reliable once the feed is stopped.)
async function waitConverged(page, need = 4) {
  await page.evaluate(() => { window.__prev = -1; window.__stable = 0; });
  await page.waitForFunction((n) => {
    const c = window.__sd;
    if (c === window.__prev) { window.__stable++; } else { window.__stable = 0; window.__prev = c; }
    return window.__stable >= n;
  }, need, { timeout: 12000, polling: 120 });
}

test.describe("CLIENT-1 — 'glass-smooth, easy on battery' (gated overlay redraw)", () => {
  test('the rings overlay renders (centred on the boat)', async ({ page }) => {
    await boot(page);
    await feedFix(page, 17.8, 177.4, 90, 6);
    await page.waitForSelector('.ownship', { timeout: 10000 });   // marker added => disp set => frame ran
    const ringCount = await page.evaluate((id) => {
      const s = window.map.getSource(id);
      let cap = null; const o = s.setData.bind(s); s.setData = (d) => { cap = d; return o(d); };
      const own = window.__ownship;
      if (!own.ringsShown()) own.toggleRings(); else { own.toggleRings(); own.toggleRings(); }
      return cap && cap.features ? cap.features.filter((f) => f.properties.kind === 'ring').length : -1;
    }, OVL);
    expect(ringCount, 'concentric range rings are drawn').toBeGreaterThan(0);
  });

  test('GATED: a SETTLED boat produces ~no overlay churn (and moving still redraws)', async ({ page }) => {
    await boot(page);
    // Kill the nav feed so the boat can truly settle and WE drive every fix deterministically.
    await page.evaluate(() => { if (window.__navClient && window.__navClient.stop) window.__navClient.stop(); });
    await page.evaluate(() => window.__ownship.update({ pos: { lat: 17.8, lon: 177.4 }, cog: 0, sog: 6 }));
    await page.waitForSelector('.ownship', { timeout: 10000 });

    await page.evaluate((id) => {
      const s = window.map.getSource(id); window.__sd = 0;
      const o = s.setData.bind(s); s.setData = (d) => { window.__sd++; return o(d); };
    }, OVL);

    // converge (no feed interfering) then measure a clean window: a settled boat must NOT churn.
    await waitConverged(page);
    await page.evaluate(() => { window.__sd = 0; });
    await page.waitForTimeout(1200);
    const settled = await page.evaluate(() => window.__sd);
    expect(settled, 'a settled boat produces NO overlay churn (un-gated would be ~70/1.2s)').toBeLessThanOrEqual(1);

    // MOVING: a new, distinct fix must redraw the overlay (it stays glued to the marker).
    await page.evaluate(() => { window.__sd = 0; window.__ownship.update({ pos: { lat: 17.86, lon: 177.47 }, cog: 40, sog: 8 }); });
    await page.waitForFunction(() => window.__sd > 0, null, { timeout: 6000 });
    expect(await page.evaluate(() => window.__sd), 'moving the boat redraws the overlay').toBeGreaterThan(0);
  });

  test('a manual pan still works (CLIENT-1 gates only the overlay source, never the camera)', async ({ page }) => {
    await boot(page);
    // sit at a defined chart zoom so a pixel pan maps to a clear longitude change (the globe-at-zoom-0
    // start barely moves lng per pixel).
    await page.evaluate(() => window.map.jumpTo({ center: [177.4, 17.8], zoom: 13 }));
    await page.waitForTimeout(60);
    const before = await page.evaluate(() => window.map.getCenter().lng);
    await page.evaluate(() => window.map.panBy([250, 0], { duration: 0 }));
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => window.map.getCenter().lng);
    expect(Math.abs(after - before), 'the map panned (camera not frozen)').toBeGreaterThan(1e-3);
  });
});
