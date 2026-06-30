/*
 * Helm — wind-layer.js
 * --------------------------------------------------------------------------
 * Self-contained, dependency-free animated wind PARTICLE layer for MapLibre
 * GL JS (the "Windy" look). Reads web/data/wind.json in the leaflet-velocity
 * VELOCITY format (a JSON array of two grid objects: U then V) and advects
 * particles across the live map, reprojecting lon/lat <-> screen each frame.
 *
 * Public API:
 *     const wind = HelmWind(map);
 *     wind.load('data/wind.json');     // returns a Promise; never rejects loudly
 *     wind.setVisible(true | false);
 *     wind.destroy();                  // optional teardown
 *
 * Design notes:
 *   - A single absolutely-positioned <canvas> is inserted over the map canvas.
 *     It has pointer-events:none so it never blocks map gestures.
 *   - Particles live in GEOGRAPHIC space (lon/lat) and are advected by the
 *     bilinearly-interpolated u/v field, then projected to screen with
 *     map.project() every frame. This keeps motion correct at any zoom,
 *     pitch, or rotation, and survives MapLibre's globe/mercator projections.
 *   - Trails fade via a translucent fill drawn over the previous frame.
 *   - Color ramps teal -> amber -> red by speed (knots).
 *   - Animation pauses during continuous map interaction (movestart/zoom etc.)
 *     and the canvas is simply re-projected; particles resume on moveend.
 *   - Missing / empty / malformed wind.json is handled gracefully (no throw,
 *     no crash) — the layer just stays empty until valid data arrives.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // ---- Tunables -----------------------------------------------------------
  // Tuned to the Windy look: SHORT, SPARSE, SLOW white streaks (not long/dense/fast).
  var DEFAULTS = {
    particleCount: 7000,   // cap; actual count scales with canvas area (see _resize)
    maxParticleAge: 50,    // shorter life -> shorter streaks + more frequent respawns
    fadeOpacity: 0.85,     // faster fade -> short tails (not long silky trails)
    lineWidth: 0.9,
    speedFactor: 0.073,    // very gentle drift — ~0.66x of 0.11
    frameRate: 60,         // target fps (rAF-driven; soft cap)
    minVisibleZoomStep: 0  // reserved
  };

  // Wind-speed colour (knots -> css) comes from the single shared ramp (web/wx-ramp.js) so the
  // particles match the scalar field EXACTLY (CLIENT-14) — no local ramp copy to drift out of sync.
  function rampColor(spd) {
    var R = (typeof window !== 'undefined') && window.HelmWxRamp;
    if (R) return R.rampCss('wind', spd > 0 ? spd : 0);
    return 'rgb(255,255,255)';   // wx-ramp.js must load first; white reads as visibly-wrong, not silently off-palette
  }

  // Precompute a small palette of color buckets so we can batch strokes by
  // color (one beginPath/stroke per bucket) instead of per particle.
  var COLOR_BUCKETS = 24;          // knots resolution: 0..48 in 2kn steps
  var BUCKET_MAX_KN = 48;
  var bucketColors = [];
  for (var bi = 0; bi < COLOR_BUCKETS; bi++) {
    bucketColors.push(rampColor((bi + 0.5) / COLOR_BUCKETS * BUCKET_MAX_KN));
  }
  function bucketIndex(spd) {
    var idx = Math.floor(spd / BUCKET_MAX_KN * COLOR_BUCKETS);
    if (idx < 0) idx = 0;
    if (idx >= COLOR_BUCKETS) idx = COLOR_BUCKETS - 1;
    return idx;
  }

  // ---- Wind field (VELOCITY format) --------------------------------------
  function WindField() {
    this.valid = false;
  }

  // Build from the two-object VELOCITY array. Returns true on success.
  WindField.prototype.build = function (arr) {
    this.valid = false;
    if (!Array.isArray(arr) || arr.length < 2) return false;

    var uComp = null, vComp = null;
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (!c || !c.header || !Array.isArray(c.data)) continue;
      var pn = c.header.parameterNumber;
      if (pn === 2) uComp = c;
      else if (pn === 3) vComp = c;
    }
    // Fallback: if parameterNumber missing, assume [U, V] order.
    if (!uComp || !vComp) {
      if (arr[0] && arr[0].header && arr[1] && arr[1].header) {
        uComp = uComp || arr[0];
        vComp = vComp || arr[1];
      } else {
        return false;
      }
    }

    var h = uComp.header;
    var nx = h.nx | 0, ny = h.ny | 0;
    if (nx <= 0 || ny <= 0) return false;
    if (uComp.data.length < nx * ny || vComp.data.length < nx * ny) return false;

    this.nx = nx;
    this.ny = ny;
    // lo1/la1 = NW corner (west, north); lo2/la2 = SE corner (east, south).
    this.lo1 = +h.lo1;
    this.la1 = +h.la1;
    // dx/dy: degrees per cell. Derive from corners if absent/zero for safety.
    var dx = +h.dx, dy = +h.dy;
    var lo2 = (h.lo2 != null) ? +h.lo2 : (this.lo1 + dx * (nx - 1));
    var la2 = (h.la2 != null) ? +h.la2 : (this.la1 - dy * (ny - 1));
    if (!isFinite(dx) || dx === 0) dx = (lo2 - this.lo1) / (nx - 1 || 1);
    if (!isFinite(dy) || dy === 0) dy = (this.la1 - la2) / (ny - 1 || 1);
    this.dx = dx;
    this.dy = dy;       // positive: degrees latitude per row going SOUTH
    this.lo2 = lo2;
    this.la2 = la2;

    this.u = uComp.data;
    this.v = vComp.data;

    // Bounds for fast in-field test (handle either corner ordering).
    this.west  = Math.min(this.lo1, lo2);
    this.east  = Math.max(this.lo1, lo2);
    this.north = Math.max(this.la1, la2);
    this.south = Math.min(this.la1, la2);

    this.valid = true;
    return true;
  };

  // Bilinear-interpolate [u, v] at lat/lon. Returns null if outside the grid. Writes into the
  // provided 2-array `out` to avoid allocation. Arg order (lat, lon) is unified across all weather
  // samplers -- cog.sampleWx(lat,lon,t), HelmWxLive.sampleAt(lat,lon) -- per CLIENT-14.
  WindField.prototype.sample = function (lat, lon, out) {
    if (!this.valid) return null;
    // Fractional grid coordinates. Column increases eastward from lo1;
    // row increases southward from la1.
    var fx = (lon - this.lo1) / this.dx;
    var fy = (this.la1 - lat) / this.dy;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return null;

    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 + 1, y1 = y0 + 1;
    if (x1 > this.nx - 1) x1 = x0;
    if (y1 > this.ny - 1) y1 = y0;
    var gx = fx - x0, gy = fy - y0;

    var nx = this.nx;
    var i00 = y0 * nx + x0, i10 = y0 * nx + x1;
    var i01 = y1 * nx + x0, i11 = y1 * nx + x1;
    var u = this.u, v = this.v;

    var w00 = (1 - gx) * (1 - gy), w10 = gx * (1 - gy);
    var w01 = (1 - gx) * gy,       w11 = gx * gy;

    out[0] = u[i00] * w00 + u[i10] * w10 + u[i01] * w01 + u[i11] * w11;
    out[1] = v[i00] * w00 + v[i10] * w10 + v[i01] * w01 + v[i11] * w11;
    if (!isFinite(out[0]) || !isFinite(out[1])) return null;
    return out;
  };

  // Random lon/lat inside the field bounds.
  WindField.prototype.randomPoint = function (out) {
    out[0] = this.west + Math.random() * (this.east - this.west);
    out[1] = this.south + Math.random() * (this.north - this.south);
    return out;
  };

  // ---- The layer ----------------------------------------------------------
  function HelmWindLayer(map, opts) {
    if (!map) throw new Error('HelmWind requires a MapLibre map instance.');
    this.map = map;
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.field = new WindField();

    this._visible = false;
    this._running = false;
    this._raf = null;
    this._particles = null;
    this._interacting = false;
    this._destroyed = false;
    this._neutral = false;   // true => white particles (color comes from the heatmap field)
    this._neutralAlpha = 0.27; // white-particle opacity (tunable via setOpacity)

    // scratch
    this._uv = [0, 0];
    this._pt = [0, 0];

    this._buildCanvas();
    this._bindMap();
  }

  HelmWindLayer.prototype._buildCanvas = function () {
    var mapCanvas = this.map.getCanvas();
    var container = mapCanvas.parentNode; // .maplibregl-canvas-container
    var c = document.createElement('canvas');
    c.className = 'helm-wind-canvas';
    var s = c.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';   // never block map gestures
    s.zIndex = '1';             // above the GL canvas, below MapLibre controls
    s.display = 'none';
    this.canvas = c;
    this.ctx = c.getContext('2d');
    (container || mapCanvas.parentNode).appendChild(c);
    this._resize();
  };

  HelmWindLayer.prototype._resize = function () {
    if (this._destroyed) return;
    var mapCanvas = this.map.getCanvas();
    // Logical CSS pixels (map.project returns CSS px, so we keep ctx in CSS px
    // and only scale the backing store for crispness).
    var w = mapCanvas.clientWidth || mapCanvas.width;
    var h = mapCanvas.clientHeight || mapCanvas.height;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._clear();
    // Particle budget scales with area so big screens aren't starved and
    // small screens aren't overworked.
    // Sparser field than before — Windy-like spacing ("fewer and farther between").
    this._budget = Math.round(
      Math.max(550, Math.min(this.opts.particleCount, (w * h) / 1050))
    );
    if (this._particles) this._initParticles();
  };

  HelmWindLayer.prototype._clear = function () {
    this.ctx.clearRect(0, 0, this._w, this._h);
  };

  HelmWindLayer.prototype._bindMap = function () {
    var self = this;
    this._onResize = function () { self._resize(); };
    this._onMoveStart = function () {
      self._interacting = true;
      // Hide stale trails while the map is moving under us.
      self._clear();
    };
    this._onMove = function () {
      // Keep canvas visually aligned: clear so we don't smear during pan.
      if (self._interacting) self._clear();
    };
    this._onMoveEnd = function () {
      self._interacting = false;
      if (self._visible) self._initParticles();
    };

    this.map.on('resize', this._onResize);
    this.map.on('movestart', this._onMoveStart);
    this.map.on('move', this._onMove);
    this.map.on('moveend', this._onMoveEnd);
    // zoom/rotate/pitch all emit move*, so the above covers them.
  };

  HelmWindLayer.prototype._unbindMap = function () {
    this.map.off('resize', this._onResize);
    this.map.off('movestart', this._onMoveStart);
    this.map.off('move', this._onMove);
    this.map.off('moveend', this._onMoveEnd);
  };

  // Initialize / reseed the particle pool for the current view.
  HelmWindLayer.prototype._initParticles = function () {
    if (!this.field.valid) { this._particles = []; return; }
    var n = this._budget;
    var ps = this._particles && this._particles.length === n
      ? this._particles
      : new Array(n);
    for (var i = 0; i < n; i++) {
      ps[i] = ps[i] || { lon: 0, lat: 0, age: 0, px: 0, py: 0, spd: 0, on: false };
      this._spawn(ps[i], true);
    }
    this._particles = ps;
  };

  // (Re)spawn a single particle at a random in-field, in-view location.
  HelmWindLayer.prototype._spawn = function (p, randomAge) {
    // Bias spawns toward the current viewport so particles are visible, but
    // clamp to field bounds so we always have valid wind to sample.
    var lon, lat, tries = 0;
    var bounds = this._viewBounds();
    do {
      if (bounds) {
        lon = bounds.w + Math.random() * (bounds.e - bounds.w);
        lat = bounds.s + Math.random() * (bounds.n - bounds.s);
      } else {
        this.field.randomPoint(this._pt);
        lon = this._pt[0]; lat = this._pt[1];
      }
      tries++;
    } while (
      tries < 4 &&
      (lon < this.field.west || lon > this.field.east ||
       lat < this.field.south || lat > this.field.north)
    );
    p.lon = lon;
    p.lat = lat;
    p.age = randomAge ? (Math.random() * this.opts.maxParticleAge) | 0 : 0;
    p.on = false;
    p.spd = 0;
  };

  // Current map viewport in lon/lat, intersected with the field bounds.
  HelmWindLayer.prototype._viewBounds = function () {
    try {
      var b = this.map.getBounds();
      var w = Math.max(b.getWest(), this.field.west);
      var e = Math.min(b.getEast(), this.field.east);
      var s = Math.max(b.getSouth(), this.field.south);
      var n = Math.min(b.getNorth(), this.field.north);
      if (e <= w || n <= s) return null; // no overlap with field
      return { w: w, e: e, s: s, n: n };
    } catch (err) {
      return null;
    }
  };

  // One simulation + render step.
  HelmWindLayer.prototype._frame = function () {
    if (!this._running) return;
    this._raf = global.requestAnimationFrame(this._frameBound);

    if (this._interacting || !this.field.valid || !this._particles) return;

    var ctx = this.ctx;
    var W = this._w, H = this._h;
    var map = this.map;
    var ps = this._particles;
    var uv = this._uv;
    var maxAge = this.opts.maxParticleAge;
    var speedFactor = this.opts.speedFactor;

    // 1) Fade previous frame to create trails.
    var prevComp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,' + this.opts.fadeOpacity + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = prevComp;

    // metres-per-pixel-ish: convert advection in lon/lat. We advance the
    // particle in geographic space scaled so motion reads well on screen at
    // the current zoom. Degrees-per-pixel from the map's current resolution.
    var degPerPx = this._degreesPerPixel();
    if (!degPerPx) degPerPx = 0.00001;
    var latRad = (this.map.getCenter().lat * Math.PI) / 180;
    var cosLat = Math.max(0.15, Math.cos(latRad));

    // Buckets of line segments keyed by color, drawn in one pass.
    var segs = this._segs || (this._segs = []);
    for (var b = 0; b < COLOR_BUCKETS; b++) {
      (segs[b] || (segs[b] = [])).length = 0;
    }

    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];

      if (p.age >= maxAge) { this._spawn(p, false); }

      // Sample wind at the particle's geographic position.
      var s = this.field.sample(p.lat, p.lon, uv);   // CLIENT-14: unified (lat, lon) arg order
      // Out of field: respawn somewhere valid and skip drawing this frame.
      // (_spawn already zeroes age, so it lives a full life next frame.)
      if (!s) { this._spawn(p, false); continue; }

      var u = uv[0], v = uv[1];          // knots, east / north
      var spd = Math.sqrt(u * u + v * v);

      // Project current position to screen.
      var pt = map.project([p.lon, p.lat]);
      var x0 = pt.x, y0 = pt.y;

      // Step in geographic space. Scale so that the per-frame pixel step is
      // proportional to speed but bounded for stability. We translate a
      // desired pixel step into degrees via degPerPx.
      // Pixel step magnitude (knots -> px/frame), gently compressed.
      var pxStep = spd * speedFactor;          // px this frame at this zoom
      if (pxStep > 8) pxStep = 8 + (pxStep - 8) * 0.3; // soft clamp fast wind
      var stepDeg = pxStep * degPerPx;
      // u is east (+lon), v is north (+lat). dlon scales by 1/cosLat.
      var inv = spd > 1e-6 ? 1 / spd : 0;
      var dlon = (u * inv) * stepDeg / cosLat;
      var dlat = (v * inv) * stepDeg;

      var nlon = p.lon + dlon;
      var nlat = p.lat + dlat;

      // If it left the field, respawn at a fresh in-field position.
      if (nlon < this.field.west || nlon > this.field.east ||
          nlat < this.field.south || nlat > this.field.north) {
        this._spawn(p, false);
      } else {
        var pt2 = map.project([nlon, nlat]);
        var x1 = pt2.x, y1 = pt2.y;
        // Only draw if at least one endpoint is on-screen (cheap cull).
        if ((x0 >= -20 && x0 <= W + 20 && y0 >= -20 && y0 <= H + 20) ||
            (x1 >= -20 && x1 <= W + 20 && y1 >= -20 && y1 <= H + 20)) {
          var bk = bucketIndex(spd);
          var arr = segs[bk];
          arr.push(x0, y0, x1, y1);
        }
        p.lon = nlon;
        p.lat = nlat;
      }
      p.age++;
    }

    // 2) Draw all segments, batched by color bucket: a soft glow underlay + a
    //    crisp core, with the line growing thicker for stronger wind.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var base = this.opts.lineWidth;
    for (var bk2 = 0; bk2 < COLOR_BUCKETS; bk2++) {
      var arr2 = segs[bk2];
      if (!arr2.length) continue;
      ctx.beginPath();
      for (var k = 0; k < arr2.length; k += 4) {
        ctx.moveTo(arr2[k], arr2[k + 1]);
        ctx.lineTo(arr2[k + 2], arr2[k + 3]);
      }
      var w2 = base * (0.85 + (bk2 / COLOR_BUCKETS) * 1.2);
      ctx.strokeStyle = this._neutral ? 'rgba(255,255,255,' + this._neutralAlpha + ')' : bucketColors[bk2];
      ctx.globalAlpha = 0.04;          // soft glow halo
      ctx.lineWidth = w2 * 3.2;
      ctx.stroke();
      ctx.globalAlpha = 1;             // crisp core
      ctx.lineWidth = w2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  // Degrees-per-CSS-pixel at the map center, used to convert pixel motion to
  // geographic steps so particle speed reads consistently across zooms.
  HelmWindLayer.prototype._degreesPerPixel = function () {
    try {
      var c = this.map.getCenter();
      var a = this.map.project([c.lng, c.lat]);
      var bLng = c.lng + 0.001;
      var bb = this.map.project([bLng, c.lat]);
      var dpx = Math.hypot(bb.x - a.x, bb.y - a.y);
      if (dpx > 1e-6) return 0.001 / dpx;
    } catch (e) {}
    return null;
  };

  // ---- Lifecycle ----------------------------------------------------------
  HelmWindLayer.prototype._start = function () {
    if (this._running || this._destroyed) return;
    this._running = true;
    this._frameBound = this._frame.bind(this);
    this._raf = global.requestAnimationFrame(this._frameBound);
  };

  HelmWindLayer.prototype._stop = function () {
    this._running = false;
    if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = null; }
  };

  // ---- Public API ---------------------------------------------------------
  HelmWindLayer.prototype.load = function (url) {
    var self = this;
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('wind.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        var ok = self.field.build(json);
        if (!ok) {
          console.warn('[HelmWind] wind.json present but not a valid VELOCITY grid; layer stays empty.');
          self.field.valid = false;
          return false;
        }
        self._initParticles();
        if (self._visible) {
          // Data arrived after the layer was switched on: clear stale frame
          // and make sure the rAF loop is running.
          self._clear();
          self._start();
        }
        return true;
      })
      .catch(function (err) {
        // Missing / empty / malformed: degrade gracefully, never crash.
        console.warn('[HelmWind] could not load wind data:', err && err.message ? err.message : err);
        self.field.valid = false;
        self._particles = [];
        return false;
      });
  };

  // Feed an in-memory leaflet-velocity grid (same shape load() fetches). Lets the Live fetch-on-pan
  // mode (wx-live.js) drive the particles over the current VIEWPORT — the windgl/Windy approach where
  // the GPU particle field re-renders to fill the screen at any zoom, instead of one fixed-bbox patch.
  HelmWindLayer.prototype.setData = function (json) {
    var ok = this.field.build(json);
    if (!ok) { this.field.valid = false; this._particles = []; return false; }
    this._initParticles();
    if (this._visible) { this._clear(); this._start(); }
    return true;
  };

  HelmWindLayer.prototype.setVisible = function (v) {
    v = !!v;
    if (v === this._visible) return;
    this._visible = v;
    if (this._destroyed) return;
    if (v) {
      this.canvas.style.display = 'block';
      this._resize();
      if (this.field.valid && (!this._particles || !this._particles.length)) {
        this._initParticles();
      }
      this._start();
    } else {
      this._stop();
      this._clear();
      this.canvas.style.display = 'none';
    }
  };

  HelmWindLayer.prototype.isVisible = function () { return this._visible; };
  HelmWindLayer.prototype.setNeutral = function (v) { this._neutral = !!v; };
  HelmWindLayer.prototype.setOpacity = function (a) { this._neutralAlpha = Math.max(0.03, Math.min(0.95, a)); };

  HelmWindLayer.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stop();
    this._unbindMap();
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
    this._particles = null;
  };

  // ---- Factory ------------------------------------------------------------
  function HelmWind(map, opts) {
    return new HelmWindLayer(map, opts);
  }
  HelmWind.Layer = HelmWindLayer;

  // UMD-ish export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HelmWind;
  } else {
    global.HelmWind = HelmWind;
  }
})(typeof window !== 'undefined' ? window : this);
