"""Measures the Vocalis V's dark square in a capture of a setup wizard's inner page (Windows or not; needs Pillow).

October 11, 2026 (the wizard header picture check). Doug asked for the same gap above and to the right of the small
picture in the wizard's header as the page title has from the top and the left of the header. The capture comes from
drive_installer.ps1 or drive_satellite_installer.ps1 (-CancelAtPage 'License Agreement' -CaptureDir <folder>), whose log
line for the capture ends in `client=<x>,<y>,<width>,<height>`: where the window's client area starts inside the picture
and how big it is. The Inno log (/LOG=) of the same run has the line `Header picture: header 596x58, title label left 24
top 8, ...` that wizard-header-picture.iss writes; its numbers go in as --header-height, --title-left and --title-top.

Usage: python measure_wizard_header.py CAPTURE.png --client X,Y,W,H --header-height H --title-left L --title-top T

Prints the bounding box of the dark square (the pixels within a small distance of the icon's dark color #2a2d33, in the
right half of the header) and the three gaps: from the top of the header, from the bottom of the header, and from the
right edge of the header; then whether each is within --tolerance pixels (default 1) of its target (the title label's
top, the top gap, the title label's left). Exit code 0 when all three are within the tolerance, 1 when not.
"""
from __future__ import annotations

import argparse
import sys

from PIL import Image

DARK = (0x2A, 0x2D, 0x33)
DISTANCE = 40  # per channel; the edge pixels of the picture are opaque, so this only has to separate the dark from white


def measure(path: str, client: tuple, header_height: int) -> dict:
    x0, y0, width, _height = client
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        box = None
        for y in range(y0, y0 + header_height):
            for x in range(x0 + width // 2, x0 + width):
                pixel = rgb.getpixel((x, y))
                if all(abs(pixel[i] - DARK[i]) <= DISTANCE for i in range(3)):
                    if box is None:
                        box = [x, y, x, y]
                    else:
                        box = [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)]
    if box is None:
        raise SystemExit(f"no dark square found in the header of {path}")
    left, top, right, bottom = box  # inclusive pixel coordinates in the capture
    return {
        "box_in_header": (left - x0, top - y0, right - x0, bottom - y0),
        "size": (right - left + 1, bottom - top + 1),
        "gap_top": top - y0,
        "gap_bottom": header_height - (bottom - y0 + 1),
        "gap_right": width - (right - x0 + 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("capture")
    parser.add_argument("--client", required=True, help="X,Y,W,H of the client area inside the capture")
    parser.add_argument("--header-height", type=int, required=True)
    parser.add_argument("--title-left", type=int, required=True)
    parser.add_argument("--title-top", type=int, required=True)
    parser.add_argument("--tolerance", type=int, default=1)
    args = parser.parse_args()
    client = tuple(int(part) for part in args.client.split(","))
    result = measure(args.capture, client, args.header_height)
    print(f"dark square, in header pixels (left, top, right, bottom): {result['box_in_header']}, size {result['size'][0]}x{result['size'][1]}")
    checks = [("top gap", result["gap_top"], args.title_top), ("bottom gap", result["gap_bottom"], result["gap_top"]),
              ("right gap", result["gap_right"], args.title_left)]
    ok = True
    for name, value, target in checks:
        good = abs(value - target) <= args.tolerance
        ok = ok and good
        print(f"{name}: {value} px (target {target}) {'ok' if good else 'NOT within tolerance'}")
    print(f"title label: left {args.title_left}, top {args.title_top}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
