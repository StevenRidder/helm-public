// CLIENT-8 validation — the claim: "Zoom in, clean up." The client asks the server (CONTRACT-8) to
// cull AIS targets to the visible viewport — so panning/zooming sends the bounds [w,s,e,n], and a
// world-scale view streams all (null). Verified by instrumenting __navClient.setBbox.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.describe("CLIENT-8 — 'zoom in, clean up' (AIS viewport cull)", () => {
  test('panning sends the viewport bbox; world view streams all (null)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.__bbox = [];
      const real = window.__navClient.setBbox.bind(window.__navClient);
      window.__navClient.setBbox = (b) => { window.__bbox.push(b); return real(b); };
    });

    // pan at a chart zoom -> a finite [w,s,e,n] bbox is sent (after the ~300ms debounce)
    await page.evaluate(() => window.map.jumpTo({ center: [177.4, -17.8], zoom: 11 }));
    await page.evaluate(() => window.map.panBy([220, 90], { duration: 0 }));
    await page.waitForFunction(() => window.__bbox.length > 0, null, { timeout: 6000 });
    const last = await page.evaluate(() => window.__bbox[window.__bbox.length - 1]);
    expect(Array.isArray(last), 'a [w,s,e,n] bbox is sent on pan').toBe(true);
    expect(last.length).toBe(4);
    expect(last[2] - last[0], 'bbox has positive width (east > west)').toBeGreaterThan(0);
    expect(last[3] - last[1], 'bbox has positive height (north > south)').toBeGreaterThan(0);

    // zoom out to world scale -> a bbox cull is useless; stream all (null)
    await page.evaluate(() => { window.__bbox = []; window.map.jumpTo({ center: [0, 0], zoom: 0 }); });
    await page.waitForFunction(() => window.__bbox.length > 0, null, { timeout: 6000 });
    const world = await page.evaluate(() => window.__bbox[window.__bbox.length - 1]);
    expect(world, 'world view streams all targets (null bbox)').toBeNull();
  });
});
