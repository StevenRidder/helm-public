// tack-assist (opposite-tack) — instrument-only: off until enabled; with REAL wind it computes the
// gybe/tack maneuver + draws the line; with no wind instrument it stays honestly empty.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

const last = (page) => page.evaluate(() => window.HelmTactics._last());

test.describe('tack assist — opposite-tack maneuver, instrument-only', () => {
  test('off until enabled · real wind → gybe + line · no wind → honest empty', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { if (window.HelmStore) HelmStore.set('ui.tackAssist', false); });
    await page.waitForSelector('#tack-chip', { timeout: 8000 });
    expect((await last(page)).enabled, 'starts disabled').toBe(false);

    // enable + feed a REAL-wind frame (stationary so apparent≈true): wind from 240, heading 120 → broad reach → GYBE
    const r = await page.evaluate(() => {
      document.getElementById('tack-chip').click();
      window.HelmShell.dispatchNav({ pos: { lat: -17.6, lon: 177.4 }, hdg: 120, cog: 120, sog: 0,
        sources: { wind: 'real', hdg: 'real', cog: 'real', sog: 'real', pos: 'real' }, wind: { spd: 15, dir: 240 } });
      return window.HelmTactics._last();
    });
    expect(r.enabled).toBe(true);
    expect(r.hasWind, 'real wind detected').toBe(true);
    expect(r.recommend, 'broad reach → recommend gybe').toBe('gybe');
    expect(r.tack.turn + r.gybe.turn, 'both options offered, turns sum to 360').toBe(360);
    expect(r.lineDrawn, 'opposite-tack line drawn from the boat').toBe(true);

    // no wind instrument → honest empty (no maneuver, no line) — no forecast/manual fallback
    const r2 = await page.evaluate(() => {
      window.HelmShell.dispatchNav({ pos: { lat: -17.6, lon: 177.4 }, cog: 120, sog: 0,
        sources: { wind: 'missing', pos: 'real' }, wind: { spd: 0, dir: 0 } });
      return window.HelmTactics._last();
    });
    expect(r2.hasWind, 'no wind instrument → no wind').toBe(false);
    expect(r2.recommend).toBe(null);
    expect(r2.lineDrawn, 'line cleared when no wind').toBe(false);
  });
});
