# Helm Safety Notice

Helm is experimental pre-alpha marine navigation software. It is not a
certified navigation system, not type-approved ECDIS, not a carriage-compliant
chartplotter, and not a substitute for official charts, notices, instruments,
watchkeeping, or seamanship.

Do not rely on Helm as your primary or only source of navigation information.
Use it as a supplemental evaluation tool only, and cross-check every
navigation decision against independent sources.

## Required Short Warning

Use this short warning anywhere Helm presents navigation, chart, weather,
satellite, community, AI, routing, or advisory information:

> Supplemental aid only. Not for primary navigation. Cross-check official
> charts, notices, instruments, and conditions.

## What To Cross-Check

Before relying on any Helm display or advisory, independently verify with:

- official charts and chart updates for the waters you are navigating;
- notices to mariners, local warnings, and current publications;
- depth sounder, compass, GPS/GNSS, radar, AIS, and other onboard instruments;
- visual lookout, weather observations, sea state, and local conditions;
- prudent route planning, watchkeeping, and seamanship.

## Known Alpha Risks

Helm may be wrong, incomplete, stale, unavailable, misconfigured, or
misleading. In particular:

- charts, chart tiles, and rendered symbols may be missing, stale,
  mis-projected, incorrectly styled, or cached from an older source;
- satellite imagery can hide reefs, shoals, wrecks, clouds, breaking seas,
  surf lines, obstructions, or recent changes;
- bathymetry, soundings, contours, and satellite-derived depth layers are
  supplemental context and may not match the current bottom, tide, datum, or
  charted danger;
- weather, wind, wave, current, tide, and routing layers are forecasts or model
  products, not guarantees;
- AIS, NMEA, SignalK, GPS/GNSS, heading, speed, depth, and instrument feeds may
  be delayed, lost, spoofed, offset, duplicated, or interpreted incorrectly;
- route, track, alarm, CPA/TCPA, anchoring, pass, and arrival logic may contain
  bugs or use assumptions that do not match the vessel or the conditions;
- AI summaries, briefings, pass advisors, dossiers, and recommendations are
  advisory text only and may omit or misread important facts;
- offline caches may be incomplete, corrupted, or older than expected;
- development builds may include test data, partial features, and local
  configuration that are not suitable for underway use.

## Underway Use

During the alpha, run Helm only in parallel with a trusted primary navigation
setup. Keep independent, validated backups available before using Helm near
land, reefs, shoals, traffic, restricted waters, bad weather, night approaches,
or offshore passages.

Never let Helm replace watchkeeping, lookout, vessel handling judgment, or the
master's responsibility for safe navigation.

## Developer And Release Rules

- Keep this safety notice linked from the README, release notes, and public
  alpha material.
- Keep user-facing warnings visible on Helm screens that show supplemental
  chart, satellite, bathymetry, weather, AI, community, or routing layers.
- Do not describe Helm as certified, type-approved, ECDIS, carriage-compliant,
  or ready for primary navigation unless that has actually been achieved and
  independently verified.
- Do not publish demo screenshots, videos, releases, or forum posts that imply
  Helm can replace official charts, instruments, watchkeeping, or seamanship.

This notice is not legal advice and does not replace the license terms,
attribution requirements, or warranty disclaimers in `LICENSE`, `LICENSE.BSL`,
and `NOTICE`.
