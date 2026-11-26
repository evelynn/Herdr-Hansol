#!/usr/bin/env python3
"""The flower village ("guild-meadow"): yards round a fountain square, its own floor plan (design: sheets/meadow/DESIGN.md, v2).

Called by office.js like the guild planner when shared "hansol.layout" is "guild-meadow":
    hansol-meadow.py --agents JSON --box WxH [--demo] [--config JSON]
    hansol-meadow.py --check          -> the sheets' state (as hansol-guild.py --check)
    hansol-meadow.py --preview PNG    -> the plan as one picture, people at their places, for a look without the App

Each workspace is a yard along one of the two back edges: a cottage roofed in the workspace's colour, a fenced yard tinted in that
colour with its tables, a name sign and a lamp at its gate. The back corner is the village hall's (the clock), the fountain square
fills the front. As in the guild hall everybody keeps to their own seat in every state (l86 true).
The common parts (pictures, slicing, light, people, seats) are hansol-guild.py's, loaded as a module and switched to this theme.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

_spec = importlib.util.spec_from_file_location('hansol_guild', HERE / 'hansol-guild.py')
G = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(G)
gs = G.gs

THEME = 'guild-meadow'
TW, TH = G.TW, G.TH
SD = 16                      # the yards' strip along both back edges (tiles deep); the back corner (gx, gy < SD) is the hall's
YGAP = 2                     # the way between two yards (tiles)
FD = 14                      # the yards' strip along a front edge (tiles deep): a stall, two rows of tables, fences
PMIN = 18                    # the square's least side (tiles): the fountain, its lamps, benches, well and cart
SAND = '#d8c49c'             # the yards' ground under their colour
INK = '#3a2414'              # the names on the light-wood signs
CLOCK_INK2 = '#6a4423'       # the clock's time-of-day word
TOD = {'evening': '#ff8a3d1f', 'night': '#1a2b5c38'}   # a tint laid over the whole village (office.js) by the time of day: a mood, not darkness (user 2026-11-26: the lamps make the night)
COLORS = ['#b4545c', '#b88a34', '#7f9a3e', '#4f8f5a', '#3d8a86', '#4d76ad', '#8a68a6', '#a8589a']   # the yards' colours (muted, hues >= 35 degrees apart)
SIZE = {                     # piece -> ('w' | 'h', px) at scene scale: the sheets' own ref_tile scale differs from sheet to sheet
    'cobble_a': ('w', 96), 'cobble_b': ('w', 96), 'cobble_c': ('w', 96), 'grass_a': ('w', 96), 'grass_b': ('w', 96), 'path': ('w', 96),
    'house_l': ('w', 288), 'house_l2': ('w', 288), 'house_r': ('w', 288), 'house_r2': ('w', 288), 'hall': ('w', 300),
    'stall_l': ('w', 196), 'stall_r': ('w', 196), 'table_l': ('w', 120), 'table_r': ('w', 120), 'stool': ('w', 40), 'sign': ('w', 100),
    'fountain': ('w', 288), 'notice_board': ('w', 120), 'post_box': ('h', 118), 'gate_arch': ('w', 140), 'plaque': ('w', 110),
    'tree': ('h', 250), 'flower_bed': ('w', 120), 'bush': ('w', 56), 'fence_l': ('w', 120), 'fence_r': ('w', 120), 'lamp': ('h', 150),
    'flower_cart': ('w', 120), 'crates': ('w', 64), 'barrel': ('w', 44), 'well': ('w', 92), 'planter': ('w', 56),
    'bench_l': ('w', 96), 'bench_r': ('w', 96),
}


def use_theme():
    G.use_theme(THEME)
    G.VERSION = 'm2'                                         # the square's own picture names and people cache
    G.POSE_OF = {**G.POSE_OF, 'front_wait': 'stand_f', 'front_raise': 'wave_f', 'sit': 'read'}   # the queues and the stumps
    gs.recolor = recolor                                     # painted cloth (this process only: the guild keeps its own)
    gs.rehair = lambda img, n: img                           # painted hair keeps its colour (the pixel-art recolouring speckled it)


def recolor(img, key_hex, to_hex, hue_tol=32):
    """The key-coloured cloth in a new colour, made for painted pictures: the brush texture spreads the hue and the saturation, so
    the mask takes a wider hue band and paler pixels, then closes its pinholes (left pink, they showed as a patchwork). Every
    masked pixel takes the new hue; saturation and value follow the pixel's own against the key's, so the painted shading stays."""
    if to_hex.lower() == key_hex.lower():
        return img
    kh, ks, kv = gs._hsv(key_hex)
    th, ts, tv = gs._hsv(to_hex)
    rgba = np.array(img)
    hsv = np.array(Image.fromarray(rgba[..., :3], 'RGB').convert('HSV')).astype(np.float32)
    dh = np.abs(hsv[..., 0] - kh)
    dh = np.minimum(dh, 256 - dh)
    solid = rgba[..., 3] > 0
    core = (dh <= hue_tol) & (hsv[..., 1] >= 30) & solid
    m = Image.fromarray(core.astype(np.uint8) * 255, 'L')
    closed = np.array(m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))) > 0
    mask = (core | (closed & (dh <= hue_tol * 2.2))) & solid
    out = hsv.copy()
    out[..., 0] = np.where(mask, th, hsv[..., 0])
    out[..., 1] = np.where(mask, np.clip(ts * np.clip(hsv[..., 1] / max(1, ks), 0.35, 1.25), 0, 255), hsv[..., 1])
    out[..., 2] = np.where(mask, np.clip(hsv[..., 2] * (tv / max(1, kv)) * 1.08, 0, 255), hsv[..., 2])
    rgba[..., :3] = np.array(Image.fromarray(out.astype(np.uint8), 'HSV').convert('RGB'))
    return Image.fromarray(rgba, 'RGBA')


def pieces():
    """{piece: RGBA at scene scale} of the square's sheets (m1 .. m6)."""
    out = {}
    for e in gs.spec()['sheets']:
        if e.get('class'):
            continue
        p = gs.cut_sheet(e)
        p.pop('ref_tile', None)
        for name, im in p.items():
            mode, px = SIZE.get(name, ('w', 96))
            out[name] = gs.scaled(im, px / (im.size[0] if mode == 'w' else im.size[1]))
    return out


def prune(keep, older_s=3600):
    """Pictures of the square's folder that neither this scene nor a remembered square scene names, older than an hour, go."""
    names = set(Path(k).name for k in keep)
    for f in ('last-scene-meadow.json', 'last-scene-meadow-demo.json'):
        try:
            names |= set(Path(m).name for m in re.findall(r'hansol-office/meadow/[^"\\]+\.(?:png|gif)', (G.APP_HOME / 'hansol-office' / f).read_text(encoding='utf-8')))
        except OSError:
            pass
    now = time.time()
    for p in [*G.OUT.glob('*.png'), *G.OUT.glob('*.gif')]:
        try:
            if p.name not in names and now - p.stat().st_mtime > older_s:
                p.unlink()
        except OSError:
            pass

def roof_recolor(img, to_hex):
    """A house picture with its red tile roof (and the red-brown timber and door painted with it) in a new colour; the cream walls,
    the stone and the windows stay. Input: RGBA PIL image, '#rrggbb'. Output: a new RGBA image, same size, same alpha.
    Rules (numpy; PIL 'HSV' has hue, saturation and value in 0..255; gs._hsv('#rrggbb') -> (h, s, v) in 0..255):
    1. hsv of the RGB channels; hue in degrees = h * 360 / 255.
    2. mask = alpha > 0 and 2 <= hue degrees <= 24 and s >= 110 and v >= 110.
    3. masked pixels: h = the new colour's h; s = clip(new_s * s / 170, 0, 255); v = clip(v * new_v / 170 * 1.1, 0, 255).
       Other pixels unchanged (exactly).
    4. Back to RGB (PIL HSV -> RGB), the original alpha."""
    arr = np.asarray(img.convert('RGBA'), dtype=np.uint8)
    rgb = arr[..., :3]
    alpha = arr[..., 3]
    hsv = np.asarray(Image.fromarray(np.ascontiguousarray(rgb), 'RGB').convert('HSV'), dtype=np.uint16)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    hue_deg = h * 360 / 255
    mask = (alpha > 0) & (hue_deg >= 2) & (hue_deg <= 24) & (s >= 110) & (v >= 110)
    nh, ns, nv = gs._hsv(to_hex)
    h = np.where(mask, nh, h)
    s = np.where(mask, np.clip(ns * s / 170, 0, 255), s)
    v = np.where(mask, np.clip(v * nv / 170 * 1.1, 0, 255), v)
    new_rgb = np.asarray(Image.fromarray(np.stack([h, s, v], -1).astype(np.uint8), 'HSV').convert('RGB'), dtype=np.uint8)
    out_rgb = np.where(mask[..., None], new_rgb, rgb)
    return Image.fromarray(np.ascontiguousarray(np.dstack([out_rgb, alpha])), 'RGBA')


def site(order, need):
    """Where the yards go and how big the village is (tiles). order = the workspaces' keys in order; need = {key: seats it needs}.
    Returns (yards, C, R, fdx, fdy): yards = list of dicts {'g', 'side', 'x0', 'y0', 'w', 'h', 'cols', 'rows'} in the order of
    `order`; C x R = the grid size; fdx, fdy = the depth (tiles) of the front strips along gx = C - 1 and gy = R - 1.
    - A yard's size by its side (k = max(2, ceil(need / 2))):
        'right'   (back, along gx, gy in [0, SD)):   cols = k, rows = 2, w = 5 * cols + 3, h = SD
        'left'    (back, along gy, gx in [0, SD)):   rows = k, cols = 2, h = 4 * rows + 5, w = SD
        'front_r' (front, along gx, by gy = R - 1):  cols = k, rows = 2, w = 5 * cols + 3, h = FD
        'front_l' (front, along gy, by gx = C - 1):  rows = k, cols = 2, h = 4 * rows + 5, w = FD
      A side's length = the sum of its yards' lengths along it (w for right and front_r, h for left and front_l) + YGAP between
      two of its yards (0 for an empty side).
    - Sides, in the order of `order`: each key goes to the side that is shortest before adding it; ties go to the first of
      ('right', 'left', 'front_r', 'front_l'). So 1 key -> right; 2 -> right, left; 3 -> + front_r; 4 -> one on each side.
    - fdx = FD when any yard is 'front_l', else 2; fdy = FD when any yard is 'front_r', else 2.
    - C = G.even(max(SD + YGAP + max(length right, length front_r) + YGAP + fdx + 1, SD + PMIN + fdx + 1));
      R = G.even(max(SD + YGAP + max(length left, length front_l) + YGAP + fdy + 1, SD + PMIN + fdy + 1)).
    - Positions, each side's yards in their order: right: x0 from SD + YGAP, y0 = 0; left: y0 from SD + YGAP, x0 = 0;
      front_r: x0 from SD + YGAP, y0 = R - 1 - FD; front_l: y0 from SD + YGAP, x0 = C - 1 - FD; the next yard on a side starts at
      the previous one's start + its length + YGAP."""
    sides = {'right': [], 'left': [], 'front_r': [], 'front_l': []}
    lens = {s: 0 for s in sides}
    for key in order:
        k = max(2, math.ceil(need[key] / 2))
        best = None
        for s in ('right', 'left', 'front_r', 'front_l'):
            if best is None or lens[s] < lens[best]:
                best = s
        if best in ('right', 'front_r'):
            w = 5 * k + 3
            yd = {'right': {'w': w, 'h': SD, 'cols': k, 'rows': 2}, 'front_r': {'w': w, 'h': FD, 'cols': k, 'rows': 2}}
            yd = yd[best]
            lens[best] += w
        else:
            h = 4 * k + 5
            yd = {'left': {'w': SD, 'h': h, 'cols': 2, 'rows': k}, 'front_l': {'w': FD, 'h': h, 'cols': 2, 'rows': k}}
            yd = yd[best]
            lens[best] += h
        sides[best].append((key, yd))
        if len(sides[best]) > 1:
            lens[best] += YGAP
    fdx = FD if sides['front_l'] else 2
    fdy = FD if sides['front_r'] else 2
    C = G.even(max(SD + YGAP + max(lens['right'], lens['front_r']) + YGAP + fdx + 1, SD + PMIN + fdx + 1))
    R = G.even(max(SD + YGAP + max(lens['left'], lens['front_l']) + YGAP + fdy + 1, SD + PMIN + fdy + 1))
    yards = []
    pos = {}
    for s, ylist in sides.items():
        p = SD + YGAP
        for key, yd in ylist:
            y = {'g': key, 'side': s, **yd}
            if s == 'right':
                y['x0'], y['y0'] = p, 0
            elif s == 'left':
                y['x0'], y['y0'] = 0, p
            elif s == 'front_r':
                y['x0'], y['y0'] = p, R - 1 - FD
            else:
                y['x0'], y['y0'] = C - 1 - FD, p
            p += (yd['w'] if s in ('right', 'front_r') else yd['h']) + YGAP
            yards.append(y)
            pos[key] = y
    return [pos[key] for key in order], C, R, fdx, fdy


def fence_run(put, cells, horizontal, oid):
    """A fence along a straight line of tiles. cells = the line's tiles in order, sorted along the line (gx for a horizontal line,
    gy for a vertical one); they may have gaps (a gate). Split the cells into runs of consecutive tiles. In each run, from its first
    tile: every full 4 tiles = one fence piece, put('fence_r', gx, gy, 4, 1, 'bs', oid=..., kind='fence') when horizontal, else
    put('fence_l', gx, gy, 1, 4, 'fs', oid=..., kind='fence') (gx, gy = the piece's first tile); the 1 to 3 tiles left at a run's end
    are one bush each: put('bush', gx, gy, 1, 1, oid=..., kind='bush'). Every call's oid is f'{oid}:{n}' with n = 0, 1, 2 .. in
    call order. Returns nothing."""
    n = 0
    run = []
    for cell in list(cells) + [None]:
        if cell is not None and run and (cell[0] == run[-1][0] + 1 or cell[1] == run[-1][1] + 1):
            run.append(cell)
            continue
        if run:
            for i in range(0, len(run), 4):
                chunk = run[i:i + 4]
                gx, gy = chunk[0]
                if len(chunk) == 4:
                    if horizontal:
                        put('fence_r', gx, gy, 4, 1, 'bs', oid=f'{oid}:{n}', kind='fence')
                    else:
                        put('fence_l', gx, gy, 1, 4, 'fs', oid=f'{oid}:{n}', kind='fence')
                else:
                    for cx, cy in chunk:
                        put('bush', cx, cy, 1, 1, oid=f'{oid}:{n}', kind='bush')
                        n += 1
                    continue
                n += 1
            run = []
        if cell is not None:
            run = [cell]


def tint_yards(bg, hall, yards):
    """The yards' ground in their colours, on the floor picture bg (RGBA, hall.W x hall.H). yards = list of
    {'inner': [x0, y0, w, h] tiles, 'colour': '#rrggbb'}. On one transparent overlay (same size, PIL ImageDraw), for every tile
    (gx, gy) with x0 <= gx < x0 + w and y0 <= gy < y0 + h: the tile's diamond (corners hall.corner(gx - 0.5, gy - 0.5),
    hall.corner(gx + 0.5, gy - 0.5), hall.corner(gx + 0.5, gy + 0.5), hall.corner(gx - 0.5, gy + 0.5)) filled with: on the
    rectangle's edge (first or last column or row) the colour at alpha 215; inside, the colour mixed half and half with SAND
    (each channel (c + s) // 2) at alpha 200 (a light ground in the yard's colour: a thin tint on the grass read as green).
    Return bg.alpha_composite-d with the overlay (a new image or bg itself)."""
    ov = Image.new('RGBA', bg.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    sand = tuple(int(SAND[i:i + 2], 16) for i in (1, 3, 5))
    for yd in yards:
        x0, y0, w, h = yd['inner']
        col = yd['colour']
        c = tuple(int(col[i:i + 2], 16) for i in (1, 3, 5))
        edge, inner = c + (215,), tuple((ch + s) // 2 for ch, s in zip(c, sand)) + (200,)
        for gx in range(x0, x0 + w):
            for gy in range(y0, y0 + h):
                pts = [hall.corner(gx - 0.5, gy - 0.5), hall.corner(gx + 0.5, gy - 0.5),
                       hall.corner(gx + 0.5, gy + 0.5), hall.corner(gx - 0.5, gy + 0.5)]
                d.polygon(pts, fill=edge if gx in (x0, x0 + w - 1) or gy in (y0, y0 + h - 1) else inner)
    bg.alpha_composite(ov)
    return bg


def build_yard(v, yard, colour, n0):
    """One workspace's yard: its cottage, tables and seats, fence, gate, sign and lamp. Returns (seats, desks, island, n).
    v = the plan's toolbox (attributes): v.put(name, gx0, gy0, w, h, want=None, oid=None, kind='decor', img=None) -> pixel rect
    [x, y, w, h] or None (blocks the tiles); v.lamp(gx, gy, check=False); v.hall (hall.xy(gx, gy) -> [x, y], a tile's feet point);
    v.F = pieces(); v.groups = {key: {'title', 'source', 'ids'}}; v.seat_no = {agent id: seat number in its group};
    v.reserved, v.people_at = sets of (gx, gy); v.things = list. yard = one dict of site(); colour = '#rrggbb'; n0 = the first
    seat's running number. g = yard['g'], cols = yard['cols'], rows = yard['rows'], x0, y0, w, h = the yard's.
    Right yard (yard['side'] == 'right', the back is gy = 0):
      cottage: put('house_r2', x0 + (w - 8) // 2, 0, 8, 4, oid=f'cottage:{g}', kind='house', img=roof_recolor(F['house_r2'], colour));
      table (c, r) for r in range(rows), c in range(cols): top-left (x0 + 2 + 5 * c, 5 + 4 * r);
      gate gc = x0 + w // 2 - 1: gate tiles (gc, SD - 1), (gc + 1, SD - 1); sign tile (gc + 2, SD - 1); lamp at (gc - 1, SD);
      the tiles just outside the gate (gc, SD), (gc + 1, SD) are reserved too;
      fences: fence_run(put, [(x0, y) for y in range(4, SD)], False, f'fence:{g}:a'),
              fence_run(put, [(x0 + w - 1, y) for y in range(4, SD)], False, f'fence:{g}:b'),
              fence_run(put, [(x, SD - 1) for x in range(x0 + 1, x0 + w - 1) if x not in (gc, gc + 1, gc + 2)], True, f'fence:{g}:c');
      inner = [x0 + 1, 4, w - 2, SD - 5].
    Left yard (the back is gx = 0):
      cottage: put('house_l', 0, y0 + (h - 8) // 2, 4, 8, oid=f'cottage:{g}', kind='house', img=roof_recolor(F['house_l'], colour));
      table (c, r): top-left (5 + 5 * c, y0 + 2 + 4 * r);
      gate gc = y0 + h // 2 - 1: gate tiles (SD - 1, gc), (SD - 1, gc + 1); sign tile (SD - 1, gc + 2); lamp at (SD, gc - 1);
      reserved outside: (SD, gc), (SD, gc + 1);
      fences: fence_run(put, [(x, y0) for x in range(4, SD)], True, f'fence:{g}:a'),
              fence_run(put, [(x, y0 + h - 1) for x in range(4, SD)], True, f'fence:{g}:b'),
              fence_run(put, [(SD - 1, y) for y in range(y0 + 1, y0 + h - 1) if y not in (gc, gc + 1, gc + 2)], False, f'fence:{g}:c');
      inner = [4, y0 + 1, SD - 5, h - 2].
    Order: cottage, then all the tables and seats, then the gate's reserved tiles (add all four to v.reserved), the fences, the
    sign, the lamp.
    Tables and seats (both sides): k = r * cols + c (row by row), sid = f'{g}#{k:02d}';
      dr = put('table_r', tx, ty, 3, 2, 'bs', oid=f'desk:{sid}', kind='desk'); seat tile = [tx + 1, ty + 2]; xy = hall.xy(*tile);
      owner = the agent of groups[g]['ids'] whose seat_no is k, else None;
      seats[sid] = {'tile': tile, 'xy': xy, 'depth': sum(tile), 'n': running number (n0, n0 + 1 ..), 'island': g, 'owner': owner,
                    'fx': [round(dr[0] + dr[2] * 0.45, 1), round(dr[1] + dr[3] * 0.2, 1)]};
      add tuple(tile) to v.reserved and v.people_at;
      owner: desks[owner] = {'seat_id': sid, 'seat_tile': tile, 'seat': xy, 'chair': None, 'seat_depth': sum(tile)};
      no owner: stool = F['stool']; v.things.append((stool, [round(xy[0] - gs.feet_x(stool), 1), round(xy[1] - stool.size[1] + 4, 1),
                stool.size[0], stool.size[1]], [tuple(tile)], f'stool:{sid}', 'stool')).
    Sign: srect = put('sign', sx, sy, 1, 1, oid=f'sign:{g}', kind='sign'); (fx, fy, fw, fh) = G.plaque_face(F['sign']);
      face = [srect x + w * fx, y + h * fy, w * fw, h * fh] each round(.., 1); pa = the face's centre, round(.., 1).
    island = {'key': g, 'title': groups[g]['title'], 'source': groups[g]['source'], 'seats': [sids in k order], 'color': colour,
              'rect': bounding box [x, y, w, h] of the table rects (round 1), 'label': pa,
              'plate': {'at': pa, 'depth': sx + sy + 0.5, 'size': [150, 20], 'behind': False}, 'banner': {'face': face, 'ink': INK},
              'yard': [x0, y0, w, h], 'inner': inner}.
    n = n0 + the number of seats made."""
    g, cols, rows = yard['g'], yard['cols'], yard['rows']
    x0, y0, w, h = yard['x0'], yard['y0'], yard['w'], yard['h']
    right = yard['side'] == 'right'
    F, hall, put, groups, seat_no = v.F, v.hall, v.put, v.groups, v.seat_no
    seats, desks, rects = {}, {}, []

    # cottage
    if right:
        put('house_r2', x0 + (w - 8) // 2, 0, 8, 4, oid=f'cottage:{g}', kind='house',
            img=roof_recolor(F['house_r2'], colour))
    else:
        put('house_l', 0, y0 + (h - 8) // 2, 4, 8, oid=f'cottage:{g}', kind='house',
            img=roof_recolor(F['house_l'], colour))

    # tables and seats
    n = n0
    for r in range(rows):
        for c in range(cols):
            k = r * cols + c
            sid = f'{g}#{k:02d}'
            if right:
                tx, ty = x0 + 2 + 5 * c, 5 + 4 * r
            else:
                tx, ty = 5 + 5 * c, y0 + 2 + 4 * r
            dr = put('table_r', tx, ty, 3, 2, 'bs', oid=f'desk:{sid}', kind='desk')
            rects.append(dr)
            tile = [tx + 1, ty + 2]
            xy = hall.xy(*tile)
            owner = next((i for i in groups[g]['ids'] if seat_no.get(i) == k), None)
            seats[sid] = {'tile': tile, 'xy': xy, 'depth': sum(tile), 'n': n, 'island': g, 'owner': owner,
                          'fx': [round(dr[0] + dr[2] * 0.45, 1), round(dr[1] + dr[3] * 0.2, 1)]}
            reserved_tile = tuple(tile)
            v.reserved.add(reserved_tile)
            v.people_at.add(reserved_tile)
            if owner is not None:
                desks[owner] = {'seat_id': sid, 'seat_tile': tile, 'seat': xy, 'chair': None, 'seat_depth': sum(tile)}
            else:
                stool = F['stool']
                v.things.append((stool, [round(xy[0] - gs.feet_x(stool), 1), round(xy[1] - stool.size[1] + 4, 1),
                                         stool.size[0], stool.size[1]], [reserved_tile], f'stool:{sid}', 'stool'))
            n += 1

    # the gate's reserved tiles
    if right:
        gc = x0 + w // 2 - 1
        gate_tiles = [(gc, SD - 1), (gc + 1, SD - 1)]
        outside = [(gc, SD), (gc + 1, SD)]
        sx, sy, lx, ly = gc + 2, SD - 1, gc - 1, SD
    else:
        gc = y0 + h // 2 - 1
        gate_tiles = [(SD - 1, gc), (SD - 1, gc + 1)]
        outside = [(SD, gc), (SD, gc + 1)]
        sx, sy, lx, ly = SD - 1, gc + 2, SD, gc - 1
    v.reserved.update(gate_tiles + outside)

    # fences
    if right:
        fence_run(put, [(x0, y) for y in range(4, SD)], False, f'fence:{g}:a')
        fence_run(put, [(x0 + w - 1, y) for y in range(4, SD)], False, f'fence:{g}:b')
        fence_run(put, [(x, SD - 1) for x in range(x0 + 1, x0 + w - 1) if x not in (gc, gc + 1, gc + 2)], True,
                  f'fence:{g}:c')
        inner = [x0 + 1, 4, w - 2, SD - 5]
    else:
        fence_run(put, [(x, y0) for x in range(4, SD)], True, f'fence:{g}:a')
        fence_run(put, [(x, y0 + h - 1) for x in range(4, SD)], True, f'fence:{g}:b')
        fence_run(put, [(SD - 1, y) for y in range(y0 + 1, y0 + h - 1) if y not in (gc, gc + 1, gc + 2)], False,
                  f'fence:{g}:c')
        inner = [4, y0 + 1, SD - 5, h - 2]

    # sign
    srect = put('sign', sx, sy, 1, 1, oid=f'sign:{g}', kind='sign')
    fx, fy, fw, fh = G.plaque_face(F['sign'])
    face = [round(srect[0] + srect[2] * fx, 1), round(srect[1] + srect[3] * fy, 1),
            round(srect[2] * fw, 1), round(srect[3] * fh, 1)]
    pa = [round(face[0] + face[2] / 2, 1), round(face[1] + face[3] / 2, 1)]

    # lamp
    v.lamp(lx, ly, check=False)

    rx = min(d[0] for d in rects)
    ry = min(d[1] for d in rects)
    rw = max(d[0] + d[2] for d in rects) - rx
    rh = max(d[1] + d[3] for d in rects) - ry
    island = {'key': g, 'title': groups[g]['title'], 'source': groups[g]['source'],
              'seats': [f'{g}#{k:02d}' for k in range(cols * rows)], 'color': colour,
              'rect': [round(rx, 1), round(ry, 1), round(rw, 1), round(rh, 1)], 'label': pa,
              'plate': {'at': pa, 'depth': sx + sy + 0.5, 'size': [150, 20], 'behind': False},
              'banner': {'face': face, 'ink': INK}, 'yard': [x0, y0, w, h], 'inner': inner}
    return seats, desks, island, n


def build_front_yard(v, yard, colour, n0):
    """One workspace's yard on a front side: a market stall with an awning in the workspace's colour (no cottage: a house in front
    would hide the people), tables and seats, fence, gate (towards the square), sign and lamp. Returns (seats, desks, island, n) as
    build_yard. v, colour, n0 as in build_yard, plus v.key_hex (the awning's key colour). g, cols, rows, x0, y0, w, h = yard's.
    'front_r' (along gx; the square is behind it, at gy < y0):
      stall: put('stall_r', x0 + w - 8, y0 + 1, 6, 3, oid=f'stall:{g}', kind='stall', img=recolor(F['stall_r'], v.key_hex, colour));
      table (c, r): top-left (x0 + 2 + 5 * c, y0 + 5 + 4 * r);
      gate tiles (x0 + 1, y0), (x0 + 2, y0); reserved outside: (x0 + 1, y0 - 1), (x0 + 2, y0 - 1);
      sign tile (sx, sy) = (x0 + 6, y0 + h - 1) (on the front fence, between the first two seats); lamp at (x0, y0 - 1);
      fences: fence_run(put, [(x0, y) for y in range(y0, y0 + h)], False, f'fence:{g}:a'),
              fence_run(put, [(x0 + w - 1, y) for y in range(y0, y0 + h)], False, f'fence:{g}:b'),
              fence_run(put, [(x, y0) for x in range(x0 + 1, x0 + w - 1) if x not in (x0 + 1, x0 + 2)], True, f'fence:{g}:c'),
              fence_run(put, [(x, y0 + h - 1) for x in range(x0 + 1, x0 + w - 1) if x != sx], True, f'fence:{g}:d').
    'front_l' (along gy; the square is behind it, at gx < x0):
      stall: put('stall_l', x0 + 1, y0 + 1, 3, 6, oid=f'stall:{g}', kind='stall', img=recolor(F['stall_l'], v.key_hex, colour));
      table (c, r): top-left (x0 + 5 + 5 * c, y0 + 2 + 4 * r);
      gate tiles (x0, y0 + h - 3), (x0, y0 + h - 2); reserved outside: (x0 - 1, y0 + h - 3), (x0 - 1, y0 + h - 2);
      sign tile (sx, sy) = (x0 + 8, y0 + h - 1) (on the end fence); lamp at (x0 - 1, y0 + h - 4);
      fences: fence_run(put, [(x, y0) for x in range(x0, x0 + w)], True, f'fence:{g}:a'),
              fence_run(put, [(x, y0 + h - 1) for x in range(x0, x0 + w) if x != sx], True, f'fence:{g}:b'),
              fence_run(put, [(x0, y) for y in range(y0 + 1, y0 + h - 1) if y not in (y0 + h - 3, y0 + h - 2)], False,
                        f'fence:{g}:c'),
              fence_run(put, [(x0 + w - 1, y) for y in range(y0 + 1, y0 + h - 1)], False, f'fence:{g}:d').
    Both: inner = [x0 + 1, y0 + 1, w - 2, h - 2].
    Order: the stall, then all the tables and seats, then the gate's reserved tiles (all four into v.reserved), the fences, the
    sign, the lamp (v.lamp(lx, ly, check=False)). The tables and seats (sid, seats[sid], v.reserved / v.people_at, desks, stools),
    the sign (srect, face, pa) and the island dict are exactly as in build_yard (same keys and values)."""
    g, cols, rows = yard['g'], yard['cols'], yard['rows']
    x0, y0, w, h = yard['x0'], yard['y0'], yard['w'], yard['h']
    right = yard['side'] == 'front_r'
    F, hall, put, groups, seat_no = v.F, v.hall, v.put, v.groups, v.seat_no
    seats, desks, rects = {}, {}, []

    # the stall (the market's, awning in the workspace's colour)
    if right:
        put('stall_r', x0 + w - 8, y0 + 1, 6, 3, oid=f'stall:{g}', kind='stall',
            img=recolor(F['stall_r'], v.key_hex, colour))
    else:
        put('stall_l', x0 + 1, y0 + 1, 3, 6, oid=f'stall:{g}', kind='stall',
            img=recolor(F['stall_l'], v.key_hex, colour))

    # tables and seats, exactly as in build_yard
    n = n0
    for r in range(rows):
        for c in range(cols):
            k = r * cols + c
            sid = f'{g}#{k:02d}'
            if right:
                tx, ty = x0 + 2 + 5 * c, y0 + 5 + 4 * r
            else:
                tx, ty = x0 + 5 + 5 * c, y0 + 2 + 4 * r
            dr = put('table_r', tx, ty, 3, 2, 'bs', oid=f'desk:{sid}', kind='desk')
            rects.append(dr)
            tile = [tx + 1, ty + 2]
            xy = hall.xy(*tile)
            owner = next((i for i in groups[g]['ids'] if seat_no.get(i) == k), None)
            seats[sid] = {'tile': tile, 'xy': xy, 'depth': sum(tile), 'n': n, 'island': g, 'owner': owner,
                          'fx': [round(dr[0] + dr[2] * 0.45, 1), round(dr[1] + dr[3] * 0.2, 1)]}
            reserved_tile = tuple(tile)
            v.reserved.add(reserved_tile)
            v.people_at.add(reserved_tile)
            if owner is not None:
                desks[owner] = {'seat_id': sid, 'seat_tile': tile, 'seat': xy, 'chair': None, 'seat_depth': sum(tile)}
            else:
                stool = F['stool']
                v.things.append((stool, [round(xy[0] - gs.feet_x(stool), 1), round(xy[1] - stool.size[1] + 4, 1),
                                         stool.size[0], stool.size[1]], [reserved_tile], f'stool:{sid}', 'stool'))
            n += 1

    # the gate's reserved tiles (towards the square), all four into v.reserved
    if right:
        v.reserved.update({(x0 + 1, y0), (x0 + 2, y0), (x0 + 1, y0 - 1), (x0 + 2, y0 - 1)})
        sx, sy, lx, ly = x0 + 6, y0 + h - 1, x0, y0 - 1
    else:
        v.reserved.update({(x0, y0 + h - 3), (x0, y0 + h - 2), (x0 - 1, y0 + h - 3), (x0 - 1, y0 + h - 2)})
        sx, sy, lx, ly = x0 + 8, y0 + h - 1, x0 - 1, y0 + h - 4

    # fences
    if right:
        fence_run(put, [(x0, y) for y in range(y0, y0 + h)], False, f'fence:{g}:a')
        fence_run(put, [(x0 + w - 1, y) for y in range(y0, y0 + h)], False, f'fence:{g}:b')
        fence_run(put, [(x, y0) for x in range(x0 + 1, x0 + w - 1) if x not in (x0 + 1, x0 + 2)], True, f'fence:{g}:c')
        fence_run(put, [(x, y0 + h - 1) for x in range(x0 + 1, x0 + w - 1) if x != sx], True, f'fence:{g}:d')
    else:
        fence_run(put, [(x, y0) for x in range(x0, x0 + w)], True, f'fence:{g}:a')
        fence_run(put, [(x, y0 + h - 1) for x in range(x0, x0 + w) if x != sx], True, f'fence:{g}:b')
        fence_run(put, [(x0, y) for y in range(y0 + 1, y0 + h - 1) if y not in (y0 + h - 3, y0 + h - 2)], False,
                  f'fence:{g}:c')
        fence_run(put, [(x0 + w - 1, y) for y in range(y0 + 1, y0 + h - 1)], False, f'fence:{g}:d')

    # the sign
    srect = put('sign', sx, sy, 1, 1, oid=f'sign:{g}', kind='sign')
    fx, fy, fw, fh = G.plaque_face(F['sign'])
    face = [round(srect[0] + srect[2] * fx, 1), round(srect[1] + srect[3] * fy, 1),
            round(srect[2] * fw, 1), round(srect[3] * fh, 1)]
    pa = [round(face[0] + face[2] / 2, 1), round(face[1] + face[3] / 2, 1)]

    # the lamp
    v.lamp(lx, ly, check=False)

    rx = min(d[0] for d in rects)
    ry = min(d[1] for d in rects)
    rw = max(d[0] + d[2] for d in rects) - rx
    rh = max(d[1] + d[3] for d in rects) - ry
    island = {'key': g, 'title': groups[g]['title'], 'source': groups[g]['source'],
              'seats': [f'{g}#{k:02d}' for k in range(cols * rows)], 'color': colour,
              'rect': [round(rx, 1), round(ry, 1), round(rw, 1), round(rh, 1)], 'label': pa,
              'plate': {'at': pa, 'depth': sx + sy + 0.5, 'size': [150, 20], 'behind': False},
              'banner': {'face': face, 'ink': INK}, 'yard': [x0, y0, w, h],
              'inner': [x0 + 1, y0 + 1, w - 2, h - 2]}
    return seats, desks, island, n


def build_corner(v):
    """The back corner (gx, gy < SD): the village hall with the clock, the notice board, the post box, trees. Returns the hall's
    pixel rect. v as in build_yard (v.put, v.wander(part, tile, facing)).
    put('hall', 5, 8, 8, 4, oid='hall', kind='house') -> the rect to return;
    put('notice_board', SD - 6, SD - 2, 4, 1, 'bs', kind='notice_board'), then v.wander('board', (SD - 4, SD), 'ur');
    put('post_box', SD - 2, 4, 1, 1, kind='post_box');
    trees: put('tree', gx, gy, 1, 1, kind='tree') at (1, 1), (1, 6), (6, 1), (2, 13), (13, 2);
    bushes: put('bush', gx, gy, 1, 1, kind='bush') at (3, 4), (4, 3), (14, 7), (7, 14)."""
    rect = v.put('hall', 5, 8, 8, 4, oid='hall', kind='house')
    v.put('notice_board', SD - 6, SD - 2, 4, 1, 'bs', kind='notice_board')
    v.wander('board', (SD - 4, SD), 'ur')
    v.put('post_box', SD - 2, 4, 1, 1, kind='post_box')
    for gx, gy in ((1, 1), (1, 6), (6, 1), (2, 13), (13, 2)):
        v.put('tree', gx, gy, 1, 1, kind='tree')
    for gx, gy in ((3, 4), (4, 3), (14, 7), (7, 14)):
        v.put('bush', gx, gy, 1, 1, kind='bush')
    return rect


def build_plaza(v, fx0, fy0):
    """The fountain square in front of the yards. fx0, fy0 = the fountain's first tile (it is 6 x 6). v as in build_yard plus
    v.wander(part, tile, facing), v.lamp(gx, gy, check=True).
    1. put('fountain', fx0, fy0, 6, 6, kind='fountain'); v.wander('fountain', (fx0 + 2, fy0 + 6), 'ur').
    2. Lamps (check=True, so a lamp only stands where there is room): (fx0 - 2, fy0 - 2), (fx0 + 7, fy0 - 2), (fx0 - 2, fy0 + 7),
       (fx0 + 7, fy0 + 7).
    3. Things, each put(..., check=True) (skipped when there is no room), and for those with a wander point that point too when
       the thing was placed and the point's tile is free floor (v.hall.walk[gy][gx] == '.'):
       ('bench_r', fx0 + 1, fy0 + 8, 3, 1, 'bs') wander 'bench' at (fx0 + 2, fy0 + 9) 'ur';
       ('bench_l', fx0 + 8, fy0 + 1, 1, 3, 'fs') wander 'bench' at (fx0 + 9, fy0 + 2) 'ul';
       ('well', fx0 - 6, fy0 + 1, 2, 2, None) wander 'well' at (fx0 - 6, fy0 + 3) 'ur';
       ('flower_cart', fx0 + 9, fy0 + 9, 3, 2, 'bs') no wander;
       ('planter', fx0 - 1, fy0 - 1, 1, 1, None), ('planter', fx0 + 6, fy0 - 1, 1, 1, None), ('planter', fx0 - 1, fy0 + 6, 1, 1, None);
       ('crates', fx0 - 5, fy0 - 4, 1, 1, None), ('barrel', fx0 - 4, fy0 - 4, 1, 1, None).
       kind='decor' for all of them. Returns nothing."""
    put, wander, lamp, hall = v.put, v.wander, v.lamp, v.hall
    # 1. the fountain
    put('fountain', fx0, fy0, 6, 6, kind='fountain')
    wander('fountain', (fx0 + 2, fy0 + 6), 'ur')
    # 2. lamps, only where there is room
    for gx, gy in ((fx0 - 2, fy0 - 2), (fx0 + 7, fy0 - 2), (fx0 - 2, fy0 + 7), (fx0 + 7, fy0 + 7)):
        lamp(gx, gy, check=True)
    # 3. things, each only where it fits
    def place(name, gx, gy, a, b, want, wpart=None, wtile=None, wfacing=None):
        r = put(name, gx, gy, a, b, want, kind='decor', check=True)
        if r is not None and wpart is not None:
            wx, wy = wtile
            if hall.walk[wy][wx] == '.':
                wander(wpart, wtile, wfacing)
    place('bench_r', fx0 + 1, fy0 + 8, 3, 1, 'bs', 'bench', (fx0 + 2, fy0 + 9), 'ur')
    place('bench_l', fx0 + 8, fy0 + 1, 1, 3, 'fs', 'bench', (fx0 + 9, fy0 + 2), 'ul')
    place('well', fx0 - 6, fy0 + 1, 2, 2, None, 'well', (fx0 - 6, fy0 + 3), 'ur')
    place('flower_cart', fx0 + 9, fy0 + 9, 3, 2, 'bs')
    place('planter', fx0 - 1, fy0 - 1, 1, 1, None)
    place('planter', fx0 + 6, fy0 - 1, 1, 1, None)
    place('planter', fx0 - 1, fy0 + 6, 1, 1, None)
    place('crates', fx0 - 5, fy0 - 4, 1, 1, None)
    place('barrel', fx0 - 4, fy0 - 4, 1, 1, None)


def build_groves(v, fx0, fy0):
    """Small gardens in the square's four quarters, only when the square is big (it grows with the yards; a big square with only
    the fountain looks empty). v as in build_plaza, v.plaza = (px0, py0, px1, py1) as in lay_floor. a = px1 - px0,
    b = py1 - py0 (the square's size in tiles); nothing when a + b < 60. Otherwise for each centre (qx, qy) in
    (px0 + a // 4, py0 + b // 4), (px0 + 3 * a // 4, py0 + b // 4), (px0 + a // 4, py0 + 3 * b // 4),
    (px0 + 3 * a // 4, py0 + 3 * b // 4), skipped when abs(qx - (fx0 + 3)) < 8 and
    abs(qy - (fy0 + 3)) < 8 (too near the fountain), a garden, each thing put(..., check=True) (skipped when there is no room):
       ('flower_bed', qx - 2, qy - 2, 4, 1, 'bs') kind 'flower_bed';
       ('bench_r', qx - 1, qy, 3, 1, 'bs') kind 'decor', and when it was placed and (qx, qy + 1) is free floor
       (v.hall.walk[qy + 1][qx] == '.'): v.wander('bench', (qx, qy + 1), 'ur');
       ('planter', qx - 3, qy, 1, 1, None) and ('planter', qx + 3, qy, 1, 1, None) kind 'decor';
       v.lamp(qx + 3, qy - 2, check=True).
    Returns nothing."""
    put, wander, lamp, hall = v.put, v.wander, v.lamp, v.hall
    px0, py0, px1, py1 = v.plaza
    a, b = px1 - px0, py1 - py0
    if a + b < 60:
        return
    for qx, qy in ((px0 + a // 4, py0 + b // 4), (px0 + 3 * a // 4, py0 + b // 4),
                   (px0 + a // 4, py0 + 3 * b // 4), (px0 + 3 * a // 4, py0 + 3 * b // 4)):
        if abs(qx - (fx0 + 3)) < 8 and abs(qy - (fy0 + 3)) < 8:
            continue
        put('flower_bed', qx - 2, qy - 2, 4, 1, 'bs', kind='flower_bed', check=True)
        if put('bench_r', qx - 1, qy, 3, 1, 'bs', kind='decor', check=True) is not None and hall.walk[qy + 1][qx] == '.':
            wander('bench', (qx, qy + 1), 'ur')
        put('planter', qx - 3, qy, 1, 1, None, kind='decor', check=True)
        put('planter', qx + 3, qy, 1, 1, None, kind='decor', check=True)
        lamp(qx + 3, qy - 2, check=True)


def build_edges(v, yards, plaza):
    """The village's edges and gaps, after everything else. v as in build_yard plus v.C, v.R, v.door_row; plaza as in lay_floor.
    1. Front edges: along gy = R - 1 from gx = SD while gx + 4 <= C - 1: alternately ('fence_r', 'bs', kind 'fence') and
       ('flower_bed', 'bs', kind 'flower_bed') 4 x 1 at (gx, R - 1), then gx += 5; along gx = C - 1 from gy = SD while
       gy + 4 <= R - 1: alternately ('fence_l', 'fs', 'fence') and ('flower_bed', 'fs', 'flower_bed') 1 x 4 at (C - 1, gy), gy += 5;
       a bush at (C - 1, R - 1). (put returns None and places nothing when a tile is not free.)
    2. The gaps. gap(gx, gy) is True for a tile with 0 <= gx < C - 1 and 0 <= gy < R - 1, not in the hall's corner (not gx < SD
       and gy < SD), not in the square, not inside any yard's [x0, x0 + w) x [y0, y0 + h), not in v.reserved, not near the gate
       (abs(gy - v.door_row) <= 2 and gx < SD), and on free floor (v.hall.walk[gy][gx] == '.'; so it turns False once something
       stands there). For gy in range(R - 1), for gx in range(C - 1), when gap(gx, gy), the first that applies:
       a. a tree, put('tree', gx, gy, 1, 1, kind='tree'), when (gy < 4 or (gx < 4 and gy < v.door_row - 6)) (only far at the back;
          a tree further front hid the gate) and (gx + gy) % 3 == 0 and (gx * 7 + gy) % 4 == 0;
       b. a row of flowers (the flower village's fields), put('flower_bed', gx, gy, 4, 1, 'bs', kind='flower_bed'), when gx >= 4,
          gy >= 4, gy % 3 == 1, gx % 5 == 0 and gap(gx + d, gy) for d in 0, 1, 2, 3;
       c. a bush, put('bush', gx, gy, 1, 1, kind='bush'), when (gx + 2 * gy) % 7 == 0.
       Returns nothing."""
    put = v.put
    C, R = v.C, v.R
    px0, py0, px1, py1 = plaza
    # 1. front edges
    n = 0
    gx = SD
    while gx + 4 <= C - 1:
        if n % 2 == 0:
            put('fence_r', gx, R - 1, 4, 1, 'bs', kind='fence')
        else:
            put('flower_bed', gx, R - 1, 4, 1, 'bs', kind='flower_bed')
        gx += 5
        n += 1
    n = 0
    gy = SD
    while gy + 4 <= R - 1:
        if n % 2 == 0:
            put('fence_l', C - 1, gy, 1, 4, 'fs', kind='fence')
        else:
            put('flower_bed', C - 1, gy, 1, 4, 'fs', kind='flower_bed')
        gy += 5
        n += 1
    put('bush', C - 1, R - 1, 1, 1)                       # the docstring names no kind: put's default ('decor')
    # 2. the gaps
    def gap(gx, gy):
        if not (0 <= gx < C - 1 and 0 <= gy < R - 1):
            return False
        if gx < SD and gy < SD:                       # the hall's corner
            return False
        if px0 <= gx < px1 and py0 <= gy < py1:       # the square
            return False
        if any(y['x0'] <= gx < y['x0'] + y['w'] and y['y0'] <= gy < y['y0'] + y['h'] for y in yards):
            return False
        if (gx, gy) in v.reserved:
            return False
        if abs(gy - v.door_row) <= 2 and gx < SD:     # near the gate
            return False
        return v.hall.walk[gy][gx] == '.'
    for gy in range(R - 1):
        for gx in range(C - 1):
            if not gap(gx, gy):
                continue
            if (gy < 4 or (gx < 4 and gy < v.door_row - 6)) and (gx + gy) % 3 == 0 and (gx * 7 + gy) % 4 == 0:
                put('tree', gx, gy, 1, 1, kind='tree')                    # a. a tree
            elif gx >= 4 and gy >= 4 and gy % 3 == 1 and gx % 5 == 0 and all(gap(gx + d, gy) for d in (0, 1, 2, 3)):
                put('flower_bed', gx, gy, 4, 1, 'bs', kind='flower_bed')  # b. a row of flowers
            elif (gx + 2 * gy) % 7 == 0:
                put('bush', gx, gy, 1, 1, kind='bush')                    # c. a bush


def lay_floor(v, yards, plaza):
    """The floor picture (RGBA, v.hall.W x v.hall.H): 2 x 2 tile pictures, then the yards coloured. yards = [{'inner', 'colour'}];
    plaza = (px0, py0, px1, py1): the square is the tiles px0 <= gx < px1, py0 <= gy < py1; v.path = the set of (gx, gy) tiles of
    the way from the gate to the square.
    For s in range(C // 2 + R // 2), for i in range(C // 2): j = s - i, skip unless 0 <= j < R // 2 (back to front);
    cells = the 4 tiles (2i + u, 2j + w) for u, w in 0, 1; h = int(hashlib.sha1(f'{i},{j}'.encode()).hexdigest(), 16);
    name = 'path' when any cell is in v.path; else ('grass_a' if h % 3 else 'grass_b') when any cell is outside the square;
    else ['cobble_a', 'cobble_b', 'cobble_c'][h % 3].
    Picture im = v.F[name]; (tx, ty) = v.hall.corner(2 * i - 0.5, 2 * j - 0.5); paste it (alpha_composite) at
    (int(round(tx - im.size[0] / 2)), int(round(ty))) on a transparent picture bg. Finally return tint_yards(bg, v.hall, yards)."""
    C, R = v.C, v.R
    bg = Image.new('RGBA', (v.hall.W, v.hall.H), (0, 0, 0, 0))
    px0, py0, px1, py1 = plaza
    for s in range(C // 2 + R // 2):
        for i in range(C // 2):
            j = s - i
            if not 0 <= j < R // 2:
                continue
            cells = [(2 * i + u, 2 * j + w) for u in (0, 1) for w in (0, 1)]
            h = int(hashlib.sha1(f'{i},{j}'.encode()).hexdigest(), 16)
            if any(cell in v.path for cell in cells):
                name = 'path'
            elif any(not (px0 <= cell[0] < px1 and py0 <= cell[1] < py1) for cell in cells):
                name = 'grass_a' if h % 3 else 'grass_b'
            else:
                name = ['cobble_a', 'cobble_b', 'cobble_c'][h % 3]
            im = v.F[name]
            tx, ty = v.hall.corner(2 * i - 0.5, 2 * j - 0.5)
            bg.alpha_composite(im, (int(round(tx - im.size[0] / 2)), int(round(ty))))
    return tint_yards(bg, v.hall, yards)


def plan(agents, demo=False):
    sheets = gs.spec()
    t0 = time.time()
    use = gs.usable()
    F = pieces()

    # ---- the workspaces: one yard each, in the order of their names
    groups, by_title = {}, {}
    for a in sorted(agents, key=lambda a: (str(G.group_key(a)), str(a['id']))):
        title = a.get('island_title') or G.group_key(a).split(':', 1)[-1].split('~')[0] or G.group_key(a)
        g = by_title.setdefault(title, G.group_key(a))
        q = groups.setdefault(g, {'title': title, 'source': a.get('source') or 'app', 'ids': []})
        q['ids'].append(a['id'])
    order = sorted(groups, key=lambda g: (str(groups[g]['title']).lower(), g))
    seat_no = G.assign_seats({g: groups[g]['ids'] for g in order}, demo)
    need = {g: max([2, len(groups[g]['ids'])] + [seat_no[i] + 1 for i in groups[g]['ids']]) for g in order}
    yards, C, R, fdx, fdy = site(order, need)
    hall = G.Hall(C, R, top=260)
    things, lights, stand_points = [], [], []                # things: (image, rect, cells, id, kind), sliced once the light map is known
    reserved, people_at = set(), set()                       # tiles kept free / tiles people stay on (nothing tall right in front)

    def inside(t):
        return 0 <= t[0] < C - 1 and 0 <= t[1] < R - 1

    def clear(cells):
        """On the map, on free tiles, nothing reserved under it, a free ring round it, not right in front of a person."""
        for gx, gy in cells:
            if not inside((gx, gy)) or hall.walk[gy][gx] != '.' or (gx, gy) in reserved:
                return False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (gx + dx, gy + dy)
                    if inside(n) and hall.walk[n[1]][n[0]] != '.':
                        return False
            if any(0 <= gx - rx <= 3 and 0 <= gy - ry <= 3 for rx, ry in people_at):
                return False
        return True

    def put(name, gx0, gy0, a, b, want=None, oid=None, kind='decor', img=None, check=False):
        cells = G.footprint(gx0, gy0, a, b)
        if check and not clear(cells):
            return None
        if any(not (0 <= x < C and 0 <= y < R) or hall.walk[y][x] != '.' for x, y in cells):
            return None
        im = img if img is not None else F[name] if want is None else G.facing(F[name], want)
        rect = G.place_floor_thing(hall, im, cells)
        things.append((im, rect, cells, oid or f'{name}:{gx0}-{gy0}', kind))
        hall.block(cells)
        return rect

    def wander(part, tile, facing_):
        reserved.add(tuple(tile))
        stand_points.append({'for': part, 'part': part, 'tile': list(tile), 'xy': hall.xy(*tile), 'facing': facing_, 'wander': True})

    def lamp(gx, gy, check=True):
        r = put('lamp', gx, gy, 1, 1, kind='lamp', check=check)
        if r:
            at = [round(r[0] + r[2] * 0.72, 1), round(r[1] + r[3] * 0.2, 1)]
            lights.append({'island': 'lamp', 'kind': 'lamp', 'at': at, 'size': [160, 110]})
        return r

    v = SimpleNamespace(put=put, lamp=lamp, wander=wander, hall=hall, F=F, groups=groups, seat_no=seat_no,
                        reserved=reserved, people_at=people_at, things=things, C=C, R=R,
                        key_hex=sheets.get('robe_key', '#D02FC0'))

    # ---- the square in the middle; the gate on the left edge's front corner, the way from it to the square (kept free first)
    plaza = (SD, SD, C - 1 - fdx, R - 1 - fdy)               # px0, py0, px1, py1 (ends excluded)
    door_row = R - 2 - fdy // 2
    door_tile, inside_tile = (2, door_row), (3, door_row)
    gate_cells = G.footprint(0, door_row - 1, 2, 3)
    hall.block(gate_cells)
    fx0, fy0 = (plaza[0] + plaza[2]) // 2 - 3, (plaza[1] + plaza[3]) // 2 - 3  # the fountain (6 x 6) in the middle of the square
    path = {(gx, door_row) for gx in range(2, SD + 2)} | {(gx, gy) for gx in (SD, SD + 1) for gy in range(plaza[3] - 1, door_row)}
    reserved |= {door_tile, inside_tile} | path
    v.plaza, v.door_row, v.path = plaza, door_row, path

    # ---- the yards (seats first: nothing may stand in front of them later), the corner, the square, the edges
    seats, desks, islands, used, n = {}, {}, [], set(), 0
    for y in yards:
        ci = gs._pick(f'{y["g"]}|standard', len(COLORS))
        while ci in used and len(used) < len(COLORS):
            ci = (ci + 1) % len(COLORS)
        used.add(ci)
        build = build_front_yard if y['side'].startswith('front') else build_yard
        s, d, isl, n = build(v, y, COLORS[ci], n)
        seats.update(s)
        desks.update(d)
        islands.append(isl)
    hall_rect = build_corner(v)
    build_plaza(v, fx0, fy0)
    build_groves(v, fx0, fy0)
    build_edges(v, yards, plaza)
    bg = lay_floor(v, [{'inner': i['inner'], 'colour': i['color']} for i in islands], plaza)

    # ---- light: the day's ambient (sheets.json), the lamps a little warmer round them
    L = G.light_map(hall.W, hall.H, [(l['at'][0], l['at'][1] + 40, 90, 0.35, G.WARM) for l in lights])
    bg = G.shade(bg, (0, 0), L)
    objects = []
    for im, rect, cells, oid, kind in things:
        objects.extend(G.slices(hall, G.shade(im, rect, L), rect, cells, oid, kind))
    objects.sort(key=lambda o: (o['depth'], o['rect'][1]))

    # ---- the gate (the door: one picture in every state, no leaves), the clock on the hall
    arch = F['gate_arch']
    arect = G.place_floor_thing(hall, arch, gate_cells)
    apic = G.write_png(G.shade(arch, arect, L), 'door')
    door = {'tile': list(door_tile), 'open_cells': [list(door_tile)], 'rect': arect, 'closed': apic, 'half': apic, 'open': apic,
            'depth': sum(door_tile) - 0.6, 'width': 2, 'leaves': 0,
            'appear': {'xy': hall.xy(*door_tile)}, 'vanish': {'xy': hall.xy(*door_tile)}, 'label_at': hall.xy(4, door_row + 2)}
    pq = gs.scaled(F['plaque'], 1.3)                         # a light board: dark words (the guild's are light on dark wood)
    clock = {'at': [round(hall_rect[0] + hall_rect[2] * 0.5, 1), round(hall_rect[1] + hall_rect[3] * 0.30, 1)],   # under the bell tower
             'plaque': G.write_png(pq, 'plaque'), 'size': list(pq.size), 'face': G.plaque_face(pq), 'ink': INK, 'ink2': CLOCK_INK2}
    fx = {'work': {cls: G.spark_picture(G.CLASS_FX.get(cls, '#ffd76a')) for cls in use['classes']},
          'work_glow': {cls: G.glow_picture(G.CLASS_FX.get(cls, '#ffd76a'), 40) for cls in use['classes']}}

    # ---- people
    people, pose_size, sprite, class_of = G.make_people(agents, sheets, use)

    # ---- background tiles (256 px + bleed, as the guild's)
    BLEED = 2
    bg = G.fill_seams(bg)
    tiles = []
    for ty in range(0, hall.H, 256):
        for tx in range(0, hall.W, 256):
            core = (tx, ty, min(hall.W, tx + 256), min(hall.H, ty + 256))
            if bg.crop(core).getbbox():
                t = bg.crop((core[0] - BLEED, core[1] - BLEED, core[2] + BLEED, core[3] + BLEED))
                tiles.append({'file': G.write_png(t, 'bg'), 'rect': [tx, ty, core[2] - tx, core[3] - ty], 'bleed': BLEED})

    scene = {
        'theme': THEME, 'backdrop': sheets.get('backdrop'), 'l86': True, 'native': True, 'scale': 1.0, 'people_scale': 1.0,
        'width': hall.W, 'height': hall.H,
        'grid': {'origin': [hall.ox, hall.oy], 'tw': TW, 'th': TH, 'cols': C, 'rows': R,
                 'walk': [''.join(r) for r in hall.walk], 'floor': ['1' * C for _ in range(R)]},
        'background_tiles': tiles, 'objects': objects, 'door': door,
        'spots': {'entrance': {'tile': list(inside_tile), 'xy': hall.xy(*inside_tile)}, 'door': hall.xy(*door_tile)},
        'seats': seats, 'desks': desks, 'stand_points': stand_points, 'islands': islands, 'zones': [],
        'wander': True, 'lights': lights, 'fx': fx, 'clock': clock, 'people_class': class_of,
        'people': people, 'pose_size': pose_size, 'sprite': sprite,
        'seatless': [], 'wait_avoid': [], 'tags_short': False,
        'square': list(plaza),                               # px0, py0, px1, py1: the fountain square's tiles (ends excluded)
        'tod': TOD,                                          # out of doors: the evening and the night darken the whole village
    }
    scene['scene_id'] = hashlib.sha1(json.dumps({k: scene[k] for k in ('grid', 'background_tiles', 'objects', 'door', 'seats', 'desks')}, sort_keys=True).encode()).hexdigest()[:10]
    scene['file'] = tiles[0]['file'] if tiles else f'{G.REL}/none.png'
    scene['plan_ms'] = int((time.time() - t0) * 1000)
    keep = [t['file'] for t in tiles] + [o['file'] for o in objects] + [apic] + G.collect_paths(fx) + G.collect_paths(clock)
    for files in people.values():
        keep += G.collect_paths(files)
    keep.append(sprite.get('shadow', {}).get('file', ''))
    prune(keep)
    return scene


def render_preview(scene, out_path, grid=False):
    """The scene as one PNG with everybody at their seat (a look at the whole village without the App). Pictures are files
    relative to G.APP_HOME (open as RGBA). Change from the old square's preview: no queues, everyone at the own seat.
    1. Canvas W x H = scene['width'], scene['height'], filled with scene['backdrop'] ('#rrggbb', default '#101827').
    2. Background: for each t in scene['background_tiles']: b = t.get('bleed', 0), r = t['rect']; paste its picture cropped to
       (b, b, b + r[2], b + r[3]) at (int(r[0]), int(r[1])).
    3. Layers (depth, order, file, rect): every object (o['depth'], 0, o['file'], o['rect']); the door (door['depth'], 0,
       door['closed'], door['rect']).
    4. People, in the order of scene['desks'] (n = 0, 1, ..), all at desks[pid]['seat'] (x, y): pose by n % 4: 0 'type_pc',
       1 'front_raise' (asking for approval), 2 'front_give' (reporting), 3 'stand' (waiting); picture people[pid][pose] (skip a
       missing one). Depth = (largest depth of the objects whose id starts with f"desk:{seat_id}", else seat_depth) + 0.5.
       Rect = [x - w / 2, y - h, w, h] with w, h = scene['pose_size']['stand']; order 2.
    5. Draw the layers sorted by (depth, order), each at (int(round(x)), int(round(y))) of its rect.
    6. Clock: if scene['clock'] has 'plaque', open that picture and draw it with its own size centred on clock['at']:
       (int(at x - picture width / 2), int(at y - picture height / 2)).
    7. grid=True: on top, every grid tile's diamond (centre x = origin x + (gx - gy) * TW / 2, y = origin y + (gx + gy) * TH / 2,
       corners at +-TW/2, +-TH/2): outline (255, 255, 0, 90) if walk is '.', else (255, 60, 60, 160).
    8. Save as RGB to out_path."""
    def open_pic(file):
        return Image.open(G.APP_HOME / file).convert('RGBA')

    # 1. the canvas
    canvas = Image.new('RGBA', (int(scene['width']), int(scene['height'])), scene.get('backdrop') or '#101827')
    # 2. the background tiles
    for t in scene.get('background_tiles', []):
        b = t.get('bleed', 0)
        r = t['rect']
        pic = open_pic(t['file']).crop((b, b, b + r[2], b + r[3]))
        canvas.paste(pic, (int(r[0]), int(r[1])), pic)
    # 3. the objects and the door
    layers = [(o['depth'], 0, o['file'], o['rect']) for o in scene.get('objects', [])]
    door = scene['door']
    layers.append((door['depth'], 0, door['closed'], door['rect']))
    # 4. the people, all at their seat
    desks = scene['desks']
    for n, pid in enumerate(desks):
        d = desks[pid]
        pose = ('type_pc', 'front_raise', 'front_give', 'stand')[n % 4]
        files = scene['people'].get(pid) or {}
        if pose not in files:
            continue
        prefix = f"desk:{d['seat_id']}"
        depths = [o['depth'] for o in scene.get('objects', []) if str(o.get('id', '')).startswith(prefix)]
        depth = (max(depths) if depths else d['seat_depth']) + 0.5
        x, y = (float(c) for c in d['seat'])
        w, h = (float(scene['pose_size']['stand'][k]) for k in ('w', 'h'))
        layers.append((depth, 2, files[pose], [x - w / 2, y - h, w, h]))
    # 5. draw the layers back to front
    for depth, order, file, rect in sorted(layers, key=lambda l: (l[0], l[1])):
        pic = open_pic(file)
        canvas.paste(pic, (int(round(rect[0])), int(round(rect[1]))), pic)
    # 6. the clock on the hall
    clock = scene.get('clock') or {}
    if clock.get('plaque'):
        pic = open_pic(clock['plaque'])
        ax, ay = clock['at']
        canvas.paste(pic, (int(ax - pic.size[0] / 2), int(ay - pic.size[1] / 2)), pic)
    # 7. the grid
    if grid:
        gd = scene['grid']
        ox, oy = gd['origin']
        tw, th = gd['tw'], gd['th']
        dr = ImageDraw.Draw(canvas)
        for gy in range(gd['rows']):
            row = gd['walk'][gy] if gy < len(gd['walk']) else ''
            for gx in range(gd['cols']):
                cx = ox + (gx - gy) * tw / 2
                cy = oy + (gx + gy) * th / 2
                pts = [(cx - tw / 2, cy), (cx, cy - th / 2), (cx + tw / 2, cy), (cx, cy + th / 2)]
                outline = (255, 255, 0, 90) if gx < len(row) and row[gx] == '.' else (255, 60, 60, 160)
                dr.polygon(pts, outline=outline)
    # 8. save
    canvas.convert('RGB').save(out_path)



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agents', default='[]')
    ap.add_argument('--box', default='1280x800')
    ap.add_argument('--config', default=None)               # (office.js passes the office settings: the square has none)
    ap.add_argument('--demo', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--preview', default=None)
    ap.add_argument('--grid', action='store_true')
    args = ap.parse_args()
    use_theme()
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
    print(json.dumps(scene))                                  # ASCII only (the App reads UTF-8; a Windows code page would break names)
    return 0


if __name__ == '__main__':
    sys.exit(main())
