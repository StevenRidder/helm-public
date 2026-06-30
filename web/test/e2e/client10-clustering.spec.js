// CLIENT-10 validation — the claim: dense harbours stay readable (POIs cluster instead of drowning
// the chart in overlapping pins). The `places` source is clustered; the legacy halo/icon/label layers
// still render INDIVIDUAL (unclustered) points, and two new places-cluster/-count layers render bubbles.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.describe("CLIENT-10 — 'clean charts in a crowded harbour' (POI clustering)", () => {
  test('dense POIs cluster (point_count present); individual + cluster layers all exist', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(
      () => window.map && window.map.isSourceLoaded && window.map.isSourceLoaded('places'),
      null,
      { timeout: 12000, polling: 200 });

    await page.evaluate(() => {
      const c = [177.4, -17.8], feats = [];
      for (let i = 0; i < 300; i++) {
        feats.push({
          type: 'Feature', properties: { kind: 'anchorage', name: 'P' + i, client10: true },
          geometry: { type: 'Point', coordinates: [c[0] + (Math.sin(i) * 0.1), c[1] + (Math.cos(i * 1.3) * 0.08)] },
        });
      }
      window.map.getSource('places').setData({ type: 'FeatureCollection', features: feats });
      window.map.jumpTo({ center: c, zoom: 9 });   // < clusterMaxZoom 13
    });

    await page.waitForFunction(
      () => {
        const src = window.map && window.map.getSource && window.map.getSource('places');
        const data = src && src.serialize && src.serialize().data;
        return !!(data && data.features && data.features.length === 300
          && data.features.every((f) => f.properties && f.properties.client10));
      },
      null, { timeout: 12000, polling: 200 });

    await page.waitForFunction(
      () => {
        const f = window.map.querySourceFeatures('places');
        const clustered = f.filter((x) => x.properties && x.properties.cluster).length;
        const maxCount = f.reduce((m, x) => Math.max(m, (x.properties && x.properties.point_count) || 0), 0);
        return clustered > 0 && maxCount > 1;
      },
      null, { timeout: 12000, polling: 200 });

    const stats = await page.evaluate(() => {
      const f = window.map.querySourceFeatures('places');
      return {
        clustered: f.filter((x) => x.properties && x.properties.cluster).length,
        maxCount: f.reduce((m, x) => Math.max(m, (x.properties && x.properties.point_count) || 0), 0),
      };
    });
    expect(stats.clustered, 'dense POIs form clusters').toBeGreaterThan(0);
    expect(stats.maxCount, 'a cluster aggregates multiple points').toBeGreaterThan(1);

    const layers = await page.evaluate(() =>
      ['places-cluster', 'places-cluster-count', 'places-halo', 'places-icon', 'places-label']
        .map((id) => !!window.map.getLayer(id)));
    expect(layers.every(Boolean), 'cluster + legacy individual layers all present').toBe(true);
  });

  test('the places source declares clustering + a sane maxzoom', async ({ page }) => {
    await boot(page);
    const src = await page.evaluate(() => window.map.getStyle().sources.places);
    expect(src.cluster, 'source is clustered').toBe(true);
    expect(src.maxzoom, 'source maxzoom capped (no over-tiling of points)').toBeLessThanOrEqual(14);
  });
});
