// Night-vision completeness (TOOLS-5b): in night/dusk, ALL chrome text + icons must sit in the red /
// amber ramp — not the day grey. Guards the ui-text.js inline-override regression (it set --cdim to a
// light grey on :root, which beats the theme stylesheet, leaving labels + rail icons grey in night).
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

const rgb = s => (String(s).match(/\d+/g) || []).map(Number);
// red (#d04835) and amber (#c47433) both satisfy this; the grey bug (#cdd9e2 → b>r) does not.
const reddish = s => { const [r, g, b] = rgb(s); return r > g && r > b && (r - b) > 25; };
const setTheme = (page, t) => page.evaluate(t =>
  document.querySelectorAll('#theme-seg span').forEach(s => { if (s.dataset.theme === t) s.click(); }), t)
  .then(() => page.waitForTimeout(300));
const cssColor = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? getComputedStyle(el).color : null; }, sel);
const cssStroke = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? getComputedStyle(el).stroke : null; }, sel);

for (const mode of ['night', 'dusk']) {
  test(`${mode}: instrument labels + rail icons + --cdim are in the red/amber ramp (not the day grey)`, async ({ page }) => {
    await boot(page);
    await setTheme(page, mode);

    const lbl = await cssColor(page, '.it .l');                 // a bottom-bar label ("WIND SPEED")
    expect(reddish(lbl), `${mode} label colour ${lbl}`).toBe(true);

    const ri = await cssStroke(page, '.rail .ri:not(.on) svg'); // an inactive rail icon (currentColor stroke)
    expect(reddish(ri), `${mode} rail icon stroke ${ri}`).toBe(true);

    const cdim = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cdim').trim());
    expect(cdim.toLowerCase(), 'ui-text must release --cdim to the theme in night/dusk').not.toBe('#cdd9e2');
  });
}
