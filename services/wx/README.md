# helm-wx — met-ocean / data-layer gateway

A standalone, **clean-IP** microservice that turns external weather sources into Helm's
value-encoded Mercator tiles **on demand** — the online counterpart of
[`pipeline/make_value_tiles.py`](../../pipeline/make_value_tiles.py).

## Why it's its own service (not in the C++ engine)

Helm's GPL OpenCPN/S-52 core is quarantined behind the wire (arm's-length containment —
ADR-0006 / ADR-0009). This service is the **opposite corner**: net-new, permissively licensed
(FastAPI + httpx + Python stdlib — **no GPL, no OpenCPN**), a brick in the **post-GPL data plane**.

It's the seam where map data layers enter Helm:

- **Today** → Open-Meteo (free, no key).
- **Next** → the **S-100 met-ocean** product specs plug in here unchanged for the client:
  S-111 (surface currents) plus the S-412/S-413/S-414 weather/wave family — sitting beside the
  planned permissive **S-101** chart rebuild.

The client should not need product-specific branches — it consumes a bundle manifest, numeric field
tiles, vector fields, source metadata, and a common probe contract. Swap the fetcher behind the same
bundle contract and you've migrated a data layer off the legacy core.

## "Fetch once, serve many" (what Windy does)

A coarse **source grid** is fetched per coarse Mercator cell and cached; every output tile in that
cell is baked from it. One client or twenty, panning or zooming — we touch Open-Meteo only when we
move into a genuinely new area or the cache ages out (default 30 min). On a provider `429`/outage we
serve stale cache if we have it, else fail honestly. **We never fabricate a value to fill a gap**
(NODATA stays transparent). **NOT FOR NAVIGATION.**

## Contract — `helm-wxv1` (mirrors `web/wx-value-codec.js`)

```
GET /index.json                -> layer catalogue for the UI picker
GET /bundles/index.json        -> environmental bundle catalogue
GET /bundles/open-meteo/latest/manifest.json
                              -> Windy-parity bundle contract (layers, LOD, cache, S-100 metadata)
GET /bundles/open-meteo/latest/materialize?...
                              -> explicit WX-18 refresh job that writes a prepared local/cache bundle
GET /bundles/open-meteo/latest/{region}/manifest.json
GET /bundles/open-meteo/latest/{region}/layers/{layer}/scalar/{valid}/{z}/{x}/{y}.png
GET /bundles/open-meteo/latest/{region}/layers/{layer}/vector/{valid}/{u|v}/{z}/{x}/{y}.png
                              -> cache-only replay of prepared bundle files (no upstream fetch)
GET /{layer}/manifest.json     -> {encoding, scale, offset, ramp, bbox, minzoom, maxzoom, unit, ...}
GET /{layer}/{z}/{x}/{y}.png   -> 256x256 RGBA; RGB = 24-bit value, A = NODATA mask (0 = no data)
GET /velocity/{layer}?w=&s=&e=&n=
                              -> u/v grids for vector layers (`wind`, `current`)
GET /health
```

`value = offset + ((R<<16)|(G<<8)|B) * scale` — decoded + colourised **client-side** by
[`web/integrations/cog.js`](../../web/integrations/cog.js) (`helmwx://` protocol). `scale`/`offset`
are **fixed per layer** so colours and values are comparable across every tile and session.

Layers: `wind, gust, temp, pressure, rain, clouds, cape` (forecast API) + `sst, waves, swell, current` (Marine API).

## Environmental bundles — `helm.env.bundle.v1` (WX-17)

Full implementation contract: [`docs/ENVIRONMENTAL-BUNDLE-V1.md`](../../docs/ENVIRONMENTAL-BUNDLE-V1.md).

The Windy-parity target is **model-run bundles**, not viewport-triggered API work:

```text
model: open-meteo / gfs / ecmwf / marine
run:   explicit model run time (for real bundles) or "latest" compatibility mode
times: t0..tN valid times
layers: wind, gust, rain, temp, pressure, clouds, cape, waves, swell, current, sst
tiles: numeric field tiles, vector uv fields, optional display tiles
```

`/bundles/open-meteo/latest/manifest.json` is the first executable contract for that shape. It
advertises:

- all met-ocean layers and their fixed value encodings/ramps;
- scalar field-tile templates and vector u/v endpoints;
- overview/basin/regional LOD with parent fallback and overzoom rules so world view and close zoom use
  the same prepared data contract;
- a cache invariant: **pan, zoom, scrub, and layer toggles read prepared local/cache data only**;
- S-100 alignment metadata (`S-111` for currents, S-412/S-413/S-414 weather/wave family candidates)
  without claiming Open-Meteo is an official S-100 dataset;
- a `helm.layer.sample.v1` probe contract for route weather, pass advisors, AI explain-this, and future
  native clients.

Important honesty: the existing endpoints are still compatibility value tiles and may fetch on cache
miss today. WX-18 moves ingest into an explicit baker/refresh path so the gesture path never hammers
Open-Meteo. WX-19 consumes this bundle in the renderer instead of layering more raster hacks.

### Prepared bundles — WX-18 baker/cache slice

Provider fetches happen only through an explicit materialize/refresh job:

```bash
curl 'http://127.0.0.1:8093/bundles/open-meteo/latest/materialize?region=fiji-south-pacific&layers=wind,current&w=160&s=-35&e=-150&n=5&minzoom=0&maxzoom=3&tile_budget=512'
```

The service writes a durable bundle under:

```text
$HELM_WX_CACHE/env/bundles/open-meteo/latest/<region>/
  manifest.json
  layers/<layer>/scalar/<validTimeId>/<z>/<x>/<y>.png
  layers/<layer>/vector/<validTimeId>/{u,v}/<z>/<x>/<y>.png    # vector layers
```

Replay endpoints serve only those prepared files and include:

```text
X-Helm-Bundle-Cache: hit|miss
X-Helm-Upstream-Fetch: 0
```

That is the invariant WX-19 should depend on: pan/zoom/scrub/toggle/sample reads prepared local/cache
data and never calls the provider. Use `route=lon,lat;lon,lat;...` plus `route_margin=` instead of
`w/s/e/n` for a route-corridor prewarm. `tile_budget` intentionally fails closed before a refresh job
can accidentally fan out into a giant upstream/provider burst.

WX-22 adds multi-frame warm jobs for the Environmental Scene renderer. Add `frames=N` and optionally
`frame_hours=0,1,2` to materialize multiple forecast valid times in one bundle:

```text
/bundles/open-meteo/latest/materialize?region=fiji&layers=wind,temp&frames=3&frame_hours=0,1,2
```

The manifest keeps `run.validTimes[]`, `run.frameIdByValidTime`, and a top-level ordered `frames[]`
list shaped for the renderer: `{validTimeId, time, latest, validTime, isLatest, offsetSeconds}`.
Tile paths use compact UTC frame ids such as `20260630T010000Z`; `/latest/` remains an alias for the
first frame so older scene clients keep rendering while WX-23/WX-24 consume the explicit frame ids.

Wide overview materializations also enforce a source-grid point budget before provider fetches. A
large Fiji/South-Pacific bbox such as `w=160&e=-150` crosses the antimeridian and is internally held
as a continuous `160..210` grid for sampling, but the baker coarsens the provider source grid when
the requested resolution would create too many points. The bundle manifest records this under
`telemetry.materializeSourceGrid`, and replay stays cache-only (`X-Helm-Upstream-Fetch: 0`).

## Run

```bash
pip install -r requirements.txt
uvicorn app:app --port 8093
# point the client at  http://<host>:8093/{layer}/manifest.json
```

Use **:8093**, not :8091 — `:8091` is the offline basemap MBTiles server, and
binding the weather gateway there collides with it (WX-15). The web client already
expects weather on :8093.

### Open-Meteo API key (commercial)

The free tier is non-commercial + daily-capped. For production / heavy use, set a commercial key — the
service then uses `customer-api.open-meteo.com` (1M+ calls/mo, no daily cap). Put it in a **gitignored**
`services/wx/.env` (never commit it):

```
HELM_WX_OPENMETEO_KEY=your-key-here
```

`app.py` loads `.env` on startup (real env vars override it). Without a key it falls back to the free host.

Env knobs: `HELM_WX_CACHE` (dir), `HELM_WX_TTL` (s, default 1800), `HELM_WX_COOLDOWN` (s after a 429,
default 300), `HELM_WX_DATA_Z` (manifest maxzoom, default 7), `HELM_WX_FETCH_Z` (coarse source-grid zoom,
default 5), `HELM_WX_GRID_N` (source-grid resolution, default 12), `HELM_WX_CONCURRENCY` / `HELM_WX_MIN_INTERVAL`
(outbound throttle).

## Test

```bash
python3 test_wx.py        # offline — bakes, round-trips bake->PNG->decode->value, checks caching
```
