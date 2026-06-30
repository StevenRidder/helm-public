# Client license register & GPL boundary

> **The evidence artifact behind [ADR-0009](decisions/0009-arms-length-gpl-containment.md)'s
> "source-only client surface" claim.** ADR-0009 *decides* the GPL engine is contained as a
> standalone process and adds a build-time guard against linking it into a client; this register
> *proves* the other half — that the distributed client (`web/`) carries no GPL today — and states
> the standing rules that keep it that way. Tracked as `NATIVE-12`.
>
> Scope is deliberately narrow: **code/dependencies that ship to the client.** The chart/weather
> **data-source** register (Sentinel, NOAA, OpenSeaMap, Windy, …) and its attribution checklist
> live in [LEGAL.md](LEGAL.md); Helm's own-code license terms live in root [LICENSE](../LICENSE)
> and [LICENSE.BSL](../LICENSE.BSL). This doc does not restate them.

## Bottom line

**As of 2026-06-26 (HEAD `4fc3dc3`), nothing in the client is GPL/LGPL/AGPL. The removal list is
empty.** Every byte that ships to the browser / WKWebView / future native shell is either
permissive third-party (BSD/MIT/ISC/Apache/OFL) or Helm's own code. The GPL — OpenCPN `model/` +
the `s57chart` S-52 renderer — lives **only** in the engine process and is reached over the network
protocol, never embedded in the client.

## What "the client" is, and where the GPL line sits

The client is everything under `web/` (and, later, the native shells that wrap or reimplement it).
It reaches the GPL engine through exactly the four surfaces ADR-0009 enumerates — `/nav` (WS),
`/chart/{z}/{x}/{y}.png`, `/health`, `/catalog`. "Network use is not distribution; an arm's-length
protocol client is not a derivative work." So the GPL question for the client reduces to two
vectors, both audited below:

1. **Vendored third-party libraries** (`web/vendor/`) — could a copyleft package have slipped in?
2. **First-party Helm code** (`web/*.js`, `web/integrations/*.js`) — could it be a *port* of
   OpenCPN's GPL source (a translation is still a derivative work, even in "our" file)?

## 1 · Vendored third-party register (`web/vendor/`)

All nine vendored bundles are permissive. Versions are pinned in
[`web/vendor/README.md`](../web/vendor/README.md) and reproducible via `web/vendor/build.mjs`.

| Library | Version | License (SPDX) | How verified |
|---|---|---|---|
| `maplibre-gl` | 5.24.0 | **BSD-3-Clause** | byte-scan (`BSD` banner) + upstream `LICENSE.txt` |
| `pmtiles` | 4.4.1 | **BSD-3-Clause** | upstream (Protomaps) |
| `@geomatico/maplibre-cog-protocol` | 0.9.0 | **MIT** | npm registry `license` field ✅ |
| `maplibre-contour` | 0.1.0 | **BSD-3-Clause** | upstream (onthegomap) |
| `terra-draw` | 1.31.2 | **MIT** | upstream |
| `terra-draw-maplibre-gl-adapter` | 1.4.1 | **MIT** | npm registry `license` field ✅ |
| `maplibre-gl-measures` | 0.0.20 | **MIT** | npm registry `license` field ✅ |
| `maplibre-gl-temporal-control` | 1.2.0 | **MIT** | npm registry `license` field ✅ |
| `deck.gl` (`core`+`mapbox`+`layers`+`aggregation-layers`, luma bundled) | 9.3.4 | **MIT** | upstream (vis.gl) |

The MapLibre stack is uniformly BSD/MIT/ISC by design — it exists *because* Mapbox GL JS v2 went
proprietary. Transitively-bundled sub-deps that retained a banner are also permissive
(`geotiff`/Esri → **Apache-2.0** inside the COG protocol; `tslib`/Microsoft → **Apache-2.0/0BSD**
inside the contour bundle). A case-sensitive, word-boundary scan of the shipped bytes for
`GPL`/`LGPL`/`AGPL`/`GNU General Public`/`MPL-2`/`Mozilla Public License` returns **zero** hits;
the lowercase `mpl`/`mit`/`isc`/`gpl` fragments a naïve scan finds are all minified-identifier
substrings (`sample`, `submit`, `discard`, …), not license declarations.

## 2 · First-party code

Helm-authored client code is GPL-free and carries Helm's own license
([LICENSE.BSL](../LICENSE.BSL): BSL-1.1 → Apache-2.0).
Every OpenCPN reference in
`web/` is a **boundary comment** ("the engine computes CPA/TCPA / route — OpenCPN's
AisDecoder/Routeman — this module just renders"); no OpenCPN C++ type, global, or symbol appears in
the JS.

Two first-party files compute navigation math **client-side** and were read line-by-line, because a
port of GPL source would hide here:

- [`web/nav-source.js`](../web/nav-source.js) — the in-browser SIM feed.
- [`web/alarms.js`](../web/alarms.js) — anchor-watch / depth / XTE / arrival / MOB evaluated off
  the nav stream.

Both implement the **standard public-domain navigation formulae** — haversine great-circle distance,
the textbook initial-bearing formula, and the standard cross-track
`xte = asin(sin(d13)·sin(θ13 − θ12))` (Ed Williams' *Aviation Formulary* / Chris Veness's
*Movable-Type*). These are **mathematical formulae, not copyrightable expression**; the JavaScript is
original Helm code. The `nav-source.js` comment "mirrors what OpenCPN's Routeman computes" means it
produces the same *outputs* (BRG/DTW/XTE), not that it copied OpenCPN's code. **No GPL derivation.**

> **Belt-and-suspenders (recommended, not required):** add a one-line provenance comment to the
> distance/bearing/XTE helpers in `nav-source.js` and `alarms.js` citing *Aviation Formulary*, so the
> independent-reimplementation provenance is self-documenting if anyone ever asks.

## 3 · Fonts & data

- **Fonts** — `web/fonts/Noto Sans Regular/*.pbf` are SDF glyph atlases from Noto Sans,
  **SIL Open Font License 1.1** (permissive, embeddable).
- **Data** — `web/data/*.json`, `web/style*.json` are Helm's own config + demo/weather data
  (not third-party code). The *upstream provenance* of live weather/chart data is governed by
  [LEGAL.md](LEGAL.md), not this register.

## Standing rules (how the client stays GPL-free)

These are governance rules for every future change to the client. The first two are the
client-side complement to ADR-0009's binary-linkage guard; rule 3 defers to it.

1. **No copyleft dependency enters `web/vendor/`.** Before vendoring or bumping a library, check its
   SPDX `license`. GPL/LGPL/AGPL → reject. MPL-2.0/EPL (file-level weak copyleft) → allowed only with
   the per-file notice preserved and a note here; prefer a permissive alternative. Update the table
   above on every add/bump.
2. **Never port OpenCPN source expression into `web/`.** Independent reimplementation of a *standard
   formula* (the nav math above) is fine. Translating OpenCPN's *expression* — S-52 symbology rules,
   `tcmgr.cpp` tide harmonics, CM93 logic, AIS decode internals — into JS is a **derivative work** and
   is forbidden in the client. Such logic stays server-side in the engine (e.g. TIDES keeps
   `tcmgr.cpp` in the engine, correct by construction).
3. **Native shells connect to the engine; they never embed it.** Any macOS/iPad/iPhone client
   (`NATIVE-1/2/4/5`) speaks the documented protocol to a separately-run engine process — it must not
   statically link or bundle `helm-server`/`helm-engine`/`libhelm-chartrender.a`. Enforced by
   ADR-0009's [`engine/containment-check.sh`](../engine/containment-check.sh); see the open item to
   extend that guard to native packaging outputs.
4. **Re-run the audit on dependency bumps and before any distributed release.** The method below is
   reproducible and cheap.

## Audit method (reproducible)

```sh
# (1) Byte-level copyleft scan of everything shipped under web/vendor/ — must print nothing:
grep -rnE '\bGPL\b|\bLGPL\b|\bAGPL\b|GNU General Public|GPL-[0-9]|MPL-2|Mozilla Public License' \
  web/vendor/

# (2) First-party provenance scan — every hit should be a boundary COMMENT, never a C++ symbol:
grep -rniE 'opencpn|gpl|ported from|adapted from|derived from' \
  web/ --include='*.js' --include='*.html' | grep -vE '/vendor/|/data/'

# (3) SPDX confirm for any non-obvious vendored package (repeat per package@version):
curl -s https://registry.npmjs.org/<pkg>/<version> | grep -o '"license":"[^"]*"'
```

## Open / gated (not blocking the web + native-over-LAN product)

- **IP-counsel sign-off** before any *commercial* distribution that depends on the GPL engine — the
  technical boundary is necessary, not by itself sufficient
  ([ADR-0009](decisions/0009-arms-length-gpl-containment.md), [LEGAL.md](LEGAL.md),
  root [LICENSE](../LICENSE) / [LICENSE.BSL](../LICENSE.BSL)).
- **Server-side dependency register.** This doc covers the *client*. A complete attribution register
  for the **engine** process (OpenCPN GPLv2+, wxWidgets 3.2 / wxWindows licence, GDAL/OGR/PROJ
  MIT-X-style) is a separate NATIVE-12 deliverable — out of scope here because none of it ships to the
  client. The GPL/GDAL boundary *decision* is [ADR-0002](decisions/0002-enc-engine.md) /
  [ADR-0009](decisions/0009-arms-length-gpl-containment.md).
- **Extend the containment guard to native outputs** once `NATIVE-*` produces installable bundles
  (assert the shipped bundle launches the engine as a separate process, and that no GPL artifact lands
  inside the client app) — already flagged Open in ADR-0009. A **source-level** provenance lint for
  `web/` (rule 2 above) would complement the existing binary-linkage check.

## See also

- [ADR-0009 — Arm's-length GPL containment interface](decisions/0009-arms-length-gpl-containment.md)
  (the boundary + binary guard; `ENGINE-11`)
- [ADR-0002 — ENC engine (GPL vs clean-room GDAL rebuild)](decisions/0002-enc-engine.md)
- [ADR-0006 — Server / thin-client split](decisions/0006-server-client-thin-display.md)
- [LEGAL.md — chart/weather data-source register + attribution checklist](LEGAL.md)
- [OPENCPN-REUSE.md](OPENCPN-REUSE.md)
