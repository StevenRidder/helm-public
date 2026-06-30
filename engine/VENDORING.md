# Vendoring OpenCPN — the headless chart-render build is reproducible

The headless S-52 renderer (`ocpn::chart-render`), the harmonic tide/current wrapper
(`ocpn::tides`), and the `helm-tiles` / `helm-engine`
binaries are **not** built by hand-editing a clone. They are reproduced from three
source-of-truth artifacts in this repo, glued by [`bootstrap.sh`](bootstrap.sh):

| Artifact | What it is |
|----------|------------|
| [`vendor/OPENCPN_REF`](vendor/OPENCPN_REF) | the pinned OpenCPN remote + commit SHA the build is reproduced against |
| [`patches/000N-*.patch`](patches/) | our edits to **upstream-tracked** files, applied in order |
| [`vendor/cli/*.cpp`](vendor/cli/) | our **new** `cli/` files, copied into the clone's `cli/` |

The clone at `$HELM_OCPN_DIR` (default `/tmp/helm-opencpn`) is **disposable** — it is
recreated from the pin on every bootstrap. Never hand-edit it; edits there are not the
source of truth and will be wiped on the next `--clean`.

## Build

```sh
engine/bootstrap.sh            # clone @ pin → apply patches → overlay cli/ → configure → build
engine/bootstrap.sh --smoke    # also render one tile and assert it has chart content
engine/bootstrap.sh --clean    # discard the clone and start fresh
```

Prerequisites (the script checks + fails loud): **wxWidgets 3.2** (3.3 removed `wxNode`;
`brew install wxwidgets@3.2`), **GNU patch** (`brew install gpatch` — OpenCPN's configure
patches a bundled lib with GNU syntax), `cmake`, `git`. Override `WX_CONFIG` /
`HELM_OCPN_DIR` if your paths differ.

Output binaries land in `$HELM_OCPN_DIR/build/cli/` (`helm-tiles`, `helm-engine`,
`chart-spike`, `helm-tides-smoke`, `libhelm-chartrender.a`, `libhelm-tides.a`). The script asserts the Step-6 seam invariant
(zero `top_frame::Get` symbols in the library) after building.

The tide wrapper defaults to the redistributable `harmonics-dwf-20210110-free.tcd`
source only. Other OpenCPN-local harmonic bundles are classified in output metadata
but stay off the default path unless a dev/test caller explicitly requests all local
sources.

## The patch series

| Patch | Touches | Why |
|-------|---------|-----|
| `0001-s57chart-headless-correctness.patch` | `gui/src/s57chart.cpp` | copy the SENC native scale into the chart so `GetNativeScale()` is correct on the headless full-Init path (SCAMIN / safety-contour correctness — a real upstream latent bug); sever the GUI `top_frame`/`GetBestVPScale` + plugin `dynamic_cast` from the render path under `OCPN_HEADLESS` |
| `0002-senc_manager-headless-topframe-seam.patch` | `gui/src/senc_manager.cpp` | guard the 5 background-SENC `top_frame::Get()` status-bar calls under `#ifndef OCPN_HEADLESS` so the library needs no frame object (Step-6 seam) |
| `0003-cli-cmakelists-helm-targets.patch` | `cli/CMakeLists.txt` | add the `helm-chartrender` and `helm-tides` libraries + `chart-spike` / `helm-tides-smoke` / `helm-tiles` / `helm-engine` targets (purely additive) |
| `0007-tcmgr-headless-include-seam.patch` | `gui/src/tcmgr.cpp` | under `OCPN_HEADLESS`, avoid GUI/navutil headers so the tide wrapper links only the tide/data-source slice plus narrow helper stubs |

These patch entries are deliberately small, real, and **upstreamable** where they touch
upstream-tracked files. See [`HARDENING.md`](HARDENING.md) for the per-change rationale
and verification.

## The overlay (`vendor/cli/`)

Our new files that OpenCPN's `cli/` does not ship: `chart_stubs.cpp` (the headless app
globals — `g_Platform`, `GetpSharedDataLocation`, the offscreen frame; **no** frame stub
since the Step-6 seam), `chart_spike.cpp` (single-tile render harness), `helm_tiles.cpp`
(S-52 tile HTTP server), `helm_tides.cpp` / `helm_tides.h` (thin source-tagged wrapper
over OpenCPN `TCMgr`), `helm_tides_stubs.cpp` (headless GUI seam for the tide slice),
`helm_tides_smoke.cpp` (offline harmonic prediction proof), `helm_engine.cpp` (nav
WebSocket + NMEA feed), `helm_spike.cpp` (minimal model-core spike). `api_shim.cpp` is
upstream — not part of the overlay.

## Refreshing a patch (when upstream moves or our edits change)

1. In a clone at the *current* pin, edit the upstream file (e.g. `gui/src/s57chart.cpp`).
2. Regenerate: `git -C <clone> diff gui/src/s57chart.cpp > engine/patches/0001-….patch`.
3. To bump the pin: update `OPENCPN_SHA` in `vendor/OPENCPN_REF`, re-`git apply --check`
   every patch against the new SHA, fix any that drift, then `bootstrap.sh --clean`.

## Bumping the OpenCPN pin

The pin is intentionally a single SHA so the build is deterministic. Bumping it is a
deliberate act: change `OPENCPN_SHA`, confirm all patches still apply, rebuild, and
re-run the byte-identical tile check (see `HARDENING.md`). wxWidgets must stay on 3.2.
