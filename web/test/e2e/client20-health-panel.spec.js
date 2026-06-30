// CLIENT-20 E2E: the Status rail panel renders engine/feed/runtime diagnostics.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.describe('CLIENT-20 - status panel', () => {
  test('shows engine health, runtime paths, nav/feed state, and diagnostics', async ({ page }) => {
    await page.route('**/health', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        engine: 'helm-server',
        version: 'client20-test',
        chart_loaded: true,
        chart_status: 'loaded',
        runtime: {
          s57data: '/tmp/helm/runtime/s57data',
          enc: '/tmp/helm/runtime/enc/US5FL4CR.000',
          senc: '/tmp/helm/runtime/senc',
        },
        nav: {
          fix_status: 'live',
          reason: 'ok',
          required: ['pos', 'sog', 'cog'],
          missing: [],
          fields: { posAgeSec: 1, sogAgeSec: 1, cogAgeSec: 1 },
        },
      }),
    }));
    await boot(page);
    await page.evaluate(() => {
      window.HelmHealthPanel.onStatus({ phase: 'live', seq: 42, age: 500 });
      window.HelmHealthPanel.onNav({
        conns: [{ id: 'vesper', name: 'Vesper AIS', type: 'tcp-client', status: 'connected', sentences: 55, ageSec: 1 }],
        ais: [{ mmsi: 1 }, { mmsi: 2 }, { mmsi: 3 }],
      });
    });

    await page.locator('.ri[data-rail="helm-client-health"]').click();
    const panel = page.locator('#helm-client-health');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Subsystems');
    await expect(panel).toContainText('Navigation');
    await expect(panel).toContainText('AIS');
    await expect(panel).toContainText('Vesper AIS');
    await expect(panel).toContainText('client20-test');
    await expect(panel).toContainText('HELM_S57_DATA');
    await expect(panel).toContainText('/tmp/helm/runtime/s57data');
    await expect(panel).toContainText('HELM_ENC');
    await expect(panel).toContainText('US5FL4CR.000');
  });
});
