// tactics.js — opposite-tack assist. Given the live TRUE wind (WX-13) it shows the maneuver to switch
// to the other tack: TACK (head up through the wind) or GYBE (bear away through downwind), the turn
// (how much + which way), the heading you'll settle on, and a line on the chart from the boat along
// that heading (green = starboard tack, red = port). The opposite tack is the MIRROR of your heading
// across the wind, NOT a fixed rotation — at a broad reach you GYBE, and a naive turn toward the wind
// would put you head-to-wind / in irons.
//
// INSTRUMENT-ONLY (per the boat's setup): nothing is shown without REAL wind — no forecast or manual
// fallback. It lights up the moment a masthead instrument is on the network (WX-13 already ingests
// NMEA MWV / SignalK / N2K apparent wind and derives true).
(function (root) {
  'use strict';
  var R = 3440.065, D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function norm360(d) { d %= 360; return d < 0 ? d + 360 : d; }
  function num(x) { return typeof x === 'number' && isFinite(x); }

  // PURE (unit-tested): from TRUE wind {twd, twa(signed −180..180), twaSide:'S'|'P'} → the other-tack
  // maneuver. twa = twd − heading (WX-13's convention), so the opposite-tack heading = twd + twa
  // (= reflect the heading across the wind). null if no wind; {irons:true} if ~head to wind.
  function oppositeTack(tw) {
    if (!tw || !num(tw.twd) || !num(tw.twa)) return null;
    var off = Math.abs(tw.twa);                                  // angle off the wind, 0..180
    if (off < 8) return { irons: true };                         // basically head to wind — no clean other tack
    var windSide = tw.twaSide === 'S' ? 'starboard' : 'port';     // side the wind is on = the tack you're on
    // Two ways to the SAME other-tack bearing: TACK heads up through the wind, GYBE bears away through
    // downwind — opposite turns that sum to 360°. The shorter turn is recommended, but BOTH are offered
    // so you can round up the long way instead of gybing in a blow.
    return {
      irons: false,
      oppHeading: Math.round(norm360(tw.twd + tw.twa)),           // the bearing you settle on (both options)
      newTack: windSide === 'starboard' ? 'port' : 'starboard',
      off: Math.round(off),
      tack: { kind: 'tack', dir: windSide === 'starboard' ? 'right' : 'left', turn: Math.round(2 * off) },          // up through the wind
      gybe: { kind: 'gybe', dir: windSide === 'starboard' ? 'left' : 'right', turn: Math.round(2 * (180 - off)) },  // away through downwind
      recommend: off > 90.5 ? 'gybe' : 'tack'                     // shorter turn: tack inside a beam reach, else gybe
    };
  }
  // a point `nm` NM from [lng,lat] along compass bearing `brg` (great-circle)
  function dest(lng, lat, brg, nm) {
    var d = nm / R, b = brg * D2R, la = lat * D2R, lo = lng * D2R;
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [lo2 * R2D, la2 * R2D];
  }

  var api = { oppositeTack: oppositeTack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node / tests
  root.HelmTactics = api;
  if (typeof document === 'undefined') return;                                 // node: stop here

  // ---- browser module ----
  var enabled = false, chip = null, lastNav = null;
  var GREEN = '#46e0a0', RED = '#ff6b6b', TACKCOL = '#6fd0e0', GYBECOL = '#e0a85c', EMPTY = { type: 'FeatureCollection', features: [] };
  var lastResult = { enabled: false, hasWind: false, maneuver: null, lineDrawn: false };
  api._last = function () { return lastResult; };

  function store(k, d) { try { return window.HelmStore ? HelmStore.get(k, d) : d; } catch (e) { return d; } }
  function save(k, v) { try { if (window.HelmStore) HelmStore.set(k, v); } catch (e) {} }
  // The live MapLibre map — fetched lazily (window.map is assigned after our init runs, so never cache it).
  function theMap() { var m = window.map; return (m && typeof m.getSource === 'function') ? m : null; }

  function ensureLayer() {
    var m = theMap(); if (!m || !m.getStyle || !m.getStyle()) return null;
    if (!m.getSource('tack')) {
      m.addSource('tack', { type: 'geojson', data: EMPTY });
      // the two turn-arcs + the current-heading line (data-driven colour/width/opacity), under everything
      m.addLayer({
        id: 'tack-arc', type: 'line', source: 'tack', filter: ['==', ['get', 'kind'], 'arc'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'col'], 'line-width': ['get', 'w'], 'line-opacity': ['get', 'op'] }
      });
      m.addLayer({
        id: 'tack-line', type: 'line', source: 'tack', filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'col'], 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 }
      });
      m.addLayer({
        id: 'tack-end', type: 'symbol', source: 'tack', filter: ['==', ['get', 'kind'], 'end'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -0.8], 'text-allow-overlap': true },
        paint: { 'text-color': ['get', 'col'], 'text-halo-color': 'rgba(5,8,12,0.9)', 'text-halo-width': 1.4 }
      });
      m.addLayer({
        id: 'tack-tag', type: 'symbol', source: 'tack', filter: ['==', ['get', 'kind'], 'tag'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-allow-overlap': true, 'text-letter-spacing': 0.06 },
        paint: { 'text-color': ['get', 'col'], 'text-halo-color': 'rgba(5,8,12,0.9)', 'text-halo-width': 1.4 }
      });
    }
    return m;
  }
  function clearLine() { var m = ensureLayer(); var s = m && m.getSource('tack'); if (s) s.setData(EMPTY); }
  // sample a turn-arc centered on `pos`: bearings from `fromBrg`, rotating by `signed`° (±), at radius `nm`
  function arcCoords(pos, fromBrg, signed, nm) {
    var pts = [], n = 44;
    for (var i = 0; i <= n; i++) pts.push(dest(pos.lon, pos.lat, norm360(fromBrg + signed * i / n), nm));
    return pts;
  }
  // Draw the whole tack picture centered on the boat: the destination line (to the shared bearing), a
  // faint current-heading line, and the TWO turn-arcs — TACK sweeping up through the wind, GYBE bearing
  // away through downwind — recommended one bold, the other faint. `H` = current heading (from the wind).
  function drawTactics(pos, man, H) {
    var m = ensureLayer(); var s = m && m.getSource('tack'); if (!s) return false;
    var destCol = man.newTack === 'starboard' ? GREEN : RED, RAD = 3;       // 3 NM rim around the boat
    var end = dest(pos.lon, pos.lat, man.oppHeading, RAD), cur = dest(pos.lon, pos.lat, H, RAD);
    var tackSigned = (man.tack.dir === 'right' ? 1 : -1) * man.tack.turn;
    var gybeSigned = (man.gybe.dir === 'right' ? 1 : -1) * man.gybe.turn;
    var recTack = man.recommend === 'tack';
    var tagAt = function (signed) { return dest(pos.lon, pos.lat, norm360(H + signed / 2), RAD); };
    s.setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { kind: 'arc', col: '#cfe9ee', w: 1.4, op: 0.45 }, geometry: { type: 'LineString', coordinates: [[pos.lon, pos.lat], cur] } },
      { type: 'Feature', properties: { kind: 'arc', col: TACKCOL, w: recTack ? 3.2 : 2, op: recTack ? 0.95 : 0.4 }, geometry: { type: 'LineString', coordinates: arcCoords(pos, H, tackSigned, RAD) } },
      { type: 'Feature', properties: { kind: 'arc', col: GYBECOL, w: recTack ? 2 : 3.2, op: recTack ? 0.4 : 0.95 }, geometry: { type: 'LineString', coordinates: arcCoords(pos, H, gybeSigned, RAD) } },
      { type: 'Feature', properties: { kind: 'line', col: destCol }, geometry: { type: 'LineString', coordinates: [[pos.lon, pos.lat], end] } },
      { type: 'Feature', properties: { kind: 'end', col: destCol, label: pad3(man.oppHeading) + '°' }, geometry: { type: 'Point', coordinates: end } },
      { type: 'Feature', properties: { kind: 'tag', col: TACKCOL, label: 'TACK' }, geometry: { type: 'Point', coordinates: tagAt(tackSigned) } },
      { type: 'Feature', properties: { kind: 'tag', col: GYBECOL, label: 'GYBE' }, geometry: { type: 'Point', coordinates: tagAt(gybeSigned) } }
    ] });
    return true;
  }

  function pad3(n) { return ('00' + n).slice(-3); }
  // "TACK left 154° to BEARING 283°"
  function fmt(o, bearing) { return o.kind.toUpperCase() + ' ' + o.dir + ' ' + o.turn + '° to BEARING ' + pad3(bearing) + '°'; }
  function setReadout(rec, alt) {
    var r = chip && chip.querySelector('.tk-rec'); if (r) r.textContent = rec;
    var a = chip && chip.querySelector('.tk-alt'); if (a) a.textContent = alt || '';
  }

  function render(s) {
    lastNav = s;
    if (!chip) return;
    if (!enabled) { setReadout('Tack assist', ''); clearLine(); lastResult = { enabled: false, hasWind: false, recommend: null, lineDrawn: false }; return; }
    var noWind = !s || !s.sources || s.sources.wind === 'missing';
    var tw = noWind ? null : (window.HelmTrueWind && HelmTrueWind.fromNav(s));
    var man = tw ? oppositeTack(tw) : null;
    if (!man || man.irons || noWind) {
      setReadout(noWind ? 'Tack — no wind' : (man && man.irons ? 'Tack — head to wind' : 'Tack — …'), '');
      clearLine(); lastResult = { enabled: true, hasWind: !noWind, recommend: null, lineDrawn: false }; return;
    }
    // both ways to the other tack, same bearing — recommended (shorter) on top, the alternative below
    var rec = man[man.recommend], alt = man.recommend === 'tack' ? man.gybe : man.tack;
    setReadout(fmt(rec, man.oppHeading), 'or ' + fmt(alt, man.oppHeading));
    var H = norm360(tw.twd - tw.twa);            // current heading (WX-13: twa = twd − heading)
    var drawn = (s.pos && num(s.pos.lat) && num(s.pos.lon)) ? drawTactics(s.pos, man, H) : (clearLine(), false);
    lastResult = { enabled: true, hasWind: true, recommend: man.recommend, oppHeading: man.oppHeading, newTack: man.newTack, tack: man.tack, gybe: man.gybe, lineDrawn: drawn };
  }

  function setEnabled(on) {
    enabled = on; save('ui.tackAssist', on);
    if (chip) chip.classList.toggle('on', on);
    if (!on) clearLine();
    render(lastNav);
  }

  function buildUI() {
    var st = document.createElement('style');
    st.textContent =
      '#tack-chip{position:absolute;left:50%;transform:translateX(-50%);bottom:96px;z-index:7;display:flex;' +
      'align-items:center;gap:9px;padding:6px 14px;border-radius:16px;cursor:pointer;user-select:none}' +
      ' #tack-chip .tk-ico{font-size:13px;color:var(--accent);align-self:center}' +
      ' #tack-chip .tk-body{display:flex;flex-direction:column;gap:1px;line-height:1.3;font-variant-numeric:tabular-nums}' +
      ' #tack-chip .tk-rec{font-size:12.5px;color:var(--ctext);font-weight:500;white-space:nowrap}' +
      ' #tack-chip:not(.on) .tk-rec{color:var(--cdim);font-weight:400}' +
      ' #tack-chip .tk-alt{font-size:11px;color:var(--cdim);white-space:nowrap}' +
      ' #tack-chip .tk-alt:empty{display:none}';
    document.head.appendChild(st);
    chip = document.createElement('div');
    chip.id = 'tack-chip'; chip.className = 'tack-chip glass';
    chip.title = 'Opposite-tack assist — needs a wind instrument';
    chip.innerHTML = '<span class="tk-ico">⊲</span><span class="tk-body"><span class="tk-rec">Tack assist</span><span class="tk-alt"></span></span>';
    chip.addEventListener('click', function () { setEnabled(!enabled); });
    document.body.appendChild(chip);
    enabled = !!store('ui.tackAssist', false);
    chip.classList.toggle('on', enabled);
  }

  function init() {
    if (!window.map) { setTimeout(init, 250); return; }
    buildUI();
    var m = window.map;
    if (m.isStyleLoaded && m.isStyleLoaded()) ensureLayer(); else if (m.once) m.once('load', ensureLayer);
    if (window.HelmShell && HelmShell.onNav) HelmShell.onNav(render);
    render(null);
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
