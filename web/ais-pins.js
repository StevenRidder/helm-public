// ais-pins.js — pin multiple AIS targets and watch them side-by-side. Tap a vessel -> "Pin" on its
// detail card -> a compact, LIVE-updating card docks in a right-hand column. Pin as many as you want;
// each refreshes every nav frame (CPA/TCPA/range/freshness/source), with a flash-on-chart and an
// unpin. Pure client-side; pinned MMSIs persist across reloads. Reuses the card formatters from the
// shell (window.HelmAisFmt) so freshness + source chips match the popup exactly.
(function () {
  if (!window.HelmShell) return;
  var pins = new Map();                 // mmsi -> last-known props (or null until first frame)
  var map = null, col = null;
  var PREF = 'helm.ais.pins';

  function loadPrefs() { try { var a = JSON.parse(localStorage.getItem(PREF) || '[]'); if (Array.isArray(a)) a.forEach(function (m) { pins.set(+m, null); }); } catch (e) {} }
  function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify(Array.from(pins.keys()))); } catch (e) {} }

  var fmt = function () { return window.HelmAisFmt || {}; };
  function tier(p) { try { return HelmAisRisk.tier(p); } catch (e) { return 'normal'; } }
  function tcol(t) { return t === 'danger' ? '#ff5a52' : t === 'caution' ? '#f5c451' : '#43d17d'; }
  function num(v, d) { return (v == null || isNaN(v)) ? '—' : (+v).toFixed(d); }
  function nm(s) { s = String(s == null ? '' : s).replace(/@+/g, '').trim(); return /^unknown$/i.test(s) ? '' : s; }

  function ensureCol() {
    if (col && document.body.contains(col)) return col;
    col = document.createElement('div'); col.id = 'helm-ais-pins';
    col.style.cssText = 'position:fixed;top:96px;right:14px;z-index:7;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 190px);overflow-y:auto;pointer-events:none';
    document.body.appendChild(col);
    return col;
  }
  function currentProps(mmsi) {
    try { var fs = map.querySourceFeatures('ais'); for (var i = 0; i < fs.length; i++) if (fs[i].properties && +fs[i].properties.mmsi === mmsi) return fs[i].properties; } catch (e) {}
    return null;
  }

  function cardHTML(mmsi, p) {
    p = p || {}; var t = tier(p), c = tcol(t), valid = p.cpaValid !== false && p.cpa != null;
    var name = nm(p.name) || ('MMSI ' + mmsi);
    var fresh = fmt().freshChip ? fmt().freshChip(p.ageSec) : '';
    var srcL = fmt().sourceLabel ? fmt().sourceLabel(p.source) : '';
    var srcChip = srcL ? '<span style="display:inline-flex;align-items:center;font-size:11px;color:var(--cdim);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.13);padding:3px 8px;border-radius:8px">' + srcL + '</span>' : '';
    return '<div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">'
      + '<span style="width:9px;height:9px;border-radius:50%;background:' + c + ';flex:0 0 auto"></span>'
      + '<span style="flex:1;font-size:14.5px;font-weight:600;color:#eef4f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</span>'
      + '<button data-act="flash" data-mmsi="' + mmsi + '" title="Flash on chart" aria-label="Flash on chart" style="border:none;background:transparent;color:var(--cdim);font-size:15px;cursor:pointer;padding:2px 4px">⌖</button>'
      + '<button data-act="unpin" data-mmsi="' + mmsi + '" title="Unpin" aria-label="Unpin" style="border:none;background:transparent;color:var(--cdim);font-size:17px;cursor:pointer;padding:2px 4px;line-height:1">×</button>'
      + '</div>'
      + '<div style="display:flex;gap:12px;font-size:15px;font-weight:600;color:' + (t === 'normal' ? '#dbe6ee' : c) + ';margin-bottom:3px">'
      + '<span>CPA ' + (valid ? num(p.cpa, 1) : '—') + '<span style="font-size:11px;color:var(--cdim2)"> NM</span></span>'
      + '<span>TCPA ' + (valid && p.tcpa != null ? (+p.tcpa).toFixed(0) : '—') + '<span style="font-size:11px;color:var(--cdim2)"> min</span></span></div>'
      + '<div style="font-size:12.5px;color:var(--cdim);margin-bottom:6px">RNG ' + num(p.range, 1) + ' NM · BRG ' + num(p.brg, 0) + '° · SOG ' + num(p.sog, 1) + ' kn</div>'
      + '<div style="display:flex;gap:5px;flex-wrap:wrap">' + fresh + srcChip + '</div>';
  }

  function renderCard(mmsi) {
    var el = document.getElementById('pin-' + mmsi);
    if (!el) {
      el = document.createElement('div'); el.id = 'pin-' + mmsi;
      el.style.cssText = 'pointer-events:auto;width:230px;background:rgba(13,23,34,.94);border:1px solid rgba(255,255,255,.12);border-radius:13px;padding:11px 12px;box-shadow:0 14px 38px -18px rgba(0,0,0,.85)';
      el.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var m = +b.getAttribute('data-mmsi');
        if (b.getAttribute('data-act') === 'unpin') unpin(m); else flash(m);
      });
      ensureCol().appendChild(el);
    }
    el.innerHTML = cardHTML(mmsi, pins.get(mmsi));
  }

  function has(mmsi) { return pins.has(+mmsi); }
  function pin(mmsi, props) { mmsi = +mmsi; if (!mmsi) return; pins.set(mmsi, props || currentProps(mmsi) || pins.get(mmsi) || null); savePrefs(); renderCard(mmsi); }
  function unpin(mmsi) { mmsi = +mmsi; pins.delete(mmsi); savePrefs(); var el = document.getElementById('pin-' + mmsi); if (el) el.remove(); }
  function toggle(mmsi) { mmsi = +mmsi; if (pins.has(mmsi)) unpin(mmsi); else pin(mmsi); }

  function flash(mmsi) {
    var p = pins.get(mmsi); if (!p || !isFinite(p.lon)) p = currentProps(mmsi) || p;
    if (!map || !p || !isFinite(p.lon) || !isFinite(p.lat)) return;
    try { map.easeTo({ center: [p.lon, p.lat], duration: 600 }); } catch (e) {}
    try { if (window.HelmAisSelect && HelmAisSelect.select) HelmAisSelect.select(mmsi); } catch (e) {}   // CLIENT-7 ring on the centred target

    try {
      var el = document.createElement('div');
      el.style.cssText = 'width:42px;height:42px;border-radius:50%;border:3px solid #5dd0b0;box-sizing:border-box;pointer-events:none';
      var mk = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
      el.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 950, easing: 'ease-out' });
      setTimeout(function () { mk.remove(); }, 950);
    } catch (e) {}
  }

  function onNav(s) {
    if (!s || !Array.isArray(s.ais) || !pins.size) return;
    var byId = {}; for (var i = 0; i < s.ais.length; i++) { var t = s.ais[i]; if (t && t.mmsi != null) byId[+t.mmsi] = t; }
    pins.forEach(function (old, mmsi) { if (byId[mmsi]) pins.set(mmsi, byId[mmsi]); renderCard(mmsi); });
  }

  function init(opts) { map = opts && opts.map; loadPrefs(); pins.forEach(function (v, m) { renderCard(m); }); }
  HelmShell.onNav(onNav);
  window.HelmAisPins = { init: init, pin: pin, unpin: unpin, toggle: toggle, has: has, flash: flash };
})();
