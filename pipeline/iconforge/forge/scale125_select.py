"""Select the 125-asset Icon Forge scale batch from chartsymbols.xml.

This is the next rung after stress20. The output is a machine-readable catalog
with family quotas and S-52 lookup provenance; generation/rendering comes next.

Run:  python -m forge.scale125_select
"""
from __future__ import annotations

import json
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
S52 = Path(os.environ.get("HELM_S52_CHARTSYMBOLS", Path.home() / ".helm/runtime/s57data/chartsymbols.xml"))
OUT = ROOT / "pilots" / "scale125.json"
TARGET = 125
MANDATORY_ASSETS = [
    "BOYCAR01", "BOYCAR02", "BOYCAR03", "BOYCAR04",
    "BCNCAR01", "BCNCAR02", "BCNCAR03", "BCNCAR04",
    "BOYLAT13", "BOYLAT14", "BOYLAT23", "BOYLAT24",
    "BOYSAW12", "WRECKS04", "WRECKS05", "UWTROC03",
    "OBSTRN11", "LIGHTS11", "RESARE51", "ACHARE51", "CTNARE51",
]


@dataclass
class Candidate:
    id: str
    asset: str
    asset_kind: str
    family: str
    object_class: str
    lookup_id: str
    rcid: str
    conditions: list[str]
    instruction: str
    description: str
    stress_reasons: list[str]


def _text(node, child: str) -> str:
    return node.findtext(child) or ""


def _asset_descriptions(root) -> dict[str, str]:
    out = {}
    for tag in ["symbol", "pattern", "line-style"]:
        for node in root.iter(tag):
            name = _text(node, "name")
            if name:
                out[name] = _text(node, "description")
    return out


def _asset_refs(instruction: str) -> list[tuple[str, str]]:
    refs = []
    for kind, pattern in [
        ("symbol", r"SY\(([^),]+)"),
        ("pattern", r"AP\(([^),]+)"),
        ("line-style", r"(?:LS|LC)\(([^),]+)"),
        ("conditional-procedure", r"CS\(([^),]+)"),
    ]:
        refs.extend((kind, name) for name in re.findall(pattern, instruction))
    return refs


def _family(obj: str, asset: str, kind: str, conditions: list[str], instruction: str) -> str:
    if obj.startswith(("BOY", "BCN")):
        return "buoy_beacon_marks"
    if obj.startswith(("LIGHTS", "DAYMAR", "TOPMAR")) or asset.startswith(("LIGHTS", "DAYMAR", "TOPMAR")):
        return "lights_daymarks_topmarks"
    if obj in {"WRECKS", "OBSTRN", "UWTROC", "DEPARE", "DEPCNT", "DRGARE", "M_QUAL"} or asset.startswith(("WRECKS", "OBSTRN", "UWTROC", "FOULGND", "FLTHAZ", "DEPARE", "DEPCNT", "DQUAL", "NODATA")):
        return "wreck_rock_obstruction"
    if kind in {"pattern", "line-style"} or obj.endswith("ARE") or obj in {"TSSLPT", "TSSRON", "TSEZNE"}:
        return "areas_patterns_lines"
    if len(conditions) >= 2 or "CS(" in instruction:
        return "ugly_attribute_edges"
    return "ugly_attribute_edges"


def _stress_reasons(family: str, obj: str, asset: str, conditions: list[str], instruction: str) -> list[str]:
    reasons = [family]
    attr = " ".join(conditions)
    if any(k in attr for k in ["CATCAM", "COLOUR", "COLPAT", "BOYSHP", "BCNSHP"]):
        reasons.append("attribute_driven_mark_variant")
    if any(k in attr for k in ["CATWRK", "CATOBS", "WATLEV", "VALSOU", "QUASOU", "DRVAL", "CATZOC"]):
        reasons.append("conditional_danger_variant")
    if "CS(" in instruction:
        reasons.append("conditional_symbology")
    if asset.startswith(("BOYCAR", "BCNCAR")):
        reasons.append("cardinal_orientation")
    if asset.startswith(("BOYLAT", "BCNLAT")):
        reasons.append("lateral_region_colour_shape")
    if obj.endswith("ARE"):
        reasons.append("area_boundary_pattern")
    return list(dict.fromkeys(reasons))


def _candidates(root) -> list[Candidate]:
    desc = _asset_descriptions(root)
    out = []
    seen = set()
    for lookup in root.iter("lookup"):
        obj = lookup.get("name") or ""
        instruction = _text(lookup, "instruction")
        conditions = [a.text or "" for a in lookup.findall("attrib-code")]
        for kind, asset in _asset_refs(instruction):
            key = (obj, asset, kind, tuple(conditions))
            if key in seen:
                continue
            seen.add(key)
            family = _family(obj, asset, kind, conditions, instruction)
            out.append(Candidate(
                id=f"{obj}_{asset}_{lookup.get('id')}",
                asset=asset,
                asset_kind=kind,
                family=family,
                object_class=obj,
                lookup_id=lookup.get("id") or "",
                rcid=lookup.get("RCID") or "",
                conditions=conditions,
                instruction=instruction,
                description=desc.get(asset, ""),
                stress_reasons=_stress_reasons(family, obj, asset, conditions, instruction),
            ))
    return out


def _score(c: Candidate) -> tuple:
    # Prefer meaningful, attribute-driven rows and canonical S-52 families.
    score = 0
    score += 10 * len(c.conditions)
    score += 15 if "conditional_symbology" in c.stress_reasons else 0
    score += 10 if "attribute_driven_mark_variant" in c.stress_reasons else 0
    score += 10 if "conditional_danger_variant" in c.stress_reasons else 0
    score += 5 if c.description else 0
    return (-score, c.object_class, c.asset, c.lookup_id)


def _take(candidates: list[Candidate], family: str, quota: int, used_assets: set[str]) -> list[Candidate]:
    pool = [c for c in candidates if c.family == family and c.asset not in used_assets]
    pool.sort(key=_score)
    picked = []
    for c in pool:
        if len(picked) >= quota:
            break
        if c.asset in used_assets:
            continue
        picked.append(c)
        used_assets.add(c.asset)
    return picked


def select() -> dict:
    root = ET.parse(S52).getroot()
    candidates = _candidates(root)
    quotas = {
        "buoy_beacon_marks": 45,
        "lights_daymarks_topmarks": 20,
        "wreck_rock_obstruction": 25,
        "areas_patterns_lines": 25,
        "ugly_attribute_edges": 10,
    }
    used_assets: set[str] = set()
    picked: list[Candidate] = []
    by_asset = {}
    for c in sorted(candidates, key=_score):
        by_asset.setdefault(c.asset, c)
    for asset in MANDATORY_ASSETS:
        c = by_asset.get(asset)
        if c and c.asset not in used_assets:
            picked.append(c)
            used_assets.add(c.asset)
    for family, quota in quotas.items():
        have = sum(1 for c in picked if c.family == family)
        if have < quota:
            picked.extend(_take(candidates, family, quota - have, used_assets))

    if len(picked) < TARGET:
        remainder = [c for c in candidates if c.asset not in used_assets]
        remainder.sort(key=_score)
        for c in remainder:
            if len(picked) >= TARGET:
                break
            picked.append(c)
            used_assets.add(c.asset)

    picked = picked[:TARGET]
    family_counts = {}
    kind_counts = {}
    for c in picked:
        family_counts[c.family] = family_counts.get(c.family, 0) + 1
        kind_counts[c.asset_kind] = kind_counts.get(c.asset_kind, 0) + 1

    return {
        "id": "scale125",
        "title": "125-asset Icon Forge scale batch",
        "source": str(S52),
        "target_assets": TARGET,
        "selected_assets": len(picked),
        "quotas": quotas,
        "family_counts": family_counts,
        "asset_kind_counts": kind_counts,
        "selection_rules": [
            "Select from chartsymbols.xml lookup rows, not by hand.",
            "Prefer whole hard families and sibling-rich cases.",
            "Prefer attribute-driven and conditional-symbology rows.",
            "Keep area patterns and line styles in scope.",
            "Each selected row carries lookup provenance and stress reasons.",
        ],
        "next_batch_outputs": {
            "styles": 2,
            "palettes": 3,
            "svg_outputs": len(picked) * 2,
            "png_outputs": len(picked) * 2 * 3,
        },
        "entries": [asdict(c) for c in picked],
    }


def main() -> int:
    data = select()
    OUT.write_text(json.dumps(data, indent=2))
    print(f"scale125 selected: {data['selected_assets']} assets -> {OUT}")
    print("family_counts:", data["family_counts"])
    print("asset_kind_counts:", data["asset_kind_counts"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
