#!/usr/bin/env bash
# Install a small NOAA ENC sample cell into Helm's durable runtime directory.
set -euo pipefail

ROOT="${HELM_ENC_ROOT:-$HOME/.helm/runtime/enc}"
CELL="${HELM_SAMPLE_ENC_CELL:-US5FL4CR}"
URL="${HELM_SAMPLE_ENC_URL:-https://www.charts.noaa.gov/ENCs/$CELL.zip}"
DEST="$ROOT/$CELL"
STAGE="$ROOT/.download-$CELL.$$"

die() { echo "install-sample-enc: $*" >&2; exit 1; }
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

command -v curl >/dev/null || die "curl not found"
command -v unzip >/dev/null || die "unzip not found"

mkdir -p "$ROOT"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "install-sample-enc: downloading $CELL -> $ROOT"
curl -fL "$URL" -o "$STAGE/$CELL.zip"
unzip -q -o "$STAGE/$CELL.zip" -d "$STAGE"

FOUND="$(find "$STAGE" -name "$CELL.000" -print -quit)"
[ -n "$FOUND" ] || die "download did not contain $CELL.000"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$(dirname "$FOUND")"/. "$DEST"/

echo "$DEST/$CELL.000"
