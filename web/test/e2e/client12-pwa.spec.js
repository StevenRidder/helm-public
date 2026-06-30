const { test, expect } = require('@playwright/test');

test('CLIENT-12 exposes installable PWA metadata', async ({ page }) => {
  await page.goto('/?client12=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Helm/);

  const pwa = await page.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
    const viewport = document.querySelector('meta[name="viewport"]');
    const theme = document.querySelector('meta[name="theme-color"]');
    const iosCapable = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
    const manifestUrl = manifestLink && new URL(manifestLink.getAttribute('href'), location.href).href;
    const manifest = manifestUrl ? await fetch(manifestUrl).then(r => r.json()) : null;
    return {
      manifestHref: manifestLink && manifestLink.getAttribute('href'),
      appleIconHref: appleIcon && appleIcon.getAttribute('href'),
      viewport: viewport && viewport.getAttribute('content'),
      theme: theme && theme.getAttribute('content'),
      iosCapable: iosCapable && iosCapable.getAttribute('content'),
      manifest,
    };
  });

  expect(pwa.manifestHref).toBe('manifest.webmanifest');
  expect(pwa.appleIconHref).toBe('icons/helm-180.png');
  expect(pwa.viewport).toContain('viewport-fit=cover');
  expect(pwa.theme).toBe('#05080c');
  expect(pwa.iosCapable).toBe('yes');
  expect(pwa.manifest.name).toBe('Helm');
  expect(pwa.manifest.short_name).toBe('Helm');
  expect(pwa.manifest.display).toBe('standalone');
  expect(pwa.manifest.start_url).toBe('./');
  expect(pwa.manifest.icons.some(icon => icon.sizes === '192x192')).toBeTruthy();
  expect(pwa.manifest.icons.some(icon => icon.sizes === '512x512')).toBeTruthy();
  expect(pwa.manifest.icons.some(icon => icon.purpose === 'maskable')).toBeTruthy();
});
