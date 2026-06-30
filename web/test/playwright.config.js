// @ts-check
// Playwright E2E config for the Helm web client (CLIENT epic — validation of the Tier-1 fixes).
// Serves web/ via the repo's range-capable serve.py and drives it in headless Chromium. Headless
// Chromium runs requestAnimationFrame normally (unlike a backgrounded tab), so the rAF-driven
// ownship/track behaviours ARE exercisable here. Runs in SIM mode (no engine) — the client falls
// back to its built-in simulator, which streams a moving fix.
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const PORT = process.env.HELM_E2E_PORT || 8077;
const BASE_URL = process.env.HELM_E2E_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  fullyParallel: false,        // one app instance; the SIM is shared state
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 10000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `python3 ${path.join(__dirname, '..', 'serve.py')} ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
