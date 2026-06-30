# ADR-0002 — ENC (S-52) engine: contain GPL vs. rebuild on GDAL

- **Status:** Proposed (decision gated on IP counsel — blocks Phase 2)
- **Date:** 2026-06-23

## Context

MapLibre cannot render S-52 (no IHO symbology, safety contours, or Day/Dusk/Night).
True vector ENC needs a dedicated S-52 engine composited on top of the raster renderer.
OpenCPN has a mature, GPLv2+ S-52 engine. Using it in a closed App Store binary is the
"VLC problem"; the project license posture keeps the option to commercialize Helm-authored
code separately from the GPL engine.

## Options

1. **Contain OpenCPN's GPL S-52 engine** behind a stable, arm's-length interface.
   - + Fastest to true ENC; battle-tested rendering.
   - − Copyleft + OpenGL-on-iOS concerns; may be incompatible with a closed App Store
     binary *at all*; constrains the license posture.
2. **Rebuild S-52 on permissive GDAL/OGR + PROJ + a custom symbology layer.**
   - + Clean IP; keeps the core relicensable; pairs with GDAL we already use.
   - − More work; must re-implement S-52 symbology and safety logic.

## Recommendation

Lean **option 2 (rebuild)** to preserve the commercial option, pending IP counsel and an
effort estimate. Phase 1 ships on **NOAA NCDS raster mbtiles** so true S-52 is deferred to
Phase 2 and this decision doesn't block the MVP.

## Consequences

- Counsel sign-off required before any OpenCPN source is embedded.
- If counsel forbids embedding even arm's-length, option 2 becomes mandatory and Phase 2
  scope grows.
