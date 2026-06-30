// HelmStore — TOOLS-7 — the one persistence layer for the web client.
//
// Every UI preference that must survive a reload (theme, units, layer visibility, alarm thresholds,
// boards, boat profile, …) goes through here instead of poking localStorage ad-hoc. One namespace
// ('helm.'), JSON values, and — per the project's FAIL-LOUD rule — storage failures are SURFACED,
// never silently swallowed: a write that can't persist (private mode, disabled storage, quota) warns
// and returns false so the caller knows the setting did NOT save, rather than pretending it did.
//
//   HelmStore.get(key, default)   → parsed value, or default if unset (corrupt value warns + default)
//   HelmStore.set(key, value)     → true if persisted, false if it could not be (and warned)
//   HelmStore.remove(key)         → forget a key
//   HelmStore.keys()              → the helm.* keys currently stored (without the namespace prefix)
//   HelmStore.available()         → true if browser storage actually works this session
(function () {
  var NS = 'helm.';
  var ok = null;            // lazily-probed: is localStorage actually usable this session?
  var warned = false;

  function ls() { return window.localStorage; }   // property access itself throws in some sandboxes

  function probe() {
    if (ok !== null) return ok;
    try {
      var k = NS + '__probe__';
      ls().setItem(k, '1'); ls().removeItem(k);
      ok = true;
    } catch (e) { ok = false; }
    return ok;
  }
  function warnNoStore() {
    if (warned) return; warned = true;
    console.warn('HelmStore: browser storage is UNAVAILABLE (private mode / disabled / sandboxed) — '
      + 'settings will NOT survive reload this session.');
  }

  function get(key, dflt) {
    try {
      var v = ls().getItem(NS + key);
      if (v == null) return dflt;
      return JSON.parse(v);
    } catch (e) {
      // a corrupt/unreadable stored value is a REAL problem — surface it, don't hide behind the default
      console.warn('HelmStore.get("' + key + '"): stored value is unreadable, using default —', e && e.message);
      return dflt;
    }
  }
  function set(key, value) {
    if (!probe()) { warnNoStore(); return false; }
    try {
      ls().setItem(NS + key, JSON.stringify(value));
      return true;
    } catch (e) {
      // quota exceeded / serialization failure — FAIL LOUD; never report a save that didn't happen
      console.warn('HelmStore.set("' + key + '") FAILED — value NOT persisted (' + (e && e.name) + '):', e && e.message);
      return false;
    }
  }
  function remove(key) {
    try { ls().removeItem(NS + key); return true; } catch (e) { return false; }
  }
  function keys() {
    var out = [];
    try {
      for (var i = 0; i < ls().length; i++) {
        var k = ls().key(i);
        if (k && k.indexOf(NS) === 0) out.push(k.slice(NS.length));
      }
    } catch (e) {}
    return out;
  }

  window.HelmStore = { get: get, set: set, remove: remove, keys: keys, available: probe, ns: NS };
})();
