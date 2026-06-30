#!/usr/bin/env bash
#
# engine/test-engine.sh — end-to-end proof of the headless OpenCPN engine.
#
# Black-box: starts the REAL binaries and asserts their behaviour over the wire, with
# each check mapped to the ENGINE-* task it proves. Run after a build (bootstrap.sh).
#
#   A. One-origin server   — helm-server serves nav WS + S-52 tiles + health + catalog
#                            + UI on one port, with snapshot/delta/seq framing and
#                            immutable tile caching.            (ENGINE-9, ENGINE-12, CHART-3)
#   B. Nav core            — the model's relocated UpdateProgress drives per-fix
#                            geometry + arrival-circle auto-advance; a real NMEA fix
#                            overrides position; source tags stay honest.
#                                                               (ENGINE-3, ENGINE-7, ENGINE-10)
#   C. GPL containment     — the engine is a process behind the protocol, never a
#                            client-linkable library.           (ENGINE-11)
#
# Usage:  engine/test-engine.sh
# Env:    HELM_OCPN_DIR (default /tmp/helm-opencpn), HELM_TEST_PORT (default 8077)

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BIN="${HELM_OCPN_DIR:-/tmp/helm-opencpn}/build/cli"
export DYLD_LIBRARY_PATH="/opt/homebrew/opt/wxwidgets@3.2/lib:/opt/homebrew/opt/libarchive/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
SPORT="${HELM_TEST_PORT:-8077}"   # one-origin helm-server test port
# Hermetic engine ports: default to FREE ephemeral ports so a concurrent helm-server/
# helm-engine on a shared box can't steal :8081/:10110 and turn Section B's real-data
# checks into misleading nav-core FAILs. Override with HELM_ENGINE_PORT / HELM_NMEA_PORT.
free_port(){ python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));p=s.getsockname()[1];s.close();print(p)'; }
EPORT="${HELM_ENGINE_PORT:-$(free_port)}"   # helm-engine nav WS port
NPORT="${HELM_NMEA_PORT:-$(free_port)}"     # helm-engine NMEA 0183 / AIS ingest port
RPORT="${HELM_RELAY_PORT:-$(free_port)}"     # helm-server NMEA relay (live-data-only: feed a fix here or nav idles)

pass=0; fail=0
P(){ printf '\033[32m  PASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
F(){ printf '\033[31m  FAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
jget(){ python3 -c 'import json,sys;exec("o=json.load(sys.stdin)\nfor k in sys.argv[1].split(\".\"): o=o[k]\nprint(o)")' "$1"; }

[ -x "$BIN/helm-server" ] || { echo "no helm-server at $BIN — run engine/bootstrap.sh first"; exit 2; }

inject_rmc(){ # lat lon [port=$NPORT]  → send one valid GPRMC fix to an NMEA listener
python3 - "$1" "$2" "${3:-$NPORT}" <<'PY'
import socket,sys
lat=float(sys.argv[1]); lon=float(sys.argv[2]); port=int(sys.argv[3]); la=abs(lat); lo=abs(lon)
lats=f"{int(la):02d}{(la-int(la))*60:07.4f}"; lons=f"{int(lo):03d}{(lo-int(lo))*60:07.4f}"
b=f"GPRMC,120000,A,{lats},{'N' if lat>=0 else 'S'},{lons},{'E' if lon>=0 else 'W'},5.0,015.0,250625,,"
cs=0
for c in b: cs^=ord(c)
s=socket.socket(); s.settimeout(2); s.connect(('127.0.0.1',port)); s.sendall(f"${b}*{cs:02X}\r\n".encode()); s.close()
PY
}

printf '\033[1m=== Helm engine — end-to-end test ===\033[0m\n'
echo "binaries: $BIN"

# ---------- A0) no-ENC boot: chart failure must not kill the server ----------
hdr "A0. No-ENC boot  (ENGINE-15 basemap-only startup)"
NO_ENC_PORT="$(free_port)"
NO_ENC_RELAY_PORT="$(free_port)"
if HELM_OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}" \
   HELM_TEST_PORT="$NO_ENC_PORT" \
   HELM_RELAY_PORT="$NO_ENC_RELAY_PORT" \
   HELM_SERVER_BIN="$BIN/helm-server" \
   bash "$HERE/test-no-enc-boot.sh" >/tmp/te-no-enc.txt 2>&1; then
  P "helm-server boots without ENC and serves health/catalog/UI/transparent tiles"
else
  F "no-ENC boot smoke failed:"
  sed 's/^/        /' /tmp/te-no-enc.txt
fi

# ---------- A) one-origin server ----------
hdr "A. One-origin server  (ENGINE-9 merge · ENGINE-12 build · CHART-3 tiles)"
ST="$(mktemp -d)"
HELM_BIND=127.0.0.1 HELM_PORT=$SPORT HELM_RELAY_PORT=$RPORT HELM_TILES_NO_WARMUP=1 HELM_WEB_ROOT="$REPO/web" HELM_CONFIG="$ST" \
  HELM_CHART_RENDERER_QUERY_OVERRIDE=1 \
  HELM_VULKAN_RENDERER_BIN="$REPO/scripts/vulkan-render-fixture" \
  HELM_VULKAN_FIXTURE_DIR="$REPO/engine/test/fixtures/vulkan-render/chart-1" \
  HELM_VULKAN_RENDERER_SHA="${HELM_VULKAN_RENDERER_SHA:-local-fixture}" \
  "$BIN/helm-server" >/tmp/te-server.log 2>&1 &
SPID=$!; sleep 3
curl -s -o /tmp/te-health-nofix.json "http://127.0.0.1:$SPORT/health" || true
nofix_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("nav",{}).get("fix_status","?"))' /tmp/te-health-nofix.json 2>/dev/null || echo "?")
[ "$nofix_status" = offline ] \
  && P "health reports nav.fix_status=offline before any GPS feed (ENGINE-17)" \
  || F "health did not report no-fix offline state before feed (got $nofix_status)"
# live-data-only engine (the simulator was removed): feed a continuous real fix into the seeded
# NMEA relay (tcp-server on $RPORT) or the nav loop idles and streams nothing — the contract is
# "no fabricated boat; nav idles until a real fix (pos+SOG+COG)".
( for _ in $(seq 1 14); do inject_rmc 24.50 -81.80 $RPORT 2>/dev/null; sleep 0.7; done ) &
FEEDPID=$!; sleep 1.5
# nav-stream framing (snapshot → deltas, strictly increasing seq) via the contract smoke
node "$HERE/stream-smoke.js" 127.0.0.1 $SPORT --ws-only >/tmp/te-smoke.txt 2>&1
curl -s -o /tmp/te-health-livefix.json "http://127.0.0.1:$SPORT/health" || true
kill $FEEDPID 2>/dev/null
if grep -q 'ALL PASS' /tmp/te-smoke.txt; then
  while IFS= read -r l; do P "nav stream:${l#  ok  }"; done < <(grep '  ok   ' /tmp/te-smoke.txt)
else
  F "nav-stream framing failed:"; sed 's/^/        /' /tmp/te-smoke.txt
fi
livefix_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("nav",{}).get("fix_status","?"))' /tmp/te-health-livefix.json 2>/dev/null || echo "?")
[ "$livefix_status" = live ] \
  && P "health reports nav.fix_status=live while real RMC feed is fresh (ENGINE-17)" \
  || F "health did not report live fix while feed was active (got $livefix_status)"
h=$(curl -s -o /tmp/te-health.json -w '%{http_code}' "http://127.0.0.1:$SPORT/health" || echo ERR)
[ "$h" = 200 ] && P "GET /health → 200 (liveness)" || F "GET /health → $h"
chart_loaded=$(python3 -c 'import json,sys; print("true" if json.load(open(sys.argv[1])).get("chart_loaded", True) else "false")' /tmp/te-health.json 2>/dev/null || echo true)
# real S-52 tile render off the Key West ENC, with immutable caching + 304 revalidation
curl -s -D /tmp/te-th -o /tmp/te-tile.png "http://127.0.0.1:$SPORT/chart/12/1117/1760.png"
tcode=$(awk 'NR==1{print $2}' /tmp/te-th 2>/dev/null); tsz=$(wc -c </tmp/te-tile.png 2>/dev/null | tr -d ' ')
ctype=$(grep -i '^content-type:' /tmp/te-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
if [ "$chart_loaded" = true ]; then
  { [ "$tcode" = 200 ] && echo "${ctype:-}" | grep -qi 'image/png' && [ "${tsz:-0}" -gt 1000 ]; } \
    && P "GET /chart S-52 tile → 200 image/png, ${tsz}B real ENC render (CHART-3)" \
    || F "S-52 tile → code=$tcode type=${ctype:-?} bytes=${tsz:-?}"
else
  cstatus=$(grep -i '^x-helm-chart-status:' /tmp/te-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
  { [ "$tcode" = 200 ] && echo "${ctype:-}" | grep -qi 'image/png' && [ "${tsz:-0}" -gt 50 ] && [ "$cstatus" = unavailable ]; } \
    && P "GET /chart with no ENC → 200 transparent image/png, ${tsz}B (ENGINE-15)" \
    || F "no-ENC chart tile → code=$tcode type=${ctype:-?} bytes=${tsz:-?} status=${cstatus:-?}"
fi
grep -qi 'cache-control:.*immutable' /tmp/te-th 2>/dev/null \
  && P "tile: Cache-Control immutable (offline-friendly caching)" || F "tile not immutable-cached"
etag=$(grep -i '^etag:' /tmp/te-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
if [ -n "${etag:-}" ]; then
  c304=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "http://127.0.0.1:$SPORT/chart/12/1117/1760.png" || echo ERR)
  [ "$c304" = 304 ] && P "tile: If-None-Match → 304 (cache revalidation works)" || F "If-None-Match → $c304"
else F "tile missing ETag"; fi
vurl="http://127.0.0.1:$SPORT/chart/12/1117/1760.png?renderer=vulkan"
curl -s -D /tmp/te-vulkan-th -o /tmp/te-vulkan-tile.png "$vurl"
vcode=$(awk 'NR==1{print $2}' /tmp/te-vulkan-th 2>/dev/null); vsz=$(wc -c </tmp/te-vulkan-tile.png 2>/dev/null | tr -d ' ')
vrenderer=$(grep -i '^x-helm-renderer:' /tmp/te-vulkan-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
vetag=$(grep -i '^etag:' /tmp/te-vulkan-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
vcache=$(grep -i '^x-helm-renderer-cache-key:' /tmp/te-vulkan-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
vout=$(grep -i '^x-helm-renderer-output-sha:' /tmp/te-vulkan-th 2>/dev/null | tr -d '\r' | awk '{print $2}')
vsha=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' /tmp/te-vulkan-tile.png 2>/dev/null || echo "?")
{ [ "$vcode" = 200 ] && [ "$vrenderer" = vulkan ] && [ "${vsz:-0}" -gt 1000 ] && echo "${vetag:-}" | grep -q '^"vulkan:' && [ "$vout" = "$vsha" ] && [ "${#vcache}" -eq 64 ]; } \
  && P "GET /chart?renderer=vulkan → shared offscreen PNG with renderer/provenance/cache headers (REPO-4)" \
  || F "Vulkan tile route shape changed: code=$vcode renderer=${vrenderer:-?} bytes=${vsz:-?} etag=${vetag:-?} cache=${vcache:-?} out=${vout:-?} sha=$vsha"
curl -s -D /tmp/te-vulkan-th2 -o /tmp/te-vulkan-tile2.png "$vurl"
vetag2=$(grep -i '^etag:' /tmp/te-vulkan-th2 2>/dev/null | tr -d '\r' | awk '{print $2}')
vsha2=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' /tmp/te-vulkan-tile2.png 2>/dev/null || echo "?")
{ [ "$vcode" = 200 ] && [ -n "${vetag:-}" ] && [ "$vetag2" = "$vetag" ] && [ "$vsha2" = "$vsha" ]; } \
  && P "Vulkan tile is deterministic across repeated renders (REPO-4)" \
  || F "Vulkan tile not deterministic: etag $vetag → ${vetag2:-?}, sha $vsha → $vsha2"
if [ -n "${vetag:-}" ]; then
  v304=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $vetag" "$vurl" || echo ERR)
  [ "$v304" = 304 ] && P "Vulkan tile: If-None-Match → 304 with shared-renderer ETag (REPO-4)" || F "Vulkan If-None-Match → $v304"
else F "Vulkan tile missing ETag"; fi
cat=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SPORT/catalog" || echo ERR)
[ "$cat" = 200 ] && P "GET /catalog → 200 (chart-cell catalog)" || F "GET /catalog → $cat"
ui=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SPORT/" || echo ERR)
[ "$ui" = 200 ] && P "GET / → 200 (serves the UI from one origin)" || F "GET / (UI) → $ui"
kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; rm -rf "$ST"

# ---------- B) nav core: relocated UpdateProgress + auto-advance ----------
hdr "B. Nav core: model UpdateProgress + auto-advance  (ENGINE-3 · ENGINE-7 · ENGINE-10)"
# Start the engine on its OWN (ephemeral) ports — no global `pkill helm-engine`,
# which would also kill other agents' engines on a shared host.
HELM_ENGINE_PORT=$EPORT HELM_NMEA_PORT=$NPORT "$BIN/helm-engine" >/tmp/te-engine.log 2>&1 &
NPID=$!; sleep 1.5
# FAIL-LOUD preflight: every check below depends on the NMEA listener binding. If it
# didn't (port stolen, etc.), ABORT Section B with the REAL cause instead of emitting
# misleading "no override / no advance" FAILs that masquerade as nav-core regressions.
if grep -q "bind/listen on .* failed" /tmp/te-engine.log; then
  F "Section B aborted: helm-engine could NOT bind NMEA :$NPORT — port contention/environment, not a nav-core bug:"
  sed 's/^/        /' /tmp/te-engine.log
else
  snap="$(node "$HERE/nav-capture.js" 127.0.0.1 $EPORT 1 /)"
  shape=$(printf '%s' "$snap" | python3 -c 'import json,sys;a=json.load(sys.stdin).get("active",{});print(int(all(k in a for k in("eta","ttg","vmg","dtg","xte","nextWp")) and "legs" in a))' 2>/dev/null || echo 0)
  [ "$shape" = 1 ] && P "nav snapshot carries the full per-fix math (dtg/xte/eta/ttg/vmg/legs/nextWp)" || F "snapshot missing nav-math fields"
  psrc=$(printf '%s' "$snap" | jget sources.pos 2>/dev/null || echo "?")
  [ "$psrc" = simulated ] && P "honest source tag: pos=\"simulated\" before any real fix (ENGINE-7)" || F "pos source not honestly tagged ($psrc)"
  nw0=$(printf '%s' "$snap" | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"]["nextWp"].split()[0])' 2>/dev/null || echo "?")
  echo "    active waypoint before any fix: $nw0"

  inject_rmc 24.485 -81.800; sleep 2
  f2="$(node "$HERE/nav-capture.js" 127.0.0.1 $EPORT 1 /)"
  src2=$(printf '%s' "$f2" | jget sources.pos 2>/dev/null || echo "?")
  nw2=$(printf '%s' "$f2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"]["nextWp"].split()[0])' 2>/dev/null || echo "?")
  [ "$src2" = nmea ] && P "real NMEA fix overrides position: pos source → nmea (CONN-2 / ENGINE-7)" || F "pos source stayed \"$src2\" after RMC inject"
  [ "$nw2" != "$nw0" ] && [ "$nw2" != "?" ] && P "arrival auto-advance: $nw0 → $nw2 (model UpdateProgress, ENGINE-10)" || F "no waypoint advance after reaching WP ($nw0 → $nw2)"

  inject_rmc 24.515 -81.793; sleep 2
  nw3=$(node "$HERE/nav-capture.js" 127.0.0.1 $EPORT 1 / | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"]["nextWp"].split()[0])' 2>/dev/null || echo "?")
  inject_rmc 24.540 -81.786; sleep 2
  nw4=$(node "$HERE/nav-capture.js" 127.0.0.1 $EPORT 1 / | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"]["nextWp"].split()[0])' 2>/dev/null || echo "?")
  { [ "$nw3" != "$nw2" ] && [ "$nw4" != "$nw3" ] && [ "$nw4" != "?" ]; } \
    && P "monotonic advance through the route: $nw2 → $nw3 → $nw4" \
    || F "advance not monotonic ($nw2 → $nw3 → $nw4)"
fi
kill $NPID 2>/dev/null; wait $NPID 2>/dev/null

# ---------- C) GPL containment ----------
hdr "C. GPL containment guard  (ENGINE-11)"
if bash "$HERE/containment-check.sh" "$BIN" >/tmp/te-cont.txt 2>&1; then
  P "containment guard exit 0: GPL engine is executable-only + client is protocol-only"
else
  F "containment guard reported a breach:"; sed 's/^/        /' /tmp/te-cont.txt
fi

# ---------- D) tides: offline harmonic prediction ----------
hdr "D. Tides: offline harmonic prediction + official provider catalog  (TIDES-1/2/6/7/9)"
TCDATA="${HELM_TCDATA_DIR:-${HELM_OCPN_DIR:-/tmp/helm-opencpn}/data/tcdata}"
NOAA_PREDICTION_FIXTURE="$HERE/test/fixtures/noaa-coops/1612340-2026-06-26-predictions.json"
FIJI_CALENDAR_FIXTURE="$HERE/test/fixtures/fiji-met/suva-2026-calendar.csv"
TIDE_ACQUISITION_POINTS="$HERE/test/fixtures/tides-acquisition-points.csv"
TIDE_HONOLULU_ROUTE="$HERE/test/fixtures/tides-honolulu-route.gpx"
TIDE_CACHE_GENERATED="$(mktemp -d)"
if [ ! -x "$BIN/helm-tides-smoke" ]; then
  F "helm-tides-smoke missing at $BIN — run engine/bootstrap.sh after the TIDES-1 target lands"
elif [ ! -x "$BIN/helm-tides-fetch" ]; then
  F "helm-tides-fetch missing at $BIN — run engine/bootstrap.sh after the TIDES-9 target lands"
elif "$BIN/helm-tides-fetch" --input-json "$NOAA_PREDICTION_FIXTURE" --cache-dir "$TIDE_CACHE_GENERATED" --station 1612340 --station-name "Honolulu, Honolulu Harbor" --datum MLLW --date 2026-06-26 --fetched-utc 2026-06-25T00:00:00Z >/tmp/te-tides-fetch.json 2>/tmp/te-tides-fetch.err; then
  tide_fetch_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); c=o.get("cache",{}); print(int(o.get("ok") is True and o.get("provider_region_id")=="noaa-coops-us" and o.get("station_id")=="1612340" and o.get("mode")=="fixture" and c.get("sample_count")==24 and c.get("valid_for_time") is True and c.get("redistribution_cleared") is True and os.path.exists(c.get("cache_path","")) and os.path.exists(c.get("data_path",""))))' /tmp/te-tides-fetch.json 2>/dev/null || echo 0)
  [ "$tide_fetch_shape" = 1 ] \
    && P "helm-tides-fetch validates NOAA JSON and writes source-tagged cache metadata (TIDES-9)" \
    || { F "helm-tides-fetch JSON/cache shape changed:"; sed 's/^/        /' /tmp/te-tides-fetch.json; }

  if "$BIN/helm-tides-fetch" --provider fiji-met-cosppac --input-calendar "$FIJI_CALENDAR_FIXTURE" --cache-dir "$TIDE_CACHE_GENERATED" --station FJ-SUVA-WHARF --station-name "Suva Wharf" --datum "Tide Prediction Datum" --date 2026-06-18 --source-url "https://www.met.gov.fj/documents/28048/Suva_2026.pdf" --fetched-utc 2026-04-08T00:00:00Z >/tmp/te-tides-fetch-fiji.json 2>/tmp/te-tides-fetch-fiji.err; then
    fiji_fetch_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); c=o.get("cache",{}); print(int(o.get("ok") is True and o.get("provider_region_id")=="fiji-met-cosppac" and o.get("station_id")=="FJ-SUVA-WHARF" and o.get("mode")=="calendar" and c.get("sample_count")==1 and c.get("time_zone")=="Pacific/Fiji" and c.get("valid_for_time") is True and c.get("redistribution_cleared") is False and os.path.exists(c.get("cache_path","")) and os.path.exists(c.get("data_path",""))))' /tmp/te-tides-fetch-fiji.json 2>/dev/null || echo 0)
    [ "$fiji_fetch_shape" = 1 ] \
      && P "helm-tides-fetch ingests Fiji Met/COSPPac calendar with local-time/license metadata (TIDES-9)" \
      || { F "Fiji calendar fetch JSON/cache shape changed:"; sed 's/^/        /' /tmp/te-tides-fetch-fiji.json; }
  else
    F "helm-tides-fetch Fiji calendar ingest failed:"
    sed 's/^/        /' /tmp/te-tides-fetch-fiji.err
    sed 's/^/        /' /tmp/te-tides-fetch-fiji.json 2>/dev/null || true
  fi

  if "$BIN/helm-tides-fetch" --resolve-lat 21.3069 --resolve-lon -157.8583 --cache-dir "$TIDE_CACHE_GENERATED" --date 2026-06-26 >/tmp/te-tides-plan-noaa.json 2>/tmp/te-tides-plan-noaa.err; then
    tide_plan_noaa_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); r=o.get("request",{}); print(int(o.get("ok") is True and o.get("mode")=="request-plan" and o.get("executed") is False and r.get("provider_region_id")=="noaa-coops-us" and r.get("station_id")=="1612340" and r.get("action")=="use-cache" and r.get("cached") is True and r.get("time_zone")=="GMT"))' /tmp/te-tides-plan-noaa.json 2>/dev/null || echo 0)
    [ "$tide_plan_noaa_shape" = 1 ] \
      && P "helm-tides-fetch resolves GPS point to cached NOAA official request plan (TIDES-9)" \
      || { F "NOAA request-plan JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-plan-noaa.json; }
  else
    F "helm-tides-fetch NOAA request-plan failed:"
    sed 's/^/        /' /tmp/te-tides-plan-noaa.err
    sed 's/^/        /' /tmp/te-tides-plan-noaa.json 2>/dev/null || true
  fi

  if "$BIN/helm-tides-fetch" --resolve-lat -15.0 --resolve-lon -147.0 --cache-dir "$TIDE_CACHE_GENERATED" --date 2026-06-26 >/tmp/te-tides-plan-shom.json 2>/tmp/te-tides-plan-shom.err; then
    tide_plan_shom_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); r=o.get("request",{}); print(int(o.get("ok") is True and o.get("mode")=="request-plan" and o.get("executed") is False and o.get("blocked") is True and r.get("provider_region_id")=="shom-spm-refmar-fr-polynesia" and r.get("action")=="configure-subscription" and r.get("requires_subscription") is True))' /tmp/te-tides-plan-shom.json 2>/dev/null || echo 0)
    [ "$tide_plan_shom_shape" = 1 ] \
      && P "helm-tides-fetch reports blocked SHOM subscription request plan for Tuamotu waters (TIDES-9)" \
      || { F "SHOM request-plan JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-plan-shom.json; }
  else
    F "helm-tides-fetch SHOM request-plan failed:"
    sed 's/^/        /' /tmp/te-tides-plan-shom.err
    sed 's/^/        /' /tmp/te-tides-plan-shom.json 2>/dev/null || true
  fi

  TIDE_PLAN_CACHE="$(mktemp -d)"
  if "$BIN/helm-tides-fetch" --resolve-lat 21.3069 --resolve-lon -157.8583 --cache-dir "$TIDE_PLAN_CACHE" --date 2026-06-26 --execute-request --input-json "$NOAA_PREDICTION_FIXTURE" >/tmp/te-tides-plan-execute.json 2>/tmp/te-tides-plan-execute.err; then
    tide_plan_execute_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); r=o.get("request",{}); c=o.get("cache",{}); print(int(o.get("ok") is True and o.get("mode")=="request-plan" and o.get("executed") is True and r.get("provider_region_id")=="noaa-coops-us" and r.get("station_id")=="1612340" and r.get("action")=="fetch-live" and c.get("sample_count")==24 and os.path.exists(c.get("cache_path","")) and os.path.exists(c.get("data_path",""))))' /tmp/te-tides-plan-execute.json 2>/dev/null || echo 0)
    [ "$tide_plan_execute_shape" = 1 ] \
      && P "helm-tides-fetch executes unresolved NOAA request plan into source-tagged cache (TIDES-9)" \
      || { F "NOAA request-plan execution JSON/cache shape changed:"; sed 's/^/        /' /tmp/te-tides-plan-execute.json; }
  else
    F "helm-tides-fetch NOAA request-plan execution failed:"
    sed 's/^/        /' /tmp/te-tides-plan-execute.err
    sed 's/^/        /' /tmp/te-tides-plan-execute.json 2>/dev/null || true
  fi
  rm -rf "$TIDE_PLAN_CACHE"

  if "$BIN/helm-tides-fetch" --points-csv "$TIDE_ACQUISITION_POINTS" --cache-dir "$TIDE_CACHE_GENERATED" --date 2026-06-26 >/tmp/te-tides-acquisition.json 2>/tmp/te-tides-acquisition.err; then
    tide_acquisition_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); s=o.get("summary",{}); items=o.get("items",[]); grouped=max([i.get("point_count",0) for i in items] or [0]); actions=sorted(i.get("request",{}).get("action") for i in items); print(int(o.get("ok") is True and o.get("mode")=="acquisition-manifest" and o.get("dry_run") is True and o.get("point_count")==4 and o.get("item_count")==3 and s.get("use_cache")==2 and s.get("blocked")==1 and s.get("needs_credentials")==1 and grouped==2 and actions==["configure-subscription","use-cache","use-cache"]))' /tmp/te-tides-acquisition.json 2>/dev/null || echo 0)
    [ "$tide_acquisition_shape" = 1 ] \
      && P "helm-tides-fetch builds grouped GPS/route acquisition manifest without duplicate station-day work (TIDES-9)" \
      || { F "tide acquisition manifest JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-acquisition.json; }
  else
    F "helm-tides-fetch acquisition manifest failed:"
    sed 's/^/        /' /tmp/te-tides-acquisition.err
    sed 's/^/        /' /tmp/te-tides-acquisition.json 2>/dev/null || true
  fi

  TIDE_SCHED_STATE="$TIDE_CACHE_GENERATED/tide-scheduler.tsv"
  if "$BIN/helm-tides-fetch" --points-csv "$TIDE_ACQUISITION_POINTS" --cache-dir "$TIDE_CACHE_GENERATED" --date 2026-06-26 --lookahead-days 3 --scheduler-state "$TIDE_SCHED_STATE" --scheduler-now 2026-06-25T00:00:00Z --max-live-fetches 1 >/tmp/te-tides-scheduler.json 2>/tmp/te-tides-scheduler.err; then
    tide_scheduler_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); sc=o.get("scheduler",{}); items=o.get("items",[]); statuses=sorted(i.get("scheduler",{}).get("status") for i in items); counts={s:statuses.count(s) for s in set(statuses)}; max_count=max([i.get("scheduler",{}).get("planned_count",0) for i in items] or [0]); print(int(o.get("ok") is True and o.get("point_count")==12 and o.get("item_count")==9 and sc.get("state_written") is True and sc.get("pending_fetch")==1 and sc.get("deferred_rate_limit")==1 and sc.get("manual_import")==2 and sc.get("blocked")==3 and sc.get("cached")==2 and counts.get("pending_fetch")==1 and counts.get("deferred_rate_limit")==1 and counts.get("manual_import")==2 and counts.get("blocked")==3 and counts.get("cached")==2 and max_count==1 and os.path.exists(sc.get("state_path",""))))' /tmp/te-tides-scheduler.json 2>/dev/null || echo 0)
    [ "$tide_scheduler_shape" = 1 ] \
      && P "helm-tides-fetch writes scheduler ledger with provider budget/defer/manual/block states (TIDES-9)" \
      || { F "tide scheduler ledger JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-scheduler.json; }
  else
    F "helm-tides-fetch scheduler ledger failed:"
    sed 's/^/        /' /tmp/te-tides-scheduler.err
    sed 's/^/        /' /tmp/te-tides-scheduler.json 2>/dev/null || true
  fi
  if "$BIN/helm-tides-fetch" --points-csv "$TIDE_ACQUISITION_POINTS" --cache-dir "$TIDE_CACHE_GENERATED" --date 2026-06-26 --lookahead-days 3 --scheduler-state "$TIDE_SCHED_STATE" --scheduler-now 2026-06-25T00:05:00Z --max-live-fetches 1 >/tmp/te-tides-scheduler-repeat.json 2>/tmp/te-tides-scheduler-repeat.err; then
    tide_scheduler_repeat_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); items=o.get("items",[]); counts=[i.get("scheduler",{}).get("planned_count",0) for i in items]; print(int(len(counts)==9 and min(counts)==2 and max(counts)==2))' /tmp/te-tides-scheduler-repeat.json 2>/dev/null || echo 0)
    [ "$tide_scheduler_repeat_shape" = 1 ] \
      && P "helm-tides-fetch reuses scheduler ledger and increments persisted plan counts (TIDES-9)" \
      || { F "tide scheduler repeat JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-scheduler-repeat.json; }
  else
    F "helm-tides-fetch scheduler repeat failed:"
    sed 's/^/        /' /tmp/te-tides-scheduler-repeat.err
    sed 's/^/        /' /tmp/te-tides-scheduler-repeat.json 2>/dev/null || true
  fi

  TIDE_SERVER_PORT="$(free_port)"
  TIDE_SERVER_RELAY="$(free_port)"
  TIDE_SERVER_CONFIG="$(mktemp -d)"
  TIDE_SERVER_SCHED="$TIDE_CACHE_GENERATED/server-scheduler.tsv"
  HELM_BIND=127.0.0.1 HELM_PORT=$TIDE_SERVER_PORT HELM_RELAY_PORT=$TIDE_SERVER_RELAY HELM_SIM=1 HELM_TILES_NO_WARMUP=1 HELM_WEB_ROOT="$REPO/web" HELM_CONFIG="$TIDE_SERVER_CONFIG" HELM_TCDATA_DIR="$TCDATA" HELM_TIDES_CACHE_DIR="$TIDE_CACHE_GENERATED" \
    "$BIN/helm-server" >/tmp/te-tides-server.log 2>&1 &
  TIDE_SERVER_PID=$!; sleep 3
  if curl -fsS "http://127.0.0.1:$TIDE_SERVER_PORT/tides/acquisition?route=active&date=2026-06-26&scheduler=1&scheduler_state=$TIDE_SERVER_SCHED&max_live_fetches=1" >/tmp/te-tides-server-acquisition.json 2>/tmp/te-tides-server-acquisition.err; then
    tide_server_acquisition_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); sc=o.get("scheduler",{}); items=o.get("items",[]); statuses=[i.get("scheduler",{}).get("status") for i in items]; scheduled=sum(sc.get(k,0) for k in ("cached","pending_fetch","deferred_rate_limit","manual_import","blocked","manual_review")); print(int(o.get("ok") is True and o.get("mode")=="acquisition-manifest" and o.get("request_mode")=="active-route" and o.get("route_name")=="Key West Approach" and o.get("dry_run") is True and o.get("point_count")==5 and o.get("item_count",0)>=1 and sc.get("state_written") is True and scheduled==o.get("item_count") and all(i.get("request",{}).get("provider_region_id") for i in items) and all(i.get("point_count",0)>=1 for i in items) and all(statuses) and os.path.exists(sc.get("state_path",""))))' /tmp/te-tides-server-acquisition.json 2>/dev/null || echo 0)
    [ "$tide_server_acquisition_shape" = 1 ] \
      && P "helm-server /tides/acquisition plans grouped official cache work from the active route (TIDES-9)" \
      || { F "helm-server /tides/acquisition JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-server-acquisition.json; }
  else
    F "helm-server /tides/acquisition request failed:"
    sed 's/^/        /' /tmp/te-tides-server-acquisition.err
    sed 's/^/        /' /tmp/te-tides-server.log 2>/dev/null || true
  fi
  if curl -fsS "http://127.0.0.1:$TIDE_SERVER_PORT/tides/currents?all=1&lat=50.4075&lon=-125.8509&time=2026-06-26T12:00:00Z" >/tmp/te-tides-current.json 2>/tmp/te-tides-current.err; then
    tide_current_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); th=o.get("theoretical",{}); obs=o.get("observed",{}); res=o.get("residual",{}); st=o.get("station") or {}; factors={f.get("name") for f in res.get("factors",[])}; print(int(o.get("ok") is True and o.get("mode")=="current-condition" and o.get("source_policy")=="all-local" and o.get("valid_time_utc")=="2026-06-26T12:00:00Z" and o.get("unit")=="knots" and th.get("available") is True and th.get("applied") is True and isinstance(th.get("speed_kn"), (int,float)) and th.get("speed_kn") >= 0 and th.get("has_direction") is True and st.get("type") in ("c","C") and st.get("unit")=="knots" and st.get("source_redistribution_cleared") is False and obs.get("applied") is False and res.get("applied") is False and {"wind_duration","swell_lagoon_fill","pass_geometry"}.issubset(factors) and o.get("confidence",{}).get("tier") in ("very_low","low","medium") and any("residual" in w for w in o.get("warnings",[]))))' /tmp/te-tides-current.json 2>/dev/null || echo 0)
    [ "$tide_current_shape" = 1 ] \
      && P "helm-server /tides/currents returns valid-time theoretical current with observed/residual honesty metadata (TIDES-3)" \
      || { F "helm-server /tides/currents JSON shape changed:"; sed 's/^/        /' /tmp/te-tides-current.json; }
  else
    F "helm-server /tides/currents request failed:"
    sed 's/^/        /' /tmp/te-tides-current.err
    sed 's/^/        /' /tmp/te-tides-server.log 2>/dev/null || true
  fi
  kill $TIDE_SERVER_PID 2>/dev/null; wait $TIDE_SERVER_PID 2>/dev/null; rm -rf "$TIDE_SERVER_CONFIG"

  TIDE_RUNNER_CACHE="$(mktemp -d)"
  TIDE_RUNNER_PORT="$(free_port)"
  TIDE_RUNNER_RELAY="$(free_port)"
  TIDE_RUNNER_CONFIG="$(mktemp -d)"
  HELM_BIND=127.0.0.1 HELM_PORT=$TIDE_RUNNER_PORT HELM_RELAY_PORT=$TIDE_RUNNER_RELAY HELM_ROUTE="$TIDE_HONOLULU_ROUTE" HELM_TILES_NO_WARMUP=1 HELM_WEB_ROOT="$REPO/web" HELM_CONFIG="$TIDE_RUNNER_CONFIG" HELM_TCDATA_DIR="$TCDATA" HELM_TIDES_CACHE_DIR="$TIDE_RUNNER_CACHE" HELM_TIDES_ACQUISITION=1 HELM_TIDES_ACQUISITION_INTERVAL_SEC=30 HELM_TIDES_ACQUISITION_DATE=2026-06-26 HELM_TIDES_LOOKAHEAD_DAYS=1 HELM_TIDES_MAX_LIVE_FETCHES=1 HELM_TIDES_NOAA_FIXTURE="$NOAA_PREDICTION_FIXTURE" \
    "$BIN/helm-server" >/tmp/te-tides-runner-server.log 2>&1 &
  TIDE_RUNNER_PID=$!
  tide_runner_shape=0
  for _ in $(seq 1 12); do
    if curl -fsS "http://127.0.0.1:$TIDE_RUNNER_PORT/tides/acquisition/status" >/tmp/te-tides-runner-status.json 2>/tmp/te-tides-runner-status.err; then
      tide_runner_shape=$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])); print(int(o.get("ok") is True and o.get("enabled") is True and o.get("run_count",0)>=1 and o.get("last_executed")==1 and o.get("last_failed")==0 and o.get("request_mode")=="active-route" and o.get("route_name")=="Honolulu Tide Acquisition" and o.get("last_pending_fetch")==1 and os.path.exists(o.get("last_cache_path","")) and os.path.exists(o.get("last_data_path",""))))' /tmp/te-tides-runner-status.json 2>/dev/null || echo 0)
      [ "$tide_runner_shape" = 1 ] && break
    fi
    sleep 1
  done
  [ "$tide_runner_shape" = 1 ] \
    && P "helm-server background tide acquisition runner executes eligible NOAA cache fetch from active route (TIDES-9)" \
    || { F "helm-server background tide acquisition runner did not populate NOAA cache:"; sed 's/^/        /' /tmp/te-tides-runner-status.json 2>/dev/null || true; sed 's/^/        /' /tmp/te-tides-runner-status.err 2>/dev/null || true; sed 's/^/        /' /tmp/te-tides-runner-server.log 2>/dev/null || true; }
  kill $TIDE_RUNNER_PID 2>/dev/null; wait $TIDE_RUNNER_PID 2>/dev/null; rm -rf "$TIDE_RUNNER_CONFIG" "$TIDE_RUNNER_CACHE"

  if "$BIN/helm-tides-smoke" --regression --official-cache-dir "$TIDE_CACHE_GENERATED" "$TCDATA" >/tmp/te-tides.json 2>/tmp/te-tides.err; then
  tide_shape=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); print(int(o.get("ok") is True and o.get("regression") is True and o.get("source")=="harmonics-dwf-20210110-free.tcd" and o.get("official_reference")=="FJ-SUVA-WHARF" and o.get("resolver_offline_ready") is True and o.get("official_prediction_cached") is True and o.get("fiji_prediction_cached") is True and o.get("official_request_action")=="use-cache" and o.get("fiji_request_action")=="use-cache" and o.get("remote_request_action")=="configure-subscription" and o.get("resolver_remote_tier") in ("low","very_low") and o.get("provider_catalog_count",0) >= 3 and o.get("resolver_remote_provider_region")=="shom-spm-refmar-fr-polynesia" and o.get("next_event",{}).get("kind")=="low_water"))' /tmp/te-tides.json 2>/dev/null || echo 0)
  [ "$tide_shape" = 1 ] \
    && P "helm-tides-smoke pinned heights + official-source/provider catalog/cache metadata (TIDES-2/6/7/9)" \
    || { F "helm-tides-smoke regression JSON missing pinned source/event:"; sed 's/^/        /' /tmp/te-tides.json; }
  else
    F "helm-tides-smoke failed:"
    sed 's/^/        /' /tmp/te-tides.err
    sed 's/^/        /' /tmp/te-tides.json 2>/dev/null || true
  fi
else
  F "helm-tides-fetch failed:"
  sed 's/^/        /' /tmp/te-tides-fetch.err
  sed 's/^/        /' /tmp/te-tides-fetch.json 2>/dev/null || true
fi
rm -rf "$TIDE_CACHE_GENERATED"

# ---------- result ----------
hdr "RESULT"
printf '  %d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" = 0 ]; then printf '\033[32m  ✓ ENGINE end-to-end: all green\033[0m\n'; exit 0
else printf '\033[31m  ✗ failures above\033[0m\n'; exit 1; fi
