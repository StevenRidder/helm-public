/* Helm — community.js
 * Baked-in client for the Helm backend (places by source · owned saved pins · "where to go"
 * recommender · give-back). Mirrors the engine pattern: auto-detect the backend at
 * http://127.0.0.1:8090 and DEGRADE GRACEFULLY to the committed local sample data when it's
 * not running — so the chart never breaks. The features are selectable LAYERS, like weather.
 */
window.HelmCommunity = function (map, opts) {
  opts = opts || {};
  const API = opts.api || 'http://127.0.0.1:8090';
  let online = false;
  const listeners = [];
  const onStatus = (fn) => listeners.push(fn);
  const emit = () => listeners.forEach((fn) => fn(online));
  const cache = () => window.HelmLayerCache;

  async function health() {
    try {
      const r = await fetch(API + '/health', { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      online = !!j.ok;
      emit();
      return j;
    } catch (e) {
      online = false; emit(); return null;
    }
  }

  function setData(source, fc) {
    const s = map.getSource(source);
    if (s && fc) s.setData(fc);
  }
  function rememberGeo(source, scope, fc) {
    const C = cache(); if (!C || !fc) return;
    try {
      C.put({
        layerId: 'community.' + source, scope: scope || 'default', kind: 'geojson',
        bbox: [-180, -85, 180, 85], source: 'helm-community', ttlMs: 24 * 60 * 60 * 1000,
        payload: { geojson: fc }
      });
    } catch (_) {}
  }
  function cachedGeo(source, scope) {
    const C = cache(); if (!C) return null;
    const rec = C.getBest('community.' + source, { scope: scope || 'default', allowAny: true });
    return rec && rec.payload && rec.payload.geojson ? rec.payload.geojson : null;
  }

  // Pull places (optionally restricted to sources) into the existing 'places' source.
  async function loadPlaces(sources) {
    const scope = sources && sources.length ? sources.join(',') : 'all';
    if (!online) { const fc = cachedGeo('places', scope); if (fc) setData('places', fc); return fc; }
    try {
      const q = sources && sources.length ? '?sources=' + sources.join(',') : '';
      const fc = await (await fetch(API + '/places' + q)).json();
      rememberGeo('places', scope, fc);
      setData('places', fc);
      return fc;
    } catch (e) { const fc = cachedGeo('places', scope); if (fc) setData('places', fc); return fc; }
  }

  // Pull owned saved pins into the 'saved' source (else the committed sample stays).
  async function loadSaved() {
    if (!online) { const fc = cachedGeo('saved', 'owned'); if (fc) setData('saved', fc); return fc; }
    try {
      const fc = await (await fetch(API + '/saved')).json();
      rememberGeo('saved', 'owned', fc);
      setData('saved', fc);
      return fc;
    } catch (e) { const fc = cachedGeo('saved', 'owned'); if (fc) setData('saved', fc); return fc; }
  }

  // "Where to go": ask the recommender, highlight results on the chart, return the list.
  async function whereTo(body) {
    if (!online) {
      const fc = cachedGeo('whereto', 'last'); if (fc) setData('whereto', fc);
      return { offline: true, recommendations: [] };
    }
    try {
      const r = await fetch(API + '/whereto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      rememberGeo('whereto', 'last', j.geojson);
      setData('whereto', j.geojson);
      return j;
    } catch (e) {
      const fc = cachedGeo('whereto', 'last'); if (fc) setData('whereto', fc);
      return { error: String(e), recommendations: [] };
    }
  }

  function clearWhereTo() { setData('whereto', { type: 'FeatureCollection', features: [] }); }

  // Spacetime probe: narrate the fused slice (enabled layers) at a point + time.
  async function narrate(body) {
    if (!online) return { offline: true };
    try {
      return await (await fetch(API + '/narrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
    } catch (e) { return { error: String(e) }; }
  }

  // Probe along a path P(t): narrate the passage from ordered {lat,lon,t} points.
  async function briefing(body) {
    if (!online) return { offline: true };
    try {
      return await (await fetch(API + '/briefing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
    } catch (e) { return { error: String(e) }; }
  }

  // Give-back (sanctioned). Mock-first on the backend.
  async function nflPush(pos) {
    if (!online) return { offline: true };
    try {
      return await (await fetch(API + '/giveback/nfl/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pos),
      })).json();
    } catch (e) { return { error: String(e) }; }
  }
  async function osmNote(note) {
    if (!online) return { offline: true };
    try {
      return await (await fetch(API + '/giveback/osm-note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note),
      })).json();
    } catch (e) { return { error: String(e) }; }
  }
  async function savePin(pin) {
    if (!online) return { offline: true };
    try {
      const res = await (await fetch(API + '/saved', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pin),
      })).json();
      await loadSaved();
      return res;
    } catch (e) { return { error: String(e) }; }
  }

  return { health, onStatus, isOnline: () => online, loadPlaces, loadSaved, whereTo,
           clearWhereTo, narrate, briefing, nflPush, osmNote, savePin };
};
