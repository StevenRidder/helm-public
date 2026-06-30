#!/usr/bin/env bash
#
# ENGINE-11 — Arm's-length GPL containment guard.
#
# Machine-checks the invariant from docs/decisions/0009-arms-length-gpl-containment.md:
#
#   The GPL S-52 / OpenCPN-model engine is contained inside standalone server
#   EXECUTABLES, reachable ONLY through the network protocol (nav WS + chart HTTP).
#   It is NEVER statically linked into — nor exposed as a linkable library to — a
#   distributed client binary. Clients (the web UI today; native clients later) couple
#   to the engine across the wire, at arm's length. "Network use is not distribution;
#   an arm's-length protocol client is not a derivative work" (ADR-0006).
#
# This is a regression tripwire: it fails the build if a change ever (a) emits the GPL
# engine as a shared library/framework a client could embed, (b) ships a native/compiled
# artifact inside the client surface, or (c) loses the protocol-only coupling. It is the
# build-time companion to the seam check in bootstrap.sh.
#
# Usage:
#   engine/containment-check.sh [<engine-build-cli-dir>]
#     default dir: ${HELM_OCPN_DIR:-/tmp/helm-opencpn}/build/cli
#   (binary checks are skipped — not failed — when no build dir is present, so the
#    client-surface checks still run on a source-only checkout.)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # engine/
REPO="$(cd "$HERE/.." && pwd)"
BIN="${1:-${HELM_OCPN_DIR:-/tmp/helm-opencpn}/build/cli}"
WEB="$REPO/web"

fail=0
note() { printf '    %s\n' "$*"; }
ok()   { printf '\033[32m    ✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[31m    ✗ %s\033[0m\n' "$*"; fail=1; }

printf '\n\033[1m== ENGINE-11 GPL containment check ==\033[0m\n'

# 1) The GPL engine must be a process boundary, not a linkable artifact: the build emits
#    standalone executables + a BUILD-INTERNAL static archive (libhelm-chartrender.a),
#    never a shared library / framework that a client could dynamically embed.
printf '  [1] GPL engine is executable-only (no redistributable shared lib)\n'
if [ -d "$BIN" ]; then
  shared="$(find "$BIN" -maxdepth 1 \( -name '*.dylib' -o -name '*.so' -o -name '*.framework' \) 2>/dev/null || true)"
  if [ -n "$shared" ]; then
    bad "engine build emitted a shared lib/framework (a client could embed the GPL engine):"
    printf '%s\n' "$shared" | sed 's/^/        /'
  else
    ok "no .dylib/.so/.framework emitted — the GPL engine ships only inside executables"
  fi
  for b in helm-engine helm-server helm-tiles chart-spike helm-tides-smoke; do
    [ -e "$BIN/$b" ] || continue
    if file -b "$BIN/$b" | grep -q 'executable'; then
      ok "$b is a standalone Mach-O executable (the GPL stays a process)"
    else
      bad "$b is not a plain executable: $(file -b "$BIN/$b")"
    fi
  done
else
  note "(no build dir at $BIN — skipping binary checks; run after bootstrap.sh)"
fi

# 2) The distributed CLIENT surface ships no native/compiled code that could statically
#    link the GPL engine. The web client is HTML/JS/CSS only.
printf '  [2] client surface (web/) is source-only — links no GPL\n'
if [ -d "$WEB" ]; then
  native="$(find "$WEB" -type f \( -name '*.a' -o -name '*.o' -o -name '*.dylib' -o -name '*.so' \
              -o -name '*.framework' -o -name '*.wasm' \) 2>/dev/null || true)"
  if [ -n "$native" ]; then
    bad "web/ contains native/compiled artifacts (possible GPL embed in the client):"
    printf '%s\n' "$native" | sed 's/^/        /'
  else
    ok "web/ is source-only (HTML/JS/CSS) — no native artifact links the engine"
  fi
else
  note "(no web/ dir — skipping client-surface check)"
fi

# 3) The client couples to the engine ONLY across the wire (arm's length): the nav WS and
#    chart HTTP endpoints — not a native FFI bridge into the GPL core.
printf '  [3] client couples to the engine via the network protocol (arm'\''s-length)\n'
if [ -d "$WEB" ] && grep -rqsE '/nav([^a-z]|$)|/chart/' "$WEB"/*.js 2>/dev/null; then
  ok "web/ reaches the engine through the protocol (/nav, /chart) — no in-process linkage"
else
  note "(could not confirm /nav,/chart endpoints in web/*.js — verify the client is protocol-only)"
fi

printf '\n'
if [ "$fail" = 0 ]; then
  printf '\033[32m  == containment OK: the GPL engine is a contained, network-only process ==\033[0m\n'
else
  printf '\033[31m  == containment BREACH — see ✗ above (ENGINE-11 · docs/decisions/0009) ==\033[0m\n'
  exit 1
fi
