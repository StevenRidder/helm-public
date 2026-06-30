// CLIENT-4 validation — the claim I sold: "Honest when something's wrong."
// A thrown exception / rejected promise / failed chart load must SAY so, never go silently blank,
// and must NOT cry wolf on benign offline tile 404s.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.describe("CLIENT-4 — 'honest when something's wrong'", () => {
  test('clean load shows NO banner (no crying wolf)', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#degraded-banner')).toBeHidden();
  });

  test('a real error surfaces; a benign tile 404 is suppressed; dismiss works', async ({ page }) => {
    await boot(page);
    const banner = page.locator('#degraded-banner');

    await page.evaluate(() => window.__helmDegrade('Test failure', 'synthetic'));
    await expect(banner).toBeVisible();
    await expect(page.locator('#dg-ttl')).toHaveText('Test failure');

    await page.locator('#dg-x').click();
    await expect(banner).toBeHidden();

    await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error',
      { message: 'boom in feature', filename: 'http://x/foo.js', lineno: 9 })));
    await expect(banner).toBeVisible();
    await expect(page.locator('#dg-ttl')).toHaveText('A feature failed');
    await page.locator('#dg-x').click();
    await expect(banner).toBeHidden();

    await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error',
      { message: 'Failed to fetch tile 12/3/4.png 404' })));
    await expect(banner).toBeHidden();   // benign => suppressed
  });

  test('classifier: map tiles suppressed, a dead nav backend SURFACES (the review blocker)', async ({ page }) => {
    await boot(page);
    const c = await page.evaluate(() => ({
      tilePbf: window.__helmBenignError('Failed to load tile 12/3/4.pbf'),
      sprite: window.__helmBenignError('sprite request 404'),
      navWss: window.__helmBenignError('Failed to fetch wss://boat.local/nav'),
      typeErr: window.__helmBenignError('undefined is not a function'),
      styleJson: window.__helmBenignError('helm-ais-targets.json failed to load'),
    }));
    expect(c.tilePbf, 'tile .pbf is benign').toBe(true);
    expect(c.sprite, 'sprite is benign').toBe(true);
    expect(c.navWss, 'a dead nav WebSocket MUST surface').toBe(false);
    expect(c.typeErr, 'a JS fault MUST surface').toBe(false);
    expect(c.styleJson, 'a failed style fragment MUST surface').toBe(false);
  });

  test('rate-limit: an identical error only banners once within the window', async ({ page }) => {
    await boot(page);
    const banner = page.locator('#degraded-banner');
    await page.evaluate(() => window.__helmDegrade('Repeat', 'x'));
    await expect(banner).toBeVisible();
    // Dismiss behavior is covered above; keep this assertion focused on the
    // rate limiter so a slow CI click cannot masquerade as a re-show.
    await page.evaluate(() => { document.getElementById('degraded-banner').hidden = true; });
    await expect(banner).toBeHidden();
    await page.evaluate(() => window.__helmDegrade('Repeat', 'x'));   // same key, within 4s
    await expect(banner).toBeHidden();                               // suppressed, not re-shown
  });

  test('a failed chart style shows the banner, NOT a blank page', async ({ page }) => {
    await page.route(/style\/.*\.json(\?.*)?$|\/style\.json(\?.*)?$/, (r) => r.abort());
    await page.goto('/');
    // the banner explains it, and the app chrome (toolbar) is still present — not a blank page
    await expect(page.locator('#degraded-banner')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.tb')).toBeVisible();
  });
});
