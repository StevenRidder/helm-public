# ADR-0005 — Community / places overlay: open-first, NFL push, partnership-or-personal pull

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

We want NoForeignLand-style places/anchorages/services (and boats) as a toggleable overlay.
After reading NFL's docs, there is **no public read API** — only push-to-NFL integrations.
Pulling NFL's data means a partnership or reverse-engineering their internal backend (which
broke the community reader). SeaPeople and ActiveCaptain are also walled. See
[integrations/noforeignland.md](../integrations/noforeignland.md).

## Decision

Build the **Places overlay from open data**, and treat the walled gardens as additive:

1. **Primary (open, shippable):** OpenStreetMap via Overpass + OpenSeaMap — pulled by bbox,
   cached offline beside the chart mbtiles, rendered as a MapLibre symbol layer.
2. **Owned:** Helm user pins + reviews stored in our backend (becomes Helm's own community asset).
3. **NoForeignLand push (official):** let the user mirror their track to NFL via their own
   NFL boat API key.
4. **NoForeignLand pull:** **partnership only** for a shipped product; allowed behind a
   personal-use *experimental* flag, never in a distributed binary.
5. **SeaPeople / ActiveCaptain:** not integrated (walled; partnership-only).

## Consequences

- Ship a useful Places overlay with **zero dependency on a walled garden** and full offline support.
- Honor ODbL attribution; cache hard and self-host/mirror Overpass at scale (don't hammer the
  public endpoint).
- Keep the option to light up richer NFL/Navily/ActiveCaptain data later via partnerships.
- The personal-build NFL pull is best-effort and may break on NFL changes — acceptable, flagged.
