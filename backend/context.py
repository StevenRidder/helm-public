"""
Helm backend — the spacetime context resolver (the "mash").

This is the keystone: given a point in SPACE and TIME (lat, lon, t), fan out across every
data layer and return ONE unified, source-tagged context object — weather valid at t,
climate, nearby places + reviews, owned saved pins, the NFL slot, chart/depth pointers, AIS.
The ReAct narrator (agents.ResearchAgent.narrate_context) then speaks it in plain language
with citations.

So "tap a point, scrub a time → it narrates the weather, climate, community, etc." becomes a
single call. Every layer is tagged with its source and the NFL layer is explicitly locked
unless experimental/partnership — honesty preserved end to end.
"""
import store
from guardrails import build_guardrail_report
from probe_contract import sample_metadata
from probe_layers import build_default_registry


PROBES = build_default_registry()


def resolve_context(lat, lon, t=None, boat=None, radius_nm=15, nfl_enabled=False, layers=None):
    """Fuse the enabled layers at (lat, lon, t) into one source-tagged slice.
    `layers` (list of keys) filters which layers participate — the selectable layer toggles
    drive the slice (ADR-0007). None = all layers."""
    want = set(layers) if layers else None
    def on(key):
        return want is None or key in want

    L, sources = {}, []

    if on("weather"):
        sample = PROBES.sample("weather", lat, lon, t)
        L["weather"] = dict(sample["value"], sample=sample_metadata(sample))
        wx_time = sample.get("validTime")
        sources.append({"title": "Open-Meteo", "url": "https://open-meteo.com", "kind": "open"})
    else:
        wx_time = None

    if on("places") or on("saved"):
        nearby, saved_near = [], []
        for p in store.all_places():
            d = store.haversine_nm(lat, lon, p["lat"], p["lon"])
            if d <= radius_nm:
                entry = {"id": p["id"], "name": p["name"], "source": p["source"], "kind": p["kind"],
                         "distanceNm": round(d, 1),
                         "reviews": [{"text": r["text"], "author": r["author"], "url": r.get("url")}
                                     for r in store.reviews_for(p["id"])[:2]]}
                if p["source"] == "owned":
                    saved_near.append(entry)
                nearby.append(entry)
        nearby.sort(key=lambda x: x["distanceNm"])
        if on("places"):
            L["places"] = nearby[:6]
            for p in nearby[:6]:
                sources.append({"title": p["name"], "kind": p["source"]})
                for r in p["reviews"]:
                    if r.get("url"):
                        sources.append({"title": r["author"], "url": r["url"], "kind": "rag"})
        if on("saved"):
            L["saved"] = saved_near

    if on("climate"):
        sample = PROBES.sample("climate", lat, lon, t)
        L["climate"] = dict(sample["value"], sample=sample_metadata(sample))
        sources.append(L["climate"]["source"])

    if on("nfl"):
        L["nfl"] = ({"available": False, "locked": True,
                     "reason": "NoForeignLand read is experimental / partnership-gated"}
                    if not nfl_enabled else
                    {"available": True, "locked": False, "note": "NFL enrichment active"})

    if on("depth"):
        sample = PROBES.sample("depth", lat, lon, t)
        L["depth"] = dict(sample["value"], sample=sample_metadata(sample))

    if on("ais"):
        sample = PROBES.sample("ais", lat, lon, t)
        L["ais"] = dict(sample["value"], sample=sample_metadata(sample))

    if on("tides"):
        sample = PROBES.sample("tides", lat, lon, t)
        L["tides"] = {"sample": sample_metadata(sample), "note": sample.get("note")}

    if on("chart"):
        L["chart"] = {"note": "Cross-reference the S-52 chart for depth, contours and hazards here.",
                      "source": {"title": "NOAA ENC (S-52)", "kind": "open"}}

    ctx = {
        "point": {"lat": lat, "lon": lon, "t": t, "weatherValidAt": wx_time},
        "layers": L,
        "boat": boat,
        "enabledLayers": sorted(L.keys()),
        "sources": sources,
        "disclaimer": "Fused from layered, cited sources. Supplemental — verify on official charts.",
    }
    ctx["guardrails"] = build_guardrail_report("context", contexts=[ctx])
    return ctx
