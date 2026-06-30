#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild not found; install Xcode to build the iOS proof shell" >&2
  exit 1
fi

xcodebuild \
  -project "$ROOT/HelmWebViewProof.xcodeproj" \
  -scheme HelmWebViewProof \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath "$ROOT/build" \
  CODE_SIGNING_ALLOWED=NO \
  build
