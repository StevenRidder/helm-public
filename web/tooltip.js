// tooltip.js — fast, styled hover tooltips for the whole UI.
//
// The native `title` tooltip has a browser-fixed ~1.5 s delay that CANNOT be changed. This replaces
// it with one small custom tooltip that reuses the `title` attributes already on every button: it
// shows after HOVER_DELAY ms, styled to match the app's dark glass, and SUPPRESSES the slow native
// one (the title is converted to data-helmtip + aria-label on first hover, so screen-reader access
// is preserved). Delegated listeners, so dynamically-created buttons are covered too — no per-button
// wiring. Disabled on touch-only devices (no hover there, same as native title).
(function () {
  var HOVER_DELAY = 600;   // ms before the tooltip appears — "almost instant". Tune here.

  if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;   // touch-only → no hover tips

  var tip = null, timer = null, current = null;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'helm-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;max-width:280px;white-space:normal;' +
      'padding:5px 9px;border-radius:7px;font:500 12px/1.35 -apple-system,system-ui;color:#eef4f9;' +
      'background:rgba(13,19,27,.94);border:.5px solid rgba(255,255,255,.16);box-shadow:0 8px 28px -10px rgba(0,0,0,.8);' +
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);opacity:0;transition:opacity .12s ease;left:0;top:0;';
    document.body.appendChild(tip);
    return tip;
  }

  // The tooltip text for el — converting a native `title` to data-helmtip (+ aria-label) on first
  // sight so the slow native tip never fires and accessibility is kept. Handles titles set later
  // by JS too (each re-adds `title`, which we re-capture on the next hover).
  function tipText(el) {
    if (!el || !el.getAttribute) return null;
    var t = el.getAttribute('title');
    if (t) {
      el.setAttribute('data-helmtip', t);
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', t);
      el.removeAttribute('title');
      return t;
    }
    return el.getAttribute('data-helmtip');
  }

  function host(el) {   // nearest ancestor that carries a tooltip
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.getAttribute && (el.getAttribute('title') || el.getAttribute('data-helmtip'))) return el;
      el = el.parentNode;
    }
    return null;
  }

  function place(el) {
    var t = ensureTip(), r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
    var left, top;
    if (el.closest && el.closest('.rail')) {         // left icon rail → to the RIGHT of the icon
      left = r.right + 8; top = r.top + r.height / 2 - tr.height / 2;
    } else if (r.top < 70) {                         // top toolbar → BELOW
      left = r.left + r.width / 2 - tr.width / 2; top = r.bottom + 8;
    } else {                                         // default → ABOVE, flipping below if no room
      left = r.left + r.width / 2 - tr.width / 2; top = r.top - tr.height - 8;
      if (top < 4) top = r.bottom + 8;
    }
    var vw = document.documentElement.clientWidth || window.innerWidth || 1200;
    var vh = document.documentElement.clientHeight || window.innerHeight || 800;
    left = Math.max(6, Math.min(left, vw - tr.width - 6));
    top = Math.max(6, Math.min(top, vh - tr.height - 6));
    t.style.left = Math.round(left) + 'px';
    t.style.top = Math.round(top) + 'px';
    t.style.opacity = '1';
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    current = null;
    if (tip) tip.style.opacity = '0';
  }

  document.addEventListener('mouseover', function (e) {
    var h = host(e.target);
    if (!h) { if (current) hide(); return; }
    if (h === current) return;
    hide();
    current = h;
    var text = tipText(h);
    if (!text) { current = null; return; }
    var t = ensureTip(); t.textContent = text; t.style.opacity = '0';   // pre-set so place() can measure
    timer = setTimeout(function () { if (current === h && document.contains(h)) place(h); }, HOVER_DELAY);
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (!current) return;
    var to = e.relatedTarget;
    if (to && current.contains && current.contains(to)) return;   // moving within the same control
    hide();
  }, true);

  window.addEventListener('scroll', hide, true);
  window.addEventListener('mousedown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('mouseleave', hide);
})();
