# Symbol Library Manifest

Status: Draft  
Version: 0.1  
Purpose: local generated maritime symbol library package

## Point

This package is not trying to create a new maritime standard. It is a practical manifest for generated symbol libraries.

The manifest gives each symbol:

- A stable local ID.
- A display name.
- A type and category.
- A visual tier.
- SVG asset paths.
- Palette/style variants.
- Source references when known.
- QA and visual parity status.
- Provenance and clean-IP status.
- Accessibility text.

The goal is to prevent the symbol library from becoming a loose folder of SVGs with no repeatable way to test, regenerate, inspect, cache, or consume them from Helm, WebGPU, or native renderer tooling.

## Cartography Boundary

This manifest describes symbols and assets. It does not decide chart portrayal.

For chart-like or official chart content, the manifest must not decide:

- Which source features use which symbols.
- Where symbols are placed.
- What is drawn above or below what.
- What is shown or hidden at chart scale.
- How decluttering works.
- What display priority a feature has.

Those decisions belong to the relevant portrayal rules, cartographer, presentation compiler, or application overlay policy. The symbol asset pipeline can produce and verify assets, but the presentation compiler remains the Tier 1 chart portrayal authority.

## Package Layout

```text
registry/
  symbols.yaml
  symbols.json
  symbol.schema.json
assets/
  svg/
    canonical/
out/
  qa/
  provenance/
tools/
  validate_registry.py
```

## Visual Tiers

Use tiers to keep generated assets honest.

`chart-artifact`:
Chart-like or chart-derived symbol assets. These may map to S-52/S-101 concepts, but the manifest is not the official chart portrayal authority and must not decide cartographic use.

`overlay`:
Helm or application overlays such as route, weather, sensor, planning, or object-inspection graphics.

`ui`:
Product UI icons, toolbar symbols, status badges, and controls.

## QA Status

Every symbol must say what is known about it.

Allowed values:

- `accepted`
- `needs_review`
- `failed`
- `blocked`

Do not mark a symbol `accepted` unless the asset has passed the relevant verifier or manual review gate.

## Provenance Status

Allowed values:

- `owned`
- `generated_owned`
- `public_reference`
- `requires_review`
- `blocked`

For now, the starter SVGs in this workspace are simple owned draft artwork and intentionally marked `needs_review`.

## Implementation Fit

This belongs in the offline symbol asset pipeline, not the boat-runtime process.

Acceptance criteria:

- `registry/symbols.yaml` exists.
- `registry/symbols.json` exists.
- Every symbol points to a real SVG asset.
- Every symbol has provenance.
- QA failures or pending reviews are explicit.
- The manifest does not encode official chart z-order, display priority, scale visibility, or decluttering rules.
- The manifest validates against `registry/symbol.schema.json`.
- The manifest can later feed atlas generation, cache keys, and debug inspection.

## Current Seed

The current seed is a working local package, not final artwork. It has enough structure to start consuming IDs and asset paths in tooling while keeping the visual review status visible.
