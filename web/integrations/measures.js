/*
 * Helm — integrations/measures.js   ·   maplibre-gl-measures (jdsantos)
 * --------------------------------------------------------------------------
 * Table-stakes marine nav: measure distance and bearing between points (and
 * area). Adds its own control with draw-to-measure tools. Distances shown in
 * km/mi by the plugin; for a chartplotter you'd post-convert to NM (1 NM =
 * 1.852 km) — noted in the ADR.
 *
 * https://github.com/jdsantos/maplibre-gl-measures
 */
import MeasuresControl from 'maplibre-gl-measures';

let control = null;

export function enable(map) {
  if (control) return;
  control = new MeasuresControl({
    lang: { areaMeasurementButtonTitle: 'Measure area', lengthMeasurementButtonTitle: 'Measure distance', clearMeasurementsButtonTitle: 'Clear' },
    units: 'imperial',
    style: {
      text: { radialOffset: 0.9, justify: 'auto', color: '#eef4f9', font: ['Noto Sans Regular'], haloColor: '#0d131b', haloWidth: 1.4 },
      common: { midPointColor: '#5bc0ff', vertexColor: '#d6219a' },
      areaMeasurement: { fillColor: '#5bc0ff', fillOutlineColor: '#5bc0ff', fillOpacity: 0.1 },
      lengthMeasurement: { color: '#d6219a' },
    },
  });
  map.addControl(control, 'bottom-right');
}

export function disable(map) {
  if (control) { try { map.removeControl(control); } catch (e) { /* noop */ } control = null; }
}
