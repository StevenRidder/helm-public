#!/usr/bin/env python3
"""Generate Helm app icon concepts and Xcode-ready icon sets.

The drawing is intentionally deterministic: it keeps the brand source editable in code
until a dedicated vector source is introduced.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent
SCALE = 4
SIZE = 1024
CANVAS = SIZE * SCALE


COLORS = {
    "bg_top": "#061521",
    "bg_bottom": "#0d2d41",
    "water_1": "#0b2537",
    "water_2": "#0f3d55",
    "shoal": "#58b7d0",
    "shoal_soft": "#246f86",
    "land": "#d7c88d",
    "land_shadow": "#8d7b43",
    "contour": "#7eb8cf",
    "contour_dim": "#3b6f86",
    "route": "#d6219a",
    "route_glow": "#ff6fc6",
    "accent": "#5bc0ff",
    "mint": "#54f0ad",
    "white": "#f4fbff",
    "navy": "#07111c",
}


def hex_to_rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def pt(x: float, y: float) -> tuple[int, int]:
    return round(x * SCALE), round(y * SCALE)


def scaled(value: float) -> int:
    return round(value * SCALE)


def make_gradient(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    width, height = size
    img = Image.new("RGBA", size)
    draw = ImageDraw.Draw(img)
    top_rgba = hex_to_rgba(top)
    bottom_rgba = hex_to_rgba(bottom)
    for y in range(height):
        t = y / max(height - 1, 1)
        color = tuple(round(top_rgba[i] * (1 - t) + bottom_rgba[i] * t) for i in range(4))
        draw.line([(0, y), (width, y)], fill=color)
    return img


def cubic(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    steps: int = 80,
) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        x = (
            mt * mt * mt * p0[0]
            + 3 * mt * mt * t * p1[0]
            + 3 * mt * t * t * p2[0]
            + t * t * t * p3[0]
        )
        y = (
            mt * mt * mt * p0[1]
            + 3 * mt * mt * t * p1[1]
            + 3 * mt * t * t * p2[1]
            + t * t * t * p3[1]
        )
        out.append(pt(x, y))
    return out


def draw_smooth_line(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[int, int]],
    fill: tuple[int, int, int, int],
    width: int,
) -> None:
    if len(points) < 2:
        return
    draw.line(points, fill=fill, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def rotated_polygon(
    center: tuple[float, float],
    points: list[tuple[float, float]],
    angle_deg: float,
) -> list[tuple[int, int]]:
    angle = math.radians(angle_deg)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    cx, cy = center
    out: list[tuple[int, int]] = []
    for x, y in points:
        rx = cx + x * cos_a - y * sin_a
        ry = cy + x * sin_a + y * cos_a
        out.append(pt(rx, ry))
    return out


def diamond(center: tuple[float, float], radius: float) -> list[tuple[int, int]]:
    cx, cy = center
    return [pt(cx, cy - radius), pt(cx + radius, cy), pt(cx, cy + radius), pt(cx - radius, cy)]


def draw_chart_content(seed: str = "ios") -> Image.Image:
    img = make_gradient((CANVAS, CANVAS), COLORS["bg_top"], COLORS["bg_bottom"])
    draw = ImageDraw.Draw(img, "RGBA")

    # Broad chart regions: enough land/shoal signal to read as navigation, not scenery.
    draw.polygon(
        [
            pt(-90, 980),
            pt(42, 725),
            pt(88, 445),
            pt(72, 218),
            pt(148, -50),
            pt(-90, -50),
        ],
        fill=hex_to_rgba(COLORS["land"], 225),
    )
    draw.line(
        [pt(112, -20), pt(76, 225), pt(96, 432), pt(52, 720), pt(-40, 980)],
        fill=hex_to_rgba(COLORS["land_shadow"], 170),
        width=scaled(7),
    )
    draw.polygon(
        [
            pt(836, -40),
            pt(1115, -40),
            pt(1115, 302),
            pt(990, 252),
            pt(922, 120),
        ],
        fill=hex_to_rgba("#143d34", 190),
    )
    draw.ellipse(
        (scaled(214), scaled(632), scaled(760), scaled(998)),
        fill=hex_to_rgba(COLORS["shoal_soft"], 115),
    )
    draw.ellipse(
        (scaled(278), scaled(704), scaled(656), scaled(928)),
        fill=hex_to_rgba(COLORS["shoal"], 70),
    )

    # Bathymetry and chart grid lines.
    contours = [
        cubic((128, 202), (332, 236), (504, 172), (892, 224)),
        cubic((142, 336), (362, 366), (604, 292), (958, 350)),
        cubic((94, 548), (316, 506), (618, 522), (1098, 458)),
        cubic((212, 850), (422, 786), (628, 808), (1034, 714)),
    ]
    for i, curve in enumerate(contours):
        draw_smooth_line(
            draw,
            curve,
            hex_to_rgba(COLORS["contour"] if i < 2 else COLORS["contour_dim"], 95 if i < 2 else 75),
            scaled(3.0 if i < 2 else 2.2),
        )
    for offset, alpha in ((0, 24), (220, 18)):
        draw_smooth_line(
            draw,
            cubic((-60, 934 - offset), (290, 738 - offset), (712, 684 - offset), (1110, 520 - offset)),
            hex_to_rgba("#7fc3dd", alpha),
            scaled(1.4),
        )

    # Weather streamlines, deliberately secondary to the route/own-ship mark.
    for y, width, alpha in ((154, 4, 175), (206, 3, 125), (260, 2, 92)):
        stream = cubic((538, y + 46), (664, y - 30), (794, y + 52), (952, y - 8), 72)
        draw_smooth_line(draw, stream, hex_to_rgba(COLORS["mint"], alpha), scaled(width))
        end_x, end_y = stream[-1]
        draw.line(
            [stream[-1], (end_x - scaled(32), end_y - scaled(10)), (end_x - scaled(22), end_y + scaled(24))],
            fill=hex_to_rgba(COLORS["mint"], alpha),
            width=scaled(width),
        )

    # Active route: Helm's magenta line is a signature product color.
    route = cubic((-92, 832), (196, 708), (348, 562), (1114, 374), 90)
    draw_smooth_line(draw, route, hex_to_rgba(COLORS["route_glow"], 55), scaled(42))
    draw_smooth_line(draw, route, hex_to_rgba(COLORS["route"], 244), scaled(20))
    draw_smooth_line(draw, route, hex_to_rgba("#ffffff", 70), scaled(3))

    draw.polygon(diamond((472, 556), 23), fill=hex_to_rgba(COLORS["route"], 255))
    draw.polygon(diamond((472, 556), 15), fill=hex_to_rgba(COLORS["bg_top"], 235))

    # Own-ship halo, body, and heading vector.
    draw.ellipse(
        (scaled(582), scaled(374), scaled(788), scaled(580)),
        outline=hex_to_rgba(COLORS["accent"], 108),
        width=scaled(5),
    )
    draw_smooth_line(
        draw,
        cubic((680, 482), (748, 442), (808, 410), (906, 386), 32),
        hex_to_rgba(COLORS["accent"], 115),
        scaled(4),
    )
    arrow_shadow = rotated_polygon(
        (675, 480),
        [(0, -92), (47, 62), (0, 34), (-47, 62)],
        68,
    )
    draw.polygon(arrow_shadow, fill=hex_to_rgba("#001927", 138))
    arrow = rotated_polygon(
        (664, 468),
        [(0, -92), (47, 62), (0, 34), (-47, 62)],
        68,
    )
    draw.polygon(arrow, fill=hex_to_rgba(COLORS["white"], 255))
    draw.line(arrow + [arrow[0]], fill=hex_to_rgba(COLORS["accent"], 230), width=scaled(5))
    inner = rotated_polygon((664, 468), [(0, -48), (21, 31), (0, 18), (-21, 31)], 68)
    draw.polygon(inner, fill=hex_to_rgba("#d9f5ff", 255))

    # AIS/source pips as tiny context, kept below the main silhouette.
    for cx, cy, color, alpha in (
        (772, 688, COLORS["mint"], 180),
        (832, 650, "#f5c451", 160),
        (894, 716, "#ff6b6b", 160),
    ):
        draw.ellipse(
            (scaled(cx - 10), scaled(cy - 10), scaled(cx + 10), scaled(cy + 10)),
            fill=hex_to_rgba(color, alpha),
        )

    # Subtle edge vignette for app-icon depth.
    vignette = Image.new("L", (CANVAS, CANVAS), 0)
    vd = ImageDraw.Draw(vignette)
    vd.ellipse((scaled(-190), scaled(-150), scaled(1214), scaled(1180)), fill=255)
    vignette = Image.eval(vignette.filter(ImageFilter.GaussianBlur(scaled(26))), lambda p: 255 - p)
    img.alpha_composite(Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)))
    draw = ImageDraw.Draw(img, "RGBA")
    draw.bitmap((0, 0), vignette, fill=(0, 0, 0, 62))

    return img


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def save_downsampled(img: Image.Image, path: Path, size: int = SIZE) -> None:
    out = img.resize((size, size), Image.Resampling.LANCZOS)
    out.save(path)


def make_ios() -> Image.Image:
    opaque = draw_chart_content("ios")
    opaque.putalpha(255)
    return opaque.convert("RGB")


def make_ios_preview(ios: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", (CANVAS, CANVAS), (4, 8, 12, 255))
    shadow_mask = rounded_mask((CANVAS, CANVAS), scaled(214)).filter(ImageFilter.GaussianBlur(scaled(28)))
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 155))
    bg.paste(shadow, (0, 0), shadow_mask)
    mask = rounded_mask((CANVAS, CANVAS), scaled(214))
    bg.paste(ios, (0, 0), mask)
    return bg


def make_macos() -> Image.Image:
    content = draw_chart_content("macos")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    left, top, right, bottom = scaled(90), scaled(74), scaled(934), scaled(918)
    tile_w = right - left
    tile_h = bottom - top
    radius = scaled(190)

    shadow_mask = Image.new("L", (CANVAS, CANVAS), 0)
    sd = ImageDraw.Draw(shadow_mask)
    sd.rounded_rectangle((left, top + scaled(18), right, bottom + scaled(18)), radius=radius, fill=255)
    shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(scaled(38)))
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 135))
    canvas.paste(shadow, (0, 0), shadow_mask)

    tile = content.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
    mask = rounded_mask((tile_w, tile_h), radius)
    canvas.paste(tile, (left, top), mask)

    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rounded_rectangle(
        (left, top, right, bottom),
        radius=radius,
        outline=hex_to_rgba("#d9f4ff", 145),
        width=scaled(6),
    )
    draw.rounded_rectangle(
        (left + scaled(14), top + scaled(14), right - scaled(14), bottom - scaled(14)),
        radius=scaled(172),
        outline=hex_to_rgba("#ffffff", 48),
        width=scaled(3),
    )
    draw.arc(
        (left + scaled(58), top + scaled(44), right - scaled(58), bottom - scaled(144)),
        208,
        306,
        fill=hex_to_rgba("#ffffff", 34),
        width=scaled(4),
    )
    return canvas


def write_iconset(src: Image.Image, folder: Path, stem: str, sizes: list[tuple[str, int]]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for filename, px in sizes:
        src.resize((px, px), Image.Resampling.LANCZOS).save(folder / filename)


def write_ios_appiconset(src: Image.Image) -> None:
    folder = ROOT / "ios.appiconset"
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
    folder.mkdir(parents=True, exist_ok=True)
    contents = {"images": [], "info": {"author": "xcode", "version": 1}}
    src = src.convert("RGB")
    for idiom, logical_size, scale, px in images:
        filename = f"helm-ios-{logical_size.replace('.', '_')}@{scale}.png"
        src.resize((px, px), Image.Resampling.LANCZOS).save(folder / filename)
        contents["images"].append(
            {
                "filename": filename,
                "idiom": idiom,
                "scale": scale,
                "size": logical_size,
            }
        )
    (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")


def write_macos_iconset(src: Image.Image) -> None:
    sizes = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    folder = ROOT / "macos.iconset"
    write_iconset(src, folder, "helm-macos", sizes)
    icns_path = ROOT / "HelmAppIcon.icns"
    if shutil.which("iconutil"):
        try:
            subprocess.run(
                ["iconutil", "--convert", "icns", "--output", str(icns_path), str(folder)],
                check=True,
                stderr=subprocess.PIPE,
                text=True,
            )
            return
        except subprocess.CalledProcessError:
            pass
    src.save(
        icns_path,
        format="ICNS",
        sizes=[(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)],
    )


def write_size_test(ios_preview: Image.Image, macos: Image.Image) -> None:
    sizes = [16, 20, 29, 40, 60, 128, 256]
    pad = 34
    label_h = 28
    row_gap = 26
    width = sum(max(s, 54) + pad for s in sizes) + pad
    height = 256 + 256 + label_h * 2 + row_gap + pad * 2
    sheet = Image.new("RGBA", (width, height), (5, 8, 12, 255))
    draw = ImageDraw.Draw(sheet)

    def paste_row(src: Image.Image, y: int, title: str) -> None:
        draw.text((pad, y), title, fill=(218, 236, 248, 255))
        x = pad
        for size in sizes:
            thumb = src.resize((size, size), Image.Resampling.LANCZOS)
            box_w = max(size, 54)
            bx = x + (box_w - size) // 2
            by = y + label_h + (256 - size) // 2
            sheet.alpha_composite(thumb, (bx, by))
            draw.text((x, y + label_h + 256 + 4), f"{size}px", fill=(130, 160, 176, 255))
            x += box_w + pad

    paste_row(ios_preview.resize((SIZE, SIZE), Image.Resampling.LANCZOS), pad, "iOS masked preview")
    paste_row(macos.resize((SIZE, SIZE), Image.Resampling.LANCZOS), pad + label_h + 256 + row_gap, "macOS transparent preview")
    sheet.save(ROOT / "helm-app-icon-size-test.png")


def main() -> None:
    ios = make_ios()
    macos = make_macos()
    ios_preview = make_ios_preview(ios)
    save_downsampled(ios, ROOT / "helm-ios-app-icon-1024.png")
    save_downsampled(ios_preview, ROOT / "helm-ios-app-icon-preview.png")
    save_downsampled(macos, ROOT / "helm-macos-app-icon-1024.png")
    write_size_test(ios_preview, macos)
    write_ios_appiconset(ios.resize((SIZE, SIZE), Image.Resampling.LANCZOS))
    write_macos_iconset(macos.resize((SIZE, SIZE), Image.Resampling.LANCZOS))


if __name__ == "__main__":
    main()
