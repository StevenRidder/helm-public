// Smoke: the app boots in SIM mode (no engine) with no uncaught errors and a hidden error banner.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test('app boots in SIM mode, no uncaught errors, banner hidden', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page);
  await expect(page.locator('#degraded-banner')).toBeHidden();
  // SIM badge present (no engine) — proves the honesty badge + nav fallback wired
  await expect(page.locator('body')).toContainText('SIM');
  expect(errors, 'no uncaught page errors on boot').toEqual([]);
});
