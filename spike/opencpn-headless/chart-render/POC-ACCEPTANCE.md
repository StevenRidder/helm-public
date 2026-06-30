# Vulkan Renderer POC Acceptance

Status: POC stakeholder rubric for Vulkan board `QA-1`

This rubric defines what the Vulkan renderer proof must demonstrate, what it
does not claim, and what evidence OpenCPN and Helm stakeholders should expect
before the POC is treated as successful.

It builds on the already-proven headless S-52 bitmap spike in this directory
and the shared renderer seam docs:

- [VULKAN-RENDERER-SEAM.md](../../../docs/VULKAN-RENDERER-SEAM.md)
- [VULKAN-RENDER-COMMAND-STREAM.md](../../../docs/VULKAN-RENDER-COMMAND-STREAM.md)
- [VULKAN-RENDER-ADAPTERS.md](../../../docs/VULKAN-RENDER-ADAPTERS.md)
- [VULKAN-RENDER-FIXTURES.md](../../../docs/VULKAN-RENDER-FIXTURES.md)

## Success Claim

The POC succeeds when it proves this narrow claim:

```text
One upstream-shaped C++ renderer core can consume explicit chart-render command
streams and produce equivalent nautical chart semantics for both an OpenCPN
interactive adapter and a Helm headless/offscreen tile adapter.
```

The POC is not a claim that the renderer is complete, production-ready, faster
than the existing OpenCPN path, or ready to replace OpenCPN on a boat.

## Must Prove

### Shared Renderer Boundary

- The shared core is C++ and OpenCPN-native in shape.
- OpenCPN and Helm adapters call into the same command semantics instead of
  copying S-52 rules into separate code paths.
- Commands carry deterministic ordering, explicit render view/display state, and
  provenance references back to source chart/object/transform records.
- Adapter-specific policies, such as HTTP cache headers or swapchain present
  mode, can change without changing command-stream hashes.

Evidence:

- design docs identify which behavior is shared, OpenCPN-specific, or
  Helm-specific;
- one command fixture validates with the C++ fixture checker;
- command-stream hashes are stable for a fixed source/view/display tuple.

### VulkanSceneGraph Backend

- The backend can render at least one fixture command stream to an offscreen
  image without a GUI window.
- The backend can render the same semantic fixture through an interactive or
  testable onscreen path suitable for OpenCPN canvas integration.
- Device/session/resource lifetime is explicit enough that failures are
  diagnosable rather than hidden in global canvas state.

Evidence:

- offscreen framebuffer output captured from a private test run;
- interactive or onscreen test-target output captured from the same fixture;
- diagnostics include device/backend status and command/provenance ids where
  available.

### S-52 Semantics

- The POC exercises at least one canonical point symbol, line style, area fill,
  raster/background command, label/text command, and sounding command.
- Display category, palette, SCAMIN/overzoom, and safety-depth or
  safety-contour inputs are present in the command/display contract.
- Chart 1 acceptance items identify which S-52 cases are covered and which are
  still absent.

Evidence:

- Chart 1 catalog entries name the S-52 features under test;
- golden images or review artifacts compare POC output against OpenCPN
  baselines for the covered cases;
- missing S-52 coverage is tracked as known POC debt rather than implied done.

### Depth, Shoreline, And Quilting

- At least one fixture path covers depth areas, depth contours, shoreline or
  land/water boundaries, and no-data/collar/coverage behavior.
- Quilt decisions affecting pixels are explicit in commands or provenance.
- Wrong-location and boundary bugs can be traced from final pixels back to
  source chart/object and transform data.

Evidence:

- selected fixture cells or synthetic fixtures are redistributable;
- source cells are not committed when licensing forbids redistribution;
- provenance records survive through command validation and image review.

### Dual Adapter Proof

- OpenCPN owns interactive canvas integration, swapchain/window behavior, and
  plugin/overlay presentation.
- Helm owns headless tile math, offscreen target sizing, PNG/readback, cache
  keys, ETags, and MapLibre composition.
- Both adapters consume the same shared render semantics for equivalent
  source/view/display inputs.

Evidence:

- OpenCPN adapter proof names the input view/display state and captured output;
- Helm adapter proof names the `{z}/{x}/{y}`, palette/category/depth settings,
  cache key inputs, and captured output;
- adapter-specific code paths do not reimplement S-52 ordering, symbol
  selection, label placement, or depth-contour semantics.

## Should Prove If Time Allows

- Measured first-frame and warm-cache render times for the starter fixtures.
- Resource-cache invalidation by source epoch, schema version, display state,
  and backend resource version.
- Failure outputs for missing chart coverage, unsupported commands, missing
  resources, and device/offscreen-target failure.
- A minimal stakeholder demo showing OpenCPN and Helm output generated from the
  same command-stream fixture.

## Explicit Non-Goals

The POC does not promise:

- complete S-52, S-57, S-63, S-101, CM93, raster, or plugin coverage;
- production navigation safety or regulatory certification;
- a replacement for OpenCPN during sea trials;
- a final standalone renderer repository layout;
- a clean-room or non-GPL renderer implementation;
- closed-source or App Store licensing conclusions;
- a Helm-only renderer fork;
- MapLibre UI polish, AIS/weather/route overlay behavior, or cockpit features;
- autopilot, alarms, routing, tides, or other non-chartplotting features;
- final performance characteristics across all chart packs and hardware.

## Stakeholder Evidence

### OpenCPN Stakeholders

OpenCPN stakeholders should expect evidence that the POC is upstream-shaped and
maintainable:

- C++ implementation style and build integration fit OpenCPN conventions.
- The interactive path can coexist with wx canvas lifecycle and plugin overlay
  boundaries.
- Existing OpenCPN chart semantics remain the baseline for comparison.
- The POC can be disabled or bypassed without destabilizing the current
  renderer.
- Missing S-52 coverage is visible in the acceptance catalog.

### Helm Stakeholders

Helm stakeholders should expect evidence that the POC can serve the boat-server
shape without moving renderer semantics into the web client:

- headless/offscreen rendering works on a private test port or offline capture
  target;
- `/chart/{z}/{x}/{y}.png` integration remains a thin adapter around shared
  semantics;
- cache keys, ETags, diagnostics, and MapLibre composition stay Helm-owned;
- bring-your-own chart data and offline runtime paths remain explicit;
- live `:8080` is not touched by POC tests.

### Shared Project Stakeholders

Both communities should expect:

- exact branch, commit, and PR evidence for every acceptance item;
- fixture paths, command hashes, and image hashes recorded with review notes;
- side-by-side artifacts when output changes;
- a clear distinction between passing POC cases and unimplemented chart
  behavior;
- no hidden dependency on Helm HTTP state or OpenCPN UI globals for command
  interpretation.

## Minimum Exit Criteria

The POC is ready for stakeholder review when:

1. The seam, command-stream, adapter, and fixture docs are current.
2. The C++ fixture checker passes on the committed fixture corpus.
3. Offscreen VSG output exists for at least one committed fixture.
4. Interactive or onscreen VSG output exists for the same fixture or equivalent
   Chart 1 acceptance scene.
5. Chart 1 and depth/shoreline fixture coverage are documented.
6. Golden-image comparison can explain failures as command drift, backend pixel
   drift, missing fixture coverage, or accepted visual change.
7. OpenCPN and Helm adapter proofs name the same shared semantics and their own
   adapter-owned behavior.
8. Non-goals and known debts are recorded next to the proof artifacts.

Anything less can still be valuable progress, but it should be reported as an
intermediate result rather than "the Vulkan renderer works."
