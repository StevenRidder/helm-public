"""POC driver — execute the FORGE pipeline over the 5-symbol / 2-style catalog.

  compose (recorded) -> structural verify (LIVE, deterministic)
                     -> render day/dusk/night (LIVE) -> vision judge (recorded)
                     -> combine -> atlas + contact sheet + report

LIVE stages run for real here. compose/judge are recorded claude-opus-4-8
output (FixtureModel); swap in LiveModel when ANTHROPIC_API_KEY is set.

Run:  python -m forge.run
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .schema import SymbolSpec, StylePack, dump
from .model import FixtureModel, LiveModel, PROMPT_VERSION, input_hash
from . import verify, render, atlas, contact

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PALETTES = ["day", "dusk", "night"]
KIND = {"buoy": "symbol", "beacon": "symbol", "danger": "symbol",
        "area": "pattern"}


def load_specs() -> list[SymbolSpec]:
    order = ["BOYCAR_north", "BCNCAR_south", "BOYSAW", "RESARE_pattern", "WRECKS_dangerous"]
    specs = {p.stem: SymbolSpec.from_dict(json.loads(p.read_text()))
             for p in (ROOT / "catalog").glob("*.json")}
    return [specs[i] for i in order]


def load_styles() -> dict[str, StylePack]:
    return {p.stem: StylePack.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "stylepacks").glob("*.json")}


def model_backend():
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return LiveModel(), "LIVE claude-opus-4-8"
        except Exception as e:  # noqa: BLE001
            print(f"  (live backend unavailable: {e}; using fixtures)")
    return FixtureModel(ROOT / "fixtures"), "RECORDED claude-opus-4-8 (fixtures)"


def render_all(svg, style, anchor, name, rdir) -> dict[str, str]:
    pngs = {}
    for pal in PALETTES:
        png = render.rasterize(svg, style.palettes[pal], size=128)
        path = rdir / f"{name}_{style.id}_{pal}.png"
        path.write_bytes(png)
        pngs[pal] = str(path)
    return pngs


def main():
    OUT.mkdir(exist_ok=True)
    rdir = OUT / "renders"
    rdir.mkdir(exist_ok=True)
    specs, styles = load_specs(), load_styles()
    model, backend = model_backend()

    print(f"\nIcon Forge POC — backend: {backend}")
    print(f"{len(specs)} symbols x {len(styles)} styles x {len(PALETTES)} palettes\n")
    hdr = f"{'symbol':18}{'style':13}{'structural':11}{'vision':8}{'overall':9}{'identity'}"
    print(hdr + "\n" + "-" * len(hdr))

    rows, report = [], []
    cases = [(s, st, "") for st in styles.values() for s in specs]
    # append the deliberately-broken hazard case
    north = next(s for s in specs if s.id == "BOYCAR_north")
    cases.append((north, styles["us-paper"], "BROKEN"))

    for spec, style, variant in cases:
        name = spec.id + (f"__{variant}" if variant else "")
        svg, anchor = model.compose(spec, style, variant)
        struct = verify.structural(svg, spec, style, style.palettes["day"])
        judge = (model.judge(spec, style, variant) if isinstance(model, FixtureModel)
                 else model.judge(spec, style, render.rasterize(svg, style.palettes["day"])))
        combined = verify.combine(struct, judge)
        pngs = render_all(svg, style, anchor, name, rdir)

        s_ok = all(c.passed for c in struct)
        v_ok = judge.overall_pass
        print(f"{name:18}{style.id:13}{'pass' if s_ok else 'FAIL':11}"
              f"{'pass' if v_ok else 'FAIL':8}"
              f"{'PASS' if combined.overall_pass else 'REJECT':9}{judge.sibling_pick}")

        rows.append({"label": name, "style": style.id, "pngs": pngs,
                     "ok": combined.overall_pass})
        report.append({
            "id": name, "style": style.id, "kind": KIND[spec.category],
            "anchor": anchor, "structural_pass": s_ok, "vision_pass": v_ok,
            "overall_pass": combined.overall_pass, "identity": judge.sibling_pick,
            "render_day": pngs["day"],
            "provenance": {"source": model.source, "prompt_version": PROMPT_VERSION,
                           "input_hash": input_hash(spec, style)},
            "criteria": [dump(c) for c in combined.criteria],
        })

    # atlas: pack the ACCEPTED day renders for each style (FORGE-9 contract)
    print()
    for style in styles.values():
        accepted = [r for r in report if r["style"] == style.id
                    and r["overall_pass"] and "__" not in r["id"]]
        m = atlas.build_atlas(
            [{"id": r["id"], "kind": r["kind"], "anchor": r["anchor"],
              "png_path": r["render_day"]} for r in accepted],
            style.id, "day", cell=96, out_dir=OUT)
        print(f"atlas {style.id}/day: {len(m['entries'])} entries "
              f"-> {m['atlas']['image']} ({m['atlas']['width']}x{m['atlas']['height']})")

    contact.build_contact(rows, PALETTES, cell=96, out_path=OUT / "contact_sheet.png")
    (OUT / "report.json").write_text(json.dumps(report, indent=2))

    accepted = sum(1 for r in report if r["overall_pass"])
    rejected = [r["id"] for r in report if not r["overall_pass"]]
    print(f"\naccepted {accepted}/{len(report)}  rejected: {rejected or 'none'}")
    print(f"artifacts in {OUT}/  (contact_sheet.png, report.json, atlas sheets)")


if __name__ == "__main__":
    main()
