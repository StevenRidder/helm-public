# Vulkan Renderer License And Upstream Boundary

Status: POC boundary for Vulkan board `ADAPT-3`

This document records the engineering boundary for upstreaming and consuming the
shared Vulkan renderer without creating a forever fork or mixing GPL-derived
renderer code into the wrong Helm surfaces. It is not legal advice; public,
commercial, App Store, or appliance distribution still needs counsel review.

## Decision

The Vulkan renderer POC is upstream-shaped first:

- OpenCPN-derived chart conversion, S-52 semantics, render-command construction,
  VulkanSceneGraph backend code, fixtures, and shared renderer behavior stay
  GPLv2-or-later compatible and live on the OpenCPN-facing renderer branch
  during the POC.
- OpenCPN consumes the shared core through an interactive wx/swapchain adapter.
- Helm consumes the same shared core through a thin headless/offscreen tile
  adapter in the boat-server engine process.
- Helm web, mobile, and cloud/client surfaces stay on the HTTP/WebSocket or
  equivalent arm's-length protocol side. They do not link OpenCPN-derived
  renderer code, embed GPL renderer source, or reimplement shared S-52 semantics.
- Standalone repository extraction is deferred until both adapters consume the
  same command stream and fixture tests prove shared behavior.

The goal is contribution-shaped reuse, not a private renderer copy that slowly
drifts away from OpenCPN.

## Ownership And License Placement

| Surface | Where it belongs during POC | Boundary rule |
|---|---|---|
| Shared renderer core | OpenCPN Vulkan branch or a GPL-compatible shared-core area | Owns chart semantics, command-stream construction, VSG backend behavior, renderer fixtures, and golden expectations. |
| OpenCPN adapter | OpenCPN-facing branch | Owns wx event loop, canvas invalidation, swapchain/window lifecycle, native preferences, and plugin-overlay integration. |
| Helm tile adapter | Helm engine/boat-server side | Owns slippy tile math, offscreen target creation, PNG/readback, cache keys, ETags, `/chart`/`/catalog` behavior, diagnostics presentation, and MapLibre source composition. |
| Helm web/mobile clients | Helm client side | Consume rendered tiles and nav frames over protocol boundaries. They may configure display options, but they do not link or copy OpenCPN-derived renderer code. |
| Debug fixtures and docs | Repo area that matches their content provenance | Synthetic fixtures may be committed when redistributable. Private charts, S-63 material, oeSENC output, generated SENC caches, or private imagery must not be committed. |

If a Helm file links OpenCPN-derived renderer code or compiles into the
OpenCPN-derived engine, treat that work as engine-side GPL-compatible work for
distribution and notice purposes. Helm-authored BSL/client code remains separate
only while it stays outside that linked renderer process and speaks through the
protocol boundary described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Allowed Paths

- Pin Helm's engine build to a reviewed OpenCPN Vulkan branch commit for the
  renderer POC.
- Feature-flag the Vulkan renderer path so the current S-52 tile path remains a
  fallback during proof and review.
- Contribute reusable command-stream, semantic, fixture, and backend work back
  toward OpenCPN in an upstream-shaped form.
- Keep Helm-specific scheduling, cache, HTTP, diagnostics, and MapLibre policy in
  the Helm adapter.
- Use synthetic redistributable fixtures and externally fetched public ENC cells
  for regression tests when their provenance and hashes are recorded.

## Forbidden Paths

- Do not copy shared renderer semantics into Helm-only web, mobile, backend, or
  BSL-licensed code.
- Do not make the shared core depend on Helm HTTP state, MapLibre source names,
  cache headers, or client UI state.
- Do not make the shared core depend on OpenCPN canvas globals, plugin-manager
  globals, toolbar state, or a hidden live GUI object as its only state source.
- Do not describe the POC as clean-room while OpenCPN-derived conversion,
  symbolization, or renderer code remains in the path.
- Do not embed GPL/OpenCPN-derived renderer code into closed mobile clients or
  App Store binaries. A local mobile renderer would require a separate
  clean-room/permissive path or explicit legal review.
- Do not commit private chart packs, S-63 data, oeSENC output, generated SENC
  caches, private imagery, or other non-redistributable test data.

## Icon Forge Presentation Asset Pack Boundary

Icon Forge is allowed to generate fresh SVG artwork from public-domain U.S.
Chart No.1 references, local `chartsymbols.xml` / S-52 lookup metadata, and
Helm-authored generator primitives/stylepacks. The generated artwork must carry
provenance hashes for the catalog, stylepacks, generator code, QA reports, atlas
manifests, and rendered atlas images before the full catalog is run.

Icon Forge must not extract, trace, crop, or repackage OpenCPN GPL
`rastersymbols-*.png` sheets into the owned Presentation Asset Pack. It also
must not use private ENC, S-63, oeSENC, generated SENC cache, or proprietary IHO
publication artwork as committed source material. Broken or uncertain symbols
stay in the hard pile; the verifier must not be weakened to increase coverage.

Until counsel confirms the own-artwork provenance and distribution placement,
the Presentation Asset Pack remains engine-side and experimental. Raw generated
artwork does not cross into closed/mobile/client distribution surfaces, and the
public wording should describe the work as a provenance-gated pilot rather than
a finished redistributable library.

## Contribution Workflow

1. Put shared renderer behavior on the OpenCPN-facing Vulkan branch with clear
   provenance and minimal Helm assumptions.
2. Keep Helm integration patches limited to the headless adapter, runtime path
   resolution, tile scheduling, HTTP/cache policy, diagnostics presentation, and
   feature-flag plumbing.
3. Record the pinned renderer commit consumed by Helm whenever the adapter is
   wired or updated.
4. When a patch is useful beyond Helm, prepare it as an upstreamable OpenCPN
   change instead of hiding it behind Helm-only build assumptions.
5. If upstream review is slow, keep the fork patch stack small, documented, and
   separable so it can still be reviewed or rebased later.
6. Revisit standalone extraction only after the OpenCPN and Helm adapters both
   replay the same command stream and fixture corpus.

## Distribution Notes

- Any distributed engine package that includes OpenCPN-derived renderer code must
  preserve the applicable GPLv2-or-later notices, source availability, and
  attribution duties.
- Helm clients can remain thinner, separately licensed surfaces only when they
  consume the engine through an arm's-length protocol boundary.
- iOS/iPadOS clients should stay remote/thin during this POC. Hosting the
  OpenCPN-derived wx/GPL engine locally on those clients is outside this path.
- Public demos and releases should keep safety disclaimers, chart-data
  provenance, and dependency notices current in [SAFETY.md](../SAFETY.md),
  [NOTICE](../NOTICE), and [LEGAL.md](LEGAL.md).

## Acceptance For ADAPT-3

`ADAPT-3` is satisfied when later adapter work can answer these without debate:

- Where does a renderer change belong: shared core, OpenCPN adapter, Helm tile
  adapter, or Helm client?
- Does the change keep GPL-derived code contained to the OpenCPN/engine side?
- Can Helm consume the renderer by pinned commit without copying shared
  semantics into Helm-only code?
- Is the contribution path still upstream-shaped rather than a forever fork?
- Are public-distribution, App Store, and chart-data obligations explicitly
  called out before anyone ships the result?
