# FAVICON-FLUKE: regenerate the favicon and app-icon family of every RawProd console from the
# owner's brand handoff artwork (handoff/brand/logo/rac-icon-shell-fluke-white.png, carried in
# the repo as web/logo/rac-icon-shell-fluke-white.png, byte for byte).
# Needs Pillow (a dev tool, not a repo dependency; same footing as brand-marks.py).
#   python3 tools/brand/favicon-fluke.py            # reads web/logo/..., writes web/, web-platform/, web-vault/
#   python3 tools/brand/favicon-fluke.py <white-icon.png> <out-dir> [<out-dir> ...]
#
# WHY A TILE. The handoff icons are transparent PNGs in one flat colour. The ink one disappears on
# a dark browser tab and the white one on a light tab, so neither can be a favicon as it stands.
# Every file here is the WHITE fluke on a solid KON NAVY (#121A33) tile, which reads on both.
#
# Only two colours ever leave this script: every pixel is Kon Navy, white, or a straight blend of
# the two (the fluke's own anti-aliasing), and the tile's alpha is carried separately. Nothing is
# resampled in RGBA, so there is no dark or light fringe at the rounded corners.
#
#   shape     files                                       tile                    fluke / side  radius
#   tab       favicon-16.png, favicon-32.png, -48.png     rounded, clear corners  0.84          0.19
#   tile      icon-192.png, icon-512.png (purpose "any")  rounded, clear corners  0.62          0.22
#   bleed     apple-touch-icon.png (180)                  opaque, edge to edge    0.62          none
#   maskable  icon-maskable-192.png, -512.png             opaque, edge to edge    0.56          none
#   favicon.ico = the three tab PNGs, embedded unchanged (16 + 32 + 48)
#
# tab: no margin beyond the tile; at 16 px every column given to padding is a column the fluke loses.
# bleed: iOS rounds the icon itself and paints transparency black, so it gets no corners and no alpha.
# maskable: a launcher may crop to any shape containing the central 80 %; at 0.56 the mark's far corner
# is 0.35 of the side from the centre, inside the 0.4 safe zone.
#
# ONE FAMILY WITH ALEMBIC. raw, rawadmin, rawagent and rawstudio draw their icons from the same
# handoff file with ALEMBIC's own generator (ops/scripts/gen-favicons.mjs in the ALEMBIC worktree
# lane/favicon-fluke; read on 2026-11-12, before it was committed). The shapes, fractions, radii,
# whole-pixel placement and the 16 px gain here are that script's numbers on purpose, so a Factory
# tab beside an Admin tab shows the same mark at the same size. The two resample differently, so the
# files agree to the eye and not to the byte. Change the numbers in one, change them in both.
#
# GAIN. Below 24 px the channels between the fluke's feathers are thinner than a pixel, so an honest
# area average turns the whole mark grey and it loses the contrast the tile exists to give. The 16 px
# icon lifts the mark's coverage by a quarter (clamped at white), which closes the channels into a white
# silhouette and leaves the outline where it was. 32 px and up keep the channels: they are the mark's
# detail and there are pixels to draw them with.
import sys, struct, io, os, math
from PIL import Image, ImageDraw

NAVY = (0x12, 0x1A, 0x33)   # Kon Navy, handoff/brand/README.md "Colour"
WHITE = (255, 255, 255)

# shape -> (fluke width / tile side, corner radius / tile side)
SHAPES = {'tab': (0.84, 0.19), 'tile': (0.62, 0.22), 'bleed': (0.62, 0.0), 'maskable': (0.56, 0.0)}
SMALL, SMALL_GAIN = 24, 1.25

FAMILY = [
    ('favicon-16.png', 16, 'tab'),
    ('favicon-32.png', 32, 'tab'),
    ('favicon-48.png', 48, 'tab'),
    ('icon-192.png', 192, 'tile'),
    ('icon-512.png', 512, 'tile'),
    ('apple-touch-icon.png', 180, 'bleed'),
    ('icon-maskable-192.png', 192, 'maskable'),
    ('icon-maskable-512.png', 512, 'maskable'),
]
ICO = ['favicon-16.png', 'favicon-32.png', 'favicon-48.png']


def half_up(x):
    """Round half up, as JavaScript's Math.round does. Python's round() goes to the even neighbour, which
    put the 512 px maskable mark one row above ALEMBIC's (148.5 -> 148 here, 149 there)."""
    return math.floor(x + 0.5)


def render(mark, size, shape):
    """One icon. `mark` is the artwork's alpha cropped to its own bounds (mode L)."""
    frac, radius = SHAPES[shape]
    # The fluke's box in whole pixels, with the same parity as the tile so the left and right margins
    # are equal: at 16 px one pixel is a sixteenth of the icon.
    gw = half_up(size * frac)
    if (size - gw) % 2:
        gw += 1
    gh = half_up(gw * mark.height / mark.width)
    gx, gy = (size - gw) // 2, half_up((size - gh) / 2)
    gain = SMALL_GAIN if size < SMALL else 1.0
    k = 8 if size <= 48 else 4          # supersample, then area-average down
    big = size * k
    fluke = Image.new('L', (big, big), 0)
    fluke.paste(mark.resize((gw * k, gh * k), Image.LANCZOS), (gx * k, gy * k))
    fluke = fluke.reduce(k)
    if radius:
        tile = Image.new('L', (big, big), 0)
        ImageDraw.Draw(tile).rounded_rectangle((0, 0, big - 1, big - 1), radius=half_up(size * radius) * k, fill=255)
        tile = tile.reduce(k)
    else:
        tile = Image.new('L', (size, size), 255)
    out = Image.new('RGBA', (size, size))
    fp, tp, op = fluke.load(), tile.load(), out.load()
    for y in range(size):
        for x in range(size):
            t = min(1.0, gain * fp[x, y] / 255.0)
            op[x, y] = tuple(round(n + (w - n) * t) for n, w in zip(NAVY, WHITE)) + (tp[x, y],)
    return out


def png_bytes(im):
    b = io.BytesIO()
    im.save(b, 'PNG', optimize=True)    # no text chunks, no timestamp: the same input gives the same bytes
    return b.getvalue()


def ico_bytes(pngs):
    """An .ico whose entries ARE the PNG files (PNG-in-ICO), so the three sizes cannot drift apart."""
    head = struct.pack('<HHH', 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, body = b'', b''
    for size, data in pngs:
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset + len(body))
        body += data
    return head + entries + body


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, '..', '..'))
    src = argv[1] if len(argv) > 1 else os.path.join(root, 'web', 'logo', 'rac-icon-shell-fluke-white.png')
    outs = argv[2:] if len(argv) > 2 else [os.path.join(root, d) for d in ('web', 'web-platform', 'web-vault')]
    alpha = Image.open(src).convert('RGBA').getchannel('A')
    mark = alpha.crop(alpha.getbbox())  # the handoff canvas has uneven margins; centre the mark itself
    files = {}
    for name, size, shape in FAMILY:
        files[name] = png_bytes(render(mark, size, shape))
    files['favicon.ico'] = ico_bytes([(int(n.split('-')[1].split('.')[0]), files[n]) for n in ICO])
    for out in outs:
        os.makedirs(out, exist_ok=True)
        for name, data in files.items():
            with open(os.path.join(out, name), 'wb') as f:
                f.write(data)
    for name, data in sorted(files.items()):
        print(f'{name:24s} {len(data):6d} bytes', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv)
