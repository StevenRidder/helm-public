// HelmNav — a SIMULATED navigation feed for the prototype.
//
// IMPORTANT: the object passed to onState() is the EXACT contract the real Helm Engine
// will emit over ws://127.0.0.1 (Phase 3). To go live, replace this module with a
// WebSocket that yields the same shape — the UI does not change. The geometry here
// (BRG / DTW / XTE / arrival / auto-advance) mirrors what OpenCPN's model/ Routeman
// computes, which we proved runs headless in spike/opencpn-headless/.
(function () {
  const R = 3440.065;                         // earth radius, nautical miles
  const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;

  function dist(a, b) {                        // great-circle NM
    const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function brg(a, b) {                         // initial bearing, degrees
    const y = Math.sin(toR(b.lon - a.lon)) * Math.cos(toR(b.lat));
    const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) -
      Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(toR(b.lon - a.lon));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }
  const interp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
  function fmtPos(p) {
    const f = (v, pos, neg) => {
      const h = v >= 0 ? pos : neg; v = Math.abs(v);
      const d = Math.floor(v), m = ((v - d) * 60).toFixed(1);
      return d + '°' + m + '′' + h;
    };
    return f(p.lat, 'N', 'S') + ' · ' + f(p.lon, 'E', 'W');
  }
  const fmtNM = nm => (nm < 1 ? (Math.round(nm * 100) / 100) : (Math.round(nm * 10) / 10)) + ' NM';

  // onState: called ~1 Hz with the engine-shaped state object. Returns the interval id.
  window.HelmNav = function (onState, opts) {
    opts = opts || {};
    const route = opts.route || [                 // SIM-ONLY demo route (HELM_SIM); not used on the live screen
      { lat: 24.770, lon: -81.580, name: 'WP1 · start' },
      { lat: 24.792, lon: -81.515, name: 'WP2 · sea buoy' },
      { lat: 24.812, lon: -81.448, name: 'WP3 · channel' },
      { lat: 24.835, lon: -81.375, name: 'WP4 · pass' },
      { lat: 24.856, lon: -81.302, name: 'WP5 · marina' }
    ];
    const legLen = []; let total = 0;
    for (let i = 0; i < route.length - 1; i++) { const L = dist(route[i], route[i + 1]); legLen.push(L); total += L; }

    let along = 0;                                 // NM travelled from the start
    const t0 = Date.now();

    function tick() {
      const t = Date.now();
      const sog = 5.6 + Math.sin((t - t0) / 9000) * 0.9;   // gentle 4.7–6.5 kn
      along += sog / 3600;                                  // NM per second
      if (along >= total) along = 0;                        // loop the leg for the demo

      let acc = 0, li = 0;
      while (li < legLen.length - 1 && acc + legLen[li] < along) { acc += legLen[li]; li++; }
      const f = legLen[li] ? (along - acc) / legLen[li] : 0;
      const A = route[li], B = route[li + 1];
      const pos = interp(A, B, f);

      const cog = Math.round(brg(A, B));
      const hdg = (cog + Math.round(Math.sin(t / 7000) * 4) + 360) % 360;   // small yaw
      const dtw = dist(pos, B);
      let dtg = dtw; for (let k = li + 1; k < legLen.length; k++) dtg += legLen[k];

      // cross-track error off the A→B leg (great-circle)
      const d13 = dist(A, pos) / R, th13 = toR(brg(A, pos)), th12 = toR(brg(A, B));
      const xteM = Math.round(Math.abs(Math.asin(Math.sin(d13) * Math.sin(th13 - th12)) * R) * 1852);

      const etaDate = new Date(t + (dtg / Math.max(0.1, sog)) * 3600 * 1000);
      const eta = etaDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' +
                  etaDate.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      const ttgMin = Math.round((dtg / Math.max(0.1, sog)) * 60);
      const ttg = ttgMin < 60 ? ttgMin + 'm'
                : ttgMin < 1440 ? (Math.floor(ttgMin / 60) + 'h ' + String(ttgMin % 60).padStart(2, '0') + 'm')
                : (Math.floor(ttgMin / 1440) + 'd ' + Math.floor((ttgMin % 1440) / 60) + 'h');
      const vmg = (sog * Math.cos(toR(brg(pos, B) - cog))).toFixed(1) + ' kn';   // velocity made good to WP

      const windSpd = 14 + Math.sin(t / 11000) * 3;
      const windDir = Math.round((95 + Math.sin(t / 13000) * 10 + 360) % 360);
      const depth = 6 + (1 - f) * 8 + Math.sin(t / 5000) * 0.6;             // shoals toward the marina

      const legs = [];
      for (let k = li + 1; k < route.length; k++) {
        const from = k === li + 1 ? pos : route[k - 1];
        legs.push({ name: route[k].name, brg: Math.round(brg(from, route[k])) + '°', active: k === li + 1 });
      }

      onState({
        pos, posStr: fmtPos(pos), sog, cog, hdg, depth,
        wind: { spd: windSpd, dir: windDir, range: Math.round(windSpd - 4) + '–' + Math.round(windSpd + 8) + ' kt' },
        active: {
          name: 'Route to Marina', eta, ttg, vmg, dtg: fmtNM(dtg), xte: xteM + ' m',
          legs,
          nextWp: route[li + 1].name.split(' · ')[0] + ' · ' + fmtNM(dtw)
        }
      });
    }
    tick();
    return setInterval(tick, 1000);
  };
})();
