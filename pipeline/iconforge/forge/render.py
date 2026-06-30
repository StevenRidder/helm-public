"""Render (FORGE-5) — deterministic SVG -> PNG with palette substitution.

Colours live in the SVG as var(--token); a palette maps tokens to hex. One SVG
renders to day/dusk/night by substitution alone — palettes cost no generation.
cairosvg's CSS-variable support is uneven, so we resolve var(--token) ourselves
before rasterizing, which keeps the output byte-stable across environments.
"""
from __future__ import annotations

import re

import cairosvg

_VAR = re.compile(r"var\(--([a-z0-9_]+)\)")


def referenced_tokens(svg: str) -> set[str]:
    return set(_VAR.findall(svg))


def inject_palette(svg: str, palette: dict[str, str]) -> str:
    def sub(m):
        tok = m.group(1)
        if tok not in palette:
            raise KeyError(f"palette has no colour token '{tok}'")
        return palette[tok]
    return _VAR.sub(sub, svg)


def rasterize(svg: str, palette: dict[str, str], size: int = 128) -> bytes:
    resolved = inject_palette(svg, palette)
    return cairosvg.svg2png(bytestring=resolved.encode(),
                            output_width=size, output_height=size)
