"""Generate the PWA icons in public/icons/.

Run with:  python tools/make_icons.py

The icons are committed, so this script is not part of any build. It exists so
the icons are reproducible and tweakable rather than being opaque binaries
nobody can regenerate.

PNGs are written by hand (zlib + the four required chunks) because the repo has
no dependencies and adding Pillow just to draw a bowl is not worth it.

Two purposes, per the Web App Manifest spec:

  any       a rounded-square badge, drawn to its own edges. This is what shows
            in a browser tab and in contexts that do not mask.
  maskable  full-bleed colour with the glyph kept inside the 80% safe zone,
            because Android crops maskable icons to whatever shape the launcher
            uses. A glyph drawn to the edge would lose its edges.
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "icons")

BG = (180, 84, 31)        # --accent, the terracotta from style.css
GLYPH = (255, 248, 240)   # warm white

SS = 3                    # supersampling factor, for antialiased edges


# ----------------------------------------------------------------- png writer
def _chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path, width, height, pixels):
    """pixels: flat list of (r, g, b, a) tuples, row-major."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)                                  # filter type 0 (None)
        for x in range(width):
            raw.extend(pixels[y * width + x])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)   # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", ihdr)
           + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + _chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


# --------------------------------------------------------------------- shapes
def rounded_square(x, y, size, radius):
    """True if (x, y) is inside a rounded square covering 0..size."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def glyph(x, y, size, scale, shift_y):
    """A bowl with three curls of steam above it.

    scale and shift_y place the same drawing inside either the badge's padded
    area or the maskable safe zone, so both icons are recognisably one icon.
    """
    u = (x - size / 2.0) / (size * scale)      # -0.5..0.5 across the glyph
    v = (y - size / 2.0) / (size * scale) - shift_y

    # Bowl: lower half of a disc, with a flat rim bar sitting on top of it.
    if v >= 0.02 and (u * u + v * v) <= 0.36 ** 2:
        return True
    if -0.055 <= v <= 0.025 and abs(u) <= 0.42:
        return True

    # Steam: three curls rising from the bowl, the middle one taller. Just over
    # one sine period each -- more than that and they read as zigzags, not steam.
    for offset, height, thickness in ((-0.23, 0.30, 0.042),
                                      (0.00, 0.40, 0.046),
                                      (0.23, 0.30, 0.042)):
        top = -0.17 - height
        if top <= v <= -0.17:
            phase = (v - top) / height          # 0 at the top, 1 at the bowl
            wave = offset + 0.062 * math.sin(phase * 1.25 * math.pi)
            if abs(u - wave) <= thickness:
                return True
    return False


def render(size, maskable):
    """Supersampled so the curves have soft edges at 192px."""
    if maskable:
        # Full bleed; glyph inside the 80% safe zone.
        bg_test = lambda x, y: True
        scale, shift = 0.62, 0.02
    else:
        bg_test = lambda x, y: rounded_square(x, y, size, size * 0.22)
        scale, shift = 0.78, 0.02

    pixels = []
    step = 1.0 / SS
    samples = SS * SS
    for py in range(size):
        for px in range(size):
            bg_hits = 0
            glyph_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if bg_test(x, y):
                        bg_hits += 1
                        if glyph(x, y, size, scale, shift):
                            glyph_hits += 1
            if bg_hits == 0:
                pixels.append((0, 0, 0, 0))
                continue
            # Blend glyph over background by coverage, then apply the
            # background's own coverage as alpha so the rounded corners are
            # smooth rather than stepped.
            g = glyph_hits / float(bg_hits)
            rgb = tuple(int(round(BG[i] * (1 - g) + GLYPH[i] * g)) for i in range(3))
            pixels.append(rgb + (int(round(255 * bg_hits / samples)),))
    return pixels


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        for maskable in (False, True):
            name = "icon-%d%s.png" % (size, "-maskable" if maskable else "")
            path = os.path.join(OUT, name)
            write_png(path, size, size, render(size, maskable))
            print("wrote %s (%d bytes)" % (name, os.path.getsize(path)))


if __name__ == "__main__":
    main()
