"""Contact sheet — a human-viewable grid of every render, for eyeballing output.

Rows = symbols (per style), columns = day / dusk / night. Tinted backgrounds so
the night palette is legible. Pure presentation; not part of the asset pack.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BG = {"day": (244, 241, 234), "dusk": (60, 66, 82), "night": (12, 16, 24)}
FG = {"day": (40, 40, 40), "dusk": (220, 220, 220), "night": (150, 160, 175)}


def build_contact(rows: list[dict], palettes: list[str], cell: int,
                  out_path: Path) -> None:
    """rows: [{label, style, pngs:{palette: path}, ok: bool}]"""
    pad, label_w, head_h = 14, 230, 30
    W = label_w + len(palettes) * (cell + pad) + pad
    H = head_h + len(rows) * (cell + pad) + pad
    img = Image.new("RGB", (W, H), (250, 250, 250))
    d = ImageDraw.Draw(img)
    for j, p in enumerate(palettes):
        x = label_w + j * (cell + pad)
        d.rectangle([x, 6, x + cell, 6 + 18], fill=BG[p])
        d.text((x + 6, 10), p.upper(), fill=FG[p])
    for i, row in enumerate(rows):
        y = head_h + i * (cell + pad)
        mark = "OK " if row["ok"] else "FAIL "
        col = (20, 130, 60) if row["ok"] else (200, 40, 40)
        d.text((10, y + cell // 2 - 16), mark + row["label"], fill=col)
        d.text((10, y + cell // 2 + 2), row["style"], fill=(120, 120, 120))
        for j, p in enumerate(palettes):
            x = label_w + j * (cell + pad)
            d.rectangle([x, y, x + cell, y + cell], fill=BG[p])
            sym = Image.open(row["pngs"][p]).convert("RGBA").resize((cell, cell))
            img.paste(sym, (x, y), sym)
    img.save(out_path)
