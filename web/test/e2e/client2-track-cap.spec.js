// CLIENT-2 validation — the claim I sold: "Plot for days, not minutes."
// The breadcrumb trail must stay bounded (<= 3000 points, mirroring the engine cap) no matter how
// many fixes arrive, via both the snapshot-replace and the delta-append paths — so a long voyage
// never degrades. We capture the geojson actually handed to the map source (MapLibre exposes no
// public read-back of source data) and assert its coordinate count.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

function fakeTrack(n) {   // n [lat,lon] points marching NE from Fiji
  const out = [];
  for (let i = 0; i < n; i++) out.push([-17.8 + i * 1e-5, 177.0 + i * 1e-5]);
  return out;
}

test.describe("CLIENT-2 — 'plot for days' (bounded track)", () => {
  test('a 5000-point snapshot is capped to 3000 (most-recent kept) and still renders', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate((pts) => {
      window.HelmTrack.onState({ track: [[-17.8, 177.0], [-17.79, 177.01]] });   // seed -> creates source
      const s = window.map.getSource('helm-track');
      let cap = null; const o = s.setData.bind(s); s.setData = (d) => { cap = d; return o(d); };
      window.HelmTrack.onState({ track: pts });                                  // 5000-pt snapshot
      const c = cap.geometry.coordinates;
      return { len: c.length, last: c[c.length - 1] };
    }, fakeTrack(5000));
    expect(r.len, 'snapshot capped to the engine kTrackCap (3000)').toBe(3000);
    // the kept points are the most-recent tail (last point of the 5000-pt input survives)
    expect(r.last[0]).toBeCloseTo(177.0 + 4999 * 1e-5, 6);   // GeoJSON [lon,lat]; lon = 177 + i*1e-5
  });

  test('deltas that overflow the cap keep it bounded', async ({ page }) => {
    await boot(page);
    const snap = fakeTrack(2990);
    const delta = fakeTrack(20);
    const len = await page.evaluate(({ snap, delta }) => {
      window.HelmTrack.onState({ track: snap });
      const s = window.map.getSource('helm-track');
      let cap = null; const o = s.setData.bind(s); s.setData = (d) => { cap = d; return o(d); };
      for (let b = 0; b < 5; b++) window.HelmTrack.onState({ trackAdd: delta });   // +100 -> 3090
      return cap.geometry.coordinates.length;
    }, { snap, delta });
    expect(len, 'still capped to 3000 after deltas overflow it').toBe(3000);
  });
});
