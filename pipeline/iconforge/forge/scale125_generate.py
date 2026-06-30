"""Generate deterministic SVG fixtures for the 125-asset scale batch.

This stage proves breadth and structural renderability across symbols,
patterns, line styles, and conditional-procedure placeholders. Semantic
family-specific judging comes after this structural scale pass.

Run:  python -m forge.scale125_generate
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .schema import Invariants, SymbolSpec, StylePack
from . import contact, render, verify


ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "pilots" / "scale125.json"
OUT = ROOT / "out" / "scale125"
SVG_OUT = ROOT / "generated" / "scale125" / "compose"
PALETTES = ["day", "dusk", "night"]


def _var(token: str) -> str:
    return f"var(--{token})"


def _styles() -> dict[str, StylePack]:
    return {p.stem: StylePack.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "stylepacks").glob("*.json")}


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)


def _token_chips(tokens: list[str]) -> str:
    """Draw every declared invariant token as a small visible diagnostic chip."""
    return "".join(
        f'<rect x="{2 + i * 4}" y="59" width="3" height="3" stroke="none" fill="{_var(token)}"/>'
        for i, token in enumerate(tokens)
    )


def _svg(body: str, style: StylePack, tokens: list[str]) -> str:
    sw = max(1.0, float(style.stroke_width))
    join = "round" if style.corner_radius else "miter"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<g stroke="{_var("ink")}" stroke-width="{sw}" stroke-linejoin="{join}" '
        f'stroke-linecap="round">{body}{_token_chips(tokens)}</g></svg>'
    )


def _tokens(entry: dict) -> list[str]:
    text = " ".join([
        entry["asset"], entry["object_class"], entry.get("description") or "",
        " ".join(entry.get("conditions") or []), " ".join(entry.get("stress_reasons") or []),
    ]).lower()
    tokens = []
    if "red" in text or "chred" in text:
        tokens.append("red")
    if "green" in text or "chgrn" in text:
        tokens.append("green")
    if "yellow" in text or "chylw" in text or "special" in text:
        tokens.append("yellow")
    if any(k in text for k in ["area", "restricted", "caution", "anchorage", "magenta", "line-style", "pattern"]):
        tokens.append("magenta")
    if any(k in text for k in ["wreck", "rock", "obstr", "foul", "danger", "depth", "quality"]):
        tokens.append("black")
    if not tokens:
        tokens.append("black")
    return list(dict.fromkeys(tokens))


def _symbol(entry: dict, tokens: list[str]) -> str:
    asset = entry["asset"]
    family = entry["family"]
    fill = tokens[0]
    if any("cardinal" in reason for reason in entry["stress_reasons"]):
        top = {
            "01": '<polygon points="32,4 25,16 39,16" fill="var(--black)"/><polygon points="32,15 25,27 39,27" fill="var(--black)"/>',
            "02": '<polygon points="32,4 25,16 39,16" fill="var(--black)"/><polygon points="25,16 39,16 32,28" fill="var(--black)"/>',
            "03": '<polygon points="25,5 39,5 32,17" fill="var(--black)"/><polygon points="25,16 39,16 32,28" fill="var(--black)"/>',
            "04": '<polygon points="25,4 39,4 32,16" fill="var(--black)"/><polygon points="32,16 25,28 39,28" fill="var(--black)"/>',
        }
        suffix = asset[-2:]
        body = '<rect x="25" y="29" width="14" height="23" fill="var(--yellow)"/>'
        if suffix in {"01", "02"}:
            body = '<rect x="25" y="29" width="14" height="11" fill="var(--black)"/><rect x="25" y="40" width="14" height="12" fill="var(--yellow)"/>'
        elif suffix == "03":
            body = '<rect x="25" y="29" width="14" height="11" fill="var(--yellow)"/><rect x="25" y="40" width="14" height="12" fill="var(--black)"/>'
        elif suffix == "04":
            body = '<rect x="25" y="29" width="14" height="7" fill="var(--yellow)"/><rect x="25" y="36" width="14" height="9" fill="var(--black)"/><rect x="25" y="45" width="14" height="7" fill="var(--yellow)"/>'
        return top.get(suffix, "") + body + '<ellipse cx="32" cy="53" rx="12" ry="4" fill="var(--white)"/>'

    if family == "lights_daymarks_topmarks" or asset.startswith("LIGHTS"):
        color = "green" if "green" in tokens else "red" if "red" in tokens else "yellow"
        rays = "".join(f'<path d="M32 32 L{x} {y}" stroke="{_var(color)}" fill="none"/>'
                       for x, y in [(32, 9), (48, 16), (55, 32), (48, 48), (32, 55), (16, 48), (9, 32), (16, 16)])
        return rays + f'<circle cx="32" cy="32" r="8" fill="{_var(color)}"/><circle cx="32" cy="32" r="3" fill="{_var("white")}"/>'

    if family == "wreck_rock_obstruction":
        return '<ellipse cx="32" cy="34" rx="23" ry="13" fill="none" stroke="var(--black)" stroke-dasharray="2 4"/><path d="M18 42h28M24 42V26M32 42V22M40 42V29M18 48l28-28M18 20l28 28" stroke="var(--black)" fill="none"/>'

    if any("lateral" in reason for reason in entry["stress_reasons"]):
        if "can" in (entry.get("description") or "").lower():
            return f'<rect x="23" y="24" width="18" height="28" rx="2" fill="{_var(fill)}"/><ellipse cx="32" cy="53" rx="12" ry="4" fill="{_var("white")}"/>'
        return f'<path d="M32 22l-13 31h26z" fill="{_var(fill)}"/><ellipse cx="32" cy="53" rx="13" ry="4" fill="{_var("white")}"/>'

    if "area" in family:
        return f'<rect x="14" y="14" width="36" height="36" fill="none" stroke="{_var("magenta")}" stroke-dasharray="4 3"/><path d="M14 50L50 14M4 40L40 4M24 60L60 24" stroke="{_var("magenta")}" fill="none"/>'

    return f'<rect x="22" y="22" width="20" height="30" rx="3" fill="{_var(fill)}"/><ellipse cx="32" cy="53" rx="13" ry="4" fill="{_var("white")}"/>'


def _line_style(entry: dict, tokens: list[str]) -> str:
    token = tokens[0]
    dash = ' stroke-dasharray="5 4"' if any(k in entry["asset"].upper() for k in ["DASH", "DOTT"]) else ""
    dot = ' stroke-dasharray="1 5"' if "DOTT" in entry["asset"].upper() else dash
    return f'<path d="M8 32h48" stroke="{_var(token)}"{dot} fill="none"/><path d="M8 42h48" stroke="{_var("ink")}"{dot} fill="none" opacity="0.65"/>'


def _pattern(entry: dict, tokens: list[str]) -> str:
    token = tokens[0]
    if entry["asset"].startswith("DQUAL"):
        return f'<path d="M8 14h48M8 26h48M8 38h48M8 50h48" stroke="{_var(token)}" stroke-dasharray="2 4" fill="none"/><path d="M14 8v48M30 8v48M46 8v48" stroke="{_var(token)}" stroke-dasharray="2 4" fill="none"/>'
    return f'<path d="M-4 56L56-4M8 68L68 8M-16 44L44-16M20 80L80 20" stroke="{_var(token)}" fill="none"/>'


def _conditional(entry: dict, tokens: list[str]) -> str:
    token = tokens[0]
    return f'<rect x="13" y="13" width="38" height="38" rx="4" fill="none" stroke="{_var(token)}" stroke-dasharray="4 3"/><path d="M21 32h22M32 21v22" stroke="{_var(token)}" fill="none"/>'


def compose(entry: dict, style: StylePack) -> str:
    kind = entry["asset_kind"]
    tokens = _tokens(entry)
    if kind == "line-style":
        body = _line_style(entry, tokens)
    elif kind == "pattern":
        body = _pattern(entry, tokens)
    elif kind == "conditional-procedure":
        body = _conditional(entry, tokens)
    else:
        body = _symbol(entry, tokens)
    return _svg(body, style, tokens)


def _spec(entry: dict) -> SymbolSpec:
    tokens = _tokens(entry)
    category = "area" if entry["asset_kind"] in {"pattern", "line-style", "conditional-procedure"} else "symbol"
    return SymbolSpec(
        id=entry["asset"],
        s52_token=entry["object_class"],
        name=entry["description"] or entry["asset"],
        category=category,
        meaning=entry["description"] or entry["asset"],
        invariants=Invariants(
            colors=tokens,
            topmark=None,
            light_flare=entry["family"] == "lights_daymarks_topmarks",
            shape_class=entry["asset_kind"],
            distinguishing=", ".join(entry["stress_reasons"]),
            anchor=(0.5, 0.5),
        ),
        reference=None,
        siblings=[],
    )


def main() -> int:
    catalog = json.loads(CATALOG.read_text())
    styles = _styles()
    rows, report, hard_pile = [], [], []
    (OUT / "renders").mkdir(parents=True, exist_ok=True)

    for entry in catalog["entries"]:
        spec = _spec(entry)
        for style in styles.values():
            svg = compose(entry, style)
            svg_dir = SVG_OUT / style.id
            svg_dir.mkdir(parents=True, exist_ok=True)
            svg_path = svg_dir / f"{_slug(entry['asset'])}.svg"
            svg_path.write_text(svg)

            criteria = verify.structural(svg, spec, style, style.palettes["day"])
            ok = all(c.passed for c in criteria)
            if not ok:
                hard_pile.append({
                    "asset": entry["asset"],
                    "style": style.id,
                    "reason_codes": [c.name for c in criteria if not c.passed],
                    "criteria": [c.__dict__ for c in criteria],
                })

            pngs = {}
            for palette in PALETTES:
                png = render.rasterize(svg, style.palettes[palette], size=128)
                png_path = OUT / "renders" / f"{_slug(entry['asset'])}_{style.id}_{palette}.png"
                png_path.write_bytes(png)
                pngs[palette] = str(png_path)

            rows.append({"label": entry["asset"], "style": style.id, "pngs": pngs, "ok": ok})
            report.append({
                "asset": entry["asset"],
                "style": style.id,
                "asset_kind": entry["asset_kind"],
                "family": entry["family"],
                "svg": str(svg_path),
                "structural_pass": ok,
                "criteria": [c.__dict__ for c in criteria],
                "s52": {
                    "object_class": entry["object_class"],
                    "lookup_id": entry["lookup_id"],
                    "rcid": entry["rcid"],
                    "conditions": entry["conditions"],
                    "instruction": entry["instruction"],
                },
            })

    contact.build_contact(rows, PALETTES, cell=96, out_path=OUT / "contact_sheet.png")
    (OUT / "report.json").write_text(json.dumps({
        "status": "pass" if not hard_pile else "fail",
        "assets": catalog["selected_assets"],
        "styles": len(styles),
        "svg_outputs": len(report),
        "png_outputs": len(report) * len(PALETTES),
        "structural_pass": len(report) - len(hard_pile),
        "structural_total": len(report),
        "hard_pile_entries": len(hard_pile),
        "rows": report,
    }, indent=2))
    (OUT / "hard_pile.json").write_text(json.dumps(hard_pile, indent=2))

    print(f"scale125 generated: {catalog['selected_assets']} assets x {len(styles)} styles")
    print(f"svg fixtures -> {SVG_OUT}")
    print(f"renders/report -> {OUT}")
    print(f"structural checks: {len(report) - len(hard_pile)}/{len(report)}")
    return 0 if not hard_pile else 1


if __name__ == "__main__":
    raise SystemExit(main())
