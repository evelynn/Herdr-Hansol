#!/usr/bin/env python3
"""The guild hall (dark) layout's floor plan: the office's own planner (hansol-office.py) is not touched.

Called by office.js like the office planner when shared "hansol.layout" is "guild-dark":
    hansol-guild.py --agents JSON --box WxH [--demo] [--config JSON] [--theme guild-dark|guild-meadow]
    hansol-guild.py --check          -> {"ready": n, "total": m, "sheets": [...]} (the menu's "그림 n/m")
    hansol-guild.py --preview PNG    -> the plan as one picture (people seated), for a look without the App

While the sheets (sheets/guild-dark/, made by the user from its README.md) are not all there, the plan is
{"not_ready": {"ready": n, "total": m, "missing": [...]}} with exit code 0: office.js shows a notice, not an error.

The scene has the keys office.js's grid mode reads (the office planner's output is the model): grid {origin, tw, th, cols, rows, walk, floor},
background_tiles, objects (sliced per floor column so people sort in front of / behind them), door, spots.entrance, seats / desks (one writing
table each, l86: everybody keeps the own seat), stand_points (the keg, the well, the potion shelf: the short breaks), people (the same pose keys as
the office's people), pose_size, sprite. A grid tile is 48 x 24 px; a sheet's floor tile (ref_tile) is 2 x 2 grid tiles.
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))   # hansol_sprites / hansol_guild_sprites live beside this file

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import hansol_guild_sprites as gs
from hansol_sprites import APP_HOME

VERSION = 'g2'                       # part of every picture's name: a change here makes them all again
TW, TH = 48, 24                      # one grid tile (the office's)
TILE = 96                            # one sheet floor tile = 2 x 2 grid tiles
STAND_H = 86                         # a standing person, px (the office's people are 88 in a 92 canvas)
WALL_RUN = 5                         # grid tiles per wall segment (a plain wall, a window, a torch): 5 = tall walls, big windows
DOOR_RUN = 6                         # the door's wall section (as tall as the walls at this length)
WALL_TOP = 210                       # px over the floor's back corner: room for the walls' height
OUT = APP_HOME / 'hansol-office' / 'guild'
REL = 'hansol-office/guild'


def use_theme(theme):
    """The theme's own folders (gs.use sets the sheets ones): every output path made from OUT takes the theme's
    value again - a guild-meadow run writes hansol-office/meadow/. Import time is guild-dark, as it has always been."""
    gs.use(theme)
    global OUT, REL, PEOPLE_CACHE, AMBIENT, LIGHT_K
    s = gs.spec()
    AMBIENT = tuple(s.get('ambient', AMBIENT))           # the meadow: plain daylight, not the hall's dim between the fires
    LIGHT_K = float(s.get('light_scale', LIGHT_K))
    out = gs.THEMES[theme][1]
    OUT = APP_HOME / 'hansol-office' / out
    REL = f'hansol-office/{out}'
    PEOPLE_CACHE = OUT / 'people-cache.json'


# ---------------------------------------------------------------- files

def write_png(img, stem):
    """Save under OUT with the pixels' hash in the name (nothing is encoded when the file is there); returns the path relative to the app folder."""
    h = hashlib.sha1(f'{VERSION}{img.mode}{img.size}'.encode() + img.tobytes()).hexdigest()[:10]
    path = OUT / f'{stem}-{h}.png'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f'{path.stem}.{os.getpid()}.tmp')
        img.save(tmp, 'PNG', compress_level=3)
        try:
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    else:
        try:
            os.utime(path)                                     # used again = new (prune keeps it)
        except OSError:
            pass
    return f'{REL}/{path.name}'


def write_gif(frames, stem, ms=260):
    """An animated GIF (looping) of RGBA frames of one size, named by its bytes like write_png. Transparency is 1-bit (alpha < 128 = clear)."""
    import io
    w, h = frames[0].size
    sheet = Image.new('RGB', (w * len(frames), h), (0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f.convert('RGB'), (i * w, 0), mask=f.getchannel('A').point(lambda v: 255 if v >= 128 else 0))
    pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = []
    for f in frames:
        q = f.convert('RGB').quantize(palette=pal, dither=Image.Dither.NONE)
        q.paste(255, mask=f.getchannel('A').point(lambda v: 255 if v < 128 else 0))
        out.append(q)
    buf = io.BytesIO()
    out[0].save(buf, 'GIF', save_all=True, append_images=out[1:], duration=ms, loop=0, transparency=255, disposal=2)
    path = OUT / f"{stem}-{hashlib.sha1(buf.getvalue()).hexdigest()[:10]}.gif"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(buf.getvalue())
    else:
        try:
            os.utime(path)
        except OSError:
            pass
    return f'{REL}/{path.name}'


def prune(keep, older_s=3600):
    """Pictures of this folder that no remembered guild scene and not this scene names, older than an hour, go."""
    import re
    names = set(Path(k).name for k in keep)
    for f in ('last-scene-guild.json', 'last-scene-guild-demo.json'):
        try:
            names |= set(Path(m).name for m in re.findall(r'hansol-office/guild/[^"\\]+\.(?:png|gif)', (APP_HOME / 'hansol-office' / f).read_text(encoding='utf-8')))
        except OSError:
            pass
    now = time.time()
    for p in [*OUT.glob('*.png'), *OUT.glob('*.gif')]:
        try:
            if p.name not in names and now - p.stat().st_mtime > older_s:
                p.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- pieces

def furniture(use):
    """{piece name: RGBA at scene scale}: each sheet's pieces scaled by its ref_tile (= TILE px wide); the floor sheet by its tiles' width.
    An optional sheet that is not there (yet) gives nothing (its pieces are left out of the hall)."""
    out = {}
    for e in gs.spec()['sheets']:
        if e.get('class') or e.get('kind') == 'outside' or (e.get('required') is False and not use.get(e['key'].split('_')[0])):
            continue
        p = gs.cut_sheet(e)
        ref = p.pop('ref_tile', None)
        s = TILE / (ref.size[0] if ref else float(np.median([v.size[0] for v in p.values()])))
        for name, im in p.items():
            out[name] = gs.scaled(im, s)
    return out


def wall_piece(img, cells):
    """A wall piece scaled so that its face's base is `cells` grid tiles long, and turned to a backslash run (the right back wall).
    Returns (image, (x, y) of the face's lower right corner in it)."""
    if gs.orient(img) == 'fs':
        img = gs.mirrored(img)
    xs, ys = gs.bottom_profile(img)
    i = int(np.argmax(ys))
    run = max(1, xs[i] - xs[0])
    img = gs.scaled(img, cells * TW / 2 / run)
    xs, ys = gs.bottom_profile(img)
    i = int(np.argmax(ys))
    return img, (float(xs[i]), float(ys[i]))


def facing(img, want):
    """The piece turned so its long base runs `want` ('bs' / 'fs')."""
    return img if gs.orient(img) == want else gs.mirrored(img)


# ---------------------------------------------------------------- the hall

class Hall:
    """Grid geometry: tile (gx, gy)'s centre is origin + ((gx - gy) * TW / 2, (gx + gy) * TH / 2); depth = gx + gy."""

    def __init__(self, cols, rows, top=150, margin=24):
        self.C, self.R = cols, rows
        self.ox = margin + rows * TW / 2
        self.oy = top + TH / 2
        self.W = int(math.ceil(margin * 2 + (cols + rows) * TW / 2))
        self.H = int(math.ceil(self.oy + (cols + rows - 1) * TH / 2 + 40))
        self.walk = [['.'] * cols for _ in range(rows)]

    def xy(self, gx, gy):
        return [round(self.ox + (gx - gy) * TW / 2, 1), round(self.oy + (gx + gy) * TH / 2, 1)]

    def corner(self, u, v):
        """A point in tile coordinates (u, v may be halves: a tile's edges are at +-0.5)."""
        return (self.ox + (u - v) * TW / 2, self.oy + (u + v) * TH / 2)

    def free(self, cell, around=1):
        """Nothing stands on the cell nor next to it."""
        gx, gy = cell
        return all(self.walk[y][x] == '.' for y in range(max(0, gy - around), min(self.R, gy + around + 1))
                   for x in range(max(0, gx - around), min(self.C, gx + around + 1)))

    def block(self, cells):
        for gx, gy in cells:
            if 0 <= gy < self.R and 0 <= gx < self.C:
                self.walk[gy][gx] = '#'


def footprint(gx0, gy0, a, b):
    return [(gx, gy) for gx in range(gx0, gx0 + a) for gy in range(gy0, gy0 + b)]


def place_floor_thing(hall, img, cells, dx=0.0, dy=0.0):
    """The picture's front corner (the lowest point of its outline) on the footprint's front corner. Returns its rect [x, y, w, h]."""
    fx, fy = gs.front_corner(img)
    u = max(c[0] for c in cells) + 0.5
    v = max(c[1] for c in cells) + 0.5
    px, py = hall.corner(u, v)
    return [round(px - fx + dx, 1), round(py - fy + dy, 1), img.size[0], img.size[1]]


def slices(hall, img, rect, cells, oid, kind):
    """The picture cut into vertical strips along the floor's columns, each with the depth of the nearest footprint tiles under it (so a person
    in front of one end is drawn over it and one behind the other end under it). Strips of the same depth are joined."""
    x0, y0, w, h = rect
    cents = [(hall.xy(gx, gy)[0], gx + gy) for gx, gy in cells]
    step = TW / 4
    cuts = []
    xs = [x0]
    k = math.floor((x0 - hall.ox) / step) + 1
    while hall.ox + k * step < x0 + w:
        xs.append(hall.ox + k * step)
        k += 1
    xs.append(x0 + w)
    for a, b in zip(xs, xs[1:]):
        mid = (a + b) / 2
        under = [d for cx, d in cents if abs(cx - mid) < TW / 2]
        dep = max(under) if under else max(d for _, d in cents)
        if cuts and cuts[-1][2] == dep:
            cuts[-1][1] = b
        else:
            cuts.append([a, b, dep])
    out = []
    for n, (a, b, dep) in enumerate(cuts):
        l, r = int(round(a - x0)), int(round(b - x0))
        if r <= l:
            continue
        piece = img.crop((l, 0, r, h))
        if not piece.getbbox():
            continue
        out.append({'id': f'{oid}:{n}', 'kind': kind, 'file': write_png(piece, 'o'), 'rect': [round(x0 + l, 1), y0, r - l, h], 'depth': dep,
                    'tiles': [list(c) for c in cells]})
    return out


DESK_A, DESK_B = 3, 2       # a writing table: 3 tiles along the right back wall, 2 deep
DESK_X0, DESK_Y0 = 4, 5     # the first table's back corner
DESK_DX, DESK_DY = 5, 5     # the step to the next table (an aisle between)
SEAT_DX = 2                 # the seat's column in front of the table's long side
TAVERN = 6                  # tiles on the right for the keg corner


def even(n):
    return n + (n % 2)


WARM = (1.0, 0.62, 0.30)
COOL = (0.45, 0.58, 1.0)
AMBIENT = (0.70, 0.68, 0.76)     # the hall between the fires: dim, but every thing stays readable
LIGHT_K = 1.0                    # the lights' strength (a theme's sheets.json light_scale: the meadow's day square, softer pools)
GROUP_GAP = 3                    # extra tiles between two workspaces' bands of tables: the zone's standard row, then two rows of plain stone
BANNER_K = 1.3                   # the standards' scale in the hall: big enough to carry the workspace's name on the cloth
PERIODS = ('morning', 'day', 'evening', 'night')
GLASS = {'morning': (255, 200, 120, 95), 'day': (220, 240, 255, 110), 'evening': (255, 120, 60, 115), 'night': (20, 28, 78, 165)}  # the light through the stained glass
CLASS_FX = {'wizard': '#b48cff', 'sorcerer': '#ff6a8a', 'warlock': '#6dff9a', 'cleric': '#ffd76a', 'paladin': '#fff0b0', 'druid': '#8fe36a',
            'ranger': '#c4e48a', 'bard': '#ffc861', 'monk': '#e8f4ff', 'fighter': '#ffb070', 'barbarian': '#ff8a50', 'rogue': '#c0c8d8'}
STANDARD_COLORS = ['#9b1c2e', '#2a4fa8', '#2f6b3a', '#5b2c83', '#1f7a7a', '#9a4e12', '#6d1f4f', '#1f2f5a']


def light_map(W, H, lights):
    """Per pixel (r, g, b) factors: the ambient plus a soft pool per light (x, y, radius, strength, colour). The pools are flattened
    like the floor (y counts twice), so a fire lights a long oval of floor and the wall above it."""
    L = np.empty((H, W, 3), np.float32)
    L[...] = AMBIENT
    for x, y, r, s, col in lights:
        x0, x1 = max(0, int(x - 3 * r)), min(W, int(x + 3 * r) + 1)
        y0, y1 = max(0, int(y - 1.6 * r)), min(H, int(y + 1.6 * r) + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        f = s * LIGHT_K * np.exp(-(((xx - x) ** 2 + ((yy - y) * 2.0) ** 2) / (r * r)))
        L[y0:y1, x0:x1] += f[..., None] * np.array(col, np.float32)
    return np.clip(L, 0, 1.3)


def shade(img, rect, L):
    """The picture lit by the light map where it stands (rect's x, y in scene px)."""
    x, y = int(round(rect[0])), int(round(rect[1]))
    w, h = img.size
    a = np.array(img).astype(np.float32)
    sub = np.empty((h, w, 3), np.float32)
    sub[...] = AMBIENT
    H, W = L.shape[:2]
    sx0, sy0, sx1, sy1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if sx0 < sx1 and sy0 < sy1:
        sub[sy0 - y:sy1 - y, sx0 - x:sx1 - x] = L[sy0:sy1, sx0:sx1]
    a[..., :3] = np.clip(a[..., :3] * sub, 0, 255)
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def glass_mask(img):
    """The stained glass of a window piece: its saturated, bright pixels (the stone is grey), closed over the lead lines, specks dropped."""
    a = np.array(img)
    hsv = np.array(img.convert('RGB').convert('HSV')).astype(np.int32)
    sat = (hsv[..., 1] > 95) & (hsv[..., 2] > 85) & (a[..., 3] > 0)
    hue = hsv[..., 0] * 360 / 255
    core = Image.fromarray((sat & (hue > 190) & (hue < 300)).astype(np.uint8) * 255, 'L')   # the blue / violet panes: only glass is that colour
    core = np.array(core.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))) > 0
    if core.sum() < 30:
        return np.zeros(sat.shape, bool)
    ys, xs = np.nonzero(core)
    box = np.zeros(sat.shape, bool)                          # the glass: saturated pixels within the panes' box (warm panes too), not the torch-lit stone around
    box[max(0, ys.min() - 8):ys.max() + 9, max(0, xs.min() - 6):xs.max() + 7] = True
    im = Image.fromarray(((sat & box)).astype(np.uint8) * 255, 'L')
    im = im.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(7))      # close: the lead lines between the panes
    return (np.array(im) > 0) & box & (a[..., 3] > 0)


POOL = {'morning': (255, 214, 150, 72), 'day': (255, 248, 220, 88), 'evening': (255, 150, 90, 52), 'night': (120, 140, 220, 22)}  # the light a window lets in on the floor


def fill_seams(img, passes=4):
    """Pinholes where two pieces meet (the walls' feet on the floor's edge): a see-through pixel between two solid ones (above and
    below, or left and right) takes their mean colour. They showed as a thin dark dotted line along the walls."""
    a = np.array(img).astype(np.int32)
    for _ in range(passes):
        al = a[..., 3]
        solid = al >= 200
        hole = ~solid
        fill = np.zeros(a.shape[:2], bool)
        acc = np.zeros(a.shape, np.int32)
        v = hole[1:-1, :] & solid[:-2, :] & solid[2:, :]
        acc[1:-1, :][v] = (a[:-2, :][v] + a[2:, :][v]) // 2
        fill[1:-1, :] |= v
        h = hole[:, 1:-1] & solid[:, :-2] & solid[:, 2:] & ~fill[:, 1:-1]
        acc[:, 1:-1][h] = (a[:, :-2][h] + a[:, 2:][h]) // 2
        fill[:, 1:-1] |= h
        if not fill.any():
            break
        a[fill] = acc[fill]
        a[fill, 3] = 255
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def empty_table(F):
    """A free table: its own picture darker and duller, its candle unlit (no flame, no light). The sheet's table_empty when there."""
    if 'table_empty' in F:
        return facing(F['table_empty'], 'bs')
    im = facing(F['table_r'], 'bs')
    a = np.array(im).astype(np.float32)
    hsv = np.array(Image.fromarray(a[..., :3].astype(np.uint8), 'RGB').convert('HSV')).astype(np.float32)
    flame = (hsv[..., 2] > 200) & (hsv[..., 1] > 60) & (hsv[..., 0] < 50)       # the candle's flame and glow: put out
    a[..., :3] *= 0.72
    a[flame, :3] = a[flame, :3] * 0.35 + np.array([60, 52, 48]) * 0.65
    grey = a[..., :3].mean(axis=2, keepdims=True)
    a[..., :3] = a[..., :3] * 0.7 + grey * 0.3
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def banner_face(std, key_hex):
    """[x, y, w, h] as fractions of the standard picture: its cloth (the pixels drawn in the key colour, whatever colour they take),
    the rows at least 85 % as wide as the widest (not the loops on the pole), inset from the gold edge. office.js writes the
    workspace's name there."""
    d = gs.key_mask(std, key_hex)
    widths = d.sum(axis=1)
    rows = np.nonzero(widths >= widths.max() * 0.85)[0]       # (the crossbar's caps and the feet change a little too: not as many)
    cols = np.nonzero(d[rows].mean(axis=0) >= 0.5)[0]           # the columns that are cloth in most of those rows (not a stray trim pixel)
    H, W = d.shape
    y0, y1, x0, x1 = rows.min(), rows.max(), cols.min(), cols.max()
    ix, iy = (x1 - x0) * 0.08, (y1 - y0) * 0.04
    return [round((x0 + ix) / W, 3), round((y0 + iy) / H, 3), round((x1 - x0 - 2 * ix) / W, 3), round((y1 - y0 - 2 * iy) / H, 3)]


def ink_for(hex_):
    """Words on a cloth of this colour: near-white on a dark cloth, near-black on a light one."""
    r, g, b = Image.new('RGB', (1, 1), hex_).getpixel((0, 0))
    return '#2a1a0e' if 0.299 * r + 0.587 * g + 0.114 * b > 120 else '#fff4dc'   # (the gold cloth: dark words)


SKY = {'morning': ((236, 150, 120), (255, 222, 160)), 'day': ((84, 150, 226), (200, 228, 255)),
       'evening': ((70, 46, 110), (255, 140, 80)), 'night': ((6, 10, 34), (30, 44, 96))}
LAND = {'morning': (0.85, 0.78, 0.70), 'day': (1.0, 1.0, 1.0), 'evening': (0.75, 0.55, 0.50), 'night': (0.20, 0.24, 0.40)}


def outside_panorama(period, use):
    """The wide view out of the windows (RGB): the user's sheet g8-outside when it is there, else drawn here (pixel art at 1/3 size):
    the sky of the time of day, far mountains, a castle on a hill, green hills with pines; stars and a moon at night."""
    if use.get('g8'):
        e = [x for x in gs.spec()['sheets'] if x['key'] == 'g8_outside'][0]
        img = gs.cut_sheet(e)[period].convert('RGB')
        hsv = np.array(img.convert('HSV')).astype(np.float32)          # day and night unmistakable: the day brighter and fuller, the night darker (its stars stay)
        sv, vv = {'morning': (1.1, 1.05), 'day': (1.2, 1.15), 'evening': (1.1, 0.95), 'night': (0.9, 0.62)}[period]
        hsv[..., 1] = np.clip(hsv[..., 1] * sv, 0, 255)
        v = hsv[..., 2]
        hsv[..., 2] = np.where(v > 200, v, np.clip(v * vv, 0, 255)) if period == 'night' else np.clip(v * vv, 0, 255)
        return Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB')
    import random
    W, H = 420, 90
    top, bot = SKY[period]
    sky = np.zeros((H, W, 3), np.float32)
    t = np.linspace(0, 1, H)[:, None]
    for c in range(3):
        sky[..., c] = top[c] + (bot[c] - top[c]) * t
    img = Image.fromarray(sky.astype(np.uint8), 'RGB')
    d = ImageDraw.Draw(img)
    rnd = random.Random(11)                                  # the same landscape at every time of day
    if period == 'night':
        for _ in range(140):
            x, y = rnd.randrange(W), rnd.randrange(int(H * 0.55))
            v = rnd.choice((150, 190, 235))
            d.point((x, y), fill=(v, v, min(255, v + 15)))
        d.ellipse((300, 10, 312, 22), fill=(244, 238, 200))
        d.ellipse((304, 8, 316, 20), fill=top)              # a crescent
    else:
        sx = {'morning': 70, 'day': 210, 'evening': 350}[period]
        sy = {'morning': 40, 'day': 14, 'evening': 42}[period]
        col = {'morning': (255, 214, 140), 'day': (255, 248, 220), 'evening': (255, 170, 90)}[period]
        d.ellipse((sx - 9, sy - 9, sx + 9, sy + 9), fill=col)
        if period == 'day':
            for cx, cy in ((90, 16), (260, 24), (370, 12)):
                for dx in (-8, 0, 8):
                    d.ellipse((cx + dx - 7, cy - 4, cx + dx + 7, cy + 4), fill=(246, 250, 255))
    lf = LAND[period]
    shade_ = lambda c, k=1.0: tuple(int(min(255, v * f * k)) for v, f in zip(c, lf))
    rnd = random.Random(5)
    far = [int(H * 0.50 + 9 * math.sin(x / 23) + 6 * math.sin(x / 9 + 1) + rnd.uniform(-1, 1)) for x in range(W)]
    for x, y in enumerate(far):
        d.line((x, y, x, H), fill=shade_((110, 128, 170)))
    for x in range(40, 70):                                  # the castle on a far hill
        d.line((x, far[55] - 14, x, far[x]), fill=shade_((88, 92, 112)))
    for tx in (38, 52, 68):
        d.rectangle((tx, far[55] - 24, tx + 5, far[55] - 10), fill=shade_((80, 84, 104)))
        d.polygon([(tx - 1, far[55] - 24), (tx + 6, far[55] - 24), (tx + 2.5, far[55] - 31)], fill=shade_((120, 60, 60)))
    if period == 'night':
        for wx, wy in ((45, -18), (58, -16), (62, -20)):
            d.point((wx, far[55] + wy), fill=(255, 200, 110))
    near = [int(H * 0.70 + 6 * math.sin(x / 31 + 2) + 4 * math.sin(x / 13)) for x in range(W)]
    for x, y in enumerate(near):
        d.line((x, y, x, H), fill=shade_((72, 128, 64)))
    for x in range(0, W, 7):                                 # pines along the hills
        h_ = rnd.randint(6, 11)
        y = near[x] + 1
        d.polygon([(x - 3, y), (x + 3, y), (x, y - h_)], fill=shade_((34, 78, 44)))
    road = [(int(200 + 40 * math.sin(v / 9)), int(H * 0.74) + v) for v in range(0, H - int(H * 0.74))]
    for x, y in road:
        d.line((x - 1 - (y - road[0][1]) // 4, y, x + 1 + (y - road[0][1]) // 4, y), fill=shade_((176, 150, 108)))
    return img.resize((W * 3, H * 3), Image.NEAREST)


def opening_mask(img):
    """A g11 window's see-through opening: the transparent pixels the stone encloses (not reached from the piece's border),
    or the flat green #00FF00 a sheet without transparency fills it with. Empty for a window without one (g2's stained glass)."""
    a = np.array(img)
    al = a[..., 3]
    solid = Image.fromarray(np.pad(np.where(al >= 128, 255, 0), 1).astype(np.uint8), 'L').copy()   # (a copy: an image on a numpy buffer is read-only)
    ImageDraw.floodfill(solid, (0, 0), 128)                 # the outside, through the transparent pixels
    hole = (np.array(solid)[1:-1, 1:-1] == 0) | ((a[..., 1] > 200) & (a[..., 0] < 90) & (a[..., 2] < 90) & (al > 0))
    return hole if hole.sum() > 0.02 * (al > 0).sum() else np.zeros(al.shape, bool)


def pane_mask(img):
    """The panes of a window piece: a g11 window's opening exactly; else (g2's stained glass) its saturated, bright pixels
    inside the panes' box (the lead lines and the stone stay)."""
    hole = opening_mask(img)
    if hole.any():
        return hole
    a = np.array(img)
    hsv = np.array(img.convert('RGB').convert('HSV')).astype(np.int32)
    sat = (hsv[..., 1] > 80) & (hsv[..., 2] > 70) & (a[..., 3] > 0)
    box = glass_mask(img)
    if not box.any():
        return box
    ys, xs = np.nonzero(box)
    inside = np.zeros(sat.shape, bool)
    inside[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True
    m = Image.fromarray((sat & inside & box).astype(np.uint8) * 255, 'L').filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    return (np.array(m) > 0) & box


def window_glows(im, at, side, panos, over=None):
    """{period: file}: the view out of one window for each time of day (laid over the window by office.js), and their rect.
    The panorama is sheared along the wall (`side` 'bs': the right back wall, 'fs': the left one) and each window shows its own part of it.
    `over`: the wall pieces drawn after this one ((image, at) ...): panes they cover are left out."""
    mask = pane_mask(im)
    for im2, at2 in over or []:
        cov = Image.new('L', im.size, 0)
        cov.paste(im2.getchannel('A'), (at2[0] - at[0], at2[1] - at[1]))
        mask &= np.array(cov) == 0
    if mask.sum() < 50:
        return None
    ys, xs = np.nonzero(mask)
    xc, yc, hh = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2, ys.max() - ys.min() + 1
    slope = 0.5 if side == 'bs' else -0.5
    EX = 150                                                 # px of floor below the window for the light it lets in
    out = {'rect': [at[0] - EX // 2, at[1], im.size[0] + EX, im.size[1] + EX]}
    W2, H2 = im.size[0] + EX, im.size[1] + EX
    yy, xx = np.mgrid[0:H2, 0:W2].astype(np.float32)
    dirx = -2 * slope                                        # into the room: right of a left-wall window, left of a right-wall one
    col = np.array(im)[:, int(xc), 3] > 60
    base = int(np.nonzero(col)[0].max()) if col.any() else ys.max() + 40   # the wall's foot under the window
    glass = np.zeros((H2, W2), bool)
    glass[:im.size[1], EX // 2:EX // 2 + im.size[0]] = mask
    pool = np.zeros((H2, W2), np.float32)
    drop = base - yc                                         # the sun's beam: the glass shape shifted down and into the room
    for t in range(int(drop * 0.55), int(drop * 1.45), 2):
        dx, dy = int(round(dirx * t * 0.9)), int(round(t))
        sh = np.zeros_like(glass)
        sh[dy:, max(0, dx):W2 + min(0, dx)] = glass[:H2 - dy, max(0, -dx):W2 - max(0, dx)]
        fade = 1 - abs(t - drop) / (drop * 0.5)
        pool = np.maximum(pool, sh * max(0.25, fade))
    pool[:base - 4] *= np.linspace(0.15, 1, H2)[:base - 4, None]  # (bright on the floor, faint in the air)
    pool[glass] = 0
    for per in PERIODS:
        P = panos[per]
        k = hh * 2.2 / P.size[1]
        P = P.resize((max(1, int(P.size[0] * k)), max(1, int(P.size[1] * k))), Image.NEAREST)
        off = int(at[0] * 0.9) % max(1, P.size[0] - im.size[0])
        view = P.transform(im.size, Image.AFFINE, (1, 0, off, -slope, 1, slope * xc - yc + 0.55 * P.size[1]), resample=Image.NEAREST)
        arr = np.array(Image.blend(view, Image.new('RGB', view.size, (210, 228, 255)), 0.12).convert('RGBA'))
        arr[..., 3] = np.where(mask, 255, 0)
        big = np.zeros((H2, W2, 4), np.uint8)
        pr, pg, pb, pa_ = POOL[per]
        big[..., 0], big[..., 1], big[..., 2] = pr, pg, pb
        big[..., 3] = (pool * pa_).astype(np.uint8)
        canvas = Image.fromarray(big, 'RGBA')
        canvas.alpha_composite(Image.fromarray(arr, 'RGBA'), (EX // 2, 0))
        out[per] = write_png(canvas, 'view')
    return out


def glow_picture(hex_, size=48):
    """A soft round glow of one colour (transparent at the rim): a flame's flicker, a class's work light."""
    r_, g_, b_ = Image.new('RGB', (1, 1), hex_).getpixel((0, 0))
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.hypot(xx - (size - 1) / 2, yy - (size - 1) / 2) / (size / 2)
    al = np.clip(1 - d, 0, 1) ** 1.8 * 200
    arr = np.zeros((size, size, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3] = r_, g_, b_, al.astype(np.uint8)
    return write_png(Image.fromarray(arr, 'RGBA'), 'glow')


def spark_picture(hex_):
    """Three small four-pointed sparkles of one colour (a class's working effect, drawn over the table)."""
    im = Image.new('RGBA', (30, 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    col = Image.new('RGB', (1, 1), hex_).getpixel((0, 0)) + (255,)
    for cx, cy, s in ((8, 20, 4), (20, 9, 5), (24, 23, 3)):
        d.polygon([(cx, cy - s), (cx + 1, cy - 1), (cx + s, cy), (cx + 1, cy + 1), (cx, cy + s), (cx - 1, cy + 1), (cx - s, cy), (cx - 1, cy - 1)], fill=col)
    return write_png(im.filter(ImageFilter.GaussianBlur(0.4)), 'spark')


def plaque_face(img):
    """[x, y, w, h] as fractions of the plaque picture: its board (the rows at least 80 % as wide as the widest, so not the chains),
    inset by its frame: office.js writes the time in there."""
    a = np.array(img)[..., 3] > 60
    widths = a.sum(axis=1)
    rows = np.nonzero(widths >= widths.max() * 0.8)[0]
    cols = np.nonzero(a[rows].any(axis=0))[0]
    H, W = a.shape
    y0, y1, x0, x1 = rows.min(), rows.max(), cols.min(), cols.max()
    ix, iy = (x1 - x0) * 0.1, (y1 - y0) * 0.14
    return [round((x0 + ix) / W, 3), round((y0 + iy) / H, 3), round((x1 - x0 - 2 * ix) / W, 3), round((y1 - y0 - 2 * iy) / H, 3)]


def group_key(a):
    return a.get('island') or f"{a.get('source') or 'app'}:"           # (office.js looks a newcomer's room up by the same key)


def plan(agents, demo=False, preview=None):
    sheets = gs.spec()
    t0 = time.time()
    use = gs.usable()
    F = furniture(use)
    # ---- the workspaces: one band of tables each, in the order of their names
    groups, by_title = {}, {}                                # one band per workspace name: the same space seen by two sources (app / tui / t3) is one band
    for a in sorted(agents, key=lambda a: (str(group_key(a)), str(a['id']))):
        title = a.get('island_title') or group_key(a).split(':', 1)[-1].split('~')[0] or group_key(a)
        g = by_title.setdefault(title, group_key(a))
        q = groups.setdefault(g, {'title': title, 'source': a.get('source') or 'app', 'ids': []})
        q['ids'].append(a['id'])
    order = sorted(groups, key=lambda g: (str(groups[g]['title']).lower(), g))
    seat_no = assign_seats({g: groups[g]['ids'] for g in order}, demo)
    need = {g: max([len(groups[g]['ids'])] + [seat_no[i] + 1 for i in groups[g]['ids']]) for g in order}
    def extent(K):                                           # (tiles deep, tiles wide) of the hall with K tables per row
        rows = sum(max(1, math.ceil(need.get(g, 2) / K)) for g in order or [None])
        return DESK_Y0 + DESK_DY * rows + GROUP_GAP * (len(order or [None]) - 1), DESK_X0 + DESK_DX * K + TAVERN
    K = max(2, min(4, max(need.values(), default=2)))       # tables in a row: the biggest workspace's in one row (2..4); more workspaces = a deeper hall
    bands, y = [], DESK_Y0                                   # (group key or None, first row's gy, rows)
    for g in order or [None]:
        rows = max(1, math.ceil(need.get(g, 2) / K))
        bands.append((g, y, rows))
        y += DESK_DY * rows + GROUP_GAP
    C = even(DESK_X0 + DESK_DX * K + TAVERN)
    R = even(y - GROUP_GAP + 1)                              # (the last zone's standard row, then a row to walk)
    hall = Hall(C, R, top=WALL_TOP)
    stand_points, lights, things, flames, windows = [], [], [], [], []   # things: (image, rect, cells, id, kind), sliced once the light map is known

    # ---- the background: floor tiles, then the two back walls (behind everything)
    bg = Image.new('RGBA', (hall.W, hall.H), (0, 0, 0, 0))
    floor_kinds = ['flag_a', 'flag_b', 'flag_c', 'flag_a', 'flag_b', 'flag_worn']
    for s in range(0, C // 2 + R // 2):
        for i in range(C // 2):
            j = s - i
            if not 0 <= j < R // 2:
                continue
            name = floor_kinds[int(hashlib.sha1(f'{i},{j}'.encode()).hexdigest(), 16) % len(floor_kinds)]
            im = F[name]
            tx, ty = hall.corner(2 * i - 0.5, 2 * j - 0.5)      # the big tile's top vertex
            bg.alpha_composite(im, (int(round(tx - im.size[0] / 2)), int(round(ty))))

    walls = []                                               # (depth key, image, (x, y)) drawn back to front

    def wall_light(name, at, im):
        cx, cy = at[0] + im.size[0] / 2, at[1] + im.size[1] * 0.45
        if name.startswith('torch'):
            lights.append((cx, cy, 120, 0.6, WARM))
            flames.append({'xy': [round(cx, 1), round(cy - 12, 1)], 'r': 34, 'depth': -1})
        elif name.startswith('window'):
            lights.append((cx, cy + 30, 90, 0.22, COOL))
            windows.append((im, at, len(walls) - 1, 'bs' if name.endswith('_l') else 'fs'))   # (its place in walls: pieces drawn after it may cover it)

    def wall_bs(name, a, cells=WALL_RUN):                    # right back wall (gy = 0 edge): grid tiles a .. a + cells - 1
        im, (fx, fy) = wall_piece(F[name], cells)
        px, py = hall.corner(a + cells - 0.5, -0.5)
        at = (int(round(px - fx)), int(round(py - fy)))
        walls.append((a + cells, im, at))
        wall_light(name, at, im)

    def wall_fs(name, b, cells=WALL_RUN):                    # left back wall (gx = 0 edge): grid tiles b .. b + cells - 1
        im, (fx, fy) = wall_piece(F[name], cells)
        im = gs.mirrored(im)
        fx = im.size[0] - 1 - fx
        px, py = hall.corner(-0.5, b + cells - 0.5)
        at = (int(round(px - fx)), int(round(py - fy)))
        walls.append((b + cells, im, at))
        wall_light(name, at, im)

    door_a = C - DOOR_RUN                                    # the door: the right back wall's last 5 tiles
    span = door_a                                            # free wall length left of the door
    hx = max(6, span // 2 - 2)                               # the hearth's first tile (the furniture below stands against these walls)
    hb = 2 * WALL_RUN if R >= 3 * WALL_RUN else None            # the hearth on the left wall (its third piece) when the hall is deep enough
    busy_r = [(1, 5)] + ([(hx, hx + 5)] if hb is None else []) + ([(hx + 6, hx + 10)] if hb is None and hx + 10 <= span else [])
    busy_l = [(1, 4)] + ([(hb, hb + 5)] if hb is not None else [(2 * WALL_RUN, 2 * WALL_RUN + 4)] if R >= 2 * WALL_RUN + 6 else [])   # the potion shelf; the hearth or the weapon rack

    def pick(a, busy, sfx, n):                               # a window wherever no tall thing stands in front of the wall, else a torch / a plain wall
        if not any(a < e and s_ < a + WALL_RUN for s_, e in busy):
            return f'window_{sfx}'
        return f'torch_{sfx}' if n % 2 == 0 else f'wall_{sfx}'

    a, n = 0, 0
    while a < door_a:
        at_ = min(a, door_a - WALL_RUN)
        wall_bs(pick(at_, busy_r, 'l', n) if at_ == a else ('torch_l' if n % 2 == 0 else 'wall_l'), at_)   # (a piece pulled back over the one before: never a window, they would overlap)
        a += WALL_RUN
        n += 1
    b, n = 0, 0
    while b < R:
        at_ = min(b, R - WALL_RUN)
        wall_fs(pick(at_, busy_l, 'r', n) if at_ == b else ('torch_r' if n % 2 == 0 else 'wall_r'), at_)
        b += WALL_RUN
        n += 1
    for _, im, at in sorted(walls, key=lambda w: w[0]):
        bg.alpha_composite(im, at)
    corner = F['corner']
    cx_, cy_ = hall.corner(-0.5, -0.5)
    fx, fy = gs.front_corner(corner)
    bg.alpha_composite(corner, (int(round(cx_ - fx)), int(round(cy_ - fy))))

    # ---- the door (an object: its picture follows the door's state)
    px, py = hall.corner(door_a + DOOR_RUN - 0.5, -0.5)     # the door section's face, lower right corner
    dimgs = {st: wall_piece(F[f'door_{st}'], DOOR_RUN) for st in ('closed', 'half', 'open')}
    boxes = {st: (px - fx, py - fy, im.size[0], im.size[1]) for st, (im, (fx, fy)) in dimgs.items()}
    rx, top = min(b[0] for b in boxes.values()), min(b[1] for b in boxes.values())
    Wd = int(math.ceil(max(b[0] + b[2] for b in boxes.values()) - rx)) + 1
    Hd = int(math.ceil(max(b[1] + b[3] for b in boxes.values()) - top)) + 1
    for fxr, fyr in ((0.14, 0.35), (0.86, 0.55)):            # its two sconces
        lights.append((rx + Wd * fxr, top + Hd * fyr, 95, 0.5, WARM))
        flames.append({'xy': [round(rx + Wd * fxr, 1), round(top + Hd * fyr - 10, 1)], 'r': 28, 'depth': -1})
    door_mid = door_a + DOOR_RUN // 2

    # ---- along the right back wall: bookshelf, hearth, quest board; the left one: potion shelf, weapon rack
    def put(name, gx0, gy0, a, b, want=None, oid=None, kind='furniture', block=True, light=None, img=None):
        im = img if img is not None else F[name] if want is None else facing(F[name], want)
        cells = footprint(gx0, gy0, a, b)
        rect = place_floor_thing(hall, im, cells)
        things.append((im, rect, cells, oid or f'{name}:{gx0}-{gy0}', kind))
        if block:
            hall.block(cells)
        if light:
            fxr, fyr, r, s = light
            lights.append((rect[0] + rect[2] * fxr, rect[1] + rect[3] * fyr, r, s, WARM))
        return rect

    def wander(part, tile, facing_):                         # a place an idle person walks over to and stands at for a while
        stand_points.append({'for': part, 'part': part, 'tile': list(tile), 'xy': hall.xy(*tile), 'facing': facing_, 'wander': True})

    put('bookshelf', 1, 0, 4, 1, 'bs')
    wander('bookshelf', (3, 1), 'ur')
    if hb is not None:                                       # the hearth on the left wall, a candle stand by it
        hr = put('hearth', 0, hb, 2, 5, 'fs', kind='hearth', light=(0.55, 0.72, 230, 0.9))
        flames.append({'xy': [round(hr[0] + hr[2] * 0.55, 1), round(hr[1] + hr[3] * 0.68, 1)], 'r': 70, 'depth': hb + 5 + 0.01})
        wander('hearth', (2, hb + 2), 'ul')
        cr = put('candle_stand', 2, hb + 5, 1, 1, kind='light', light=(0.5, 0.15, 90, 0.45))
        flames.append({'xy': [round(cr[0] + cr[2] * 0.5, 1), round(cr[1] + cr[3] * 0.12, 1)], 'r': 26, 'depth': hb + 7 + 0.01})
    else:
        hr = put('hearth', hx, 0, 5, 2, 'bs', kind='hearth', light=(0.45, 0.72, 230, 0.9))
        flames.append({'xy': [round(hr[0] + hr[2] * 0.45, 1), round(hr[1] + hr[3] * 0.68, 1)], 'r': 70, 'depth': hx + 5 + 0.01})
        wander('hearth', (hx + 2, 2), 'ur')
    if hb is None and hx + 6 + 4 <= span:
        put('quest_board', hx + 6, 0, 4, 1, 'bs', kind='board')
        wander('quest_board', (hx + 8, 1), 'ur')
    if hb is None and hx + 6 <= span:
        cr = put('candle_stand', hx + 5, 2, 1, 1, kind='light', light=(0.5, 0.15, 90, 0.45))
        flames.append({'xy': [round(cr[0] + cr[2] * 0.5, 1), round(cr[1] + cr[3] * 0.12, 1)], 'r': 26, 'depth': hx + 7 + 0.01})
    put('potion_shelf', 0, 1, 1, 3, 'fs', kind='shelf')
    stand_points.append({'for': 'potion', 'part': 'potion', 'tile': [1, 2], 'xy': hall.xy(1, 2), 'facing': 'ul', 'wander': True})
    if hb is None and R >= 2 * WALL_RUN + 6:
        put('weapon_rack', 0, 2 * WALL_RUN, 1, 4, 'fs', kind='rack')
        wander('weapon_rack', (1, 2 * WALL_RUN + 2), 'ul')
    # the tavern corner on the right: keg, round table, barrel; crates and a well in the front, a brazier
    kx = C - 3
    put('keg', kx, 3, 2, 2, kind='keg')
    stand_points.append({'for': 'keg', 'part': 'keg', 'tile': [kx - 1, 4], 'xy': hall.xy(kx - 1, 4), 'facing': 'ur', 'wander': True})
    tr = put('round_table', kx - 1, 7, 2, 2, kind='table', light=(0.5, 0.2, 70, 0.4))
    flames.append({'xy': [round(tr[0] + tr[2] * 0.5, 1), round(tr[1] + tr[3] * 0.18, 1)], 'r': 20, 'depth': kx + 8 + 0.01})
    put('barrel', kx + 1, 6, 1, 1, kind='barrel')
    wx = kx if R - 3 >= 10 else kx - 3                       # the well: in the front right corner, clear of the tables (a small hall: by the tavern)
    put('well', wx, R - 3, 2, 2, kind='well')
    stand_points.append({'for': 'well', 'part': 'well', 'tile': [wx, R - 1], 'xy': hall.xy(wx, R - 1), 'facing': 'ur', 'wander': True})
    if R >= 14:                                              # the brazier: in the tavern corner (a small hall has no room for it)
        bt = (kx, 10)
        br = put('brazier', *bt, 1, 1, kind='light', light=(0.5, 0.2, 130, 0.65))
        flames.append({'xy': [round(br[0] + br[2] * 0.5, 1), round(br[1] + br[3] * 0.18, 1)], 'r': 40, 'depth': sum(bt) + 0.01})

    LONG = {'map_table', 'shield_rack', 'bench_l', 'bench_r'}       # (2 tiles along the wall)
    left = [n for n in ('plant', 'map_table', 'chest', 'book_pile', 'shield_rack', 'sacks', 'barrel', 'crates', 'candle_stand') if n in F]
    right = [n for n in ('armor_stand', 'globe_table', 'crates', 'dummy', 'lute_stand', 'barrel', 'sacks', 'bench_r') if n in F]
    i = 0                                                    # a deeper hall gets more things: by the left wall between its windows,
    for gy in range(3 * WALL_RUN, R - 3, WALL_RUN):          # and along the open right edge past the tavern corner (never in a zone or its aisle)
        if (hb is not None and hb - 1 <= gy <= hb + 6) or not left:
            continue
        name = left[i % len(left)]
        n2 = 2 if name in LONG else 1
        if all(hall.free((0, gy + d)) for d in range(n2)):
            put(name, 0, gy, 1, n2, 'fs', kind='deco')
            i += 1
    for j, gy in enumerate(range(13, R - 4, 4)):
        name = right[j % len(right)] if right else None
        if name and hall.free((C - 1, gy)):
            put(name, C - 1, gy, 1, 1, 'bs', kind='deco')

    # ---- the writing tables: one band per workspace (its standard and name plate at the band's left end), one seat each
    seats, desks, islands, colors_used, zones = {}, {}, [], set(), []
    stool = F['stool']
    n_all = 0
    for bi, (g, gy_start, rows) in enumerate(bands):
        ids = groups[g]['ids'] if g else []
        owner_of = {seat_no[i]: i for i in ids}
        sids, rects = [], []
        for n in range(rows * K):
            row, col = divmod(n, K)
            gx0, gy0 = DESK_X0 + DESK_DX * col, gy_start + DESK_DY * row
            sid = f'{g or "guild"}#{n:02d}'                  # (2 digits: office.js finds a table's slices by the id's prefix)
            seat_tile = [gx0 + SEAT_DX, gy0 + DESK_B]
            mine = owner_of.get(n) is not None                # somebody's table (lit, even while they are away) or a free one (dark, bare)
            if mine:
                rects.append(put('table_r', gx0, gy0, DESK_A, DESK_B, 'bs', oid=f'desk:{sid}', kind='desk', light=(0.3, 0.12, 60, 0.4)))
            else:
                rects.append(put('table_r', gx0, gy0, DESK_A, DESK_B, 'bs', oid=f'desk:{sid}', kind='desk', img=empty_table(F)))
            dr = rects[-1]
            if mine:
                flames.append({'xy': [round(dr[0] + dr[2] * 0.3, 1), round(dr[1] + dr[3] * 0.1, 1)], 'r': 18, 'depth': gx0 + gy0 + DESK_A + DESK_B - 2 + 0.01})
            xy = hall.xy(*seat_tile)
            fx_xy = [round(dr[0] + dr[2] * 0.58, 1), round(dr[1] + dr[3] * 0.2, 1)]   # over the open book: a class's working sparkles
            seats[sid] = {'tile': seat_tile, 'xy': xy, 'depth': sum(seat_tile), 'n': n_all, 'island': g or 'guild', 'owner': owner_of.get(n), 'fx': fx_xy}
            sids.append(sid)
            if owner_of.get(n):
                desks[owner_of[n]] = {'seat_id': sid, 'seat_tile': seat_tile, 'seat': xy, 'chair': None, 'seat_depth': sum(seat_tile)}
            else:                                            # nobody's seat: its stool stands there (a seated picture brings its own)
                fx_ = gs.feet_x(stool)
                things.append((stool, [round(xy[0] - fx_, 1), round(xy[1] - stool.size[1] + 4, 1), stool.size[0], stool.size[1]], [tuple(seat_tile)], f'stool:{sid}', 'stool'))
            n_all += 1
        if not g:
            continue
        ci = gs._pick(f'{g}|standard', len(STANDARD_COLORS))  # the workspace's colour: its own pick, the next free one when another band has it
        while ci in colors_used and len(colors_used) < len(STANDARD_COLORS):
            ci = (ci + 1) % len(STANDARD_COLORS)
        colors_used.add(ci)
        col_hex = STANDARD_COLORS[ci]
        u0, u1 = DESK_X0 - 1.5, DESK_X0 + DESK_DX * K - 1.5     # the workspace's zone: a rug in its colour under its tables and its standard, stone rows between two zones
        v0, v1 = gy_start - 1.5, gy_start + DESK_DY * rows - 0.5
        zones.append(([hall.corner(u0, v0), hall.corner(u1, v0), hall.corner(u1, v1), hall.corner(u0, v1)], col_hex))
        st_tile = (DESK_X0 - 1, gy_start + DESK_DY * rows - 1)  # its standard: at the zone's front left corner, the workspace's name on its cloth
        banner = None
        if 'standard' in F:                                  # the cloth in the workspace's colour
            std = gs.scaled(F['standard'], BANNER_K)
            cloth = gs.recolor(std, sheets.get('robe_key', '#D02FC0'), col_hex)
            srect = put('standard', *st_tile, 1, 1, oid=f'standard:{g}', kind='standard', img=cloth)
            fx_, fy_, fw_, fh_ = banner_face(std, sheets.get('robe_key', '#D02FC0'))
            face = [round(srect[0] + srect[2] * fx_, 1), round(srect[1] + srect[3] * fy_, 1), round(srect[2] * fw_, 1), round(srect[3] * fh_, 1)]
            banner = {'face': face, 'ink': ink_for(col_hex)}
            pa = (face[0] + face[2] / 2, face[1] + face[3] / 2)
        else:                                                # no standard picture: the name plate on the zone's front edge
            hall.block([st_tile])
            pa = hall.corner((u0 + u1) / 2, v1 - 0.55)
        x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
        x1, y1 = max(r[0] + r[2] for r in rects), max(r[1] + r[3] for r in rects)
        islands.append({'key': g, 'title': groups[g]['title'], 'source': groups[g]['source'], 'seats': sids, 'color': col_hex,
                        'rect': [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)], 'label': [round(pa[0], 1), round(pa[1], 1)],
                        'plate': {'at': [round(pa[0], 1), round(pa[1], 1)], 'depth': sum(st_tile) + 0.5, 'size': [150, 20], 'behind': False},
                        'banner': banner})

    if zones:                                                # the zones' rugs lie on the floor (lit with it)
        rug = Image.new('RGBA', bg.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(rug)
        for poly, col in zones:
            r_, g_, b_ = Image.new('RGB', (1, 1), col).getpixel((0, 0))
            light = tuple(min(255, int(c * 0.55 + 255 * 0.45)) for c in (r_, g_, b_))
            d.polygon(poly, fill=(r_, g_, b_, 95))
            cx, cy = sum(q[0] for q in poly) / 4, sum(q[1] for q in poly) / 4
            inner = [(cx + (q[0] - cx) * 0.985, cy + (q[1] - cy) * 0.97) for q in poly]
            d.line(poly + poly[:1], fill=(20, 12, 8, 170), width=3)
            d.line(inner + inner[:1], fill=light + (190,), width=2)
        bg.alpha_composite(rug)
    # ---- light: the background, then every thing where it stands
    L = light_map(hall.W, hall.H, lights)
    bg = shade(bg, (0, 0), L)
    objects = []
    for im, rect, cells, oid, kind in things:
        objects.extend(slices(hall, shade(im, rect, L), rect, cells, oid, kind))
    objects.sort(key=lambda o: (o['depth'], o['rect'][1]))
    door_pics = {}
    for st, (im, _) in dimgs.items():                        # the three states on one canvas, their face corners at the same point
        canvas = Image.new('RGBA', (Wd, Hd), (0, 0, 0, 0))
        canvas.alpha_composite(im, (int(round(boxes[st][0] - rx)), int(round(boxes[st][1] - top))))
        door_pics[st] = write_png(shade(canvas, (rx, top), L), 'door')
    door = {'tile': [door_mid, 0], 'open_cells': [[door_mid, 0]], 'rect': [round(rx, 1), round(top, 1), Wd, Hd],
            **door_pics, 'depth': door_mid - 0.6, 'width': 2, 'leaves': 2,
            'appear': {'xy': hall.xy(door_mid, 0)}, 'vanish': {'xy': hall.xy(door_mid, 0)}, 'label_at': hall.xy(door_mid - 1, 2)}
    order_w = sorted(range(len(walls)), key=lambda i: walls[i][0])          # the order the wall pieces were drawn in
    rank = {i: r for r, i in enumerate(order_w)}
    panos = {per: outside_panorama(per, use) for per in PERIODS}
    glows = [w for w in (window_glows(im, at, side, panos, [(walls[j][1], walls[j][2]) for j in order_w if rank[j] > rank[wi]]) for im, at, wi, side in windows) if w]
    fx = {'flame': glow_picture('#ffb050'), 'flames': flames,
          'work': {cls: spark_picture(CLASS_FX.get(cls, '#ffd76a')) for cls in use['classes']}, 'work_glow': {cls: glow_picture(CLASS_FX.get(cls, '#ffd76a'), 40) for cls in use['classes']}}
    clock = {'at': [round(rx + Wd * 0.5, 1), round(top + Hd * 0.06, 1)], 'plaque': write_png(F['plaque'], 'plaque') if 'plaque' in F else None,
             'size': list(F['plaque'].size) if 'plaque' in F else [92, 34], 'face': plaque_face(F['plaque']) if 'plaque' in F else None}

    # ---- people
    people, pose_size, sprite, class_of = make_people(agents, sheets, use)

    # ---- background tiles (256 px, named by their content), each with BLEED px of its neighbours on every side: the App smears a
    # picture's outer pixel when it zooms it, which showed every seam as a thin line; office.js clips a piece back to its rect (as the office's)
    BLEED = 2
    bg = fill_seams(bg)
    tiles = []
    for ty in range(0, hall.H, 256):
        for tx in range(0, hall.W, 256):
            core = (tx, ty, min(hall.W, tx + 256), min(hall.H, ty + 256))
            if bg.crop(core).getbbox():
                t = bg.crop((core[0] - BLEED, core[1] - BLEED, core[2] + BLEED, core[3] + BLEED))
                tiles.append({'file': write_png(t, 'bg'), 'rect': [tx, ty, core[2] - tx, core[3] - ty], 'bleed': BLEED})

    inside = [door_mid, 1]
    scene = {
        'theme': sheets.get('theme', 'guild-dark'), 'backdrop': sheets.get('backdrop'), 'l86': True, 'native': True, 'scale': 1.0, 'people_scale': 1.0,
        'width': hall.W, 'height': hall.H,
        'grid': {'origin': [hall.ox, hall.oy], 'tw': TW, 'th': TH, 'cols': C, 'rows': R,
                 'walk': [''.join(r) for r in hall.walk], 'floor': ['1' * C for _ in range(R)]},
        'background_tiles': tiles, 'objects': objects, 'door': door,
        'spots': {'entrance': {'tile': inside, 'xy': hall.xy(*inside)}, 'door': hall.xy(door_mid, 0)},
        'seats': seats, 'desks': desks, 'stand_points': stand_points, 'islands': islands, 'zones': [],
        'wander': True, 'window_glows': glows, 'fx': fx, 'clock': clock, 'people_class': class_of,
        'people': people, 'pose_size': pose_size, 'sprite': sprite,
        'seatless': [], 'wait_avoid': [], 'tags_short': False,
    }
    sid_ = hashlib.sha1(json.dumps({k_: scene[k_] for k_ in ('grid', 'background_tiles', 'objects', 'door', 'seats', 'desks')}, sort_keys=True).encode()).hexdigest()[:10]
    scene['scene_id'] = sid_
    scene['file'] = tiles[0]['file'] if tiles else f'{REL}/none.png'
    scene['plan_ms'] = int((time.time() - t0) * 1000)
    if preview:
        render_preview(scene, preview)
    keep = [t['file'] for t in tiles] + [o['file'] for o in objects] + list(door_pics.values()) + collect_paths(glows) + collect_paths(fx) + collect_paths(clock)
    for files in people.values():
        keep += collect_paths(files)
    keep.append(sprite.get('shadow', {}).get('file', ''))
    prune(keep)
    return scene


def collect_paths(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        return [x for q in v for x in collect_paths(q)]
    if isinstance(v, dict):
        return [x for q in v.values() for x in collect_paths(q)]
    return []


# ---------------------------------------------------------------- seats

def assign_seats(groups, demo):
    """{id: seat number in its workspace's band}: kept in guild/desks[-demo].json as {id: [workspace, n]}; somebody gone frees the seat,
    a newcomer takes the lowest free one of the own workspace (a person whose workspace changed is seated anew)."""
    path = OUT / ('desks-demo.json' if demo else 'desks.json')
    try:
        old = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        old = {}
    out, keep = {}, {}
    for g, ids in groups.items():
        used = set()
        for i in ids:
            v = old.get(i)
            if isinstance(v, list) and len(v) == 2 and v[0] == g and isinstance(v[1], int) and v[1] not in used:
                out[i] = v[1]
                used.add(v[1])
        nxt = 0
        for i in ids:
            if i in out:
                continue
            while nxt in used:
                nxt += 1
            out[i] = nxt
            used.add(nxt)
        keep.update({i: [g, out[i]] for i in ids})
    try:
        OUT.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(keep, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass
    return out


# ---------------------------------------------------------------- people

POSE_OF = {'stand': 'stand_f', 'type_pc': 'write', 'read_pc': 'read', 'front_give': 'give_f'}
PROP_OF = {'wave_f': 'wave_f', 'stand_b': 'stand_b', 'coffee_f': 'mug_f', 'coffee_b': 'mug_b'}


def class_pictures(sheets, cls, work=False):
    """{pose name: RGBA at scene scale} of one class: the poses scaled so stand_f is STAND_H tall, the walk frames so their median is as tall;
    with `work` the three writing frames (write_a .. c) too, as tall as the seated write pose."""
    by = {e.get('kind'): e for e in sheets['sheets'] if e.get('class') == cls}
    poses = gs.cut_sheet(by['poses'])
    walk = gs.cut_sheet(by['walk'])
    s = STAND_H / poses['stand_f'].size[1]
    sw = STAND_H * 0.98 / float(np.median([walk[f'f{i}'].size[1] for i in range(1, 9)]))
    out = {n: gs.scaled(im, s) for n, im in poses.items()}
    out.update({n: gs.scaled(im, sw) for n, im in walk.items()})
    if work and by.get('work'):
        fr = gs.cut_sheet(by['work'])
        s3 = out['write'].size[1] / float(np.median([im.size[1] for im in fr.values()]))
        out.update({n: gs.scaled(im, s3) for n, im in fr.items()})
    return out


PEOPLE_CACHE = OUT / 'people-cache.json'


def make_people(agents, sheets, use):
    """{id: pose files}, pose_size, sprite. Every pose sits on one canvas (the same w x h for all classes): feet at the bottom centre.
    A class + robe colour that was made before (guild/people-cache.json, same sheets, files still there) is not made again."""
    classes = use['classes'] or ['wizard']
    key_hex = sheets.get('robe_key', '#D02FC0')
    sig = f'{VERSION}|{gs.sheets_signature()}|{STAND_H}|{",".join(classes)}'
    try:
        cache = json.loads(PEOPLE_CACHE.read_text(encoding='utf-8'))
        if cache.get('sig') != sig:
            cache = None
    except (OSError, ValueError):
        cache = None
    pics = {}
    if not cache:                                            # the canvas fits every class's every pose
        pics = {cls: class_pictures(sheets, cls, use['work'].get(cls)) for cls in classes}
        half_w = top_h = 0
        for p in pics.values():
            for im in p.values():
                fx = gs.feet_x(im)
                half_w = max(half_w, fx, im.size[0] - fx)
                top_h = max(top_h, im.size[1])
        cache = {'sig': sig, 'canvas': [int(math.ceil(half_w * 2 + 2)), int(math.ceil(top_h + 2))], 'sets': {}}
    CW, CH = cache['canvas']

    def canvas(im):
        c = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
        fx = gs.feet_x(im)
        c.alpha_composite(im, (int(round(CW / 2 - fx)), CH - 1 - im.size[1]))
        return c

    people, class_of = {}, {}
    for a in agents:
        cls, robe, hr = gs.class_of(a['id'], classes), gs.robe_of(a['id']), gs.hair_of(a['id'])
        class_of[a['id']] = cls
        got = cache['sets'].get(f'{cls}|{robe}|{hr}')
        if got and all((APP_HOME / p).exists() for p in collect_paths(got)):
            people[a['id']] = got
            continue
        if cls not in pics:
            pics[cls] = class_pictures(sheets, cls, use['work'].get(cls))
        memo = {}
        def pic(name, flip=False):
            k = (name, flip)
            if k not in memo:
                im = canvas(gs.rehair(gs.recolor(pics[cls][name], key_hex, robe), hr))
                memo[k] = write_png(gs.mirrored(im) if flip else im, f'p-{cls}')
            return memo[k]
        files = {key: pic(src) for key, src in POSE_OF.items()}
        if all(f'write_{c}' in pics[cls] for c in 'abc'):   # the writing frames: the seated picture moves (office.js plays a GIF as it is)
            files['type_pc'] = write_gif([canvas(gs.rehair(gs.recolor(pics[cls][f'write_{c}'], key_hex, robe), hr)) for c in 'abcb'], f'w-{cls}')
        files['flip'] = {'stand': pic('stand_f', True), 'front_give': pic('give_f', True)}
        files['prop'] = {key: pic(src) for key, src in PROP_OF.items()}
        files['prop']['flip'] = {key: pic(src, True) for key, src in PROP_OF.items()}
        front = [pic(f'f{i}') for i in range(1, 9)]
        back = [pic(f'b{i}') for i in range(1, 9)]
        walk8 = {'dl': front, 'dr': [pic(f'f{i}', True) for i in range(1, 9)], 'ur': back, 'ul': [pic(f'b{i}', True) for i in range(1, 9)]}
        files['walk8_frames'] = walk8
        files['walk_frames'] = walk8
        people[a['id']] = files
        cache['sets'][f'{cls}|{robe}|{hr}'] = files
    try:
        OUT.mkdir(parents=True, exist_ok=True)
        PEOPLE_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass
    keys = ['stand', 'type_pc', 'read_pc', 'front_give', 'walk', 'walk_gif', 'sit', 'hold', 'raise', 'front_wait', 'front_raise', 'bow', 'type', 'type_pc2']
    pose_size = {k_: {'w': CW, 'h': CH} for k_ in keys}
    shadow = Image.new('RGBA', (40, 14), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse((2, 2, 37, 11), fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.6))
    sprite = {'w': CW, 'h': CH, 'shadow': {'file': write_png(shadow, 'shadow'), 'w': 40, 'h': 14, 'foot': [20, 8]}}
    return people, pose_size, sprite, class_of


# ---------------------------------------------------------------- a look without the App

def render_preview(scene, out_path, grid=False, period='day'):
    """The scene as one PNG: background, objects and people (seated at their desks, by depth). `grid` draws the walk grid over it."""
    def load(rel):
        return Image.open(APP_HOME / rel).convert('RGBA')
    W, H = scene['width'], scene['height']
    bd = scene.get('backdrop') or '#101827'            # the colour round the floor (as office.js)
    img = Image.new('RGBA', (W, H), tuple(int(bd[i:i + 2], 16) for i in (1, 3, 5)) + (255,))
    for t in scene['background_tiles']:
        b, r = t.get('bleed', 0), t['rect']
        img.alpha_composite(load(t['file']).crop((b, b, b + r[2], b + r[3])), (int(r[0]), int(r[1])))
    for w in scene.get('window_glows', []):                  # the view out of the windows (as office.js: over the walls, under the things)
        img.alpha_composite(load(w[period]), (int(w['rect'][0]), int(w['rect'][1])))
    layers = [(o['depth'], 0, o['file'], o['rect']) for o in scene['objects']]
    d = scene['door']
    layers.append((d['depth'], 0, d['closed'], d['rect']))
    ps = scene['pose_size']['stand']
    for pid, dk in scene['desks'].items():
        f = scene['people'].get(pid, {}).get('type_pc')
        if f:
            x, y = dk['seat']
            slic = [o['depth'] for o in scene['objects'] if o['id'].startswith(f"desk:{dk['seat_id']}")]
            layers.append(((max(slic) if slic else dk['seat_depth']) + 0.5, 2, f, [x - ps['w'] / 2, y - ps['h'], ps['w'], ps['h']]))
    for dep, _, f, r in sorted(layers, key=lambda q: (q[0], q[1])):
        img.alpha_composite(load(f), (int(round(r[0])), int(round(r[1]))))
    if grid:
        g = scene['grid']
        dr = ImageDraw.Draw(img)
        for gy, row in enumerate(g['walk']):
            for gx, ch in enumerate(row):
                cx = g['origin'][0] + (gx - gy) * TW / 2
                cy = g['origin'][1] + (gx + gy) * TH / 2
                dr.polygon([(cx, cy - TH / 2), (cx + TW / 2, cy), (cx, cy + TH / 2), (cx - TW / 2, cy)], outline=(255, 255, 0, 90) if ch == '.' else (255, 60, 60, 160))
    img.convert('RGB').save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agents', default='[]')
    ap.add_argument('--box', default='1280x800')
    ap.add_argument('--config', default=None)
    ap.add_argument('--demo', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--preview', default=None)
    ap.add_argument('--grid', action='store_true')
    ap.add_argument('--theme', default='guild-dark', choices=('guild-dark', 'guild-meadow'))   # the background: the dark hall / the bright flower meadow town
    args = ap.parse_args()
    use_theme(args.theme)
    state = gs.check()
    if args.check:
        print(json.dumps(state, ensure_ascii=False))
        return 0
    if state['ready'] < state['total']:
        print(json.dumps({'not_ready': {k: state[k] for k in ('ready', 'total', 'missing')}}, ensure_ascii=False))
        return 0
    try:
        agents = [a for a in json.loads(args.agents) if isinstance(a, dict) and a.get('id')]
    except ValueError:
        agents = []
    scene = plan(agents, demo=args.demo)
    if args.preview:
        render_preview(scene, args.preview, grid=args.grid)
    print(json.dumps(scene))                                  # ASCII only: the App reads the output as UTF-8, a Windows console code page would break the names
    return 0


if __name__ == '__main__':
    sys.exit(main())
