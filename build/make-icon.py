# Generates build/icon.png (1024px), build/icon.icns and the in-app copy: the app's mark, a >_ prompt in rainbow
# colours (top to bottom, like the classic rainbow bands) on a white tile, drawn here from geometry (a 48-unit
# drawing), on the macOS Big Sur grid: an 824px squircle with a soft drop shadow inside a 1024px canvas.
# Run with any Python that has Pillow and NumPy:  python3 build/make-icon.py
import math, os, subprocess
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S, BODY, SS = 1024, 824, 4          # canvas, squircle body, supersampling for smooth edges
here = os.path.dirname(os.path.abspath(__file__))
U = BODY / 48                        # one unit of the 48-unit drawing, in pixels
O = (S - BODY) / 2                   # where the body starts

def squircle_mask(n=5.0, scale=4):
    big = S * scale
    mask = Image.new('L', (big, big), 0)
    c, half = big / 2, BODY * scale / 2
    pts = []
    for i in range(1440):
        t = 2 * math.pi * i / 1440
        x, y = math.cos(t), math.sin(t)
        pts.append((c + half * abs(x) ** (2 / n) * (1 if x >= 0 else -1), c + half * abs(y) ** (2 / n) * (1 if y >= 0 else -1)))
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((S, S), Image.LANCZOS)

# The rainbow, top to bottom across the glyph.
STOPS = [(0.00, (255, 94, 87)), (0.20, (255, 149, 0)), (0.38, (255, 204, 0)), (0.56, (52, 199, 89)), (0.76, (10, 132, 255)), (1.00, (175, 82, 222))]
def ramp(t):
    t = np.clip(t, 0, 1); out = np.zeros(t.shape + (3,))
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        inside = ((t >= a) & (t <= b))[..., None]; f = ((t - a) / (b - a))[..., None]
        out = np.where(inside, np.array(ca) * (1 - f) + np.array(cb) * f, out)
    return out

# The glyph: chevron and underscore as round-capped strokes, as in the 48-unit drawing.
def strokes(scale):
    layer = Image.new('L', (S * scale, S * scale), 0)
    draw = ImageDraw.Draw(layer)
    width = 4.4 * U * scale
    def at(x, y): return ((O + x * U) * scale, (O + y * U) * scale)
    for path in ([(14.5, 16.5), (22, 24), (14.5, 31.5)], [(25.5, 31.5), (34, 31.5)]):
        pts = [at(*p) for p in path]
        draw.line(pts, fill=255, width=round(width), joint='curve')
        for x, y in pts: draw.ellipse((x - width / 2, y - width / 2, x + width / 2, y + width / 2), fill=255)
    return layer.resize((S, S), Image.LANCZOS)
glyph = strokes(SS)

yy, xx = np.mgrid[0:S, 0:S].astype(float)
top_y, bottom_y = O + 14.3 * U, O + 33.7 * U            # the glyph's height, strokes included
colours = Image.fromarray(ramp((yy - top_y) / (bottom_y - top_y)).astype(np.uint8))
# The tile: white, a touch warmer and darker at the bottom.
t = np.clip((yy - O) / BODY, 0, 1)[..., None]
tile = Image.fromarray((np.array([255, 255, 255]) * (1 - t) + np.array([241, 239, 235]) * t).astype(np.uint8))
tile.paste((0, 0, 0), (0, 12), glyph.filter(ImageFilter.GaussianBlur(16)).point(lambda v: v * 0.10))  # a soft shadow
tile.paste(colours, (0, 0), glyph)

mask = squircle_mask()
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 255), (0, 14), mask.point(lambda v: v * 0.45))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(20)))
img.paste(tile.convert('RGBA'), (0, 0), mask)
# a hairline edge, so the white tile holds its shape on light backgrounds
ring = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
img.paste((0, 0, 0, 255), (0, 0), ring.point(lambda v: v * 0.10))

img.save(os.path.join(here, 'icon.png'))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(here, '..', 'app', 'renderer', 'public', 'app-icon.png'))
iconset = os.path.join(here, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for size in [16, 32, 128, 256, 512]:
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(here, 'icon.icns')], check=True)
for name in os.listdir(iconset):
    os.remove(os.path.join(iconset, name))
os.rmdir(iconset)
print('wrote build/icon.png, build/icon.icns and app/renderer/public/app-icon.png')
