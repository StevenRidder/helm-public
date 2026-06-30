# Vulkan S-52 Atlas Pipeline

Status: Vulkan board `SYM-2`

This document describes the first C++ atlas pipeline for S-52 symbols, area
patterns, and line styles. It is deliberately small: the initial implementation
uses a redistributable fixture corpus, deterministic PPM atlas images, and a JSON
manifest contract that later VSG/Vulkan renderer work can load without depending
on OpenCPN GUI globals.

The runtime/rendering boundary is C++ only. Python may still help fixture or
golden-file chores, but palette application, atlas packing, manifest writing,
and manifest loading live in C++.

## Files

Implementation:

```text
engine/vendor/cli/helm_s52_atlas.h
engine/vendor/cli/helm_s52_atlas.cpp
engine/vendor/cli/helm_s52_atlas_builder.cpp
engine/vendor/cli/helm_s52_atlas_smoke.cpp
```

Fixture and smoke:

```text
engine/test/fixtures/s52-atlas/s52_atlas.fixture
engine/test-s52-atlas.sh
```

OpenCPN overlay wiring:

```text
engine/patches/0003-cli-cmakelists-helm-targets.patch
engine/bootstrap.sh
```

The CMake patch adds `helm-s52-atlas-builder` and
`helm-s52-atlas-smoke`. `engine/bootstrap.sh` builds both targets with the
normal Helm C++ binaries.

## Fixture Input

The first fixture is intentionally line-oriented so the C++ builder needs no
third-party parser:

```text
kind name width height anchor_x anchor_y repeat_x repeat_y dash day dusk night
symbol BOYSPP 12 12 6 6 0 0 - #f5d76e #b38b2e #8a5a22
pattern DEPARE01 8 8 0 0 8 8 - #b9d7e8 #5f7a88 #1b3c4b
line DEPCNT02 16 4 0 2 0 0 3,2 #4a6f8a #304a5a #7eb6d6
```

The fixture represents one point symbol, one repeatable area pattern, and one
line style across day, dusk, and night palettes. The names mirror S-52 asset
families, but the geometry and colors are synthetic and repo-owned.

## Builder

Example:

```bash
helm-s52-atlas-builder \
  --input engine/test/fixtures/s52-atlas/s52_atlas.fixture \
  --output /tmp/helm-s52-atlas \
  --palettes day,dusk,night
```

Outputs:

```text
s52_symbols_day.ppm
s52_symbols_dusk.ppm
s52_symbols_night.ppm
s52_patterns_day.ppm
s52_patterns_dusk.ppm
s52_patterns_night.ppm
s52_lines_day.ppm
s52_lines_dusk.ppm
s52_lines_night.ppm
s52_atlas_manifest.json
```

PPM is used for the first slice because it is deterministic and dependency-free.
The manifest format is the contract; later work can switch atlas image encoding
to PNG or a GPU-native cache by changing the schema version.

## Manifest Contract

The manifest contains:

```text
schema_version
generator
palettes[]
atlases[]
entries[]
```

Each atlas records:

```text
kind          # symbol, pattern, line
palette       # day, dusk, night
image
format        # ppm-p3 in this slice
width
height
```

Each entry records:

```text
name
kind
palette
atlas
pixel_rect    # x, y, width, height
uv            # u0, v0, u1, v1
anchor
repeat        # pattern repeat/tile metadata
dash          # line-style dash segments
color         # resolved palette color for fixture verification
```

Downstream renderer code should look up entries by `(name, kind, palette)`, bind
the referenced atlas image, and use `pixel_rect`/`uv` plus kind-specific
metadata. The backend must not reinterpret S-52 palette or style rules while
loading this manifest.

## Determinism

Atlas packing is deterministic:

- fixture entries are sorted by kind and name;
- palettes are emitted in caller order;
- each `(name, kind, palette)` key is unique;
- atlas images and manifest entries are generated from stable row packing;
- the smoke test builds twice and compares representative outputs byte-for-byte.

## Verification

Run:

```bash
engine/test-s52-atlas.sh
```

The smoke test compiles the C++ builder and loader without wxWidgets, OpenCPN,
VSG, or Vulkan. It proves:

- one symbol, one pattern, and one line style are ingested;
- day/dusk/night variants are generated separately;
- manifest ordering is deterministic;
- UV and pixel rects stay inside atlas bounds;
- line dash metadata and pattern repeat metadata survive manifest load;
- the runtime-side C++ lookup API can resolve entries by key.

## Deferred

This slice does not cover full Chart 1 rendering, text placement, soundings,
complete `chartsymbols.xml` ingestion, PNG encoding, GPU uploads, or final cache
format selection. Those belong to downstream renderer and Chart 1 acceptance
tasks once this manifest contract is stable.
