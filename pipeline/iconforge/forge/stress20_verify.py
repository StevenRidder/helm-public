"""Semantic QA and hard-pile reporting for the 20-symbol stress pilot.

The generator's structural checks prove SVG hygiene. This stage checks the
load-bearing semantics that make a nautical symbol safe: orientation, colour
order, body class, danger class, area identity, and light flare presence. It
also runs deliberate broken cases and requires them to reject.

Run:  python -m forge.stress20_verify
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from .schema import Criterion, StylePack
from . import stress20_generate, verify


ROOT = Path(__file__).resolve().parent.parent
PILOT = ROOT / "pilots" / "stress20.json"
OUT = ROOT / "out" / "stress20"
SVG_OUT = ROOT / "generated" / "stress20" / "compose"

TOPMARK = {
    "two_cones_point_up": ["32,4 25,16 39,16", "32,15 25,27 39,27"],
    "two_cones_point_down": ["25,5 39,5 32,17", "25,16 39,16 32,28"],
    "two_cones_base_to_base": ["32,4 25,16 39,16", "25,16 39,16 32,28"],
    "two_cones_point_to_point": ["25,4 39,4 32,16", "32,16 25,28 39,28"],
    "single_sphere": ['circle cx="32" cy="10" r="5.5" fill="var(--red)"'],
}

SHAPE = {
    "beacon": ['rect x="26" y="27" width="12" height="26"', "M24 56h16M28 53l-5 5h18l-5-5"],
    "buoy": ['rect x="24" y="25" width="16" height="27"', 'ellipse cx="32" cy="53"'],
    "conical_buoy": ["M32 24l-13 29h26z"],
    "can_buoy": ['rect x="23" y="26" width="18" height="26"'],
    "wreck": ["M18 40h28M25 40V25M32 40V21M39 40V27"],
    "wreck_danger_oval": ['ellipse cx="32" cy="35" rx="24" ry="14"', 'stroke-dasharray="1.5 4"'],
    "underwater_rock": ["M17 42l7-17 8 10 7-14 9 21z"],
    "obstruction": ["M18 44h28M22 36h20M25 28h14M32 20v28"],
    "light_flare": ['circle cx="32" cy="32" r="8" fill="var(--red)"', "M32 32 L32 9"],
}

AREA = {
    "RESARE_pattern": ["M-4 56L56-4", "M8 68L68 8"],
    "ACHARE_pattern": ['circle cx="32" cy="31" r="13"', "M32 16v30M22 31h20"],
    "CTNARE_pattern": ["M32 12l22 40H10z", "M32 25v13M32 45v1"],
}


@dataclass
class QaRow:
    id: str
    style: str
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


def _positions(svg: str, token: str) -> list[int]:
    needle = f"var(--{token})"
    out = []
    start = 0
    while True:
        i = svg.find(needle, start)
        if i < 0:
            return out
        out.append(i)
        start = i + len(needle)


def _colour_order_ok(entry: dict, svg: str, colors: list[str]) -> bool:
    if len(colors) < 2:
        return True
    if entry["id"] == "BOYSAW":
        return True
    rect_fills = re.findall(r'<rect[^>]+fill="var\(--([a-z_]+)\)"', svg)
    if rect_fills:
        body = []
        for fill in rect_fills:
            if fill != "white" and (not body or body[-1] != fill):
                body.append(fill)
        if body:
            return body[:len(colors)] == colors
    positions = []
    for color in colors:
        hits = _positions(svg, color)
        if not hits:
            return False
        positions.append(hits[0])
    return positions == sorted(positions)


def semantic(entry: dict, svg: str) -> list[Criterion]:
    inv = entry["invariants"]
    out: list[Criterion] = []

    topmark = inv.get("topmark")
    if topmark:
        ok = _has_all(svg, TOPMARK[topmark])
        out.append(Criterion("semantic_topmark", ok, topmark if ok else f"missing/wrong {topmark}"))

    shape = inv["shape"]
    if entry["id"] == "BOYSAW":
        snippets = TOPMARK["single_sphere"] + [
            'rect x="23" y="23" width="18" height="29"',
            'rect x="24" y="24" width="5" height="27" fill="var(--red)"',
            'rect x="35" y="24" width="5" height="27" fill="var(--red)"',
            'ellipse cx="32" cy="53"',
        ]
    elif shape == "area_pattern":
        snippets = AREA[entry["id"]]
    else:
        snippets = SHAPE[shape]
    ok_shape = _has_all(svg, snippets)
    out.append(Criterion("semantic_shape_class", ok_shape, shape if ok_shape else f"missing/wrong {shape}"))

    ok_order = _colour_order_ok(entry, svg, inv["colors"])
    out.append(Criterion("semantic_colour_order", ok_order,
                         "colour order matches invariants" if ok_order else f"wrong colour order: {inv['colors']}"))

    if inv.get("light_flare"):
        flare = _has_all(svg, SHAPE["light_flare"])
        out.append(Criterion("semantic_light_flare", flare,
                             "flare present" if flare else "missing light flare"))

    if shape == "wreck":
        no_danger_oval = 'ellipse cx="32" cy="35" rx="24" ry="14"' not in svg
        out.append(Criterion("semantic_danger_class", no_danger_oval,
                             "non-dangerous wreck has no danger oval" if no_danger_oval else "unexpected danger oval"))
    if shape == "wreck_danger_oval":
        has_danger_oval = 'ellipse cx="32" cy="35" rx="24" ry="14"' in svg
        out.append(Criterion("semantic_danger_class", has_danger_oval,
                             "dangerous wreck has danger oval" if has_danger_oval else "missing danger oval"))

    return out


def _reason_codes(criteria: list[Criterion], entry: dict) -> list[str]:
    codes = []
    for c in criteria:
        if c.passed:
            continue
        if c.name == "semantic_topmark":
            codes.append("wrong_cardinal_orientation" if "cardinal" in " ".join(entry["stress_class"]) else "missing_topmark")
        elif c.name == "semantic_colour_order":
            stress = " ".join(entry["stress_class"])
            codes.append("wrong_cardinal_colour_order" if "cardinal" in stress else "wrong_lateral_colour")
        elif c.name == "semantic_shape_class":
            if "rock_obstruction_wreck_confusion" in entry["stress_class"]:
                codes.append("wrong_obstruction_family")
            elif "area_pattern_restricted_anchorage_caution" in entry["stress_class"]:
                codes.append("wrong_pattern_family")
            else:
                codes.append("wrong_mark_body")
        elif c.name == "semantic_danger_class":
            codes.append("wrong_danger_class")
        elif c.name == "semantic_light_flare":
            codes.append("missing_light_flare")
        else:
            codes.append(c.name)
    allowed = set(entry["hard_pile_codes"]) | {
        "missing_topmark", "wrong_lateral_colour", "wrong_mark_body",
        "wrong_obstruction_family", "wrong_pattern_family",
    }
    return [c for c in dict.fromkeys(codes) if c in allowed] or ["semantic_reject"]


def _mutated(entry: dict, failure: str) -> dict:
    e = copy.deepcopy(entry)
    inv = e["invariants"]
    if failure in {"flip_topmark_down", "flip_topmark_up"}:
        inv["topmark"] = "two_cones_point_down" if failure.endswith("down") else "two_cones_point_up"
    elif failure == "flip_to_west_topmark":
        inv["topmark"] = "two_cones_point_to_point"
    elif failure == "flip_to_east_topmark":
        inv["topmark"] = "two_cones_base_to_base"
    elif failure.startswith("swap_") or failure in {"wrong_light_colour", "swap_to_lateral_colour"}:
        swaps = {"black": "yellow", "yellow": "black", "red": "green", "green": "red"}
        inv["colors"] = [swaps.get(c, "red" if c == "yellow" else c) for c in inv["colors"]]
    elif failure == "drop_middle_black_band":
        inv["colors"] = ["yellow"]
    elif failure in {"render_as_buoy", "render_as_conical"}:
        inv["shape"] = "buoy" if failure == "render_as_buoy" else "conical_buoy"
    elif failure == "render_as_can":
        inv["shape"] = "can_buoy"
    elif failure == "render_as_rock":
        inv["shape"] = "underwater_rock"
    elif failure == "render_as_wreck":
        inv["shape"] = "wreck"
    elif failure == "add_danger_oval":
        inv["shape"] = "wreck_danger_oval"
    elif failure in {"drop_danger_oval", "drop_danger_cue"}:
        inv["shape"] = "wreck"
    elif failure in {"drop_sphere_topmark", "missing_flare"}:
        inv["topmark"] = None
        inv["light_flare"] = False
    elif failure == "horizontal_stripes":
        inv["colors"] = list(reversed(inv["colors"]))
    elif failure in {"render_as_restricted_area", "wrong_area_symbol"}:
        e["id"] = "RESARE_pattern"
    elif failure == "render_as_anchorage_area":
        e["id"] = "ACHARE_pattern"
    elif failure == "wrong_area_colour":
        inv["colors"] = ["red"]
    elif failure == "non_tileable_pattern":
        e["id"] = "CTNARE_pattern"
    return e


def _mutate_svg(svg: str, failure: str) -> str:
    if failure == "wrong_area_colour":
        return svg.replace("var(--magenta)", "var(--red)")
    if failure == "wrong_light_colour":
        return svg.replace("var(--red)", "var(--green)")
    if failure == "drop_sphere_topmark":
        return svg.replace('<circle cx="32" cy="10" r="5.5" fill="var(--red)"/>', "")
    if failure == "horizontal_stripes":
        svg = svg.replace('<rect x="24" y="24" width="5" height="27" fill="var(--red)"/>', '<rect x="24" y="27" width="16" height="5" fill="var(--red)"/>')
        return svg.replace('<rect x="35" y="24" width="5" height="27" fill="var(--red)"/>', '<rect x="24" y="39" width="16" height="5" fill="var(--red)"/>')
    return svg


def _evaluate(entry: dict, style: StylePack, svg: str, case: str, expected: str) -> QaRow:
    spec = stress20_generate._spec_from_entry(entry)
    criteria = verify.structural(svg, spec, style, style.palettes["day"]) + semantic(entry, svg)
    accepted = all(c.passed for c in criteria)
    observed = "accept" if accepted else "reject"
    passed = observed == expected
    return QaRow(
        id=entry["id"],
        style=style.id,
        case=case,
        expected=expected,
        observed=observed,
        passed=passed,
        reason_codes=[] if accepted else _reason_codes(criteria, entry),
        criteria=[asdict(c) for c in criteria],
    )


def main() -> int:
    # Regenerate first so verification always uses fixtures from current code.
    gen_rc = stress20_generate.main()
    if gen_rc:
        return gen_rc

    pilot = json.loads(PILOT.read_text())
    styles = _styles()
    rows: list[QaRow] = []
    hard_pile = []

    for entry in pilot["entries"]:
        for style in styles.values():
            svg_path = SVG_OUT / style.id / f"{entry['id']}.svg"
            row = _evaluate(entry, style, svg_path.read_text(), "valid", "accept")
            rows.append(row)
            if row.observed == "reject":
                hard_pile.append(asdict(row))

            for failure in entry["deliberate_failures"]:
                bad_entry = _mutated(entry, failure)
                bad_svg = _mutate_svg(stress20_generate.compose(bad_entry, style), failure)
                bad_row = _evaluate(entry, style, bad_svg, f"broken:{failure}", "reject")
                rows.append(bad_row)
                if bad_row.observed == "reject":
                    hard_pile.append(asdict(bad_row))

    valid = [r for r in rows if r.case == "valid"]
    broken = [r for r in rows if r.case.startswith("broken:")]
    report = {
        "status": "pass" if all(r.passed for r in rows) else "fail",
        "valid_accepts": sum(1 for r in valid if r.observed == "accept"),
        "valid_total": len(valid),
        "broken_rejects": sum(1 for r in broken if r.observed == "reject"),
        "broken_total": len(broken),
        "rows": [asdict(r) for r in rows],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "semantic_report.json").write_text(json.dumps(report, indent=2))
    (OUT / "hard_pile.json").write_text(json.dumps(hard_pile, indent=2))

    print(f"stress20 semantic QA: {report['status'].upper()}")
    print(f"valid accepts: {report['valid_accepts']}/{report['valid_total']}")
    print(f"broken rejects: {report['broken_rejects']}/{report['broken_total']}")
    print(f"hard pile entries: {len(hard_pile)} -> {OUT / 'hard_pile.json'}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
