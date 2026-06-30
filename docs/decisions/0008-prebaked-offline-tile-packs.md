# ADR-0008 — Pre-baked offline chart tile packs (offline-on-the-phone before a native renderer)

- **Status:** Proposed
- **Date:** 2026-06-25

## Context

Offline-first is a non-negotiable differentiator: true BYO/offline use, without chart-subscription
lock-in. But our chart-rendering architecture
([ADR-0006](0006-server-client-thin-display.md)) renders S-52 **on the boat server** and
ships **PNG tiles** to thin clients (`/chart/{z}/{x}/{y}.png`, per
[engine/README.md](../../engine/README.md)). That is exactly the right call — it keeps the
GPLv2 engine off the App Store binary and means no client re-implements S-52 — but it has a
hole: **the client only has charts while the server is reachable.** Off the boat, server
powered down, or no LAN → no charts on the phone.

The full fix — a **native S-52 renderer on the client** (the permissive GDAL/PROJ rebuild,
[ADR-0002](0002-enc-engine.md) Option B) — is multi-engineer-years of safety-critical work
and is deliberately held as an **insurance policy, not a committed public milestone** (see the S-57
reasoning: we designed *around* the GPL wall with the tile-server split rather than rewriting
through it). We need offline charts on the phone **without** paying for that rewrite yet.

There is a lighter step between "live tiles only" and "native renderer": **bake the tiles
once, ship the pack to the phone, display it with no live renderer.**

## Decision

Ship **pre-baked offline chart tile packs.** For a user-selected region, the server (or the
[pipeline/](../../pipeline/)) renders that region's S-52 tiles over a chosen zoom range and
palette into a single portable pack (mbtiles / PMTiles). The client downloads the pack and
displays it **offline** — same MapLibre raster path as today, just pointed at a **local pack**
instead of the live `/chart/{z}/{x}/{y}.png` URL. No live renderer on the client, no server
connection required for a downloaded region.

This is the **limited-but-ships-now** offline path. It covers "offline on the phone for the
areas I downloaded" and **defers** (does not replace) the native-renderer rewrite.

## How it works

Reuses what already exists; the only genuinely new pieces are the batch bake and the
client-side pack mount + "download region" UX.

1. **Select** — user lassoes a bbox + picks a zoom range (`z_min..z_max`) and a palette.
2. **Bake** — drive the existing `helm-tiles` S-52 render path
   ([engine/vendor/cli/](../../engine/vendor/cli/)) over the region's XYZ pyramid (batch
   instead of on-demand) and write each PNG into a pack. The pipeline already lassoes a bbox →
   XYZ → mbtiles for raster basemaps (`pipeline/fetch_tiles.py`); this is the same loop with
   the S-52 tile source.
3. **Stamp** — the pack carries its **chart edition(s), render date, palette, and z-range** as
   metadata (load-bearing for safety — see below).
4. **Download** — client pulls the pack over the LAN from the server (or sideloads it).
5. **Display** — client mounts the pack as a **local raster source** (MapLibre reads
   mbtiles/PMTiles directly, web *and* native), so charts render with zero network.

## Scope

**In:**
- Download a region; display its charts fully offline.
- Pixel-identical to live tiles (it *is* the same renderer's output, just pre-rendered).
- Composes with other offline layers if they're packed too (satellite basemap, depth GeoJSON,
  places, weather JSON) — the natural extension is a single **"region bundle"** = charts +
  basemap + depth + places for one area.
- Pack management on the client (list / size / delete downloaded regions).

**Out (explicit limitations — this is a snapshot, not a live renderer):**
- **Fixed palette.** Day/Dusk/Night is baked at render time. Switching palette offline needs a
  **separate pack per palette** (3× storage) or accepting one. No on-the-fly re-render.
- **Fixed zoom range.** You get `z_min..z_max`; panning past the edge or zooming past `z_max`
  shows no detail. Deeper packs are exponentially larger (~4× per zoom level).
- **No live S-52 interactivity.** No cursor-pick object query (that needs the live
  `s57chart`), no dynamic SCAMIN/declutter changes, no on-the-fly safety-contour change. The
  pack is a rendered image, not a queryable chart.
- **Staleness.** A pack is a point-in-time render of a chart *edition*. Notices to Mariners /
  new ENC editions require a **re-bake**; the pack does not self-update.

## Safety (this is a navigation tool)

Per the production quality bar — truthful signals, never silently degrade:
- Every pack **must** stamp chart edition + render date + palette + z-range, and the UI **must
  warn** when a pack is stale (newer edition exists) or when the user has panned/zoomed
  **outside the pack's coverage**. Never present blank or stale chart area as if it were live.
- The existing satellite "supplemental, not for primary nav" disclaimer posture applies; an
  offline pack is *more* prone to staleness than live tiles, so the staleness signal is
  mandatory, not optional.

## Relationship to other decisions

- **Defers [ADR-0002](0002-enc-engine.md) Option B** (native S-52 renderer). This buys offline
  charts on the phone without the rewrite; the rewrite stays an insurance policy.
- **Complements [ADR-0006](0006-server-client-thin-display.md).** Identical tile contract; the
  client just swaps the live source for a local one. The boat server remains the renderer of
  record (live tiles when connected, baked packs when not).
- **Extends the on-demand pipeline** (mbtiles → offline) from raster basemaps to S-52
  charts.

## Open questions

- **Pack format** — PMTiles (single file, range-request friendly, ideal for a client) vs.
  mbtiles (what the pipeline emits today). Lean PMTiles for the client, keep mbtiles as the
  bake intermediate.
- **Palette policy** — one baked palette, or per-palette packs? (Storage vs. Night-mode
  fidelity offline.)
- **Sizing & budget** — show the user an estimated pack size **before** download (tiles grow
  ~4× per zoom level over the bbox); set sane default z-ranges per use (overview vs.
  harbor-approach).
- **Update / refresh** — edition-stamp diffing → re-bake; can we ship delta updates rather than
  full re-downloads?
- **Bundle composition** — does v1 ship charts-only, or the full region bundle (charts +
  satellite + depth + places) in one download?
- **Where the bake runs** — on the boat server on demand, or pre-built region packs distributed
  centrally (the latter has cartography-licensing implications for non-NOAA sources).

## Why this, now

It directly serves the MVP success criterion — *sail a real passage on Helm alone, offline* —
and it is **mostly wiring on top of proven parts** (the S-52 render path, the bbox→pyramid
tiler, MapLibre's native pack reading). Low research risk, high product value, and it lets us
ship credible offline charts on the phone **without** committing to the renderer rewrite.
