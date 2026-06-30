"""Seed the POC's recorded model output (FORGE-2 catalog, FORGE-3/4 compose,
FORGE-6 verdicts).

The SVGs here are claude-opus-4-8 output for the compose stage, authored from a
small shared set of primitives (cones, pillar bodies, bases) so the five-symbol
family reads as one coherent set and the two styles differ only on the
non-semantic axis. Stored as fixtures so the POC runs offline; the live path
(model.LiveModel) fetches the equivalent over the API.

Run:  python -m forge._seed_fixtures
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------- styles ----
STYLES = {
    "us-paper": dict(
        id="us-paper", stroke_width=1.4, corner_radius=0, fill_mode="filled",
        line_treatment="crisp", shadow=False,
        palettes={
            "day":   {"black": "#1b1b1b", "yellow": "#f2c200", "red": "#d21f26",
                      "white": "#ffffff", "magenta": "#c2249a", "ink": "#1b1b1b"},
            "dusk":  {"black": "#2b2b33", "yellow": "#c7a32a", "red": "#ad353e",
                      "white": "#e7e5de", "magenta": "#97417f", "ink": "#2b2b33"},
            "night": {"black": "#3a3a44", "yellow": "#6c6322", "red": "#79313a",
                      "white": "#8b8881", "magenta": "#5d3a57", "ink": "#6a6a74"},
        }),
    "open-bridge": dict(
        id="open-bridge", stroke_width=2.6, corner_radius=4, fill_mode="filled",
        line_treatment="soft", shadow=False,
        palettes={
            "day":   {"black": "#23201c", "yellow": "#e8b53b", "red": "#cf3b32",
                      "white": "#f7f3ea", "magenta": "#b23a86", "ink": "#23201c"},
            "dusk":  {"black": "#2e2a30", "yellow": "#bf9a3a", "red": "#a8474a",
                      "white": "#e4ddcf", "magenta": "#8f4a78", "ink": "#2e2a30"},
            "night": {"black": "#3c3942", "yellow": "#6f5f2a", "red": "#743a3e",
                      "white": "#87837a", "magenta": "#5b3f56", "ink": "#6a6470"},
        }),
}

# --------------------------------------------------------------- catalog ----
SPECS = [
    dict(id="BOYCAR_north", s52_token="BOYCAR", name="North cardinal buoy",
         category="buoy",
         meaning="Pass to the north of this mark; safe water lies to the north.",
         invariants=dict(colors=["black", "yellow"], topmark="two_cones_point_up",
                         light_flare=False, shape_class="buoy",
                         distinguishing="black above yellow; topmark two cones BOTH points up",
                         anchor=[0.5, 0.84]),
         reference=None, siblings=["BOYCAR_south", "BOYCAR_east", "BOYCAR_west"]),
    dict(id="BCNCAR_south", s52_token="BCNCAR", name="South cardinal beacon",
         category="beacon",
         meaning="Pass to the south of this mark; safe water lies to the south.",
         invariants=dict(colors=["yellow", "black"], topmark="two_cones_point_down",
                         light_flare=False, shape_class="beacon",
                         distinguishing="yellow above black; topmark two cones BOTH points down; fixed beacon on a base",
                         anchor=[0.5, 0.88]),
         reference=None, siblings=["BCNCAR_north", "BCNCAR_east", "BCNCAR_west"]),
    dict(id="BOYSAW", s52_token="BOYSAW", name="Safe water mark buoy",
         category="buoy",
         meaning="Navigable water all around; mid-channel or landfall mark.",
         invariants=dict(colors=["red", "white"], topmark="single_sphere",
                         light_flare=False, shape_class="buoy",
                         distinguishing="red and white VERTICAL stripes; single red sphere topmark",
                         anchor=[0.5, 0.84]),
         reference=None, siblings=["BOYISD", "BOYSPP", "BOYLAT_port"]),
    dict(id="RESARE_pattern", s52_token="RESARE", name="Restricted area pattern",
         category="area",
         meaning="Entry/activity restricted; magenta-tagged area fill.",
         invariants=dict(colors=["magenta"], topmark=None, light_flare=False,
                         shape_class="area_pattern",
                         distinguishing="tileable magenta diagonal hatch",
                         anchor=[0.5, 0.5]),
         reference=None, siblings=["ACHARE_pattern", "CTNARE_pattern"]),
    dict(id="WRECKS_dangerous", s52_token="WRECKS", name="Dangerous wreck",
         category="danger",
         meaning="Wreck with < safety-clearance depth; dangerous to navigation.",
         invariants=dict(colors=["black"], topmark=None, light_flare=False,
                         shape_class="wreck",
                         distinguishing="hull-and-masts inside a DOTTED danger oval (dangerous variant)",
                         anchor=[0.5, 0.55]),
         reference=None, siblings=["WRECKS_nondangerous", "OBSTRN", "UWTROC"]),
]

# ------------------------------------------------- compose primitives -------
def _wrap(inner: str) -> str:
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            + inner + "</svg>")


def _cap(p):  # soft styles get rounded joins
    return ' stroke-linejoin="round" stroke-linecap="round"' if p["corner_radius"] else ""


def _cone(cx, top, w, h, up, fill, p):
    if up:
        pts = f"{cx},{top} {cx-w/2},{top+h} {cx+w/2},{top+h}"
    else:
        pts = f"{cx-w/2},{top} {cx+w/2},{top} {cx},{top+h}"
    return (f'<polygon points="{pts}" fill="var(--{fill})" '
            f'stroke="var(--ink)" stroke-width="{p["stroke_width"]}"{_cap(p)}/>')


def _rect(x, y, w, h, fill, p, outline=False):
    rx = p["corner_radius"] if outline else 0
    f = "none" if outline else f"var(--{fill})"
    s = (f' stroke="var(--ink)" stroke-width="{p["stroke_width"]}"' if outline else "")
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{f}"{s}{_cap(p)}/>'


def _base(p):
    return (f'<ellipse cx="32" cy="53" rx="9" ry="2.6" fill="var(--white)" '
            f'stroke="var(--ink)" stroke-width="{p["stroke_width"]}"/>')


def _mast(y0, y1, p):
    return (f'<line x1="32" y1="{y0}" x2="32" y2="{y1}" stroke="var(--ink)" '
            f'stroke-width="{p["stroke_width"]}"/>')


def build_north(p, broken=False):
    up = not broken  # broken: cones flipped down -> reads as a SOUTH cardinal
    return _wrap(
        _cone(32, 6, 12, 8, up, "black", p) + _cone(32, 15, 12, 8, up, "black", p)
        + _mast(23, 26, p)
        + _rect(24, 26, 16, 26, None, p, outline=True)
        + _rect(25, 27, 14, 12, "black", p) + _rect(25, 39, 14, 12, "yellow", p)
        + _base(p))


def build_south_beacon(p):
    mount = (f'<polygon points="22,56 42,56 32,48" fill="var(--ink)"/>')
    return _wrap(
        _cone(32, 6, 12, 8, False, "black", p) + _cone(32, 15, 12, 8, False, "black", p)
        + _mast(23, 26, p)
        + _rect(28, 26, 8, 25, None, p, outline=True)
        + _rect(29, 27, 6, 11, "yellow", p) + _rect(29, 38, 6, 12, "black", p)
        + mount)


def build_safewater(p):
    sphere = (f'<circle cx="32" cy="11" r="6" fill="var(--red)" '
              f'stroke="var(--ink)" stroke-width="{p["stroke_width"]}"/>')
    stripes = (_rect(25, 27, 3.5, 24, "red", p) + _rect(28.5, 27, 3.5, 24, "white", p)
               + _rect(32, 27, 3.5, 24, "red", p) + _rect(35.5, 27, 3.5, 24, "white", p))
    return _wrap(sphere + _mast(17, 26, p)
                 + _rect(24, 26, 16, 26, None, p, outline=True) + stripes + _base(p))


def build_restricted(p):
    sw = p["stroke_width"] + 0.4
    lines = "".join(
        f'<line x1="{off}" y1="0" x2="{off+64}" y2="64" stroke="var(--magenta)" '
        f'stroke-width="{sw}"/>' for off in (-32, -16, 0, 16, 32, 48))
    return _wrap(lines)


def build_wreck(p):
    # A black line symbol: the wreck is drawn in the load-bearing `black`
    # token (not `ink`), so the invariant colour is actually present.
    sw = p["stroke_width"]
    oval = (f'<ellipse cx="32" cy="36" rx="23" ry="16" fill="none" '
            f'stroke="var(--black)" stroke-width="{sw}" stroke-dasharray="1.6,3"/>')
    hull = (f'<path d="M16,42 Q32,49 48,42" fill="none" stroke="var(--black)" '
            f'stroke-width="{sw+0.3}"{_cap(p)}/>')
    masts = "".join(
        f'<line x1="{x}" y1="43" x2="{x}" y2="{ty}" stroke="var(--black)" stroke-width="{sw}"/>'
        f'<line x1="{x-3}" y1="{ty+3}" x2="{x+3}" y2="{ty+3}" stroke="var(--black)" stroke-width="{sw}"/>'
        for x, ty in ((23, 30), (32, 27), (41, 31)))
    return _wrap(oval + hull + masts)


BUILDERS = {
    "BOYCAR_north": build_north,
    "BCNCAR_south": build_south_beacon,
    "BOYSAW": build_safewater,
    "RESARE_pattern": build_restricted,
    "WRECKS_dangerous": build_wreck,
}

# ---------------------------------------------------- recorded verdicts -----
def pass_verdict(spec) -> dict:
    inv = spec["invariants"]
    crit = [{"name": "colours_correct", "passed": True,
             "reason": f"{', '.join(inv['colors'])} present; no wrong lateral colour"}]
    if inv["topmark"]:
        crit.append({"name": "topmark_correct", "passed": True,
                     "reason": f"topmark is {inv['topmark']}"})
    crit.append({"name": "light_flare", "passed": True,
                 "reason": f"flare present == {inv['light_flare']}"})
    crit.append({"name": "distinguishing_feature", "passed": True,
                 "reason": inv["distinguishing"]})
    return {"criteria": crit, "overall_pass": True, "confidence": 0.95,
            "sibling_pick": spec["id"]}


def broken_verdict() -> dict:
    return {"criteria": [
        {"name": "colours_correct", "passed": True,
         "reason": "black above yellow — colours fine"},
        {"name": "topmark_correct", "passed": False,
         "reason": "topmark cones point DOWN, not up — this reads as a SOUTH "
                   "cardinal. Wrong cardinal quadrant is a grounding hazard."},
        {"name": "light_flare", "passed": True, "reason": "no flare, correct"},
        {"name": "distinguishing_feature", "passed": False,
         "reason": "black-over-yellow with down-cones is contradictory"},
    ], "overall_pass": False, "confidence": 0.93,
        "sibling_pick": "BOYCAR_south"}


# --------------------------------------------------------------- emit -------
def main():
    (ROOT / "catalog").mkdir(exist_ok=True)
    (ROOT / "stylepacks").mkdir(exist_ok=True)
    for s in SPECS:
        (ROOT / "catalog" / f"{s['id']}.json").write_text(json.dumps(s, indent=2))
    for st in STYLES.values():
        (ROOT / "stylepacks" / f"{st['id']}.json").write_text(json.dumps(st, indent=2))

    for style_id, st in STYLES.items():
        cdir = ROOT / "fixtures" / "compose" / style_id
        vdir = ROOT / "fixtures" / "verdicts" / style_id
        cdir.mkdir(parents=True, exist_ok=True)
        vdir.mkdir(parents=True, exist_ok=True)
        for spec in SPECS:
            svg = BUILDERS[spec["id"]](st)
            (cdir / f"{spec['id']}.svg").write_text(svg)
            (vdir / f"{spec['id']}.json").write_text(json.dumps(pass_verdict(spec), indent=2))

    # the deliberately-broken case (us-paper only): north cardinal, cones flipped
    bdir_c = ROOT / "fixtures" / "compose" / "us-paper"
    bdir_v = ROOT / "fixtures" / "verdicts" / "us-paper"
    (bdir_c / "BOYCAR_north__BROKEN.svg").write_text(build_north(STYLES["us-paper"], broken=True))
    (bdir_v / "BOYCAR_north__BROKEN.json").write_text(json.dumps(broken_verdict(), indent=2))
    print("seeded catalog, stylepacks, compose SVGs, verdicts")


if __name__ == "__main__":
    main()
