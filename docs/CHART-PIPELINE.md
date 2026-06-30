# Chart pipeline — on-demand acquisition + depth-on-satellite

> The signature capability: "ChartLocker, but live." Lasso an area → fetch → pack
> mbtiles → cache offline. Plus ENC depth overlaid on satellite imagery.

## What ChartLocker actually is (and isn't)

[ChartLocker](https://chartlocker.brucebalan.com) (Bruce Balan & Alene Rice) is **not
software** — it's a hand-curated catalog of **pre-built regional `.mbtiles` ZIPs**
(Bing/Google/ArcGIS satellite + rasterized Navionics) downloaded from MediaFire and
loaded into OpenCPN 5.x via Chart Groups + quilting. The authors georeference and tile
each region by hand, then post the ZIPs.

The "select-an-area, fetch-on-demand" behavior the user wants **does not exist in
ChartLocker** — it's the live version we're building. The engineering is easy; the hard
part is licensing ([LEGAL.md](LEGAL.md)).

## The on-demand tiler

Runs **server/edge-side** (not on-device), so source credentials and source-swapping
stay off the device.

```
bbox + max-zoom
   │
   ├─ bbox → XYZ tile list            (standard slippy-map enumeration)
   ├─ fetch tiles from source         (Sentinel-2 / NOAA / OpenSeaMap — clean only)
   ├─ georeference                    (pre-georeferenced sources skip this;
   │                                   ad-hoc imagery → gdalwarp + GCPs)
   ├─ pack to mbtiles                 (GDAL MBTiles driver / gdal2tiles.py)
   │     ⚠ TMS Y-flip: mbtiles uses y=0 at SOUTH, XYZ uses y=0 at NORTH
   └─ device downloads packed mbtiles → caches offline → MapLibre + quilting
```

Tooling is entirely off-the-shelf GDAL:
[`gdal2tiles`](https://gdal.org/en/stable/programs/gdal2tiles.html) /
[MBTiles driver](https://gdal.org/en/stable/drivers/raster/mbtiles.html).

### Tile / size math (set user expectations)

Web-Mercator tile side = 40,075,017 m / 2^z:

| Zoom | m/tile | typical use |
|---|---|---|
| Z16 | ~611 m | default cap |
| Z17 | ~305 m | coastal detail |
| Z18 | ~153 m | anchorages (opt-in) |

Each zoom is ~4× the tiles of the previous. A moderate cruising region at Z8–Z18 runs
**hundreds of MB to several GB per source** (ChartLocker's Fiji BingSat set is 5.93 GB).
Implication: cap default max zoom (~Z16), make Z18 opt-in for anchorages, fetch
incrementally, show an estimated size before download.

## Source tiers (summary — see LEGAL.md for the binding rules)

- **Clean (ship it):** Sentinel-2/Copernicus (free, commercial-OK, attribution req'd,
  10 m), NOAA ENC + NCDS raster (US public domain), OpenSeaMap (ODbL, seamarks overlay
  only).
- **Bring-your-own:** Google, Bing (ToS bars cache/bulk-download; Bing EOL 2028) — user
  imports their own `.mbtiles`; we never server-fetch or host.
- **Partnership:** Navionics (official API is online-display-only; scraping prohibited),
  Esri World Imagery (SDK-locked, per-export cap, Maxar downstream terms).

The full ChartLocker workflow is preserved 1:1 via **"import my own `.mbtiles`"** — so
the product never has to touch a prohibited tile.

## Depth-on-satellite (the wholybee technique, generalized)

[wholybee/chartplotter](https://github.com/wholybee/chartplotter) is a Qt6 + GDAL **S-57
ENC viewer** that depth-shades areas and labels soundings (and now follows routes +
drives an autopilot). It proved the **hard half** — parsing depth out of S-57. It does
*not* itself touch satellite.

Helm composites that depth layer **over** satellite raster:

- **Base raster:** satellite mbtiles (Sentinel-2 / BYO Bing / Google).
- **Overlay vector:** NOAA ENC S-57 →
  - `DEPARE` — depth-area fills (translucent),
  - `DEPCNT` — depth contours,
  - `SOUNDG` — soundings, with depth labels.

Rendered translucent on top of the imagery, with depth labels. The satellite shows you
the reef and the sandbar; the ENC overlay puts the numbers on it. This is "satellite
piloting with depth" — the holy grail for thin water and poorly-charted atolls.

All public-domain (NOAA ENC) over a clean base (Sentinel-2) → fully offline, fully
shippable.

For offline S-52 chart snapshots, `pipeline/bake_s52_region_pack.py` drives the
same live `/chart/{z}/{x}/{y}.png` renderer over a selected XYZ pyramid and emits
a PMTiles pack. The pack is stamped with the renderer, palette, display category,
source chart edition/epoch, render date, freshness window, bbox, z-range, requested
tile counts, baked tile counts, coverage gaps, and palette sibling group. The
local pack server normalizes those stamps into `/catalog` `staleness`, `coverage`,
and `warnings` fields so client work can warn about stale or out-of-coverage chart
pixels without reimplementing pack metadata rules.

### Local pack source and tap metadata

`pipeline/mbtiles_server.py` keeps MBTiles and PMTiles packs read-only and publishes
only public catalog metadata. Each `/catalog` entry includes:

- `source_info`: source label/id/url/ref/format, license, attribution, modified time,
  source created/updated/downloaded/freshness/confidence fields when the pack exposes
  them, plus chart edition/epoch and render date for S-52 snapshots.
- `coverage`, `staleness`, and `warnings`: normalized pack status for UI warnings.
- `inspection`: the deterministic tap policy for the pack.

Tap behavior is intentionally honest:

- ENC/vector objects are queried through the live chart-object path when available.
- Raster chart or satellite packs show pack/source metadata; raster pixels are not
  semantic chart objects.
- Depth packs may show depth/source/confidence, but they are still not chart-object
  attributes.
- AIS taps stay on the AIS target/card path.

For future curated raster hints, place a JSON sidecar next to the pack:

```text
fiji-chart.pmtiles
fiji-chart.metadata.json
```

The sidecar is allow-listed to public metadata fields such as source id/ref/url,
license, attribution, coverage note, and a small `inspection` object. The server
exposes only the sidecar filename, never the local directory path. A sidecar may
say "show these curated hints first," but it must not claim that raster pixels are
native S-57/S-101 objects.

### Route-corridor prefetch manifests

The local pack server also exposes `GET /prefetch` for passage planning cache
warm-up. It does not download tiles by itself; it returns a deterministic manifest
the client/native app can use to warm HTTP, PMTiles, browser, or device caches.

Examples:

```text
/prefetch?route=178.0,-18.0;178.3,-17.7&radius_nm=2&minzoom=8&maxzoom=12&packs=chart,sat
/prefetch?bbox=178.0,-18.0,179.0,-17.0&minzoom=8&maxzoom=12
```

The response includes the expanded corridor bbox, selected packs, effective zoom
range per pack, tile coordinates, tile URLs, truncation status, and rough byte
estimates when the pack has enough metadata. This is the route/passage-corridor
piece. General viewport overscan, no-blank-edge panning, and adjacent-zoom warming
belong to the client-side cache scheduler work.

### Region bundle manifests and delta plans

`pipeline/region_bundle.py` builds `helm.region_bundle.manifest.v1`, the first
bundle-level contract for the Fiji/local-pack proof:

```text
/catalog + route/bbox request
  -> chart/basemap/depth/places component inventory
  -> source/freshness/coverage/inspection status
  -> route/bbox prefetch manifest
  -> per-component fingerprints
  -> bundle manifest
```

The local pack server exposes the same manifest through `GET /bundle`. With no
`bbox` or `route`, the bundle uses the union of selected pack bounds. With a
route or bbox, it embeds the `helm.prefetch.manifest.v1` advice for that corridor.

Examples:

```text
/bundle?bbox=178.0,-18.0,179.0,-17.0&minzoom=8&maxzoom=12
/bundle?route=178.0,-18.0;178.3,-17.7&radius_nm=2&packs=chart,sat
```

The companion diff helper compares an available bundle with an installed bundle
and reports `missing`, `changed`, `stale`, and `out_of_coverage` components. It
does not decide UI policy or mutate files. This keeps pack management backend
state clear while the client-side OFFLINE work handles selector UI, viewport
overscan, no-blank-edge panning, and local cache behavior.

> ⚠ **Supplemental only.** Satellite + satellite-derived bathymetry is an aid, never
> primary navigation. Clouds hide reefs; imagery can paint reefs out; SDB ≈ IHO ZOC-C.
> A permanent "cross-reference official charts" disclaimer is mandatory on these layers.

## Shared Vulkan renderer adapter

The Vulkan POC keeps Helm's public tile contract stable while replacing the
server-side renderer behind a feature flag. See
[VULKAN-HEADLESS-TILE-ADAPTER.md](VULKAN-HEADLESS-TILE-ADAPTER.md) for the
Helm `/chart/{z}/{x}/{y}.png` adapter sketch: viewport math, offscreen target,
cache keys, ETags, diagnostics, fallback, and MapLibre composition.
