"""
Helm backend — standalone smoke test (no network, no keys required).

Runs the whole community/spacetime API in STUB mode against an in-process client and asserts
structure (not live values, so it passes offline / behind a restrictive proxy). Exit code 0 =
all pass, 1 = something failed.

    cd backend && pip install -r requirements.txt && python test_smoke.py

This is the deterministic floor. With OPENAI_API_KEY set and open network you additionally get
real OpenAI prose + real Open-Meteo values; verify those separately before live use.
"""
import os
os.environ.pop("OPENAI_API_KEY", None)          # force stub mode for a deterministic run

from fastapi.testclient import TestClient
import main

c = TestClient(main.app)
checks = []


def ok(name, cond):
    checks.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


# health
h = c.get("/health").json()
ok("health ok", h.get("ok"))
ok("llm provider is stub (no key)", h.get("llm") == "stub")
ok("nfl push mock", h["nfl"]["mode"] == "mock")
ok("osm scaffold", h["osm"]["mode"] == "scaffold")

# places (source-tagged store)
pl = c.get("/places").json()
ok("places >= 6 features", len(pl["features"]) >= 6)
ok("places are source-tagged", all("source" in f["properties"] for f in pl["features"]))

# owned saved pins (write + read back)
sv = c.post("/saved", json={"title": "Smoke pin", "category": "anchorage",
                            "lat": 24.56, "lon": -81.79, "note": "test"}).json()
ok("saved returns id", bool(sv.get("id")))
ok("saved is listed", any(f["properties"]["name"] == "Smoke pin" for f in c.get("/saved").json()["features"]))

# where-to-go recommender (deterministic pre-filter ranks NE-sheltered first for a NE blow)
wt = c.post("/whereto", json={"query": "safe spot, strong NE wind",
                              "position": {"lat": 24.5, "lon": -81.8}, "boat": {"draft": 1.8},
                              "forecast": {"windFromDeg": 45, "windKt": 25}}).json()
ok("whereto returns recommendations", len(wt["recommendations"]) >= 1)
ok("whereto top is source-tagged", "source" in wt["recommendations"][0]["place"])
ok("whereto top has reasons + confidence", wt["recommendations"][0]["reasons"]
   and wt["recommendations"][0]["confidence"] in ("low", "fair", "good"))
ok("whereto produces map highlight geojson", wt["geojson"]["type"] == "FeatureCollection")

# spacetime probe: layer filter (only requested layers join the slice)
n = c.post("/narrate", json={"lat": 24.553, "lon": -81.782,
                             "layers": ["depth", "ais", "places"]}).json()
ok("narrate slice respects layer filter", set(n["layers"].keys()) == {"depth", "ais", "places"})
ok("depth-at-point present", n["layers"]["depth"]["nearestChartedM"] is not None)
ok("ais targets present", n["layers"]["ais"]["count"] >= 1)
ok("narration is non-empty text", isinstance(n["narration"], str) and len(n["narration"]) > 10)

# NFL stays locked unless experimental flag
n2 = c.post("/narrate", json={"lat": 24.55, "lon": -81.8, "layers": ["nfl"]}).json()
ok("nfl locked by default", n2["layers"]["nfl"]["locked"] is True)

# passage briefing (probe along a path) carries the full weather catalog per leg
b = c.post("/briefing", json={"points": [{"lat": 24.46, "lon": -81.88, "t": "2026-06-25T18:00"},
                                         {"lat": 24.55, "lon": -81.78, "t": "2026-06-25T22:00"}],
                              "layers": ["weather", "places"]}).json()
ok("briefing returns one leg per point", len(b["legs"]) == 2)
ok("legs carry full catalog keys", {"windKt", "gustKt", "waveM", "swellM", "rainMm",
    "pressureHpa", "cloudPct"}.issubset(b["legs"][0].keys()))

# dossier (ReAct research agent assembles cited sections)
d = c.post("/dossier", json={"placeId": "osm-kw-garrison"}).json()
ok("dossier has all sections", {"formalities", "anchorage", "services", "community",
    "climate"}.issubset(d["sections"].keys()))

# give-back (sanctioned, mock/scaffold first)
ok("nfl push mock-sends", c.post("/giveback/nfl/push", json={"lat": 24.5, "lon": -81.8}).json()["status"] == "sent-mock")
ok("osm note scaffolds", c.post("/giveback/osm-note", json={"lat": 24.5, "lon": -81.8, "text": "x"}).json()["status"] == "would-create")

# cleanup the owned.json the saved-pin test wrote (it's gitignored anyway)
try:
    os.remove(os.path.join(os.path.dirname(__file__), "data", "owned.json"))
except OSError:
    pass

passed = sum(p for _, p in checks)
print("\n%d/%d checks passed" % (passed, len(checks)))
raise SystemExit(0 if passed == len(checks) else 1)
