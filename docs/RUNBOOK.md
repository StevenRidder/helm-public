# Runbook - Build, Run, and Verify Helm on macOS

**Audience:** an engineer or alpha tester on macOS who wants to build the
headless engine, run the web client, and verify the current one-origin stack.

**What you are building today:** a C++ `helm-server` that reuses OpenCPN's
`model/` navigation core and S-52/S-57 renderer headlessly, plus the browser
client in `web/`. The server owns `/nav`, `/chart/{z}/{x}/{y}.png`, `/health`,
`/catalog`, and the static UI on one HTTP/WebSocket origin.

The browser/web client is the reference client. The `native/` subtree contains App-Store-clean
client/protocol code and thin native shells used to prove Apple-target packaging, discovery, and
WKWebView capability gates; it does not embed the GPL OpenCPN engine, wxWidgets, chart rendering,
serial drivers, or networking stacks from the engine.

## Live-Port Warning

In shared development environments, `:8080` may be reserved for a stable live
instance and must not be killed or replaced by agents. The examples below use
private port `9001`. On your own machine you can choose another port, but using
a private port keeps the habit safe.

## 0. TL;DR

```bash
# 1. Prerequisites, once.
brew install wxwidgets@3.2 gpatch cmake libarchive libusb libsndfile mpg123 lame openssl@3 gdal node python3
sudo xcodebuild -license accept

# 2. Build the one-origin engine. First run may take 10-20 minutes.
engine/bootstrap.sh

# 3. Optional but recommended: install a free NOAA ENC sample into ~/.helm/runtime/enc.
scripts/install-sample-enc.sh

# 4. Set up the weather gateway venv, once.
python3 -m venv services/wx/.venv
services/wx/.venv/bin/python -m pip install -r services/wx/requirements.txt

# 5. Run a private one-origin server plus weather and online-fill helpers.
scripts/start-helm.sh --port 9001 --weather --fill

# 6. Open the client.
open http://127.0.0.1:9001/
```

**Shortcut:** after the one-time build (step 2), `scripts/start-helm.sh` launches the
core on the port you choose (add `--weather`/`--basemap`/`--fill`/`--backend`,
or `--all`, to also bring up the opt-in helper services on the ports in
[PORTS.md](PORTS.md); each is skipped with a clear reason if its deps/data are absent).
The sample ENC is used automatically if it exists at `~/.helm/runtime/enc/US5FL4CR/US5FL4CR.000`.
Ctrl-C stops everything it started.

```bash
scripts/start-helm.sh --port 9001 --all
```

The UI will load even without live vessel data. To see live movement, feed NMEA or
configure a SignalK/NMEA connection as described below.

## 1. Prerequisites

| Tool | Why | Install |
|---|---|---|
| Xcode CLT / Xcode | C/C++ toolchain | `xcode-select --install`; if full Xcode is active, run `sudo xcodebuild -license accept` |
| wxWidgets 3.2 | OpenCPN dependency; 3.3 is not compatible | `brew install wxwidgets@3.2` |
| GNU patch (`gpatch`) | OpenCPN bundled-lib patches require GNU patch | `brew install gpatch` |
| CMake | build system | `brew install cmake` |
| OpenCPN native deps | archive, device, sound, mp3, and TLS libraries used by the headless build | `brew install libarchive libusb libsndfile mpg123 lame openssl@3` |
| GDAL | optional depth extraction pipeline | `brew install gdal` |
| node | smoke tests and WebSocket checks | `brew install node` |
| python3 | helper scripts | macOS/Homebrew Python |

`engine/bootstrap.sh` checks prerequisites and fails with the specific fix when
something is missing.

### Native client core compile gate

The native Apple lane starts with a tiny C++17 client/protocol core, not a SwiftUI app and not an
iOS build of OpenCPN. To verify it:

```bash
./native/test-native-core.sh
```

The first iOS proof shell is a WKWebView wrapper around the existing web UI. It discovers a
boat-side `helm-server` over Bonjour (`_helm._tcp`) and loads that HTTP/TLS origin in a native
shell without embedding OpenCPN/GPL code:

```bash
native/ios/build-ios-proof.sh
```

That builds and tests `libhelm_native_core.a` on macOS, then compiles the same static library for
iOS Simulator and iPhoneOS when the Apple SDKs are installed. The native core is intentionally
transport-free: it shares snapshot/delta nav-state reduction, staleness classification, resume
metadata, and pairing/trust storage shape with future Swift clients while the boat server keeps
owning safety-critical navigation.

Run the proof from Xcode (`native/ios/HelmWebViewProof.xcodeproj`) against a private Helm server,
for example `scripts/start-helm.sh --port 9001`. Do not use the shared live `:8080` instance for
agent testing.

## 2. Chart and Weather Data

Helm does not include chart packs. Bring your own local charts/basemaps at
runtime, the same general posture as OpenCPN: the repo supplies code and safe
sample/public data, while user-owned ENC cells, MBTiles/PMTiles, private
satellite packs, `~/.helm` runtime data, and generated caches stay outside Git.

### NOAA ENC Cells

Free US ENC cells are available from NOAA:
<https://www.charts.noaa.gov/ENCs/ENCs.shtml>

Install the default sample cell into Helm's durable runtime directory:

```bash
scripts/install-sample-enc.sh
# ~/.helm/runtime/enc/US5FL4CR/US5FL4CR.000
```

`helm-server` reads a single ENC from `HELM_ENC` — a user-provided NOAA `.000`
cell (Helm ships no chart packs). A valid cell is required for S-52 ENC tiles,
but not for the server to boot. If the cell is missing or invalid, Helm starts in
basemap-only mode: `/health` stays green, `/catalog` reports zero chart cells,
`/chart/...png` returns transparent tiles, and local MBTiles/PMTiles or online
fill can still paint underneath. The S-52 **presentation library** it renders
with is installed durably by `bootstrap.sh` into `~/.helm/runtime/s57data`
(override with `HELM_S57_DATA`) and survives a reboot.

### Local Basemap Packs

The browser UI has local/user-owned chart and imagery slots. In Steve's local
cockpit those are served from local packs on `:8091`; another user can point the
same slots at their own local MBTiles/PMTiles service or configure equivalent
local basemap sources. Do not commit MBTiles, PMTiles, ENC bundles, private
imagery, or generated chart caches to this repo.

Best performance comes from copying the owned packs to the machine that is
serving the UI and starting the local pack helper:

```bash
HELM_MBTILES_DIR="$HOME/.helm/basemaps/fiji-tcl2407" \
  scripts/start-helm.sh --port 9001 --weather --basemap --fill
```

The helper scans `HELM_MBTILES_DIR` for both `*.mbtiles` and `*.pmtiles`.
MBTiles remain available as XYZ tile endpoints. PMTiles are advertised in
`/catalog` with a Range-readable `pmtiles_url` and `pmtiles://` protocol URL, so
MapLibre clients can load single-file local packs without inventing per-pack
tile URL templates.

To pre-bake an S-52 chart region from a private chart-tile origin into a local
PMTiles pack, first run `helm-server` or `helm-tiles` on a private port, then
batch the same `/chart/{z}/{x}/{y}.png` renderer over the chosen bbox:

```bash
python3 pipeline/bake_s52_region_pack.py \
  --source "http://127.0.0.1:9001/chart/{z}/{x}/{y}.png" \
  --bbox "176.8,-19.2,180.0,-16.0" \
  --minzoom 7 --maxzoom 12 \
  --palette day \
  --display-category std \
  --edition "source-chart-edition-or-update-chain" \
  --out "$HOME/.helm/basemaps/fiji-tcl2407/fiji-s52-day.pmtiles"
```

The output PMTiles metadata includes the Helm pack schema, renderer, palette,
display category, chart edition/epoch, render date, bbox, z-range, and tile
counts. Bake dusk/night as separate packs when offline palette fidelity matters.
Do not bake against the shared live `:8080` screen.

For a direct local acceptance run, start only the local pack helper and open the
Chart Packs panel in the browser. The UI discovers `/catalog`, lists each local
pack, and activates the selected pack as the MapLibre raster/PMTiles source.
Use C++ `helm-packd` for runtime checks and `basemapPort` when the helper is not
on the default `:8091`:

```bash
HELM_MBTILES_DIR="$HOME/.helm/basemaps/fiji-tcl2407" \
  /private/tmp/helm-offline/build/cli/helm-packd 9120

python3 web/serve.py 9100
# open http://127.0.0.1:9100/?basemapPort=9120
```

`pipeline/mbtiles_server.py` remains the Python reference/oracle for manifest
evolution and quick stdlib-only checks.

The same helper can describe the whole local offline region without touching
client storage:

```bash
curl "http://127.0.0.1:9120/bundle?bbox=176.8,-19.2,180.0,-16.0&minzoom=7&maxzoom=12" \
  | python3 -m json.tool

python3 pipeline/region_bundle.py \
  --catalog "http://127.0.0.1:9120/catalog" \
  --bbox "176.8,-19.2,180.0,-16.0" \
  --minzoom 7 --maxzoom 12 \
  --bundle-id fiji \
  --title "Fiji offline bundle"
```

That `helm.region_bundle.manifest.v1` output groups charts, basemap imagery,
depth/places descriptors when present, source/freshness/coverage/inspection
metadata, and route/bbox prefetch advice. Use
`pipeline/region_bundle.py --diff-against installed-bundle.json` to produce a
read-only update plan for missing, changed, stale, and out-of-coverage
components.

If the packs live on another Mac temporarily, use the cache-backed proxy rather
than a thin forwarding proxy. The first view still warms from the upstream Mac,
but repeated zoom/pan serves from `~/.helm/basemap-proxy-cache`:

```bash
HELM_BASEMAP_UPSTREAM="http://192.168.1.137:8091" \
  scripts/start-helm.sh --port 9001 --weather --basemap-proxy --fill
```

`Online fill` is an optional underlay/cache on `:8095`. It can help fill gaps
under local charts, but it is off by default and is not the primary chart source.
The online-fill toggle in the UI persists its on/off state, and on a LAN it
rewrites the basemap-fill host to the serving machine's address so other devices
on the network reach the same `:8095` proxy.

### Depth-on-Satellite GeoJSON

Optional overlay extraction:

```bash
pipeline/extract_depth.sh ~/.helm/runtime/enc/US5FL4CR/US5FL4CR.000
```

This writes generated GeoJSON under `HELM_USER_DATA_ROOT`, `HELM_CONFIG/data`,
or `~/.helm/data` by default. Helm serves that directory at same-origin
`/user-data/` and prefers those user-owned files over the bundled `web/data/`
demo fixtures. Without user data, the browser falls back to the public demo
GeoJSON; the S-52 engine tiles still render if `HELM_ENC` points at a valid cell.

Expected local depth overlay filenames:

```text
~/.helm/data/depare.geojson
~/.helm/data/depcnt.geojson
~/.helm/data/soundg.geojson
~/.helm/data/depth-contours.geojson
```

### Weather

```bash
bash pipeline/build.sh
```

This builds demo/public-data weather layers into `web/data/`.

## 3. Build

```bash
engine/bootstrap.sh
```

The bootstrap clones the pinned OpenCPN source into `~/.helm/build/helm-opencpn`, applies
Helm's maintained patch series, overlays Helm's new CLI sources, and builds the
Helm targets, including:

```text
~/.helm/build/helm-opencpn/build/cli/helm-server
~/.helm/build/helm-opencpn/build/cli/helm-engine
~/.helm/build/helm-opencpn/build/cli/helm-tiles
~/.helm/build/helm-opencpn/build/cli/helm-tides-smoke
```

`helm-server` is the normal product path. `helm-engine` and `helm-tiles` remain
useful lower-level split-process debugging tools.

To rebuild from scratch:

```bash
engine/bootstrap.sh --clean
```

To run the bootstrap's smoke check on a private port:

```bash
engine/bootstrap.sh --smoke
```

## 4. Run the One-Origin Server

```bash
scripts/start-helm.sh --port 9001 --weather --fill
```

Open:

```bash
open http://127.0.0.1:9001/
```

Sanity checks:

```bash
curl -s http://127.0.0.1:9001/health
curl -s http://127.0.0.1:9001/catalog
mkdir -p ~/.helm/runtime/smoke
curl -s -o ~/.helm/runtime/smoke/helm-tile.png -w '%{http_code}\n' \
  http://127.0.0.1:9001/chart/12/1120/1756.png
```

## 5. Feed Boat Data

The server seeds a local NMEA TCP relay on `127.0.0.1:10110` for first-run
testing. You can send NMEA 0183 sentences to it:

```bash
cat engine/test/fixtures/ais_sample.nmea | nc 127.0.0.1 10110
```

For a real boat, add connections through the UI or provide a persisted
`HELM_CONFIG` with `connections.json`. Supported connection types include TCP
client/server, UDP, SignalK, serial, NMEA 2000 placeholders, and internet AIS
raw NMEA feeds.

For SignalK, configure the connection in the UI or use the persisted connection
file under the selected `HELM_CONFIG` directory.

## 6. Verify End-to-End

After a build, run:

```bash
engine/test-engine.sh
```

It starts private test instances and verifies:

- one-origin `helm-server` framing, `/health`, `/catalog`, UI, and S-52 tiles;
- no-ENC basemap-only boot behavior via `engine/test-no-enc-boot.sh`;
- immutable tile caching and ETag revalidation;
- nav-core per-fix math, source tags, and waypoint auto-advance;
- GPL containment guard;
- offline tide smoke/regression coverage.

Fresh-install durability has its own CI smoke:

```bash
engine/test-fresh-clone-install.sh
```

That check runs with an empty temporary `HOME`, installs the public sample ENC
into `~/.helm/runtime`, runs `engine/bootstrap.sh --clean --smoke`, and requires
`/health`, `/catalog`, and a real ENC chart tile to render without any `/tmp`
pre-seeding.

## 7. What to Look For in the Browser

| Feature | Pass looks like |
|---|---|
| One-origin UI | `http://127.0.0.1:9001/` serves the browser app |
| Health/catalog | `/health` and `/catalog` return JSON |
| Charts | S-52 chart tiles render when `HELM_ENC` points at a valid NOAA cell; without one, Helm stays up in basemap-only mode |
| Data honesty | missing or stale data is shown as missing/stale, not silently live |
| AIS | AIS targets appear after NMEA/AIS sentences reach the server |
| Routes | route create/save/activate uses the command plane and navobj persistence |
| Weather | generated weather layers appear after `pipeline/build.sh` |

## 8. Troubleshooting

- `wx-config not executable`: install `wxwidgets@3.2` or set `WX_CONFIG`.
- Xcode license errors: run `sudo xcodebuild -license accept`.
- `patch` errors during OpenCPN configure: install `gpatch`.
- `dyld: library not loaded`: set `DYLD_LIBRARY_PATH` as shown above.
- No ENC tiles: set `HELM_ENC` to a valid `.000` file. If none is configured,
  Helm should still boot; `/health` reports `chart_loaded:false`.
- UI loads but no boat movement: feed NMEA/SignalK; the server should not fake a
  live vessel.
- Port conflict: pick another private `HELM_PORT` and, if needed,
  `HELM_RELAY_PORT`.

## 9. Public Alpha Caveat

Helm is pre-alpha navigation software. It is not type-approved ECDIS, not a
primary navigation system, and not a substitute for official charts,
instruments, watchkeeping, or seamanship. See [SAFETY.md](../SAFETY.md),
[LEGAL.md](LEGAL.md), [CLIENT-LICENSE-REGISTER.md](CLIENT-LICENSE-REGISTER.md),
root [LICENSE](../LICENSE), and [LICENSE.BSL](../LICENSE.BSL) before
distributing a public build.
