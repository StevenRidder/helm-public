"""Smoke the 20-symbol primitive generator.

Run:  python -m forge.tests.test_stress20_generate
"""
from __future__ import annotations

from pathlib import Path

from .. import stress20_generate


ROOT = Path(__file__).resolve().parent.parent.parent


def main():
    rc = stress20_generate.main()
    assert rc == 0, "stress20 generation failed structural checks"

    for style in ["open-bridge", "us-paper"]:
        svgs = sorted((ROOT / "generated" / "stress20" / "compose" / style).glob("*.svg"))
        assert len(svgs) == 20, f"{style} should have 20 SVG fixtures"

    assert (ROOT / "out" / "stress20" / "contact_sheet.png").exists(), "contact sheet missing"
    assert (ROOT / "out" / "stress20" / "report.json").exists(), "report missing"
    print("stress20 generate: OK")


if __name__ == "__main__":
    main()
