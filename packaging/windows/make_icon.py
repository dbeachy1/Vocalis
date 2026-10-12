"""Draws the Vocalis icon (packaging/windows/vocalis.ico) with Pillow.

The mark is the web UI favicon, `source/vocalis/src/webui/index.html` (the `<link rel="icon">` data
URI). Decoded, it is this SVG, which this script reproduces without an SVG renderer:

    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <rect width="64" height="64" rx="14" fill="#2a2d33"/>
      <path d="M18 18 L32 46 L46 18" fill="none" stroke="#ff7a18" stroke-width="10"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>

Design amendment 13 (Windows installer): draw at 1024 px (16 pixels per viewBox unit), use circles for
the round caps and joins, and reduce to each icon size with LANCZOS. The 64-unit viewBox maps onto the
1024 px canvas exactly, so every coordinate below is the SVG value times SCALE.

Satellite tray icon (October 11, 2026, design "Satellite setup program and tray icon for Windows"): the
notification-area icon has three looks, all drawn by this script from the same drawing so they are not
a different picture. "colour" is vocalis.ico itself (the satellite is running); "stopped" is the same V
in grey (stopped, starting, or nothing to run); "nodocker" is the grey V with a small red mark in the
lower right corner (Docker Desktop is not running).

Wizard pictures (October 11, 2026): both setup programs (vocalis.iss and
vocalis-satellite.iss) show the Vocalis V on the pictures of Inno Setup's modern wizard instead of Inno's
stock ones. WizardSmallImageFile is the square picture in the upper right corner of the inner pages: the
icon itself (the colour look) with a small transparent margin. WizardImageFile is the tall picture on the
left of the Welcome and Finish pages (aspect 164:314): the same orange V, at the same scale as in the icon,
on the same dark colour. (Superseded October 11, 2026 for the small picture: it is no longer the icon with a
small margin. See the comment at WIZARD_SMALL_GAP below: the dark square is smaller and the transparent margin
is what gives it the same gap from the top and the bottom of the header as the page title has from the top.) Inno Setup 6.7.3 picks the file that best matches the size of its image area,
which depends on the display scaling, so each picture is written at the seven sizes the help lists for
100% through 250% (WizardSmallImageFile and WizardImageFile topics): small 58, 77, 97, 116, 124, 143 and
159 pixels square; large 202x386, 269x515, 336x643, 403x772, 430x824, 498x953 and 534x1022. No SVG renderer
and no font: the pictures carry no text.

Run from anywhere: `python packaging/windows/make_icon.py` rewrites vocalis.ico, the two grey
looks (vocalis-satellite-stopped.ico, vocalis-satellite-nodocker.ico) and the fourteen wizard pictures
(vocalis-wizard-small-<n>.png, vocalis-wizard-large-<w>x<h>.png) beside this script.
The output is committed; rerun this only when the favicon changes. The colour look is byte-identical
to the vocalis.ico committed before the grey looks were added.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024
VIEWBOX = 64
SCALE = CANVAS // VIEWBOX  # 16 pixels per viewBox unit
SIZES = (16, 24, 32, 48, 64, 128, 256)

BACKGROUND = (0x2A, 0x2D, 0x33, 255)  # #2a2d33
STROKE = (0xFF, 0x7A, 0x18, 255)  # #ff7a18
CORNER_RADIUS = 14 * SCALE  # rx="14"
STROKE_WIDTH = 10 * SCALE  # stroke-width="10"
POINTS = [(18 * SCALE, 18 * SCALE), (32 * SCALE, 46 * SCALE), (46 * SCALE, 18 * SCALE)]  # M18 18 L32 46 L46 18

# The grey looks of the tray icon (same geometry, only the colours and the small mark differ).
GREY_STROKE = (0x8B, 0x8F, 0x98, 255)  # the V when the satellite is not running
MARK_FILL = (0xE5, 0x48, 0x4D, 255)  # the small mark: Docker Desktop is not running
MARK_CENTER = (47 * SCALE, 47 * SCALE)  # lower right, clear of the V's arms
MARK_RADIUS = 14 * SCALE
MARK_RING = 2 * SCALE  # a ring in the background colour keeps the mark apart from the V
MARK_GLYPH = (255, 255, 255, 255)  # the "!" drawn inside the mark

# look name -> (file name beside this script, stroke colour, drawn with the small mark)
LOOKS = {
    "colour": ("vocalis.ico", STROKE, False),
    "stopped": ("vocalis-satellite-stopped.ico", GREY_STROKE, False),
    "nodocker": ("vocalis-satellite-nodocker.ico", GREY_STROKE, True),
}


def draw_v(draw: ImageDraw.ImageDraw, stroke: tuple, dx: int = 0, dy: int = 0) -> None:
    """The round-capped V, the icon's geometry at SCALE pixels per viewBox unit, moved by (dx, dy) pixels.
    With the default (0, 0) every coordinate is exactly what draw_master always used, so the icons do not change."""
    half = STROKE_WIDTH / 2
    points = [(x + dx, y + dy) for x, y in POINTS]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        # Each straight segment is a quadrilateral offset by half the stroke width on both sides.
        length = math.hypot(x1 - x0, y1 - y0)
        nx, ny = -(y1 - y0) / length * half, (x1 - x0) / length * half
        draw.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], fill=stroke)
    # A circle at both ends (round caps) and at the middle vertex (round join).
    for x, y in points:
        draw.ellipse((x - half, y - half, x + half, y + half), fill=stroke)


def draw_master(look: str = "colour") -> Image.Image:
    """The 1024 px master: transparent corners, rounded square, round-capped V (and, for the "nodocker" look, the mark)."""
    _, stroke, with_mark = LOOKS[look]
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1), radius=CORNER_RADIUS, fill=BACKGROUND)
    draw_v(draw, stroke)
    if with_mark:
        cx, cy = MARK_CENTER
        ring = MARK_RADIUS + MARK_RING
        draw.ellipse((cx - ring, cy - ring, cx + ring, cy + ring), fill=BACKGROUND)
        draw.ellipse((cx - MARK_RADIUS, cy - MARK_RADIUS, cx + MARK_RADIUS, cy + MARK_RADIUS), fill=MARK_FILL)
        # "!": a bar and a dot, in viewBox units times SCALE.
        draw.rounded_rectangle((cx - 2 * SCALE, cy - 8 * SCALE, cx + 2 * SCALE, cy + 2 * SCALE), radius=2 * SCALE, fill=MARK_GLYPH)
        draw.ellipse((cx - 2.2 * SCALE, cy + 4.6 * SCALE, cx + 2.2 * SCALE, cy + 9 * SCALE), fill=MARK_GLYPH)
    return image


def build_icon(path: Path, look: str = "colour") -> list[int]:
    master = draw_master(look)
    frames = {size: master.resize((size, size), Image.Resampling.LANCZOS) for size in SIZES}
    largest = frames[max(SIZES)]
    # append_images supplies each size as drawn here instead of letting the ICO writer rescale it.
    largest.save(path, format="ICO", sizes=[(size, size) for size in SIZES],
                 append_images=[frames[size] for size in SIZES if size != max(SIZES)])
    return list(SIZES)


# ---- the wizard pictures of both setup programs ---------------------------------------------------------------

# The sizes of Inno Setup 6.7.3's image areas at 100%, 125%, 150%, 175%, 200%, 225% and 250% display scaling with the
# default font and WizardSizePercent (WizardSmallImageFile and WizardImageFile help topics). Setup picks the file that
# best matches the area, so a file at exactly each size is never stretched.
WIZARD_SMALL_SIZES = (58, 77, 97, 116, 124, 143, 159)  # square
WIZARD_LARGE_SIZES = ((202, 386), (269, 515), (336, 643), (403, 772), (430, 824), (498, 953), (534, 1022))  # 164:314
# The small picture, October 11, 2026. Doug, looking at the real satellite setup program: the picture "needs a little bit
# more space between the icon edge and the edge of the frame on the top and the right ... It should match the gap on the
# top and the left for the left side of the text." The header panel of Inno Setup 6.7.3's modern wizard is as high as the
# picture area (58 pixels at 100%) and the picture sat in its top right corner. The page title label starts 8 pixels from
# the top and 24 from the left of the header at 100% (measured on the hidden desktop with Log() calls of the label and
# image geometry, October 11, 2026: header 596x58, picture 58x58 at left 538 and top 0, title label left 24 and top 8).
# So the dark square is drawn with a transparent margin of the title label's top (8 pixels at 100%) on all four sides of
# the picture area, which centers it vertically with a top and bottom gap equal to the title's top; the [Code] of both .iss
# files (wizard-header-picture.iss) then moves the picture left so the right gap equals the title label's left.
# The picture files are exactly the size of the picture area, so Setup draws them at their own pixel size, not stretched.
# WIZARD_SMALL_GAP is the title label's top at each display scaling. 58 is measured. The others are Delphi's
# rounding of 8 * (area size / 58) (Inno scales every position by one factor, whose result for the 58 pixel area is the
# listed area size); the [Code] logs the real value at run time so a different one can be seen in an Inno log.
WIZARD_SMALL_GAP = {58: 8, 77: 11, 97: 13, 116: 16, 124: 17, 143: 20, 159: 22}
LARGE_MASTER = (CANVAS, round(CANVAS * 314 / 164))  # 1024 x 1961, the aspect ratio of the large image area
LARGE_V_CENTER = 0.36  # the V's center sits this fraction down the large picture, above the middle


def wizard_small_name(size: int) -> str:
    return f"vocalis-wizard-small-{size}.png"


def wizard_large_name(size: tuple) -> str:
    return f"vocalis-wizard-large-{size[0]}x{size[1]}.png"


def wizard_picture_names() -> list:
    """Every wizard picture file name, small ones first; the .iss files list the same names."""
    return [wizard_small_name(size) for size in WIZARD_SMALL_SIZES] + [wizard_large_name(size) for size in WIZARD_LARGE_SIZES]


def draw_wizard_small(size: int) -> Image.Image:
    """The icon (colour look) as a square of size - 2 * gap pixels, at a distance of gap pixels from every edge of a
    transparent size x size picture. The tile is reduced from the 1024 px master with LANCZOS like the icon's own sizes."""
    gap = WIZARD_SMALL_GAP[size]
    side = size - 2 * gap
    tile = draw_master("colour").resize((side, side), Image.Resampling.LANCZOS)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    image.paste(tile, (gap, gap), tile)
    return image


def draw_wizard_large_master() -> Image.Image:
    """The tall picture: the dark colour of the icon's square with the icon's orange V on it, at the icon's own scale."""
    width, height = LARGE_MASTER
    image = Image.new("RGB", LARGE_MASTER, BACKGROUND[:3])
    draw = ImageDraw.Draw(image)
    # The V's box in the icon is 18..46 units plus half the stroke on each side: centered at (32, 32) units. Move that
    # center to the middle of the picture's width and LARGE_V_CENTER of its height.
    draw_v(draw, STROKE, dx=width // 2 - 32 * SCALE, dy=round(height * LARGE_V_CENTER) - 32 * SCALE)
    return image


def build_wizard_pictures(directory: Path) -> list:
    """Writes the fourteen wizard pictures into directory and returns their paths. PNG at the highest compression
    level with the encoder's default filter, so the same Pillow writes the same bytes."""
    written = []
    for size in WIZARD_SMALL_SIZES:
        path = directory / wizard_small_name(size)
        draw_wizard_small(size).save(path, format="PNG", compress_level=9)
        written.append(path)
    large_master = draw_wizard_large_master()
    for size in WIZARD_LARGE_SIZES:
        path = directory / wizard_large_name(size)
        large_master.resize(size, Image.Resampling.LANCZOS).save(path, format="PNG", compress_level=9)
        written.append(path)
    return written


# ---- the Nomi browser extension's icons -----------------------------------------------------------------------

# The extension's manifest names three icon files, and Chrome refuses to load an unpacked extension when one of
# them is missing. They are the same V as everything else here, drawn by this script, so no outside artwork is
# needed.
NOMI_ICON_SIZES = (16, 48, 128)
NOMI_ICON_DIRECTORY = Path(__file__).resolve().parents[2] / "source" / "vocalis" / "nomi" / "chrome_extension" / "icons"


def nomi_icon_name(size: int) -> str:
    return f"icon{size}.png"


def build_nomi_extension_icons(directory: Path) -> list:
    """Writes the extension's three icons into directory and returns their paths."""
    directory.mkdir(parents=True, exist_ok=True)
    master = draw_master("colour")
    written = []
    for size in NOMI_ICON_SIZES:
        path = directory / nomi_icon_name(size)
        master.resize((size, size), Image.Resampling.LANCZOS).save(path, format="PNG", compress_level=9)
        written.append(path)
    return written


def main() -> int:
    for look, (name, _stroke, _mark) in LOOKS.items():
        path = Path(__file__).resolve().with_name(name)
        sizes = build_icon(path, look)
        print(f"Wrote {path} ({path.stat().st_size} bytes, look {look}) with sizes {sizes}.")
    for path in build_wizard_pictures(Path(__file__).resolve().parent):
        print(f"Wrote {path} ({path.stat().st_size} bytes).")
    for path in build_nomi_extension_icons(NOMI_ICON_DIRECTORY):
        print(f"Wrote {path} ({path.stat().st_size} bytes).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
