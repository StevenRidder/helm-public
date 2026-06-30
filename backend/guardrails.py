"""
Deterministic advisory guardrails for Helm AI surfaces.

AI text may explain, summarize, and recommend what to inspect next. It must not
look like an executable navigation command, and every advisory response must
carry enough provenance for a skipper to judge source, freshness, and horizon.
"""
import re
import time


ADVISORY_DISCLAIMER = (
    "Advisory only. Do not use this as an instruction to steer, route, or actuate; "
    "verify with official charts, onboard instruments, and local conditions."
)

_ACTION_PATTERNS = (
    r"\b(set|engage|disengage)\s+(the\s+)?(autopilot|pilot)\b",
    r"\b(execute|commit|activate)\s+(the\s+)?(route|maneuver|turn)\b",
    r"\b(turn|steer|alter course)\s+(now|to|onto|toward)\b",
    r"\b(change heading|set heading|adjust heading)\b",
)


def _now():
    return time.strftime("%Y-%m-%dT%H:%MZ")


def action_language_violations(text):
    if not text:
        return []
    found = []
    for pattern in _ACTION_PATTERNS:
        if re.search(pattern, text, re.I):
            found.append("unsafe_action_language")
            break
    return found


def _source_title(source):
    if not isinstance(source, dict):
        return None
    return (
        source.get("title")
        or source.get("name")
        or source.get("label")
        or source.get("producer")
        or source.get("productId")
    )


def _record_source(evidence, source):
    title = _source_title(source)
    if not title:
        return
    key = "%s|%s" % (title, source.get("url") or source.get("kind") or source.get("productId") or "")
    evidence["_sourceKeys"].add(key)
    evidence["sources"].append({k: source[k] for k in source if source[k] is not None})


def _record_sample(evidence, layer, sample):
    if not isinstance(sample, dict):
        return
    source_ref = sample.get("sourceRef") or {}
    if source_ref:
        _record_source(evidence, source_ref)
    if sample.get("freshness"):
        evidence["freshness"].append({
            "layer": layer,
            "freshness": sample.get("freshness"),
            "validTime": sample.get("validTime"),
            "status": sample.get("status"),
        })
    if sample.get("horizon"):
        evidence["horizons"].append({
            "layer": layer,
            "horizon": sample.get("horizon"),
            "confidence": sample.get("confidence"),
        })
    if sample.get("notForNavigation") is False:
        evidence["violations"].append("sample_missing_not_for_navigation:%s" % layer)


def _record_context(evidence, ctx):
    if not isinstance(ctx, dict):
        return
    for source in ctx.get("sources") or []:
        _record_source(evidence, source)
    for layer, value in (ctx.get("layers") or {}).items():
        if isinstance(value, dict):
            _record_sample(evidence, layer, value.get("sample"))


def _record_dossier(evidence, dossier):
    if not isinstance(dossier, dict):
        return
    sections = dict(dossier.get("sections") or {})
    if isinstance(dossier.get("arrivalWeather"), dict):
        sections["arrivalWeather"] = dossier["arrivalWeather"]
    for name, section in sections.items():
        if not isinstance(section, dict):
            continue
        for source in section.get("sources") or []:
            _record_source(evidence, source)
        if section.get("fetchedAt"):
            evidence["freshness"].append({"layer": name, "freshness": section.get("fetchedAt")})
        if section.get("horizon"):
            evidence["horizons"].append({"layer": name, "horizon": section.get("horizon")})


def _record_recommendations(evidence, recommendations):
    for i, rec in enumerate(recommendations or []):
        if not isinstance(rec, dict):
            continue
        label = "recommendation:%s" % (rec.get("place", {}) or {}).get("id", i + 1)
        for source in rec.get("sources") or []:
            _record_source(evidence, source)
        if rec.get("freshness"):
            evidence["freshness"].append({"layer": label, "freshness": rec.get("freshness")})
        if rec.get("horizon"):
            evidence["horizons"].append({"layer": label, "horizon": rec.get("horizon")})


def build_guardrail_report(kind, text=None, contexts=None, dossier=None, recommendations=None):
    evidence = {
        "_sourceKeys": set(),
        "sources": [],
        "freshness": [],
        "horizons": [],
        "violations": [],
    }
    for ctx in contexts or []:
        _record_context(evidence, ctx)
    _record_dossier(evidence, dossier)
    _record_recommendations(evidence, recommendations)
    evidence["violations"].extend(action_language_violations(text))

    if not evidence["_sourceKeys"]:
        evidence["violations"].append("missing_sources")
    if not evidence["freshness"]:
        evidence["violations"].append("missing_freshness")
    if not evidence["horizons"]:
        evidence["violations"].append("missing_horizon")

    violations = sorted(set(evidence["violations"]))
    if any(v == "unsafe_action_language" or v.startswith("sample_missing") for v in violations):
        status = "blocked_from_action"
    elif violations:
        status = "needs_verification"
    else:
        status = "ok"

    return {
        "kind": kind,
        "status": status,
        "actionClass": "advisory",
        "mayAct": False,
        "notForNavigation": True,
        "requiresHumanVerification": True,
        "disclaimer": ADVISORY_DISCLAIMER,
        "checkedAt": _now(),
        "violations": violations,
        "evidence": {
            "sourceCount": len(evidence["_sourceKeys"]),
            "freshnessCount": len(evidence["freshness"]),
            "horizonCount": len(evidence["horizons"]),
            "sources": evidence["sources"],
            "freshness": evidence["freshness"],
            "horizons": evidence["horizons"],
        },
    }


def attach_guardrails(payload, kind, text=None, contexts=None, dossier=None, recommendations=None):
    payload["guardrails"] = build_guardrail_report(
        kind,
        text=text,
        contexts=contexts,
        dossier=dossier or payload,
        recommendations=recommendations,
    )
    return payload
