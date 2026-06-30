#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n== %s\n' "$*"; }

say "macOS native-core build + tests"
cmake --preset macos-debug -S "$ROOT"
cmake --build "$ROOT/build/macos-debug"
ctest --test-dir "$ROOT/build/macos-debug" --output-on-failure

if command -v xcrun >/dev/null 2>&1 && xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1; then
  say "iOS Simulator static-library compile"
  cmake --preset ios-simulator-release -S "$ROOT"
  cmake --build "$ROOT/build/ios-simulator-release" --target helm_native_core
else
  say "iOS Simulator static-library compile skipped: iphonesimulator SDK not available"
fi

if command -v xcrun >/dev/null 2>&1 && xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  say "iPhoneOS static-library compile"
  cmake --preset iphoneos-release -S "$ROOT"
  cmake --build "$ROOT/build/iphoneos-release" --target helm_native_core
else
  say "iPhoneOS static-library compile skipped: iphoneos SDK not available"
fi
