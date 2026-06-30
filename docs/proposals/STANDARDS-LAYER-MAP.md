# Standards Layer Map For Helm/OpenCPN Boundary Proposals

Status: Draft  
Date: 2026-07-01  
Scope: implementation seams and candidate RFC boundaries

## Purpose

This document maps current Helm/OpenCPN implementation boundaries against existing standards and specifications.

The rule is simple:

> Use existing standards where they already own the layer. Write project RFCs only for missing implementation boundaries.

This keeps the work useful to OpenCPN developers without accidentally becoming a parallel charting standards body.

## Implementation Workstreams

The current renderer and product architecture already split the work into useful layers:

- Renderer seam: renderer ownership boundaries and command stream.
- Chart source pipeline: chart-source and provenance boundaries.
- Package format: portable nautical package architecture.
- Converter API: replaceable chart converter boundary.
- Presentation compiler: S-52/S-101 presentation boundary.
- Symbol assets: generated symbols, visual QA, provenance, and atlas integration.
- Cache: machine-local GPU/tile artifact cache.
- Backend: draw-only backend contract for native and web rendering targets.
- Debug/inspection: source-to-render inspection.
- Web consumer: Helm browser/WebGPU artifact consumer contract.
- Adaptation/upstream: OpenCPN/Helm integration and upstream posture.

## Executive Map

| Layer | Existing standards or sources | Implementation area | Project RFC? |
|---|---|---|---|
| Official ENC/chart data | IHO S-57, S-100, S-101, S-102, S-104, S-111, S-124, S-125, S-128, S-412, S-63, S-58, S-98 | Converter, presentation, package format | No replacement. Only adapter/profile docs. |
| Official chart portrayal | IHO S-52, S-101 portrayal/catalogues, IEC ECDIS context | Presentation compiler, symbol integration | No portrayal RFC. Compiler boundary RFC only. |
| Symbol asset library | SVG, OpenBridge references, generated owned assets, Chart No.1 reference workflow | Symbol asset pipeline | Yes: asset manifest, provenance, QA, clean-IP status. |
| Routes/tracks | GPX, RTZ, IEC route exchange concepts, S-421 where applicable | Helm route layer, package format | Maybe: practical route/track profile. |
| Overlay layers | GeoJSON, OGC API Features, GeoPackage, WMS/WMTS, OGC API Tiles, MVT, MBTiles, PMTiles, Cloud Optimized GeoTIFF | Package format, web consumer | Yes: marine overlay package/profile wrapper. |
| Preprocessed package and index | S-100 exchange-set patterns, S-128 catalogue ideas, GeoPackage/PMTiles/MBTiles/MVT where useful | Package format, converter, cache | Yes: local package/index/cache contract. |
| Renderer seam | No direct maritime standard | Renderer seam, backend | Yes: command stream and backend contract. |
| GPU artifacts/cache | Vulkan/WebGPU APIs, local cache practice | Cache, native backend, web backend | Yes: rebuildable artifact cache contract. |
| Source-to-render debug | No direct maritime standard | Debug/inspection, provenance | Yes: provenance/inspection trace. |
| Sensors/AIS/NMEA | NMEA 0183/2000, IEC 61162 family, ITU-R M.1371 AIS, Signal K as open implementation ecosystem | Helm runtime, sensor/AIS adapters | Maybe: adapter profile, not replacement protocol. |
| Weather/metocean | S-104, S-111, S-412, GRIB conventions, OGC coverage/tile APIs | Package format, web consumer | Yes: local field/texture artifact contract. |
| Web/client contract | WebGPU, WebGL, SVG, OpenAPI where appropriate | Web consumer, backend, debug/inspection | Yes: client artifact consumer contract. |

## Layer Details

### 1. Official Chart Data

Existing standards and sources:

- IHO S-57: legacy ENC transfer standard.
- IHO S-100: universal hydrographic data model.
- IHO S-101: ENC product specification under S-100.
- IHO S-102: bathymetric surface.
- IHO S-104: water level information.
- IHO S-111: surface currents.
- IHO S-124: navigational warnings.
- IHO S-125: marine aids to navigation.
- IHO S-128: catalogue of nautical products.
- IHO S-412: weather overlay.
- IHO S-63: data protection scheme.
- IHO S-58: ENC validation checks.
- IHO S-98: interoperability specification for S-100 ECDIS.

Implementation ownership:

- Converter: read source products and convert into implementation package records.
- Package format: carry product identity, edition, producer, coverage, and package metadata.
- Presentation compiler: consume source feature semantics for portrayal.

Do not invent:

- New ENC encoding.
- Replacement S-101 schema.
- Replacement data protection.
- Replacement validation scheme.

Possible RFC:

- `RFC: Portable Nautical Package Profile`
- `RFC: Chart Converter Module API`

The RFC should say how our implementation carries references to official products. It should not define the official products themselves.

### 2. Official Chart Portrayal

Existing standards and sources:

- IHO S-52 and the ECDIS Presentation Library.
- S-101 portrayal catalogues and S-100 portrayal model.
- Chart No.1 as a public explanatory reference, not a machine portrayal authority.
- IEC ECDIS performance context, where applicable.

Implementation ownership:

- Presentation compiler: owns the compiler boundary.
- Symbol integration: audits reusable S-52 semantics.
- Chart test fixtures: hold Chart No.1 acceptance/debug coverage.

Do not invent:

- Feature-to-symbol rules for official chart content.
- Z-order/display priority for official chart content.
- Scale visibility/SCAMIN replacement rules.
- Decluttering rules for official chart content.
- Safety contour behavior.
- Text/sounding placement.

Possible RFC:

- `RFC: Presentation Compiler Boundary`

The RFC should define inputs, outputs, provenance, and test fixtures for the compiler. It should not define cartography.

### 3. Generated Symbol Asset Library

Existing standards and sources:

- SVG for canonical vector assets.
- OpenBridge as a maritime/industrial UI reference set where licensing and context permit.
- Chart No.1 references for human visual parity review.
- Project-owned generated geometry and primitives.

Implementation ownership:

- Symbol asset pipeline: generated assets, QA, hard cases, provenance, clean-IP boundary.
- Symbol integration: symbol and atlas integration.
- Presentation compiler: remains authority for Tier 1 chart semantics.

Do not invent:

- Official chart portrayal policy.
- Official S-52/S-101 replacement symbology.
- Legal equivalence to official chart symbols.

Possible RFC:

- `RFC: Generated Symbol Library Manifest`

This proposal should define stable IDs, SVG paths, variants, source references, accessibility, QA state, and provenance.

### 4. Routes And Tracks

Existing standards and sources:

- GPX 1.1 for broad waypoint/route/track exchange.
- RTZ route exchange format in ECDIS/vendor route exchange practice.
- IEC route-plan concepts and IHO S-421 route plan work where applicable.
- OpenCPN's existing route/track data model and plugin interfaces.

Implementation ownership:

- Not currently a core rendering seam.
- Future Helm route layer should own product semantics.
- Renderer should consume route primitives only after application policy decides what route data means.

Do not invent:

- A whole new route exchange standard before profiling existing ones.
- Autopilot/control semantics inside a route display format.

Possible RFC:

- `RFC: Open Route/Track Exchange Profile`

This could be useful if it profiles GPX/RTZ-like concepts into a local, testable JSON/GeoJSON form with explicit metadata and no autopilot authority.

### 5. Overlay Layers And Extra Georeferenced Information

Existing standards and sources:

- RFC 7946 GeoJSON.
- OGC API Features.
- OGC GeoPackage.
- OGC WMS/WMTS.
- OGC API Tiles and Tile Matrix Set.
- Mapbox Vector Tile.
- MBTiles.
- PMTiles.
- Cloud Optimized GeoTIFF.
- OGC SensorThings API for sensor observations where applicable.

Implementation ownership:

- Package format: package and layer metadata.
- Web consumer: browser/client consumption.
- Debug/inspection: inspection/provenance.

Do not invent:

- A new geometry format unless existing formats fail a documented requirement.
- A map tile format unless MBTiles/PMTiles/MVT/COG/OGC options are insufficient.

Possible RFC:

- `RFC: Marine Overlay Layer Manifest`

This should wrap existing geospatial formats with marine metadata: layer identity, source, time validity, safety status, update policy, attribution, offline cache behavior, and inspection fields.

### 6. Preprocessed Chart Package And Index

Existing standards and sources:

- IHO S-100 exchange-set concepts.
- S-128 catalogue/product metadata patterns.
- GeoPackage, MBTiles, PMTiles, MVT, COG, and OGC tile/index standards where useful.

Implementation ownership:

- Package format: portable nautical package architecture.
- Converter API: replaceable converter API.
- Chart source pipeline: chart source/provenance boundary.
- Cache: machine-local artifact cache.

Do not invent:

- A final render contract disguised as a package format.
- A protected-chart redistribution mechanism.
- A cache format that becomes durable chart truth.

Possible RFC:

- `RFC: Portable Nautical Package And Index`

This is an implementation package profile. It can define product references, coverage, feature partitions, layer inventories, and index metadata. It must keep protected/offical chart data rules intact.

### 7. Renderer Seam And Command Stream

Existing standards and sources:

- No maritime standard owns the app-to-renderer command stream.
- General graphics APIs exist, but they do not express nautical render semantics.

Implementation ownership:

- Renderer seam: render command stream schema and ownership boundary.
- Draw backend: draw-only backend contract.
- Native backend: VulkanSceneGraph implementation.
- Web backend: browser/WebGPU target.

Do not invent:

- Chart portrayal rules inside backend commands.
- Backend-specific command streams as durable data formats.

Possible RFC:

- `RFC: Nautical Render Command Stream`
- `RFC: Draw-Only Backend Contract`

These are strong candidates because no external standard cleanly owns this seam.

### 8. GPU Artifact Cache

Existing standards and sources:

- Vulkan and WebGPU define graphics API behavior.
- Filesystem/cache layout is implementation-specific.
- GPU pipeline/material/texture cache contracts are not maritime standards.

Implementation ownership:

- Cache: rebuildable machine-local GPU artifact cache.
- Draw backend: consumes artifacts.
- Debug/inspection: traces artifact provenance.

Do not invent:

- A durable chart package.
- Source semantics in cache keys beyond provenance handles.
- Backend-owned chart policy.

Possible RFC:

- `RFC: Rebuildable GPU Artifact Cache`

This can define cache keys, invalidation, device/backend identity, provenance handles, memory budgets, and debug trace hooks.

### 9. Source-To-Render Debug Inspection

Existing standards and sources:

- No direct maritime standard owns source-to-pixel debugging.
- OpenTelemetry/OpenAPI-style practices may help for API/log shape, but the nautical provenance chain is project-specific.

Implementation ownership:

- Debug/inspection: source-to-render inspection.
- Chart source pipeline: conversion provenance.
- Presentation compiler: presentation provenance.
- Cache/draw backend: artifact and draw provenance.

Do not invent:

- A new chart authority.
- Debug fields that imply legal equivalence to official portrayal.

Possible RFC:

- `RFC: Source-To-Render Inspection Trace`

This is a good candidate because it helps humans and AI agents inspect the chain from source feature to presentation primitive to cache artifact to pixel.

### 10. Sensors, AIS, And Navigation Inputs

Existing standards and sources:

- NMEA 0183.
- NMEA 2000.
- IEC 61162 family, including serial and Ethernet maritime data paths.
- ITU-R M.1371 for AIS technical characteristics.
- Signal K as a useful open implementation ecosystem, not a regulatory replacement.

Implementation ownership:

- Mostly Helm runtime, not renderer core.
- The renderer should draw already-decided target/vector primitives.

Do not invent:

- A replacement NMEA/AIS protocol.
- Autopilot or vessel-control authority inside display overlays.

Possible RFC:

- `RFC: Sensor/AIS Display Adapter Profile`

Only if there is a clear local adapter boundary between runtime data and render primitives.

### 11. Weather, Metocean, And Environmental Fields

Existing standards and sources:

- IHO S-104 for water levels.
- IHO S-111 for surface currents.
- IHO S-412 for weather overlay.
- GRIB conventions for weather grids.
- OGC coverage/tile APIs and Cloud Optimized GeoTIFF where useful.

Implementation ownership:

- Package format: field/layer metadata.
- Web consumer: environmental field-texture contract and browser scene.
- Cache: GPU field texture artifacts.

Do not invent:

- A new meteorological data model before profiling existing product families.
- A renderer-owned meaning for environmental fields.

Possible RFC:

- `RFC: Environmental Field Texture Artifact Contract`

This fits the existing environmental bundle and WebGPU field-texture work.

### 12. Web/API Client Boundary

Existing standards and sources:

- WebGPU.
- WebGL.
- SVG.
- OpenAPI for HTTP API descriptions where useful.
- OGC API standards where geospatial web APIs are involved.

Implementation ownership:

- Web consumer: browser/WebGPU consumer.
- Draw backend: draw-only backend contract.
- Debug/inspection: inspection hooks.

Do not invent:

- A browser graphics API.
- A Helm-only hidden format if OpenAPI/OGC-style descriptions fit.

Possible RFC:

- `RFC: Helm WebGPU Artifact Consumer`
- `RFC: Object Inspection API`

## Relationship To Target Service Architecture

This standards map answers what existing standards own. It does not define the runtime service end state.

ADR 0013 and [TARGET-SERVICE-ARCHITECTURE.md](TARGET-SERVICE-ARCHITECTURE.md) define the broad C++ target service architecture first, then use this standards map to decide which inter-service boundaries deserve RFCs.

The combined sequence is:

1. Define the target service catalog.
2. Map existing standards per layer.
3. Identify missing implementation seams between services.
4. Audit the relevant OpenCPN/Helm code path for each seam.
5. Write RFCs for the boundaries that remain project-specific.

The current renderer proof is intentionally narrower than the final service catalog:

- Keep S-52/S-101/chart semantics in the presentation/compiler layer.
- Keep navigation and chart model logic upstream-shaped.
- Put GPU drawing behind a neutral render model and draw-only backend.
- Keep caches disposable and rebuildable.
- Let Helm/WebGPU consume artifacts without owning official chart semantics.

## Recommended RFC Queue

Priority order:

1. `RFC: Presentation Compiler Boundary`  
   Owner: presentation compiler  
   Reason: protects cartography from renderer/backend drift.

2. `RFC: Generated Symbol Library Manifest`  
   Owner: symbol asset pipeline / symbol integration  
   Reason: lets generated assets become consumable without becoming portrayal policy.

3. `RFC: Portable Nautical Package And Index`  
   Owner: package format / converter API  
   Reason: defines what the local package carries and what it refuses to own.

4. `RFC: Nautical Render Command Stream`  
   Owner: renderer seam / draw backend  
   Reason: documents the narrow renderer seam that Vulkan/WebGPU can implement.

5. `RFC: Rebuildable GPU Artifact Cache`  
   Owner: cache  
   Reason: keeps GPU artifacts disposable and renderer/device-specific.

6. `RFC: Source-To-Render Inspection Trace`  
   Owner: debug/inspection  
   Reason: makes the whole pipeline explainable.

7. `RFC: Marine Overlay Layer Manifest`  
   Owner: package format / web consumer  
   Reason: supports extra georeferenced data without inventing geometry formats.

8. `RFC: Helm WebGPU Artifact Consumer`  
   Owner: web consumer  
   Reason: keeps browser rendering aligned with the shared package/cache/backend model.

## References

- IHO standards and specifications: https://iho.int/en/standards-and-specifications
- IHO S-100 based product specifications: https://iho.int/en/s-100-based-product-specifications
- IETF RFC 7946, GeoJSON: https://www.rfc-editor.org/rfc/rfc7946
- OGC GeoPackage: https://www.ogc.org/standard/geopackage/
- OGC API - Features: https://ogcapi.ogc.org/features/
- OGC API - Tiles: https://ogcapi.ogc.org/tiles/
- OGC Tile Matrix Set: https://www.ogc.org/standard/tms/
- OGC Web Map Service: https://www.ogc.org/standard/wms/
- OGC Web Map Tile Service: https://www.ogc.org/standard/wmts/
- OGC SensorThings API: https://www.ogc.org/standard/sensorthings/
- Cloud Optimized GeoTIFF: https://www.cogeo.org/
- PMTiles: https://github.com/protomaps/PMTiles
- MBTiles: https://github.com/mapbox/mbtiles-spec
- Mapbox Vector Tile: https://github.com/mapbox/vector-tile-spec
- GPX 1.1 schema: https://www.topografix.com/gpx.asp
- W3C WebGPU: https://www.w3.org/TR/webgpu/
- Khronos Vulkan: https://registry.khronos.org/vulkan/
- W3C SVG 2: https://www.w3.org/TR/SVG2/
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html
- ITU-R M.1371 AIS recommendation: https://www.itu.int/rec/R-REC-M.1371
