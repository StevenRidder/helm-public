# 0014: Prefer Existing Standards At Service Boundaries

Date: 2026-07-01

Status: Proposed

## Context

Helm touches domains that already have serious standards and existing practice:
IHO chart data and portrayal, NMEA/AIS inputs, GPX/route exchange, OGC
geospatial formats, GRIB/weather data, SVG/WebGPU/Vulkan rendering, and local
package formats such as MBTiles or PMTiles.

Trying to invent replacement standards would make Helm less useful and less
credible. The useful work is to define the missing implementation contracts
between Helm components.

## Decision

Use existing standards where they already own the layer. Write Helm proposals or
RFC-style documents only for unspecified implementation seams.

The standards map lives at
[../proposals/STANDARDS-LAYER-MAP.md](../proposals/STANDARDS-LAYER-MAP.md).

## Examples

- Do not replace S-52/S-101 portrayal. Define the presentation compiler boundary.
- Do not replace NMEA, AIS, or Signal K. Define adapter/display contracts.
- Do not invent a new geometry format while GeoJSON, GeoPackage, MVT, PMTiles,
  or OGC APIs are sufficient.
- Do define draw-only renderer commands, rebuildable GPU caches, inspection
  traces, and local package manifests where no maritime standard owns the seam.

## Consequences

The proposal set stays useful to OpenCPN and maritime developers because it
respects existing authorities while making Helm's internal contracts reviewable.
