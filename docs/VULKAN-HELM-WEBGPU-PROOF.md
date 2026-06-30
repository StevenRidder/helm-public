# Helm WebGPU Proof Path

Status: public POC publication note

This is the Helm-facing public explanation for the Vulkan renderer POC. It is
the narrow bridge between the OpenCPN proof branch and Helm's product direction:
Helm consumes the shared nautical pipeline and inspection contract, while the
Helm client experience is WebGPU-first with WebGL/MapLibre and server-rendered
raster fallbacks.

This document is intentionally smaller than the full Helm repo. It avoids
roadmap, business, board, and local-machine context so it can be used in public
POC/RFC material.

## Current Evidence Snapshot

- Helm branch: `main` at `f852bded8a0963fbccc9df6d47ef9befd3a9e69a`.
- OpenCPN renderer branch: `vulkan/render-core-poc` at
  `6c450d27e129f90519f8bd18e28c3a93eed83e8d`.
- Helm renderer-adapter evidence, PR #172: Helm can select the shared offscreen
  renderer path with `HELM_CHART_RENDERER=vulkan`, carry renderer SHA/cache
  metadata, emit renderer headers, and keep explicit legacy fallback.
- Helm extraction-gate evidence, PR #173: standalone repository extraction is
  gated until OpenCPN and Helm both consume the same renderer model with
  accepted evidence.
- OpenCPN proof-branch evidence, PR #26: the public proof branch is curated
  around `chart-render/`, reproducible CMake smoke/demo commands, and explicit
  exclusions for unfinished Metal compatibility work.

## Architecture Posture

Helm should not make VSG/Vulkan the browser architecture. The POC split is:

```text
chart source / interchange package
  -> C++ chart-source normalization
  -> S-52/S-101 presentation compiler
  -> NauticalRenderModel
  -> adapter scheduler policy
  -> server artifact boundary
  -> Helm browser/offline targets
```

OpenCPN owns the native interactive proof backend. VSG/Vulkan is useful there
because it proves a modern native draw/cache backend can consume the neutral
model without owning chart semantics.

Helm owns the product/client side: smooth pan/zoom, offline packs, prefetch,
object inspection UI, AIS/routes/weather/satellite composition, and fallback
behavior. Helm clients consume artifacts produced from the shared server-side
model; they do not reimplement S-52/S-101 or chart-source rules in browser code.

## Helm Client Target Priority

1. WebGPU is the preferred Helm client target for nautical primitives and
   high-frequency interaction once parity evidence exists.
2. WebGL/MapLibre remains useful for raster packs, basemap/weather/AIS/route
   composition, and fallback/experimentation where WebGPU is unavailable.
3. Server-rendered raster tiles remain the safety and verification fallback via
   `GET /chart/{z}/{x}/{y}.png`.

The route shape can remain stable while Helm adds model-derived browser
artifacts. A WebGPU-capable client should eventually prefer compiled primitive
packets and inspection packets, while unsupported devices can keep using raster
tiles.

## What The Server Must Own

The C++ boat-server side remains the semantic authority until a browser target
proves parity:

- chart-source parsing and normalization;
- S-52/S-101 display categories, SCAMIN, palette, symbol, pattern, text,
  sounding, and safety-depth decisions;
- chart quilting and source selection;
- neutral primitive generation and stable layer ordering;
- tile/view scheduler policy, overscan, prefetch hints, adjacent zoom blending,
  and cache invalidation epochs;
- object inspection provenance from source feature to browser draw record;
- deterministic server-raster output for fallback and regression evidence.

No browser renderer should fill a chart-semantics gap by inventing its own S-52
logic.

## What The Browser May Own

The browser/client may own interaction speed and composition:

- feature detection and renderer selection;
- WebGPU/WebGL/MapLibre composition with AIS, routes, tracks, weather,
  satellite, places, alarms, and UI overlays;
- camera motion, animation, smooth pan/zoom, and local zoom blending using
  server-provided scheduler hints;
- client cache admission, eviction, pack mounting, and prefetch execution;
- object picking and inspection UI using source trace handles emitted by the
  server.

The browser can be fast without becoming the chart-semantics authority.

## Current Helm Runtime Evidence

The renderer adapter in `engine/vendor/cli/helm_server.cpp` is intentionally a
thin adapter:

- `HELM_CHART_RENDERER=legacy|vulkan` selects the chart route renderer.
- `HELM_CHART_RENDERER_QUERY_OVERRIDE=1` enables `?renderer=` on private ports
  for development only.
- `HELM_VULKAN_RENDERER_BIN` points to the shared offscreen renderer command.
- `HELM_VULKAN_RENDERER_SHA` records the pinned renderer commit in headers and
  cache keys.
- `HELM_VULKAN_FALLBACK=legacy` enables explicit fallback; silent fallback is
  not allowed in verification.
- Successful Vulkan-path tiles carry `X-Helm-Renderer: vulkan` and renderer
  cache/output metadata.

The adapter owns HTTP, tile math, PNG encoding/readback, cache keys, ETags,
diagnostics, and fallback presentation. It does not own S-52 semantics, quilt
policy, neutral primitive generation, or backend draw/cache behavior.

## Offline And Sample Data Posture

Helm main includes small demo assets under `web/data/` so the UI can run without
private data. Per `web/data/DEMO-DATA.md`, these are synthetic fixtures, not
navigation data and not proof that PMTiles/MBTiles are the final renderer hot
path.

For public proof material:

- Do not package private charts, S-63 permits, oeSENC output, generated SENC
  caches, private satellite imagery, or vessel/runtime data.
- Treat `web/data/key-west-sat.pmtiles` as a synthetic demo fixture only unless
  a later packaging task re-verifies its provenance and license posture.
- Keep real chart packs, basemaps, generated caches, and route/vessel data in
  local runtime paths such as `HELM_ENC`, `HELM_USER_DATA_ROOT`, or `~/.helm`,
  never in Git.
- Do not use the live Helm `:8080` screen for public proof runs. Use a private
  development port and record branch, SHA, renderer SHA, port, fixture/source,
  and command.

## Public Framing Guardrails

- Say "Helm uses the shared nautical pipeline/model and object-inspection
  contract."
- Say "Helm product UX is WebGPU-first, with WebGL/MapLibre and server-raster
  fallbacks."
- Say "VSG/Vulkan is the OpenCPN/native proof backend, not Helm client
  architecture."
- Say "Metal is deferred compatibility work, not a current Helm product
  priority."
- Do not say this is full S-52 parity, ECDIS certification, primary-navigation
  readiness, a production WebGPU renderer, or a production Metal backend.
- Do not publish the whole Helm planning corpus as Vulkan proof. Use this doc,
  the seam/adapter/license docs, and the OpenCPN `chart-render/` proof package.

## Related Docs

- [VULKAN-RENDERER-SEAM.md](VULKAN-RENDERER-SEAM.md) - shared renderer
  ownership boundary and extraction gate.
- [VULKAN-RENDER-ADAPTERS.md](VULKAN-RENDER-ADAPTERS.md) - OpenCPN and Helm
  adapter responsibilities.
- [VULKAN-HEADLESS-TILE-ADAPTER.md](VULKAN-HEADLESS-TILE-ADAPTER.md) - Helm
  server-side tile route contract.
- [VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md) -
  GPL/upstream/client boundary.
- [LEGAL.md](LEGAL.md) and [SAFETY.md](../SAFETY.md) - distribution and
  navigation-safety obligations.

## RFC Handoff

The RFC package should use this as the Helm side of the proof. The OpenCPN side
should remain centered on the `vulkan/render-core-poc` proof branch, the
`chart-render/` docs, and reproducible CMake smoke/demo evidence.
