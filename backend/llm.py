"""
Helm backend — the "where to go" recommender.

Honesty spine:
- The DETERMINISTIC pre-filter computes the hard facts — distance/ETA, a draft check, and a
  shelter score vs. the forecast wind direction. These are never LLM-generated.
- The LLM only RANKS and EXPLAINS, with citations + confidence. It never invents a depth,
  holding, review, or forecast; unknowns are "verify locally".
- Provider-pluggable `LLMClient`: OpenAI for the prototype (key from env). With no key it
  runs a deterministic STUB that returns the same schema — so the loop works offline/now and
  simply reads better once the key is supplied.
- NFL is just-another-source: when NFL records are present they enter the candidate list
  tagged `nfl`; nothing here special-cases them.
"""
import os
import json

from store import haversine_nm, reviews_for

# 8 compass points for the shelter check
_DIRS = {"N": 0, "NE": 45, "E": 90, "SE": 135, "S": 180, "SW": 225, "W": 270, "NW": 315}


def _wind_from_dir(deg):
    """Nearest 8-point compass label for a wind-FROM bearing."""
    return min(_DIRS, key=lambda d: abs((deg - _DIRS[d] + 180) % 360 - 180))


def prefilter(places, position, boat, forecast):
    """DETERMINISTIC scoring. Returns candidates with computed facts attached."""
    draft = (boat or {}).get("draft", 1.8)
    wind_dir = (forecast or {}).get("windFromDeg")
    wind_kt = (forecast or {}).get("windKt")
    wind_lbl = _wind_from_dir(wind_dir) if wind_dir is not None else None
    out = []
    for p in places:
        lat, lon = p["lat"], p["lon"]
        dist = haversine_nm(position["lat"], position["lon"], lat, lon) if position else None
        attrs = p.get("attrs", {})
        depth = attrs.get("depth")
        draft_ok = None if depth is None else depth >= draft + 0.5  # 0.5 m under-keel margin
        shelter_dirs = attrs.get("shelterDirs") or []
        sheltered = None if wind_lbl is None else (wind_lbl in shelter_dirs)
        # score: prefer sheltered, draft-ok, close; unknowns are neutral, not rewarded
        score = 0.0
        if sheltered is True:
            score += 3
        elif sheltered is False:
            score -= 2
        if draft_ok is True:
            score += 1.5
        elif draft_ok is False:
            score -= 3
        if dist is not None:
            score -= min(dist / 10.0, 3)  # mild distance penalty
        out.append({
            "place": p,
            "computed": {
                "distanceNm": round(dist, 1) if dist is not None else None,
                "draftOk": draft_ok, "depth": depth,
                "shelteredFrom": shelter_dirs, "windLabel": wind_lbl, "windKt": wind_kt,
                "sheltered": sheltered,
            },
            "score": score,
            "reviews": reviews_for(p["id"]),
        })
    out.sort(key=lambda c: c["score"], reverse=True)
    return out


def _stub_reasons(c, query):
    """Deterministic, honest reasons when there's no LLM key."""
    comp, p = c["computed"], c["place"]
    bits = []
    if comp["sheltered"] is True:
        bits.append(f"sheltered from the forecast {comp['windLabel']} wind")
    elif comp["sheltered"] is False:
        bits.append(f"exposed to the forecast {comp['windLabel']} — caution")
    if comp["draftOk"] is True:
        bits.append(f"depth {comp['depth']} m clears your draft")
    elif comp["draftOk"] is False:
        bits.append(f"shallow ({comp['depth']} m) for your draft — verify")
    if comp["distanceNm"] is not None:
        bits.append(f"{comp['distanceNm']} NM away")
    for r in c["reviews"][:1]:
        bits.append(f'"{r["text"]}" — {r["author"]}')
    return bits or ["limited data — verify locally"]


def _sources_for(c):
    srcs = [{"label": c["place"]["source"], "kind": "place"}]
    for r in c["reviews"]:
        srcs.append({"label": r["author"], "kind": r["source"], "url": r.get("url")})
    return srcs


class LLMClient:
    """Provider-pluggable. OpenAI when OPENAI_API_KEY is set; deterministic stub otherwise."""

    def __init__(self):
        self.key = os.environ.get("OPENAI_API_KEY", "").strip()
        self.model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
        self.provider = "openai" if self.key else "stub"

    def rank(self, query, candidates, position, boat, forecast, top=3):
        ranked = candidates[:top]
        if self.provider == "stub":
            return [self._row(c, _stub_reasons(c, query), "stub") for c in ranked]
        try:
            return self._rank_openai(query, ranked, position, boat, forecast)
        except Exception as e:  # never fail the request — fall back to honest stub
            return [self._row(c, _stub_reasons(c, query) + [f"(LLM unavailable: {e})"], "stub")
                    for c in ranked]

    def _row(self, c, reasons, mode):
        comp = c["computed"]
        # honest confidence from how much we actually know
        known = sum(x is not None for x in (comp["sheltered"], comp["draftOk"], comp["distanceNm"]))
        conf = {0: "low", 1: "low", 2: "fair", 3: "good"}[known]
        return {
            "place": {k: c["place"][k] for k in ("id", "source", "kind", "name", "lat", "lon")},
            "reasons": reasons,
            "sources": _sources_for(c),
            "freshness": "request-time",
            "horizon": "advisory planning only; verify locally before acting",
            "confidence": conf,
            "computed": comp,
            "llm": mode,
            "nfl": c["place"]["source"] == "nfl",
            "advisory": {"mayAct": False, "requiresHumanVerification": True},
        }

    def _rank_openai(self, query, ranked, position, boat, forecast):
        from openai import OpenAI
        client = OpenAI(api_key=self.key)
        facts = [{
            "id": c["place"]["id"], "name": c["place"]["name"], "source": c["place"]["source"],
            "kind": c["place"]["kind"], "computed": c["computed"],
            "reviews": [{"author": r["author"], "text": r["text"], "url": r.get("url")} for r in c["reviews"]],
        } for c in ranked]
        sys = (
            "You are Helm's cruising first-mate. Explain WHY each anchorage/marina fits the "
            "sailor's request, in one or two short sentences. Use ONLY the provided computed "
            "facts and reviews — never invent depths, holding, weather, or reviews. If data is "
            "missing, say 'verify locally'. Cite review authors inline. Return STRICT JSON: "
            '{"items":[{"id":str,"reasons":[str],"confidence":"low|fair|good"}]}.'
        )
        usr = json.dumps({"query": query, "boat": boat, "forecast": forecast, "candidates": facts})
        resp = client.chat.completions.create(
            model=self.model, temperature=0.3,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": sys}, {"role": "user", "content": usr}],
        )
        parsed = json.loads(resp.choices[0].message.content)
        by_id = {it["id"]: it for it in parsed.get("items", [])}
        rows = []
        for c in ranked:
            it = by_id.get(c["place"]["id"], {})
            row = self._row(c, it.get("reasons") or _stub_reasons(c, query), "openai")
            if it.get("confidence"):
                row["confidence"] = it["confidence"]
            rows.append(row)
        return rows
