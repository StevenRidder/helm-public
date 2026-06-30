// CLIENT-7 validation — tap-to-select highlight via feature-state (NOT setData).
// HelmAisSelect.select(mmsi) sets {selected:true} on that target's feature (keyed by CLIENT-5's
// promoteId:'mmsi') and adds a selection-ring layer; selecting another / clearing flips it back.
// The highlight must survive the AIS source's per-nav-frame setData refresh.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

const MMSI = 244660000;

async function seed(page, lon, lat) {
  await page.evaluate(({ mmsi, lon, lat }) => {
    window.map.jumpTo({ center: [lon, lat], zoom: 11 });
    window.map.getSource('ais').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { mmsi, name: 'TESTBOAT', sog: 5, cog: 90 },
        geometry: { type: 'Point', coordinates: [lon, lat] } }] });
  }, { mmsi: MMSI, lon, lat });
  await page.waitForFunction((m) => {
    const src = window.map && window.map.getSource && window.map.getSource('ais');
    const data = src && src.serialize && src.serialize().data;
    return !!(data && data.features && data.features.some((f) => f.properties && f.properties.mmsi === m));
  }, MMSI, { timeout: 8000 });
}
const fstate = (page, id) => page.evaluate((i) => window.map.getFeatureState({ source: 'ais', id: i }), id);

test.describe('CLIENT-7 — tap-to-select highlight (feature-state, no setData)', () => {
  test('the HelmAisSelect API is present', async ({ page }) => {
    await boot(page);
    const ok = await page.evaluate(() => !!(window.HelmAisSelect && typeof window.HelmAisSelect.select === 'function' && typeof window.HelmAisSelect.clear === 'function'));
    expect(ok).toBe(true);
  });

  test('select() sets feature-state.selected + adds the ring layer', async ({ page }) => {
    await boot(page);
    await seed(page, 177.4, -17.8);
    await page.evaluate((id) => window.HelmAisSelect.select(id), MMSI);
    expect((await fstate(page, MMSI)).selected, 'feature-state.selected set').toBe(true);
    expect(await page.evaluate(() => !!window.map.getLayer('helm-ais-selected')), 'ring layer added').toBe(true);
    expect(await page.evaluate(() => window.HelmAisSelect.selected)).toBe(MMSI);
  });

  test('selecting another target clears the previous one', async ({ page }) => {
    await boot(page);
    await seed(page, 177.4, -17.8);
    await page.evaluate((id) => {
      window.map.getSource('ais').setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { mmsi: id, name: 'A' }, geometry: { type: 'Point', coordinates: [177.40, -17.80] } },
        { type: 'Feature', properties: { mmsi: id + 1, name: 'B' }, geometry: { type: 'Point', coordinates: [177.41, -17.81] } }] });
    }, MMSI);
    await page.waitForFunction((m) => {
      const src = window.map && window.map.getSource && window.map.getSource('ais');
      const data = src && src.serialize && src.serialize().data;
      return !!(data && data.features && data.features.some((f) => f.properties && f.properties.mmsi === m + 1));
    }, MMSI, { timeout: 8000 });
    await page.evaluate((id) => window.HelmAisSelect.select(id), MMSI);
    await page.evaluate((id) => window.HelmAisSelect.select(id + 1), MMSI);
    expect((await fstate(page, MMSI)).selected, 'previous deselected').toBeFalsy();
    expect((await page.evaluate((id) => window.map.getFeatureState({ source: 'ais', id: id + 1 }), MMSI)).selected, 'new one selected').toBe(true);
  });

  test('clear() removes the selection', async ({ page }) => {
    await boot(page);
    await seed(page, 177.4, -17.8);
    await page.evaluate((id) => window.HelmAisSelect.select(id), MMSI);
    await page.evaluate(() => window.HelmAisSelect.clear());
    expect((await fstate(page, MMSI)).selected).toBeFalsy();
    expect(await page.evaluate(() => window.HelmAisSelect.selected)).toBeFalsy();
  });

  test('selection survives the AIS source refresh (setData per nav frame)', async ({ page }) => {
    await boot(page);
    await seed(page, 177.4, -17.8);
    await page.evaluate((id) => window.HelmAisSelect.select(id), MMSI);
    // simulate a nav frame: the same target moved → full setData replace
    await page.evaluate((id) => {
      window.map.getSource('ais').setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { mmsi: id, name: 'TESTBOAT', sog: 6, cog: 95 }, geometry: { type: 'Point', coordinates: [177.402, -17.802] } }] });
    }, MMSI);
    await page.waitForFunction((id) => window.map.getFeatureState({ source: 'ais', id }).selected === true, MMSI, { timeout: 5000 });
    expect((await fstate(page, MMSI)).selected, 'still selected after refresh').toBe(true);
  });

  test('clicking an AIS list row selects that target', async ({ page }) => {
    await boot(page);
    await seed(page, 177.4, -17.8);
    // the real list lives in a hub panel; here we only exercise the delegated row→select wiring
    await page.evaluate((id) => {
      const t = document.createElement('table'); t.id = 'helm-ais-list';
      t.innerHTML = '<tbody><tr class="ais-row" data-mmsi="' + id + '"><td>x</td></tr></tbody>';
      document.body.appendChild(t);
      t.querySelector('tr.ais-row').click();
    }, MMSI);
    expect(await page.evaluate(() => window.HelmAisSelect.selected)).toBe(MMSI);
    expect((await fstate(page, MMSI)).selected).toBe(true);
  });
});
