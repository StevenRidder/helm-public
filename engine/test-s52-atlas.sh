#!/usr/bin/env bash
#
# Dependency-free smoke for the C++ S-52 atlas pipeline. This intentionally
# avoids Vulkan, wxWidgets, and the full OpenCPN build so SYM-2 can be validated
# in a clean checkout before renderer integration exists.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-s52-atlas.$$"
FIXTURE="$HERE/test/fixtures/s52-atlas/s52_atlas.fixture"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin" "$TMP/out-a" "$TMP/out-b" "$TMP/smoke"

"$CXX" -std=c++11 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_s52_atlas.cpp" \
  "$HERE/vendor/cli/helm_s52_atlas_builder.cpp" \
  -o "$TMP/bin/helm-s52-atlas-builder"

"$CXX" -std=c++11 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_s52_atlas.cpp" \
  "$HERE/vendor/cli/helm_s52_atlas_smoke.cpp" \
  -o "$TMP/bin/helm-s52-atlas-smoke"

"$TMP/bin/helm-s52-atlas-builder" \
  --input "$FIXTURE" \
  --output "$TMP/out-a" \
  --palettes day,dusk,night

"$TMP/bin/helm-s52-atlas-builder" \
  --input "$FIXTURE" \
  --output "$TMP/out-b" \
  --palettes day,dusk,night

cmp "$TMP/out-a/s52_atlas_manifest.json" "$TMP/out-b/s52_atlas_manifest.json"
cmp "$TMP/out-a/s52_symbols_day.ppm" "$TMP/out-b/s52_symbols_day.ppm"
cmp "$TMP/out-a/s52_patterns_night.ppm" "$TMP/out-b/s52_patterns_night.ppm"
cmp "$TMP/out-a/s52_lines_dusk.ppm" "$TMP/out-b/s52_lines_dusk.ppm"

"$TMP/bin/helm-s52-atlas-smoke" "$FIXTURE" "$TMP/smoke"

echo "ok test-s52-atlas: deterministic C++ atlas builder and loader"
