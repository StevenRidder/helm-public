# Note 0001: OpenCPN Cartography Boundary Feedback

Date: 2026-07-01  
Source: OpenCPN RFC discussion response from Dave

## Feedback

The RFC section on drawing classes and z-order risked conflating two separate questions:

- What symbols are available, and what should the assets look like?
- How may or must those symbols be used in chart portrayal?

Dave's core objection was that the second question belongs to the cartographer. If a registry chooses symbols, placement, ordering, display priority, scale visibility, or decluttering through heuristic rules, it becomes a de-facto cartographer and inherits the responsibility attached to that role.

## Design Decision

The generated symbol library must stay on the asset/identity side of the boundary.

It may define:

- Stable symbol IDs.
- Names and categories.
- SVG asset paths.
- Palette/style variants.
- Accessibility labels.
- Source mappings.
- Provenance and clean-IP status.
- QA and visual parity status.
- Asset-local anchors, orientation hints, and scale readability hints.

It must not define official chart portrayal rules:

- Which chart feature gets which symbol.
- Where a chart symbol is placed.
- Z-order.
- Display priority.
- Chart scale visibility.
- Decluttering.
- Safety contour behavior.
- Text or sounding placement.

For official or chart-like content, those decisions belong to S-52/S-101 portrayal rules, the cartographer, and the presentation compiler. The symbol asset pipeline owns asset generation and verification, while the presentation compiler remains the Tier 1 chart portrayal authority.

## Document Updates

The RFC and manifest were updated so z-order/display-priority/decluttering are no longer registry-owned conformance fields. They are now explicitly outside the symbol library for chart portrayal, with only non-normative application hints allowed for non-chart UI, preview tools, atlas grouping, debugging, or local overlays.
