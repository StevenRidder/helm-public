"""Smoke the scale125 structural generation/render pass.

Run:  python -m forge.tests.test_scale125_generate
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import scale125_generate


ROOT = Path(__file__).resolve().parent.parent.parent


def main():
    rc = scale125_generate.main()
    assert rc == 0, "scale125 generation had structural hard-pile entries"

    catalog = json.loads((ROOT / "pilots" / "scale125.json").read_text())
    report = json.loads((ROOT / "out" / "scale125" / "report.json").read_text())
    hard_pile = json.loads((ROOT / "out" / "scale125" / "hard_pile.json").read_text())

    assert report["status"] == "pass"
    assert report["assets"] == 125
    assert report["styles"] == 2
    assert report["svg_outputs"] == catalog["next_batch_outputs"]["svg_outputs"] == 250
    assert report["png_outputs"] == catalog["next_batch_outputs"]["png_outputs"] == 750
    assert report["structural_pass"] == report["structural_total"] == 250
    assert hard_pile == []

    for style in ["open-bridge", "us-paper"]:
        svgs = sorted((ROOT / "generated" / "scale125" / "compose" / style).glob("*.svg"))
        assert len(svgs) == 125, f"{style} should have 125 SVG fixtures"

    renders = sorted((ROOT / "out" / "scale125" / "renders").glob("*.png"))
    assert len(renders) == 750, "scale125 should render 750 PNGs"
    assert (ROOT / "out" / "scale125" / "contact_sheet.png").exists()
    print("scale125 generate: OK")


if __name__ == "__main__":
    main()
