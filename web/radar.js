/*
 * Helm — radar.js
 * Animated precipitation radar nowcast from the free RainViewer API
 * (https://www.rainviewer.com/api.html), as a MapLibre raster layer that cycles
 * through the past frames + the nowcast frames — the "radar" you see on Windy.
 *
 * API:
 *   const radar = HelmRadar(map, { beforeId: 'route-line' });
 *   radar.load();          // fetch frame index, show latest, start animating
 *   radar.setVisible(true|false);   radar.play();   radar.stop();
 */
(function (global) {
  'use strict';
  var SRC = 'helm-radar', LYR = 'helm-radar';

  function HelmRadar(map, opts) {
    if (!(this instanceof HelmRadar)) return new HelmRadar(map, opts);
    this.map = map;
    this.beforeId = (opts && opts.beforeId) || null;
    this.frames = [];
    this.idx = 0;
    this.timer = null;
    this.host = '';
  }

  HelmRadar.prototype._tileUrl = function (frame) {
    // color scheme 2 (universal), smooth=1, snow=1, 256px tiles
    return this.host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png';
  };

  HelmRadar.prototype.load = function () {
    var self = this;
    return fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        self.host = j.host;
        var past = (j.radar && j.radar.past) || [];
        var now = (j.radar && j.radar.nowcast) || [];
        self.frames = past.concat(now);
        if (!self.frames.length) return null;
        self.idx = Math.max(0, past.length - 1);   // start at "now"
        var url = self._tileUrl(self.frames[self.idx]);
        var map = self.map;
        if (map.getSource(SRC)) {
          map.getSource(SRC).setTiles([url]);
          map.setLayoutProperty(LYR, 'visibility', 'visible');
        } else {
          map.addSource(SRC, { type: 'raster', tiles: [url], tileSize: 256,
            attribution: 'Radar &copy; RainViewer' });
          var before = (self.beforeId && map.getLayer(self.beforeId)) ? self.beforeId : undefined;
          map.addLayer({ id: LYR, type: 'raster', source: SRC,
            paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 } }, before);
        }
        self.play();
        return self.frames.length;
      })
      .catch(function (e) { console.warn('[HelmRadar] load failed', e && e.message); return null; });
  };

  HelmRadar.prototype.play = function () {
    var self = this;
    this.stop();
    this.timer = global.setInterval(function () {
      if (!self.frames.length || !self.map.getSource(SRC)) return;
      self.idx = (self.idx + 1) % self.frames.length;
      self.map.getSource(SRC).setTiles([self._tileUrl(self.frames[self.idx])]);
    }, 700);
  };

  HelmRadar.prototype.stop = function () {
    if (this.timer) { global.clearInterval(this.timer); this.timer = null; }
  };

  HelmRadar.prototype.setVisible = function (v) {
    if (this.map.getLayer(LYR)) this.map.setLayoutProperty(LYR, 'visibility', v ? 'visible' : 'none');
    if (v) this.play(); else this.stop();
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = HelmRadar;
  else global.HelmRadar = HelmRadar;
})(typeof window !== 'undefined' ? window : this);
