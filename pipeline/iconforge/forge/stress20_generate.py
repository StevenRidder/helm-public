"""Generate deterministic SVG fixtures for the 20-symbol stress pilot.

This is a primitive composer, not an artwork finalizer. Its job is to exercise
the pipeline over the hard catalog classes with owned SVG that is palette-token
clean and structurally verifiable before FORGE-4 tightens semantic judging.

Run:  python -m forge.stress20_generate
"""
from __future__ import annotations

import json
from pathlib import Path

from .schema import Invariants, SymbolSpec, StylePack
from . import contact, render, verify

ROOT = Path(__file__).resolve().parent.parent
PILOT = ROOT / "pilots" / "stress20.json"
OUT = ROOT / "out" / "stress20"
SVG_OUT = ROOT / "generated" / "stress20" / "compose"
PALETTES = ["day", "dusk", "night"]


def _var(token: str) -> str:
    return f"var(--{token})"


def _uniq(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _style_attrs(style: StylePack) -> tuple[str, str]:
    sw = max(1.0, float(style.stroke_width))
    join = "round" if style.corner_radius else "miter"
    return str(sw), join


def _svg(body: str, style: StylePack) -> str:
    sw, join = _style_attrs(style)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<g stroke="{_var("ink")}" stroke-width="{sw}" stroke-linejoin="{join}" '
        f'stroke-linecap="round">{body}</g></svg>'
    )


def _poly(points: str, fill: str = "black") -> str:
    return f'<polygon points="{points}" fill="{_var(fill)}"/>'


def _cone(cx: float, y: float, direction: str, fill: str = "black") -> str:
    if direction == "up":
        pts = f"{cx},4 {cx - 7},17 {cx + 7},17"
    elif direction == "down":
        pts = f"{cx},20 {cx - 7},7 {cx + 7},7"
    elif direction == "left":
        pts = f"{cx - 8},12 {cx + 5},5 {cx + 5},19"
    else:
        pts = f"{cx + 8},12 {cx - 5},5 {cx - 5},19"
    return _poly(pts, fill)


def _topmark(kind: str | None) -> str:
    if kind == "two_cones_point_up":
        return _poly("32,4 25,16 39,16") + _poly("32,15 25,27 39,27")
    if kind == "two_cones_point_down":
        return _poly("25,5 39,5 32,17") + _poly("25,16 39,16 32,28")
    if kind == "two_cones_base_to_base":
        return _poly("32,4 25,16 39,16") + _poly("25,16 39,16 32,28")
    if kind == "two_cones_point_to_point":
        return _poly("25,4 39,4 32,16") + _poly("32,16 25,28 39,28")
    if kind == "single_sphere":
        return f'<circle cx="32" cy="10" r="5.5" fill="{_var("red")}"/>'
    return ""


def _banded_body(colors: list[str], shape: str) -> str:
    if shape == "beacon":
        x, y, w, h = 26, 27, 12, 26
        parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{_var(colors[0])}"/>']
        if len(colors) > 1:
            parts.append(f'<rect x="{x}" y="{y + h / 2}" width="{w}" height="{h / 2}" fill="{_var(colors[1])}"/>')
        parts.append('<path d="M24 56h16M28 53l-5 5h18l-5-5" fill="none"/>')
        return "".join(parts)

    if shape == "can_buoy":
        return f'<rect x="23" y="26" width="18" height="26" rx="2" fill="{_var(colors[0])}"/><ellipse cx="32" cy="53" rx="12" ry="4" fill="{_var("white")}"/>'

    if shape == "conical_buoy":
        return f'<path d="M32 24l-13 29h26z" fill="{_var(colors[0])}"/><ellipse cx="32" cy="53" rx="13" ry="4" fill="{_var("white")}"/>'

    # Default cardinal/safe buoy body.
    body = ['<rect x="24" y="25" width="16" height="27" rx="2" fill="none"/>']
    if len(colors) == 1:
        body.append(f'<rect x="25" y="26" width="14" height="25" fill="{_var(colors[0])}"/>')
    elif len(colors) == 2:
        body.append(f'<rect x="25" y="26" width="14" height="12.5" fill="{_var(colors[0])}"/>')
        body.append(f'<rect x="25" y="38.5" width="14" height="12.5" fill="{_var(colors[1])}"/>')
    else:
        body.append(f'<rect x="25" y="26" width="14" height="8" fill="{_var(colors[0])}"/>')
        body.append(f'<rect x="25" y="34" width="14" height="9" fill="{_var(colors[1])}"/>')
        body.append(f'<rect x="25" y="43" width="14" height="8" fill="{_var(colors[2])}"/>')
    body.append(f'<ellipse cx="32" cy="53" rx="12" ry="4" fill="{_var("white")}"/>')
    return "".join(body)


def _safe_water() -> str:
    return (
        _topmark("single_sphere") +
        '<rect x="23" y="23" width="18" height="29" rx="2" fill="var(--white)"/>'
        '<rect x="24" y="24" width="5" height="27" fill="var(--red)"/>'
        '<rect x="35" y="24" width="5" height="27" fill="var(--red)"/>'
        '<ellipse cx="32" cy="53" rx="12" ry="4" fill="var(--white)"/>'
    )


def _wreck(dangerous: bool) -> str:
    oval = '<ellipse cx="32" cy="35" rx="24" ry="14" fill="none" stroke="var(--black)" stroke-dasharray="1.5 4"/>'
    wreck = '<path d="M18 40h28M25 40V25M32 40V21M39 40V27M21 31l7 5 8-5 7 5" stroke="var(--black)" fill="none"/>'
    return (oval if dangerous else "") + wreck


def _rock_or_obstruction(shape: str) -> str:
    if shape == "underwater_rock":
        return '<path d="M17 42l7-17 8 10 7-14 9 21z" stroke="var(--black)" fill="none"/><ellipse cx="32" cy="42" rx="22" ry="9" fill="none" stroke="var(--black)" stroke-dasharray="2 4"/>'
    return '<path d="M18 44h28M22 36h20M25 28h14M32 20v28" stroke="var(--black)" fill="none"/><path d="M17 48l30-30M17 18l30 30" stroke="var(--black)" fill="none" stroke-dasharray="3 3"/>'


def _area_pattern(kind: str) -> str:
    if kind.startswith("ACHARE"):
        return '<circle cx="32" cy="31" r="13" fill="none" stroke="var(--magenta)"/><path d="M32 16v30M22 31h20" stroke="var(--magenta)" fill="none"/>'
    if kind.startswith("CTNARE"):
        return '<path d="M32 12l22 40H10z" fill="none" stroke="var(--magenta)"/><path d="M32 25v13M32 45v1" stroke="var(--magenta)" fill="none"/>'
    return '<path d="M-4 56L56-4M8 68L68 8M-16 44L44-16M20 80L80 20" stroke="var(--magenta)" fill="none"/>'


def _light_flare() -> str:
    rays = "".join(
        f'<path d="M32 32 L{x} {y}" stroke="var(--red)" fill="none"/>'
        for x, y in [(32, 9), (48, 16), (55, 32), (48, 48), (32, 55), (16, 48), (9, 32), (16, 16)]
    )
    return rays + '<circle cx="32" cy="32" r="8" fill="var(--red)"/><circle cx="32" cy="32" r="3" fill="var(--white)"/>'


def compose(entry: dict, style: StylePack) -> str:
    inv = entry["invariants"]
    shape = inv["shape"]
    colors = inv["colors"]
    if shape == "area_pattern":
        body = _area_pattern(entry["id"])
    elif inv.get("light_flare"):
        body = _light_flare()
    elif shape in {"wreck", "wreck_danger_oval"}:
        body = _wreck(shape == "wreck_danger_oval")
    elif shape in {"underwater_rock", "obstruction"}:
        body = _rock_or_obstruction(shape)
    elif entry["id"] == "BOYSAW":
        body = _safe_water()
    else:
        body = _topmark(inv.get("topmark")) + _banded_body(colors, shape)
    return _svg(body, style)


def _spec_from_entry(entry: dict) -> SymbolSpec:
    inv = entry["invariants"]
    return SymbolSpec(
        id=entry["id"],
        s52_token=entry["s52"]["object_class"],
        name=entry["symbol"]["description"],
        category="area" if inv["shape"] == "area_pattern" else "symbol",
        meaning=entry["symbol"]["description"],
        invariants=Invariants(
            colors=_uniq(inv["colors"]),
            topmark=inv.get("topmark"),
            light_flare=bool(inv.get("light_flare", False)),
            shape_class=inv["shape"],
            distinguishing="; ".join(entry["stress_class"]),
            anchor=tuple(inv["anchor"]),
        ),
        reference=entry["reference_crop"],
        siblings=entry["siblings"],
    )


def _styles() -> dict[str, StylePack]:
    return {p.stem: StylePack.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "stylepacks").glob("*.json")}


def main() -> int:
    pilot = json.loads(PILOT.read_text())
    styles = _styles()
    rows, report = [], []
    (OUT / "renders").mkdir(parents=True, exist_ok=True)

    failures = []
    for entry in pilot["entries"]:
        spec = _spec_from_entry(entry)
        for style in styles.values():
            svg = compose(entry, style)
            svg_dir = SVG_OUT / style.id
            svg_dir.mkdir(parents=True, exist_ok=True)
            svg_path = svg_dir / f"{entry['id']}.svg"
            svg_path.write_text(svg)

            structural = verify.structural(svg, spec, style, style.palettes["day"])
            ok = all(c.passed for c in structural)
            if not ok:
                failures.append((entry["id"], style.id, [c.__dict__ for c in structural if not c.passed]))

            pngs = {}
            for palette in PALETTES:
                png = render.rasterize(svg, style.palettes[palette], size=128)
                png_path = OUT / "renders" / f"{entry['id']}_{style.id}_{palette}.png"
                png_path.write_bytes(png)
                pngs[palette] = str(png_path)
            rows.append({"label": entry["id"], "style": style.id, "pngs": pngs, "ok": ok})
            report.append({
                "id": entry["id"],
                "style": style.id,
                "svg": str(svg_path),
                "structural_pass": ok,
                "criteria": [c.__dict__ for c in structural],
                "s52": entry["s52"],
                "reference_crop": entry["reference_crop"],
            })

    contact.build_contact(rows, PALETTES, cell=96, out_path=OUT / "contact_sheet.png")
    (OUT / "report.json").write_text(json.dumps(report, indent=2))

    print(f"stress20 generated: {len(pilot['entries'])} symbols x {len(styles)} styles")
    print(f"svg fixtures -> {SVG_OUT}")
    print(f"renders/report -> {OUT}")
    if failures:
        print(json.dumps(failures, indent=2))
        return 1
    print("structural checks: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
