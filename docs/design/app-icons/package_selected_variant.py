#!/usr/bin/env python3
"""Build Xcode-ready icon packages from the selected Helm icon variant."""

from __future__ import annotations

import json
import shutil
import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = ROOT / "variants" / "helm-icon-variant-01-clean-reference.png"
DEFAULT_OUT = ROOT / "helm-icon-v01-package"
SOURCE = DEFAULT_SOURCE
OUT = DEFAULT_OUT
PACKAGE_ID = "v01"


def find_square_crop(img: Image.Image, threshold: int = 245) -> tuple[int, int, int, int]:
    arr = np.array(img.convert("RGB"))
    mask = ~(
        (arr[:, :, 0] >= threshold)
        & (arr[:, :, 1] >= threshold)
        & (arr[:, :, 2] >= threshold)
    )
    ys, xs = np.where(mask)
    left, right = int(xs.min()), int(xs.max())
    top, bottom = int(ys.min()), int(ys.max())
    side = max(right - left + 1, bottom - top + 1)
    cx = (left + right) / 2
    cy = (top + bottom) / 2
    left = round(cx - side / 2)
    top = round(cy - side / 2)
    right = left + side
    bottom = top + side

    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > img.width:
        left -= right - img.width
        right = img.width
    if bottom > img.height:
        top -= bottom - img.height
        bottom = img.height
    return left, top, right, bottom


def remove_edge_background(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    arr = np.array(rgba)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    candidate = (
        (r > 246)
        & (g > 246)
        & (b > 246)
        & ((np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])) < 10)
    )

    height, width = candidate.shape
    seen = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        for y in (0, height - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < width and 0 <= ny < height and candidate[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                queue.append((nx, ny))

    background = Image.fromarray((seen * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.5))
    alpha = np.clip(255 - np.array(background).astype("int16"), 0, 255).astype("uint8")
    rgba.putalpha(Image.fromarray(alpha))
    return rgba


def ensure_dirs() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    for folder in (
        OUT / "source",
        OUT / "ios" / "HelmIcon.appiconset",
        OUT / "macos" / "HelmIcon.appiconset",
        OUT / "macos" / "HelmIcon.iconset",
        OUT / "previews",
    ):
        folder.mkdir(parents=True, exist_ok=True)


def save_icon(img: Image.Image, path: Path, size: int, mode: str | None = None) -> None:
    out = img.resize((size, size), Image.Resampling.LANCZOS)
    if mode:
        out = out.convert(mode)
    out.save(path)


def write_ios_appiconset(master: Image.Image) -> None:
    folder = OUT / "ios" / "HelmIcon.appiconset"
    images = [
        ("iphone", "20x20", "2x", 40),
        ("iphone", "20x20", "3x", 60),
        ("iphone", "29x29", "2x", 58),
        ("iphone", "29x29", "3x", 87),
        ("iphone", "40x40", "2x", 80),
        ("iphone", "40x40", "3x", 120),
        ("iphone", "60x60", "2x", 120),
        ("iphone", "60x60", "3x", 180),
        ("ipad", "20x20", "1x", 20),
        ("ipad", "20x20", "2x", 40),
        ("ipad", "29x29", "1x", 29),
        ("ipad", "29x29", "2x", 58),
        ("ipad", "40x40", "1x", 40),
        ("ipad", "40x40", "2x", 80),
        ("ipad", "76x76", "1x", 76),
        ("ipad", "76x76", "2x", 152),
        ("ipad", "83.5x83.5", "2x", 167),
        ("ios-marketing", "1024x1024", "1x", 1024),
    ]
    contents = {"images": [], "info": {"author": "xcode", "version": 1}}
    rgb = master.convert("RGB")
    for idiom, logical_size, scale, px in images:
        filename = f"HelmIcon-iOS-{idiom}-{logical_size.replace('.', '_')}@{scale}.png"
        save_icon(rgb, folder / filename, px, "RGB")
        contents["images"].append(
            {"filename": filename, "idiom": idiom, "scale": scale, "size": logical_size}
        )
    (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")


def write_macos_appiconset(master: Image.Image) -> None:
    folder = OUT / "macos" / "HelmIcon.appiconset"
    iconset_folder = OUT / "macos" / "HelmIcon.iconset"
    images = [
        ("16x16", "1x", 16),
        ("16x16", "2x", 32),
        ("32x32", "1x", 32),
        ("32x32", "2x", 64),
        ("128x128", "1x", 128),
        ("128x128", "2x", 256),
        ("256x256", "1x", 256),
        ("256x256", "2x", 512),
        ("512x512", "1x", 512),
        ("512x512", "2x", 1024),
    ]
    contents = {"images": [], "info": {"author": "xcode", "version": 1}}
    for logical_size, scale, px in images:
        app_filename = f"HelmIcon-macOS-{logical_size}@{scale}.png"
        save_icon(master, folder / app_filename, px)
        contents["images"].append(
            {"filename": app_filename, "idiom": "mac", "scale": scale, "size": logical_size}
        )

        iconset_name = f"icon_{logical_size}.png" if scale == "1x" else f"icon_{logical_size}@2x.png"
        save_icon(master, iconset_folder / iconset_name, px)
    (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")


def write_icns(master: Image.Image) -> None:
    master.save(
        OUT / "macos" / "HelmIcon.icns",
        format="ICNS",
        sizes=[(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)],
    )


def checkerboard(size: tuple[int, int], tile: int = 32) -> Image.Image:
    width, height = size
    img = Image.new("RGB", size, "#eef2f5")
    draw = ImageDraw.Draw(img)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill="#cfd8df")
    return img


def write_previews(ios_master: Image.Image, mac_master: Image.Image) -> None:
    sizes = [16, 20, 29, 40, 60, 128, 256, 512]
    pad = 36
    label_h = 28
    row_h = 512 + label_h + 22
    width = pad * 2 + sum(max(size, 58) + pad for size in sizes)
    height = pad * 2 + row_h * 2
    sheet = Image.new("RGB", (width, height), "#f7fafc")
    draw = ImageDraw.Draw(sheet)

    def paste_row(src: Image.Image, y: int, title: str, transparent: bool = False) -> None:
        draw.text((pad, y), title, fill="#142231")
        x = pad
        for size in sizes:
            box_w = max(size, 58)
            bx = x + (box_w - size) // 2
            by = y + label_h + (512 - size) // 2
            thumb = src.resize((size, size), Image.Resampling.LANCZOS)
            if transparent:
                bg = checkerboard((size, size), max(4, size // 8)).convert("RGBA")
                bg.alpha_composite(thumb.convert("RGBA"))
                thumb = bg.convert("RGB")
            sheet.paste(thumb.convert("RGB"), (bx, by))
            draw.text((x, y + label_h + 512 + 4), f"{size}px", fill="#607080")
            x += box_w + pad

    paste_row(ios_master, pad, "iOS opaque app icon")
    paste_row(mac_master, pad + row_h, "macOS transparent app icon", True)
    sheet.save(OUT / "previews" / f"HelmIcon-{PACKAGE_ID}-size-test.png")

    contact = Image.new("RGB", (1560, 560), "#f7fafc")
    cd = ImageDraw.Draw(contact)
    examples = [
        ("Original generated variant", SOURCE),
        ("iOS 1024 opaque", OUT / "source" / f"HelmIcon-{PACKAGE_ID}-iOS-1024.png"),
        ("macOS 1024 transparent", OUT / "source" / f"HelmIcon-{PACKAGE_ID}-macOS-transparent-1024.png"),
    ]
    x = 40
    for label, path in examples:
        im = Image.open(path).convert("RGBA")
        if "transparent" in label:
            bg = checkerboard((430, 430), 32).convert("RGBA")
            im.thumbnail((430, 430), Image.Resampling.LANCZOS)
            bg.alpha_composite(im, ((430 - im.width) // 2, (430 - im.height) // 2))
            im = bg
        else:
            im.thumbnail((430, 430), Image.Resampling.LANCZOS)
        contact.paste(im.convert("RGB"), (x, 40))
        cd.text((x, 492), label, fill="#142231")
        x += 500
    contact.save(OUT / "previews" / f"HelmIcon-{PACKAGE_ID}-contact-sheet.png")


def write_readme(crop_box: tuple[int, int, int, int]) -> None:
    source_label = SOURCE.name
    source_arg = f"docs/design/app-icons/source/HelmIcon-{PACKAGE_ID}-original.png"
    (OUT / "README.md").write_text(
        f"""# Helm Icon {PACKAGE_ID} Package

Selected source: `{source_label}`

This package is ready to drop into Apple app projects:

- `ios/HelmIcon.appiconset/` - iOS/iPadOS Xcode asset catalog icon set
- `macos/HelmIcon.appiconset/` - macOS Xcode asset catalog icon set
- `macos/HelmIcon.iconset/` - macOS iconset PNG source
- `macos/HelmIcon.icns` - macOS `.icns`
- `source/HelmIcon-{PACKAGE_ID}-iOS-1024.png` - opaque iOS master
- `source/HelmIcon-{PACKAGE_ID}-macOS-transparent-1024.png` - transparent macOS master
- `source/HelmIcon-{PACKAGE_ID}-cropped-master-2048.png` - high-resolution cropped source

The iOS package is RGB/opaque. The macOS package keeps transparency outside the icon/shadow.

To use it, copy the relevant `HelmIcon.appiconset` folder into your app target's
`Assets.xcassets`, then set the target's App Icon source to `HelmIcon` in Xcode.
For a non-Xcode macOS bundle, use `macos/HelmIcon.icns`.

Generated crop box from the source image: `{crop_box}`.

Regenerate with:

```bash
python3 docs/design/app-icons/package_selected_variant.py --source "{source_arg}" --out "{OUT}" --id "{PACKAGE_ID}"
```
""",
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Source icon PNG")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output package folder")
    parser.add_argument("--id", default="v01", help="Filename/package identifier")
    return parser.parse_args()


def main() -> None:
    global SOURCE, OUT, PACKAGE_ID
    args = parse_args()
    SOURCE = args.source
    OUT = args.out
    PACKAGE_ID = args.id

    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    ensure_dirs()

    original = Image.open(SOURCE).convert("RGB")
    crop_box = find_square_crop(original)
    cropped = original.crop(crop_box)

    cropped_2048 = cropped.resize((2048, 2048), Image.Resampling.LANCZOS)
    ios_master = cropped.resize((1024, 1024), Image.Resampling.LANCZOS).convert("RGB")
    mac_master = remove_edge_background(ios_master)

    shutil.copy2(SOURCE, OUT / "source" / f"HelmIcon-{PACKAGE_ID}-original.png")
    cropped_2048.save(OUT / "source" / f"HelmIcon-{PACKAGE_ID}-cropped-master-2048.png")
    ios_master.save(OUT / "source" / f"HelmIcon-{PACKAGE_ID}-iOS-1024.png")
    mac_master.save(OUT / "source" / f"HelmIcon-{PACKAGE_ID}-macOS-transparent-1024.png")

    write_ios_appiconset(ios_master)
    write_macos_appiconset(mac_master)
    write_icns(mac_master)
    write_previews(ios_master, mac_master)
    write_readme(crop_box)


if __name__ == "__main__":
    main()
