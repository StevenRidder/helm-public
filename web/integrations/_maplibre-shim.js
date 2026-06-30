/*
 * Helm — _maplibre-shim.js
 * --------------------------------------------------------------------------
 * The page loads MapLibre GL JS as a classic <script> (window.maplibregl).
 * The ESM integration plugins below `import ... from 'maplibre-gl'`. The import
 * map points that bare specifier HERE so every plugin shares the SAME MapLibre
 * instance the map was built with — instead of esm.sh fetching a second ~1 MB
 * copy (which also breaks `instanceof` checks across the boundary).
 *
 * Plugins use either the default import or named imports, so we expose both.
 */
const m = globalThis.maplibregl;
if (!m) console.warn('[helm] maplibre-gl global missing — load maplibre-gl.js before the integration modules');

export default m;

export const {
  Map, Marker, Popup, Style,
  NavigationControl, ScaleControl, AttributionControl, GeolocateControl, FullscreenControl,
  LngLat, LngLatBounds, MercatorCoordinate, Point,
  addProtocol, removeProtocol, getRTLTextPluginStatus, setRTLTextPlugin,
} = m || {};
