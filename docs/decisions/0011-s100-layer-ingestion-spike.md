# ADR-0011 - S-100 Layer Ingestion Spike

- **Status:** Accepted for LABS-5 proof scope; production parser and UI remain future work.
- **Date:** 2026-06-29
- **Builds on:** [ADR-0008](0008-prebaked-offline-tile-packs.md), [ADR-0009](0009-arms-length-gpl-containment.md), `AI-17`, `TIDES-2`, `LABS-2`

## Context

S-100 is the professional direction for layered nautical products. The useful Helm move is not to
wait for full global S-101 coverage, and not to stuff product-specific logic into a renderer. The
move is to prove that individual products can enter Helm as source-tagged layers with clear
contracts:

| Product | Helm target |
|---|---|
| S-102 bathymetry | `depth.bathymetry` for depth, contours, and UKC input |
| S-104 water levels | `tides.water_level` for tide state and safety-contour inputs |
| S-111 surface currents | `tides.current` for pass/current context |
| S-124 navigational warnings | `warnings.navigation` for route-aware warnings and probes |
| S-129 under-keel clearance | `pass.ukc` for `TIDES-5` / `LABS-2` pass-condition modeling |

The spike also reflects the marketplace shape: official S-100, partner layers, and cruiser-local
layers should travel one layer/probe pipe, with provenance, confidence, coverage, and freshness
visible at the point of use.

## Decision

LABS-5 defines an executable fixture inventory, not a production S-100 parser.

The inventory shape is `helm.labs.s100.layer_inventory.v1` and carries:

- product identifier, dataset name, edition, reference date, and producer code
- source feature IDs and source links
- coverage bbox/polygon
- time range
- target Helm contract and probe handle
- freshness, confidence, and explicit not-for-navigation labels

The sample path is:

```text
S-100 fixture inventory
  -> S100FixtureProbeLayer
  -> ProbeRegistry.sample("s111.surface_current", lat, lon, t)
  -> LayerSample with sourceRef, freshness, confidence, coverage, and advisory label
```

That path is covered by `backend/test_s100_spike.py`.

## Consequences

- S-100 semantics stay above the renderer. A backend renderer or future WebGPU/Vulkan backend draws
  already-presented primitives; it does not decide what an S-111 current or S-129 clearance means.
- Real parsers can be swapped in behind the same inventory and probe contract later.
- S-129 is treated as a pass/UKC model input, not as a simple visual overlay.
- S-124 remains advisory/probe input until alert policy and route-awareness are production-grade.
- The fixture is intentionally marked not for navigation and synthetic; it proves contract shape,
  not data availability or authoritative coverage.

## Non-Goals

- No claim of production S-100 parsing.
- No S-101 base-chart dependency.
- No UI or MapLibre layer picker work.
- No live port, engine, or OpenCPN-derived code changes.

## Follow-Ups

- Replace fixture records with a real S-102 or S-111 sample reader.
- Connect the layer inventory to the local region bundle/catalog so offline packages can advertise
  S-100-derived layers.
- Feed S-104/S-111/S-129 samples into the `TIDES-5` / `LABS-2` pass-condition model.
- Add source-to-render inspection so a tapped warning, current arrow, or UKC advisory can explain
  the product, edition, producer, and coverage behind it.
