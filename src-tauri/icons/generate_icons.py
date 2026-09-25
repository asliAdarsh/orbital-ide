#!/usr/bin/env python3
"""Generate the Orbital icon set (PNG + ICO) with the Python standard library only.

    .venv/Scripts/python.exe src-tauri/icons/generate_icons.py

The mark is a chartreuse angular ring — the "O" of Orbital — on a graphite rounded square. Shapes
are rasterised from polygons at 2x supersampling and box-filtered down, so no image library, no
network access and no `cargo tauri icon` are involved.

This is a placeholder mark: it is the product's initial in the app's own accent, and a designed
logo should replace it by rewriting the two polygons below.
"""

from __future__ import annotations

import math
import struct
import zlib
from collections.abc import Callable
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parent

# Design tokens from src/index.css converted HSL -> sRGB:
#   --chrome-raised 220 13% 10% -> rgb(22, 27, 29)
#   --background    220 16% 4%  -> rgb(9, 10, 12)
#   --primary       74 92% 60%  -> rgb(203, 247, 59)
GRAPHITE_TOP = (22, 27, 29)
GRAPHITE_BOTTOM = (9, 10, 12)
ACCENT = (203, 247, 59)

MASTER = 1024
SUPERSAMPLE = 2
CORNER_RADIUS = 0.17

# Glyph geometry, normalised to the canvas: a ring, cut as an eight-sided outer band with a
# smaller eight-sided hole punched through it by the same counter trick the previous mark used.
# The flat top and bottom keep it in the same angular language as the rest of the interface.
RING_OUTER = (
    (0.500, 0.135),
    (0.758, 0.243),
    (0.865, 0.500),
    (0.758, 0.757),
    (0.500, 0.865),
    (0.242, 0.757),
    (0.135, 0.500),
    (0.242, 0.243),
)
RING_INNER = (
    (0.500, 0.325),
    (0.624, 0.376),
    (0.675, 0.500),
    (0.624, 0.624),
    (0.500, 0.675),
    (0.376, 0.624),
    (0.325, 0.500),
    (0.376, 0.376),
)

# Standard Tauri PNG set plus the Windows Store logo sizes.
PNG_TARGETS: tuple[tuple[str, int], ...] = (
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("256x256.png", 256),
    ("512x512.png", 512),
    ("icon.png", 1024),
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
    ("StoreLogo.png", 50),
)

ICO_SIZES = (16, 32, 48, 64, 256)

RGB = tuple[int, int, int]
Point = tuple[float, float]
RowColor = RGB | Callable[[int], RGB]


def _fill_rows(pixels: bytearray, size: int, color_at: Callable[[int], RGB]) -> None:
    stride = size * 4
    for y in range(size):
        red, green, blue = color_at(y)
        pixels[y * stride : (y + 1) * stride] = bytes((red, green, blue, 255)) * size


def _round_corners(pixels: bytearray, size: int, radius: float) -> None:
    """Clear the pixels outside the rounding arc in each corner quadrant."""
    corner = int(round(radius * size))
    radius_squared = corner * corner
    for box_y in (0, size - corner):
        for box_x in (0, size - corner):
            centre_x = corner if box_x == 0 else size - corner
            centre_y = corner if box_y == 0 else size - corner
            for y in range(box_y, box_y + corner):
                base = y * size * 4
                for x in range(box_x, box_x + corner):
                    dx = x + 0.5 - centre_x
                    dy = y + 0.5 - centre_y
                    if dx * dx + dy * dy > radius_squared:
                        pixels[base + x * 4 + 3] = 0


def _fill_polygon(pixels: bytearray, size: int, points: list[Point], color: RowColor) -> None:
    """Even-odd scanline fill. `color` is either a flat RGB triple or a per-row callable, which
    lets the ring's hole punch straight through to the background gradient."""
    edges: list[tuple[float, float, float, float]] = []
    for index, (x_a, y_a) in enumerate(points):
        x_b, y_b = points[(index + 1) % len(points)]
        if y_a != y_b:
            edges.append((x_a, y_a, x_b, y_b))

    top = max(0, int(math.floor(min(y for _, y in points))))
    bottom = min(size, int(math.ceil(max(y for _, y in points))) + 1)
    for y in range(top, bottom):
        scan = y + 0.5
        crossings: list[float] = []
        for x_a, y_a, x_b, y_b in edges:
            low, high = (y_a, y_b) if y_a < y_b else (y_b, y_a)
            if low <= scan < high:
                crossings.append(x_a + (scan - y_a) / (y_b - y_a) * (x_b - x_a))
        if not crossings:
            continue
        crossings.sort()
        red, green, blue = color(y) if callable(color) else color
        fill = bytes((red, green, blue, 255))
        for index in range(0, len(crossings) - 1, 2):
            start = max(0, int(math.ceil(crossings[index] - 0.5)))
            end = min(size, int(math.ceil(crossings[index + 1] - 0.5)))
            if end > start:
                pixels[(y * size + start) * 4 : (y * size + end) * 4] = fill * (end - start)


def _render(size: int) -> bytearray:
    def row_color(y: int) -> RGB:
        travel = y / max(size - 1, 1)
        return (
            int(round(GRAPHITE_TOP[0] + (GRAPHITE_BOTTOM[0] - GRAPHITE_TOP[0]) * travel)),
            int(round(GRAPHITE_TOP[1] + (GRAPHITE_BOTTOM[1] - GRAPHITE_TOP[1]) * travel)),
            int(round(GRAPHITE_TOP[2] + (GRAPHITE_BOTTOM[2] - GRAPHITE_TOP[2]) * travel)),
        )

    pixels = bytearray(size * size * 4)
    _fill_rows(pixels, size, row_color)
    _round_corners(pixels, size, CORNER_RADIUS)

    def scale(point: Point) -> Point:
        return (point[0] * size, point[1] * size)

    outer = [scale(point) for point in RING_OUTER]
    hole = [scale(point) for point in RING_INNER]

    _fill_polygon(pixels, size, outer, ACCENT)
    # The hole is filled with the background gradient, not with a flat colour, so the ring reads as
    # a cut-out rather than as a lighter disc sitting on the tile.
    _fill_polygon(pixels, size, hole, row_color)
    return pixels


def _resize(source: bytearray, size: int, target: int) -> bytearray:
    """Bilinear resample. Every size is derived from the nearest larger power of two, so a halving
    degenerates into an exact 2x2 box average; alpha is averaged premultiplied to keep the rounded
    corners from picking up dark fringes."""
    if target == size:
        return bytearray(source)

    output = bytearray(target * target * 4)
    scale = size / target
    for y in range(target):
        source_y = (y + 0.5) * scale - 0.5
        y0 = int(math.floor(source_y))
        weight_y = source_y - y0
        row_a = min(max(y0, 0), size - 1) * size * 4
        row_b = min(max(y0 + 1, 0), size - 1) * size * 4
        for x in range(target):
            source_x = (x + 0.5) * scale - 0.5
            x0 = int(math.floor(source_x))
            weight_x = source_x - x0
            col_a = min(max(x0, 0), size - 1) * 4
            col_b = min(max(x0 + 1, 0), size - 1) * 4
            corners = (
                (row_a + col_a, (1 - weight_x) * (1 - weight_y)),
                (row_a + col_b, weight_x * (1 - weight_y)),
                (row_b + col_a, (1 - weight_x) * weight_y),
                (row_b + col_b, weight_x * weight_y),
            )
            alpha = sum(source[offset + 3] * weight for offset, weight in corners)
            if alpha <= 0:
                continue
            target_offset = (y * target + x) * 4
            output[target_offset + 3] = min(255, int(round(alpha)))
            for channel in range(3):
                premultiplied = sum(
                    source[offset + channel] * source[offset + 3] * weight
                    for offset, weight in corners
                )
                output[target_offset + channel] = min(255, max(0, int(round(premultiplied / alpha))))
    return output


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def _encode_png(size: int, pixels: bytearray) -> bytes:
    stride = size * 4
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        raw += pixels[y * stride : (y + 1) * stride]
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _png_chunk(b"IEND", b"")
    )


def _encode_ico(frames: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = len(header) + 16 * len(frames)
    entries = bytearray()
    payload = bytearray()
    for size, data in frames:
        dimension = 0 if size >= 256 else size  # 0 encodes 256 in the ICO directory
        entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    return bytes(header + entries + payload)


def _at_size(levels: dict[int, bytearray], target: int) -> bytearray:
    if target in levels:
        return levels[target]
    base = min(size for size in levels if size >= target)
    return _resize(levels[base], base, target)


def main() -> None:
    supersampled = MASTER * SUPERSAMPLE
    master = _resize(_render(supersampled), supersampled, MASTER)

    levels = {MASTER: master}
    size = MASTER
    while size > ICO_SIZES[0] * 2:
        size //= 2
        levels[size] = _resize(levels[size * 2], size * 2, size)

    written: list[str] = []
    for name, target in PNG_TARGETS:
        (ICONS_DIR / name).write_bytes(_encode_png(target, _at_size(levels, target)))
        written.append(name)

    frames = [(ico_size, _encode_png(ico_size, _at_size(levels, ico_size))) for ico_size in ICO_SIZES]
    (ICONS_DIR / "icon.ico").write_bytes(_encode_ico(frames))
    written.append("icon.ico")

    for name in written:
        print(f"{name}\t{(ICONS_DIR / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
