// BOARD-4 — per-tile threshold alarms on the CONTRACT-10 alarm schema.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

async function openBoard(page) {
  await page.locator('[data-rail="helm-board-panel"]').click();
  await expect(page.locator('#helm-board-panel')).toBeVisible();
}

test('Smart Board tile thresholds raise CONTRACT-10 alarms with notification, haptic, sound, and clear', async ({ page }) => {
  await page.addInitScript(() => {
    window.__board4Beeps = 0;
    window.__board4Vibrations = [];
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: pattern => { window.__board4Vibrations.push(pattern); return true; }
    });
    class FakeGain {
      constructor() {
        this.gain = {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {}
        };
      }
      connect() {}
    }
    class FakeOscillator {
      constructor() { this.frequency = { value: 0 }; this.type = ''; }
      connect() {}
      start() { window.__board4Beeps += 1; }
      stop() {}
    }
    class FakeAudioContext {
      constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createOscillator() { return new FakeOscillator(); }
      createGain() { return new FakeGain(); }
      resume() { this.state = 'running'; return Promise.resolve(); }
    }
    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
  });

  await boot(page);
  await page.waitForFunction(() => !!window.HelmBoard && !!window.HelmStore && !!window.__alarms, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__board4AlarmFrames = [];
    const original = window.__alarms.fromAlarm.bind(window.__alarms);
    window.__alarms.fromAlarm = (alarm, meta) => {
      window.__board4AlarmFrames.push(JSON.parse(JSON.stringify(alarm)));
      return original(alarm, meta);
    };
    window.HelmStore.remove('board.state.v1');
    window.HelmBoard.reset();
    window.HelmBoard.addPathTile('tanks.fuel.0.currentLevel', 'Fuel Level', '%');
    window.HelmBoard.addPathTile('electrical.batteries.house.voltage', 'House Battery', 'V');
  });
  await openBoard(page);

  const ids = await page.evaluate(() => {
    const tiles = window.HelmBoard.state().boards[0].tiles;
    return {
      fuel: tiles.find(t => t.path === 'tanks.fuel.0.currentLevel').id,
      battery: tiles.find(t => t.path === 'electrical.batteries.house.voltage').id
    };
  });
  await page.evaluate(({ fuel, battery }) => {
    window.HelmBoard.setTileAlarm(fuel, { enabled: true, op: '>', threshold: 40, hysteresis: 5 });
    window.HelmBoard.setTileAlarm(battery, { enabled: true, op: '<', threshold: 12, hysteresis: 0.5 });
    window.HelmBoard.update({
      sources: {},
      tanks: { fuel: [{ currentLevel: 42 }] },
      electrical: { batteries: { house: { voltage: 11.8 } } }
    });
  }, ids);

  await expect.poll(() => page.evaluate(() => window.__alarms._state().active.sort())).toEqual([
    'tile:electrical.batteries.house.voltage',
    'tile:tanks.fuel.0.currentLevel'
  ]);
  await expect(page.locator('#alarm-banner')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__board4Vibrations.length)).toBe(2);
  await page.evaluate(() => window.__alarms._tick());
  await expect.poll(() => page.evaluate(() => window.__board4Beeps)).toBeGreaterThan(0);

  await expect.poll(() => page.evaluate(() => window.__board4AlarmFrames.map(f => ({
    t: f.t,
    op: f.op,
    id: f.id,
    kind: f.kind,
    rev: f.rev,
    sev: f.sev,
    path: f.data && f.data.path,
    value: f.data && f.data.value,
    threshold: f.data && f.data.threshold,
    cmp: f.data && f.data.op,
    hysteresis: f.data && f.data.hysteresis,
    tileId: !!(f.data && f.data.tileId)
  })))).toEqual([
    { t: 'alarm', op: 'raise', id: 'tile:tanks.fuel.0.currentLevel', kind: 'tile', rev: 1, sev: 'critical', path: 'tanks.fuel.0.currentLevel', value: 42, threshold: 40, cmp: '>', hysteresis: 5, tileId: true },
    { t: 'alarm', op: 'raise', id: 'tile:electrical.batteries.house.voltage', kind: 'tile', rev: 1, sev: 'critical', path: 'electrical.batteries.house.voltage', value: 11.8, threshold: 12, cmp: '<', hysteresis: 0.5, tileId: true }
  ]);

  await page.evaluate(() => {
    window.HelmBoard.update({
      sources: {},
      tanks: { fuel: [{ currentLevel: 44 }] },
      electrical: { batteries: { house: { voltage: 11.8 } } }
    });
  });
  await expect.poll(() => page.evaluate(() => {
    const f = window.__board4AlarmFrames.findLast(x => x.id === 'tile:tanks.fuel.0.currentLevel');
    return { op: f.op, rev: f.rev, value: f.data.value };
  })).toEqual({ op: 'update', rev: 2, value: 44 });
  await expect.poll(() => page.evaluate(() => window.__board4Vibrations.length)).toBe(2);

  await page.evaluate(() => {
    window.HelmBoard.update({
      sources: {},
      tanks: { fuel: [{ currentLevel: 34 }] },
      electrical: { batteries: { house: { voltage: 12.6 } } }
    });
  });
  await expect.poll(() => page.evaluate(() => window.__alarms._state().active)).toEqual([]);
});
