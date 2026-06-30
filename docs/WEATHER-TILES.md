# Value-encoded (Mercator) weather tiles — the WX-10 contract

> The pan/zoomable, sample-able replacement for the fixed-bbox `field-*.json` heatmap blob.
> One artifact drives **both** the on-screen weather render **and** the deterministic
> `sample(lat, lon, t)` probe that ROUTING-3 (spacetime probe) and AI-5 (layer sample faces)
> consume — the number you read and the colour you see come from the *same* decoded pixels.

Owned by the **WX** epic. Files:
`web/wx-value-codec.js` (the encoding, one source of truth) · `web/integrations/cog.js`
(render + probe) · `web/wx-grib.js` (HelmShell panel + `window.__helmWxSample`) ·
`pipeline/make_value_tiles.py` (baker) · `pipeline/fetch_grib.py` (Tier-2 ingestion).

---

## Why

Tier-1 weather (`pipeline/fetch_weather.py` → `web/field-layer.js`) renders a coarse scalar grid as
**one fixed-bbox `image` source**: colours live in the PNG, the actual values live only in JSON, and
nothing tiles or pans like a real layer. You cannot ask it "what's the wind at this lat/lon/time?".

WX-10 makes weather a **value-encoded Web-Mercator XYZ pyramid** (the "Mercator" / mercator.blue
pattern, the same family as Mapbox terrain-RGB and the Terrarium DEM in `web/integrations/mercator.js`):
each pixel's RGB encodes the *physical value*, decoded + colourised client-side. Because the value is
in the pixels, the same tiles answer a probe. Per `docs/WEATHER-DATA.md`, **the renderer is invariant
between Tier-1 (Open-Meteo) and Tier-2 (raw GRIB) — only the fetcher changes.**

---

## The encoding — `helm-wxv1`

24-bit unsigned value + 8-bit NODATA mask. Defined once in `web/wx-value-codec.js`; the Python baker
mirrors it byte-for-byte (cross-checked by a test that decodes Python-encoded pixels through the JS
codec).

```
n      = clamp(round((value - offset) / scale), 0, 0xFFFFFF)
R,G,B  = (n>>16)&255, (n>>8)&255, n&255          A = 255 (valid)  |  A = 0 (NODATA)
value  = offset + ((R<<16)|(G<<8)|B) * scale      ← only when A >= 128, else NO DATA
```

- `scale` / `offset` are **per-layer and constant across every time frame** (derived from the field's
  *global* [min,max]) so decoded values and colours are comparable along the scrubber. They live in
  the layer `manifest.json` — never hardcoded.
- **`--bits 16`** (the committed-demo default) keeps the value on the 24-bit grid but zeroes the low
  byte (B constant) so PNGs compress ~10× smaller while still resolving `(max-min)/65535` per step —
  far below any weather display precision. The decoder is unchanged. `--bits 24` is available for max
  fidelity.
- **NODATA stays NODATA.** `A = 0` (land for an ocean-only layer, gap in coverage) renders transparent
  and samples as `value: null` with a "verify locally" note. Helm never fakes a value to fill a gap.
- Projection: standard Web-Mercator slippy tiles. Tile math mirrors `pipeline/gen_demo_data.py`.

### Tile-set layout + manifest

```
web/data/wxtiles/
  index.json                      { encoding, layers:{ <layer>:{unit,source,model,minzoom,maxzoom,frames,manifest} } }
  <layer>/
    manifest.json
    t<frame>/<z>/<x>/<y>.png       per-frame value tiles  (single-frame sets drop the t<frame>/ dir)
```

`manifest.json`:

| key | meaning |
|---|---|
| `encoding` | `"helm-wxv1"` |
| `bits` | 16 or 24 |
| `scale`, `offset` | the decode constants (above) |
| `layer`, `unit`, `kind` | e.g. `"wind"`, `"kn"`, `"scalar"` |
| `bbox` | `[west, south, east, north]` (EPSG:4326) |
| `minzoom`, `maxzoom`, `tileSize` | baked zoom range; the client **overzooms** past `maxzoom` |
| `vmin`, `vmax` | global value range (for the legend) |
| `ramp` | colour stops `[[value,[r,g,b(,a)]], …]` (same shape as `fetch_weather.py`) |
| `source`, `model` | provenance: `open-meteo`/`gfs`/`ecmwf-ifs`/`icon`/`demo-synthetic` + human model name |
| `fetchedAt` | issue/fetch time (ISO) for data-age, or `null` for the synthetic demo |
| `times`, `frames` | forecast valid-times + per-frame dirs (null for single-frame) |
| `horizon`, `confidence`, `disclaimer` | honesty metadata carried into every sample |

---

## The probe — `sample(lat, lon, t)`

`web/integrations/cog.js` exposes `sampleWx(lat, lon, t)` (and `window.__helmWxSample(lat, lon, t)`).
It decodes the value from the tiles and returns a **`LayerSample`**:

```js
{ layer, value,            // DECODED from the tiles — never invented; null when NODATA/out-of-coverage
  unit,
  source,                  // 'open' for real public models (GFS/ECMWF/ICON/Open-Meteo);
                           // 'synthetic' for the offline demo — it must NOT share the trusted-model class
  sourceRef: { title, url, provenance },   // provenance = the raw tag (gfs/open-meteo/demo-synthetic/…)
  freshness,               // DATA-AGE: issue/fetch time (or 'synthetic'/'forecast') — NOT the valid-time
  validTime,               // the forecast valid-time of the sampled frame (separate field)
  confidence, horizon, encoding,
  notForNavigation,        // boolean — true for synthetic/NOT-FOR-NAVIGATION data; the machine-readable honesty flag
  disclaimer,              // the manifest NOT-FOR-NAVIGATION string, carried through
  note? }                  // 'no data here — verify locally' on a gap
```

`source` is `'synthetic'` (not `'open'`) for the demo pack and `notForNavigation` is `true`, so a
consumer that only trusts known real-model classes fails closed on demo data rather than narrating
invented numbers as a real forecast. `freshness` is **data-age** (when the model was issued/fetched),
kept distinct from `validTime` (the forecast time being sampled).

> **Argument order:** this honours the doc contract `sample(lat, lon, t)` — **lat first**. Note that
> `web/wind-layer.js`'s particle sampler is `sample(lon, lat)` (lon first). The backend
> `probe_contract.py` / `probe_layers.py` contract standardises probe layers on this doc's
> lat-first order; this layer already does.

ROUTING-3 calls it per point along a worldline `W(P(t), t)`; AI-5 fuses it with the other layers'
`sample()` faces. Because every sample carries `source` + `freshness` + `horizon`/`confidence`, a
narrator can show provenance and never speak a value the layers didn't return.

---

## Producing tiles

### Tier-1 — Open-Meteo (no GRIB tooling)
```bash
python3 pipeline/fetch_weather.py --bbox="-87,19,-77,29" --layers wind,pressure --hours 12
python3 pipeline/make_value_tiles.py --layers wind,pressure --data ../web/data
```

### Tier-2 — raw GRIB (production / offline-clean)
```bash
python3 pipeline/fetch_grib.py --bbox="-87,19,-77,29" --layers wind,pressure --hours 12 --source gfs
python3 pipeline/make_value_tiles.py --layers wind,pressure --source gfs --model "NOAA GFS 0.25°"
```
`fetch_grib.py` pulls NOAA NOMADS GFS 0.25° via the grib-filter subset API (US public domain),
decodes with `pygrib`/`cfgrib` **if installed**, and writes `field-*.json` in the exact Tier-1 shape.
With no decoder or no network it **degrades honestly** (prints the URLs it would fetch + the Tier-1 /
demo fallbacks) — it never fabricates model values. ECMWF open-data (CC-BY-4.0, **attribution
required**) and DWD ICON are scaffolded; GFS-Wave (waves/swell) and RTOFS (currents/SST) are separate
products, noted but not yet wired.

### Offline deterministic demo (what's committed)
```bash
python3 pipeline/make_value_tiles.py --demo --layers wind,pressure
```
Synthesises a deterministic Key-West field offline (matching the rest of the committed demo pack —
`dem`/`relief`/`ais`/`radar`) and bakes byte-identical tiles, so the committed pack is regenerable
with zero network — exactly like `gen_demo_data.py`'s DEM. **NOT FOR NAVIGATION.**

---

## Rendering / consuming (in the app)

The **WX-owned `web/wx-grib.js`** registers a HelmShell panel + ⌘K command (zero edits to the shell
body beyond the two `<script>` tags). It calls `cog.js`:

```js
import * as cog from './integrations/cog.js';
await cog.enableWxTiles(map, { maplibregl, manifestUrl: 'data/wxtiles/wind/manifest.json',
                               beforeId: 'route-line', opacity: 0.82, frame: 0, notify });
cog.setWxFrame(map, 6);  cog.setWxOpacity(map, 0.6);  cog.disableWxTiles(map);
const s = await cog.sampleWx(lat, lon, '2026-06-26T06:00');   // -> LayerSample
```

Rendering uses a custom **`helmwx://<layer>/<frame>/{z}/{x}/{y}`** MapLibre protocol: it fetches the
raw value tile, decodes each pixel, paints it through the layer's ramp (NODATA → transparent), and
returns the colourised image — while caching the decoded value grid so the probe and the heatmap
share pixels. No tiler, no server-side colourising, fully offline.

---

## Ensemble spread (WX-11) — GFS vs ECMWF

Multi-model honesty: when Helm shows more than one model, it names each model and shows
spread/agreement because disagreement between models is itself decision-relevant. Two value-tile sets
of the same layer (one per model) are decoded together and the per-pixel **spread `|GFS − ECMWF|`**
is painted through a ramp that is **transparent where the models agree and reddens where they
diverge** — the map literally highlights "the forecast is uncertain here" (which typically grows with
forecast horizon).

- **Bake:** `make_value_tiles.py --demo-ensemble --layers wind` → `wxtiles/wind-gfs/`,
  `wxtiles/wind-ecmwf/`, and `wxtiles/ensemble.json` pairing them. (Production: bake each member from
  its model via `fetch_grib.py --source gfs|ecmwf` then `make_value_tiles.py`.)
- **Render:** `cog.js` `enableEnsemble(map, {manifestA, manifestB, labelA, labelB, …})` via a
  `helmwxspread://` protocol; `setEnsembleFrame/Opacity`, `disableEnsemble`.
- **Probe:** `sampleEnsemble(lat, lon, t)` / `window.__helmWxEnsemble(lat,lon,t)` →
  `{ layer, unit, value/mean, spread, agreement: 'agree'|'marginal'|'diverge', confidence:
  'good'|'fair'|'low', models: { GFS, ECMWF }, validTime, notForNavigation, note? }`. Agreement is
  classified on `spread / (combined value range)` (`<0.08` agree, `<0.2` marginal, else diverge); the
  ensemble confidence **overrides** the single-model confidence (disagreement = lower confidence).
- A pixel is assessed only where **both** members have data; otherwise transparent / `null`.

## Notes / known edges

- **NODATA mask is always on.** Value tiles are always baked RGBA; out-of-coverage pixels (a tile
  straddling the data-bbox edge) get `alpha = 0` so they render transparent and sample as `null` —
  never decoded to `offset`/`vmin` as a phantom reading.
- **Tile path scheme is fixed** at `t<frame>/{z}/{x}/{y}.png` (or `{z}/{x}/{y}.png` single-frame);
  the renderer derives it directly. `manifest.tiles_template`/`frames[].dir` are descriptive only.
- **Seam samples are nearest-edge.** `sampleWx` bilinear-interpolates within a single tile; at an
  exact tile boundary it clamps to the tile edge rather than fetching the neighbour. The error is one
  inter-pixel step of a smooth field and matches the nearest-pixel heatmap render, so the
  "sample == what you see" property holds.
- **Antimeridian:** the probe coverage check handles a wrapped bbox (`west > east`, near 180°/Fiji);
  the baker refuses a wrapped bbox and asks you to split it either side of 180° (fail-loud, not a
  silent empty bake).

## Honesty checklist (must hold)

- Value is **decoded, never invented**; gaps return `null` + "verify locally".
- Every sample names the **model** + **valid-time** + **horizon/confidence**; `fetchedAt` gives data-age.
- Synthetic/demo data is labelled `NOT FOR NAVIGATION` in the manifest, attribution, and panel.
- A missing/stale source **degrades visibly** (load-failure surfaced) — it is never a silent fallback
  to plausible fiction.
- Imported PredictWind GRIB (WX-12) stays device-local and excluded from sync (separate task).
