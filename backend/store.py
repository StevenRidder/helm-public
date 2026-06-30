"""
Helm backend — place store + owned data.

The candidate store for the "where to go" recommender and the Places overlay. Every record
carries a `source` tag (osm | openseamap | owned | nfl) so the recommender is source-agnostic
and NFL is just-another-source (the slot stays open). For the prototype this is a seeded
in-memory store + a JSON file for owned pins/reviews; production swaps in a real DB and the
live OSM/OpenSeaMap ingest (extend pipeline/fetch_places.py).

Seed places sit around Key West (the live prototype's map center) so they line up with the
chart on screen.
"""
import json
import os
import math
import time

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OWNED_FILE = os.path.join(DATA_DIR, "owned.json")

# --- seed: source-tagged places near Key West (lon, lat) ---------------------------------
# shelterDirs = wind directions the spot is sheltered FROM (good in these winds).
SEED_PLACES = [
    {
        "id": "osm-kw-bight", "source": "osm", "kind": "marina",
        "name": "Key West Bight / Historic Seaport", "lat": 24.5612, "lon": -81.8045,
        "attrs": {"depth": 3.0, "holding": None, "shelterDirs": ["N", "NE", "E"],
                  "services": ["water", "fuel", "provisions", "repairs"]},
    },
    {
        "id": "osm-kw-garrison", "source": "openseamap", "kind": "anchorage",
        "name": "Garrison Bight anchorage", "lat": 24.5685, "lon": -81.7905,
        "attrs": {"depth": 2.4, "holding": "good — mud", "shelterDirs": ["N", "NW", "NE"],
                  "services": ["dinghy", "water"]},
    },
    {
        "id": "osm-kw-fleming", "source": "osm", "kind": "fuel",
        "name": "Fuel dock — Conch Harbor", "lat": 24.5628, "lon": -81.8011,
        "attrs": {"depth": 3.5, "shelterDirs": ["N", "NE"], "services": ["fuel", "water"]},
    },
    {
        "id": "osm-stock-island", "source": "osm", "kind": "marina",
        "name": "Stock Island Marina Village", "lat": 24.5705, "lon": -81.7378,
        "attrs": {"depth": 4.0, "shelterDirs": ["S", "SW", "W", "N"],
                  "services": ["fuel", "water", "provisions", "repairs", "haulout"]},
    },
    {
        "id": "owned-boca-chica", "source": "owned", "kind": "anchorage",
        "name": "Boca Chica Basin", "lat": 24.5772, "lon": -81.6960,
        "attrs": {"depth": 3.2, "holding": "good — sand/mud", "shelterDirs": ["E", "SE", "S"],
                  "services": []},
    },
    {
        "id": "osm-sand-key", "source": "openseamap", "kind": "anchorage",
        "name": "Sand Key (day stop)", "lat": 24.4548, "lon": -81.8772,
        "attrs": {"depth": 4.5, "holding": "fair — sand, exposed", "shelterDirs": [],
                  "services": []},
    },
]

# seed reviews (owned + cited examples) keyed by place id
SEED_REVIEWS = [
    {"id": "r1", "placeId": "osm-kw-garrison", "source": "owned", "author": "SV Halcyon",
     "boat": "Catalina 36", "text": "Held well in a 25 kt norther. Dinghy dock a short row.",
     "ratings": {"holding": 5}, "url": None, "createdAt": "2026-03-02"},
    {"id": "r2", "placeId": "owned-boca-chica", "source": "owned", "author": "SV Pelagia",
     "boat": "Outremer 45", "text": "Quiet in an easterly, good sand holding. Watch the shoal on entry.",
     "ratings": {"holding": 4}, "url": None, "createdAt": "2026-02-18"},
    {"id": "r3", "placeId": "osm-stock-island", "source": "rag", "author": "s/v Totem (blog)",
     "boat": None, "text": "Best all-round shelter near Key West; full services, easy provisioning.",
     "ratings": {}, "url": "https://www.sailingtotem.com", "createdAt": "2025-12-10"},
]


# seed AIS targets near Key West (the engine provides real decode + CPA/TCPA; this is sample)
SEED_AIS = [
    {"mmsi": 367001230, "name": "Conch Express", "lat": 24.553, "lon": -81.782, "sog": 7.2, "cog": 95, "kind": "ferry"},
    {"mmsi": 338111222, "name": "SV Tradewind", "lat": 24.579, "lon": -81.808, "sog": 5.1, "cog": 300, "kind": "sailing"},
    {"mmsi": 367554000, "name": "Tug Resolve", "lat": 24.501, "lon": -81.752, "sog": 3.4, "cog": 270, "kind": "tug"},
]


def ais_near(lat, lon, radius_nm=8):
    out = []
    for a in SEED_AIS:
        d = haversine_nm(lat, lon, a["lat"], a["lon"])
        if d <= radius_nm:
            out.append({**{k: a[k] for k in ("mmsi", "name", "sog", "cog", "kind")}, "rangeNm": round(d, 1)})
    out.sort(key=lambda x: x["rangeNm"])
    return out


def nearest_charted_depth(lat, lon):
    """Nearest charted feature carrying a depth, as a proxy until the S-52 engine depth probe."""
    best = None
    for p in SEED_PLACES:
        dep = (p.get("attrs") or {}).get("depth")
        if dep is None:
            continue
        d = haversine_nm(lat, lon, p["lat"], p["lon"])
        if best is None or d < best[0]:
            best = (d, dep, p["name"])
    return best


def _load_owned():
    try:
        with open(OWNED_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"saved": [], "reviews": []}


def _save_owned(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OWNED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065  # nautical miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def all_places(sources=None):
    """Seed places + owned saved pins, optionally filtered to a set of sources."""
    owned = _load_owned()
    places = list(SEED_PLACES)
    for s in owned["saved"]:
        places.append({
            "id": s["id"], "source": "owned", "kind": s.get("category", "pin"),
            "name": s["title"], "lat": s["lat"], "lon": s["lon"],
            "attrs": {"note": s.get("note"), "sourceUrl": s.get("sourceUrl")},
        })
    if sources:
        places = [p for p in places if p["source"] in sources]
    return places


def reviews_for(place_id):
    owned = _load_owned()
    return [r for r in SEED_REVIEWS + owned["reviews"] if r["placeId"] == place_id]


def add_saved(pin):
    owned = _load_owned()
    pin["id"] = pin.get("id") or f"saved-{int(time.time()*1000)}"
    pin["createdAt"] = pin.get("createdAt") or time.strftime("%Y-%m-%d")
    owned["saved"].append(pin)
    _save_owned(owned)
    return pin


def list_saved():
    return _load_owned()["saved"]


def add_review(review):
    owned = _load_owned()
    review["id"] = review.get("id") or f"rev-{int(time.time()*1000)}"
    review["createdAt"] = review.get("createdAt") or time.strftime("%Y-%m-%d")
    review["source"] = "owned"
    owned["reviews"].append(review)
    _save_owned(owned)
    return review


def to_feature_collection(places):
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                "properties": {
                    "id": p["id"], "source": p["source"], "kind": p["kind"],
                    "name": p["name"], **{k: v for k, v in p.get("attrs", {}).items()
                                          if isinstance(v, (str, int, float))},
                },
            }
            for p in places
        ],
        "attribution": "OSM/OpenSeaMap (ODbL) + Helm community (owned)",
    }
