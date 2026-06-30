"""
Helm backend — FastAPI app (prototype).

The small service the static web app + C++ engine don't provide: the place store, owned
pins/reviews, the "where to go" recommender, and the give-back publishers. Source-agnostic,
offline-first, NFL-slot-open. Run:

    cd backend && pip install -r requirements.txt && cp .env.example .env
    uvicorn main:app --reload --port 8090

The web prototype (web/community.js) auto-detects this at http://127.0.0.1:8090 and falls
back to local sample data when it's not running — so the chart never breaks.
"""
import os
from typing import List, Optional   # explicit (not PEP 604 `|`) so this runs on Python 3.9+ too

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass

import store
from llm import LLMClient, prefilter
from publisher import NFLPublisher, OSMNotes
from agents import ResearchAgent, get_weather
from context import resolve_context
from guardrails import attach_guardrails

app = FastAPI(title="Helm backend", version="0.1")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

llm = LLMClient()
agent = ResearchAgent(llm)
nfl = NFLPublisher()
osm = OSMNotes()


# ---- models ----
class SavedPin(BaseModel):
    title: str
    category: str = "pin"
    lat: float
    lon: float
    note: Optional[str] = None
    sourceUrl: Optional[str] = None
    collectionId: Optional[str] = None


class Review(BaseModel):
    placeId: str
    author: str
    text: str
    boat: Optional[str] = None
    ratings: dict = {}
    url: Optional[str] = None


class WhereTo(BaseModel):
    query: str = "Where should I go?"
    position: Optional[dict] = None           # {lat, lon}
    boat: Optional[dict] = None               # {draft, airDraft}
    forecast: Optional[dict] = None           # {windFromDeg, windKt}
    sources: Optional[List[str]] = None       # restrict candidate sources
    top: int = 3


class PushPos(BaseModel):
    lat: float
    lon: float
    sog: Optional[float] = None
    cog: Optional[float] = None


class NoteReq(BaseModel):
    lat: float
    lon: float
    text: str


# ---- endpoints ----
@app.get("/health")
def health():
    return {"ok": True, "llm": llm.provider, "model": llm.model if llm.provider == "openai" else None,
            "nfl": nfl.status(), "osm": osm.status()}


@app.get("/places")
def places(sources: Optional[str] = None):
    src = sources.split(",") if sources else None
    return store.to_feature_collection(store.all_places(src))


@app.get("/saved")
def saved():
    pins = store.list_saved()
    return store.to_feature_collection([
        {"id": p["id"], "source": "owned", "kind": p.get("category", "pin"),
         "name": p["title"], "lat": p["lat"], "lon": p["lon"],
         "attrs": {"note": p.get("note"), "sourceUrl": p.get("sourceUrl")}}
        for p in pins
    ])


@app.post("/saved")
def add_saved(pin: SavedPin):
    return store.add_saved(pin.model_dump())


@app.post("/reviews")
def add_review(r: Review):
    return store.add_review(r.model_dump())


@app.post("/whereto")
def whereto(req: WhereTo):
    cands = prefilter(store.all_places(req.sources), req.position, req.boat, req.forecast)
    recs = llm.rank(req.query, cands, req.position, req.boat, req.forecast, top=req.top)
    # GeoJSON of the recommended places, for the map highlight layer
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["place"]["lon"], r["place"]["lat"]]},
         "properties": {"id": r["place"]["id"], "name": r["place"]["name"], "rank": i + 1,
                        "confidence": r["confidence"]}}
        for i, r in enumerate(recs)]}
    out = {"query": req.query, "provider": llm.provider, "recommendations": recs, "geojson": fc}
    return attach_guardrails(out, "whereto", recommendations=recs)


@app.post("/giveback/nfl/push")
def nfl_push(pos: PushPos):
    return nfl.push(pos.lat, pos.lon, pos.sog, pos.cog)


@app.post("/giveback/osm-note")
def osm_note(req: NoteReq):
    return osm.create_note(req.lat, req.lon, req.text)


@app.get("/giveback/status")
def giveback_status():
    return {"nfl": nfl.status(), "osm": osm.status()}


@app.get("/weather")
def weather(lat: float, lon: float):
    """Real forecast at a point (Open-Meteo) — the agent's weather tool, exposed directly."""
    return get_weather(lat, lon)


class NarrateReq(BaseModel):
    lat: float
    lon: float
    t: Optional[str] = None                   # ISO time on the passage timeline
    boat: Optional[dict] = None
    nflEnabled: bool = False                  # experimental NFL read toggle
    layers: Optional[List[str]] = None        # selectable layers drive the slice (ADR-0007)


class BriefingReq(BaseModel):
    points: List[dict]                        # ordered [{lat, lon, t}] along the path P(t)
    boat: Optional[dict] = None
    layers: Optional[List[str]] = None
    nflEnabled: bool = False


@app.post("/context")
def context(req: NarrateReq):
    """The spacetime mash: fuse the enabled layers at (lat, lon, t) into one source-tagged object."""
    return resolve_context(req.lat, req.lon, req.t, req.boat, nfl_enabled=req.nflEnabled, layers=req.layers)


@app.post("/narrate")
def narrate(req: NarrateReq):
    """Keystone: pick a point in space + time -> the agent narrates the fused layers, cited."""
    ctx = resolve_context(req.lat, req.lon, req.t, req.boat, nfl_enabled=req.nflEnabled, layers=req.layers)
    out = agent.narrate_context(ctx)
    out["point"] = ctx["point"]
    out["layers"] = ctx["layers"]
    return out


@app.post("/briefing")
def briefing(req: BriefingReq):
    """Probe along a path P(t): resolve a slice at each point, narrate the passage."""
    slices = [resolve_context(p["lat"], p["lon"], p.get("t"), req.boat,
                              nfl_enabled=req.nflEnabled, layers=req.layers)
              for p in req.points[:8]]
    return agent.narrate_passage(slices, req.boat)


class DossierReq(BaseModel):
    placeId: Optional[str] = None
    name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


@app.post("/dossier")
def dossier(req: DossierReq):
    """ReAct research agent fills the destination dossier (cited)."""
    place = None
    if req.placeId:
        place = next((p for p in store.all_places() if p["id"] == req.placeId), None)
    if place is None and req.lat is not None and req.lon is not None:
        place = {"id": req.placeId or "adhoc", "source": "adhoc",
                 "name": req.name or "Selected point", "lat": req.lat, "lon": req.lon, "attrs": {}}
    if place is None:
        return {"error": "provide placeId or lat/lon"}
    return agent.build_dossier(place)
