// BOARD-2 — Any-SignalK-path tiles for non-core boat systems.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

async function openBoard(page) {
  await page.locator('[data-rail="helm-board-panel"]').click();
  await expect(page.locator('#helm-board-panel')).toBeVisible();
}

test('Smart Board renders arbitrary nested SignalK-style boat paths', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard && !!window.HelmStore, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.HelmStore.remove('board.state.v1');
    window.HelmBoard.reset();
    window.HelmBoard.addPathTile('electrical.batteries.house.voltage', 'House Battery', 'V');
    window.HelmBoard.addPathTile('tanks.fuel.0.currentLevel', 'Fuel Level', '%');
    window.HelmBoard.addPathTile('bilge.pumps.forward.state', 'Bilge Pump', '');
    window.HelmBoard.addPathTile('propulsion.main.revolutions', 'Engine RPM', 'rpm');
    window.HelmBoard.addPathTile('steering.autopilot.state', 'Autopilot', '');
    window.HelmBoard.update({
      sources: {},
      electrical: { batteries: { house: { voltage: 12.8 } } },
      tanks: { fuel: [{ currentLevel: 42 }] },
      bilge: { pumps: { forward: { state: 'off' } } },
      propulsion: { main: { revolutions: 2200 } },
      steering: { autopilot: { state: 'standby' } }
    });
  });

  await openBoard(page);
  const board = page.locator('#helm-board-panel');
  await expect(board).toContainText('House Battery');
  await expect(board.locator('.helm-board-tile').filter({ hasText: 'House Battery' }).locator('.helm-board-value')).toContainText('12.8');
  await expect(board.locator('.helm-board-tile').filter({ hasText: 'Fuel Level' }).locator('.helm-board-value')).toContainText('42');
  await expect(board.locator('.helm-board-tile').filter({ hasText: 'Bilge Pump' }).locator('.helm-board-value')).toContainText('off');
  await expect(board.locator('.helm-board-tile').filter({ hasText: 'Engine RPM' }).locator('.helm-board-value')).toContainText('2200');
  await expect(board.locator('.helm-board-tile').filter({ hasText: 'Autopilot' }).locator('.helm-board-value')).toContainText('standby');

  await page.reload();
  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard, null, { timeout: 10000 });
  await openBoard(page);
  await expect.poll(() => page.evaluate(() => {
    const paths = window.HelmBoard.state().boards[0].tiles.map(t => t.path);
    return [
      'electrical.batteries.house.voltage',
      'tanks.fuel.0.currentLevel',
      'bilge.pumps.forward.state',
      'propulsion.main.revolutions',
      'steering.autopilot.state'
    ].every(path => paths.includes(path));
  })).toBe(true);
});
