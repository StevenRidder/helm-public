#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Helm -- fetch_places.py
============================================================================
Stdlib-only fetcher for the "Places" overlay. Queries the OpenStreetMap
Overpass API for the region bbox and writes web/data/places.geojson: a
FeatureCollection of Point features tagged by `kind`:

    marina        leisure=marina
    anchorage     seamark:type=anchorage  (or natural anchorages)
    fuel          waterway=fuel / amenity=fuel near water
    dinghy        seamark:small_craft_facility=dinghy / mooring dinghy docks
    water         amenity=drinking_water
    chandlery     shop=chandlery

One polite Overpass QL request by bbox. Nodes are used directly; ways and
relations use their `center` (Overpass `out center`) as the point geometry.

Data (c) OpenStreetMap contributors, ODbL 1.0. The attribution string is
embedded in the output and printed to stderr.

Usage:
    python3 pipeline/fetch_places.py
    python3 pipeline/fetch_places.py --bbox -81.86,24.44,-81.68,24.60
    python3 pipeline/fetch_places.py --out web/data/places.geojson

No third-party dependencies. Fails loudly and clearly (no silent fallback) so
a broken fetch is never mistaken for "no places here".
============================================================================
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# --- Defaults: Key West region (W,S,E,N) -----------------------------------
DEFAULT_BBOX = (-81.86, 24.44, -81.68, 24.60)

# Public Overpass endpoints (tried in order on transient failure).
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

USER_AGENT = (
    "Helm-Chartplotter/0.1 (marine chartplotter prototype; "
    "contact: helm@example.com)"
)

ATTRIBUTION = "(c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)"

# --- Where this file lives, so paths resolve regardless of cwd -------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
DEFAULT_OUT = os.path.join(_REPO, "web", "data", "places.geojson")


def build_query(bbox):
    """Build one Overpass QL query for the bbox (S,W,N,E order for Overpass)."""
    w, s, e, n = bbox
    b = "{s},{w},{n},{e}".format(s=s, w=w, n=n, e=e)
    # nwr = node + way + relation. `out center` gives ways/relations a
    # representative point so we can treat everything uniformly.
    return """
[out:json][timeout:60];
(
  nwr["leisure"="marina"]({b});
  nwr["seamark:type"="harbour"]["seamark:harbour:category"="marina"]({b});
  nwr["seamark:type"="anchorage"]({b});
  nwr["natural"="bay"]["seamark:type"="anchorage"]({b});
  nwr["waterway"="fuel"]({b});
  nwr["amenity"="fuel"]["fuel:diesel"]({b});
  nwr["seamark:small_craft_facility:category"~"dinghy"]({b});
  nwr["mooring"="dinghy"]({b});
  nwr["amenity"="drinking_water"]({b});
  nwr["shop"="chandlery"]({b});
  nwr["shop"="boat"]["chandlery"="yes"]({b});
);
out center tags;
""".strip().replace("{b}", b)


# --- Classification: map raw OSM tags -> a single Helm `kind` ---------------
def classify(tags):
    """Return the Helm kind for an element, or None to skip it."""
    if not tags:
        return None

    leisure = tags.get("leisure")
    seamark = tags.get("seamark:type")
    waterway = tags.get("waterway")
    amenity = tags.get("amenity")
    shop = tags.get("shop")
    mooring = tags.get("mooring")
    scf = tags.get("seamark:small_craft_facility:category", "")

    # Order matters: most-specific wins.
    if leisure == "marina":
        return "marina"
    if seamark == "harbour" and tags.get("seamark:harbour:category") == "marina":
        return "marina"
    if seamark == "anchorage":
        return "anchorage"
    if waterway == "fuel":
        return "fuel"
    if amenity == "fuel" and ("fuel:diesel" in tags or "seamark:type" in tags):
        # an amenity=fuel that also carries marine/diesel tags = marine fuel
        return "fuel"
    if "dinghy" in scf or mooring == "dinghy":
        return "dinghy"
    if amenity == "drinking_water":
        return "water"
    if shop == "chandlery":
        return "chandlery"
    if shop == "boat" and tags.get("chandlery") == "yes":
        return "chandlery"
    return None


def element_point(el):
    """Return (lon, lat) for a node/way/relation, or None if unavailable."""
    if el.get("type") == "node":
        if "lon" in el and "lat" in el:
            return (el["lon"], el["lat"])
        return None
    # way / relation -> Overpass `out center`
    c = el.get("center")
    if c and "lon" in c and "lat" in c:
        return (c["lon"], c["lat"])
    return None


def round6(x):
    """Trim coordinate precision to ~0.1 m -- plenty for a chartplotter."""
    return round(float(x), 6)


def fetch(query, endpoints, retries=2, timeout=90):
    """POST the query to Overpass; return parsed JSON. Raises on total failure."""
    body = ("data=" + urllib.parse.quote(query)).encode("utf-8")
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    last_err = None
    for endpoint in endpoints:
        for attempt in range(retries + 1):
            try:
                req = urllib.request.Request(
                    endpoint, data=body, headers=headers, method="POST"
                )
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                last_err = exc
                # 429/504 = busy; back off politely before retrying.
                wait = 5 * (attempt + 1)
                sys.stderr.write(
                    "[places] {ep} attempt {a} failed ({err}); "
                    "waiting {w}s\n".format(
                        ep=endpoint, a=attempt + 1, err=exc, w=wait
                    )
                )
                time.sleep(wait)
            except json.JSONDecodeError as exc:
                last_err = exc
                sys.stderr.write(
                    "[places] {ep} returned non-JSON: {err}\n".format(
                        ep=endpoint, err=exc
                    )
                )
                break  # bad response from this endpoint; try the next one
    raise RuntimeError(
        "Overpass fetch failed on all endpoints: {err}".format(err=last_err)
    )


def to_geojson(elements, bbox):
    """Convert Overpass elements -> a Helm places FeatureCollection."""
    features = []
    seen = set()  # de-dup co-located points of the same kind
    counts = {}
    for el in elements:
        tags = el.get("tags") or {}
        kind = classify(tags)
        if kind is None:
            continue
        pt = element_point(el)
        if pt is None:
            continue
        lon, lat = round6(pt[0]), round6(pt[1])
        key = (kind, lon, lat)
        if key in seen:
            continue
        seen.add(key)

        name = (
            tags.get("name")
            or tags.get("seamark:name")
            or tags.get("ref")
            or ""
        ).strip()

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "kind": kind,
                    "name": name,
                    # keep the source id so features are stable across refetches
                    "osm": "{t}/{i}".format(t=el.get("type"), i=el.get("id")),
                },
            }
        )
        counts[kind] = counts.get(kind, 0) + 1

    w, s, e, n = bbox
    return {
        "type": "FeatureCollection",
        "attribution": ATTRIBUTION,
        "license": "ODbL-1.0",
        "bbox": [w, s, e, n],
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "features": features,
    }, counts


def parse_bbox(text):
    parts = [float(p) for p in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be W,S,E,N")
    return tuple(parts)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fetch Helm Places overlay from OSM/Overpass.")
    ap.add_argument(
        "--bbox",
        type=parse_bbox,
        default=DEFAULT_BBOX,
        help="W,S,E,N (default: Key West)",
    )
    ap.add_argument("--out", default=DEFAULT_OUT, help="output geojson path")
    ap.add_argument(
        "--endpoint",
        action="append",
        help="override Overpass endpoint (repeatable)",
    )
    args = ap.parse_args(argv)

    endpoints = args.endpoint or OVERPASS_ENDPOINTS
    query = build_query(args.bbox)

    sys.stderr.write("[places] querying Overpass for bbox %s\n" % (args.bbox,))
    data = fetch(query, endpoints)
    elements = data.get("elements", [])
    sys.stderr.write("[places] %d raw elements\n" % len(elements))

    fc, counts = to_geojson(elements, args.bbox)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    summary = ", ".join("%s=%d" % (k, counts[k]) for k in sorted(counts)) or "none"
    sys.stderr.write(
        "[places] wrote %d features -> %s (%s)\n"
        % (len(fc["features"]), args.out, summary)
    )
    sys.stderr.write("[places] %s\n" % ATTRIBUTION)
    return 0


if __name__ == "__main__":
    sys.exit(main())