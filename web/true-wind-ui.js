// true-wind-ui.js — WX-13 UI: APPARENT vs TRUE wind, surfaced by TAPPING the Wind tiles in the
// bottom instrument bar (not a rail icon). The pure derivation lives in true-wind.js (HelmTrueWind,
// unit-tested); this file is the on-screen surface + the per-frame update. Lane: WX-owned.
//
// Why a tile tap, not a rail panel: true wind is a *detail of the wind reading*, so its home is the
// Wind instrument itself. Tap "Wind Speed" or "Wind Dir" → a popover with apparent vs true (speed,
// direction, angle). The richer "tap any instrument → history line charts" is a BOARD-epic task.
// Wired live via index.html applyNav() → HelmTrueWindUI.onNav(s) (unchanged). ⌘K still opens it.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var TW = window.HelmTrueWind;
  var trueW = null, apparent = null, pop = null, open = false;

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function signed180(d) { d = norm360(d); return d > 180 ? d - 360 : d; }
  function side(a) { return a == null ? '' : (a >= 0 ? 'S' : 'P'); }   // starboard / port, off the bow

  // apparent wind from the nav frame: AWS (speed), AWD (compass dir), AWA (angle off the bow)
  function apparentOf(s) {
    if (!s || !s.wind || !num(s.wind.spd) || !num(s.wind.dir)) return null;
    var hdg = num(s.hdg) ? s.hdg : (num(s.cog) ? s.cog : 0);
    var src = s.sources && s.sources.wind;
    return { aws: s.wind.spd, awd: norm360(s.wind.dir), awa: signed180(s.wind.dir - hdg),
             real: !!(src && src !== 'simulated' && src !== 'sim') };
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'helm-wind-detail';
    pop.style.cssText = 'position:fixed;z-index:20;display:none;min-width:208px;max-width:248px;padding:11px 13px;' +
      'border-radius:12px;font:500 12px -apple-system,system-ui;color:#eef4f9;background:rgba(16,22,30,.95);' +
      'border:.5px solid rgba(255,255,255,.16);box-shadow:0 16px 48px -16px rgba(0,0,0,.8);' +
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);';
    document.body.appendChild(pop);
    return pop;
  }

  function paint() {
    if (!pop || pop.style.display === 'none') return;
    var a = apparent, t = trueW;
    if (!a) { pop.innerHTML = '<div style="opacity:.7">Waiting for wind data…</div>'; return; }
    var head = '<td style="text-align:right;color:#7d92a6;font-size:10px;letter-spacing:.05em;padding:0 0 4px">';
    var row = function (lbl, ap, tr) {
      return '<tr><td style="padding:3px 0;color:#8aa0b0">' + lbl + '</td>' +
        '<td style="padding:3px 16px 3px 0;text-align:right;font-variant-numeric:tabular-nums">' + ap + '</td>' +
        '<td style="padding:3px 0;text-align:right;font-variant-numeric:tabular-nums">' + tr + '</td></tr>';
    };
    var sp = function (v) { return num(v) ? v.toFixed(1) : '—'; };
    var dir = function (v) { return num(v) ? Math.round(norm360(v)) + '°' : '—'; };
    var ang = function (v, sd) { return num(v) ? Math.abs(Math.round(v)) + '° ' + (sd || side(v)) : '—'; };
    pop.innerHTML =
      '<div style="font-weight:500;margin-bottom:7px;display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
        '<span>Wind — apparent vs true</span>' + (a.real ? '' : '<span style="font-size:10px;color:#ffc06a">sim, no sensor</span>') + '</div>' +
      '<table style="width:100%;border-collapse:collapse">' +
      '<tr><td></td>' + head + 'APPARENT</td>' + head + 'TRUE</td></tr>' +
      row('Speed', sp(a.aws) + ' kn', t ? sp(t.tws) + ' kn' : '—') +
      row('Direction', dir(a.awd), t ? dir(t.twd) : '—') +
      row('Angle', ang(a.awa), t ? ang(t.twa, t.twaSide) : '—') +
      '</table>' +
      '<div style="margin-top:8px;font-size:10px;color:#7d92a6;line-height:1.4">True = apparent minus your motion (SOG/COG), ground-referenced.</div>';
  }

  function place() {
    var anchor = document.getElementById('nv-wind');
    var tile = anchor && anchor.closest ? anchor.closest('.it') : null;
    var bar = document.querySelector('.ib');
    var left = tile ? tile.getBoundingClientRect().left : 12;
    var barH = bar ? bar.offsetHeight : 64;
    var p = ensurePop();
    p.style.display = 'block';
    p.style.left = Math.round(Math.max(8, left)) + 'px';
    p.style.bottom = (barH + 10) + 'px';   // anchored to the instrument bar (robust to viewport quirks)
    p.style.top = 'auto';
  }

  function show() { open = true; ensurePop(); place(); paint(); }
  function hide() { open = false; if (pop) pop.style.display = 'none'; }
  function toggle() { open ? hide() : show(); }

  function onNav(s) {
    if (!s) return;
    apparent = apparentOf(s);
    trueW = (TW && TW.fromNav) ? TW.fromNav(s) : null;
    if (trueW) window.__truewind = trueW;   // laylines (ROUTING-6) + others read this
    if (open) { place(); paint(); }
  }

  function wireTiles() {
    ['nv-wind', 'nv-winddir'].forEach(function (id) {
      var el = document.getElementById(id), tile = el && el.closest ? el.closest('.it') : null;
      if (tile && !tile._windTap) {
        tile._windTap = true;
        tile.style.cursor = 'pointer';
        tile.setAttribute('title', 'Tap for apparent vs true wind');
        tile.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
      }
    });
  }
  if (document.readyState !== 'loading') wireTiles(); else document.addEventListener('DOMContentLoaded', wireTiles);
  document.addEventListener('click', function (e) { if (open && pop && !pop.contains(e.target)) hide(); }, false);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });

  // ⌘K still opens it (the rail panel is gone — it lives on the wind tile now).
  if (window.HelmShell && typeof window.HelmShell.registerCommand === 'function') {
    window.HelmShell.registerCommand({
      id: 'helm-wx-truewind-show', epic: 'WX', title: 'Show true wind', subtitle: 'Apparent vs true (TWS / TWD / TWA)',
      keywords: 'wind true twa twd tws apparent', group: 'Weather', run: show
    });
  }

  window.HelmTrueWindUI = { onNav: onNav, current: function () { return trueW; }, show: show, hide: hide };
})();
