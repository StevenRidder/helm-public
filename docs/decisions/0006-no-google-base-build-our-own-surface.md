# ADR-0006 — Don't make Google Earth the chart; build our own seamless surface

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

The "obvious" idea: use Google Earth's gorgeous, seamless, global imagery as the chartplotter
base — curvature-of-the-earth down to a beach, no toggling. It looks like the ultimate
chartplotter and nobody ships it, which usually means there's a non-obvious reason. There is —
four, stacked from annoying to fatal.

## Decision

**Helm never uses Google (or any nav-prohibited / un-cacheable) imagery as the navigation
base.** Instead we **build our own** Google-Earth-like seamless surface from sources we are
legally allowed to cache and redistribute, and **composite the real chart's safety data on top**:

- **Cloudless Sentinel-2 (s2cloudless)** — the beautiful seamless imagery base.
- **NOAA ENC** (and other clean ENC) — the safety layer: soundings, contours, dangers, lights.
- **OpenSeaMap** — seamarks/harbours overlay.
- **Globe projection + a continuous slippy-tile pyramid** for the seamless globe→beach motion.
- Imagery is permanently labelled **supplemental**; the **ENC is the navigation authority**.

Google/Bing remain **bring-your-own / personal-use only** (see [LEGAL.md](../LEGAL.md)).

## Why "just use Google Earth" fails

1. **License.** Google Maps/Earth terms prohibit using the imagery for **navigation** and
   prohibit the **offline caching/redistribution** a chartplotter requires. You cannot ship it.
2. **Offline-first.** Boats lose signal; Google is an online-only streamed service. A nav tool
   that blanks without a cell connection is not a nav tool.
3. **Imagery is not a chart (the deep one).** A chart is a georeferenced *safety database* —
   depths, contours, rocks/wrecks, buoy & light characteristics, datum. Imagery shows only the
   surface; it cannot show what's *under* the water, can't give a light's characteristic, and
   clouds/glint/turbidity **hide** hazards (imagery can even paint a reef out). Primary nav on
   imagery is unsafe — it's missing the layer that makes a chart a chart.
4. **Datum & accuracy.** Charts are surveyed to IHO standards with known horizontal + sounding
   datum; imagery has neither a depth reference nor survey-grade accuracy for close piloting.

**It has been done — as a supplemental overlay, which is the ceiling.** GE2KAP/ChartLocker,
OpenCPN photolayer, TimeZero PhotoFusion, Orca "hybrid charts," Navionics satellite overlay all
blend imagery with charts — using **licensed** imagery and always keeping the **chart as the
authority**. Nobody makes imagery the authority, for reasons 1–3. Helm's edge is doing the
*synthesis* — our own seamless surface from legal pieces — which requires assembling the parts
yourself instead of taking Google's forbidden fruit.

## On offline size (why charts are "gigs per country")

The weight is **raster/satellite**, not chart data:

- **Raster pyramids quadruple every zoom level** (a quadtree). Coast-overview→harbour detail over
  a whole country = millions of tiles = **gigabytes**. Inherent to pixels.
- **Vector ENC is tiny** — geometry + attributes, not pixels: tens to low-hundreds of MB for a
  country's full set.

So the answer isn't to beat physics, it's to **stop downloading the country**:

- **On-demand, bbox-scoped download** — cache the passage corridor, not the nation.
- **Zoom caps** — deep zoom only for harbours/anchorages, not open water.
- **Render vector ENC to tiles on demand** (our engine) instead of shipping pre-baked raster.

See [CHART-PIPELINE.md](../CHART-PIPELINE.md).

## Consequences

- We carry the cost/complexity of assembling + hosting clean imagery + ENC ourselves (the
  on-demand tiler), rather than free-riding Google. That *is* the moat — incumbents won't.
- The product promise is honest: seamless and beautiful **and** safe + offline, with imagery as
  an aid, never the authority.
- Reinforces the license posture in root [LICENSE](../../LICENSE) / [LICENSE.BSL](../../LICENSE.BSL)
  and the depth-on-satellite work in [CHART-QUILTING.md](../CHART-QUILTING.md).
