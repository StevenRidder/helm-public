#!/usr/bin/env bash
# Verify a live Helm server with the same Playwright gates used for parity.
set -euo pipefail

URL="${1:-http://127.0.0.1:8080}"
HASH="${2:-#11/24.52/-81.77}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/web/test"
HELM_VERIFY_CHART=1 HELM_E2E_URL="$URL" HELM_E2E_HASH="$HASH" npm run test:e2e -- e2e/verified-chart-view.spec.js
HELM_E2E_URL="$URL" npm run test:e2e -- e2e/verified-local-ui.spec.js
HELM_E2E_URL="$URL" npm run test:e2e -- e2e/verified-weather-gateway.spec.js
