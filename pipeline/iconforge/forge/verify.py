"""Verify (FORGE-6) — the centre of gravity.

structural() is deterministic and runs for real here: it proves the SVG is
well-formed, references only colours the palette defines, actually uses the
load-bearing invariant colours, declares a sane in-bounds anchor, and renders
without error. The vision judge + sibling-discrimination come from the model
adapter (recorded in the POC, live in production).
"""
from __future__ import annotations

import xml.dom.minidom as minidom

from .schema import SymbolSpec, StylePack, Criterion, Verdict
from .render import referenced_tokens, rasterize


def structural(svg: str, spec: SymbolSpec, style: StylePack,
               palette: dict[str, str]) -> list[Criterion]:
    out: list[Criterion] = []

    # 1. well-formed XML
    try:
        minidom.parseString(svg)
        out.append(Criterion("xml_wellformed", True, "parses as XML"))
    except Exception as e:  # noqa: BLE001
        out.append(Criterion("xml_wellformed", False, f"parse error: {e}"))
        return out  # nothing else is meaningful

    # 2. every var(--token) is defined by the palette
    toks = referenced_tokens(svg)
    missing = sorted(t for t in toks if t not in palette)
    out.append(Criterion("palette_tokens_defined", not missing,
               "all colour tokens defined" if not missing
               else f"undefined tokens: {missing}"))

    # 3. the load-bearing invariant colours are actually referenced
    missing_inv = [c for c in spec.invariants.colors if c not in toks]
    out.append(Criterion("invariant_colours_used", not missing_inv,
               "all invariant colours referenced" if not missing_inv
               else f"invariant colour not drawn: {missing_inv}"))

    # 4. colours are vars, not literal hex (palette-substitutable)
    has_hex = "#" in svg
    out.append(Criterion("no_literal_hex", not has_hex,
               "colours are CSS variables" if not has_hex
               else "literal hex found — not palette-substitutable"))

    # 5. anchor declared and in-bounds
    ax, ay = spec.invariants.anchor
    in_bounds = 0.0 <= ax <= 1.0 and 0.0 <= ay <= 1.0
    out.append(Criterion("anchor_in_bounds", in_bounds,
               f"anchor=({ax},{ay})"))

    # 6. actually rasterizes
    try:
        png = rasterize(svg, palette, size=64)
        ok = len(png) > 0
        out.append(Criterion("renders", ok, f"{len(png)} bytes"))
    except Exception as e:  # noqa: BLE001
        out.append(Criterion("renders", False, f"render error: {e}"))

    return out


def combine(structural_c: list[Criterion], judge: Verdict) -> Verdict:
    """Merge deterministic structural checks with the model's vision verdict."""
    criteria = structural_c + judge.criteria
    overall = all(c.passed for c in criteria) and judge.overall_pass
    return Verdict(criteria=criteria, overall_pass=overall,
                   confidence=judge.confidence, sibling_pick=judge.sibling_pick)
