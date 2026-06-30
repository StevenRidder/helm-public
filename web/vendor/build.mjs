import { build } from 'esbuild';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Portable: emit next to this script (web/vendor/) and resolve deps from web/vendor/node_modules, so
// `npm ci && node build.mjs` reproduces every bundle on ANY machine (no hardcoded home path). Override
// with VENDOR_OUT / VENDOR_RESOLVE — e.g. build into a temp dir to diff against the committed files.
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.VENDOR_OUT || HERE;
const RESOLVE = process.env.VENDOR_RESOLVE || HERE;
mkdirSync(OUT, { recursive: true });

const COMMON = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'eof',          // keep license attribution at end of file
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning',
};

// universal entry: preserve BOTH named exports and a default (contour/temporal are default-imports)
const universal = (pkg) =>
  `import * as __ns from ${JSON.stringify(pkg)};\n` +
  `export * from ${JSON.stringify(pkg)};\n` +
  `export default (__ns && __ns.default !== undefined ? __ns.default : __ns);\n`;

const jobs = [
  { out: 'pmtiles.js',                       contents: universal('pmtiles'),                          external: ['maplibre-gl'] },
  { out: 'maplibre-cog-protocol.js',         contents: universal('@geomatico/maplibre-cog-protocol'), external: ['maplibre-gl'] },
  { out: 'maplibre-contour.js',              contents: universal('maplibre-contour'),                 external: ['maplibre-gl'] },
  { out: 'terra-draw.js',                    contents: universal('terra-draw'),                       external: [] },
  { out: 'terra-draw-maplibre-gl-adapter.js',contents: universal('terra-draw-maplibre-gl-adapter'),   external: ['maplibre-gl', 'terra-draw'] },
  { out: 'maplibre-gl-measures.js',          contents: universal('maplibre-gl-measures'),             external: ['maplibre-gl'] },
  { out: 'maplibre-gl-temporal-control.js',  contents: universal('maplibre-gl-temporal-control'),     external: ['maplibre-gl'] },
  // deck.gl: ONE self-contained bundle (core + luma deduped internally) exporting exactly what ais-deck.js needs
  { out: 'deck.js',
    contents: `export { MapboxOverlay } from "@deck.gl/mapbox";\n` +
              `export { ScatterplotLayer } from "@deck.gl/layers";\n` +
              `export { HeatmapLayer } from "@deck.gl/aggregation-layers";\n`,
    external: ['maplibre-gl'] },
];

let ok = 0, fail = 0;
for (const j of jobs) {
  try {
    await build({
      ...COMMON,
      stdin: { contents: j.contents, resolveDir: RESOLVE, loader: 'js', sourcefile: 'entry-' + j.out },
      external: j.external,
      outfile: `${OUT}/${j.out}`,
    });
    console.log('  ✓', j.out);
    ok++;
  } catch (e) {
    console.error('  ✗', j.out, '\n    ', (e && e.message || e).toString().split('\n').slice(0, 6).join('\n     '));
    fail++;
  }
}
console.log(`\nDONE  ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
