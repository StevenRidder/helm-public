"""Atlas compile (FORGE-9) — pack verified renders into a sheet + manifest.

The manifest mirrors engine/vendor/cli/helm_s52_atlas.* — entries keyed by
(name, kind, palette) with pixel_rect / uv / anchor — plus the new `style`
axis. The downstream C++/Vulkan loader consumes it unchanged.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


def build_atlas(renders: list[dict], style: str, palette: str,
                cell: int, out_dir: Path) -> dict:
    """renders: [{id, kind, anchor, png_path}] -> sheet png + manifest dict."""
    n = len(renders)
    cols = min(n, 8)
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    entries = []
    for i, r in enumerate(renders):
        cx, cy = (i % cols) * cell, (i // cols) * cell
        img = Image.open(r["png_path"]).convert("RGBA").resize((cell, cell))
        sheet.paste(img, (cx, cy), img)
        entries.append({
            "name": r["id"], "kind": r["kind"], "palette": palette, "style": style,
            "pixel_rect": {"x": cx, "y": cy, "width": cell, "height": cell},
            "uv": {"u0": cx / (cols * cell), "v0": cy / (rows * cell),
                   "u1": (cx + cell) / (cols * cell), "v1": (cy + cell) / (rows * cell)},
            "anchor": {"x": r["anchor"][0], "y": r["anchor"][1]},
        })
    sheet_name = f"s52_symbols_{style}_{palette}.png"
    sheet.save(out_dir / sheet_name)
    manifest = {
        "schema_version": 1, "generator": "iconforge-forge-poc",
        "style": style, "palette": palette,
        "atlas": {"image": sheet_name, "format": "png",
                  "width": cols * cell, "height": rows * cell, "cell": cell},
        "entries": entries,
    }
    (out_dir / f"manifest_{style}_{palette}.json").write_text(
        json.dumps(manifest, indent=2))
    return manifest
