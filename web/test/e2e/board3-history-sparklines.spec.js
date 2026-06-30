// BOARD-3 — history sparklines + trend direction on Smart Board tiles.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

async function openBoard(page) {
  await page.locator('[data-rail="helm-board-panel"]').click();
  await expect(page.locator('#helm-board-panel')).toBeVisible();
}

test('Smart Board tiles keep bounded history and render sparkline trend direction', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard && !!window.HelmStore, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.HelmStore.remove('board.state.v1');
    window.HelmBoard.reset();
  });
  await openBoard(page);

  const sogTile = page.locator('.helm-board-tile').filter({ hasText: 'SOG' });
  await page.evaluate(() => {
    [4.0, 5.2, 7.4].forEach((sog) => {
      window.HelmBoard.update({ sources: {}, sog, cog: 100, depth: 8.1, wind: { spd: 10, dir: 90 }, active: {} });
    });
  });

  await expect(sogTile.locator('.helm-board-spark svg polyline')).toBeVisible();
  await expect(sogTile.locator('.helm-board-trend')).toContainText('↑');
  await expect(sogTile.locator('.helm-board-trend')).toHaveClass(/up/);
  await expect.poll(() => page.evaluate(() => {
    const tile = window.HelmBoard.state().boards[0].tiles.find(t => t.path === 'navigation.speedOverGround');
    return tile._history;
  })).toEqual([4, 5.2, 7.4]);

  await page.evaluate(() => {
    window.HelmBoard.update({ sources: {}, sog: 3.9, cog: 100, depth: 8.1, wind: { spd: 10, dir: 90 }, active: {} });
  });
  await expect(sogTile.locator('.helm-board-trend')).toContainText('↓');
  await expect(sogTile.locator('.helm-board-trend')).toHaveClass(/down/);

  await page.evaluate(() => {
    for (let i = 0; i < 40; i += 1) {
      window.HelmBoard.update({ sources: {}, sog: i, cog: 100, depth: 8.1, wind: { spd: 10, dir: 90 }, active: {} });
    }
  });

  await expect.poll(() => page.evaluate(() => {
    const tile = window.HelmBoard.state().boards[0].tiles.find(t => t.path === 'navigation.speedOverGround');
    return {
      len: tile._history.length,
      first: tile._history[0],
      last: tile._history[tile._history.length - 1],
      points: document.querySelector('.helm-board-tile[data-tile-id="' + tile.id + '"] .helm-board-spark polyline').getAttribute('points').trim().split(/\s+/).length
    };
  })).toEqual({ len: 32, first: 8, last: 39, points: 32 });
});
