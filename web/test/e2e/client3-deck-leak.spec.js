// CLIENT-3 validation — the claim I sold: "Toggle layers freely."
// The deck.gl AIS-at-scale overlay must DETACH cleanly on disable (no leaked map control / GL
// context), and re-enable must build a fresh overlay — so toggling it across a long watch doesn't
// accumulate. Driven by importing the integration module directly (its bare deck imports resolve
// through the page's import map).
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.describe("CLIENT-3 — 'toggle layers freely' (no deck.gl leak)", () => {
  test('enable -> disable -> enable leaves no leaked control, and re-enable works', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await boot(page);

    const r = await page.evaluate(async () => {
      const map = window.map;
      const n = () => (map._controls ? map._controls.length : -1);
      const ctx = { region: { center: [177.4, -17.8] }, notify: () => {}, aisUrl: 'data/__missing__.geojson' };
      const mod = await import('./integrations/ais-deck.js');
      const base = n();
      await mod.enable(map, ctx);
      const afterEnable = n();
      mod.disable(map);
      const afterDisable = n();
      await mod.enable(map, ctx);          // must rebuild a FRESH overlay
      const afterReEnable = n();
      mod.disable(map);                    // leave clean
      return { base, afterEnable, afterDisable, afterReEnable };
    });

    expect(r.base, 'map controls readable').toBeGreaterThanOrEqual(0);
    expect(r.afterEnable, 'deck overlay added on enable').toBe(r.base + 1);
    expect(r.afterDisable, 'overlay DETACHED on disable (the leak fix)').toBe(r.base);
    expect(r.afterReEnable, 're-enable builds a fresh overlay').toBe(r.base + 1);
    expect(errors, 'no uncaught errors across the toggle cycle').toEqual([]);
  });
});
