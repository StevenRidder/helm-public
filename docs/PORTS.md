# Helm Port Map

Use private development ports while testing Helm. Do not assume another developer's
machine, boat server, or demo process is safe to stop or replace.

## Common Ports

| Port | Service | Notes |
|------|---------|-------|
| 8080 | Default `helm-server` port | Product default only. In shared environments this may already be reserved. |
| 8090 | Optional backend service | Weather, places, and community/LLM prototype endpoints. |
| 8091 | Optional BYO local pack server | Local MBTiles/PMTiles packs served by C++ `helm-packd`; `pipeline/mbtiles_server.py` remains the Python reference/oracle. Packs are not committed. **Reserved for basemaps — other services must NOT bind it.** |
| 8093 | Optional weather gateway | `services/wx` value-tile gateway (Open-Meteo). Must use :8093, never :8091 (WX-15). |
| 8095 | Optional basemap-fill proxy | Online Sentinel-2 fill/cache service. |
| 9001+ | Private development servers | Recommended for local agent/test runs. |

## Public-Alpha Rule

Run examples on a private port:

```bash
scripts/start-helm.sh --port 8080 --weather --fill
```

For BYO MBTiles or PMTiles, point the helper at a local directory:

```bash
HELM_MBTILES_DIR="$HOME/Charts/local-packs" \
  /path/to/build/cli/helm-packd 8091
```

OFFLINE-16/17 moved the runtime helper to C++ as `helm-packd`: MBTiles/PMTiles
serving, `/catalog`, `/layers`, `/prefetch`, `/bundle`, and public
sidecar/freshness/coverage/inspection metadata. Treat `pipeline/mbtiles_server.py`
as the reference/oracle and use private test ports for agent runs:

```bash
HELM_OCPN_DIR=/private/tmp/helm-offline16-ocpn \
  engine/bootstrap.sh --dir /private/tmp/helm-offline16-ocpn --jobs 4
HELM_MBTILES_DIR="$HOME/Charts/local-packs" HELM_BIND=127.0.0.1 \
  /private/tmp/helm-offline16-ocpn/build/cli/helm-packd 9120
```

MBTiles packs are exposed as `/{pack}/{z}/{x}/{y}.{ext}` for existing raster
sources. PMTiles packs are exposed as `/{pack}.pmtiles` with HTTP Range support
and are advertised in `/catalog` with `pmtiles_url` and `protocol_url`. The same
helper exposes `GET /prefetch` for route-corridor or bbox tile manifests that a
client can use to warm its local cache without mutating the packs. `GET /layers`
exposes the local maritime layer inventory: chart/basemap/depth/weather/places/S-100-style
metadata with coverage, freshness, source, confidence, and sample/probe handles for client
inspection without leaking private filesystem paths. `GET /bundle` groups those
packs plus the prefetch advice into a `helm.region_bundle.manifest.v1` response.

If packs are temporarily on another Mac, use the cache-backed proxy instead
of a thin one-hop proxy:

```bash
HELM_BASEMAP_UPSTREAM="http://192.168.1.137:8091" \
  scripts/start-helm.sh --port 8080 --weather --basemap-proxy --fill
```

Commercial, proprietary, or personally acquired chart packs must stay local and
must not be committed to this repository.
