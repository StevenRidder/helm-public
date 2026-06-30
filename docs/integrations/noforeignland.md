# Integration scope — NoForeignLand (and the community-places overlay)

> Goal: bring NoForeignLand-style **places/anchorages/services + boats** into Helm as a
> toggleable overlay. This doc scopes what's actually possible after reading NFL's docs,
> and recommends the shippable path.

## TL;DR

- **NoForeignLand has no public *read* API.** There is no developer portal and no
  documented endpoint to pull places or boats.
- The "**NFL API key**" is a **per-boat tracking key** (Account → Settings → Boat tracking
  → API Key). Every documented integration is **push-only** — data flows *into* NFL.
- So showing NFL data *inside* Helm requires either a **partnership** (clean) or
  **reverse-engineering their internal map backend** (fragile, ToS-risky, personal-only —
  it's what broke the community app when NFL changed their structure).
- **Recommendation:** build the Places overlay from **open data (OpenStreetMap/Overpass +
  OpenSeaMap)** — it covers ~80% of NFL's value, is legal, and works offline — and use NFL
  only for **push** (your boat appears for friends), plus an optional **personal-use pull**
  behind an experimental flag. Pursue an NFL **partnership** separately if/when commercial.

## What NFL is, and why we'd want it

[NoForeignLand](https://www.noforeignland.com) is a free, crowd-sourced cruising community:
anchorages, marinas, dinghy docks, fuel, services — with photos and reviews — plus live
boat tracking and social features. The crowdsourced place database is genuinely valuable
and is **their moat** (they fundraise to keep it free, which signals they guard
redistribution).

## API reality (from their docs)

Source: NFL [help — track using an external provider](https://www.noforeignland.com/help/tracking/track-using-external-providers),
the [signalk-to-nfl](https://github.com/amirlanesman/signalk-to-nfl) plugin, and the now-broken
[oleedv/Noforeignland](https://github.com/oleedv/Noforeignland) reader.

- **No documented REST API** for reading places/boats. No self-service developer portal.
- **Inbound (push) integrations only**, all flowing *to* NFL:
  - Email position: `LAT|50|39.732|N LON|1|35.514|W` from an authorized sender address.
  - Garmin inReach (KML feed URL), Iridium/SPOT (email), YB Tracking (JSON feed URL),
    Advanced Tracking/Konectis (proprietary keys), and the open-source **Signal K plugin**.
  - The per-boat **NFL API key** authorizes pushing *your* position/track.
- **Pulling** places/boats was done by community apps hitting NFL's **internal map backend**
  (the same XHR/JSON the web map uses, queried by bounding box). It is undocumented and
  unauthenticated-ish — and **broke when NFL changed their API structure**. Not sanctioned.

## The options

### Option A — Official partnership (clean; for a shipped product)
Approach NFL for a data-sharing agreement to read places (and optionally boats). Clean,
durable, cacheable. Given their non-commercial ethos they may permit non-commercial use;
commercial use needs explicit terms. **Status: requires outreach — not self-serve.**

### Option B — Push integration (build regardless; officially supported)
Helm sends the user's *own* position/track to NFL using the user's NFL boat API key.
Direction is Helm → NFL (your boat shows up for friends). It does **not** bring NFL data in,
but it's the sanctioned interop and it's easy.
- UX: Settings → "Share my position to NoForeignLand" → paste NFL boat API key.
- Behavior: post position on NFL's expected cadence; queue while offline, flush on
  reconnect. No credential storage beyond the user's own key, device-local.

### Option C — Unofficial internal-API pull (PERSONAL build only)
Reverse-engineer the JSON the NFL web map fetches by bbox and render it as an overlay
(the oleedv approach).
- **Reality:** undocumented, **fragile** (will break on their changes), and **against their
  ToS / data posture**. **Must NOT ship in a distributed or commercial product.**
- Acceptable only for a personal build, behind an **"experimental · personal use ·
  may break"** flag, with aggressive client-side caching and gentle rate-limiting so we
  never hammer their backend. Best-effort, expect breakage.

### Option D — Open substitute (RECOMMENDED for the actual overlay)
Most of NFL's place value is in **open data** we can pull, cache offline, and redistribute:
- **OpenStreetMap via the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)** —
  `leisure=marina`, `seamark:type=anchorage`, `waterway=fuel`, dinghy docks, chandleries,
  `amenity=*` services. Query by bbox → GeoJSON.
- **OpenSeaMap** — seamarks, harbours (ODbL).
- **Helm's own user pins/reviews** — stored in *our* backend, so we own that data and it
  becomes a Helm community asset over time.

This is legal, offline-capable, and free of NFL's fragility.

## Recommended architecture — the "Places" overlay

A toggleable **Places** layer in the layer stack, backed by a pluggable source list:

```
Places overlay (toggle)
  ├─ OpenStreetMap / Overpass   (open, primary — marinas/fuel/docks/services)
  ├─ OpenSeaMap seamarks        (open — harbours/anchorage marks)
  ├─ Helm user pins + reviews   (our backend — owned community data)
  ├─ NoForeignLand  ── push (official)  +  pull (partnership, or personal experimental)
  └─ [future] Navily / Waterway Guide  (partnership only)
```

- **Fetch:** Overpass query by the visible bbox → GeoJSON; cache to disk **alongside the
  region's chart mbtiles** so the Places layer is available offline like everything else.
- **Render:** a MapLibre symbol layer, icons by amenity type (anchor, marina, fuel, dinghy,
  laundry, chandlery); cluster at low zoom.
- **Detail card:** tap a pin → name, type, depth/holding (if tagged), photos, reviews,
  "navigate here." Reviews come from Helm's own pins (and NFL only under Option A/C).
- **Contribute:** add/edit a pin → writes to Helm's backend; optionally mirror the user's
  *track* to NFL via Option B.

## Driving the LLM "where to go" + giving back (the two directions)

The two flows are **not symmetric**: giving back is easy and sanctioned; reading in is walled
and must be **gated as experimental**.

### Reading in → the "where to go" recommender (NFL read = EXPERIMENTAL)

The recommender runs over a **source-agnostic, provenance-tagged place graph** so it is
strong on *allowed* data alone and only *enriched* by NFL where access exists:

- **Load-bearing (shippable):** open (OSM/OpenSeaMap) + owned (Helm pins/reviews) + cited RAG
  (Noonsite/blogs/forums). The LLM ranks candidates and **explains why, with citations and
  confidence** — this works with **zero NFL dependency**.
- **NFL as enrichment only:**
  - **Partnership (Option A)** — the clean, shippable way to read NFL places/boats.
  - **Personal-experimental pull (Option C)** — lives behind an **Experimental Features**
    flag: `personal · unofficial · may break · not in shared/commercial builds`. Cached hard,
    rate-limited, best-effort. Feeds only a personal recommender; never ships.
  - **NFL public-page RAG** is **partnership-preferred**, not a backdoor (NFL guards
    redistribution); prefer Noonsite/blogs for RAG.
- **Honesty:** every recommendation tags its sources; NFL-sourced enrichment is labelled, and
  when NFL read is off the card shows a *locked* "+N NoForeignLand reviews — partnership /
  experimental" affordance rather than silently omitting it.

### Giving back → sanctioned now, and it's the leverage

- **NFL push (Option B):** mirror the user's own track/position to NFL via their own boat key
  (the signalk-to-nfl pattern). Stable, build now.
- **Give back to the open commons:** let users push opted-in anchorage corrections/POIs back
  to **OpenStreetMap / OpenSeaMap** — legal, universal, improves the data for everyone
  (including NFL indirectly). A more durable contribution than feeding one walled garden.
- **The leverage:** giving back is what earns reading in. Pitch NFL **reciprocity** — "Helm
  sends you opted-in active-cruiser tracks (and contributions); in return, non-commercial
  read access to render your places, attributed" — far more appealing to their non-commercial
  ethos than a pure take.

## Legal / ToS posture

- **NFL pull:** partnership (Option A) or personal-experimental (Option C) only —
  **never scrape in a distributed product.** See [ADR-0005](../decisions/0005-community-places-overlay.md).
- **NFL push:** fine — user's own key + own position, device-local.
- **OpenStreetMap / Overpass:** ODbL — attribution required; **don't hammer public Overpass**
  (cache hard; self-host or use a paid mirror at scale).
- **OpenSeaMap:** ODbL — attribution + share-alike.
- **SeaPeople:** consumer app, **no public API** — not integrable. Walled.
- **ActiveCaptain** (Garmin): the other big anchorage DB — now walled behind Garmin. Partnership only.

## Decision

Build Option D (open) as the Places overlay + Option B (NFL push) now; keep Option C behind
a personal-use flag; pursue Option A (partnership) only if commercializing. Recorded in
[ADR-0005](../decisions/0005-community-places-overlay.md).

The **"where to go" recommender** runs on open + owned + RAG (no NFL dependency); **NFL read
is enrichment only, gated under Experimental Features** (personal/unofficial/may-break) or a
partnership. **Give-back** (NFL push + opt-in OSM/OpenSeaMap contribution) ships now and is
the **reciprocity leverage** for a partnership. The UI wireframe is kept with private design files.
