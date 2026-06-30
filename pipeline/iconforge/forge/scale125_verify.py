"""Semantic QA and hard-pile reporting for the 125-asset scale batch.

The scale125 generator proves broad structural renderability. This stage adds
deterministic sibling-discrimination checks over the generated schematics:
cardinal orientation, lateral colour/shape, wreck/rock/obstruction cues,
area/pattern/line styling, conditional symbols, and light/topmark flares.

Run:  python -m forge.scale125_verify
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from .schema import Criterion, StylePack
from . import scale125_generate, verify


ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "pilots" / "scale125.json"
OUT = ROOT / "out" / "scale125"
SVG_OUT = ROOT / "generated" / "scale125" / "compose"

TOPMARK = {
    "01": '<polygon points="32,4 25,16 39,16" fill="var(--black)"/><polygon points="32,15 25,27 39,27" fill="var(--black)"/>',
    "02": '<polygon points="32,4 25,16 39,16" fill="var(--black)"/><polygon points="25,16 39,16 32,28" fill="var(--black)"/>',
    "03": '<polygon points="25,5 39,5 32,17" fill="var(--black)"/><polygon points="25,16 39,16 32,28" fill="var(--black)"/>',
    "04": '<polygon points="25,4 39,4 32,16" fill="var(--black)"/><polygon points="32,16 25,28 39,28" fill="var(--black)"/>',
}

CARDINAL_BODY = {
    "01": ['rect x="25" y="29" width="14" height="11" fill="var(--black)"', 'rect x="25" y="40" width="14" height="12" fill="var(--yellow)"'],
    "02": ['rect x="25" y="29" width="14" height="11" fill="var(--black)"', 'rect x="25" y="40" width="14" height="12" fill="var(--yellow)"'],
    "03": ['rect x="25" y="29" width="14" height="11" fill="var(--yellow)"', 'rect x="25" y="40" width="14" height="12" fill="var(--black)"'],
    "04": ['rect x="25" y="29" width="14" height="7" fill="var(--yellow)"', 'rect x="25" y="36" width="14" height="9" fill="var(--black)"'],
}

FAMILIES = [
    "buoy_beacon_marks",
    "wreck_rock_obstruction",
    "areas_patterns_lines",
    "lights_daymarks_topmarks",
    "ugly_attribute_edges",
]


@dataclass
class QaRow:
    asset: str
    style: str
    family: str
    asset_kind: str
    case: str
    expected: str
    observed: str
    passed: bool
    reason_codes: list[str]
    criteria: list[dict]


def _styles() -> dict[str, StylePack]:
    return {p.stem: StylePack.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "stylepacks").glob("*.json")}


def _has_all(svg: str, snippets: list[str]) -> bool:
    return all(s in svg for s in snippets)


def _suffix(entry: dict) -> str:
    return entry["asset"][-2:]


def _first_token(entry: dict) -> str:
    return scale125_generate._tokens(entry)[0]


def _semantic(entry: dict, svg: str) -> list[Criterion]:
    criteria: list[Criterion] = []
    asset = entry["asset"]
    family = entry["family"]
    kind = entry["asset_kind"]
    reasons = set(entry["stress_reasons"])

    if "cardinal_orientation" in reasons:
        suffix = _suffix(entry)
        ok_top = TOPMARK[suffix] in svg
        criteria.append(Criterion(
            "semantic_cardinal_topmark", ok_top,
            f"{asset} topmark {suffix}" if ok_top else f"{asset} wrong/missing cardinal topmark",
        ))
        ok_body = _has_all(svg, CARDINAL_BODY[suffix])
        criteria.append(Criterion(
            "semantic_cardinal_colour_order", ok_body,
            f"{asset} cardinal band order" if ok_body else f"{asset} wrong cardinal colour order",
        ))
        return criteria

    if "lateral_region_colour_shape" in reasons:
        token = _first_token(entry)
        is_can = "can" in (entry.get("description") or "").lower()
        shape_snippet = 'rect x="23" y="24" width="18" height="28"' if is_can else "M32 22l-13 31h26z"
        ok_shape = shape_snippet in svg
        criteria.append(Criterion(
            "semantic_lateral_shape", ok_shape,
            "lateral can/conical body matches" if ok_shape else "wrong lateral body class",
        ))
        if is_can:
            ok_colour = f'<rect x="23" y="24" width="18" height="28" rx="2" fill="var(--{token})"' in svg
        else:
            ok_colour = f'<path d="M32 22l-13 31h26z" fill="var(--{token})"' in svg
        criteria.append(Criterion(
            "semantic_lateral_colour", ok_colour,
            f"lateral colour {token}" if ok_colour else f"wrong lateral colour, expected {token}",
        ))
        return criteria

    if kind == "line-style":
        ok_line = "M8 32h48" in svg
        criteria.append(Criterion(
            "semantic_line_geometry", ok_line,
            "line-style baseline present" if ok_line else "missing line-style baseline",
        ))
        if "DOTT" in asset.upper():
            ok_dash = 'stroke-dasharray="1 5"' in svg
            criteria.append(Criterion("semantic_line_dash", ok_dash, "dotted style" if ok_dash else "wrong dotted cadence"))
        elif "DASH" in asset.upper():
            ok_dash = 'stroke-dasharray="5 4"' in svg
            criteria.append(Criterion("semantic_line_dash", ok_dash, "dashed style" if ok_dash else "wrong dashed cadence"))
        return criteria

    if kind == "pattern":
        if asset.startswith("DQUAL"):
            ok = "M8 14h48M8 26h48M8 38h48M8 50h48" in svg and "M14 8v48M30 8v48M46 8v48" in svg
        else:
            ok = "M-4 56L56-4M8 68L68 8" in svg
        criteria.append(Criterion(
            "semantic_pattern_tile", ok,
            "pattern tile geometry present" if ok else "wrong/non-tileable pattern",
        ))
        return criteria

    if kind == "conditional-procedure":
        ok = 'rect x="13" y="13" width="38" height="38"' in svg and "M21 32h22M32 21v22" in svg
        criteria.append(Criterion(
            "semantic_conditional_marker", ok,
            "conditional marker frame/cross present" if ok else "wrong conditional marker",
        ))
        return criteria

    if family == "lights_daymarks_topmarks":
        token = "green" if "green" in scale125_generate._tokens(entry) else "red" if "red" in scale125_generate._tokens(entry) else "yellow"
        flare = f'<circle cx="32" cy="32" r="8" fill="var(--{token})"/>' in svg and "M32 32 L32 9" in svg
        criteria.append(Criterion(
            "semantic_light_flare", flare,
            f"light/daymark flare {token}" if flare else f"missing/wrong light flare {token}",
        ))
        return criteria

    if family == "wreck_rock_obstruction":
        snippets = [
            'ellipse cx="32" cy="34" rx="23" ry="13"',
            "M18 42h28M24 42V26M32 42V22M40 42V29",
            'stroke="var(--black)"',
        ]
        ok = _has_all(svg, snippets)
        criteria.append(Criterion(
            "semantic_obstruction_family", ok,
            "wreck/rock/obstruction danger cue present" if ok else "wrong wreck/rock/obstruction cue",
        ))
        return criteria

    if family == "areas_patterns_lines":
        ok = 'rect x="14" y="14" width="36" height="36"' in svg and "M14 50L50 14M4 40L40 4M24 60L60 24" in svg
        criteria.append(Criterion(
            "semantic_area_boundary_pattern", ok,
            "area boundary/pattern present" if ok else "wrong area boundary/pattern",
        ))
        return criteria

    token = _first_token(entry)
    ok = f'<rect x="22" y="22" width="20" height="30" rx="3" fill="var(--{token})"' in svg
    criteria.append(Criterion(
        "semantic_symbol_colour", ok,
        f"default symbol colour {token}" if ok else f"wrong default symbol colour {token}",
    ))
    return criteria


def _reason_codes(criteria: list[Criterion]) -> list[str]:
    mapping = {
        "semantic_cardinal_topmark": "wrong_cardinal_orientation",
        "semantic_cardinal_colour_order": "wrong_cardinal_colour_order",
        "semantic_lateral_shape": "wrong_lateral_shape",
        "semantic_lateral_colour": "wrong_lateral_colour",
        "semantic_light_flare": "missing_or_wrong_light_flare",
        "semantic_obstruction_family": "wrong_obstruction_family",
        "semantic_line_geometry": "wrong_line_geometry",
        "semantic_line_dash": "wrong_line_cadence",
        "semantic_pattern_tile": "wrong_pattern_tile",
        "semantic_conditional_marker": "wrong_conditional_marker",
        "semantic_area_boundary_pattern": "wrong_area_pattern",
        "semantic_symbol_colour": "wrong_symbol_colour",
    }
    codes = [mapping.get(c.name, c.name) for c in criteria if not c.passed]
    return list(dict.fromkeys(codes)) or ["semantic_reject"]


def _swap_colour(svg: str, a: str, b: str) -> str:
    marker = "__FORGE_TMP_COLOUR__"
    return svg.replace(f"var(--{a})", marker).replace(f"var(--{b})", f"var(--{a})").replace(marker, f"var(--{b})")


def _broken_svg(entry: dict, svg: str) -> tuple[str, str]:
    asset = entry["asset"]
    family = entry["family"]
    kind = entry["asset_kind"]
    reasons = set(entry["stress_reasons"])

    if "cardinal_orientation" in reasons:
        suffix = _suffix(entry)
        sibling = {"01": "03", "02": "04", "03": "01", "04": "02"}[suffix]
        return f"broken:flip_cardinal_to_{sibling}", svg.replace(TOPMARK[suffix], TOPMARK[sibling])

    if "lateral_region_colour_shape" in reasons:
        if "red" in scale125_generate._tokens(entry):
            return "broken:swap_lateral_red_green", _swap_colour(svg, "red", "green")
        if "green" in scale125_generate._tokens(entry):
            return "broken:swap_lateral_green_red", _swap_colour(svg, "green", "red")
        return "broken:drop_lateral_body", re.sub(r'<(path|rect)[^>]+(M32 22l-13 31h26z|x="23" y="24")[^>]*/>', "", svg, count=1)

    if kind == "line-style":
        if "DOTT" in asset.upper():
            return "broken:wrong_dotted_cadence", svg.replace('stroke-dasharray="1 5"', 'stroke-dasharray="5 4"')
        if "DASH" in asset.upper():
            return "broken:wrong_dashed_cadence", svg.replace('stroke-dasharray="5 4"', 'stroke-dasharray="1 5"')
        return "broken:drop_line_baseline", svg.replace("M8 32h48", "M14 32h36", 1)

    if kind == "pattern":
        return "broken:break_pattern_tile", svg.replace("M8 14h48M8 26h48M8 38h48M8 50h48", "M8 14h30", 1).replace("M-4 56L56-4M8 68L68 8", "M8 56L56 8", 1)

    if kind == "conditional-procedure":
        return "broken:drop_conditional_cross", svg.replace("M21 32h22M32 21v22", "M21 32h22", 1)

    if family == "lights_daymarks_topmarks":
        return "broken:drop_light_primary_ray", svg.replace('<path d="M32 32 L32 9"', '<path d="M32 32 L32 18"', 1)

    if family == "wreck_rock_obstruction":
        return "broken:drop_obstruction_masts", svg.replace("M18 42h28M24 42V26M32 42V22M40 42V29", "M18 42h28", 1)

    if family == "areas_patterns_lines":
        return "broken:drop_area_hatch", svg.replace("M14 50L50 14M4 40L40 4M24 60L60 24", "M14 50L50 14", 1)

    token = _first_token(entry)
    swap = "red" if token != "red" else "green"
    return f"broken:wrong_symbol_colour_{swap}", svg.replace(f'fill="var(--{token})"', f'fill="var(--{swap})"', 1)


def _evaluate(entry: dict, style: StylePack, svg: str, case: str, expected: str) -> QaRow:
    spec = scale125_generate._spec(entry)
    criteria = verify.structural(svg, spec, style, style.palettes["day"]) + _semantic(entry, svg)
    accepted = all(c.passed for c in criteria)
    observed = "accept" if accepted else "reject"
    return QaRow(
        asset=entry["asset"],
        style=style.id,
        family=entry["family"],
        asset_kind=entry["asset_kind"],
        case=case,
        expected=expected,
        observed=observed,
        passed=observed == expected,
        reason_codes=[] if accepted else _reason_codes(criteria),
        criteria=[asdict(c) for c in criteria],
    )


def main() -> int:
    gen_rc = scale125_generate.main()
    if gen_rc:
        return gen_rc

    catalog = json.loads(CATALOG.read_text())
    styles = _styles()
    rows: list[QaRow] = []
    hard_pile = []

    for entry in catalog["entries"]:
        for style in styles.values():
            svg_path = SVG_OUT / style.id / f"{scale125_generate._slug(entry['asset'])}.svg"
            svg = svg_path.read_text()

            row = _evaluate(entry, style, svg, "valid", "accept")
            rows.append(row)
            if row.observed == "reject":
                hard_pile.append(asdict(row))

            case, bad_svg = _broken_svg(entry, svg)
            bad_row = _evaluate(entry, style, bad_svg, case, "reject")
            rows.append(bad_row)
            if bad_row.observed == "reject":
                hard_pile.append(asdict(bad_row))

    valid = [r for r in rows if r.case == "valid"]
    broken = [r for r in rows if r.case.startswith("broken:")]
    family_coverage = {
        family: {
            "valid_cases": sum(1 for r in valid if r.family == family),
            "broken_cases": sum(1 for r in broken if r.family == family),
            "valid_accepts": sum(1 for r in valid if r.family == family and r.observed == "accept"),
            "broken_rejects": sum(1 for r in broken if r.family == family and r.observed == "reject"),
        }
        for family in FAMILIES
    }
    report = {
        "status": "pass" if all(r.passed for r in rows) else "fail",
        "assets": catalog["selected_assets"],
        "styles": len(styles),
        "fixture_valid_cases": len(valid),
        "valid_accepts": sum(1 for r in valid if r.observed == "accept"),
        "valid_total": len(valid),
        "broken_rejects": sum(1 for r in broken if r.observed == "reject"),
        "broken_total": len(broken),
        "family_coverage": family_coverage,
        "hard_pile_entries": len(hard_pile),
        "rows": [asdict(r) for r in rows],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "semantic_report.json").write_text(json.dumps(report, indent=2))
    (OUT / "semantic_hard_pile.json").write_text(json.dumps(hard_pile, indent=2))

    print(f"scale125 semantic QA: {report['status'].upper()}")
    print(f"valid accepts: {report['valid_accepts']}/{report['valid_total']}")
    print(f"broken rejects: {report['broken_rejects']}/{report['broken_total']}")
    print(f"family coverage: {family_coverage}")
    print(f"semantic hard pile entries: {len(hard_pile)} -> {OUT / 'semantic_hard_pile.json'}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
