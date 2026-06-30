"""
Helm backend — ReAct research agents.

The research engine behind the cards. A ReAct-style (reason → act → observe) tool-using agent
fills the destination dossier and enriches "where to go" by actually researching — searching,
fetching, extracting, and synthesizing WITH CITATIONS — rather than hallucinating.

Honesty spine:
- Tools return real data (weather from Open-Meteo; fetched page text; the place store). The
  agent may only summarize what tools returned — never invent a fee, depth, holding, or
  forecast. Unknowns are "verify locally". Every claim carries a source + fetch date.
- Provider-pluggable via LLMClient. With an OpenAI key the agent runs a real tool-calling
  loop; with no key it runs a DETERMINISTIC stub that still assembles an honest dossier from
  the real weather tool + seed/cited sources — so the loop works now and reads better later.
- search_web is the one tool that needs a provider (Tavily/Bing/SerpAPI) to be fully live;
  until configured it returns curated cruiser sources (Noonsite/blogs) so citations are real
  links a human can open. Marked clearly so it's never mistaken for an exhaustive search.
"""
import os
import json
import re
import time

import httpx

from guardrails import attach_guardrails

UA = {"User-Agent": "Helm/0.1 (marine nav prototype; contact: steve@taikunai.com)"}


# ----------------------------- TOOLS (real data) -----------------------------
def get_weather(lat: float, lon: float):
    """Real forecast at a point via Open-Meteo (free, no key). The full Windy-class catalog:
    wind/gust + rain/pressure/cloud/temp/CAPE (atmosphere) + wave/swell/SST/current (marine)."""
    out = {"source": "Open-Meteo", "fetchedAt": time.strftime("%Y-%m-%dT%H:%MZ"),
           "lat": lat, "lon": lon}
    ATMO = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,pressure_msl,cloud_cover,temperature_2m,cape"
    try:
        w = httpx.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": lat, "longitude": lon, "wind_speed_unit": "kn", "forecast_days": 3,
            "hourly": ATMO, "current": ATMO,
        }, headers=UA, timeout=8).json()
        cur = w.get("current", {})
        out["now"] = {"windKt": cur.get("wind_speed_10m"), "windFromDeg": cur.get("wind_direction_10m"),
                      "gustKt": cur.get("wind_gusts_10m"), "rainMm": cur.get("precipitation"),
                      "pressureHpa": cur.get("pressure_msl"), "cloudPct": cur.get("cloud_cover"),
                      "tempC": cur.get("temperature_2m"), "cape": cur.get("cape")}
        h = w.get("hourly", {})
        out["next"] = [{"t": h["time"][i], "windKt": h["wind_speed_10m"][i],
                        "windFromDeg": h["wind_direction_10m"][i], "gustKt": h["wind_gusts_10m"][i],
                        "rainMm": h["precipitation"][i], "pressureHpa": h["pressure_msl"][i],
                        "cloudPct": h["cloud_cover"][i], "tempC": h["temperature_2m"][i], "cape": h["cape"][i]}
                       for i in range(0, min(len(h.get("time", [])), 36), 6)]
    except Exception as e:
        out["windError"] = str(e)
    try:
        m = httpx.get("https://marine-api.open-meteo.com/v1/marine", params={
            "latitude": lat, "longitude": lon,
            "current": "wave_height,swell_wave_height,wave_period,wind_wave_height,"
                       "sea_surface_temperature,ocean_current_velocity,ocean_current_direction",
        }, headers=UA, timeout=8).json()
        c = m.get("current", {})
        out["sea"] = {"waveM": c.get("wave_height"), "swellM": c.get("swell_wave_height"),
                      "periodS": c.get("wave_period"), "windWaveM": c.get("wind_wave_height")}
        out["sst"] = {"sstC": c.get("sea_surface_temperature")}
        out["current"] = {"velKn": c.get("ocean_current_velocity"), "dirDeg": c.get("ocean_current_direction")}
    except Exception as e:
        out["seaError"] = str(e)
    return out


def fetch_page(url: str, max_chars: int = 3500):
    """Fetch a public page and crudely extract text, for cited summarization."""
    try:
        r = httpx.get(url, headers=UA, timeout=10, follow_redirects=True)
        text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", r.text)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return {"url": url, "fetchedAt": time.strftime("%Y-%m-%dT%H:%MZ"), "text": text[:max_chars]}
    except Exception as e:
        return {"url": url, "error": str(e)}


# curated, real cruiser sources so citations are openable even before a search provider is set
SEED_SOURCES = {
    "formalities": [{"title": "Noonsite — formalities", "url": "https://www.noonsite.com", "kind": "rag"}],
    "anchorage": [{"title": "OpenSeaMap", "url": "https://www.openseamap.org", "kind": "open"}],
    "services": [{"title": "OpenStreetMap", "url": "https://www.openstreetmap.org", "kind": "open"}],
    "community": [{"title": "s/v Totem (blog)", "url": "https://www.sailingtotem.com", "kind": "rag"}],
    "climate": [{"title": "NOAA climatology", "url": "https://www.noaa.gov", "kind": "open"}],
}


def search_web(query: str, section: str = "formalities"):
    """Pluggable web search. TODO: wire Tavily/Bing/SerpAPI via env for full live search.
    Until then, return curated real sources so the agent cites openable links."""
    provider = os.environ.get("SEARCH_PROVIDER")
    if provider:
        pass  # implement real provider call here on go-live
    return {"provider": provider or "seed", "results": SEED_SOURCES.get(section, [])}


# --------------------------- THE ReAct AGENT ---------------------------
TOOL_SCHEMAS = [
    {"type": "function", "function": {"name": "get_weather", "description": "Real forecast (wind/gust/wave) at a lat/lon via Open-Meteo.",
     "parameters": {"type": "object", "properties": {"lat": {"type": "number"}, "lon": {"type": "number"}}, "required": ["lat", "lon"]}}},
    {"type": "function", "function": {"name": "search_web", "description": "Find sources about a topic (formalities/anchorage/services/community/climate).",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "section": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "fetch_page", "description": "Fetch a public web page and return its text for cited summarization.",
     "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
]
TOOLS = {"get_weather": get_weather, "search_web": search_web, "fetch_page": fetch_page}


class ResearchAgent:
    """ReAct tool-calling loop (OpenAI) with a deterministic stub fallback."""

    def __init__(self, llm):
        self.llm = llm

    def build_dossier(self, place):
        lat, lon, name = place["lat"], place["lon"], place["name"]
        weather = get_weather(lat, lon)  # always real, no key needed
        if self.llm.provider == "stub":
            return attach_guardrails(self._stub_dossier(place, weather), "dossier")
        try:
            return attach_guardrails(self._agent_dossier(place, weather), "dossier")
        except Exception as e:
            d = self._stub_dossier(place, weather)
            d["note"] = f"(agent unavailable, stub used: {e})"
            return attach_guardrails(d, "dossier")

    def narrate_passage(self, slices, boat=None):
        """Narrate a sequence of slices along a path P(t) — the 'along the way' briefing.
        Same layer-sample contract, applied along the route geometry."""
        legs = [self._leg_summary(s, i) for i, s in enumerate(slices)]
        srcs = []
        for s in slices:
            srcs.extend(s.get("sources", []))
        if self.llm.provider == "stub":
            out = {"provider": "stub", "narration": self._stub_passage(legs), "legs": legs, "sources": srcs}
            return attach_guardrails(out, "briefing", text=out["narration"], contexts=slices)
        try:
            from openai import OpenAI
            client = OpenAI(api_key=self.llm.key)
            sys = ("You are Helm's first-mate. Narrate the PASSAGE from these ordered slices "
                   "(time + wind/sea + nearest shelter at points along the route). 3-5 short "
                   "sentences: what the sailor will encounter and when, where it gets rough, "
                   "and any shelter. Use ONLY the data; never invent; note forecast horizon; "
                   "end 'verify on official charts'.")
            resp = client.chat.completions.create(model=self.llm.model, temperature=0.3,
                messages=[{"role": "system", "content": sys},
                          {"role": "user", "content": json.dumps({"boat": boat, "legs": legs})[:9000]}])
            out = {"provider": "openai", "narration": resp.choices[0].message.content.strip(),
                   "legs": legs, "sources": srcs}
            return attach_guardrails(out, "briefing", text=out["narration"], contexts=slices)
        except Exception as e:
            out = {"provider": "stub", "narration": self._stub_passage(legs) + f" (LLM unavailable: {e})",
                   "legs": legs, "sources": srcs}
            return attach_guardrails(out, "briefing", text=out["narration"], contexts=slices)

    def _leg_summary(self, ctx, i):
        L, pt = ctx.get("layers", {}), ctx.get("point", {})
        w = (L.get("weather") or {}).get("atTime") or (L.get("weather") or {}).get("now") or {}
        sea = (L.get("weather") or {}).get("sea") or {}
        near = (L.get("places") or [{}])
        return {"leg": i + 1, "t": pt.get("weatherValidAt") or pt.get("t"),
                "lat": round(pt.get("lat", 0), 3), "lon": round(pt.get("lon", 0), 3),
                "windKt": w.get("windKt"), "windFromDeg": w.get("windFromDeg"), "gustKt": w.get("gustKt"),
                "waveM": sea.get("waveM"), "swellM": sea.get("swellM"),
                "rainMm": w.get("rainMm"), "pressureHpa": w.get("pressureHpa"), "cloudPct": w.get("cloudPct"),
                "nearest": near[0].get("name") if near and near[0] else None,
                "nearestNm": near[0].get("distanceNm") if near and near[0] else None,
                "wxError": (L.get("weather") or {}).get("error")}

    def _stub_passage(self, legs):
        out = []
        for lg in legs:
            when = lg["t"] or f"leg {lg['leg']}"
            if lg["wxError"] or lg["windKt"] is None:
                out.append(f"{when}: weather n/a.")
            else:
                s = f"{when}: ~{lg['windKt']} kt from {lg['windFromDeg']}°"
                if lg["waveM"] is not None:
                    s += f", seas {lg['waveM']} m"
                if lg["nearest"]:
                    s += f" (near {lg['nearest']}, {lg['nearestNm']} NM)"
                out.append(s + ".")
        return "Passage: " + " ".join(out) + " Forecast skill drops beyond ~7 days — recheck en route. Verify on official charts."

    def narrate_context(self, ctx):
        """Speak a fused spacetime context (from context.resolve_context) in plain language,
        with citations + honesty. The keystone: pick a point in space+time -> narration."""
        if self.llm.provider == "stub":
            out = {"narration": self._stub_narration(ctx), "provider": "stub",
                   "sources": ctx.get("sources", [])}
            return attach_guardrails(out, "narration", text=out["narration"], contexts=[ctx])
        try:
            out = {"narration": self._llm_narration(ctx), "provider": "openai",
                   "sources": ctx.get("sources", [])}
            return attach_guardrails(out, "narration", text=out["narration"], contexts=[ctx])
        except Exception as e:
            out = {"narration": self._stub_narration(ctx) + f" (LLM unavailable: {e})",
                   "provider": "stub", "sources": ctx.get("sources", [])}
            return attach_guardrails(out, "narration", text=out["narration"], contexts=[ctx])

    def _stub_narration(self, ctx):
        L, pt = ctx.get("layers", {}), ctx["point"]
        when = pt.get("weatherValidAt") or pt.get("t") or "now"
        parts = [f"At {pt['lat']:.3f}, {pt['lon']:.3f} ({when}):"]
        wx = L.get("weather")
        if wx is not None:
            w = wx.get("atTime") or wx.get("now") or {}
            sea = wx.get("sea") or {}
            if wx.get("error"):
                parts.append("weather unavailable here — verify locally.")
            elif w:
                s = (f"wind ~{w.get('windKt','?')} kt from {w.get('windFromDeg','?')}°,"
                     f" gusts {w.get('gustKt','?')} kt; seas {sea.get('waveM','?')} m")
                if w.get("rainMm"):
                    s += f"; rain {w['rainMm']} mm"
                if w.get("pressureHpa"):
                    s += f"; {round(w['pressureHpa'])} hPa"
                parts.append(s + ".")
        if L.get("places"):
            p = L["places"][0]
            rv = f" — \"{p['reviews'][0]['text']}\"" if p["reviews"] else ""
            parts.append(f"Nearest: {p['name']} ({p['distanceNm']} NM, {p['source']}){rv}.")
        if L.get("depth") and L["depth"].get("nearestChartedM") is not None:
            parts.append(f"Charted depth near here ~{L['depth']['nearestChartedM']} m (verify on chart).")
        if L.get("ais") and L["ais"].get("count"):
            tg = L["ais"]["targets"][0]
            parts.append(f"{L['ais']['count']} AIS target(s) nearby; nearest {tg['name']} at {tg['rangeNm']} NM.")
        if L.get("climate"):
            parts.append(L["climate"]["note"])
        if L.get("nfl"):
            parts.append("NFL community data: locked (experimental)." if L["nfl"].get("locked")
                         else "NFL enrichment active.")
        if L.get("chart"):
            parts.append(L["chart"]["note"])
        return " ".join(parts)

    def _llm_narration(self, ctx):
        from openai import OpenAI
        client = OpenAI(api_key=self.llm.key)
        sys = (
            "You are Helm's first-mate narrator. Given a FUSED spacetime context (weather "
            "valid at a time, climate, nearby places + reviews, saved pins, the NFL slot, and "
            "chart pointers at one lat/lon/time), narrate what a sailor needs to know in 2-4 "
            "short sentences. Use ONLY the provided data; never invent weather, depths, fees, "
            "or reviews. Note the forecast horizon/confidence. If NFL is locked, say it's "
            "experimental/partnership-gated, don't fabricate it. End with 'verify on official "
            "charts'. Cite place/review names inline."
        )
        resp = client.chat.completions.create(
            model=self.llm.model, temperature=0.3,
            messages=[{"role": "system", "content": sys},
                      {"role": "user", "content": json.dumps(ctx)[:9000]}],
        )
        return resp.choices[0].message.content.strip()

    def _section(self, key, summary, sources, facts=None, horizon="verify locally before relying"):
        return {"summary": summary, "facts": facts or {}, "sources": sources,
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%MZ"), "horizon": horizon}

    def _stub_dossier(self, place, weather):
        wx = weather.get("now") or {}
        arr = "Forecast unavailable." if "windError" in weather else \
            f"Arrival wind ~{wx.get('windKt','?')} kt from {wx.get('windFromDeg','?')}°," \
            f" gusts {wx.get('gustKt','?')} kt; sea {((weather.get('sea') or {}).get('waveM','?'))} m."
        return {
            "place": {k: place[k] for k in ("id", "name", "lat", "lon", "source")},
            "provider": "stub",
            "arrivalWeather": self._section("weather", arr, [{"title": "Open-Meteo", "url": "https://open-meteo.com", "kind": "open"}], wx,
                                            "Open-Meteo forecast horizon; recheck before departure"),
            "sections": {
                "formalities": self._section("formalities", "Check local port-of-entry procedure, hours and fees before arrival.", SEED_SOURCES["formalities"]),
                "anchorage": self._section("anchorage", "See holding/shelter from open data and reviews; verify on the chart.", SEED_SOURCES["anchorage"]),
                "services": self._section("services", "Fuel/water/provisioning/repairs from OSM nearby.", SEED_SOURCES["services"]),
                "community": self._section("community", "Recent cruiser reports — verify currency.", SEED_SOURCES["community"]),
                "climate": self._section("climate", "Seasonal/cyclone context from climatology.", SEED_SOURCES["climate"]),
            },
            "disclaimer": "Synthesized from real weather + cited public sources. Not an official clearance — verify locally.",
        }

    def _agent_dossier(self, place, weather):
        from openai import OpenAI
        client = OpenAI(api_key=self.llm.key)
        sys = (
            "You are Helm's cruising research agent. Build a destination dossier for the place. "
            "Use the tools to gather REAL data; summarize ONLY what tools return; never invent "
            "fees, depths, holding, or weather; cite every claim with the source url; mark gaps "
            "'verify locally'. Sections: formalities, anchorage, services, community, climate. "
            "When done, return STRICT JSON matching the schema the user gives."
        )
        schema_hint = {
            "sections": {k: {"summary": "str", "facts": {}, "sources": [{"title": "str", "url": "str"}]}
                         for k in ["formalities", "anchorage", "services", "community", "climate"]}
        }
        messages = [
            {"role": "system", "content": sys},
            {"role": "user", "content": json.dumps({
                "place": place, "preloadedWeather": weather, "returnSchema": schema_hint})},
        ]
        for _ in range(6):  # bounded ReAct loop
            resp = client.chat.completions.create(model=self.llm.model, temperature=0.2,
                                                  tools=TOOL_SCHEMAS, messages=messages)
            msg = resp.choices[0].message
            if not msg.tool_calls:
                content = msg.content or "{}"
                try:
                    parsed = json.loads(re.search(r"\{.*\}", content, re.S).group(0))
                except Exception:
                    parsed = {"sections": {}}
                sections = parsed.get("sections", {})
                fetched = time.strftime("%Y-%m-%dT%H:%MZ")
                for section in sections.values():
                    if isinstance(section, dict):
                        section.setdefault("sources", [])
                        section.setdefault("fetchedAt", fetched)
                        section.setdefault("horizon", "verify locally before relying")
                return {"place": {k: place[k] for k in ("id", "name", "lat", "lon", "source")},
                        "provider": "openai",
                        "arrivalWeather": self._section("weather", "", [{"title": "Open-Meteo", "url": "https://open-meteo.com", "kind": "open"}], weather.get("now") or {},
                                                        "Open-Meteo forecast horizon; recheck before departure"),
                        "sections": sections,
                        "disclaimer": "Researched from real weather + cited sources. Verify locally."}
            messages.append(msg)
            for tc in msg.tool_calls:
                args = json.loads(tc.function.arguments or "{}")
                result = TOOLS.get(tc.function.name, lambda **k: {"error": "unknown tool"})(**args)
                messages.append({"role": "tool", "tool_call_id": tc.id,
                                 "content": json.dumps(result)[:6000]})
        return self._stub_dossier(place, weather)
