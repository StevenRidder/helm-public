// BOARD-1 — Smart Board composable, persisted tile-grid substrate.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

async function openBoard(page) {
  await page.locator('[data-rail="helm-board-panel"]').click();
  await expect(page.locator('#helm-board-panel')).toBeVisible();
}

test('Smart Board supports add, resize, reorder, and reload persistence', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard && !!window.HelmStore, null, { timeout: 10000 });
  await page.evaluate(() => { window.HelmStore.remove('board.state.v1'); window.HelmBoard.reset(); });

  await openBoard(page);
  await expect(page.locator('.helm-board-tile')).toHaveCount(6);
  await expect(page.locator('#helm-board-panel')).toContainText('SOG');

  await page.locator('.helm-board-add-select').selectOption('heading');
  await page.locator('.helm-board-add-btn').click();
  await expect(page.locator('#helm-board-panel')).toContainText('Heading');

  await page.locator('.helm-board-path-input').fill('wind.spd');
  await page.locator('.helm-board-title-input').fill('Wind path');
  await page.locator('.helm-board-unit-input').fill('kt');
  await page.locator('.helm-board-add-path-btn').click();
  await expect(page.locator('#helm-board-panel')).toContainText('Wind path');

  const customId = await page.evaluate(() => window.HelmBoard.state().boards[0].tiles.find(t => t.path === 'wind.spd').id);
  await page.evaluate(() => window.HelmBoard.update({ sources: {}, sog: 6.1, cog: 123, hdg: 121, depth: 8.4, wind: { spd: 22, dir: 100 }, active: {} }));
  const customCard = page.locator('.helm-board-tile').filter({ hasText: 'Wind path' });
  await expect(customCard.locator('.helm-board-value')).toContainText('22');
  await page.evaluate(() => window.HelmBoard.update({ sources: {}, sog: 6.5, cog: 125, hdg: 122, depth: 8.2, wind: { spd: 26, dir: 105 }, active: {} }));
  await expect(customCard.locator('.helm-board-spark svg')).toBeVisible();
  await expect(customCard.locator('.helm-board-trend')).toContainText('↑');

  await page.evaluate((id) => window.HelmBoard.setTileAlarm(id, { enabled: true, op: '>', threshold: 24, hysteresis: 1 }), customId);
  await page.evaluate(() => window.HelmBoard.update({ sources: {}, sog: 6.6, cog: 125, hdg: 122, depth: 8.2, wind: { spd: 27, dir: 105 }, active: {} }));
  await expect.poll(() => page.evaluate(() => window.__alarms._state().active.includes('tile:wind.spd'))).toBe(true);

  await page.locator('.helm-board-rule-path').fill('sog');
  await page.locator('.helm-board-rule-value').fill('7');
  await page.locator('.helm-board-add-rule-btn').click();
  await expect(page.locator('.helm-board-rule-list')).toContainText('sog > 7');
  await page.evaluate(() => window.HelmBoard.setMode('Anchor'));
  await expect.poll(() => page.evaluate(() => window.HelmBoard.state().boards.find(b => b.id === window.HelmBoard.state().activeId).mode)).toBe('Anchor');
  await page.evaluate(() => window.HelmBoard.setMode('Underway'));

  const firstId = await page.evaluate(() => window.HelmBoard.state().boards[0].tiles[0].id);
  await page.locator('.helm-board-size').first().click();
  await expect.poll(() => page.evaluate((id) => {
    const t = window.HelmBoard.state().boards[0].tiles.find(x => x.id === id);
    return `${t.w}x${t.h}`;
  }, firstId)).toBe('2x1');

  await page.evaluate((id) => window.HelmBoard.moveTile(id, 2), firstId);
  await expect.poll(() => page.evaluate((id) => {
    return window.HelmBoard.state().boards[0].tiles.findIndex(x => x.id === id);
  }, firstId)).toBe(2);

  await page.reload();
  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard, null, { timeout: 10000 });
  await openBoard(page);

  await expect(page.locator('#helm-board-panel')).toContainText('Heading');
  await expect.poll(() => page.evaluate((id) => {
    const s = window.HelmBoard.state();
    const t = s.boards[0].tiles.find(x => x.id === id);
    const custom = s.boards[0].tiles.find(x => x.path === 'wind.spd');
    return {
      index: s.boards[0].tiles.findIndex(x => x.id === id),
      size: `${t.w}x${t.h}`,
      count: s.boards[0].tiles.length,
      custom: custom && custom.title,
      alarm: custom && custom.alarm && custom.alarm.enabled,
      rules: s.rules.length,
      modes: s.boards.map(b => b.mode).sort().join(',')
    };
  }, firstId)).toEqual({ index: 2, size: '2x1', count: 8, custom: 'Wind path', alarm: true, rules: 1, modes: 'Anchor,Underway' });
});
