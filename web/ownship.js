// HelmOwnship — the "feels like a chartplotter" layer: a smooth ownship marker plus a
// follow / course-up / head-up camera, range rings and a speed-scaled predictor vector.
//
//  • Eases the DISPLAYED position + heading toward each ~1 Hz fix on every animation frame,
//    so the boat GLIDES instead of teleporting once a second.
//  • FOLLOW MODE (⌖): continuously keeps the vessel centred (with a look-ahead offset so the
//    boat sits low on screen and you see where you're going). Re-centring is GUARDED so it
//    never fights your hand — any manual pan/rotate suspends follow, and the ⌖ button
//    re-engages it. The camera is only nudged when the boat has actually drifted, and never
//    while a previous nudge is still animating, so the chart stays calm.
//  • ORIENTATION (N/C/H): north-up (bearing 0), course-up (chart rotates to COG) or head-up
//    (chart rotates to heading). Bearing is eased smoothly, not snapped, so it never jitters.
//  • RANGE RINGS + PREDICTOR: concentric distance rings centred on the boat plus a vector
//    showing the predicted position N minutes ahead at the current speed/course.
//  • NEVER extrapolates the MARKER past the latest fix. When the feed goes stale/offline the
//    boat simply stops at the last known position — marker motion is never fabricated ahead of
//    real data. (The predictor vector is an explicit, labelled estimate — not the boat itself.)
(function () {
  function easeAngle(cur, tgt, k) {                 // shortest-path angular ease (degrees)
    const d = ((tgt - cur + 540) % 360) - 180;
    return cur + d * k;
  }
  function angDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }   // |Δ| in degrees, 0..180

  // dead-reckon a lat/lon `nm` nautical miles along bearing `brgDeg` (great-circle, plenty exact at this range)
  function project(lat, lon, brgDeg, nm) {
    const R = 3440.065;                              // earth radius in NM
    const br = brgDeg * Math.PI / 180, d = nm / R;
    const la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [lo2 * 180 / Math.PI, la2 * 180 / Math.PI];
  }
  // a closed ring polyline of radius `nm` around lat/lon
  function ring(lat, lon, nm, steps) {
    steps = steps || 64;
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(project(lat, lon, i * 360 / steps, nm));
    return pts;
  }

  window.HelmOwnship = function (map, opts) {
    opts = opts || {};
    const lookahead = opts.lookahead != null ? opts.lookahead : 0.30;   // top-padding fraction → boat sits low → see ahead
    const predictMin = opts.predictMin != null ? opts.predictMin : 6;   // predictor reach, minutes ahead
    let target = null, disp = null;                 // latest fix vs eased display state
    let sog = 0;                                    // latest speed over ground (kn) for the predictor
    let follow = (opts.follow != null) ? !!opts.follow : false;   // ⌖ engages continuous follow
    let orient = 0;                                 // 0 = north-up, 1 = course-up (COG), 2 = head-up (heading)
    let active = true, framedOnce = opts.frameOnFirstFix === false; // active=false → frozen; framedOnce → FIRST fix frames the boat
    let dispBearing = 0;                            // eased chart bearing we drive toward
    let showRings = (opts.rings != null) ? !!opts.rings : false;

    // --- guard so our OWN camera moves are never mistaken for the user's hand -----------------
    // We mark a short window around every camera op WE issue. Within that window (and for any move
    // event that carries no originalEvent, i.e. wasn't driven by a hand) gestures are ignored. A
    // timestamp window — not a balanced +/- counter — so overlapping eased moves can't leak the
    // guard or false-trip on the user. `easing` blocks stacking follow nudges on top of each other.
    let programmaticUntil = 0;                       // performance.now() ms until which moves are ours
    let easing = false;                             // a follow nudge is mid-flight (don't stack easeTo)
    const now = () => (window.performance ? performance.now() : Date.now());
    const isProgrammatic = () => now() < programmaticUntil;
    const drive = (fn, holdMs) => { programmaticUntil = Math.max(programmaticUntil, now() + (holdMs || 80)); fn(); };
    map.on('moveend', () => { easing = false; });
    // ANY user-initiated translate/rotate gesture drops follow. The presence of a real
    // `originalEvent` is authoritative: our programmatic easeTo/setBearing NEVER carry one, so a
    // gesture that has one is the user's hand even if it lands inside our guard window. Gestures
    // with no originalEvent (our own / synthetic) are ignored.
    const userGesture = (e) => {
      if (!e || e.originalEvent == null) return;    // our own nudge / synthetic — not a real hand
      if (follow) dropFollow();
    };
    ['dragstart', 'rotatestart', 'pitchstart'].forEach(ev => map.on(ev, userGesture));
    // A user wheel/pinch ZOOM is allowed to keep follow (you often zoom while following) — only
    // translation/rotation releases it, so following + zooming feels natural.

    const el = document.createElement('div');
    el.className = 'ownship';
    el.setAttribute('aria-label', 'Your boat');
    el.style.cssText = 'width:46px;height:46px;position:relative;pointer-events:none;will-change:transform;' +
      'filter:drop-shadow(0 0 7px rgba(91,192,255,.72)) drop-shadow(0 2px 2px rgba(0,0,0,.72));';
    el.innerHTML =
      '<div style="position:absolute;left:50%;top:3px;width:0;height:0;margin-left:-13px;' +
        'border-left:13px solid transparent;border-right:13px solid transparent;border-bottom:34px solid #06121d;' +
        'filter:drop-shadow(0 2px 2px rgba(0,0,0,.65));"></div>' +
      '<div style="position:absolute;left:50%;top:7px;width:0;height:0;margin-left:-9px;' +
        'border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:26px solid #fff;"></div>' +
      '<div style="position:absolute;left:50%;top:11px;width:3px;height:18px;margin-left:-1.5px;' +
        'background:#06121d;border-radius:2px;opacity:.9;"></div>';
    const marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' });
    const label = document.createElement('div');
    label.className = 'ownship-label';
    label.textContent = 'YOU';
    label.style.cssText = 'pointer-events:none;padding:2px 5px;border-radius:999px;background:rgba(5,12,20,.88);' +
      'border:1px solid rgba(255,255,255,.95);box-shadow:0 0 0 2px rgba(91,192,255,.65),0 2px 8px rgba(0,0,0,.45);' +
      'color:#fff;font:800 9px/1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.08em;text-shadow:0 1px 1px #000;';
    const labelMarker = new maplibregl.Marker({ element: label, anchor: 'bottom', offset: [0, -28] });
    let added = false, labelAdded = false;

    // --- range rings + predictor vector: one GeoJSON source we keep refreshed -----------------
    const SRC = 'helm-ownship-overlay';
    const RING_NM = [0.25, 0.5, 1];                 // concentric ring radii (NM)
    function ensureOverlay() {
      if (!map || map.getSource(SRC)) return;
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'helm-ownship-rings', type: 'line', source: SRC,
        filter: ['==', ['get', 'kind'], 'ring'],
        paint: { 'line-color': '#5bc0ff', 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [2, 3] },
      });
      map.addLayer({
        id: 'helm-ownship-predictor', type: 'line', source: SRC,
        filter: ['==', ['get', 'kind'], 'predictor'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#9ad8ff', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [1.5, 1.5] },
      });
    }
    function overlayData() {
      const feats = [];
      if (disp) {
        if (showRings) for (const nm of RING_NM)
          feats.push({ type: 'Feature', properties: { kind: 'ring' },
            geometry: { type: 'LineString', coordinates: ring(disp.lat, disp.lon, nm) } });
        // predictor vector: where we'll be `predictMin` minutes ahead at current SOG along COG
        const reachNM = (sog || 0) * (predictMin / 60);
        if (reachNM > 0.01) {
          const tip = project(disp.lat, disp.lon, disp.cog, reachNM);
          feats.push({ type: 'Feature', properties: { kind: 'predictor' },
            geometry: { type: 'LineString', coordinates: [[disp.lon, disp.lat], tip] } });
        }
      }
      return { type: 'FeatureCollection', features: feats };
    }
    // --- overlay redraw gating: rebuild the rings/predictor source only when something VISIBLE
    // changed (pose moved, COG/SOG changed, or rings toggled) instead of ~60×/s. Thresholds are tiny
    // (sub-metre / sub-degree) so the overlay stays glued to the gliding marker while moving — the win
    // is eliminating the churn when the boat is settled/stationary (anchored, paused, stale, no fix).
    const OVL_POS_EPS = 1e-6;     // deg (~0.1 m) — "did the boat actually move"
    const OVL_COG_EPS = 0.05;     // deg — predictor direction
    const OVL_SOG_EPS = 0.05;     // kn  — predictor length
    let lastOvlLat = null, lastOvlLon = null, lastOvlCog = 0, lastOvlSog = 0, lastOvlRings = showRings;
    function redrawOverlay() {     // force a rebuild (rings-toggle handlers route here; the gated tick too)
      try { ensureOverlay(); const s = map.getSource(SRC); if (s) s.setData(overlayData()); } catch (e) {}
      if (disp) { lastOvlLat = disp.lat; lastOvlLon = disp.lon; lastOvlCog = disp.cog; }
      lastOvlSog = sog; lastOvlRings = showRings;
    }
    function tickOverlay() {       // per-frame: skip the setData unless something visible actually changed
      if (!disp) return;
      if (showRings !== lastOvlRings || lastOvlLat == null
          || Math.abs(disp.lat - lastOvlLat) > OVL_POS_EPS || Math.abs(disp.lon - lastOvlLon) > OVL_POS_EPS
          || angDiff(disp.cog, lastOvlCog) > OVL_COG_EPS || Math.abs(sog - lastOvlSog) > OVL_SOG_EPS) {
        redrawOverlay();
      }
    }
    if (map.isStyleLoaded && map.isStyleLoaded()) ensureOverlay(); else map.on('load', ensureOverlay);

    // --- controls as a maplibre control group (bottom-right) ----------------------------------
    const group = document.createElement('div');
    group.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const mk = (label, title) => {
      const b = document.createElement('button'); b.type = 'button'; b.title = title; b.textContent = label;
      b.style.cssText = 'font:600 15px system-ui;color:#cfe6ff;touch-action:manipulation;';
      return b;
    };
    const followBtn = mk('⌖', 'Center on boat / follow');
    const modeBtn = mk('N', 'North-up / course-up / head-up');
    const ringsBtn = mk('◎', 'Range rings');
    group.appendChild(followBtn); group.appendChild(modeBtn); group.appendChild(ringsBtn);
    map.addControl({ onAdd() { return group; }, onRemove() { group.remove(); } }, 'bottom-right');

    const ACCENT = '#5bc0ff';
    const ORIENT_LABEL = ['N', 'C', 'H'];
    const ORIENT_TITLE = ['North-up', 'Course-up', 'Head-up'];
    const paint = () => {
      followBtn.style.color = follow ? ACCENT : '#cfe6ff';
      modeBtn.textContent = ORIENT_LABEL[orient];
      modeBtn.style.color = orient ? ACCENT : '#cfe6ff';
      modeBtn.title = ORIENT_TITLE[orient] + ' (tap to cycle)';
      ringsBtn.style.color = showRings ? ACCENT : '#cfe6ff';
    };

    function applyPadding() {
      // Bias the boat low on screen while following so you see more water ahead.
      const top = follow ? Math.round(map.getCanvas().clientHeight * lookahead) : 0;
      drive(() => map.setPadding({ top, bottom: 0, left: 0, right: 0 }));
    }
    function dropFollow() {
      if (!follow) return;
      follow = false;
      drive(() => map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }));
      paint();
    }
    function engageFollow() {
      follow = true;
      framedOnce = true;                            // we're taking the camera now
      applyPadding();
      if (disp) recenterNow(600);
      paint();
    }
    function recenterNow(duration) {
      if (!disp) return;
      easing = true;
      // hold the guard for the whole ease (+ a little slack) so the move it generates is ours
      drive(() => map.easeTo({ center: [disp.lon, disp.lat], duration: duration, essential: true }), duration + 120);
    }

    followBtn.addEventListener('click', () => { if (follow) dropFollow(); else engageFollow(); });
    modeBtn.addEventListener('click', () => {
      orient = (orient + 1) % 3;                     // N → Course-up → Head-up → N
      if (orient === 0) drive(() => map.easeTo({ bearing: 0, duration: 400, essential: true }));
      paint();
    });
    ringsBtn.addEventListener('click', () => { showRings = !showRings; paint(); redrawOverlay(); });
    paint();

    // distance (px) the boat has drifted from the camera's target point — decides whether to nudge
    function driftPx() {
      const c = map.project([disp.lon, disp.lat]);
      const pad = map.getPadding ? map.getPadding() : { top: 0, bottom: 0, left: 0, right: 0 };
      const cx = (map.getCanvas().clientWidth + (pad.left || 0) - (pad.right || 0)) / 2;
      const cy = (map.getCanvas().clientHeight + (pad.top || 0) - (pad.bottom || 0)) / 2;
      return Math.hypot(c.x - cx, c.y - cy);
    }

    function frame() {
      requestAnimationFrame(frame);
      if (!target) return;
      if (!disp) disp = { lat: target.lat, lon: target.lon, cog: target.cog, hdg: target.hdg };
      const k = active ? 0.14 : 0.30;
      disp.lat += (target.lat - disp.lat) * k;
      disp.lon += (target.lon - disp.lon) * k;
      disp.cog = easeAngle(disp.cog, target.cog, k);
      disp.hdg = easeAngle(disp.hdg, target.hdg, k);
      try {
        if (!added) { marker.setLngLat([disp.lon, disp.lat]).addTo(map); added = true; }
        if (!labelAdded) { labelMarker.setLngLat([disp.lon, disp.lat]).addTo(map); labelAdded = true; }
        // The marker always points where the BOAT points (heading if we have it, else COG).
        marker.setLngLat([disp.lon, disp.lat]).setRotation(disp.hdg != null ? disp.hdg : disp.cog);
        labelMarker.setLngLat([disp.lon, disp.lat]);   // the "YOU" label rides upright above the boat
        tickOverlay();

        // ORIENTATION — ease the chart bearing toward the target (course-up: COG, head-up: heading).
        if (orient !== 0) {
          const tgtBearing = orient === 1 ? disp.cog : (disp.hdg != null ? disp.hdg : disp.cog);
          dispBearing = easeAngle(dispBearing, tgtBearing, 0.12);
          // push to the map only when it's meaningfully off + not mid-gesture (avoids jitter)
          if (!isProgrammatic() && angDiff(map.getBearing(), dispBearing) > 0.4) {
            drive(() => map.setBearing(dispBearing), 60);   // setBearing fires move events synchronously
          }
        } else {
          dispBearing = map.getBearing();           // keep our state in sync while north-up
        }

        // FOLLOW — guarded continuous re-centre. Never while one is in flight, never mid-gesture,
        // and only once the boat has actually drifted off the target point. This is what keeps it
        // from freezing the user's pan: we do NOT touch the camera every frame.
        if (follow && active && !easing && !isProgrammatic() && driftPx() > 18) {
          recenterNow(450);
        }

        if (!framedOnce) {            // ONE-TIME: bring the boat into view on the first fix.
          framedOnce = true;
          if (follow) { applyPadding(); recenterNow(600); }
          else drive(() => map.easeTo({ center: [disp.lon, disp.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 }));
        }
      } catch (e) { /* map not ready this frame */ }
    }
    requestAnimationFrame(frame);

    return {
      update(s) {
        if (s && s.pos) {
          const cog = (s.cog != null ? +s.cog : (target ? target.cog : 0));
          // HONEST HEADING: trust s.hdg ONLY when it comes from a REAL source. The engine emits
          // hdg:0 with sources.hdg:"missing" when no compass is wired (and "simulated" in pure sim),
          // which would otherwise peg the bow to north. With no real heading, point along the real
          // track (COG) when moving, and HOLD the last orientation at rest (COG is just noise then).
          const sh = s.sources && s.sources.hdg;
          const hdgReal = (sh === 'nmea' || sh === 'nmea2000' || sh === 'signalk') && s.hdg != null;
          const moving = (s.sog != null ? parseFloat(s.sog) : sog) >= 0.5;
          const hdg = hdgReal ? +s.hdg : (moving ? cog : (target ? target.hdg : cog));
          target = { lat: s.pos.lat, lon: s.pos.lon, cog: cog, hdg: hdg };
          if (s.sog != null) sog = parseFloat(s.sog) || 0;
        }
      },
      setActive(a) { active = !!a; },               // false when the feed is stale/offline → freeze
      recenter() { engageFollow(); },               // command/⌘K entry point: engage follow + centre
      dropFollow() { dropFollow(); },
      isFollowing() { return follow; },
      setOrientation(mode) {                         // 'north' | 'course' | 'head'
        orient = mode === 'course' ? 1 : mode === 'head' ? 2 : 0;
        if (orient === 0) drive(() => map.easeTo({ bearing: 0, duration: 400, essential: true }));
        paint();
      },
      cycleOrientation() { modeBtn.click(); },
      orientation() { return ['north', 'course', 'head'][orient]; },
      toggleRings() { showRings = !showRings; paint(); redrawOverlay(); },
      ringsShown() { return showRings; },
    };
  };

  // --- HelmShell integration: expose follow + orientation + rings as ⌘K commands --------------
  // (Pure UI surface; all map/marker logic stays in this module. Guarded so the module still works
  // if the shell isn't present — e.g. the legacy fallback path.)
  function wireShell() {
    if (!window.HelmShell || !window.HelmShell.registerCommand) return;
    const own = () => window.__ownship;
    HelmShell.registerCommand({
      id: 'helm-ownship-follow', epic: 'OWNSHIP',
      title: 'Center on boat & follow', subtitle: 'Keep the vessel centred',
      keywords: ['center', 'centre', 'follow', 'ownship', 'boat'], group: 'Ownship',
      run() { const o = own(); if (o) o.recenter(); },
    });
    HelmShell.registerCommand({
      id: 'helm-ownship-orient', epic: 'OWNSHIP',
      title: 'Cycle chart orientation', subtitle: 'North-up → Course-up → Head-up',
      keywords: ['orientation', 'course up', 'head up', 'north up', 'rotate', 'heading'], group: 'Ownship',
      run() { const o = own(); if (o) o.cycleOrientation(); },
    });
    HelmShell.registerCommand({
      id: 'helm-ownship-rings', epic: 'OWNSHIP',
      title: 'Toggle range rings', subtitle: 'Concentric distance rings on the boat',
      keywords: ['rings', 'range', 'distance', 'circles'], group: 'Ownship',
      run() { const o = own(); if (o) o.toggleRings(); },
    });
  }
  if (document.readyState !== 'loading') wireShell();
  else document.addEventListener('DOMContentLoaded', wireShell);
})();
