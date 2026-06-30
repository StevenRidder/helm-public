"""Live vision-judge pass (FORGE-6, production).

Runs the REAL claude-opus-4-8 vision judge against the recorded compose
renders — including the deliberately-broken hazard case — and reports whether
the live model agrees with the recorded verdict. This is the single most
meaningful validation of the verifier: does a real vision pass catch the
flipped-cone north cardinal and clear the 10 good symbols?

Isolates the *judge* from compose on purpose — it consumes the SVGs we already
have, so the only live variable is the model's verdict.

Run (needs ANTHROPIC_API_KEY):
    python -m forge.judge_live
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .schema import SymbolSpec, StylePack
from .model import LiveModel, FixtureModel
from . import render

ROOT = Path(__file__).resolve().parent.parent


def _write_blocked_report(reason: str) -> Path:
    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    path = out / "live_judge_report.json"
    path.write_text(json.dumps({
        "status": "blocked",
        "live_agreement_observed": False,
        "reason": reason,
        "expected_gate": (
            "Run the real vision judge and confirm it accepts the ten known-good "
            "symbols and rejects BOYCAR_north__BROKEN as BOYCAR_south."
        ),
    }, indent=2))
    return path


def _specs() -> dict[str, SymbolSpec]:
    return {p.stem: SymbolSpec.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "catalog").glob("*.json")}


def _styles() -> dict[str, StylePack]:
    return {p.stem: StylePack.from_dict(json.loads(p.read_text()))
            for p in (ROOT / "stylepacks").glob("*.json")}


def _base_id(stem: str) -> str:
    return stem.split("__", 1)[0]


def run(live: LiveModel) -> int:
    specs, styles = _specs(), _styles()
    fix = FixtureModel(ROOT / "fixtures")  # for the recorded verdict to compare against
    rows = []
    hdr = f"{'symbol':22}{'style':13}{'expected':10}{'live':8}{'identity':16}agree"
    print(hdr + "\n" + "-" * len(hdr))

    for sdir in sorted((ROOT / "fixtures" / "compose").iterdir()):
        style = styles[sdir.name]
        for svg_path in sorted(sdir.glob("*.svg")):
            stem = svg_path.stem
            spec = specs[_base_id(stem)]
            variant = stem.split("__", 1)[1] if "__" in stem else ""
            svg = svg_path.read_text()
            png = render.rasterize(svg, style.palettes["day"], size=160)

            verdict = live.judge(spec, style, png)            # the live call
            recorded = fix.judge(spec, style, variant)        # ground truth
            expected_accept = recorded.overall_pass
            agree = verdict.overall_pass == expected_accept
            print(f"{stem:22}{style.id:13}"
                  f"{'accept' if expected_accept else 'reject':10}"
                  f"{'accept' if verdict.overall_pass else 'reject':8}"
                  f"{str(verdict.sibling_pick):16}{'yes' if agree else 'NO'}")
            rows.append({"symbol": stem, "style": style.id,
                         "expected_accept": expected_accept,
                         "live_accept": verdict.overall_pass,
                         "live_identity": verdict.sibling_pick, "agree": agree,
                         "criteria": [c.__dict__ for c in verdict.criteria]})

    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    (out / "live_judge_report.json").write_text(json.dumps(rows, indent=2))
    disagree = [r["symbol"] for r in rows if not r["agree"]]
    print(f"\nlive/recorded agreement: {len(rows) - len(disagree)}/{len(rows)}"
          f"  disagreements: {disagree or 'none'}")
    print(f"report -> {out / 'live_judge_report.json'}")
    return 1 if disagree else 0


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        report = _write_blocked_report("ANTHROPIC_API_KEY not set")
        print("ANTHROPIC_API_KEY not set — the live judge needs API access.\n"
              "Set it and re-run:  ANTHROPIC_API_KEY=... python -m forge.judge_live\n"
              "(The offline wiring test, forge/tests/test_live_judge_wiring.py, "
              "validates the request/response plumbing without a key.)\n"
              f"blocked report -> {report}")
        return 2
    return run(LiveModel())


if __name__ == "__main__":
    sys.exit(main())
