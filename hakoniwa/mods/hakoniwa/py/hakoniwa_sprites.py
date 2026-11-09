#!/usr/bin/env python3
"""Sprite parts and people for the agent HUD office (the chosen style, concepts 175119_03).

Used as a module by hakoniwa-office.py (`sys.path` has its folder):

    import hakoniwa_sprites as sprites
    sprites.parts()      -> manifest dict (room and desk PNGs, the lit-screen frames, sprite size)
    sprites.person(id)   -> {"type": [p1, p2], "raise", "hold", "stand", "walk_dl": [p1, p2],
                             "walk_ur": [p1, p2], "sofa", "sit", "walk", "doze"}

All paths are relative to ~/.config/herdr-app (like the other office files) and carry a content
hash, because Herdr App caches images by path. Fixed things (floor, walls, desks, furniture) are
the sheet's PNGs as they are; only people are recoloured.

Sources: three generated sheets with a transparent background in `concepts/` (room pieces; desks
and small furniture; two people). Pieces are found by connected components of the alpha channel,
so no cut boxes are written by hand, and a changed layout fails loudly (piece count).

* parts(): `desk_off` is `desk_on` with the monitor faces painted dark (so it lines up exactly; the
  sheet's own off-desk is kept as `desk_off_sheet`). `screen_on` are two frames of lit screens (rect
  in desk coordinates): the mod lays them over a working desk and swaps them with
  .loop("opacity") so the code seems to move. `desk_alert` (warning light) is the same desk;
  its `offset` says where it sits in desk_on coordinates.
* person(id): one of the two people, with jacket, hair and skin colours from a fixed random number
  generated from the id (the same agent always looks the same). Cached.

CLI (for a look):  python -I hakoniwa_sprites.py --preview <png> [--ids a,b,c]
"""
import argparse
import colorsys
import hashlib
import math
import io
import json
import os
import re
import time
import shutil
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

HOME = Path.home()
APP_HOME = Path(os.environ.get('HERDR_APP_HOME') or HOME / '.config' / 'herdr-app')
OUT = APP_HOME / 'hakoniwa-office' / 'sheet'
BUNDLED = Path(__file__).resolve().parents[1] / 'herdr-app' / 'assets' / 'sheets'
VERSION = 97   # v97 (★100-1): the welcome board (one facing, never mirrored) joins the deco parts

ALPHA_MIN = 40
# ★75-3: more plants (T3, the pot on the 2:1 isometric, background and the gaps between the leaves clear): <name>_L / _R. One scale for all
# (drawn at one scale): the palm about 1.4 x the old potted plant; placed like it (office: place(..., .3)).
PLANT_ISO_DIR = 'plants-iso-20261105'
PLANT_ISO = {'plant_fig': 'fig', 'plant_snake': 'snake', 'plant_monstera': 'monstera', 'plant_boxwood': 'boxwood', 'plant_palm': 'palm'}
PLANT_ISO_K = .6
# ★89-4: office things that fill the faces the machines left (T3, 11/5): <name>_L / _R in their own folder, the same 2:1 isometric as the machines (ISO_K, the machines' route:
# white rim off, holes filled). deco_* parts: one cell, a back on a wall / partition (office: furn()).
DECO_ISO = {'deco_whiteboard': ('office-iso-20261105', 'whiteboard'), 'deco_bookshelf': ('office-iso-20261105', 'bookshelf'), 'deco_fridge': ('office-iso-20261105', 'fridge'),
            'deco_microwave': ('office-iso-20261105', 'microwave'), 'deco_shredder': ('office-iso-20261105', 'shredder'), 'deco_locker': ('office-iso-20261105', 'locker'),
            'deco_recycle': ('office-iso-20261105', 'recycle'), 'deco_cafe': ('break-iso-20261105', 'cafe'), 'deco_hightable': ('break-iso-20261105', 'hightable'),
            'deco_bench': ('break-iso-20261105', 'bench'), 'deco_counter': ('counter-iso-20261105', 'counter'), 'deco_barstool': ('counter-iso-20261105', 'barstool'),
            # ★100-1 the welcome board by the entrance (T3, 11/6): _L only (front +x), never mirrored (the WELCOME letters would turn round)
            'deco_welcome': ('welcome-iso-20261106', 'welcome')}
CELL = 4           # resolution (px) of the mask used to find pieces
MIN_CELLS = 150

# sheet file -> (piece names in reading order, merge distance in cells)
ROOM_SHEET = ('20261102_175916_00.png',
              ['floor_tile', 'partition_left', 'partition_right', 'partition_corner',
               'partition_doorway', 'wall_window_left', 'wall_window_right', 'door_closed',
               'door_half', 'door_open', 'reception', 'picture',
               'trash'], 2)
DESK_SHEET = ('20261102_180043_01.png',
              ['desk_on', 'desk_off_sheet', 'desk_alert',
               'lamp_on', 'lamp_off', 'mug_1', 'mug_2',
               'mug_3', 'plant', 'books', 'pens',
               'bookshelf', 'chair', 'sofa', 'table'], 1)
PEOPLE_SHEET = ('20261102_180223_02.png',
                [f'{who}_{pose}' for who in ('a', 'b')
                 for pose in ('type1', 'type2', 'raise', 'hold', 'stand',
                              'walk_dl1', 'walk_dl2', 'walk_ur1', 'walk_ur2', 'sofa')], 1)

# Dozing in an armchair: three poses per person (male a, female b); person() picks one by the id.
DOZE_SHEET = ('20261102_204112.png', [f'{who}_doze{n}' for who in ('a', 'b') for n in (1, 2, 3)], 2)
DOZES = ['doze1', 'doze2', 'doze3']
_HERE = Path(__file__).resolve().parent
BUNDLED = next((d for d in (_HERE / 'sheets', _HERE.parent / 'herdr-app' / 'assets' / 'sheets') if d.is_dir()), _HERE / 'sheets')   # an installed copy has `sheets` next to it; the source tree keeps them in herdr-app/assets/sheets

# Seen from the front, for the queues at the windows (wait, hand in a paper, raise a paper, bow) and the
# windows' own desks seen from the inside (approval: monitor, stamp, in-tray, warning light; counter: in-tray, bell).
FRONT_POSES = ['front_wait', 'front_give', 'front_raise', 'bow']
FRONTS_SHEET = ('20261102_210146.png', [f'{who}_{p}' for who in ('a', 'b') for p in FRONT_POSES], 2)
WINDOWS_SHEET = ('20261102_210317.png', ['win_approval_empty', 'win_approval_full', 'win_counter_empty', 'win_counter_full'], 2)
WINDOW_PARTS = WINDOWS_SHEET[1]
WIN_FRONT_SHEET1 = ('20261104_140148_alpha.png', ['win_approval_front_empty', 'win_approval_front_full', 'a_staff_sit', 'b_staff_sit'], 2)
WIN_FRONT_SHEET2 = ('20261104_140114_alpha.png', ['_wf_u0', '_wf_u1', 'win_counter_front_empty', 'win_counter_front_full', '_wf_u2', '_wf_u3', '_wf_u4'], 2)
WIN_FRONT_PARTS = ['win_approval_front_empty', 'win_approval_front_full', 'win_counter_front_empty', 'win_counter_front_full',
                   'win_approval_front_nochair_empty', 'win_approval_front_nochair_full', 'win_counter_front_nochair_empty', 'win_counter_front_nochair_full',
                   'win_approval_front', 'win_counter_front', 'win_approval_front_nochair', 'win_counter_front_nochair']
STAFF_POSES = ['staff_sit']

ROOM_PARTS = [n for n in ROOM_SHEET[1]]
DESK_PARTS = ['desk_alert', 'lamp_on', 'lamp_off', 'mug_1', 'mug_2', 'mug_3', 'plant', 'books', 'pens',
              'bookshelf', 'chair', 'sofa', 'table']
POSES = ['type1', 'type2', 'raise', 'hold', 'stand', 'walk_dl1', 'walk_dl2', 'walk_ur1', 'walk_ur2', 'sofa']
# Where the head is (rows above this fraction of the piece): hair is only recoloured there.
HEAD = {'type_pc': .4, 'type_pc2': .4, 'read_pc': .42, 'staff_sit': .4, 'type1': .4, 'type2': .4, 'raise': .42, 'hold': .32, 'stand': .32, 'walk_dl1': .32, 'walk_dl2': .32,
        'walk_ur1': .32, 'walk_ur2': .32, 'sofa': .38, 'doze1': .5, 'doze2': .5, 'doze3': .5,
        'front_wait': .32, 'front_give': .32, 'front_raise': .32, 'bow': .42}
HEAD.update({p_: .32 for p_ in ('cafe_f', 'cafe_b', 'stool_f', 'stool_b')})
HEAD.update({p_: .32 for p_ in ('wave_f', 'wave_b', 'coffee_f', 'coffee_b', 'bag_f', 'bag_b', 'stand_b')})        # the same hair / skin / jacket recolour as a standing person
FLIPPED = ('type1', 'type2', 'staff_sit')   # mirrored to sit like the chair of the desk sheet (staff_sit faces down-right, office side)
LONG_HAIR = 1.55    # person b's hair reaches this much further down
# Jacket grey: seated poses have a grey chair too, so they use a smaller area and brighter grey only.
JACKET_Y = {'type_pc': (.1, .7), 'type_pc2': (.1, .7), 'read_pc': (.1, .7), 'staff_sit': (.24, .60), 'type1': (.1, .7), 'type2': (.1, .7), 'raise': (.05, .7), 'sofa': (.28, .66),}
JACKET_X0 = {'type_pc': .25, 'type_pc2': .25, 'read_pc': .25, 'sofa': .3, 'type1': .25, 'type2': .25}                  # the sofa's back and arms are the same grey: only the torso box
JACKET_X1 = {'type_pc': .72, 'type_pc2': .72, 'read_pc': .72, 'type1': .68, 'type2': .68, 'sofa': .72}   # the keyboard lies to the right of the typing sleeves
SEATED = set(JACKET_Y)
JACKET_Y.update({p_: (.08, .86) for p_ in ('walk_dl1', 'walk_dl2', 'walk_ur1', 'walk_ur2')})   # ★23: the walking frames recolour the cardigan only (the trousers' light folds are grey too and took the jacket colour)
JACKET_Y.update({p_: (.1, .62) for p_ in ('cafe_f', 'cafe_b', 'stool_f', 'stool_b')})    # the cardigan only (not the dark trousers below)

JACKETS = ['#7c4dff', '#2f7cf6', '#12a594', '#e0457b', '#f2711c', '#1f9d55', '#c9971c', '#5b5bd6',      # ★16-10: no two near-alike colours (the red and the dark orange were dropped)
           '#64748b', '#8b5e3c', '#0ea5e9', '#84cc16', '#e7e0d2', '#2b3a55']
HAIRS = ['#2b1d14', '#4a2c17', '#6b3f1d', '#a0522d', '#d4a64a', '#e8d08a', '#8a8a8a', '#111111', '#7a2e1f']
SKINS = ['#f7d6b8', '#f2c9a0', '#e6b48a', '#cf9468', '#a8704a', '#7a4b2e']


# ---------------------------------------------------------------- finding pieces

def _grow(mask, steps):
    for _ in range(steps):
        g = mask.copy()
        g[1:] |= mask[:-1]; g[:-1] |= mask[1:]; g[:, 1:] |= mask[:, :-1]; g[:, :-1] |= mask[:, 1:]
        mask = g
    return mask


def label(mask):
    """Connected cell lists (4-neighbourhood) of a boolean mask (OpenCV when it is there: 50 times faster; else a flood fill)."""
    try:
        import cv2
        n, lab = cv2.connectedComponents(np.ascontiguousarray(mask, dtype=np.uint8), connectivity=4)
        pts = np.argwhere(lab > 0)
        if not len(pts):
            return []
        ids = lab[pts[:, 0], pts[:, 1]]
        order = np.argsort(ids, kind='stable')
        pts, ids = pts[order], ids[order]
        cuts = np.nonzero(np.diff(ids))[0] + 1
        return [[(int(y), int(x)) for y, x in grp] for grp in np.split(pts, cuts)]
    except Exception:
        pass
    seen = np.zeros_like(mask)
    out = []
    for sy, sx in zip(*np.nonzero(mask)):
        if seen[sy, sx]:
            continue
        stack, cells = [(sy, sx)], []
        seen[sy, sx] = True
        while stack:
            y, x = stack.pop()
            cells.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        out.append(cells)
    return out


def components(alpha, gap):
    """Boxes (x0, y0, x1, y1 in px) of the pieces of a sheet, in reading order."""
    h, w = alpha.shape
    small = (alpha[:h // CELL * CELL, :w // CELL * CELL] > ALPHA_MIN).reshape(h // CELL, CELL, w // CELL, CELL).any(axis=(1, 3))
    boxes = []
    for cells in label(_grow(small, gap)):
        if sum(small[y, x] for y, x in cells) < MIN_CELLS:
            continue
        ys, xs = zip(*cells)
        boxes.append((min(xs) * CELL, min(ys) * CELL, (max(xs) + 1) * CELL, (max(ys) + 1) * CELL))
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows, row = [], boxes[:1]
    for b in boxes[1:]:
        if abs((b[1] + b[3]) / 2 - sum((r[1] + r[3]) / 2 for r in row) / len(row)) < 140:
            row.append(b)
        else:
            rows.append(row)
            row = [b]
    rows.append(row)
    return [b for r in rows for b in sorted(r, key=lambda b: b[0])]


def office_settings():
    """config.json "office" (the settings object; "officeSettings" is the older name)."""
    try:
        cfg = json.loads((APP_HOME / 'mods' / 'hakoniwa' / 'config.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    got = cfg.get('office') if isinstance(cfg.get('office'), dict) else cfg.get('officeSettings')
    return got if isinstance(got, dict) else {}


def colors_cfg():
    """office.colors: people (list / generate), chair and floor (HEX or null). States and ui are for the mod."""
    c = office_settings().get('colors')
    return c if isinstance(c, dict) else {}


def sheet_files():
    """{room, desk, people: Path of the sheet}. Default: the concepts folder. config.json office.sheets
    overrides it: a folder (str), or {"dir": folder, "room"|"desk"|"people": file name}."""
    names = {'room': ROOM_SHEET[0], 'desk': DESK_SHEET[0], 'people': PEOPLE_SHEET[0], 'doze': DOZE_SHEET[0],
             'fronts': FRONTS_SHEET[0], 'windows': WINDOWS_SHEET[0], 'win_front1': WIN_FRONT_SHEET1[0], 'win_front2': WIN_FRONT_SHEET2[0],
             'fa': FA_SHEET[0], 'fa_people': FA_PEOPLE_SHEET[0], 'walk_a': WALK_SHEETS['a'], 'walk_b': WALK_SHEETS['b'],
             'desk_props': DESKPROP_SHEET[0], 'people_props': PEOPLEPROP_SHEET[0], 'moon': MOON_SHEET, 'walk8v2': WALK8V2_SHEET, 'cafe': CAFE_SHEET, 'window2': WINDOW2_SHEET, 'board': BOARD_SHEET, 'weather': WEATHER_SHEET, 'entrance': ENTRANCE_SHEET[0], 'poles': POLE_SHEET[0], 'store': STORE_SHEET[0], 'equip': EQUIP_SHEET[0], 'floors': FLOOR_SHEET, 'walk8_a': WALK8_SHEETS['a'], 'walk8_b': WALK8_SHEETS['b'], 'life': LIFE_SHEET[0], 'bird': BIRD_SHEET[0], **{f'out_{k}': v for k, v in OUTSIDE_SHEETS.items()},
             **{f'iso_{p_}_{s_}': f'{ISO_DIR}/{v_}_{s_}.png' for p_, v_ in ISO_EQUIP.items() for s_ in 'LR'}, 'iso_desk': f'{ISO_DIR}/desk_R.png',
             **{f'iso_{p_}_{s_}': f'{PLANT_ISO_DIR}/{v_}_{s_}.png' for p_, v_ in PLANT_ISO.items() for s_ in 'LR'},
             **{f'iso_{p_}_{s_}': f'{d_}/{v_}_{s_}.png' for p_, (d_, v_) in DECO_ISO.items() for s_ in 'LR'}}
    base = BUNDLED  # the sheets shipped with the code (★108: every sheet read is bundled; the old fallback to a personal concepts folder is gone)
    try:
        cfg = json.loads((APP_HOME / 'mods' / 'hakoniwa' / 'config.json').read_text(encoding='utf-8'))
        given = (cfg.get('office') if isinstance(cfg.get('office'), dict) else cfg.get('officeSettings') or {}).get('sheets')
    except (OSError, ValueError, AttributeError):
        given = None
    if isinstance(given, str):
        base = Path(given).expanduser()
    elif isinstance(given, dict):
        base = Path(given.get('dir', base)).expanduser()
        names.update({k: v for k, v in given.items() if k in names})
    found = {}
    for k, v in names.items():
        found[k] = base / v if (base / v).is_file() or not (BUNDLED / v).is_file() else BUNDLED / v   # else the bundled copy
    return found


_HASH = []


def sheet_hash():
    """Short hash of the three sheets' bytes: the cut-outs are redone only when this changes."""
    if not _HASH:
        h = hashlib.sha1()
        h.update(json.dumps({k: colors_cfg().get(k) for k in ('people', 'chair', 'floor')} | {'walk': office_settings().get('walk')}, sort_keys=True).encode())
        for key, path in sorted(sheet_files().items()):
            if path.is_file():
                h.update(key.encode() + path.read_bytes())
        _HASH.append(h.hexdigest()[:16])
    return _HASH[0]


def cut(sheet, names, gap, clean=True):
    """{name: RGBA image trimmed to the piece}; the count must match (a changed sheet fails loudly)."""
    img = Image.open(sheet).convert('RGBA')
    boxes = components(np.array(img.getchannel('A')), gap)
    if len(boxes) != len(names):
        raise SystemExit(f'{sheet}: {len(boxes)} pieces found, expected {len(names)} - the layout changed')
    pieces = {}
    for name, box in zip(names, boxes):
        part = clean_edges(img.crop(box)) if clean else img.crop(box)
        ys, xs = np.nonzero(np.array(part.getchannel('A')) > ALPHA_MIN)
        pieces[name] = part.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    return pieces


def standing_hold(raw_hold, stand):
    """A standing person holding a paper: the `stand` picture with the paper cut out of the seated `hold`
    picture (taken before clean_edges, which would erase its white) laid behind the right hand.
    Returns None if the paper or the hand cannot be found."""
    a = np.array(raw_hold)
    h, w = a.shape[:2]
    region = np.zeros((h, w), bool)
    region[:int(h * .24), int(w * .62):] = True
    ys, xs = np.nonzero(region & (a[..., 3] > 200))
    if len(xs) < 300:
        return None
    paper = raw_hold.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    sa = np.array(stand).astype(np.float32)
    sh_, sw = sa.shape[:2]
    rgb = sa[..., :3] / 255
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) % 360
    skin = (hue > 5) & (hue < 42) & (sat > .12) & (sat < .62) & (mx >= .78) & (sa[..., 3] > 200)
    skin[:int(sh_ * .45)] = False
    skin[int(sh_ * .78):] = False
    skin[:, :int(sw * .55)] = False
    hy, hx = np.nonzero(skin)
    if len(hx) < 40:
        return None
    hand_x, hand_top = hx.mean(), hy.min()
    left = int(hand_x - paper.width * .3)
    top = int(hand_top - paper.height + 6)
    over = max(0, left + paper.width - sw)              # paper sticks out to the right: pad the left by the same
    pad_top = max(0, -top)
    out = Image.new('RGBA', (sw + 2 * over, sh_ + pad_top), (0, 0, 0, 0))
    out.alpha_composite(paper, (over + left, top + pad_top))   # behind the body, so the fingers are in front
    out.alpha_composite(stand, (over, pad_top))
    return out


def _grow4(mask):
    g = mask.copy()
    g[1:] |= mask[:-1]; g[:-1] |= mask[1:]; g[:, 1:] |= mask[:, :-1]; g[:, :-1] |= mask[:, 1:]
    return g


def white_rim_off(img, light=200, grey=25):
    """★69: the pale dots left outside the dark outline where the white background was taken off: pale, grey pixels reached from the transparent
    outside through pale pixels only (the outline stops the walk, so the machines' own pale faces inside it stay). Returns the picture."""
    a = np.array(img.convert('RGBA'))
    rgb = a[..., :3].astype(int)
    pale = (a[..., 3] > ALPHA_MIN) & (rgb.min(axis=2) >= light) & (rgb.max(axis=2) - rgb.min(axis=2) < grey)
    clear = a[..., 3] <= ALPHA_MIN
    reach = np.zeros_like(pale)
    for _ in range(6):                                        # at most a few pixels thick
        nxt = _grow4(clear | reach) & pale
        if (nxt == reach).all():
            break
        reach = nxt
    a[reach, 3] = 0
    return Image.fromarray(a, 'RGBA')


def cut_pair(sheet, names, gap):
    """{name: (cleaned, raw)} cut to the same box (the raw one keeps the whites that clean_edges removes)."""
    img = Image.open(sheet).convert('RGBA')
    boxes = components(np.array(img.getchannel('A')), gap)
    out = {}
    for name, box in zip(names, boxes):
        raw = img.crop(box)
        clean = clean_edges(raw)
        ys, xs = np.nonzero(np.array(raw.getchannel('A')) > ALPHA_MIN)
        bb = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        out[name] = (clean.crop(bb), raw.crop(bb))
    return out


def refill_object(clean, raw, rows_from=0.0):
    """White objects (a pot, a sheet of paper) lose their pale faces to clean_edges when no dark outline closes them.
    Everything inside the hull of the object's dark outline gets its original pixels back; the pale floor shadow lies
    outside that hull and stays transparent."""
    c, r = np.array(clean), np.array(raw)
    lum = (299 * r[..., 0].astype(int) + 587 * r[..., 1].astype(int) + 114 * r[..., 2].astype(int)) // 1000
    mx, mn = r[..., :3].max(axis=2).astype(int), r[..., :3].min(axis=2).astype(int)
    dark = (r[..., 3] > ALPHA_MIN) & ((lum < 150) | (mx - mn > 70))
    dark[:int(dark.shape[0] * rows_from)] = False
    ys, xs = np.nonzero(dark)
    if len(xs) < 3:
        return clean
    hm = Image.new('L', (c.shape[1], c.shape[0]), 0)
    ImageDraw.Draw(hm).polygon(hull([(int(x), int(y)) for y, x in zip(ys, xs)]), fill=255)
    back = (np.array(hm) > 0) & (c[..., 3] <= ALPHA_MIN) & (r[..., 3] > ALPHA_MIN)
    c[back] = r[back]
    c[back, 3] = 255
    return Image.fromarray(c, 'RGBA')


def fill_holes(img):
    """Transparent pixels fully enclosed by the picture become opaque, with the colour of their nearest solid neighbour
    (a hole inside a shirt or a screen would show the floor through it)."""
    a = np.array(img.convert('RGBA'))
    solid = a[..., 3] > ALPHA_MIN
    outside = ~solid
    reach = np.zeros_like(solid)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = outside[0, :], outside[-1, :], outside[:, 0], outside[:, -1]
    while True:
        nxt = _grow4(reach) & outside
        if (nxt == reach).all():
            break
        reach = nxt
    holes = outside & ~reach
    if not holes.any():
        return img
    for _ in range(20):
        todo = holes & (a[..., 3] <= ALPHA_MIN)
        if not todo.any():
            break
        ys, xs = np.nonzero(todo)
        for y, x in zip(ys, xs):
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < a.shape[0] and 0 <= nx < a.shape[1] and a[ny, nx, 3] > ALPHA_MIN and not holes[ny, nx]:
                    a[y, x] = a[ny, nx]
                    a[y, x, 3] = 255
                    break
        holes = holes & (a[..., 3] <= ALPHA_MIN)
    return Image.fromarray(a, 'RGBA')


def count_holes(img):
    a = np.array(img.convert('RGBA'))
    outside = a[..., 3] <= 8                 # fully clear pixels (frosted glass is semi-transparent on purpose)
    reach = np.zeros_like(outside)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = outside[0, :], outside[-1, :], outside[:, 0], outside[:, -1]
    while True:
        nxt = _grow4(reach) & outside
        if (nxt == reach).all():
            break
        reach = nxt
    return int((outside & ~reach).sum())


def clean_edges(part):
    """Make the cut-out clean on any background (the sheets were matted on white):
    1. whitish / pale-grey pixels connected to the outside (halos, the pale ground shadow under sofas and
       chairs) become transparent. Parts with an outline (a white pot, a shirt) are not reached.
    2. the remaining pale fringe on the edge is peeled for 2 pixels, and half-transparent pale pixels go."""
    px = np.array(part).astype(np.float32)
    a = px[..., 3]
    mx, mn = px[..., :3].max(axis=2), px[..., :3].min(axis=2)
    lum = 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    solid = a > ALPHA_MIN
    pale = solid & (lum > 190) & (sat < .14)    # also the faint grey ground shadow under feet
    outside = np.pad(~solid, 1, constant_values=True)[1:-1, 1:-1]
    region = outside.copy()
    while True:
        nxt = region | (_grow4(region) & pale)
        if (nxt == region).all():
            break
        region = nxt
    solid &= ~(region & pale)
    for _ in range(2):
        edge = solid & _grow4(~solid)
        solid &= ~(edge & (lum > 198) & (sat < .14))
    solid &= ~((a < 200) & (lum > 190) & (sat < .14))
    px[..., 3] = np.where(solid, a, 0)
    return Image.fromarray(px.astype(np.uint8), 'RGBA')


_SHEETS = {}


def _is_hex(v):
    return isinstance(v, str) and len(v) == 7 and v[0] == '#' and all(c in '0123456789abcdefABCDEF' for c in v[1:])


def _isolate_main(img):
    """Keep only the largest connected component (drops neighbouring row corners or stray specks) and trim to its box."""
    a = np.array(img).copy()
    solid = a[..., 3] > ALPHA_MIN
    comps = label(solid)
    if not comps:
        return img
    main = max(comps, key=len)
    keep = np.zeros_like(solid)
    for y, x in main:
        keep[y, x] = True
    a[~keep, 3] = 0
    ys, xs = np.nonzero(keep)
    return Image.fromarray(a, 'RGBA').crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def _peel_1px(img):
    """Peel 1 px around the outer silhouette edge (removes the 1 px white JPEG fringe left by alpha extraction)."""
    a = np.array(img).copy()
    solid = a[..., 3] > ALPHA_MIN
    solid &= ~(solid & _grow4(~solid))
    a[..., 3] = np.where(solid, 255, 0)
    ys, xs = np.nonzero(solid)
    return Image.fromarray(a, 'RGBA').crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def _cut_desk_front(raw0):
    iso = _isolate_main(raw0)
    cln = clean_edges(iso)
    ref = fill_holes(refill_object(cln, iso))
    return _peel_1px(ref)


def _cut_staff_sit(raw0):
    iso = _isolate_main(raw0)
    a = np.array(iso).copy()
    h, w = a.shape[:2]
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    lum = (299 * r + 587 * g + 114 * b) // 1000
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    trapped = np.zeros_like(lum, dtype=bool)
    trapped[int(h * 0.60):, :] = (lum[int(h * 0.60):, :] > 175) & ((mx - mn)[int(h * 0.60):, :] < 36)
    trapped[int(h * 0.30):int(h * 0.50), int(w * 0.65):] = (lum[int(h * 0.30):int(h * 0.50), int(w * 0.65):] > 200) & ((mx - mn)[int(h * 0.30):int(h * 0.50), int(w * 0.65):] < 30)
    a[trapped, 3] = 0
    cln = clean_edges(Image.fromarray(a, 'RGBA'))
    return _isolate_main(_peel_1px(cln))


def _remove_back_chair_pair(empty_img, full_img, has_monitor=False):
    """Remove the blue chair protruding behind the back-left edge of the front-facing desk, keeping the exact image size (w, h)."""
    px_e = np.array(empty_img)
    r_e, g_e, b_e, al_e = (px_e[..., i].astype(int) for i in range(4))
    solid_e = al_e > ALPHA_MIN
    h_e, w_e = solid_e.shape
    blue_e = solid_e & (b_e > r_e + (32 if has_monitor else 18)) & (b_e > g_e + (18 if has_monitor else 8))
    blue_e[int(h_e * 0.46):, :] = False
    blue_e[:, int(w_e * 0.55):] = False
    bys, bxs = np.nonzero(blue_e)
    if not len(bxs):
        return empty_img, full_img
    wood_e = solid_e & (r_e > b_e + 35) & (r_e > 160)
    vals = []
    for x in range(int(bxs.min()) + (15 if has_monitor else 0), int(bxs.max()) + 20):
        wy = np.nonzero(wood_e[:, x])[0]
        if len(wy):
            vals.append(int(wy.min()) + 0.5 * x)
    c_val = float(np.median(vals)) - (2.0 if has_monitor else 0.5)
    x_min = max(100, int(bxs.min()) - 3) if has_monitor else int(bxs.min()) - 5
    outs = []
    for im in (empty_img, full_img):
        px = np.array(im).copy()
        r, g, b, al = (px[..., i].astype(int) for i in range(4))
        solid = al > ALPHA_MIN
        h, w = solid.shape
        yy, xx = np.mgrid[0:h, 0:w]
        wood = solid & (r > b + 35) & (r > 160)        # the back edge is measured on this image: the full desk is a different crop
        vals_i = [int(np.nonzero(wood[:, x])[0].min()) + 0.5 * x
                  for x in range(int(bxs.min()) + (15 if has_monitor else 0), min(w, int(bxs.max()) + 20)) if wood[:, x].any()]
        c_i = (float(np.median(vals_i)) - (2.0 if has_monitor else 0.5)) if vals_i else c_val + (h - h_e)
        above_wood = (yy + 0.5 * xx) < c_i
        in_x = (xx >= x_min) & (xx <= int(bxs.max()) + 18 + max(0, w - w_e))   # the wider full desk has the chair further right
        if has_monitor:
            a_mon = float(np.median([np.nonzero(solid[:, x])[0].min() - 0.5 * x for x in range(60, 110)]))
            mon_box = (xx <= 127) & (yy >= np.floor(a_mon + 0.5 * xx))
            in_x &= ~mon_box
        red_light = (r > b + 40) & (r > 140)
        white_paper = (r > 185) & (g > 185) & (b > 185) & (xx > int(bxs.max()) - 5)
        chair_m = solid & above_wood & in_x & ~red_light & ~white_paper
        px[chair_m, 3] = 0
        comps = label(px[..., 3] > ALPHA_MIN)
        if comps:
            main = max(comps, key=len)
            keep = np.zeros_like(solid)
            for y_, x_ in main:
                keep[y_, x_] = True
            px[~keep, 3] = 0
        outs.append(fill_holes(Image.fromarray(px, 'RGBA')))
    return outs[0], outs[1]


def paper_in_hand(canvas_img):
    """★88-2 `coffee_b` (standing, back to us, a cup in the right hand) with a sheet of paper where the cup is. The cup box is found from the figure's
    own box (the cup sits at the right edge, about a third of the way down); the sheet is a bit larger so nothing of the cup shows."""
    from PIL import ImageDraw
    im = canvas_img.copy()
    ys, xs = np.where(np.array(im)[..., 3] > ALPHA_MIN)
    if not len(ys):
        return im
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    fw, fh = x1 - x0 + 1, y1 - y0 + 1
    cx, cy = x0 + fw * 0.865, y0 + fh * 0.375           # where the cup is (measured on the sheet: 73-100% across, 32-42% down)
    w, h = fw * 0.34, fh * 0.17
    sl = h * 0.18                                         # the isometric slant: the right edge sits a little higher
    pts = [(cx - w / 2, cy - h / 2 + sl), (cx + w / 2, cy - h / 2 - sl), (cx + w / 2, cy + h / 2 - sl), (cx - w / 2, cy + h / 2 + sl)]
    S = 4                                                 # drawn 4x and shrunk: smooth edges
    big = Image.new('RGBA', (im.width * S, im.height * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.polygon([(x * S, y * S) for x, y in pts], fill=(247, 246, 240, 255))
    d.line([(x * S, y * S) for x, y in pts + [pts[0]]], fill=(32, 32, 36, 255), width=max(2, int(1.6 * S)))
    for i in range(1, 5):                                 # grey lines of text
        t = i / 5.0
        l = (pts[0][0] + (pts[3][0] - pts[0][0]) * t + w * .12, pts[0][1] + (pts[3][1] - pts[0][1]) * t)
        r = (pts[1][0] + (pts[2][0] - pts[1][0]) * t - w * .12, pts[1][1] + (pts[2][1] - pts[1][1]) * t)
        d.line([(l[0] * S, l[1] * S), (r[0] * S, r[1] * S)], fill=(150, 150, 158, 255), width=max(1, int(S * .9)))
    out = im.copy()
    out.alpha_composite(big.resize(im.size, Image.LANCZOS))
    return out


def stand_back_from(bag, cof):
    """Standing with the back to us (up-right), no prop: no sheet has it, so it is put together from the people-prop sheet. Above the
    cardigan's hem and the right hand: "back, with the bag" (the arm hangs down); below: "back, with coffee" (both legs are seen)."""
    A, C = np.array(bag), np.array(cof)
    ha, wa = A.shape[:2]
    hc, wc = C.shape[:2]
    best = None
    ma = A[:85, :, 3] > ALPHA_MIN                     # line the two up on the hair and the shoulders (above the cup)
    mc = C[:85, :, 3] > ALPHA_MIN
    for dy in range(-6, 7):
        for dx in range(-12, 13):
            W_, H_ = max(wa, wc) + 30, 130
            ca, cc = np.zeros((H_, W_), bool), np.zeros((H_, W_), bool)
            ca[10:95, 15:15 + wa] = ma
            y0 = 10 + dy + (ha - hc)
            if y0 < 0 or y0 + 85 > H_:
                continue
            cc[y0:y0 + 85, 15 + dx:15 + dx + wc] = mc
            sc = int((ca & cc).sum()) - int((ca ^ cc).sum())
            if best is None or sc > best[0]:
                best = (sc, dx, dy)
    _, dx, dy = best
    oy = dy + (ha - hc)
    x0 = -min(0, dx)
    W, H = max(wa, dx + wc) + x0, ha
    Ab, Cc = np.zeros((H, W, 4), np.uint8), np.zeros((H, W, 4), np.uint8)
    Ab[:, x0:x0 + wa] = A
    ys, ye = max(0, oy), min(H, oy + hc)
    Cc[ys:ye, x0 + dx:x0 + dx + wc] = C[ys - oy:ye - oy]
    r, g, b = (Ab[..., i].astype(int) for i in range(3))
    sa = Ab[..., 3] > ALPHA_MIN
    mx, mn = Ab[..., :3].max(axis=2).astype(int), Ab[..., :3].min(axis=2).astype(int)
    rows, cols = np.arange(H)[:, None], np.arange(W)[None, :]
    grey = sa & ((mx - mn) < 24) & (r > 95) & (r < 190)
    cnt = grey.sum(axis=1)
    hem = max(y for y in range(int(H * .75)) if cnt[y] > W * .25) + 2     # just below the cardigan's ribbed hem
    R = np.concatenate([Ab[:hem], Cc[hem:]])
    skin = sa & (r > 200) & (r > b + 40) & ((mx - mn) > 40) & (b > 95) & (g > 150)   # (the handle's brass rivets are yellower)
    left = skin & (cols < W * .35) & (rows > hem - 30) & (rows < hem + 45)
    if left.any():                                     # the left hand straddles the seam: whole from the bag picture
        ly, lx = np.nonzero(_grow(left, 3))
        R[max(hem, ly.min()):ly.max() + 1, :lx.max() + 1] = Ab[max(hem, ly.min()):ly.max() + 1, :lx.max() + 1]
    skin &= (cols > W * .45) & (rows > hem - 25) & (rows < hem + 45)
    if skin.any():                                     # the right fist from the bag picture, without the handle's leather and brass
        lum = (299 * r + 587 * g + 114 * b) // 1000
        loose = sa & (r > 170) & (r > b + 40) & (b > 80)
        handle = ((lum < 120) & (lum >= 45) & (r > b + 12)) | ((b < 95) & (r > 150))
        hand = _grow(skin | (loose & _grow(skin, 3)), 2) & sa & (rows <= int(np.nonzero(skin.any(axis=1))[0].max()) + 2) & ~handle
        R[hand] = Ab[hand]
        R[_grow(hand, 1) & ~(R[..., 3] > ALPHA_MIN) & (rows > hem)] = (22, 18, 18, 255)   # close the fist's outline where the handle was
    comps = label(R[..., 3] > ALPHA_MIN)
    keep = np.zeros((H, W), bool)
    for y_, x_ in max(comps, key=len):
        keep[y_, x_] = True
    R[~keep, 3] = 0
    im = fill_holes(Image.fromarray(R, 'RGBA'))
    ys_, xs_ = np.nonzero(np.array(im)[..., 3] > ALPHA_MIN)
    return im.crop((int(xs_.min()), int(ys_.min()), int(xs_.max()) + 1, int(ys_.max()) + 1))


def apply_scene_colors(pieces):
    """office.colors.chair / floor: HEX recolours the chair seats (desks, chairs, seated people) and the
    wooden floor; null leaves the sheet as it is. The brightness pattern is kept (see _paint)."""
    cfg = colors_cfg()
    chair, floor = cfg.get('chair'), cfg.get('floor')
    if _is_hex(chair):
        seated = ('type1', 'type2', 'raise', 'hold_seated') + tuple(PC_POSES) + tuple(STAFF_POSES)
        names = ['chair', 'chair_empty', 'desk_on', 'desk_off_sheet', 'desk_alert'] + [n for n in pieces if n.startswith('win_')]
        names += [f'{who}_{p}' for who in ('a', 'b') for p in seated]
        for n in names:
            if n not in pieces:
                continue
            px = np.array(pieces[n]).astype(np.float32)
            h = px.shape[0]
            blue = (px[..., 2] > 110) & (px[..., 2] - px[..., 0] > 60) & (px[..., 3] > ALPHA_MIN)
            blue[:int(h * .45)] = False          # below the monitors: the seat, not the screens
            _paint(px, blue, chair)
            pieces[n] = Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), 'RGBA')
    if _is_hex(floor) and 'floor_tile' in pieces:
        px = np.array(pieces['floor_tile']).astype(np.float32)
        _paint(px, px[..., 3] > ALPHA_MIN, floor)
        pieces['floor_tile'] = Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), 'RGBA')


def _sheets_build():
    if not _SHEETS:
        files = sheet_files()
        for key, spec in (('room', ROOM_SHEET), ('desk', DESK_SHEET), ('people', PEOPLE_SHEET), ('doze', DOZE_SHEET), ('fronts', FRONTS_SHEET), ('windows', WINDOWS_SHEET)):
            if key in ('doze', 'fronts', 'windows') and not files[key].is_file():
                continue                                       # an older install without the dozing sheet: doze = sofa
            _SHEETS.update(cut(files[key], spec[1], spec[2]))
        if files['win_front1'].is_file():                      # ★26-4: approval desk seen from queue side (row 1) + seated staff people (row 2)
            raw1 = cut(files['win_front1'], WIN_FRONT_SHEET1[1], WIN_FRONT_SHEET1[2], clean=False)
            for n_ in ('win_approval_front_empty', 'win_approval_front_full'):
                _SHEETS[n_] = _cut_desk_front(raw1[n_])
            for n_ in ('a_staff_sit', 'b_staff_sit'):
                _SHEETS[n_] = _cut_staff_sit(raw1[n_])
        if files['win_front2'].is_file():                      # ★26-4: submit counter seen from queue side (row 2 of 3-row sheet; rows 1 and 3 unused)
            raw2 = cut(files['win_front2'], WIN_FRONT_SHEET2[1], WIN_FRONT_SHEET2[2], clean=False)
            for n_ in ('win_counter_front_empty', 'win_counter_front_full'):
                _SHEETS[n_] = _cut_desk_front(raw2[n_])
        for key, spec in (('fa', FA_SHEET), ('fa_people', FA_PEOPLE_SHEET)):
            if files[key].is_file():
                _SHEETS.update(cut(files[key], spec[1], spec[2]))
        pairs_r = cut_pair(files['room'], ROOM_SHEET[1], ROOM_SHEET[2])        # the reception's pale side and its pot, the bin's rim: pale faces clean_edges took
        for n_ in ('reception', 'trash'):
            if n_ in pairs_r and n_ in _SHEETS:
                _SHEETS[n_] = refill_object(*pairs_r[n_])
        if files['fa'].is_file():                            # the white pot and the paper: give their pale faces back
            pairs = cut_pair(files['fa'], FA_SHEET[1], FA_SHEET[2])
            _SHEETS['plant_fa'] = refill_object(*pairs['plant_fa'], rows_from=.45)
            _SHEETS['papers_fa'] = refill_object(*pairs['papers_fa'])
        raw_people = None
        for who in ('a', 'b'):                                 # `hold`: standing with a paper (the seated one has a chair)
            if raw_people is None:
                raw_people = cut(files['people'], PEOPLE_SHEET[1], PEOPLE_SHEET[2], clean=False)
            built = standing_hold(raw_people[f'{who}_hold'], _SHEETS[f'{who}_stand'])
            _SHEETS[f'{who}_hold_seated'] = _SHEETS[f'{who}_hold']
            _SHEETS[f'{who}_hold'] = built if built is not None else _SHEETS[f'{who}_stand']
        if 'a_front_wait' in _SHEETS:       # drawn bigger than the older people sheet: bring them to the stand picture's height
            ratio = (_SHEETS['a_stand'].height + _SHEETS['b_stand'].height) / (_SHEETS['a_front_wait'].height + _SHEETS['b_front_wait'].height)
            for n in [n for n in _SHEETS if any(n.endswith(p) for p in FRONT_POSES)]:
                im = _SHEETS[n]
                _SHEETS[n] = im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS)
        if 'win_approval_empty' in _SHEETS:  # window desks: as wide as a work desk, and turned so that the long side runs along x
            ratio = _SHEETS['desk_on'].width / _SHEETS['win_approval_empty'].width
            for n in WINDOW_PARTS:
                im = _SHEETS[n].resize((round(_SHEETS[n].width * ratio), round(_SHEETS[n].height * ratio)), Image.LANCZOS)
                _SHEETS[n] = ImageOps.mirror(im)
        if 'win_approval_front_empty' in _SHEETS:  # ★26-4: front-facing approval desk (long side runs along y, bottom-left to top-right)
            ratio = _SHEETS['desk_on'].width / _SHEETS['win_approval_front_empty'].width
            for n in ('win_approval_front_empty', 'win_approval_front_full'):
                im = _SHEETS[n]
                _SHEETS[n] = fill_holes(im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS))
            _SHEETS['win_approval_front_nochair_empty'], _SHEETS['win_approval_front_nochair_full'] = _remove_back_chair_pair(
                _SHEETS['win_approval_front_empty'], _SHEETS['win_approval_front_full'], has_monitor=True)
            _SHEETS['win_approval_front'] = _SHEETS['win_approval_front_full']
            _SHEETS['win_approval_front_nochair'] = _SHEETS['win_approval_front_nochair_full']
        if 'win_counter_front_empty' in _SHEETS:   # ★26-4: front-facing submit counter (long side runs along y, bottom-left to top-right)
            ratio = _SHEETS['desk_on'].width / _SHEETS['win_counter_front_empty'].width
            for n in ('win_counter_front_empty', 'win_counter_front_full'):
                im = _SHEETS[n]
                _SHEETS[n] = fill_holes(im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS))
            _SHEETS['win_counter_front_nochair_empty'], _SHEETS['win_counter_front_nochair_full'] = _remove_back_chair_pair(
                _SHEETS['win_counter_front_empty'], _SHEETS['win_counter_front_full'], has_monitor=False)
            _SHEETS['win_counter_front'] = _SHEETS['win_counter_front_full']
            _SHEETS['win_counter_front_nochair'] = _SHEETS['win_counter_front_nochair_full']
        if 'a_staff_sit' in _SHEETS:         # ★26-4: seated window staff brought to the typing poses' height
            ratio = (_SHEETS['a_type1'].height + _SHEETS['b_type1'].height) / (_SHEETS['a_staff_sit'].height + _SHEETS['b_staff_sit'].height)
            for n in ('a_staff_sit', 'b_staff_sit'):
                im = _SHEETS[n]
                _SHEETS[n] = im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS)
        if 'a_type_pc' in _SHEETS:           # drawn at another scale: bring the laptop poses to the size of the typing poses
            ratio = (_SHEETS['a_type1'].height + _SHEETS['b_type1'].height) / (_SHEETS['a_type_pc'].height + _SHEETS['b_type_pc'].height)
            for n in [n for n in _SHEETS if any(n.endswith(p) for p in PC_POSES)]:
                im = _SHEETS[n]
                _SHEETS[n] = fill_holes(im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS))
        if files['life'].is_file():
            _SHEETS.update(cut(files['life'], LIFE_SHEET[1], LIFE_SHEET[2]))
            if 'a_type_pc' in _SHEETS:
                _SHEETS['chair_empty'] = fit_empty_chair(_SHEETS['a_type_pc'], [_SHEETS['e_chair1'], _SHEETS['e_chair2']])
            if 'a_sofa' in _SHEETS:
                _SHEETS['armchair_empty'] = fit_empty_armchair([_SHEETS['e_arm1'], _SHEETS['e_arm2']], _SHEETS['a_sofa'])
        if files['entrance'].is_file():
            got = cut(files['entrance'], ENTRANCE_SHEET[1], ENTRANCE_SHEET[2], clean=False)      # the pale wall tops must stay (clean_edges would peel them)
            for n_, im_ in got.items():
                a_ = np.array(im_)[..., 3] > 128
                c0 = np.nonzero(a_.any(axis=0))[0].min() + 3
                ys_ = np.nonzero(a_[:, c0])[0]
                kk = ENTRANCE_END / float(ys_.max() - ys_.min())
                _SHEETS[n_] = fill_holes(im_.resize((round(im_.width * kk), round(im_.height * kk)), Image.LANCZOS))
        def _end_h(im_):
            al_ = np.array(im_)[..., 3] > 128
            c_ = np.nonzero(al_.any(axis=0))[0]
            hs_ = [int(np.nonzero(al_[:, x_])[0].max() - np.nonzero(al_[:, x_])[0].min()) for x_ in (c_.min() + 3, c_.max() - 3)]
            return sum(hs_) / 2
        if 'partition_left' in _SHEETS:                            # one height for every partition piece (the sheet drew the doorway and the corner a little bigger)
            ref_h = (_end_h(_SHEETS['partition_left']) + _end_h(_SHEETS['partition_right'])) / 2
            for n_ in ('partition_doorway', 'partition_corner'):
                if n_ in _SHEETS:
                    kk = ref_h / _end_h(_SHEETS[n_])
                    if abs(kk - 1) > .01:
                        im_ = _SHEETS[n_]
                        _SHEETS[n_] = im_.resize((round(im_.width * kk), round(im_.height * kk)), Image.LANCZOS)
        if 'wall_window_left' in _SHEETS:                          # taller outer walls, plaster-coloured; the windowless pieces and the entrance as tall
            tl = tall_window_wall(_SHEETS['wall_window_left'])
            _SHEETS['wall_tall_left'] = tl
            _SHEETS['wall_tall_right'] = ImageOps.mirror(tl)
            closed0 = _SHEETS.get('entrance_closed')
            for name in ('wall_plain', 'wall_light', 'entrance_closed', 'entrance_half', 'entrance_open'):
                if name in _SHEETS:
                    _SHEETS[name] = tall_plain_wall(_SHEETS[name], like=(closed0 if name.startswith('entrance') else None))
        for key, spec in (('store', STORE_SHEET), ('equip', EQUIP_SHEET)):
            if files[key].is_file():
                got = cut(files[key], spec[1], spec[2])
                for n_, im_ in got.items():
                    if n_ == 'equip_rack':
                        _SHEETS['_rack_leds_src'] = im_
                    _SHEETS[n_] = fill_holes(im_.resize((round(im_.width * SHEET_K), round(im_.height * SHEET_K)), Image.LANCZOS))
        for p_ in list(ISO_EQUIP) + list(DECO_ISO):            # ★69 (★89-4: and the deco things): the machines redrawn on the 2:1 isometric of the floor; _L (back on a wall rising to the right,
            fl_, fr_ = files.get(f'iso_{p_}_L'), files.get(f'iso_{p_}_R')     # front +x) replaces the old cut-out, _R (back on a wall falling to the right, front +y) its mirror
            if fl_ and fr_ and fl_.is_file() and fr_.is_file():
                for key_, f_ in ((p_, fl_), (f'_isoR_{p_}', fr_)):
                    im_ = fill_holes(white_rim_off(Image.open(f_).convert('RGBA')))
                    _SHEETS[key_] = im_.resize((round(im_.width * ISO_K), round(im_.height * ISO_K)), Image.LANCZOS)
        for p_ in DECO_ISO:                                    # ★100-1 a part with one facing only (_L): no _R, never mirrored
            fl_, fr_ = files.get(f'iso_{p_}_L'), files.get(f'iso_{p_}_R')
            if fl_ and fl_.is_file() and not (fr_ and fr_.is_file()):
                im_ = fill_holes(white_rim_off(Image.open(fl_).convert('RGBA')))
                _SHEETS[p_] = im_.resize((round(im_.width * ISO_K), round(im_.height * ISO_K)), Image.LANCZOS)
        for p_ in PLANT_ISO:                                   # ★75-3: five more plants on the 2:1 isometric (their leaves' gaps stay clear: no fill_holes)
            fl_, fr_ = files.get(f'iso_{p_}_L'), files.get(f'iso_{p_}_R')
            if fl_ and fr_ and fl_.is_file() and fr_.is_file():
                for key_, f_ in ((p_, fl_), (f'_isoR_{p_}', fr_)):
                    im_ = white_rim_off(Image.open(f_).convert('RGBA'))
                    _SHEETS[key_] = im_.resize((round(im_.width * PLANT_ISO_K), round(im_.height * PLANT_ISO_K)), Image.LANCZOS)
        if files.get('iso_desk') and files['iso_desk'].is_file():   # ★70-1: the one-top desk (desk_R: seat side down-left), scaled in parts() (desk_iso)
            _SHEETS['_iso_desk'] = Image.open(files['iso_desk']).convert('RGBA')
        if files['poles'].is_file():                           # cut without clean_edges (the sheet is already transparent: the sign's white face stays), then scaled
            for n_, im_ in cut(files['poles'], POLE_SHEET[1], POLE_SHEET[2], clean=False).items():
                k_ = SIGN_K if n_ == 'sign_board' else POLE_K
                _SHEETS[n_] = im_.resize((max(1, round(im_.width * k_)), max(1, round(im_.height * k_))), Image.LANCZOS)
        if files['desk_props'].is_file():
            pairs_d = cut_pair(files['desk_props'], DESKPROP_SHEET[1], DESKPROP_SHEET[2])      # white paper, boxes, cans, the pizza box: clean_edges takes their pale faces, give them back
            for n_, im_ in {n: refill_object(*pairs_d[n]) for n in pairs_d}.items():
                _SHEETS[n_] = im_.resize((max(1, round(im_.width * DESK_K)), max(1, round(im_.height * DESK_K))), Image.LANCZOS)
        if files['people_props'].is_file():
            got = cut(files['people_props'], PEOPLEPROP_SHEET[1], PEOPLEPROP_SHEET[2])
            for who in ('a', 'b'):                                 # the same height as the standing picture of that person
                k_ = _SHEETS[f'{who}_stand'].height / got[f'{who}_wave_f'].height
                for p_ in PROP_POSES:
                    im_ = got[f'{who}_{p_}']
                    _SHEETS[f'{who}_{p_}'] = im_.resize((max(1, round(im_.width * k_)), max(1, round(im_.height * k_))), Image.LANCZOS)
                _SHEETS[f'{who}_stand_b'] = stand_back_from(_SHEETS[f'{who}_bag_b'], _SHEETS[f'{who}_coffee_b'])   # standing, back to us
            for m_ in MARKS:
                im_ = got[f'mark_{m_}']
                _SHEETS[f'mark_{m_}'] = im_.resize((max(1, round(im_.width * MARK_H / im_.height)), MARK_H), Image.LANCZOS)
        if files['cafe'].is_file():
            got = cut(files['cafe'], [f'{who}_{p_}' for who in ('a', 'b') for p_ in CAFE_POSES] + CAFE_ITEMS, 2, clean=False)
            for n_ in CAFE_ITEMS:                                            # furniture: the white seen between the legs and slats is background, not paint
                ga = np.array(got[n_])
                pale = (ga[..., :3].min(axis=2) >= 236) & (ga[..., 3] > 0)
                ga[pale, 3] = 0
                got[n_] = clean_edges(Image.fromarray(ga, 'RGBA'))
            for n_ in [n for n in got if n not in CAFE_ITEMS]:
                got[n_] = clean_edges(got[n_])
            kc = _SHEETS['a_type1'].height / got['a_cafe_f'].height          # a seated person at the cafe as big as one at a desk
            for n_, im_ in got.items():
                _SHEETS[n_] = im_.resize((max(1, round(im_.width * kc)), max(1, round(im_.height * kc))), Image.LANCZOS)
        if files['window2'].is_file():
            _SHEETS.update(cut_window2(files['window2']))
        if files['bird'].is_file():
            _SHEETS.update(cut(files['bird'], BIRD_SHEET[1], BIRD_SHEET[2], clean=False))
        apply_scene_colors(_SHEETS)
        # the dozing sheet was drawn bigger: bring its armchairs to the size of the sofa pose's (same picture scale)
        dz = [n for n in _SHEETS if '_doze' in n]
        if dz:
            ratio = (_SHEETS['a_sofa'].width + _SHEETS['b_sofa'].width) / (_SHEETS['a_doze1'].width + _SHEETS['b_doze1'].width)
            for n in dz:
                im = _SHEETS[n]
                _SHEETS[n] = im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS)
    return _SHEETS


def sheets():
    """The cut-out pieces of all the sheets. Making them takes 10-20 s, so they are kept on disk (OUT/pieces/<version>-<sheet hash>/): a new
    process reads them back in about a second. Written piece by piece into a folder of its own, the index last: a run that is stopped leaves
    nothing half-done."""
    if _SHEETS:
        return _SHEETS
    d = OUT / 'pieces' / f'{VERSION}-{sheet_hash()}'
    index = d / 'index.json'
    try:
        modes = json.loads(index.read_text(encoding='utf-8'))
        for name, mode in modes.items():
            _SHEETS[name] = Image.open(d / f'{name}.png').convert(mode)
        return _SHEETS
    except (OSError, ValueError, KeyError):
        _SHEETS.clear()
    _sheets_build()
    try:
        tmp = d.with_name(d.name + f'.tmp{os.getpid()}')
        tmp.mkdir(parents=True, exist_ok=True)
        modes = {}
        for name, im in _SHEETS.items():
            if isinstance(im, Image.Image):
                im.save(tmp / f'{name}.png', compress_level=1)
                modes[name] = im.mode
        (tmp / 'index.json').write_text(json.dumps(modes), encoding='utf-8')
        try:
            os.replace(tmp, d)                                  # a finished folder appears at once
        except OSError:
            shutil.rmtree(tmp, ignore_errors=True)              # somebody else was quicker
        for old in (OUT / 'pieces').glob('*'):                  # the pieces of other versions are no use any more
            if old.name != d.name and not old.name.startswith(d.name + '.tmp'):
                shutil.rmtree(old, ignore_errors=True)
    except OSError:
        pass
    return _SHEETS


def write_png(img, folder, stem):
    """Save under OUT with a content hash in the name (of the pixels: nothing is encoded when the file is already there); returns the path
    relative to the app folder."""
    h = hashlib.sha1(f'{img.mode}{img.size}'.encode() + img.tobytes()).hexdigest()[:10]
    path = OUT / folder / f'{stem}-{h}.png'
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
    return path.relative_to(APP_HOME).as_posix()


def write_gif(rel_pngs, folder, stem, ms=120):
    """Frames (paths relative to the app folder) -> one animated GIF with a transparent index. image() plays it by itself
    (animated GIF works in Herdr App with 1-bit transparency; animated WebP loses its transparency, APNG does not play).
    All frames share one palette, so the colours do not flicker. Returns the path relative to the app folder."""
    return gif_from_frames([Image.open(APP_HOME / r).convert('RGBA') for r in rel_pngs], folder, stem, ms)


def gif_from_frames(frames, folder, stem, ms=120):
    w, h = frames[0].size
    sheet = Image.new('RGB', (w * len(frames), h), (0, 0, 0))
    for i, f in enumerate(frames):
        flat = Image.new('RGB', f.size, (0, 0, 0))
        flat.paste(f.convert('RGB'), mask=f.getchannel('A').point(lambda v: 255 if v >= 128 else 0))
        sheet.paste(flat, (i * w, 0))
    pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = []
    for f in frames:
        q = f.convert('RGB').quantize(palette=pal, dither=Image.Dither.NONE)
        q.paste(255, f.getchannel('A').point(lambda v: 255 if v < 128 else 0))   # index 255: transparent
        out.append(q)
    buf = io.BytesIO()
    out[0].save(buf, 'GIF', save_all=True, append_images=out[1:], duration=ms, loop=0, transparency=255, disposal=2)
    name = f'{stem}-{hashlib.sha1(buf.getvalue()).hexdigest()[:10]}.gif'
    path = OUT / folder / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(buf.getvalue())
    return path.relative_to(APP_HOME).as_posix()


# ---------------------------------------------------------------- the desk and its lit screens

def hull(points):
    """Convex hull (Andrew's monotone chain) of (x, y) points."""
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out[:-1]
    return half(pts) + half(pts[::-1])


def screen_masks(desk):
    """Polygon masks of the two monitor faces of the lit desk: the two biggest navy areas in the
    upper half (convex hulls, so the coloured code lines inside are part of the face)."""
    px = np.array(desk).astype(int)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    navy = (b - r > 28) & (b > g + 8) & (px[..., 3] > ALPHA_MIN)
    navy[int(desk.height * .5):] = False
    found = sorted(label(navy), key=len, reverse=True)[:2]
    masks = []
    for cells in found:
        poly = hull([(x, y) for y, x in cells])
        m = Image.new('L', desk.size, 0)
        ImageDraw.Draw(m).polygon(poly, fill=255)
        masks.append(np.array(m) > 0)
    if len(masks) != 2:
        raise SystemExit('desk_on: could not find the two monitor faces')
    return masks


def desk_parts(desk_on):
    """desk_off (dark screens) and two lit-screen frames, all aligned to desk_on's pixels."""
    both = np.logical_or(*screen_masks(desk_on))
    on = np.array(desk_on)
    off = on.copy()
    rows = np.linspace(1, 0, both.shape[0])[:, None] * np.ones(both.shape)    # slightly lighter at the top
    dark = np.stack([24 + 8 * rows, 28 + 10 * rows, 40 + 14 * rows], axis=-1)
    off[both, :3] = dark[both].astype(np.uint8)
    ys, xs = np.nonzero(both)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    frames = []
    for shift in (0, 4):        # frame 2: the content scrolled up a few pixels, hue turned a little
        lit = on[y0:y1, x0:x1].copy()
        mask = both[y0:y1, x0:x1]
        if shift:
            lit = np.roll(lit, -shift, axis=0)
            hsv = np.array([colorsys.rgb_to_hsv(*(q / 255)) for q in lit[..., :3].reshape(-1, 3)])
            hsv[:, 0] = (hsv[:, 0] + .03) % 1
            lit[..., :3] = (np.array([colorsys.hsv_to_rgb(*q) for q in hsv]).reshape(lit.shape[:2] + (3,)) * 255).astype(np.uint8)
        lit[..., 3] = np.where(mask, 255, 0)
        frames.append(Image.fromarray(lit, 'RGBA'))
    return Image.fromarray(off, 'RGBA'), frames, [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def split_chair(desk):
    """desk picture -> (the desk without its chair, the chair alone cut to its box, (x, y) of that box in the desk picture).
    The chair = the blue seat (lower part only: the monitors are bluish too) and the dark back / arms / grey base joined to it."""
    px = np.array(desk).astype(np.int32)
    r, g, b, a = px[..., 0], px[..., 1], px[..., 2], px[..., 3]
    solid = a > 128
    blue = solid & (b > r + 35) & (b > g + 15)
    blue[:int(desk.height * 0.44)] = False
    ys, xs = np.nonzero(blue)
    if not len(xs):
        return desk, None, (0, 0)
    box = np.zeros_like(solid)
    box[max(0, ys.min() - 12):, max(0, xs.min() - 25):min(desk.width, xs.max() + 25)] = True
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    sat = px[..., :3].max(axis=2) - px[..., :3].min(axis=2)
    cand = (blue | (solid & box & (lum < 120) & (sat < 45)) | (solid & box & (lum >= 120) & (lum < 215) & (sat < 30))) & box
    region = blue.copy()
    while True:
        nxt = region | (_grow4(region) & cand)
        if (nxt == region).all():
            break
        region = nxt
    free = np.array(desk).copy()
    free[region, 3] = 0
    chair = np.array(desk).copy()
    chair[~region, 3] = 0
    cy, cx = np.nonzero(region)
    x0, y0, x1, y1 = cx.min(), cy.min(), cx.max() + 1, cy.max() + 1
    return Image.fromarray(free, 'RGBA'), Image.fromarray(chair[y0:y1, x0:x1], 'RGBA'), (int(x0), int(y0))


def screen_faces(frame):
    """frame: the lit screens (RGBA, cut to the two monitor faces). -> [[fx, fy, fw, fh], ...] the biggest axis-aligned rectangle
    inside each monitor face (the faces are slanted; a code strip scrolling in a plain rectangle must stay inside), 4% inset."""
    a = np.array(frame.getchannel('A')) > 128
    h, w = a.shape
    cols = a.any(axis=0)
    gap = None                                     # the widest empty column run between the two monitors
    best = 0; run = 0; start = 0
    for x in range(w):
        if not cols[x]:
            if run == 0: start = x
            run += 1
            if run > best: best, gap = run, (start, x)
        else:
            run = 0
    cut = (gap[0] + gap[1]) // 2 if gap and cols[:gap[0]].any() and cols[gap[1] + 1:].any() else w // 2
    out = []
    for x0, x1 in ((0, cut), (cut, w)):
        m = a[:, x0:x1]
        heights = np.zeros(m.shape[1], int); bestr = (0, 0, 0, 0, 0)
        for y in range(m.shape[0]):
            heights = np.where(m[y], heights + 1, 0)
            for xx in range(m.shape[1]):               # largest rectangle ending on row y (small images: brute force)
                hh = heights[xx]
                for x2 in range(xx, m.shape[1]):
                    hh = min(hh, heights[x2])
                    if hh == 0: break
                    area = hh * (x2 - xx + 1)
                    if area > bestr[0]: bestr = (area, xx, y - hh + 1, x2 - xx + 1, hh)
        _, bx, by, bw, bh = bestr
        if bw and bh:
            ix, iy = max(1, round(bw * .04)), max(1, round(bh * .06))
            out.append([round((x0 + bx + ix) / w, 4), round((by + iy) / h, 4), round(max(1, bw - 2 * ix) / w, 4), round(max(1, bh - 2 * iy) / h, 4)])
    return out


def align(base, other):
    """(dx, dy): where `other` goes in `base` coordinates so their lower parts (desk body, chair)
    match best. Brute force over a small window."""
    pad = 40
    size = (base.width + 2 * pad, base.height + 2 * pad)

    def on_canvas(img, dx, dy):
        c = Image.new('RGBA', size, (0, 0, 0, 0))
        c.paste(img, (pad + dx, pad + dy))
        return np.array(c).astype(int)

    ref = on_canvas(base, 0, 0)
    lo, hi = pad + int(base.height * .6), pad + base.height
    best = None
    for dx in range(-30, 31):
        for dy in range(-8, 9):
            err = np.abs(ref[lo:hi, :, :3] - on_canvas(other, dx, dy)[lo:hi, :, :3]).mean()
            if best is None or err < best[0]:
                best = (err, dx, dy)
    return best[1], best[2]



# ---------------------------------------------------------------- free-address desks (task2-fa)
def _wood(px):
    r, g, b = (px[..., i].astype(int) for i in range(3))
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    return (px[..., 3] > ALPHA_MIN) & (r > b + 40) & (r >= g) & (mx > 140) & (mx - mn > 55)


def strip_shadow(img):
    """The pale grey floor shadow drawn under the furniture: transparent (our own soft shadow is drawn by the mod).
    Only pale pixels connected to the outside go, so a white pot or sheet of paper keeps its inside."""
    a = np.array(img.convert('RGBA'))
    r, g, b = (a[..., i].astype(int) for i in range(3))
    lum = (299 * r + 587 * g + 114 * b) // 1000
    pale = (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) < 26) & (lum > 196) & (a[..., 3] > ALPHA_MIN)
    clear = a[..., 3] <= ALPHA_MIN
    reach = _grow4(clear) & pale
    while True:
        nxt = _grow4(reach) & pale
        if (nxt == reach).all():
            break
        reach = nxt
    a[reach, 3] = 0
    px = a[..., 3] > ALPHA_MIN                                  # drop the specks the rule leaves behind
    keep = max(label(px), key=len) if px.any() else []
    m = np.zeros_like(px)
    for y, x in keep:
        m[y, x] = True
    a[~_grow4(_grow4(m)), 3] = 0
    out = Image.fromarray(a, 'RGBA')
    bb = out.getchannel('A').point(lambda v: 255 if v > ALPHA_MIN else 0).getbbox()
    return out.crop(bb) if bb else out


def open3(mask):
    """Morphological opening with a 3 x 3 square: strokes thinner than 3 px disappear, the rest is untouched."""
    sq = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    def shift(mk, dy, dx):
        o = np.zeros_like(mk)
        o[max(0, dy):mk.shape[0] + min(0, dy), max(0, dx):mk.shape[1] + min(0, dx)] = mk[max(0, -dy):mk.shape[0] + min(0, -dy), max(0, -dx):mk.shape[1] + min(0, -dx)]
        return o
    er = mask.copy()
    for dy, dx in sq:
        er &= shift(mask, dy, dx)
    op = np.zeros_like(mask)
    for dy, dx in sq:
        op |= shift(er, dy, dx)
    return op & mask


def drop_ticks(img):
    a = np.array(img.convert('RGBA'))
    keep = open3(a[..., 3] > ALPHA_MIN)
    a[~keep, 3] = 0
    return Image.fromarray(a, 'RGBA')


def extract_laptop(desk):
    """The laptop alone from a one-person desk picture (the dark body on top of the wooden top, above the legs)."""
    a = np.array(desk.convert('RGBA'))
    h, w = a.shape[:2]
    r, g, b = (a[..., i].astype(int) for i in range(3))
    lum = (299 * r + 587 * g + 114 * b) // 1000
    solid = a[..., 3] > ALPHA_MIN
    metal = solid & (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) < 60) & (lum < 150)
    box = np.zeros_like(metal)
    box[:int(h * .68), int(w * .12):int(w * .88)] = True
    metal &= box
    core = metal.copy()
    for _ in range(2):                                           # open: thin outline strands fall away
        core = ~_grow4(~core)
    cells = max(label(core), key=len)
    m = np.zeros_like(core)
    for y, x in cells:
        m[y, x] = True
    m = _grow4(_grow4(m)) & solid & ~_wood(a)
    pts = [(int(x), int(y)) for y, x in zip(*np.nonzero(m))]
    hm = Image.new('L', (w, h), 0)
    ImageDraw.Draw(hm).polygon(hull(pts), fill=255)             # the keys are lighter than the frame: take the whole outline
    m = (np.array(hm) > 0) & solid & ~_wood(a)
    a[~m, 3] = 0
    px = a[..., 3] > ALPHA_MIN                                  # the body only: thin strands (outline scraps) fall away
    core = px.copy()
    for _ in range(3):
        core = ~_grow4(~core)
    big = np.zeros_like(px)
    for y, x in max(label(core), key=len):
        big[y, x] = True
    for _ in range(4):
        big = _grow4(big) & px
    sq = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]   # opening with a 3 x 3 square: strokes thinner than 3 px (ticks) go
    def shift(mk, dy, dx):
        o = np.zeros_like(mk)
        o[max(0, dy):mk.shape[0] + min(0, dy), max(0, dx):mk.shape[1] + min(0, dx)] = mk[max(0, -dy):mk.shape[0] + min(0, -dy), max(0, -dx):mk.shape[1] + min(0, -dx)]
        return o
    er = big.copy()
    for dy, dx in sq:
        er &= shift(big, dy, dx)
    op = np.zeros_like(big)
    for dy, dx in sq:
        op |= shift(er, dy, dx)
    big = op & big
    a[~big, 3] = 0
    out = Image.fromarray(a, 'RGBA')
    bb = out.getchannel('A').point(lambda v: 255 if v > ALPHA_MIN else 0).getbbox()
    return out.crop(bb)


def largest_rect(mask):
    """(x, y, w, h) of the largest axis-aligned rectangle inside a boolean mask."""
    heights = np.zeros(mask.shape[1], int)
    best = (0, 0, 0, 0, 0)
    for y in range(mask.shape[0]):
        heights = np.where(mask[y], heights + 1, 0)
        stack = []
        for x in range(mask.shape[1] + 1):
            cur = heights[x] if x < mask.shape[1] else 0
            start = x
            while stack and stack[-1][1] >= cur:
                sx, sh = stack.pop()
                if sh * (x - sx) > best[0]:
                    best = (sh * (x - sx), sx, y - sh + 1, x - sx, sh)
                start = sx
            stack.append((start, cur))
    return best[1:]


DESK_ISO_CELLS = (2.0, 1.2)         # ★70-1: one seat's desk, along x x deep, in the office's cells (a plank of 2 sheet tiles is 1.5 cells); T3's 1.5 x .9 left the laptop wider than half the desk


def desk_iso(img, top_h):
    """★70-1: T3's desk (desk_R: the long side along x, the seat side down-left), white rim off, scaled so that it is DESK_ISO_CELLS on the floor
    (the planks' scale: 1 cell = 4/3 sheet tiles), the legs made longer (rows under the top repeated) so the top stands `top_h` px over the floor
    like the planks' (the laptops sit at the typing hands). Returns (picture, {foot, top_vertex, top_height, cells, note})."""
    im = fill_holes(white_rim_off(img.convert('RGBA')))
    bb = im.getchannel('A').point(lambda v: 255 if v > 128 else 0).getbbox()
    im = im.crop(bb)
    a_, b_ = (c_ * 4 / 3 for c_ in DESK_ISO_CELLS)                       # in sheet tiles
    k = ((a_ + b_) * GRID_TW / 2 / .92) / im.width                         # the planks' own .92 (fa_parts)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    px = np.array(im)
    wood = _wood(px)
    ys, xs = np.nonzero(wood)
    vy = int(ys.max())                                                     # the top's front corner (the lowest wood)
    vx = float(xs[ys >= vy - 1].mean())
    floor = int(np.nonzero((px[..., 3] > ALPHA_MIN).any(axis=1))[0].max())
    add_ = max(0, round(top_h - (floor - vy)))
    if add_:                                                               # repeat one row of the legs (just under the top's lowest point)
        cut_y = min(px.shape[0] - 2, vy + 4)
        out = np.zeros((px.shape[0] + add_, px.shape[1], 4), np.uint8)
        out[:cut_y] = px[:cut_y]
        out[cut_y:cut_y + add_] = px[cut_y:cut_y + 1]
        out[cut_y + add_:] = px[cut_y:]
        im = Image.fromarray(out, 'RGBA')
    return im, {'foot': [round(vx, 1), vy + int(top_h)], 'top_vertex': [round(vx, 1), vy], 'top_height': int(top_h), 'cells': list(DESK_ISO_CELLS),
                'note': 'foot = the floor point under the top\'s front corner (max x, max y of the desk); the desk is cells[0] along x, cells[1] deep'}


def fa_parts(pieces):
    """The free-address furniture at the desk sheet's scale: planks (mirrored: the long side runs along x, the seat side
    faces down-left), laptops (off / on / closed, with the screen face), mug / plant / papers; and the points A needs."""
    k = None
    out, info = {}, {}
    mid = pieces['plank_b']
    k = (3 * GRID_TW / 4) / .92 / mid.width * 2 if False else ((2 + 1) * GRID_TW / 2 / .92) / mid.width     # 2 x 1 tiles
    def scale(im):
        return im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    planks = {'plank_left': 'plank_c', 'plank_mid': 'plank_b', 'plank_right': 'plank_a'}      # mirrored: the ends swap
    pl = {}
    for name, src in planks.items():
        img = scale(ImageOps.mirror(strip_shadow(pieces[src])))
        pl[name] = fill_holes(img)
    hleg = None
    for name, img in pl.items():
        px = np.array(img)
        wood = _wood(px)
        ys, xs = np.nonzero(wood)
        wy = int(ys.max())
        wx = float(xs[ys >= wy - 2].mean())
        foot = foot_of(img)
        if name == 'plank_mid':
            hleg = foot[1] - wy                                  # top surface -> floor, pixels
        info[name] = {'wood_front_corner': [round(wx, 1), wy]}
    for name, img in pl.items():
        wx, wy = info[name]['wood_front_corner']
        info[name]['anchor'] = tile_anchor((wx, wy + hleg), 2, 1)
        info[name]['footprint'] = [[0, 0], [1, 0]]
        # the middle of the near (down-left) edge of the top surface: the lowest wood pixel of each column
        wood = _wood(np.array(img))
        cols = np.nonzero(wood.any(axis=0))[0]
        xm = int((cols.min() + cols.max()) / 2)
        info[name]['front_edge'] = [xm, int(np.nonzero(wood[:, xm])[0].max())]
        info[name]['top_height'] = hleg
        out[name] = img
    # a person's seat: the tile in front of the middle of a plank, (0.5, 1) of the plank's own tiles
    for name in pl:
        ax, ay = info[name]['anchor']
        info[name]['seat_point'] = [round(ax + (0.5 - 1) * GRID_TW / 2, 1), round(ay + (0.5 + 1) * GRID_TH / 2, 1)]
    lap = {}
    for key, name in (('lt_off', 'laptop_off'), ('lt_on', 'laptop_on'), ('lt_closed', 'laptop_closed')):
        lap[name] = fill_holes(drop_ticks(scale(ImageOps.mirror(extract_laptop(strip_shadow(pieces[key]))))))
        out[name] = lap[name]
    # keyboard centre: the middle of the lower half of the laptop body
    kb = {}
    for name, img in lap.items():
        a = np.array(img)[..., 3] > ALPHA_MIN
        ys, xs = np.nonzero(a[int(a.shape[0] * .55):])
        kb[name] = [round(float(xs.mean()), 1), round(float(ys.mean()) + a.shape[0] * .55, 1)]
    scr = np.array(lap['laptop_on'])
    r_, g_, b_ = (scr[..., i].astype(int) for i in range(3))
    face = (scr[..., 3] > ALPHA_MIN) & (b_ - r_ > 28) & (b_ > g_ + 8)
    ys, xs = np.nonzero(face)
    fm = Image.new('L', face.shape[::-1], 0)
    ImageDraw.Draw(fm).polygon(hull([(int(x), int(y)) for y, x in zip(ys, xs)]), fill=255)
    face = np.array(fm) > 0
    ys, xs = np.nonzero(face)
    srect = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    fx, fy, fw, fh = largest_rect(face[srect[1]:srect[1] + srect[3], srect[0]:srect[0] + srect[2]])
    info['laptop'] = {'keyboard_center': kb, 'screen_rect': srect,
                      'faces': [[round(fx / srect[2] + .02, 3), round(fy / srect[3] + .03, 3), round(fw / srect[2] - .04, 3), round(fh / srect[3] - .06, 3)]],
                      'note': 'pixels of laptop_on; faces = the largest plain rectangle inside the screen, as fractions of screen_rect'}
    dim = np.array(lap['laptop_on'])                              # the same laptop, screen dark (the typist is away)
    dim[face, :3] = (24, 30, 46)
    for yy in range(srect[1] + 3, srect[1] + srect[3] - 2, 4):    # a few very faint lines, so it still reads as a screen
        row = face[yy]
        dim[yy, row, :3] = (34, 42, 62)
    out['laptop_dim'] = Image.fromarray(dim, 'RGBA')
    kb['laptop_dim'] = kb['laptop_on']
    out['mug'] = fill_holes(scale(strip_shadow(pieces['mug_fa'])))
    out['plant_2'] = fill_holes(scale(pieces['plant_fa']))
    out['papers'] = fill_holes(scale(pieces['papers_fa']))
    info['scale'] = round(k, 4)
    return out, info


def _best_shift(pose_mask, part_mask, part_img, rng_x, rng_y, scales):
    """(scale, dx, dy, score, resized image) that covers the pose's visible blue best without adding blue where the pose has none."""
    best = None
    for sc in scales:
        im = part_img.resize((round(part_img.width * sc), round(part_img.height * sc)), Image.LANCZOS)
        a = np.array(im)
        blue = (a[..., 2] > 110) & (a[..., 2].astype(int) - a[..., 0] > 60) & (a[..., 3] > ALPHA_MIN)
        al = a[..., 3] > ALPHA_MIN
        h, w = blue.shape
        for dy in range(*rng_y):
            for dx in range(*rng_x):
                ys0, xs0 = max(0, dy), max(0, dx)
                ys1, xs1 = min(pose_mask.shape[0], dy + h), min(pose_mask.shape[1], dx + w)
                if ys1 <= ys0 or xs1 <= xs0:
                    continue
                pm = pose_mask[ys0:ys1, xs0:xs1]
                cm = blue[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
                out_of = int((al[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx] & ~part_mask[ys0:ys1, xs0:xs1]).sum()) + int(al.sum() - al[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx].sum())
                score = int((pm & cm).sum()) - 1.5 * int((pm & ~cm).sum()) - .3 * out_of
                if best is None or score > best[3]:
                    best = (sc, dx, dy, score, im)
    return best


def fit_empty_chair(pose, cands):
    """The sheet's empty office chair laid onto the laptop pose's own chair (scale and shift found by the blue of the seat
    the person leaves visible); returns a picture the size of `pose`, the chair where the pose's chair is."""
    pa = np.array(pose)
    pm = (pa[..., 2] > 110) & (pa[..., 2].astype(int) - pa[..., 0] > 60) & (pa[..., 3] > ALPHA_MIN)
    pm[:int(pose.height * .45)] = False
    pal = pa[..., 3] > ALPHA_MIN
    best = None
    for img in cands:
        for im0 in (img, ImageOps.mirror(img)):
            got = _best_shift(pm, pal, im0, (-30, 91, 4), (-10, 181, 4), (.4, .45, .5, .55, .6, .65, .7, .75, .8))
            if got:
                fine = _best_shift(pm, pal, im0, (got[1] - 3, got[1] + 4, 1), (got[2] - 3, got[2] + 4, 1), (got[0] - .03, got[0] - .015, got[0], got[0] + .015, got[0] + .03))
                got = fine or got
                if best is None or got[3] > best[3]:
                    best = got
    sc, dx, dy, score, im = best
    out = Image.new('RGBA', pose.size, (0, 0, 0, 0))
    out.alpha_composite(im, (max(0, dx), max(0, dy)), (max(0, -dx), max(0, -dy)))
    return out


def _feet(img):
    a = np.array(img).astype(int)
    r, g, b, al = (a[..., i] for i in range(4))
    brown = (al > ALPHA_MIN) & (r - b > 35) & (r > g) & (g > b) & (r < 215)
    brown[:int(a.shape[0] * .6)] = False
    ys, xs = np.nonzero(brown)
    return xs, ys


def fit_empty_armchair(cands, sitting_pose):
    """The sheet's empty armchair scaled so that its feet stand as far apart as the sitting pose's, and placed on them.
    Returns a picture the size of the pose. The better-matching of the two drawings is used."""
    chair, legs = _armchair_known(sitting_pose)
    cy, cx = np.nonzero(chair | legs)
    ly, lx = np.nonzero(legs)
    best = None
    for img in cands:
        fx, fy = _feet(img)
        if len(fx) < 20:
            continue
        ay, ax = np.nonzero(np.array(img)[..., 3] > ALPHA_MIN)
        sc = ((cx.max() - cx.min()) / max(1, ax.max() - ax.min()) + (cy.max() - cy.min()) / max(1, ay.max() - ay.min())) / 2   # as big as the pose's visible chair (width and height averaged: the drawings differ a little)
        im = img.resize((round(img.width * sc), round(img.height * sc)), Image.LANCZOS)
        ay2, ax2 = np.nonzero(np.array(im)[..., 3] > ALPHA_MIN)
        fx2, fy2 = _feet(im)
        dx = int(round((cx.min() + cx.max()) / 2 - (ax2.min() + ax2.max()) / 2))
        dy = int(ly.max() - fy2.max())
        out = Image.new('RGBA', sitting_pose.size, (0, 0, 0, 0))
        out.alpha_composite(im, (max(0, dx), max(0, dy)), (max(0, -dx), max(0, -dy)))
        pc_ = np.array(out)[..., 3] > ALPHA_MIN
        score = int((pc_ & (np.array(sitting_pose)[..., 3] > ALPHA_MIN)).sum()) - 2 * int((pc_ & ~(np.array(sitting_pose)[..., 3] > ALPHA_MIN)).sum())
        if best is None or score > best[0]:
            best = (score, out)
    return best[1]


def bird_frames(pieces, width=40):
    """The bird's 8 frames (dark 0-3, pale 0-3) on one canvas, facing right, scaled to `width` px; and the mirrored ones."""
    names = [f'bird_{t}{i}' for t in 'dl' for i in range(4)]
    k = width / max(pieces[n].width for n in names)
    cw_ = max(round(pieces[n].width * k) for n in names)
    ch_ = max(round(pieces[n].height * k) for n in names)
    out = {}
    for n in names:
        im = pieces[n].resize((max(1, round(pieces[n].width * k)), max(1, round(pieces[n].height * k))), Image.LANCZOS)
        c = Image.new('RGBA', (cw_, ch_), (0, 0, 0, 0))
        c.alpha_composite(im, ((cw_ - im.width) // 2, (ch_ - im.height) // 2))
        out[n] = c
    return out


def slanted_outside(photo, win):
    """A flat 16:9 picture sheared to the window part's glass (a parallelogram: vertical sides, the top and bottom edges follow the
    wall) and cut to the glass; same size and foot as the part."""
    m = glass_mask(win)
    ys, xs = np.nonzero(m)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    gw, gh = x1 - x0, y1 - y0
    cols = [int(np.nonzero(m[:, x])[0].min()) for x in range(x0, x1) if m[:, x].any()]
    k = float(np.polyfit(np.arange(len(cols)), cols, 1)[0])
    hv = max(8, int(round(gh - abs(k) * gw)))
    ph = photo.convert('RGBA')
    ratio = gw / hv                                                  # cover the parallelogram's vertical extent
    cw_, chh = (ph.width, round(ph.width / ratio)) if ph.width / ph.height > ratio else (round(ph.height * ratio), ph.height)
    ph = ph.crop(((ph.width - cw_) // 2, (ph.height - chh) // 2, (ph.width - cw_) // 2 + cw_, (ph.height - chh) // 2 + chh)).resize((gw, hv), Image.LANCZOS)
    tall = Image.new('RGBA', (gw, gh), (0, 0, 0, 255))
    tall.paste(ph, (0, 0))
    s0 = 0.0 if k >= 0 else -k * gw
    sheared = tall.transform((gw, gh), Image.AFFINE, (1, 0, 0, -k, 1, -s0), Image.BICUBIC)
    out = Image.new('RGBA', win.size, (0, 0, 0, 0))
    out.paste(sheared, (x0, y0))
    a = np.array(out)
    a[..., 3] = np.where(m, 255, 0)
    return Image.fromarray(a, 'RGBA')


def empty_chair_pc(pieces, chair_img, cw, ch):
    """The chair of the laptop poses without the person: the desk's chair (it is the same drawing, seen from the other
    side, so mirrored), with the desk's scraps removed, scaled and shifted onto the pose's own chair by the blue of the
    seat (the part the person leaves visible). The result is on the pose canvas."""
    pose = pieces['a_type_pc']
    pa = np.array(pose)
    pm = (pa[..., 2] > 110) & (pa[..., 2].astype(int) - pa[..., 0] > 60) & (pa[..., 3] > ALPHA_MIN)
    pm[:int(pose.height * .45)] = False
    pal = pa[..., 3] > ALPHA_MIN
    ca = np.array(chair_img)
    ci_ = ca.astype(int)
    lum_ = (299 * ci_[..., 0] + 587 * ci_[..., 1] + 114 * ci_[..., 2]) // 1000
    solid = (ca[..., 3] > ALPHA_MIN) & ((ci_[..., 2] >= ci_[..., 0] - 3) | (lum_ < 70))    # the chair is blue / cool grey / black; the desk is warm grey
    core = solid.copy()
    for _ in range(2):
        core = ~_grow4(~core)                                     # thin desk lines fall away, the chair stays
    big = np.zeros_like(solid)
    for y, x in max(label(core), key=len):
        big[y, x] = True
    for _ in range(4):
        big = _grow4(big) & solid
    ca[~big, 3] = 0
    img = ImageOps.mirror(Image.fromarray(ca, 'RGBA'))
    mb = np.array(img)
    bl = (mb[..., 2] > 110) & (mb[..., 2].astype(int) - mb[..., 0] > 60) & (mb[..., 3] > ALPHA_MIN)
    mb[:, :max(0, int(np.nonzero(bl.any(axis=0))[0].min()) - 3), 3] = 0         # the desk's side panel left of the chair's back
    img = Image.fromarray(mb, 'RGBA')
    sc, dx, dy, score, im = _best_shift(pm, pal, img, (-20, 61, 3), (0, 111, 3), (.85, .9, .95, 1.0, 1.05, 1.1, 1.15))
    sc, dx, dy, score, im = _best_shift(pm, pal, img, (dx - 3, dx + 4, 1), (dy - 3, dy + 4, 1), (sc - .03, sc - .015, sc, sc + .015, sc + .03))
    canvas_ = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    ox, oy = (cw - pose.width) // 2 + dx, ch - pose.height + dy
    canvas_.alpha_composite(im, (max(0, ox), max(0, oy)), (max(0, -ox), max(0, -oy)))
    return canvas_


def _armchair_known(im):
    """(chair, legs): the armchair's own pixels of a sitting picture (its warm grey faces, its brown feet)."""
    a = np.array(im).astype(int)
    r, g, b, al = (a[..., i] for i in range(4))
    solid = al > ALPHA_MIN
    chair = solid & (r - b >= 5) & (r - b <= 30) & (r > 90)       # the cardigan, shirt, trousers and skin are not this warm grey
    brown = solid & (r - b > 35) & (r > g) & (g > b) & (r < 190)
    brown[:int(a.shape[0] * .57)] = False
    legs = np.zeros_like(solid)
    for comp in label(brown):                                      # the chair's feet: brown pieces at the left or right edge, or far below
        xs = [x for y, x in comp]
        if 60 <= len(comp) <= 140 and (min(xs) < 30 or min(xs) > 150):
            for y, x in comp:
                legs[y, x] = True
    return chair, legs


def empty_armchair(sofa, sitting_pose):
    """An armchair with nobody in it. The sheets have none, and what is left of the chair behind a person is not enough,
    so it is built from the sheet's sofa: mirrored (its near arm is then on the right, as on the armchair), one cushion's
    width cut out of the middle (translation along the sofa's own axis, so the edges run on), recoloured to the armchair's
    warm grey with the sofa's own light and shade, the feet in the armchair's brown. Placed like the sitting pose
    (feet at the same place). Returns an image the size of `sitting_pose`."""
    sf = np.array(ImageOps.mirror(sofa))
    H, W = sf.shape[:2]
    cutL, d = 110, 76
    out = np.zeros((H + d // 2 + 4, W - d + 4, 4), np.uint8)
    oy = d // 2 + 2
    out[oy:oy + H, 0:cutL] = sf[:, :cutL]
    right = sf[:, cutL + d:]
    seg = out[oy - d // 2:oy - d // 2 + H, cutL:cutL + right.shape[1]]
    m = right[..., 3] > ALPHA_MIN
    seg[m] = right[m]
    band = out[:, cutL - 4:cutL + 5].astype(float)            # the join: smooth it sideways where the picture is solid on both sides
    full = (band[..., 3] > ALPHA_MIN).all(axis=1)
    lumb = (band[..., 0] * .3 + band[..., 1] * .59 + band[..., 2] * .11)
    ok = full & (lumb > 60).all(axis=1)
    sm = band.mean(axis=1)
    out[ok, cutL - 2:cutL + 3, :3] = np.clip(sm[ok][:, None, :3], 0, 255).astype(np.uint8)
    ys, xs = np.nonzero(out[..., 3] > ALPHA_MIN)
    out = out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    a = out.astype(float)
    solid = a[..., 3] > ALPHA_MIN
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = .299 * r + .587 * g + .114 * b
    feet = solid & (r > 150) & (g > 70) & (g < 140) & (b < 70)
    face = solid & ~feet & (lum > 45)
    chair, legs = _armchair_known(sitting_pose)
    pa = np.array(sitting_pose).astype(float)
    plum = .299 * pa[..., 0] + .587 * pa[..., 1] + .114 * pa[..., 2]
    t_lo, t_hi = np.percentile(plum[chair], (4, 96))
    s_lo, s_hi = np.percentile(lum[face], (4, 96))
    mean_c = pa[chair][:, :3].mean(axis=0)
    mean_l = plum[chair].mean()
    new_l = t_lo + (np.clip(lum, s_lo, s_hi) - s_lo) * (t_hi - t_lo) / max(1.0, s_hi - s_lo)
    rgb = a[..., :3].copy()
    rgb[face] = (mean_c[None, :] * (new_l[face] / mean_l)[:, None])
    rgb[solid & ~face & ~feet] = rgb[solid & ~face & ~feet] * .0 + (22, 20, 22)       # the black outline
    if legs.any():
        mean_f = pa[legs][:, :3].mean(axis=0)
        mf = plum[legs].mean()
        rgb[feet] = mean_f[None, :] * (lum[feet] / max(1.0, lum[feet].mean()))[:, None] * 1.0
    res = np.zeros(out.shape, np.uint8)
    res[..., :3] = np.clip(rgb, 0, 255)
    res[..., 3] = out[..., 3]
    big = np.zeros(solid.shape, bool)                          # only the chair itself (the sofa's faint ground shadow goes)
    for y, x in max(label(res[..., 3] > ALPHA_MIN), key=len):
        big[y, x] = True
    res[~big, 3] = 0
    img = Image.fromarray(res, 'RGBA')
    # place: the feet's lowest row and the middle of the feet's span on the sitting pose's
    ly, lx = np.nonzero(legs)
    fy, fx = np.nonzero(feet)
    dx = int(round((lx.min() + lx.max()) / 2 - (fx.min() + fx.max()) / 2))
    dy = int(ly.max() - fy.max())
    canvas_ = Image.new('RGBA', sitting_pose.size, (0, 0, 0, 0))
    canvas_.alpha_composite(img, (max(0, dx), max(0, dy)), (max(0, -dx), max(0, -dy)))
    return canvas_


TIMES = ('morning', 'day', 'evening', 'night')
LIFE_HOURS = {'morning': [5, 10], 'day': [10, 16], 'evening': [16, 19], 'night': [19, 5]}
LIFE_TINTS = {'morning': ['#FFD9A0', .10], 'day': [None, 0], 'evening': ['#FF9A5A', .16], 'night': ['#0B1030', .42]}


def outside_view(time, side, w=160, h=100):
    """A window's outside, drawn at its own pixel size (still pictures; the same one is used by every window of that side).
    sky + sun / moon, a city line, a tree; the sun stands on the other side for `right`."""
    rnd = random.Random(f'{time}-{side}')
    sky = {'morning': ((255, 214, 170), (150, 200, 240)), 'day': ((120, 185, 245), (190, 225, 250)),
           'evening': ((250, 140, 90), (120, 100, 160)), 'night': ((10, 14, 40), (34, 44, 86))}[time]
    img = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    px = np.zeros((h, w, 4), np.uint8)
    for y in range(h):
        t = y / (h - 1)
        px[y, :, :3] = [round(sky[0][i] * (1 - t) + sky[1][i] * t) if time != 'evening' and time != 'morning' else round(sky[1][i] * (1 - t) + sky[0][i] * t) for i in range(3)]
        px[y, :, 3] = 255
    img = Image.fromarray(px, 'RGBA')
    d = ImageDraw.Draw(img)
    sx = int(w * (.28 if side == 'left' else .72))
    if time == 'night':
        for _ in range(26):
            d.point((rnd.randrange(w), rnd.randrange(int(h * .6))), fill=(235, 238, 255, 255))
        d.ellipse((sx - 7, 12, sx + 7, 26), fill=(246, 244, 220, 255))
        d.ellipse((sx - 3, 12, sx + 11, 26), fill=(26, 34, 72, 255))
    else:
        sun = {'morning': ((255, 236, 170), 22 + h // 5), 'day': ((255, 250, 215), 14), 'evening': ((255, 200, 120), 52)}[time]
        d.ellipse((sx - 9, sun[1] - 9, sx + 9, sun[1] + 9), fill=sun[0] + (255,))
        cloud = (255, 255, 255, 200) if time == 'day' else (255, 226, 200, 190) if time == 'morning' else (255, 170, 140, 200)
        for cx, cy in ((rnd.randrange(10, w - 40), rnd.randrange(8, 30)) for _ in range(2)):
            for ox, oy, rr in ((0, 0, 7), (9, 2, 6), (-8, 3, 5), (17, 4, 4)):
                d.ellipse((cx + ox - rr, cy + oy - rr, cx + ox + rr + 6, cy + oy + rr // 2 + 5), fill=cloud)
    ground = {'morning': (96, 112, 104), 'day': (86, 122, 82), 'evening': (70, 62, 82), 'night': (14, 20, 30)}[time]
    far = {'morning': (150, 160, 180), 'day': (140, 170, 200), 'evening': (110, 90, 130), 'night': (24, 32, 58)}[time]
    near = {'morning': (110, 120, 140), 'day': (100, 125, 160), 'evening': (72, 58, 96), 'night': (14, 20, 40)}[time]
    for layer, col, base, hmin, hmax in ((0, far, int(h * .78), 12, 34), (1, near, int(h * .86), 8, 26)):
        x = -rnd.randrange(6)
        while x < w:
            bw, bh = rnd.randrange(9, 20), rnd.randrange(hmin, hmax)
            d.rectangle((x, base - bh, x + bw - 1, base), fill=col + (255,))
            if time == 'night':
                for wy in range(base - bh + 3, base - 2, 4):
                    for wx in range(x + 2, x + bw - 2, 4):
                        if rnd.random() < .45:
                            d.point((wx, wy), fill=(255, 218, 130, 255))
            x += bw + rnd.randrange(0, 3)
    d.rectangle((0, int(h * .86), w, h), fill=ground + (255,))
    tx = int(w * (.8 if side == 'left' else .18))                # a tree in front
    trunk = (74, 54, 40, 255) if time != 'night' else (22, 18, 20, 255)
    leaf = {'morning': (110, 160, 100), 'day': (70, 160, 80), 'evening': (110, 110, 80), 'night': (18, 40, 36)}[time]
    d.rectangle((tx - 2, int(h * .66), tx + 2, h), fill=trunk)
    for ox, oy, rr in ((0, 0, 14), (-11, 8, 10), (11, 8, 10), (0, 14, 10)):
        d.ellipse((tx + ox - rr, int(h * .5) + oy - rr, tx + ox + rr, int(h * .5) + oy + rr), fill=leaf + (255,))
    return img


def bird_shadow():
    """One small bird silhouette (wings up), transparent; the mod moves it across the windows."""
    img = Image.new('RGBA', (26, 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = (24, 28, 42, 235)
    d.polygon([(0, 2), (5, 1), (10, 6), (13, 8), (16, 6), (21, 1), (25, 2), (19, 5), (15, 9), (13, 10), (11, 9), (7, 5)], fill=c)
    d.ellipse((11, 7, 15, 11), fill=c)
    return img


WALL_RAISE = 186         # px: how much taller the outer walls become (190 -> 376 at the end column: x 2.0; a door 1.4 x a person's height fits)


def raise_wall(img, bands, extra=WALL_RAISE):
    """Make a wall piece `extra` px taller without touching its base, top edge or ends: in every column the rows
    r0..r1 (`bands(x) -> (r0, r1)`, following the wall's slope) are stretched to take the extra height; rows above stay,
    rows below move down. Same width; the picture grows downward, so its foot stays on the wall's base line."""
    a = np.array(img.convert('RGBA')).astype(float)
    a[..., :3] *= a[..., 3:4] / 255.0                                   # premultiplied: no dark fringes while resampling
    h, w = a.shape[:2]
    out = np.zeros((h + extra, w, 4))
    for x in range(w):
        r0, r1 = bands(x)
        r0, r1 = float(r0), float(max(r0 + 1, r1))
        yo = np.arange(h + extra, dtype=float)
        yi = np.where(yo < r0, yo, np.where(yo < r1 + extra, r0 + (yo - r0) * (r1 - r0) / (r1 - r0 + extra), yo - extra))
        y0 = np.clip(np.floor(yi).astype(int), 0, h - 1)
        y1 = np.clip(y0 + 1, 0, h - 1)
        f = (yi - np.floor(yi))[:, None]
        out[:, x] = a[y0, x] * (1 - f) + a[y1, x] * f
    al = out[..., 3:4]
    rgb = np.where(al > 0, out[..., :3] * 255.0 / np.maximum(al, 1e-6), 0)
    res = np.zeros(out.shape, np.uint8)
    res[..., :3] = np.clip(rgb, 0, 255)
    res[..., 3] = np.where(al[..., 0] > 127, 255, 0)
    return Image.fromarray(res, 'RGBA')


PLASTER = (236, 226, 210)         # the walls' colour in the target picture: a bright, warm plaster


def plaster(img):
    """Recolour the wall's light-grey faces to bright plaster, keeping their light and shade; the dark frames and the glass stay."""
    a = np.array(img.convert('RGBA')).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = .299 * r + .587 * g + .114 * b
    mx, mn = a[..., :3].max(axis=2), a[..., :3].min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    m = (a[..., 3] > 127) & (sat < .22) & (lum > 105) & (b - r < 14)
    if m.any():
        ref = np.percentile(lum[m], 75)
        f = np.clip(lum / ref, .55, 1.12)[..., None]
        a[..., :3] = np.where(m[..., None], np.clip(np.array(PLASTER)[None, None, :] * f, 0, 255), a[..., :3])
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def remap_window_rows(img, geo, extra):
    """Make a window piece `extra` px taller with no wall under the glass: per column `geo(x) -> (top, glass_end, rail, skirt0)`: rows above `top`
    stay; the glass (top..glass_end) is stretched down to just above the lower rail; the rail (`rail` px) and everything from `skirt0` down
    (skirting, moulding) are kept at the foot; the plaster between the rail and `skirt0` is dropped. Same width; the foot stays on the base line."""
    a = np.array(img.convert('RGBA')).astype(float)
    a[..., :3] *= a[..., 3:4] / 255.0
    h, w = a.shape[:2]
    out = np.zeros((h + extra, w, 4))
    yo = np.arange(h + extra, dtype=float)
    for x in range(w):
        t, g, rail, s0 = geo(x)
        d_g = s0 + extra - rail                                    # where the rail starts in the new picture
        yi = np.where(yo < t, yo, np.where(yo < d_g, t + (yo - t) * (g - t) / max(1.0, d_g - t), np.where(yo < d_g + rail, g + (yo - d_g), s0 + (yo - d_g - rail))))
        y0 = np.clip(np.floor(yi).astype(int), 0, h - 1)
        y1 = np.clip(y0 + 1, 0, h - 1)
        f = (yi - np.floor(yi))[:, None]
        out[:, x] = a[y0, x] * (1 - f) + a[y1, x] * f
    al = out[..., 3:4]
    rgb = np.where(al > 0, out[..., :3] * 255.0 / np.maximum(al, 1e-6), 0)
    res = np.zeros(out.shape, np.uint8)
    res[..., :3] = np.clip(rgb, 0, 255)
    res[..., 3] = np.where(al[..., 0] > 127, 255, 0)
    return Image.fromarray(res, 'RGBA')


def tall_window_wall(win, extra=WALL_RAISE, apron_share=90):
    """The window wall part made taller: a third of the wall's height is plaster apron (the sill and the plaster below it grow by
    `apron_share` px), the glass above grows by the rest; the band above the glass is kept. Plaster-coloured."""
    geo = glass_geometry(win)
    k, top0, x0, hh = geo['slope'], geo['top_y0'], geo['x0'], geo['h']
    eg = extra - apron_share
    glass_up = raise_wall(win, lambda x: (top0 + k * (x - x0), top0 + k * (x - x0) + hh + 6), eg)
    bot = lambda x: top0 + k * (x - x0) + hh + 6 + eg                 # glass bottom in the part raised so far
    tall = raise_wall(glass_up, lambda x: (bot(x) + 6, bot(x) + 24), apron_share)
    return plaster(tall)


def tall_plain_wall(img, a_off=22, foot=14, extra=WALL_RAISE, like=None):
    """A piece without windows (plain wall, wall with a lamp, entrance block) made as tall: every column is stretched between the
    top face (kept) and the base (kept), so the top and bottom edges keep their slope. Plaster-coloured. `like`: another picture of
    the same block whose top and bottom edges are used (the open doors have gaps in the middle: their columns end higher)."""
    ref = np.array((like or img).convert('RGBA'))[..., 3] > 127
    tops = {x: (int(np.nonzero(ref[:, x])[0].min()) if ref[:, x].any() else 0) for x in range(ref.shape[1])}
    bots = {x: (int(np.nonzero(ref[:, x])[0].max()) if ref[:, x].any() else 0) for x in range(ref.shape[1])}
    wmax = ref.shape[1] - 1
    return plaster(raise_wall(img, lambda x: (tops[min(x, wmax)] + a_off, bots[min(x, wmax)] - foot), extra))


def cut_window2(path):
    """The 2-tile window (opaque on white in T3's picture): {window2, window2_glass (the same with the glass in magenta), wall_plain1, wall_post}
    as transparent pictures at the outer walls' scale (end height WALL_END), the walls in plaster colour."""
    img = Image.open(path).convert('RGB')
    a = np.array(img).astype(int)
    white = a.min(axis=2) >= 238
    reach = np.zeros_like(white)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = white[0, :], white[-1, :], white[:, 0], white[:, -1]
    while True:
        nxt = _grow4(reach) & white
        if (nxt == reach).all():
            break
        reach = nxt
    rgba = np.dstack([a.astype(np.uint8), np.where(reach, 0, 255).astype(np.uint8)])
    full = Image.fromarray(rgba, 'RGBA')
    boxes = components(np.array(full.getchannel('A')), 6)
    if len(boxes) != 4:
        return {}
    names = ['window2', 'wall_plain1', 'window2_glass', 'wall_post']
    raw = {}
    for n, b in zip(names, boxes):
        pc = np.array(full.crop(b))
        big = np.zeros(pc.shape[:2], bool)
        for y, x in max(label(pc[..., 3] > 127), key=len):         # the boxes of the two windows overlap a little: keep this piece's own pixels only
            big[y, x] = True
        pc[~big, 3] = 0
        raw[n] = _trim(Image.fromarray(pc, 'RGBA'))
    # T3 drew the 2-tile window wide and low: scale it to the outer walls' length (a 2-tile piece is 2/3 as long as the 3-tile walls), then raise it to the walls' height
    k = (WALL_LEN3 * 2 / 3.0 + 6) / raw['window2'].width
    small = {n: im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS) for n, im in raw.items()}
    ga = np.array(small['window2_glass']).astype(int)
    gm = (ga[..., 0] > 180) & (ga[..., 1] < 110) & (ga[..., 2] > 180) & (ga[..., 3] > 127)

    def end_h(im):
        al = np.array(im.getchannel('A')) > 127
        c = np.nonzero(al.any(axis=0))[0].min() + 3
        ys = np.nonzero(al[:, c])[0]
        return int(ys.max() - ys.min())
    extra = max(0, WALL_END - end_h(small['window2']))
    ys_, xs_ = np.nonzero(gm)
    cols = [(x, int(np.nonzero(gm[:, x])[0].min()), int(np.nonzero(gm[:, x])[0].max())) for x in range(int(xs_.min()), int(xs_.max()) + 1) if gm[:, x].any()]
    fit = np.polyfit([c[0] for c in cols], [c[1] for c in cols], 1)
    slope, x0 = float(fit[0]), int(xs_.min())
    top0 = float(np.polyval(fit, x0))
    hh = float(np.mean([c[2] - c[1] for c in cols])) + 1
    # ★21-2: no plaster apron under the glass: the glass runs from just above the skirting to just under the top frame.
    al_ = np.array(small['window2'].getchannel('A')) > 127
    bx_ = np.array([x for x in range(al_.shape[1]) if al_[:, x].any()])
    bfit = np.polyfit(bx_, [int(np.nonzero(al_[:, x])[0].max()) for x in bx_], 1)       # the piece's bottom edge (follows the wall's slope)
    RAIL, SKIRT = 8, 22                                                                  # the glass's dark lower rail kept, and the skirting + moulding kept (px)

    def tall(im):
        return remap_window_rows(im, lambda x: (top0 + slope * (x - x0) - 2, top0 + slope * (x - x0) + hh + 4, RAIL, float(np.polyval(bfit, x)) - SKIRT), extra)
    out = {'window2': plaster(tall(small['window2'])), 'window2_glass': tall(small['window2_glass'])}
    for n in ('wall_plain1', 'wall_post'):
        out[n] = plaster(tall_plain_wall(small[n], extra=max(0, WALL_END - end_h(small[n]))))
    return out


def _trim(img):
    ys, xs = np.nonzero(np.array(img.getchannel('A')) > ALPHA_MIN)
    return img.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def build_board(path, width=261, total_end=376):
    """The notice-board wall and the same wall plain, from T3's picture: scaled to the outer walls' length (261 px = 3 tiles), the
    plaster in the walls' colour, made as tall as the other outer walls by stretching the plain bands above and below the board
    (the board itself keeps its shape). Also the board's face: the lattice of its LED dots, in pixels of the finished picture."""
    img = Image.open(path).convert('RGBA')
    boxes = components(np.array(img.getchannel('A')), 6)
    if len(boxes) != 2:
        return {}, None
    pieces = [_trim(img.crop(b)) for b in boxes]
    out, info = {}, None
    for name, pc in zip(('wall_board', 'wall_plain3'), pieces):
        k = width / pc.width
        im = pc.resize((width, round(pc.height * k)), Image.LANCZOS)
        a = np.array(im)
        solid = a[..., 3] > 127
        h, w = solid.shape
        tops = np.array([np.nonzero(solid[:, x])[0].min() if solid[:, x].any() else 0 for x in range(w)])
        bots = np.array([np.nonzero(solid[:, x])[0].max() if solid[:, x].any() else 0 for x in range(w)])
        xs_ = np.arange(w)
        slope = float(np.polyfit(xs_[8:w - 24], tops[8:w - 24], 1)[0])
        end_h = int(bots[6] - tops[6])
        extra = max(0, total_end - end_h)
        lum = (299 * a[..., 0].astype(int) + 587 * a[..., 1].astype(int) + 114 * a[..., 2].astype(int)) // 1000
        dots = None
        if name == 'wall_board':
            dark = solid & (lum < 60)
            comps = [c for c in label(dark) if len(c) > 4000]
            board = max(comps, key=len)
            bm = np.zeros_like(solid)
            for y, x in board:
                bm[y, x] = True
            v = np.array([y - slope * x for y, x in board])
            A_, B_ = float(v.min()), float(v.max())               # top and bottom lines of the board (y - slope * x)
            xl = int(min(x for y, x in board)); xr = int(max(x for y, x in board))
            bez = 7                                              # the bezel, in px of this picture
            dots = {'A': A_ + bez, 'B': B_ - bez, 'xl': xl + bez, 'xr': xr - bez}
        # the bands to stretch: above the board and below it (or the middle of a plain wall)
        if name == 'wall_board':
            et = int(round(extra * .4)); ea = extra - et
            a1 = lambda x: (tops[x] + 18, dots['A'] - 14 + slope * x)
            first = raise_wall(Image.fromarray(a, 'RGBA'), a1, et)
            b2 = lambda x: (dots['B'] + 14 + slope * x + et, bots[x] + et - 14)
            res = raise_wall(first, b2, ea)
            dots['A'] += et; dots['B'] += et
        else:
            res = raise_wall(Image.fromarray(a, 'RGBA'), lambda x: (tops[x] + 22, bots[x] - 14), extra)
        ra = np.array(res).astype(float)
        rl = .299 * ra[..., 0] + .587 * ra[..., 1] + .114 * ra[..., 2]
        wall = (ra[..., 3] > 127) & (rl > 95) & (ra[..., 0] > ra[..., 2] + 12)
        ref = np.percentile(rl[wall], 75)
        f = np.clip(rl / ref, .5, 1.12)[..., None]
        ra[..., :3] = np.where(wall[..., None], np.clip(np.array(PLASTER)[None, None, :] * f, 0, 255), ra[..., :3])
        res = Image.fromarray(ra.astype(np.uint8), 'RGBA')
        out[name] = res
        if name == 'wall_board':
            # the LED lattice: find the dots in the original-scale picture of the finished board
            ra2 = np.array(res).astype(int)
            l2 = (299 * ra2[..., 0] + 587 * ra2[..., 1] + 114 * ra2[..., 2]) // 1000
            info = {'face': None, 'slope': round(slope, 4), 'A': round(dots['A'], 1), 'B': round(dots['B'], 1), 'xl': dots['xl'], 'xr': dots['xr']}
    return out, info


def weather_layers(path):
    """{layer name: picture} cut from T3's weather sheet: cloud_light, cloud_dark, rain, snow, fog (fringes whitened), bolt, and
    icon_sun / moon / partly / cloud / rain / snow / thunder / fog."""
    img = Image.open(path).convert('RGBA')
    a = np.array(img)
    al = a[..., 3] > 8
    rows = al.any(axis=1)
    segs, y = [], 0
    while y < len(rows):
        if rows[y]:
            y1 = y
            while y1 < len(rows) and rows[y1]:
                y1 += 1
            segs.append((y, y1))
            y = y1
        else:
            y += 1
    if len(segs) != 7:
        return {}
    out = {}
    for name, (y0, y1) in zip(('cloud_light', 'cloud_dark', 'rain', 'snow', 'fog', 'bolt', 'icons'), segs):
        crop = img.crop((0, y0, img.width, y1))
        if name == 'icons':
            cols = np.array(crop.getchannel('A')).max(axis=0) > 8
            x, k = 0, 0
            names = ('sun', 'moon', 'partly', 'cloud', 'rain', 'snow', 'thunder', 'fog')
            while x < len(cols):
                if cols[x]:
                    x1 = x
                    gap = 0
                    while x1 < len(cols) and (cols[x1] or gap < 14):
                        gap = 0 if cols[x1] else gap + 1
                        x1 += 1
                    if k < 8:
                        out[f'icon_{names[k]}'] = _trim(crop.crop((x, 0, x1, crop.height)))
                    k += 1
                    x = x1
                else:
                    x += 1
        else:
            out[name] = _trim(crop)
    if 'fog' in out:                                              # the green / violet fringes of the fog: white-ish
        f = np.array(out['fog'])
        f[..., :3] = (232, 242, 246)
        out['fog'] = Image.fromarray(f, 'RGBA')
    return out


_WEATHER = {}


def _weather_layers():
    if 'v' not in _WEATHER:
        f = sheet_files().get('weather')
        _WEATHER['v'] = weather_layers(f) if f and f.is_file() else {}
    return _WEATHER['v']


def weather_band(layer, side, length_px, frame=0, offset=0.0, part='wall_tall', geo=None):
    """A weather layer ('cloud_light', 'cloud_dark', 'rain', 'snow', 'fog') as a band for one outer wall, made like outside_band:
    `length_px` wide along the wall, as tall as the glass, sheared like the wall; A cuts it with life.tall[side].mask. Clouds hang
    from the top of the glass, fog lies on the bottom, rain and snow fill the height (3 frames: `frame` 0..2, the drops shift a few
    px). Clouds and fog repeat mirrored along the wall. Same arguments, same file. Returns {file, w, h, edge0, slope, glass_h}."""
    layers = _weather_layers()
    parts_ = parts()['parts']
    if geo is None:                                               # ★21: the 2-tile window passes its own (taller) glass: {slope, h}
        win = Image.open(APP_HOME / parts_[f'{part}_{side}']['file']).convert('RGBA')
        geo = glass_geometry(win)
    PAD = 4
    hv = max(8, int(round(geo['h']))) + 2 * PAD
    L = int(length_px)
    k = geo['slope']
    H = hv + int(math.ceil(abs(k) * L)) + 1
    src = layers[layer]
    scale = {'cloud_light': .42, 'cloud_dark': .55, 'fog': .42}.get(layer)
    if scale:
        sh = max(8, int(hv * scale))
        unit = src.resize((max(8, round(src.width * sh / src.height)), sh), Image.LANCZOS)
        if layer != 'fog':                                          # the clouds' flat underside fades out
            ua = np.array(unit).astype(float)
            ramp = np.clip((sh - 1 - np.arange(sh)) / (sh * .35), 0, 1)[:, None]
            ua[..., 3] *= ramp
            unit = Image.fromarray(ua.astype(np.uint8), 'RGBA')
        tile = Image.new('RGBA', (L, hv), (0, 0, 0, 0))
        x, n = -int((offset % 2.0) * unit.width), 0
        y = hv - unit.height if layer == 'fog' else 0
        while x < L:
            tile.alpha_composite(unit if n % 2 == 0 else ImageOps.mirror(unit), (x, y)) if x >= 0 else tile.alpha_composite(unit if n % 2 == 0 else ImageOps.mirror(unit), (0, y), (-x, 0))
            x += unit.width
            n += 1
    else:                                                          # rain, snow: tile the layer over the height, shift per frame
        sc = .8 if layer == 'rain' else .7
        unit = src.resize((max(8, round(src.width * sc)), max(8, round(src.height * sc))), Image.LANCZOS)
        step = 5 if layer == 'rain' else 3
        tile = Image.new('RGBA', (L, hv), (0, 0, 0, 0))
        dy = frame * step
        for yy in range(-unit.height + dy, hv, unit.height):
            x = -(frame * step)
            n = 0
            while x < L:
                u_ = unit if n % 2 == 0 else ImageOps.mirror(unit)
                tile.alpha_composite(u_, (max(0, x), max(0, yy)), (max(0, -x), max(0, -yy)))
                x += unit.width
                n += 1
    tall = Image.new('RGBA', (L, H), (0, 0, 0, 0))
    tall.paste(tile, (0, 0))
    s0 = 0.0 if k >= 0 else -k * L
    out = tall.transform((L, H), Image.AFFINE, (1, 0, 0, -k, 1, -s0), Image.BICUBIC)
    return {'file': write_png(out, 'furniture', f'wx_{layer}_{side}_{frame}'), 'w': out.width, 'h': out.height,
            'edge0': [0, round(s0 + PAD, 1)], 'slope': k, 'glass_h': hv - 2 * PAD}


def sheared_icon(img, side, size, win=None):
    """An icon sheared like the wall (y shifts by slope * x), scaled to `size` px tall; the wall's slope is the glass edge's."""
    if win is None:
        win = Image.open(APP_HOME / parts()['parts'][f'wall_tall_{side}']['file']).convert('RGBA')
    k = glass_geometry(win)['slope']
    im = img.resize((max(1, round(img.width * size / img.height)), size), Image.LANCZOS)
    w, h = im.size
    H = h + int(math.ceil(abs(k) * w)) + 1
    tall = Image.new('RGBA', (w, H), (0, 0, 0, 0))
    tall.paste(im, (0, 0))
    s0 = 0.0 if k >= 0 else -k * w
    return tall.transform((w, H), Image.AFFINE, (1, 0, 0, -k, 1, -s0), Image.BICUBIC)


def glass_mask(win):
    """The glass of a wall-window picture (its blue panes, the dark frame and mullions left out), a little inside the frame."""
    a = np.array(win).astype(int)
    r, g, b, al = (a[..., i] for i in range(4))
    glass = (al > 200) & (b > r + 18) & (b > g + 4)
    for _ in range(2):
        glass = _grow4(glass)
    for _ in range(2):
        glass = ~_grow4(~glass)
    lum = (299 * r + 587 * g + 114 * b) // 1000
    glass &= (al > 200) & ((lum > 95) | (b > r + 30))
    for _ in range(1):                                           # close hairline gaps beside the mullions
        glass = _grow4(glass)
    for _ in range(1):
        glass = ~_grow4(~glass)
    holes = ~glass & (al > 127)
    for comp in label(holes):                                     # small enclosed specks inside a pane (a highlight, a corner dot): glass too
        if len(comp) < 90:
            for y, x in comp:
                glass[y, x] = True
    return ~_grow4(~glass)


def wall_frame(win):
    """The window part with its glass made transparent: the wall's frame; same size and foot."""
    m = glass_mask(win)
    for _ in range(1):
        m = _grow4(m)
    a = np.array(win)
    a[m, 3] = 0
    return Image.fromarray(a, 'RGBA')


def glass_geometry(win):
    """Where the glass lies in a window part: x0, x1, y of its top edge at x0, the slope of that edge (px per px), its vertical height."""
    m = glass_mask(win)
    ys, xs = np.nonzero(m)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    cols = [(x, int(np.nonzero(m[:, x])[0].min()), int(np.nonzero(m[:, x])[0].max())) for x in range(x0, x1) if m[:, x].any()]
    k = float(np.polyfit([c[0] for c in cols], [c[1] for c in cols], 1)[0])
    top0 = float(np.polyval(np.polyfit([c[0] for c in cols], [c[1] for c in cols], 1), x0))
    hv = float(np.mean([c[2] - c[1] for c in cols])) + 1
    return {'x0': x0, 'x1': x1, 'top_y0': round(top0, 1), 'slope': round(k, 4), 'h': round(hv, 1)}


def _disc_box(photo, time):
    """Box (x0, y0, x1, y1) of the moon (night) or the sun (morning, evening) in the view, or None."""
    a = np.array(photo).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (299 * r + 587 * g + 114 * b) // 1000
    if time == 'night':
        m = (lum > 225) & (r > 200) & (g > 200) & (b > 140)
    elif time in ('morning', 'evening'):
        m = (r > 245) & (g > 200) & (b < 205)
    else:
        return None
    m[int(m.shape[0] * .85):] = False
    best = None
    for comp in label(m):
        if len(comp) > 150 and (best is None or len(comp) > len(best)):
            best = comp
    if best is None:
        return None
    ys, xs = zip(*best)
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def _without_disc(photo, box, pad=12):
    """The view with the moon / sun painted out: every row of the box is filled across from the sky on its left to the sky on its right."""
    a = np.array(photo).astype(float)
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = max(1, x0 - pad), max(0, y0 - pad), min(a.shape[1] - 2, x1 + pad), min(a.shape[0], y1 + pad)
    for y in range(y0, y1):
        l, r = a[y, x0 - 1], a[y, x1 + 1]
        for x in range(x0, x1 + 1):
            f = (x - x0 + 1) / (x1 - x0 + 2)
            a[y, x] = l * (1 - f) + r * f
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')


def _grade(img, time):
    """Make the four times of day read at a glance: a day with a strong blue sky and darker, clearer buildings, a warm morning,
    an orange evening, a deep night (the lit windows stay bright)."""
    a = np.array(img).astype(float)
    h = a.shape[0]
    lum = (.299 * a[..., 0] + .587 * a[..., 1] + .114 * a[..., 2])[..., None]
    sat, con, bright, tint = {'day': (1.3, 1.12, 1.03, None), 'morning': (1.15, 1.08, 1.0, ((255, 200, 150), .14)),
                              'evening': (1.2, 1.1, .98, ((255, 130, 80), .10)), 'night': (1.15, 1.1, .82, None)}[time]
    a = lum + (a - lum) * sat
    a = (a - 128) * con + 128
    a = a * bright
    if time == 'day':                                            # the buildings (the lower part) a little darker than the sky: clear outlines
        ramp = np.clip((np.arange(h) / h - .5) / .3, 0, 1)[:, None, None]
        a = a * (1 - .20 * ramp)
    if tint:
        a = a * (1 - tint[1]) + np.array(tint[0], float)[None, None, :] * tint[1]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')


def outside_band(time, side, length_px, offset=0.0, part='wall_tall', geo=None):
    """A long band of the T3 view for one outer wall: `length_px` wide along the wall, sheared like the wall (slope of the
    glass edge of wall_window_<side>), as tall as the glass; the view repeats mirrored if the wall is longer than one picture, and
    starts `offset` pictures in (left and right walls use different offsets, so they show different parts). The file name carries a
    content hash: the same arguments give the same file. Returns {file, w, h, edge0: [x, y] (the top edge at the band's left end),
    slope, glass_h}; line the band's top edge up with the glass's top edge on the wall."""
    parts_ = parts()['parts']
    if geo is None:                                               # ★21: the 2-tile window passes its own (taller) glass: {slope, h}
        win = Image.open(APP_HOME / parts_[f'{part}_{side}']['file']).convert('RGBA')
        geo = glass_geometry(win)
    PAD = 4                                                       # the band reaches PAD px above and below the glass: it ends under the frame, no gap
    hv = max(8, int(round(geo['h']))) + 2 * PAD
    photo = Image.open(sheet_files()[f'out_{time}']).convert('RGB')
    photo = photo.crop((0, 0, photo.width, int(photo.height * .64)))          # the sky above, the tops of the far buildings below: a view from a high floor, no ground or trees
    pw = max(8, round(photo.width * hv / photo.height))
    box = _disc_box(photo, time)
    clean_photo = _without_disc(photo, box) if box else photo
    unit_o = _grade(photo.resize((pw, hv), Image.LANCZOS), time)               # with the moon / sun
    unit_c = _grade(clean_photo.resize((pw, hv), Image.LANCZOS), time)         # without it
    L = int(length_px)
    strip = Image.new('RGB', (L, hv))
    x0_, xs_, k_ = -int((offset % 2.0) * pw), [], 0
    while x0_ + k_ * pw < L:
        xs_.append(x0_ + k_ * pw)
        k_ += 1
    pick = -1 if time == 'night' else len(xs_) // 2             # the sun appears once per wall (middle picture); the night has no moon here: the mod draws one moon with its phase
    for k_, x in enumerate(xs_):
        u = unit_o if k_ == pick else unit_c
        strip.paste(u if k_ % 2 == 0 else ImageOps.mirror(u), (x, 0))
    k = geo['slope']
    H = hv + int(math.ceil(abs(k) * L)) + 1
    tall = Image.new('RGBA', (L, H), (0, 0, 0, 0))
    tall.paste(strip.convert('RGBA'), (0, 0))
    s0 = 0.0 if k >= 0 else -k * L
    out = tall.transform((L, H), Image.AFFINE, (1, 0, 0, -k, 1, -s0), Image.BICUBIC)
    a = np.array(out)
    a[..., 3] = np.where(a[..., 3] > 127, 255, 0)
    out = Image.fromarray(a, 'RGBA')
    return {'file': write_png(out, 'furniture', f'band_{time}_{side}'), 'w': out.width, 'h': out.height,
            'edge0': [0, round(s0 + PAD, 1)], 'slope': k, 'glass_h': hv - 2 * PAD}


def masked_outside(view, win):
    """The outside picture stretched over the window part's glass box and cut to the glass: same size and foot as the part."""
    m = glass_mask(win)
    ys, xs = np.nonzero(m)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    pic = view.resize((x1 - x0, y1 - y0), Image.LANCZOS)
    out = Image.new('RGBA', win.size, (0, 0, 0, 0))
    out.paste(pic, (x0, y0))
    a = np.array(out)
    a[..., 3] = np.where(m, 255, 0)
    return Image.fromarray(a, 'RGBA')


def life_parts(pieces, manifest, cw, ch):
    """Seat meaning (empty chair), a resting armchair, the outside of the windows, the bird, the ceiling light, the day's tints."""
    life = {'note': 'still pictures only: the mod chooses which to show. `empty` pictures are on the pose canvas (same anchor as the person).'}
    if 'chair_empty' in pieces:
        ec = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        ec.alpha_composite(pieces['chair_empty'], ((cw - pieces['a_type_pc'].width) // 2, ch - pieces['a_type_pc'].height))
        life['empty_chair'] = {'file': write_png(ec, 'furniture', 'empty_chair_pc'),
                               'flip': write_png(ImageOps.mirror(ec), 'furniture', 'empty_chair_pc_flip'),
                               'anchor': manifest['people_anchor'].get('type_pc'),
                               'note': 'the laptop poses\' chair, no person (T3 sheet fitted onto the pose\'s chair); same canvas, same foot (bottom centre) as people poses; flip faces the other way'}
    elif 'a_type_pc' in pieces and 'chair' in manifest['parts']:
        ec = empty_chair_pc(pieces, Image.open(APP_HOME / manifest['parts']['chair']['file']).convert('RGBA'), cw, ch)
        life['empty_chair'] = {'file': write_png(ec, 'furniture', 'empty_chair_pc'),
                               'flip': write_png(ImageOps.mirror(ec), 'furniture', 'empty_chair_pc_flip'),
                               'anchor': manifest['people_anchor'].get('type_pc'), 'note': 'stand-in built from the desk chair'}
    if 'armchair_empty' in pieces:
        ar = pieces['armchair_empty']
        oc = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        oc.alpha_composite(ar, ((cw - ar.width) // 2, ch - ar.height))
        life['empty_armchair'] = {'file': write_png(oc, 'furniture', 'empty_armchair'),
                                  'flip': write_png(ImageOps.mirror(oc), 'furniture', 'empty_armchair_flip'),
                                  'note': 'the sitting pose\'s armchair, nobody in it (T3 sheet, feet on the pose\'s feet): same canvas and foot as the `sofa` pose / its flip'}
    elif 'sofa' in pieces and 'a_sofa' in pieces:
        ar = empty_armchair(pieces['sofa'], pieces['a_sofa'])
        oc = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        oc.alpha_composite(ar, ((cw - ar.width) // 2, ch - ar.height))
        life['empty_armchair'] = {'file': write_png(oc, 'furniture', 'empty_armchair'),
                                  'flip': write_png(ImageOps.mirror(oc), 'furniture', 'empty_armchair_flip'), 'note': 'stand-in built from the sofa'}
    out_files = sheet_files()
    photos = {t_: Image.open(out_files[f'out_{t_}']).convert('RGB') for t_ in TIMES if out_files.get(f'out_{t_}') and out_files[f'out_{t_}'].is_file()}
    if len(photos) == 4:
        life['outside'] = {t_: {sd: write_png(photos[t_].resize((320, 180), Image.LANCZOS), 'furniture', f'outside_{t_}') for sd in ('left', 'right')} for t_ in TIMES}
        life['outside_size'] = [320, 180]
        life['outside_note'] = 'T3 pictures (16:9), reused by every window: one per time of day; clip to the window rect (outside_masked is already cut to the glass)'
    else:
        life['outside'] = {t: {sd: write_png(outside_view(t, sd), 'furniture', f'outside_{t}_{sd}') for sd in ('left', 'right')} for t in TIMES}
        life['outside_size'] = [160, 100]
        life['outside_note'] = 'stand-ins until the T3 pictures are present'
    if 'wall_window_left' in manifest['parts']:
        wins = {sd: Image.open(APP_HOME / manifest['parts'][f'wall_window_{sd}']['file']).convert('RGBA') for sd in ('left', 'right')}
        if len(photos) == 4:
            life['outside_masked'] = {t_: {sd: write_png(slanted_outside(photos[t_] if sd == 'left' else ImageOps.mirror(photos[t_]), wins[sd]), 'furniture', f'outside_m_{t_}_{sd}') for sd in ('left', 'right')} for t_ in TIMES}
        else:
            life['outside_masked'] = {t_: {sd: write_png(masked_outside(outside_view(t_, sd), wins[sd]), 'furniture', f'outside_m_{t_}_{sd}') for sd in ('left', 'right')} for t_ in TIMES}
        life['outside_masked_note'] = ('8 pictures, one per (time, side): the size and foot of wall_window_<side>, glass only (frame and mullions stay '
                                       'transparent), the T3 picture sheared to the glass: lay each on its window part at the same position, above the part')
    if 'wall_window_left' in manifest['parts']:
        life['wall_frames'] = {}
        life['glass'] = {}
        for sd in ('left', 'right'):
            win = Image.open(APP_HOME / manifest['parts'][f'wall_window_{sd}']['file']).convert('RGBA')
            wf = wall_frame(win)
            life['wall_frames'][sd] = {'file': write_png(wf, 'furniture', f'wall_frame_{sd}'), 'w': wf.width, 'h': wf.height,
                                       'foot': list(manifest['parts'][f'wall_window_{sd}']['foot'])}
            life['glass'][sd] = glass_geometry(win)
        life['wall_frames_note'] = ('wall_window_<side> with the glass transparent (same size and foot); life.glass[side] = where the glass lies '
                                    'in the part (x0, x1, top_y0 = y of its top edge at x0, slope, h); hakoniwa_sprites.outside_band(time, side, length_px, offset) builds the view band')
    if 'wall_tall_left' in manifest['parts']:                    # the tall outer walls: the frame, the glass mask and where the glass lies
        life['tall'] = {}
        for sd in ('left', 'right'):
            tw = Image.open(APP_HOME / manifest['parts'][f'wall_tall_{sd}']['file']).convert('RGBA')
            gm = _grow4(glass_mask(tw))                          # exactly the region wall_frame makes transparent: no gap between the view and the frame
            ma = np.zeros(tw.size[::-1] + (4,), np.uint8)
            ma[..., :3] = 255
            ma[..., 3] = np.where(gm, 255, 0)
            life['tall'][sd] = {'frame': write_png(wall_frame(tw), 'room', f'wall_tall_frame_{sd}'),
                                'mask': write_png(Image.fromarray(ma, 'RGBA'), 'room', f'wall_tall_glass_{sd}'),
                                'glass': glass_geometry(tw), 'w': tw.width, 'h': tw.height, 'foot': list(manifest['parts'][f'wall_tall_{sd}']['foot'])}
        life['tall_note'] = ('tall outer wall part wall_tall_<side> (plaster, windows from the apron to near the ceiling): frame = the part with the glass transparent; '
                             'mask = the glass shape (white, same size and foot as the part) to cut the view band with; glass = x0, x1, top_y0, slope, h. '
                             'outside_band() now uses these parts and crops the photo to sky + the tops of far buildings')
    wl = _weather_layers()
    if wl and 'wall_tall_left' in manifest['parts']:
        wx = {'icons': {}, 'layers': ['cloud_light', 'cloud_dark', 'rain', 'snow', 'fog'], 'frames': {'rain': 3, 'snow': 3}}
        for nm, im in wl.items():
            if nm.startswith('icon_') or nm == 'bolt':
                key = nm[5:] if nm.startswith('icon_') else nm
                size = 30 if nm.startswith('icon_') else 52
                flat = im.resize((max(1, round(im.width * size / im.height)), size), Image.LANCZOS)
                ent = {'file': write_png(flat, 'furniture', f'wx_{nm}'), 'w': flat.width, 'h': flat.height, 'sheared': {}}
                for sd in ('left', 'right'):
                    sh_ = sheared_icon(im, sd, size, Image.open(APP_HOME / manifest['parts'][f'wall_tall_{sd}']['file']).convert('RGBA'))
                    ent['sheared'][sd] = {'file': write_png(sh_, 'furniture', f'wx_{nm}_{sd}'), 'w': sh_.width, 'h': sh_.height}
                wx['icons'][key] = ent
        wx['kinds'] = {'clear': [], 'partly': ['cloud_light'], 'cloudy': ['cloud_light', 'cloud_dark'], 'fog': ['fog'],
                       'rain': ['cloud_dark', 'rain'], 'snow': ['cloud_light', 'snow'], 'thunder': ['cloud_dark', 'rain']}
        wx['note'] = ('layers are made by hakoniwa_sprites.weather_band(layer, side, length_px, frame, offset) -> {file, w, h, edge0, slope, glass_h}, '
                      'the same build as outside_band (cut it with life.tall[side].mask); kinds = which layers make a weather (the bolt is a flash for thunder, '
                      'laid over the window); icons are 30 px tall (the bolt 52 px); sheared[side] = the icon sheared like that wall')
        life['weather'] = wx
    if 'bird_d0' in pieces:
        fr = bird_frames(pieces)
        life['bird'] = {'file': write_png(fr['bird_d0'], 'furniture', 'bird_d0'), 'w': fr['bird_d0'].width, 'h': fr['bird_d0'].height,
                        'dark': [write_png(fr[f'bird_d{i}'], 'furniture', f'bird_d{i}') for i in range(4)],
                        'light': [write_png(fr[f'bird_l{i}'], 'furniture', f'bird_l{i}') for i in range(4)],
                        'dark_flip': [write_png(ImageOps.mirror(fr[f'bird_d{i}']), 'furniture', f'bird_d{i}_flip') for i in range(4)],
                        'light_flip': [write_png(ImageOps.mirror(fr[f'bird_l{i}']), 'furniture', f'bird_l{i}_flip') for i in range(4)],
                        'note': '4 wing frames, two shades (dark: day; pale: morning / evening / night), facing right; *_flip face left; all on one canvas of w x h'}
    else:
        life['bird'] = {'file': write_png(bird_shadow(), 'furniture', 'bird'), 'w': 26, 'h': 12}
    life['hours'] = LIFE_HOURS
    life['tints'] = {t: {'color': c, 'alpha': a_} for t, (c, a_) in LIFE_TINTS.items()}
    life['tints_note'] = 'cover the whole scene with a flat rect of `color` at `alpha` (no picture); hours are [from, to) local time'
    w2i = manifest.pop('_window2', None)
    if w2i:
        life['window2'] = w2i
        life['window2_note'] = ('a 2-tile window in one piece (parts.window2, plaster, one thin mullion), its frame with the glass transparent (frame) and the glass shape (mask, white, '
                                'same size and foot): cut the view band with the mask and lay the frame over it; wall_plain1 = a 1-tile plain wall between windows, wall_post = a back corner post')
    mi = manifest.pop('_moon', None)
    if mi:
        life['moon_phases'] = mi['phases']
        life['moon_size'] = mi['size']
        life['stars'] = mi['stars']
        life['moon_note'] = ('moon_phases: 8 pictures (same size, round, centre = the middle of the picture) from the new moon on: new, crescent, first quarter, waxing gibbous, '
                             'full, waning gibbous, last quarter, waning crescent; the night view (outside_band night) has no moon: the mod draws it. '
                             'stars: star_dot / plus / sparkle / big / shoot (a shooting star), small pictures, centre = foot')
    manifest['life'] = life


def code_strip(w, h):
    """A tall picture (3 x the face height) of code lines on the screen's dark blue, repeating every h pixels, so the mod can
    clip it to the screen face and loop its `top` upward by h (or 2h) without a seam."""
    rng = random.Random(7)
    pal = [(240, 160, 48), (245, 210, 66), (53, 199, 232), (232, 68, 63), (159, 176, 255), (120, 224, 176)]
    n = 9
    pitch = max(2, h // n)
    one = Image.new('RGBA', (w, h), (27, 34, 52, 255))
    d = ImageDraw.Draw(one)
    for i in range(n):
        y = i * pitch + max(1, pitch // 4)
        x = int(w * .06) + int(w * .06) * rng.choice((0, 0, 1, 2))
        for _ in range(rng.choice((2, 3, 3, 4))):
            seg = int(w * rng.uniform(.08, .26))
            if x + seg > w - 2:
                break
            d.rectangle([x, y, x + seg, y + max(1, pitch // 2 - 1)], fill=rng.choice(pal) + (255,))
            x += seg + max(2, int(w * .03))
    strip = Image.new('RGBA', (w, h * 3))
    for i in range(3):
        strip.paste(one, (0, i * h))
    return strip


def hand_point(canvas_img):
    """Fingertip centre of a typing pose: the skin pixels to the right of the torso at keyboard height."""
    px = np.array(canvas_img)
    r, g, b = (px[..., i].astype(int) for i in range(3))
    skin = (px[..., 3] > ALPHA_MIN) & (r > g + 12) & (g > b + 6) & (r > 170)
    ys, xs = np.nonzero(skin)
    bb = canvas_img.getchannel('A').getbbox()
    top, bot, left, right = bb[1], bb[3], bb[0], bb[2]
    sel = (ys > top + .22 * (bot - top)) & (ys < top + .62 * (bot - top)) & (xs > left + .55 * (right - left))
    if not sel.any():
        return None
    return [round(float(xs[sel].mean()), 1), round(float(ys[sel].mean()), 1)]


# ---------------------------------------------------------------- grid: footprints and anchors (task2-grid)
# One floor tile, in pixels of the furniture / room sheets (both are drawn at about the same scale): a person stands on
# one tile, a chair is one tile.  office.py scales everything by one factor, so its tile is GRID_TW * scale wide.
GRID_TW, GRID_TH = 120, 60
# name -> (long, short, how).  how: 'x' = long along gx (down-right), 'run' = along whichever way the picture runs,
# 'sq' = as given.  Tiles on the long + short sides = picture width * .92 / (TW / 2); checked by `--grid-preview`.
FOOTPRINT = {
    'desk_nochair': (4, 1, 'x'), 'desk_free': (4, 1, 'x'), 'desk_off': (4, 1, 'x'), 'desk_on': (4, 1, 'x'),
    'desk_alert': (4, 1, 'x'), 'chair': (1, 1, 'sq'), 'plant': (1, 1, 'sq'), 'trash': (1, 1, 'sq'),
    'bookshelf': (3, 1, 'run'), 'sofa': (4, 1, 'run'), 'reception': (3, 1, 'run'), 'table': (2, 2, 'sq'),
    'partition_left': (3, 1, 'run'), 'partition_right': (3, 1, 'run'), 'partition_doorway': (3, 1, 'run'),
    'door_closed': (3, 1, 'run'), 'door_half': (3, 1, 'run'), 'door_open': (3, 1, 'run'),
    'entrance_closed': (3, 1, 'run'), 'entrance_half': (3, 1, 'run'), 'entrance_open': (3, 1, 'run'), 'wall_plain': (2, 1, 'run'), 'wall_light': (2, 1, 'run'),
    'cafe_table': (2, 2, 'sq'), 'cafe_counter': (3, 1, 'run'), 'cafe_chair': (1, 1, 'sq'), 'cafe_stool': (1, 1, 'sq'),
    'window2': (2, 1, 'run'), 'wall_plain1': (1, 1, 'run'), 'wall_post': (1, 1, 'sq'),
    'wall_board': (3, 1, 'run'), 'wall_plain3': (3, 1, 'run'),
    'doorway2': (4, 1, 'run'), 'door2_closed': (4, 1, 'run'), 'door2_half': (4, 1, 'run'), 'door2_open': (4, 1, 'run'),
    'store_bookshelf': (1, 1, 'sq'), 'store_steel': (1, 1, 'sq'), 'store_locker': (2, 1, 'run'), 'store_sideboard': (2, 1, 'run'),
    'store_cabinet': (1, 1, 'sq'), 'store_drawers': (2, 1, 'run'),
    **{p_: (1, 1, 'sq') for p_ in PLANT_ISO},
    **{p_: (1, 1, 'sq') for p_ in DECO_ISO},
    'equip_mfp': (1, 1, 'sq'), 'equip_printer': (1, 1, 'sq'), 'equip_water': (1, 1, 'sq'), 'equip_coffee': (1, 1, 'sq'), 'equip_vending': (1, 1, 'sq'),
    'equip_whiteboard': (2, 1, 'run'), 'equip_rack': (1, 1, 'sq'), 'equip_files': (1, 1, 'sq'), 'equip_coat': (1, 1, 'sq'), 'equip_lamp': (1, 1, 'sq'),
    'pole_y1': (1, 1, 'sq'), 'pole_x1': (1, 1, 'sq'), 'pole_y2': (2, 1, 'run'), 'pole_y3': (2, 1, 'run'), 'pole_x2': (2, 1, 'run'), 'pole_x3': (2, 1, 'run'),
    'pole_l': (2, 2, 'sq'), 'sign_board': (1, 1, 'sq'),
    'win_approval_empty': (4, 2, 'x'), 'win_approval_full': (4, 2, 'x'), 'win_counter_empty': (4, 2, 'x'),
    'win_counter_full': (4, 2, 'x'),
    **{n_: (4, 2, 'run') for n_ in WIN_FRONT_PARTS},
}
DESK_SAME = ('desk_nochair', 'desk_free', 'desk_off', 'desk_on', 'desk_alert')   # drawn on the same pixel grid
SWING = {'entrance_closed': 2, 'entrance_half': 2, 'entrance_open': 2, 'door_closed': 2, 'door_half': 2, 'door_open': 2, 'door2_closed': 2, 'door2_half': 2, 'door2_open': 2}      # tiles in front of a door that must stay free


def foot_of(img):
    """(x, y) of the lowest opaque point of a picture (x = middle of the lowest 3 rows): the front corner of its base."""
    a = np.array(img.convert('RGBA'))[..., 3] > 128
    ys = np.nonzero(a.any(axis=1))[0]
    if not len(ys):
        return img.width / 2, img.height - 1
    y = int(ys.max())
    xs = np.nonzero(a[max(0, y - 2):y + 1].any(axis=0))[0]
    return float((xs.min() + xs.max()) / 2), y


def runs_down_right(img):
    a = np.array(img.convert('RGBA'))[..., 3] > 40
    ys = np.nonzero(a.any(axis=1))[0]
    top = int(ys.min())
    xs = np.nonzero(a[top:top + max(3, img.height // 12)].any(axis=0))[0]
    return (xs.min() + xs.max()) / 2 < img.width / 2


def tile_anchor(foot, a, b):
    """Pixel (in the picture) of the centre of the reference tile (0, 0) of an a x b footprint (tiles i < a along gx,
    j < b along gy) whose front corner is at `foot`.  Tile (i, j) has its centre at anchor + ((i-j)*TW/2, (i+j)*TH/2)."""
    return [round(foot[0] - (a - b) * GRID_TW / 2, 1), round(foot[1] - (a + b - 1) * GRID_TH / 2, 1)]


def footprint_for(name, img):
    a, b, how = FOOTPRINT[name]
    if how == 'run' and not runs_down_right(img):
        a, b = b, a
    return a, b


def widen_run(img, cut, mode='full', sw=30):
    """Make a piece that runs along a wall one tile (2 x `sw` px along the axis) longer: the part right of column `cut` moves
    one tile along the piece's own axis, and the strip of width `sw` just left of the cut is repeated twice into the gap (the
    lintel / panes are the same all along, so the edges run on). mode 'top': only the top 26 rows of each strip column (the
    lintel) are repeated, for pictures whose lower part holds swung leaves. Returns the picture."""
    a = np.array(img.convert('RGBA'))
    h, w = a.shape[:2]
    down = runs_down_right(img)
    sign = 1 if down else -1
    dx, dy = 2 * sw, sw * sign
    pad_t, pad_b = (0, dy) if down else (-dy, 0)
    out = np.zeros((h + pad_t + pad_b, w + dx, 4), np.uint8)
    oy = pad_t

    def put(src, x, y):
        m = src[..., 3] > 0
        reg = out[y:y + src.shape[0], x:x + src.shape[1]]
        reg[m] = src[m]
    put(a[:, :cut], 0, oy)
    strip = a[:, cut - sw:cut].copy()
    if mode == 'top':
        for x in range(strip.shape[1]):
            ys = np.nonzero(strip[:, x, 3] > 0)[0]
            if len(ys):
                strip[ys.min() + 26:, x, 3] = 0
    for r in (1, 2):
        put(strip, cut + (r - 1) * sw, oy + (sw // 2) * r * sign)
    put(a[:, cut:], cut + dx, oy + dy)
    return Image.fromarray(out, 'RGBA')


def split_depth(img, cx):
    """(back, front): the piece cut at column `cx` into two pictures of the same size. A person walks through between them:
    the end of the run that is farther from the viewer is `back`."""
    a = np.array(img.convert('RGBA'))
    left, right = a.copy(), a.copy()
    left[:, cx:, 3] = 0
    right[:, :cx, 3] = 0
    L, R = Image.fromarray(left, 'RGBA'), Image.fromarray(right, 'RGBA')
    return (L, R) if runs_down_right(img) else (R, L)


DOOR2_CUTS = {'partition_doorway': ('doorway2', .5, 'full'), 'door_closed': ('door2_closed', .39, 'full'), 'door_half': ('door2_half', .62, 'full'), 'door_open': ('door2_open', .5, 'full')}


def rack_leds(src, k):
    """Positions (x, y in the scaled picture) of the small green / yellow / orange lights on the server rack's front."""
    a = np.array(src).astype(int)
    r, g, b, al = (a[..., i] for i in range(4))
    mx, mn = a[..., :3].max(axis=2), a[..., :3].min(axis=2)
    lit = (al > 200) & (mx > 170) & (mx - mn > 110) & ((g > b + 60))      # green and yellow (blue bars have b > g)
    pts = []
    for comp in label(lit):
        if 3 <= len(comp) <= 160:
            ys, xs = zip(*comp)
            pts.append([int(round(np.mean(xs) * k)), int(round(np.mean(ys) * k))])
    return sorted(pts, key=lambda p_: (p_[1], p_[0]))


def _periodic_noise(n, rng):
    """Smooth value noise on an n x n lattice that wraps around (bicubic-ish via smoothstep), as a function of (u, v) in [0, 1)."""
    g = rng.random((n, n))
    def f(u, v):
        x, y = (u % 1.0) * n, (v % 1.0) * n
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = x - x0, y - y0
        fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        x0, y0, x1, y1 = x0 % n, y0 % n, (x0 + 1) % n, (y0 + 1) % n
        return (g[y0, x0] * (1 - fx) + g[y0, x1] * fx) * (1 - fy) + (g[y1, x0] * (1 - fx) + g[y1, x1] * fx) * fy
    return f


def seamless_concrete(mean, tile_w=282, seed=7):
    """One floor tile (a flat diamond) of plain concrete: the tile's mean colour with soft patches and fine grain, all of it a
    function of the position inside the tile that wraps around (u, v: the two floor axes), so neighbouring tiles continue each other
    edge to edge: no seam, no repeating pattern."""
    w, h = tile_w, tile_w // 2
    y, x = np.mgrid[0:h, 0:w].astype(float)
    xc, yc = (x + .5 - w / 2) / w, (y + .5) / h
    u, v = yc + xc, yc - xc                                       # the floor axes: 0..1 inside the diamond
    rng = np.random.default_rng(seed)
    lum = np.zeros((h, w))
    for n, amp in ((4, .010), (9, .016), (17, .018), (33, .014)):   # patches, from large to small
        lum += (_periodic_noise(n, rng)(u, v) - .5) * 2 * amp
    grain = rng.random((72, 72))
    lum += (grain[(np.floor((u % 1) * 72).astype(int)) % 72, (np.floor((v % 1) * 72).astype(int)) % 72] - .5) * 2 * .012
    rgb = np.array(mean, float)[None, None, :] * (1.0 + lum[..., None])
    out = np.zeros((h, w, 4), np.uint8)
    out[..., :3] = np.clip(rgb, 0, 255)
    inside = (np.abs(x + .5 - w / 2) / (w / 2) + np.abs(y + .5 - h / 2) / (h / 2)) <= 1.0 + 2.2 / w      # a hair wider: no cracks between tiles
    out[..., 3] = np.where(inside, 255, 0)
    return Image.fromarray(out, 'RGBA')


def build_moon(path, size=44):
    """({phase pictures, 8, from the new moon on: new, crescent, first quarter, waxing gibbous, full, waning gibbous, last quarter, waning crescent},
    {star pictures}) cut from T3's sheet: every moon a round picture of the same size, centred, the dark glow ring of some of them cut off."""
    img = Image.open(path).convert('RGBA')
    a = np.array(img)
    al = a[..., 3] > 8
    rows = al.any(axis=1)
    segs, y = [], 0
    while y < len(rows):
        if rows[y]:
            y1 = y
            while y1 < len(rows) and rows[y1]:
                y1 += 1
            segs.append((y, y1))
            y = y1
        else:
            y += 1
    if len(segs) != 3:
        return [], {}

    def split(y0, y1, minw):
        cols = al[y0:y1].any(axis=0)
        out, x = [], 0
        while x < len(cols):
            if cols[x]:
                x1 = x
                gap = 0
                while x1 < len(cols) and (cols[x1] or gap < 6):
                    gap = 0 if cols[x1] else gap + 1
                    x1 += 1
                if x1 - x >= minw:
                    out.append((x, x1))
                x = x1
            else:
                x += 1
        return out
    cols = split(segs[1][0], segs[1][1], 60)
    if len(cols) != 8:
        return [], {}
    phases = []
    for x0, x1 in cols:
        pc = img.crop((x0, segs[1][0], x1, segs[1][1]))
        pa = np.array(pc.getchannel('A')) > 8
        ys, xs = np.nonzero(pa)
        cx, cy = (xs.min() + xs.max()) / 2.0, (ys.min() + ys.max()) / 2.0
        rad = 72.0                                                       # the moons are 144 px across; the full moon has a dark glow ring around it
        yy, xx = np.mgrid[0:pc.height, 0:pc.width]
        keep = ((xx - cx) ** 2 + (yy - cy) ** 2) <= rad ** 2
        arr = np.array(pc)
        arr[..., 3] = np.where(keep, arr[..., 3], 0)
        disc = Image.fromarray(arr, 'RGBA').crop((int(round(cx - rad)), int(round(cy - rad)), int(round(cx + rad)), int(round(cy + rad))))
        phases.append(disc.resize((size, size), Image.LANCZOS))
    stars = {}
    sc = split(segs[2][0], segs[2][1], 8)
    names = ['star_dot', 'star_plus', 'star_sparkle', 'star_big', 'star_shoot']
    sizes = {'star_dot': 4, 'star_plus': 9, 'star_sparkle': 13, 'star_big': 20, 'star_shoot': 16}      # px, the longer side... shooting star: its height
    if len(sc) >= 5:
        sc = sc[:2] + sc[2:3] + [(sc[3][0], sc[3][1])] + [(sc[-1][0], sc[-1][1])] if len(sc) == 5 else sc
    for nm, (x0, x1) in zip(names, sc[:5] if len(sc) >= 5 else sc):
        pc = _trim(img.crop((x0, segs[2][0], x1, segs[2][1])))
        longer = sizes[nm] if nm != 'star_shoot' else 34
        k = longer / max(pc.width, pc.height)
        stars[nm] = pc.resize((max(1, round(pc.width * k)), max(1, round(pc.height * k))), Image.LANCZOS)
    return phases, stars


def build_floors(sheet_path, tile_w=282):
    """The four floor tiles' top faces as flat diamonds (width `tile_w`, height half of it), plus three tinted carpets."""
    img = Image.open(sheet_path).convert('RGB')
    a = np.array(img).astype(int)
    nonwhite = (a.min(axis=2) < 238)
    cols = nonwhite.any(axis=0)
    boxes, x = [], 0
    while x < len(cols):                                                 # the tiles stand side by side: split at the empty columns
        if cols[x]:
            x1 = x
            while x1 < len(cols) and cols[x1]:
                x1 += 1
            ys = np.nonzero(nonwhite[:, x:x1].any(axis=1))[0]
            if x1 - x > 200:
                boxes.append((x, int(ys.min()), x1, int(ys.max()) + 1))
            x = x1
        else:
            x += 1
    if len(boxes) != 4:
        return {}
    out = {}
    for name, (x0, y0, x1, y1) in zip(('floor_carpet', 'floor_concrete', 'floor_oak', 'floor_smoke'), boxes):
        w = x1 - x0
        top = img.crop((x0, y0, x1, y1))
        inset = int(w * .075)                                           # inside the tile's rim (the thickness at the front edges)
        fw = w - 2 * inset
        fh = fw // 2
        cx, cy = (x0 + x1) / 2, y0 + (w // 4) + 1                       # centre of the top face (its height is w / 2 from y0)
        face = img.crop((int(round(cx - fw / 2)), int(round(cy - fh / 2)), int(round(cx + fw / 2)), int(round(cy + fh / 2))))
        face = face.resize((tile_w, tile_w // 2), Image.LANCZOS).convert('RGBA')
        mask = Image.new('L', face.size, 0)
        ImageDraw.Draw(mask).polygon([(0, face.height / 2), (face.width / 2, 0), (face.width - 1, face.height / 2), (face.width / 2, face.height - 1)], fill=255)
        face.putalpha(mask)
        out[name] = face
    cc = np.array(out['floor_concrete']).astype(float)
    out['floor_concrete'] = seamless_concrete(cc[cc[..., 3] > 0][:, :3].mean(axis=0), tile_w)      # not the sheet's own tile: it shows its pattern when repeated
    carpet = out['floor_carpet']
    ca = np.array(carpet).astype(float)
    lum = ca[..., :3].mean(axis=2)
    ca[..., :3] = np.clip(ca[..., :3] * (1.0 + (86.0 - lum[ca[..., 3] > 0].mean()) / max(1.0, lum[ca[..., 3] > 0].mean()) * .9), 0, 255)   # a little lighter: people sink on a dark floor
    carpet = Image.fromarray(ca.astype(np.uint8), 'RGBA')
    out['floor_carpet'] = carpet
    for tag, tint in (('navy', (52, 74, 128)), ('green', (46, 100, 76)), ('maroon', (110, 52, 62))):
        c = np.array(carpet).astype(float)
        l = c[..., :3].mean(axis=2, keepdims=True)
        tinted = np.array(tint)[None, None, :] * (l / max(1.0, l[c[..., 3] > 0].mean())) * 1.0
        c[..., :3] = c[..., :3] * .62 + tinted * .38
        out[f'floor_carpet_{tag}'] = Image.fromarray(np.clip(c, 0, 255).astype(np.uint8), 'RGBA')
    return out


def add_door2(manifest, pieces):
    """Double-width (2 tiles open) versions of the doorway and the three door pictures, with `back` / `front` halves."""
    for src, (name, frac, mode) in DOOR2_CUTS.items():
        base = pieces.get(src)
        if base is None:
            continue
        cut = int(base.width * frac)
        img = widen_run(base, cut, mode)
        folder = 'room'
        manifest['parts'][name] = {'file': write_png(img, folder, name), 'w': img.width, 'h': img.height, 'foot': [img.width // 2, img.height - 1]}
        back, front = split_depth(img, int(img.width / 2))
        manifest['parts'][name]['back'] = {'file': write_png(back, folder, f'{name}_back')}
        manifest['parts'][name]['front'] = {'file': write_png(front, folder, f'{name}_front')}
        manifest['parts'][name]['split_x'] = int(img.width / 2)


def add_grid(manifest):
    """footprint (tile offsets from the reference tile), anchor (its centre, pixels in the picture) and swing."""
    manifest['grid'] = {'tw': GRID_TW, 'th': GRID_TH, 'note': 'sheet pixels; tile (i, j) centre = anchor + ((i-j)*tw/2, (i+j)*th/2); +i = down-right (gx), +j = down-left (gy)'}
    for name in FOOTPRINT:
        part = manifest['parts'].get(name)
        if not part:
            continue
        img = Image.open(APP_HOME / part['file']).convert('RGBA')
        a, b = footprint_for(name, img)
        part['footprint'] = [[i, j] for i in range(a) for j in range(b)]
        part['anchor'] = tile_anchor(foot_of(img), a, b)
        if name in DESK_SAME and 'desk_nochair' in manifest['parts']:   # these pictures share the chair-less desk's pixels
            nc = manifest['parts']['desk_nochair']
            nimg = Image.open(APP_HOME / nc['file']).convert('RGBA')
            base = tile_anchor(foot_of(nimg), 4, 1)
            off = part.get('offset', [0, 0]) if name == 'desk_alert' else [0, 0]
            part['anchor'] = [round(base[0] - off[0], 1), round(base[1] - off[1], 1)]
        if name in SWING:     # the swing area is in front of the door leaf
            n = SWING[name]
            part['swing'] = [[i, j] for i in range(a, a + n) for j in range(b)] if b > a else [[i, j] for i in range(a) for j in range(b, b + n)]
    corner = manifest['parts'].get('partition_corner')
    if corner:
        img = Image.open(APP_HOME / corner['file']).convert('RGBA')
        corner['footprint'] = [[0, 0], [1, 0], [0, 1]]
        corner['anchor'] = tile_anchor(foot_of(img), 2, 2)
    d, c = manifest['parts'].get('desk_nochair'), manifest['parts'].get('chair')
    if d and c and 'offset' in c:      # where the chair stands in the desk's tile coordinates
        cf = foot_of(Image.open(APP_HOME / c['file']).convert('RGBA'))
        c['footprint'] = [[0, 0]]
        c['anchor'] = tile_anchor(cf, 1, 1)
        cx = c['offset'][0] + c['anchor'][0] - d['anchor'][0]
        cy = c['offset'][1] + c['anchor'][1] - d['anchor'][1]
        diff, tot = cx / (GRID_TW / 2), cy / (GRID_TH / 2)
        i, j = (tot + diff) / 2, (tot - diff) / 2
        manifest['desk_chair_tile'] = {'tile': [round(i), max(1, round(j))], 'exact': [round(i, 2), round(j, 2)],
                                       'note': 'the chair stands tucked in at the desk front; as an object it takes the free tile in front of the desk (j >= 1), relative to the desk reference tile (0, 0). Place the picture with its offset, use the tile for collisions'}


def add_flips(manifest):
    """A mirrored copy of every footprint part: `flip` = {file, anchor, footprint, swing}; mirroring swaps i and j."""
    for name, part in manifest['parts'].items():
        if 'footprint' not in part:
            continue
        img = Image.open(APP_HOME / part['file']).convert('RGBA')
        part['flip'] = {'file': write_png(ImageOps.mirror(img), 'furniture', f'{name}_flip'),
                        'anchor': [round(img.width - 1 - part['anchor'][0], 1), part['anchor'][1]],
                        'footprint': [[j, i] for i, j in part['footprint']]}
        if 'swing' in part:
            part['flip']['swing'] = [[j, i] for i, j in part['swing']]
        if 'leds' in part:
            part['flip']['leds'] = [[img.width - 1 - x, y] for x, y in part['leds']]
        if 'back' in part:                                       # the mirrored halves: depth is decided again on the mirrored picture
            mi = ImageOps.mirror(img)
            b, f = split_depth(mi, mi.width - 1 - part['split_x'])
            part['flip']['back'] = {'file': write_png(b, 'furniture', f'{name}_flip_back')}
            part['flip']['front'] = {'file': write_png(f, 'furniture', f'{name}_flip_front')}


def navy_core(lit, navy):
    return navy


def scroll_screen(desk_on, n=8, ms=200):
    """The lit screens with the code scrolling up, as a looping GIF cut to the monitor faces (n * ms = 1.6 s)."""
    both = np.logical_or(*screen_masks(desk_on))
    on = np.array(desk_on)
    ys, xs = np.nonzero(both)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    lit = on[y0:y1, x0:x1]
    mask = both[y0:y1, x0:x1]
    r_, g_, b_ = (lit[..., i].astype(int) for i in range(3))
    navy = mask & (b_ - r_ > 28) & (b_ > g_ + 8)              # the face's dark blue and its blue bars: they stay put
    code = mask & ~navy                                        # the coloured code lines: these scroll
    code = code | (_grow4(code) & mask & ~navy_core(lit, navy))
    bg_colour = np.median(lit[navy][:, :3], axis=0).astype(np.uint8) if navy.any() else np.array([24, 28, 44], np.uint8)
    base = lit.copy()
    base[code, :3] = bg_colour                                 # the face without any code
    spans = []                                                 # per column, the rows of the face: lines wrap around inside them
    for x in range(mask.shape[1]):
        ys_ = np.nonzero(mask[:, x])[0]
        spans.append((int(ys_.min()), int(ys_.max()) + 1) if len(ys_) else None)
    frames = []
    for k in range(n):
        f = base.copy()
        for x, span in enumerate(spans):
            if span:
                col_px = lit[span[0]:span[1], x]
                col_code = code[span[0]:span[1], x]
                shift = -(k * len(col_px) // n)
                rp, rc = np.roll(col_px, shift, axis=0), np.roll(col_code, shift, axis=0)
                seg = f[span[0]:span[1], x]
                seg[rc] = rp[rc]
        f[..., 3] = np.where(mask, 255, 0)
        frames.append(Image.fromarray(f, 'RGBA'))
    return frames, [int(x0), int(y0), int(x1 - x0), int(y1 - y0)], ms


def people_anchor(pieces, cw, ch):
    """Pixel of the pose canvas that must land on a tile's centre.  Standing / walking poses: the feet (bottom middle of
    the canvas).  `type` (a person on the desk's chair): the chair's reference tile, so it replaces the `chair` part."""
    out = {'stand': [cw / 2, ch - 1]}
    piece = pieces.get('a_type1')
    if piece is not None:
        on_canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        on_canvas.alpha_composite(piece, ((cw - piece.width) // 2, ch - piece.height))
        on_canvas = ImageOps.mirror(on_canvas)           # as person() does for the typing poses
        out['type'] = tile_anchor(foot_of(on_canvas), 1, 1)
    sp = pieces.get('a_staff_sit')
    if sp is not None:
        on_canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        on_canvas.alpha_composite(sp, ((cw - sp.width) // 2, ch - sp.height))
        on_canvas = ImageOps.mirror(on_canvas)           # staff_sit is in FLIPPED (faces down-right, office side)
        out['staff_sit'] = tile_anchor(foot_of(on_canvas), 1, 1)
    return {k: [round(v[0], 1), round(v[1], 1)] for k, v in out.items()}


def grid_preview(path):
    """Each footprint part with its tiles drawn over it (and the anchor), on one sheet: a check of the table above."""
    m = parts()
    names = [n for n, v in m['parts'].items() if 'footprint' in v]
    cell_w, cell_h, cols = 520, 420, 4
    sheet = Image.new('RGB', (cols * cell_w, ((len(names) + cols - 1) // cols) * cell_h), (235, 232, 224))
    d = ImageDraw.Draw(sheet, 'RGBA')
    for n_, name in enumerate(names):
        v = m['parts'][name]
        img = Image.open(APP_HOME / v['file']).convert('RGBA')
        ox = (n_ % cols) * cell_w + cell_w // 2 - int(v['anchor'][0])
        oy = (n_ // cols) * cell_h + cell_h // 2 + 60 - int(v['anchor'][1])
        layer = Image.new('RGBA', sheet.size, (0, 0, 0, 0))
        layer.paste(img, (ox, oy))
        sheet.paste(layer, (0, 0), layer)
        cx, cy = ox + v['anchor'][0], oy + v['anchor'][1]
        for i, j in v['footprint'] + v.get('swing', []):
            x, y = cx + (i - j) * GRID_TW / 2, cy + (i + j) * GRID_TH / 2
            dia = [(x, y - GRID_TH / 2), (x + GRID_TW / 2, y), (x, y + GRID_TH / 2), (x - GRID_TW / 2, y)]
            solid = [i, j] in v['footprint']
            d.polygon(dia, outline=(220, 30, 30, 255) if solid else (30, 120, 220, 255),
                      fill=(255, 0, 0, 30) if solid else (0, 100, 255, 25))
        d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(0, 0, 0, 255))
        d.text((n_ % cols * cell_w + 8, n_ // cols * cell_h + 6), name, fill=(0, 0, 0, 255))
    sheet.save(path)


# ---------------------------------------------------------------- parts()

def parts():
    """Write the PNGs and manifest.json (once per version / source change) and return the manifest."""
    path = OUT / 'manifest.json'
    stamp = sheet_hash()
    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved.get('version') == VERSION and saved.get('stamp') == stamp and all(
                (APP_HOME / v['file']).is_file() for v in saved['parts'].values()):
            return saved
    except (OSError, ValueError, KeyError):
        pass
    pieces = sheets()
    manifest = {'version': VERSION, 'stamp': stamp, 'parts': {}, 'screen_on': {}, 'sprite': {}}

    def add(name, img, folder='furniture'):
        manifest['parts'][name] = {'file': write_png(img, folder, name), 'w': img.width, 'h': img.height,
                                   'foot': [img.width // 2, img.height - 1]}

    for name in ROOM_PARTS:
        add(name, pieces[name], 'room')
    for name in DESK_PARTS:
        add(name, pieces[name])
    for name in WINDOW_PARTS + WIN_FRONT_PARTS:
        if name in pieces:
            add(name, pieces[name])
    desk_off, frames, rect = desk_parts(pieces['desk_on'])
    add('desk_on', pieces['desk_on'])
    add('desk_off', desk_off)
    free, chair_img, chair_at = split_chair(desk_off)              # a seated person brings the chair; the floor keeps none
    if chair_img is not None:
        add('desk_free', free)
        add('desk_chair', chair_img)
        manifest['parts']['desk_chair']['offset'] = list(chair_at)  # top-left in desk_off coordinates
    add('desk_off_sheet', pieces['desk_off_sheet'])
    scroll, srect, sms = scroll_screen(pieces['desk_on'])
    manifest['screen_scroll'] = {'file': write_gif([write_png(f, 'furniture', f'scrl{i}') for i, f in enumerate(scroll)],
                                                   'furniture', 'screen_scroll', sms),
                                 'rect': srect, 'ms': sms, 'frames': len(scroll), 'note': 'rect in desk_on / desk_nochair coordinates'}
    manifest['parts']['desk_alert']['offset'] = list(align(pieces['desk_on'], pieces['desk_alert']))  # top-left in desk_on coordinates
    if 'desk_free' in manifest['parts']:
        manifest['parts']['desk_nochair'] = dict(manifest['parts']['desk_free'])          # the desk, screens dark, no chair
    if 'desk_chair' in manifest['parts']:
        manifest['parts']['chair_sheet'] = manifest['parts'].get('chair')                 # the loose chair of the sheet
        manifest['parts']['chair'] = dict(manifest['parts']['desk_chair'])                # the chair as it stands at the desk
    for name, img in light_parts().items():                     # drawn, not cut: soft shadow and glows (foot = centre)
        add(name, img)
        manifest['parts'][name]['foot'] = [img.width // 2, img.height // 2]
    manifest['screen_faces'] = screen_faces(frames[0])        # the two monitors' inner rectangles, as fractions of the screen rect
    manifest['screen_on'] = {'rect': rect, 'frames': [
        {'file': write_png(f, 'furniture', f'screen_on_{i}'), 'rect': rect} for i, f in enumerate(frames)]}
    w, h = canvas()
    manifest['sprite'] = {'w': w, 'h': h, 'note': 'every pose is drawn on this canvas; foot = bottom centre'}
    for name in STORE_SHEET[1] + EQUIP_SHEET[1] + ENTRANCE_SHEET[1] + POLE_SHEET[1] + ['wall_tall_left', 'wall_tall_right'] + list(PLANT_ISO) + list(DECO_ISO):
        if name in pieces:
            add(name, pieces[name])
    for name in ENTRANCE_SHEET[1][:3]:                           # the entrance halves, so that a person can walk between them
        if name in manifest['parts']:
            img = pieces[name]
            back, front = split_depth(img, img.width // 2)
            manifest['parts'][name]['back'] = {'file': write_png(back, 'room', f'{name}_back')}
            manifest['parts'][name]['front'] = {'file': write_png(front, 'room', f'{name}_front')}
            manifest['parts'][name]['split_x'] = img.width // 2
    if 'wall_light' in manifest['parts']:                        # where the wall lamp's glow centres (pixels of the picture)
        a_ = np.array(pieces['wall_light']).astype(int)
        warm = (a_[..., 3] > 200) & (a_[..., 0] > 215) & (a_[..., 1] > 170) & (a_[..., 2] < 175) & (a_[..., 0] - a_[..., 2] > 60)
        if warm.any():
            ys_, xs_ = np.nonzero(warm)
            manifest['parts']['wall_light']['light'] = [int(xs_.mean()), int(ys_.mean())]
    if 'equip_rack' in manifest['parts'] and '_rack_leds_src' in pieces:
        manifest['parts']['equip_rack']['leds'] = rack_leds(pieces['_rack_leds_src'], SHEET_K)
    fl = sheet_files().get('floors')
    if fl and fl.is_file():
        for name, img in build_floors(fl).items():
            add(name, img, 'room')
            manifest['parts'][name]['foot'] = [img.width // 2, img.height - 1]
    for name in DESKPROP_SHEET[1] + [f'mark_{m_}' for m_ in MARKS]:
        if name in pieces:
            add(name, pieces[name], 'furniture')
    manifest['props'] = {'desk': {'papers': ['desk_papers1', 'desk_papers2', 'desk_papers3', 'desk_papers4'], 'boxes': ['desk_box1', 'desk_box2', 'desk_box3', 'desk_storagebox'],
                                  'drinks': ['desk_mug', 'desk_cup', 'desk_can1', 'desk_can3', 'desk_can6'], 'other': ['desk_notes', 'desk_plant', 'desk_pizza', 'desk_lamp']},
                         'marks': [f'mark_{m_}' for m_ in MARKS],
                         'note': 'desk things: parts[name] (foot = bottom centre; put it on the desk top, back to front like the laptop). desk_papers1..4 = messiness stages, '
                                 'desk_box1..3 = 1..3 cartons (storagebox = an archive box), desk_mug / cup / can1 / can3 / can6 = the drinks stages (can6 comes with the snack bag), '
                                 'desk_lamp = a lit desk lamp for overtime. marks = parts mark_<name> (sweat, steam, question, alert, sparkle, sprout, coffee, paper), 56 px tall, '
                                 'centre them over a head. People props: person(id)["prop"][wave_f|wave_b|coffee_f|coffee_b|bag_f|bag_b|stand_b (standing, back to us, no prop)] (+ ["prop"]["flip"][...] mirrored), '
                                 'on the pose canvas like the walking pictures (feet = bottom centre): _f faces down-left, _b up-right'}
    for name in CAFE_ITEMS + ['window2', 'wall_plain1', 'wall_post']:
        if name in pieces:
            add(name, pieces[name], 'furniture' if name.startswith('cafe') else 'room')
    if 'window2' in pieces and 'window2_glass' in pieces:
        w2, g2 = pieces['window2'], np.array(pieces['window2_glass']).astype(int)
        gm = (g2[..., 0] > 180) & (g2[..., 1] < 110) & (g2[..., 2] > 180) & (g2[..., 3] > 127)
        gm = _grow4(gm) if gm.any() else gm
        h_, w_ = min(w2.height, gm.shape[0]), min(w2.width, gm.shape[1])
        mk = np.zeros((w2.height, w2.width), bool)
        mk[:h_, :w_] = gm[:h_, :w_]
        fr = np.array(w2)
        fr[mk, 3] = 0
        ma = np.zeros(mk.shape + (4,), np.uint8)
        ma[..., :3] = 255
        ma[..., 3] = np.where(mk, 255, 0)
        ys_, xs_ = np.nonzero(mk)
        manifest['_window2'] = {'frame': write_png(Image.fromarray(fr, 'RGBA'), 'room', 'window2_frame'), 'mask': write_png(Image.fromarray(ma, 'RGBA'), 'room', 'window2_glass'),
                                'w': w2.width, 'h': w2.height, 'foot': manifest['parts']['window2']['foot'],
                                'glass_box': [int(xs_.min()), int(ys_.min()), int(xs_.max()) + 1, int(ys_.max()) + 1] if mk.any() else None}
    mf = sheet_files().get('moon')
    moon_info = None
    if mf and mf.is_file():
        ph, stars_ = build_moon(mf)
        if ph:
            for i_, im in enumerate(ph):
                add(f'moon_{i_}', im, 'furniture')
                manifest['parts'][f'moon_{i_}']['foot'] = [im.width // 2, im.height // 2]            # the centre
            for nm, im in stars_.items():
                add(nm, im, 'furniture')
                manifest['parts'][nm]['foot'] = [im.width // 2, im.height // 2]
            moon_info = {'phases': [manifest['parts'][f'moon_{i_}']['file'] for i_ in range(8)], 'size': ph[0].width,
                         'stars': {nm: {'file': manifest['parts'][nm]['file'], 'w': im.width, 'h': im.height} for nm, im in stars_.items()}}
    manifest['_moon'] = moon_info
    bf = sheet_files().get('board')
    if bf and bf.is_file():
        bw, binfo = build_board(bf)
        for name, im in bw.items():
            add(name, im, 'room')
        if binfo and 'wall_board' in manifest['parts']:
            s_, xl_, xr_, A_, B_ = binfo['slope'], binfo['xl'], binfo['xr'], binfo['A'], binfo['B']
            px_, pv_ = 4.0, 5.0                                  # the lattice pitch of T3's LED dots (measured on the finished picture), px
            manifest['parts']['wall_board']['board'] = {
                'face': [[xl_, round(A_ + s_ * xl_, 1)], [xr_, round(A_ + s_ * xr_, 1)], [xr_, round(B_ + s_ * xr_, 1)], [xl_, round(B_ + s_ * xl_, 1)]],
                'slope': s_, 'cols': int((xr_ - xl_) / px_), 'rows': int((B_ - A_) / pv_),
                'origin': [round(xl_ + px_ / 2, 1), round(A_ + pv_ / 2 + s_ * (xl_ + px_ / 2), 1)],
                'dx': [px_, round(px_ * s_, 2)], 'dy': [0, pv_],
                'note': 'face = the dot area (TL, TR, BR, BL; pixels of wall_board, bezel left out): the top and bottom edges run down-right at `slope`, the sides are vertical. '
                        'origin = centre of the first dot; one column on = origin + dx, one row down = + dy. Draw LEDs on this lattice (or any coarser one inside the face); flip: mirror x (w - 1 - x)'}
    add_door2(manifest, pieces)
    add_grid(manifest)
    add_flips(manifest)
    for p_ in list(ISO_EQUIP) + list(PLANT_ISO) + list(DECO_ISO):                 # ★69 / ★75-3: the other facing is its own picture (_R), not a mirror of the cut-out
        part_, r_ = manifest['parts'].get(p_), pieces.get(f'_isoR_{p_}')
        if part_ and r_ is not None and 'flip' in part_:
            part_['flip'] = {'file': write_png(r_, 'furniture', f'{p_}_iso_r'), 'anchor': tile_anchor(foot_of(r_), 1, 1),
                             'footprint': [[j, i] for i, j in part_['footprint']]}
            part_['iso'] = True
    wp_ = manifest['parts'].get('deco_welcome')                    # ★100-1 one facing only: the other way is the same picture (never mirror the WELCOME letters)
    if wp_:
        wp_['flip'] = {'file': wp_['file'], 'anchor': list(wp_['anchor']), 'footprint': [list(t_) for t_ in wp_['footprint']]}
        wp_['iso'] = True
        wp_['no_mirror'] = True
    manifest['people_anchor'] = people_anchor(pieces, w, h)
    if 'plank_a' in pieces and 'a_type_pc' in pieces:
        fa_imgs, fa_info = fa_parts(pieces)
        for name, img in fa_imgs.items():
            add(name, img)
            if name in fa_info:
                manifest['parts'][name].update({kk: vv for kk, vv in fa_info[name].items() if kk != 'wood_front_corner'})
        manifest['fa'] = {'scale': fa_info['scale'], 'laptop': fa_info['laptop'],
                          'plank': {n: {kk: fa_info[n][kk] for kk in ('front_edge', 'seat_point', 'top_height')} for n in ('plank_left', 'plank_mid', 'plank_right')},
                          'note': 'planks 2 x 1 tiles at the desk-sheet scale, the long side along x, seat side down-left; place a laptop so that '
                                  'laptop.keyboard_center lands on the person hand point (people_anchor.type + fa.hand)'}
        cw_, ch_ = w, h
        pc = pieces['a_type_pc']
        on_canvas = Image.new('RGBA', (cw_, ch_), (0, 0, 0, 0))
        on_canvas.alpha_composite(pc, ((cw_ - pc.width) // 2, ch_ - pc.height))
        manifest['people_anchor']['type_pc'] = tile_anchor(foot_of(on_canvas), 1, 1)
        hp = hand_point(on_canvas)
        if hp:
            ta = manifest['people_anchor']['type_pc']
            manifest['fa']['hand'] = [round(hp[0] - ta[0], 1), round(hp[1] - ta[1], 1)]
            manifest['fa']['hand_note'] = 'fingertip centre relative to people_anchor.type_pc (the pixel of the pose canvas that stands on the chair tile)'
        lap = manifest['fa']['laptop']
        fx, fy, fw, fh = lap['faces'][0]
        sr = lap['screen_rect']
        face = [round(sr[0] + fx * sr[2]), round(sr[1] + fy * sr[3]), round(fw * sr[2]), round(fh * sr[3])]
        strip = code_strip(max(8, face[2]), max(9, face[3]))
        lap['screen'] = {'rect': face, 'faces': [write_png(strip, 'furniture', 'laptop_code')], 'strip_h': strip.height,
                         'note': 'rect = the plain rectangle inside the laptop_on screen (pixels of laptop_on); faces[0] = a tall picture, 3 x rect height, '
                                 'repeating every rect height: clip it to rect and loop its top from 0 to -rect height'}
        if '_iso_desk' in pieces:                                # ★70-1: one seat's desk as ONE picture (one top, no seam), on the 2:1 isometric
            dimg, dinfo = desk_iso(pieces['_iso_desk'], manifest['fa']['plank']['plank_mid']['top_height'])
            add('desk_iso', dimg)
            manifest['parts']['desk_iso'].update(dinfo)
        life_parts(pieces, manifest, w, h)
        manifest['holes'] = {n: count_holes(Image.open(APP_HOME / v['file'])) for n, v in manifest['parts'].items()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    return manifest


def light_parts():
    """Soft PNGs for the mod to lay over the floor: a person's ground shadow, the light of a working
    screen (cool) and of a desk lamp (warm). Still pictures; the mod decides when to show them."""
    def radial(w, h, color, peak, power, ellipse_h=1.0):
        y, x = np.mgrid[0:h, 0:w]
        r = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2 * ellipse_h)) ** 2)
        alpha = np.clip(1 - r, 0, 1) ** power * peak
        px = np.zeros((h, w, 4), np.uint8)
        px[..., :3] = color
        px[..., 3] = alpha.astype(np.uint8)
        return Image.fromarray(px, 'RGBA')
    return {'shadow': radial(120, 40, (30, 30, 45), 95, .8),
            'glow_screen': radial(300, 200, (140, 185, 255), 105, 1.8),
            'glow_lamp': radial(260, 200, (255, 214, 140), 120, 1.6),
            'glow_alert': radial(160, 160, (255, 60, 50), 170, 1.4),
            'glow_ceiling': radial(360, 220, (255, 238, 196), 120, 1.5)}      # night: a pool of light under a ceiling lamp, reused


# ---------------------------------------------------------------- person()

def canvas():
    """One canvas for every pose of both people: the biggest width and height; foot = bottom centre."""
    pieces = sheets()
    names = [f'{who}_{pose}' for who in ('a', 'b') for pose in POSES + DOZES + FRONT_POSES + PC_POSES + STAFF_POSES if f'{who}_{pose}' in pieces]
    return max(pieces[n].width for n in names), max(pieces[n].height for n in names)


def _rgb(hexcolor):
    return np.array([int(hexcolor[i:i + 2], 16) for i in (1, 3, 5)], np.float32)


def _paint(px, mask, hexcolor):
    """Fill the masked pixels with a colour, keeping their brightness pattern (folds, highlights)."""
    if not mask.any():
        return
    lum = 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]
    f = np.clip(lum / max(1.0, lum[mask].mean()), .3, 1.7)[..., None]
    t = _rgb(hexcolor)
    new = np.where(f <= 1, t * f, t + (255 - t) * np.clip(f - 1, 0, 1) * .8)
    px[..., :3] = np.where(mask[..., None], new, px[..., :3])


def recolour(part, pose, who, jacket, hair, skin):
    px = np.array(part).astype(np.float32)
    h, w = px.shape[:2]
    rgb = px[..., :3] / 255
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    val, sat = mx, np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) % 360
    solid = px[..., 3] > ALPHA_MIN
    rows = np.arange(h)[:, None] * np.ones((1, w))
    warm = (hue > 5) & (hue < 42) & solid
    skin_m = warm & (sat > .12) & (sat < .62) & (val >= .78)
    head = min(.7, HEAD[pose] * (LONG_HAIR if who == 'b' else 1))
    hair_m = warm & (sat > .3) & (val < .8) & (rows < h * head)
    lum = 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]
    y0, y1 = JACKET_Y.get(pose, (0.0, 1.0))
    lo, hi = (118, 175) if pose in SEATED else (90, 160) if pose == 'sofa' else (70, 175)   # the sofa is lighter grey
    cols = np.arange(w)[None, :] * np.ones((h, 1))
    grey = solid & ((mx - mn) < .09) & (lum > lo) & (lum < hi) & (rows >= h * y0) & (rows < h * y1) & (cols >= w * JACKET_X0.get(pose, 0.0)) & (cols < w * JACKET_X1.get(pose, 1.0))
    if pose.startswith('walk_') and grey.any():   # ★23: only the grey pieces that sit on the torso / arms (centre above the hips); a light fold on the trousers is a piece of its own, low down
        keep = np.zeros_like(grey)
        for comp in label(grey):
            ys = np.array([c[0] for c in comp])
            if ys.mean() < h * .66:
                keep[ys, np.array([c[1] for c in comp])] = True
        grey = keep
    if pose in DOZES:   # the armchair is warm grey (red > blue by ~10), the cardigan neutral: tell them apart by colour
        grey &= ((px[..., 0] - px[..., 2]) < 6) & ((px[..., 0] - px[..., 1]) < 6)
    if hair_m.any():       # ★23: pixels at the hair's rim that are too bright / saturated to count as hair or skin stay orange; they are hair
        rim = _grow(hair_m, 2) & solid & ~skin_m & ~hair_m & ((hue < 46) | (hue > 340)) & (sat > .3) & (rows < h * head)
        hair_m = hair_m | rim
    if pose in STAFF_POSES:    # ★26-4: cardigan + sleeves (including shaded folds) separated from the chair armrest by the dark outline
        skin_m = skin_m | (_grow4(skin_m) & warm & ~hair_m & (val >= .58))
        cand = solid & ~hair_m & ~skin_m & ((mx - mn) < .10) & (lum > 88) & (lum < 182) & (rows >= h * .24) & (rows < h * .60)
        if who == 'b':
            cand &= ~((rows < h * .38) & (cols > w * .72))
        grey = np.zeros_like(cand)
        for comp in label(cand):
            ys = np.array([c[0] for c in comp])
            if ys.min() < h * .45:
                grey[ys, np.array([c[1] for c in comp])] = True
    _paint(px, skin_m, skin)
    _paint(px, hair_m, hair)
    _paint(px, grey, jacket)
    return Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), 'RGBA')


def _hls_hex(h, l, sat):
    r, g, b = colorsys.hls_to_rgb(h % 1.0, max(0.0, min(1.0, l)), max(0.0, min(1.0, sat)))
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))


NATURAL_HAIRS = ['#0f0c0a', '#2b1d14', '#3d2616', '#4a2c17', '#6b3f1d', '#8a5a2b', '#a0522d', '#c9a063', '#d4a64a',
                 '#e8d08a', '#8a8a8a', '#c8c8c8']


def gen_jacket(rng, spec):
    spec = spec if isinstance(spec, dict) else {}
    sr, lr = spec.get('s') or [.35, .75], spec.get('l') or [.35, .6]
    return _hls_hex(rng.random(), rng.uniform(*lr), rng.uniform(*sr))     # any hue, a readable saturation and lightness


def gen_skin(rng):
    t = rng.random()                                                     # a continuous natural range, light to deep
    return _hls_hex((24 + rng.uniform(-3, 4) + 6 * t) / 360, .88 - .55 * t ** .9, .5 + rng.uniform(-.06, .06))


def gen_hair(rng, fancy):
    if fancy and rng.random() < .4:                                      # bright colours only when asked for
        return _hls_hex(rng.random(), rng.uniform(.4, .65), rng.uniform(.55, .9))
    base = rng.choice(NATURAL_HAIRS)
    r, g, b = (int(base[k:k + 2], 16) / 255 for k in (1, 3, 5))
    h, l, sat = colorsys.rgb_to_hls(r, g, b)
    return _hls_hex(h + rng.uniform(-.012, .012), l + rng.uniform(-.04, .04), sat)


def look(agent_id, leader=False):
    """(who, jacket, hair, skin): a fixed random choice from the id (who: 'a' short hair, 'b' long hair).
    office.colors.people: mode "list" picks from jackets / hairs / skins (default: JACKETS, HAIRS, SKINS);
    mode "generate" makes the HEX values (see generate)."""
    seed = int(hashlib.sha1(str(agent_id).encode('utf-8')).hexdigest()[:12], 16)
    rng = random.Random(seed)
    who = rng.choice('ab')
    if leader:                                            # ★92 the leader (an agent with workers): the same face and hair, a black jacket over the white shirt
        base = look(agent_id)
        return who, LEADER_JACKET, base[2], base[3]
    cfg = colors_cfg().get('people')
    cfg = cfg if isinstance(cfg, dict) else {}
    if cfg.get('mode') == 'generate':
        gen = cfg.get('generate') if isinstance(cfg.get('generate'), dict) else {}
        jacket, hair, skin = (gen_jacket(random.Random(seed ^ 0x1), gen.get('jacket')),
                              gen_hair(random.Random(seed ^ 0x2), bool(gen.get('hair_fancy'))),
                              gen_skin(random.Random(seed ^ 0x3)))
        return who, jacket, hair, skin

    def pick(key, default):
        got = [c for c in (cfg.get(key) or []) if _is_hex(c)]
        return rng.choice(got or default)
    jackets = [c for c in (cfg.get('jackets') or []) if _is_hex(c)] or JACKETS
    m_ = re.search(r'(\d+)$', str(agent_id))
    if m_ and len(jackets) > 1:                         # ids that end in a number (demo:1, demo:2 ...): neighbours get different jackets (a step coprime with the count)
        step = next(k for k in (5, 7, 3, 1) if math.gcd(k, len(jackets)) == 1)
        base = int(hashlib.sha1(str(agent_id)[:m_.start()].encode('utf-8')).hexdigest()[:8], 16)
        jacket = jackets[(base + int(m_.group(1)) * step) % len(jackets)]
        rng.choice(jackets)                               # (keep the hair and skin draws as they were)
    else:
        jacket = rng.choice(jackets)
    return who, jacket, pick('hairs', HAIRS), pick('skins', SKINS)


FA_SHEET = ('20261103_071207.png', ['plank_a', 'plank_b', 'plank_c', 'plank_long', 'lt_off', 'lt_on', 'lt_closed',
                                    'mug_fa', 'plant_fa', 'papers_fa'], 2)
FA_PEOPLE_SHEET = ('20261103_071329.png', [f'{who}_{p}' for who in ('a', 'b') for p in ('type_pc', 'type_pc2', 'read_pc')], 2)
PC_POSES = ['type_pc', 'type_pc2', 'read_pc']        # a person at a laptop, with the chair, facing up-right (not mirrored)
LIFE_SHEET = ('20261103_133440.png', ['e_chair1', 'e_arm1', 'e_chair2', 'e_arm2'], 6)       # empty office chairs (left), empty armchairs (right), two each
BIRD_SHEET = ('20261103_133532.png', [f'bird_{t}{i}' for t in 'dl' for i in range(4)], 4)  # 4 wing frames: dark shadow (top row), pale (bottom row), facing right
OUTSIDE_SHEETS = {'morning': '20261103_133631.png', 'day': '20261103_133731.png', 'evening': '20261103_133838.png', 'night': '20261103_133930.png'}   # 16:9, no alpha
DESKPROP_SHEET = ('20261103_195110.png', ['desk_papers1', 'desk_papers2', 'desk_papers3', 'desk_papers4',
                                         'desk_box1', 'desk_box2', 'desk_box3', 'desk_storagebox',
                                         'desk_mug', 'desk_cup', 'desk_can1', 'desk_can3', 'desk_can6',
                                         'desk_notes', 'desk_plant', 'desk_pizza', 'desk_lamp'], 4)      # small things for a desk: the more messy / the longer the work, the more of them
PROP_POSES = ['wave_f', 'wave_b', 'coffee_f', 'coffee_b', 'bag_f', 'bag_b']     # _f: facing us (down-left), _b: back to us (up-right)
MARKS = ['sweat', 'steam', 'question', 'alert', 'sparkle', 'sprout', 'coffee', 'paper']
PEOPLEPROP_SHEET = ('20261103_195106.png', [f'{who}_{p}' for who in ('a', 'b') for p in PROP_POSES] + [f'mark_{m}' for m in MARKS], 4)
DESK_K = .7              # the desk-things sheet is drawn bigger than the desk sheet: this brings the mug to the size of the desk's own mug
MARK_H = 56              # px: the marks (sweat, steam, ...) over a head
WALK8V2_SHEET = '20261104_071712.png'      # 4 rows x 8 frames: man down-left, man up-right, woman down-left, woman up-right (legs: 1-4 left forward, 5-8 right forward)
CAFE_SHEET = '20261104_071711.png'         # people sitting on cafe chairs / stools with coffee, a round table with 2 chairs, a high counter with 3 stools, a chair, a stool
WINDOW2_SHEET = '20261104_071647.png'      # a 2-tile window, the same with the glass in magenta (for the mask), a 1-tile plain wall, a back corner post (opaque, white background)
MOON_SHEET = '20261103_211946_alpha.png'     # a big full moon, a small one, 8 phases in a row, 5 stars / a shooting star
CAFE_POSES = ['cafe_f', 'cafe_b', 'stool_f', 'stool_b']   # a person on a cafe chair / a high stool with coffee, facing us (_f) or back to us (_b)
CAFE_ITEMS = ['cafe_table', 'cafe_counter', 'cafe_chair', 'cafe_stool']     # a round table with 2 chairs, a high counter with 3 stools, a chair, a stool (empty)
WALL_LEN3 = 261          # px: the length of a 3-tile outer wall piece
WALL_END = 376           # px: the end height of the outer walls (see WALL_RAISE)
MOON_SIZE = 44           # px: the moon's diameter on the wall (a window is ~220 px high)
BOARD_SHEET = '20261103_170006.png'          # left: a wall with the LED notice board, right: the same wall plain (three tiles long, running down-right)
WEATHER_SHEET = '20261103_170019_alpha.png'   # cloud / dark cloud bands, rain, snow, fog, a lightning bolt, 8 weather icons
ENTRANCE_SHEET = ('20261103_151218.png', ['entrance_closed', 'entrance_half', 'entrance_open', 'wall_plain', 'wall_light'], 6)   # the entrance block (2-tile double glass door) and two windowless wall pieces; they run down-right
ENTRANCE_END = 190     # px: the height of a wall piece's end column in the room sheet's scale (wall_window_left); the T3 pieces are scaled to it
# ★A3 review 11: queue poles with a blue belt (one pole; 2 / 3 poles, belt up-right; 2 / 3 poles, belt down-right; an L of 3), and a white signboard on a pole (T3, transparent)
POLE_SHEET = ('20261104_020855_alpha.png', ['pole_y1', 'pole_y2', 'pole_y3', 'pole_x1', 'pole_x2', 'pole_x3', 'pole_l', 'sign_board'], 6)
SIGN_K = 1.6                               # the signboard is bigger than a pole in proportion: the words (11 px) must fit on its board
POLE_K = 1.0                              # the poles are waist-high on a standing person: one scale for the whole sheet
STORE_SHEET = ('20261103_150917.png', ['store_bookshelf', 'store_steel', 'store_locker', 'store_sideboard', 'store_cabinet', 'store_drawers'], 6)   # opaque storage furniture
EQUIP_SHEET = ('20261103_150950.png', ['equip_mfp', 'equip_printer', 'equip_water', 'equip_coffee', 'equip_vending',
                                       'equip_whiteboard', 'equip_rack', 'equip_files', 'equip_coat', 'equip_lamp'], 6)
# ★69: the machines on the 2:1 isometric (T3, gpt-image-2, white background taken off): <name>_L.png (back on the left wall / a wall rising to the
# right, front +x) and <name>_R.png (its mirror: back on the back wall / a wall falling to the right, front +y). All five are drawn at one scale
# (the screen width = (along the wall + deep) x one tile), so one factor keeps them in proportion; ISO_K puts the vending machine as tall as before.
ISO_DIR = 'equip-iso-20261105'
ISO_EQUIP = {'equip_mfp': 'copier', 'equip_files': 'cabinet', 'equip_coffee': 'coffee', 'equip_water': 'water', 'equip_vending': 'vending'}
ISO_K = .46
FLOOR_SHEET = '20261103_150820.png'       # four floor tiles (charcoal carpet, concrete, oak herringbone, smoked oak), diamonds on white
SHEET_K = .4                              # these two sheets are drawn bigger than the room sheet: one scale for all of them
WALK8_SHEETS = {'a': '20261103_150235_00.png', 'b': '20261103_150337_01.png'}      # 8 frames: top row facing us (down-left), bottom row back to us (up-right); strides at 1 and 5, feet crossing at 3 and 7
WALK_SHEETS = {'a': '20261102_211545_00.png', 'b': '20261102_211647_01.png'}   # male / female: 6 frames facing us, 6 facing away
_WALK = {}


def _drop_scraps(img, keep=.05):
    """Remove small pieces (a neighbouring frame's edge caught by the cell cut): anything under 5% of the biggest piece."""
    a = np.array(img)
    comps = label(a[..., 3] > ALPHA_MIN)
    if len(comps) < 2:
        return img
    big = max(len(c) for c in comps)
    for c in comps:
        if len(c) < big * keep:
            for y, x in c:
                a[y, x, 3] = 0
    return Image.fromarray(a, 'RGBA')


def _refill_shirt(clean, raw):
    """clean_edges takes the white shirt where its pale area touches the outside through a seam, leaving a hole in the body. Put the original
    pixels back in the torso rows wherever the figure closes over them (a morphological closing, 6 px: the gaps between an arm and the body stay open)."""
    c, r = np.array(clean), np.array(raw)
    sol = c[..., 3] > ALPHA_MIN
    big = sol.copy()
    for _ in range(10):
        big = _grow4(big)
    for _ in range(10):
        big = ~_grow4(~big)
    h = sol.shape[0]
    rows = np.arange(h)[:, None] * np.ones((1, sol.shape[1]))
    fill = big & ~sol & (r[..., 3] > ALPHA_MIN) & (rows > h * .12) & (rows < h * .62)
    c[fill] = r[fill]
    c[fill, 3] = 255
    return Image.fromarray(c, 'RGBA')


def _fix_shirt(frame):
    """A dull, greenish shirt (some frames of the sheet) back to white: only when the shirt's pale pixels are clearly darker than in the other frames."""
    a = np.array(frame).astype(float)
    h, w = a.shape[:2]
    solid = a[..., 3] > ALPHA_MIN
    lum = .299 * a[..., 0] + .587 * a[..., 1] + .114 * a[..., 2]
    mx, mn = a[..., :3].max(axis=2), a[..., :3].min(axis=2)
    rows = np.arange(h)[:, None] * np.ones((1, w))
    shirt = solid & (rows < h * .6) & (rows > h * .15) & (lum > 168) & ((mx - mn) < 45) & (a[..., 1] >= a[..., 0] + 2)    # pale and slightly green / blue: the cardigan is neutral grey
    if shirt.sum() > 60:
        s = a[shirt, :3]
        l = (s * [.299, .587, .114]).sum(1, keepdims=True)
        a[shirt, :3] = np.clip(np.minimum(l * 1.22 + 14, 244) * np.array([1.0, 1.0, 1.01]), 0, 255)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def _split_legs(frame, kind, k):
    """The frame with the trailing / leading leg one step darker, so that left and right can be told apart. Only frames with the feet apart
    (k = 0, 1, 4, 5 of the 8) are changed. kind 'dl': walking down-left (facing us), 'ur': up-right (back to us). Frames 1-4 darken the trailing
    leg, 5-8 the leading one (the sheet's trousers are the same colour on both legs)."""
    if k not in (0, 1, 4, 5):
        return frame
    a = np.array(frame).astype(float)
    h, w = a.shape[:2]
    solid = a[..., 3] > ALPHA_MIN
    lum = .299 * a[..., 0] + .587 * a[..., 1] + .114 * a[..., 2]
    mx, mn = a[..., :3].max(axis=2), a[..., :3].min(axis=2)
    rows = np.arange(h)[:, None] * np.ones((1, w))
    legs = solid & (rows >= h * .5) & (lum < 120) & ((mx - mn) < 60)             # trousers (shoes: brown, handled below)
    r0 = None                                                      # the crotch: the first row (from the top) below which the trousers are two separate pieces
    for r in range(int(h * .5), int(h * .92), 3):
        sub = legs.copy()
        sub[:r] = False
        sizes = sorted((len(c) for c in label(sub)), reverse=True)
        if len(sizes) >= 2 and sizes[1] >= 300 and sizes[1] >= .2 * sizes[0]:
            r0 = r
            break
    if r0 is None:                                                 # the legs overlap in this frame: one blob, no shape to follow: leave it
        return frame
    sub = legs.copy()
    sub[:r0] = False
    comps = sorted(label(sub), key=len, reverse=True)[:2]
    leg = []
    for c in comps:
        m = np.zeros(legs.shape, bool)
        for y, x in c:
            m[y, x] = True
        leg.append(m)
    # the leg shapes: grow each piece upward / sideways inside the trousers (and its shoe), so each leg owns the trouser pixels nearest to it along the cloth
    shoes = solid & (rows >= h * .72) & (a[..., 0] > a[..., 2] + 25) & (lum < 160)
    region = legs | shoes
    own = [leg[0].copy(), leg[1].copy()]
    for _ in range(160):
        g0, g1 = _grow4(own[0]) & region & ~own[1], _grow4(own[1]) & region & ~own[0]
        both = g0 & g1
        g0, g1 = g0 & ~both, g1 & ~both
        if not (g0 | g1).any():
            break
        own[0] |= g0
        own[1] |= g1
    cx = [np.mean(np.nonzero(m)[1]) for m in leg]
    right_x = 0 if cx[0] > cx[1] else 1                         # the leg that is more to the right
    trail = right_x if kind == 'dl' else 1 - right_x            # dl: the trailing foot is up-right (larger x); ur: down-left (smaller x)
    far = trail if k < 4 else 1 - trail                          # frames 1-4: the trailing leg is the far one; 5-8: the leading one
    fade = max(10, int(h * .08))
    wgt = np.clip(1.0 - (r0 - rows) / fade, 0, 1)                # above the crotch the effect fades out (no straight seam)
    for i in (0, 1):
        m = own[i]
        f = wgt[m][:, None]
        if i == far:
            a[m, :3] = a[m, :3] * (1 - f * .45)                  # the far leg (its trousers and its shoe): darker
        else:
            a[m, :3] = np.minimum(255, a[m, :3] * (1 + f * .3) + f * 4)   # the near leg: a little lighter
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def walk_frames_v2(who):
    """The 8-frame walk from the 4-row sheet (man: rows 0, 1; woman: rows 2, 3), with the legs told apart (_split_legs)."""
    if (who, 'v2') in _WALK:
        return _WALK[(who, 'v2')]
    f = sheet_files().get('walk8v2')
    if not f or not f.is_file():
        return None
    img = Image.open(f).convert('RGBA')
    al_ = np.array(img.getchannel('A')) > ALPHA_MIN
    prof = al_.sum(axis=1) > 3
    bands, y = [], 0
    while y < len(prof):
        if prof[y]:
            y1 = y
            while y1 < len(prof) and prof[y1]:
                y1 += 1
            if y1 - y > 100:
                bands.append((y, y1))
            y = y1
        else:
            y += 1
    if len(bands) != 4:
        hh = img.height / 4
        bands = [(int(i * hh), int((i + 1) * hh)) for i in range(4)]
    cell = img.width / 8
    rows_ = {'a': (0, 1), 'b': (2, 3)}[who]
    out = {}
    for name, r in zip(('dl', 'ur'), rows_):
        y0, y1 = bands[r]
        cp = al_[y0:y1].sum(axis=0) > 0
        segs, x = [], 0
        while x < len(cp):                                         # the frames are separated by empty columns
            if cp[x]:
                x1 = x
                while x1 < len(cp) and cp[x1]:
                    x1 += 1
                segs.append([x, x1])
                x = x1
            else:
                x += 1
        while len(segs) > 8:                                       # a stray piece: join the narrowest to its nearest neighbour
            i = min(range(len(segs)), key=lambda j: segs[j][1] - segs[j][0])
            j = i - 1 if i > 0 and (i == len(segs) - 1 or segs[i][0] - segs[i - 1][1] <= segs[i + 1][0] - segs[i][1]) else i + 1
            lo, hi = min(i, j), max(i, j)
            segs[lo:hi + 1] = [[segs[lo][0], segs[hi][1]]]
        if len(segs) != 8:
            segs = [[round((k + .5) * cell - cell / 2), round((k + .5) * cell + cell / 2)] for k in range(8)]
        frames = []
        for k in range(8):
            raw_ = img.crop((segs[k][0] - 2, y0, segs[k][1] + 2, y1))
            frames.append(_refill_shirt(clean_edges(raw_), raw_))
        # one canvas for the 8 frames, each centred on its body (the middle of the torso rows), so the figure does not jump
        frames = [_split_legs(_fix_shirt(fr), name, k) for k, fr in enumerate(frames)]
        bb = [np.nonzero(np.array(fr.getchannel('A')) > ALPHA_MIN) for fr in frames]
        x0 = min(int(xs.min()) for ys, xs in bb); x1 = max(int(xs.max()) + 1 for ys, xs in bb)
        top = min(int(ys.min()) for ys, xs in bb); bot = max(int(ys.max()) + 1 for ys, xs in bb)
        out[name] = [_drop_scraps(fr.crop((x0, top, x1, bot))) for fr in frames]
    _WALK[(who, 'v2')] = out
    return out


def walk_frames(who, n=6):
    """{'dl': 6 frames walking down-left (facing us), 'ur': 6 frames walking up-right (back to us)}: cut on the
    sheet's own cells so the body keeps its place from frame to frame, trimmed together, then scaled to the stand picture."""
    if n == 8:
        v2 = walk_frames_v2(who)
        if v2:
            return v2
    if (who, n) in _WALK:
        return _WALK[(who, n)]
    path = sheet_files()[f'walk_{who}' if n == 6 else f'walk8_{who}']
    img = Image.open(path).convert('RGBA')
    boxes = components(np.array(img.getchannel('A')), 2)
    if len(boxes) != 2 * n:
        raise SystemExit(f'{path}: {len(boxes)} pieces found, expected {2 * n}')
    cell = img.width / n
    out = {}
    for r, name in enumerate(('dl', 'ur')):
        row = boxes[r * n:(r + 1) * n]
        y0, y1 = min(b[1] for b in row), max(b[3] for b in row)
        frames = []
        for k in range(n):
            cx = (k + .5) * cell
            frames.append(clean_edges(img.crop((round(cx - cell / 2), y0, round(cx + cell / 2), y1))))
        boxes_ = [np.nonzero(np.array(f.getchannel('A')) > ALPHA_MIN) for f in frames]
        x0 = min(int(xs.min()) for ys, xs in boxes_)
        x1 = max(int(xs.max()) + 1 for ys, xs in boxes_)
        top = min(int(ys.min()) for ys, xs in boxes_)
        bot = max(int(ys.max()) + 1 for ys, xs in boxes_)
        out[name] = [_drop_scraps(f.crop((x0, top, x1, bot))) for f in frames]
    _WALK[(who, n)] = out
    return out



FAR_LEG_SHADE = .72    # ★23: the leg that is further from the viewer is 28 % darker, so the alternation of the legs reads at a glance


def shade_far_leg(img):
    """The walking frame with its far leg darkened. The nearer foot is the lower one (we look down on the floor); the far leg is the part
    below the hem on the other side of the middle between the two feet. Frames where the feet are together (passing) are left as they are."""
    px = np.array(img).astype(np.float32)
    h, w = px.shape[:2]
    solid = px[..., 3] > ALPHA_MIN
    y0 = int(h * .68)
    low = solid.copy()
    low[:y0] = False
    cols = np.nonzero(low.any(axis=0))[0]
    if not len(cols):
        return img
    bottom = np.array([np.nonzero(low[:, c])[0].max() if low[:, c].any() else -1 for c in range(w)])
    x1 = int(np.argmax(bottom))                                   # the nearer foot (lowest point)
    far = np.abs(np.arange(w) - x1) > w * .14
    if not (far & (bottom >= 0)).any():
        return img
    x2 = int(np.argmax(np.where(far, bottom, -1)))                # the other foot
    split = (x1 + x2) / 2
    side = (np.arange(w) > split) if x2 > x1 else (np.arange(w) < split)
    rgb_ = px[..., :3] / 255
    mx_, mn_ = rgb_.max(axis=2), rgb_.min(axis=2)
    skinish = ((mx_ - mn_) / np.maximum(mx_, 1e-6) > .12) & (mx_ >= .6) & (rgb_[..., 0] >= rgb_[..., 1]) & (rgb_[..., 1] >= rgb_[..., 2])   # a hand in the lower part is not a leg
    mask = low & side[None, :] & ~skinish
    px[..., :3] = np.where(mask[..., None], px[..., :3] * FAR_LEG_SHADE, px[..., :3])
    return Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), 'RGBA')


def walk_gifs(pieces, who, jacket, hair, skin, cw, ch, ms=110, n=6):
    """The four walking GIFs: dl, dr (mirrored), ur, ul (mirrored), on the pose canvas (feet = bottom middle)."""
    frames = walk_frames(who, n)
    tag = 'p-wf' if n == 6 else 'p-w8f'
    ratio = pieces[f'{who}_stand'].height / frames['dl'][0].height
    gifs, pngs = {}, {}
    for name, pose in (('dl', 'walk_dl1'), ('ur', 'walk_ur1')):
        canvases = []
        for f in frames[name]:
            f = shade_far_leg(recolour(f, pose, who, jacket, hair, skin))
            f = f.resize((max(1, round(f.width * ratio)), max(1, round(f.height * ratio))), Image.LANCZOS)
            c = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            c.alpha_composite(f, ((cw - f.width) // 2, ch - f.height))
            canvases.append(c)
        mirrored = [ImageOps.mirror(c) for c in canvases]
        other = 'dr' if name == 'dl' else 'ul'
        gifs[name] = gif_from_frames(canvases, 'people', f'p-walk-{name}' if n == 6 else f'p-walk8-{name}', ms)
        gifs[other] = gif_from_frames(mirrored, 'people', f'p-walk-{other}' if n == 6 else f'p-walk8-{other}', ms)
        pngs[name] = [write_png(c, 'people', f'{tag}-{name}') for c in canvases]       # the same frames as PNGs: the mod steps them
        pngs[other] = [write_png(c, 'people', f'{tag}-{other}') for c in mirrored]
    return gifs, pngs


LEADER_JACKET = '#202126'      # ★92


def person(agent_id, leader=False):
    """The pictures of one agent (paths relative to the app folder). Cached on disk (people-cache.json). leader: the black-jacket set (cached as `<id>#L`)."""
    ckey = str(agent_id) + ('#L' if leader else '')
    cache_path = OUT / 'people-cache.json'
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cache = {}
    entry = cache.get(ckey)
    if entry and entry.get('v') == VERSION and entry.get('sheets') == sheet_hash() and 'hold_b' in (entry['poses'].get('prop') or {}) and all((APP_HOME / p).is_file() for p in entry['files']):
        return entry['poses']
    pieces = sheets()
    who, jacket, hair, skin = look(agent_id, leader)
    cw, ch = canvas()
    files = {}
    dozes = [d for d in DOZES if f'{who}_{d}' in pieces]
    pick = random.Random(int(hashlib.sha1(('doze' + str(agent_id)).encode('utf-8')).hexdigest()[:12], 16)).choice(dozes) if dozes else None
    fronts = [f for f in FRONT_POSES if f'{who}_{f}' in pieces]
    pcs = [f for f in PC_POSES if f'{who}_{f}' in pieces]
    staffs = [f for f in STAFF_POSES if f'{who}_{f}' in pieces]
    for pose in POSES + ([pick] if pick else []) + fronts + pcs + staffs:
        img = recolour(pieces[f'{who}_{pose}'], pose, who, jacket, hair, skin)
        on_canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        on_canvas.alpha_composite(img, ((cw - img.width) // 2, ch - img.height))
        if pose in FLIPPED:      # the desk's chair faces up-left; the typing sheet faces up-right; staff_sit faces down-right
            on_canvas = ImageOps.mirror(on_canvas)
        files[pose] = write_png(on_canvas, 'people', f'p-{pose}')
    poses = {'type': [files['type1'], files['type2']], 'raise': files['raise'], 'hold': files['hold'],
             'stand': files['stand'], 'walk_dl': [files['walk_dl1'], files['walk_dl2']],
             'walk_ur': [files['walk_ur1'], files['walk_ur2']], 'sofa': files['sofa']}
    poses.update({f: files[f] for f in fronts})      # front_wait, front_give, front_raise, bow
    poses.update({f: files[f] for f in pcs})         # type_pc, type_pc2, read_pc: at a laptop, with the chair
    poses.update({f: files[f] for f in staffs})      # staff_sit: seated window staff facing down-right (office side)
    poses['walk6_gif'], poses['walk6_frames'] = walk_gifs(pieces, who, jacket, hair, skin, cw, ch)
    poses['walk_gif'], poses['walk_frames'] = poses['walk6_gif'], poses['walk6_frames']
    if sheet_files()[f'walk8_{who}'].is_file():
        poses['walk8_gif'], poses['walk8_frames'] = walk_gifs(pieces, who, jacket, hair, skin, cw, ch, 90, 8)
        if str(office_settings().get('walk')) == '8':          # office.walk = "8": the 8-frame walk is the default one
            poses['walk_gif'], poses['walk_frames'] = poses['walk8_gif'], poses['walk8_frames']   # {'dl','dr','ur','ul'}: 6 frames (GIF kept; PNG lists for the mod)
    flips = {}
    for pose in ['stand', 'hold', 'raise', 'sofa'] + fronts + staffs + ([pick] if pick else []):    # gpui cannot mirror: ready-made copies
        flips[pose] = write_png(ImageOps.mirror(Image.open(APP_HOME / files[pose]).convert('RGBA')), 'people', f'p-{pose}-flip')
    poses['flip'] = flips
    files.update({f'flip_{k}': v for k, v in flips.items()})
    files.update({f'walk_{k}': v for k, v in poses['walk_gif'].items()})
    files.update({f'wf_{k}_{i}': f for k, fl in poses['walk_frames'].items() for i, f in enumerate(fl)})
    for tag_ in ('walk6', 'walk8'):
        if f'{tag_}_frames' in poses:
            files.update({f'{tag_}_f_{k}_{i}': f for k, fl in poses[f'{tag_}_frames'].items() for i, f in enumerate(fl)})
            files.update({f'{tag_}_g_{k}': v for k, v in poses[f'{tag_}_gif'].items()})
    cafes_ = [pp for pp in CAFE_POSES if f'{who}_{pp}' in pieces]
    if cafes_:                                                     # sitting at the cafe: chair / stool, facing us / back to us, recoloured like the person; mirrored copies too
        cf, cff = {}, {}
        for pp in cafes_:
            img = recolour(pieces[f'{who}_{pp}'], pp, who, jacket, hair, skin)
            on_canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            on_canvas.alpha_composite(img, ((cw - img.width) // 2, ch - img.height))
            cf[pp] = write_png(on_canvas, 'people', f'p-{pp}')
            cff[pp] = write_png(ImageOps.mirror(on_canvas), 'people', f'p-{pp}-flip')
        cf['flip'] = cff
        poses['cafe'] = cf
        files.update({f'cafe_{k}': v for k, v in cf.items() if k != 'flip'})
        files.update({f'cafeflip_{k}': v for k, v in cff.items()})
    props_ = [pp for pp in PROP_POSES + ['stand_b', 'hold_b'] if f'{who}_{pp}' in pieces or (pp == 'hold_b' and f'{who}_coffee_b' in pieces)]
    if props_:                                                     # waving, coffee, bag (+ stand_b: standing, back to us, no prop): facing us / back to us, recoloured like the person; mirrored copies too
        pr, prf = {}, {}
        for pp in props_:
            src_ = 'coffee_b' if pp == 'hold_b' else pp
            img = recolour(pieces[f'{who}_{src_}'], src_, who, jacket, hair, skin)
            on_canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            on_canvas.alpha_composite(img, ((cw - img.width) // 2, ch - img.height))
            if pp == 'hold_b':
                on_canvas = paper_in_hand(on_canvas)      # ★88-2 standing at the desk, back to us, a report sheet in the hand instead of the cup
            pr[pp] = write_png(on_canvas, 'people', f'p-{pp}')
            prf[pp] = write_png(ImageOps.mirror(on_canvas), 'people', f'p-{pp}-flip')
        pr['flip'] = prf
        poses['prop'] = pr
        files.update({f'prop_{k}': v for k, v in pr.items() if k != 'flip'})
        files.update({f'propflip_{k}': v for k, v in prf.items()})
    poses['type_anim'] = write_gif(poses['type'], 'people', 'p-type-anim')   # two typing frames, played by image() itself (no redraw)
    poses.update(sit=poses['type'][0], walk=poses['walk_dl'][0], doze=files[pick] if pick else poses['sofa'])   # for older callers
    cache[ckey] = {'v': VERSION, 'sheets': sheet_hash(), 'look': [who, jacket, hair, skin], 'poses': poses, 'files': list(files.values())}
    OUT.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    return poses


# ---------------------------------------------------------------- limit on generated files

GENERATED = ['sheet/furniture', 'sheet/room', 'sheet/people', 'scaled']        # folders (under hakoniwa-office/) of generated PNGs
GENERATED_PREFIXES = ('win-', 'alert-', 'scr-', 'part-door-', 'building-', 'front-', 'chair-')   # loose files in hakoniwa-office/
CACHE_MAX_BYTES = 400 * 1024 * 1024        # about 40 people's worth (a person is ~100 files, ~8 MB); the ones in the scene are never pruned
CACHE_MAX_FILES = 12000


def generated_files():
    base = APP_HOME / 'hakoniwa-office'
    found = []
    for folder in GENERATED:
        found += [f for f in (base / folder).glob('*.png') if f.is_file()] + [f for f in (base / folder).glob('*.gif') if f.is_file()]   # (the walking GIFs too: they are a third of the people folder)
    found += [f for f in base.glob('*.png') if f.is_file() and f.name.startswith(GENERATED_PREFIXES)]
    return found


def prune(keep=(), max_bytes=CACHE_MAX_BYTES, max_files=CACHE_MAX_FILES, dry_run=False, stale_after=3600, listing=None):
    """Keep the generated pictures under a size and count limit: oldest first. Only PNGs this tool and the
    office builder write, in their own folders (never desks.json, the manifest or the cache files).
    `keep`: paths (relative to the app folder, or absolute) in use by the scene on screen; those and the files
    the manifest / people cache name are never removed. Returns (removed count, removed bytes)."""
    protected = {str(Path(k)) for k in keep}
    import re
    pat = r'hakoniwa-office/[^"\\]+\.(?:png|gif)'         # a path in a JSON file (png or gif)
    # the manifest's parts and the scenes the mod remembers are kept; the people cache is not (a person whose pictures are gone is made again)
    for path_ in (OUT / 'manifest.json', APP_HOME / 'hakoniwa-office' / 'last-scene.json', APP_HOME / 'hakoniwa-office' / 'last-scene-demo.json'):
        try:                                                    # (Herdr App caches a failed load by path: a picture deleted and made again stays blank)
            text = path_.read_text(encoding='utf-8')
        except OSError:
            continue
        protected |= set(re.findall(pat, text))
    protected = {Path(p).as_posix() for p in protected}
    files = generated_files()
    sizes = {f: f.stat().st_size for f in files}
    total, count = sum(sizes.values()), len(files)
    removed = freed = 0
    for f in sorted(files, key=lambda f: f.stat().st_mtime):
        if total <= max_bytes and count <= max_files:
            break
        rel_ = f.relative_to(APP_HOME).as_posix() if f.is_relative_to(APP_HOME) else f.as_posix()
        if rel_ in protected or f.as_posix() in protected:
            continue
        if not dry_run:
            f.unlink()
        total -= sizes[f]
        count -= 1
        removed += 1
        freed += sizes[f]
    # ★16-7: pictures of OLD versions: files in sheet/furniture that neither the manifest nor a remembered scene names and that are older than
    # `stale_after` seconds (a version bump leaves a whole set behind); never one the screen may still show (they are in `protected`)
    now_ = time.time()
    # ★20: the same for the people folder: a person that the scene on screen / the remembered scenes do not name, and that is older than an hour, goes
    # (made again when needed; a path the screen may still show is in `protected`)
    for f in [g for sub_ in ('furniture', 'people') for g in (APP_HOME / 'hakoniwa-office' / 'sheet' / sub_).glob('*')]:
        if not f.is_file() or f.suffix not in ('.png', '.gif'):
            continue
        rel_ = f.relative_to(APP_HOME).as_posix()
        if rel_ in protected or f.as_posix() in protected or now_ - f.stat().st_mtime < stale_after:
            continue
        size_ = f.stat().st_size
        if listing is not None:
            listing.append(rel_)
        if not dry_run:
            try:
                f.unlink()
            except OSError:
                continue
        removed += 1
        freed += size_
    if removed and not dry_run:                                # the people cache must not name a picture that is gone: such a person is dropped from it (made again when needed)
        try:
            cache_path = OUT / 'people-cache.json'
            cache = json.loads(cache_path.read_text(encoding='utf-8'))
            kept = {k: e for k, e in cache.items() if not (isinstance(e, dict) and any(not (APP_HOME / f_).is_file() for f_ in e.get('files', [])))}
            if len(kept) != len(cache):
                tmp_ = cache_path.with_name(cache_path.name + f'.{os.getpid()}.tmp')
                tmp_.write_text(json.dumps(kept, ensure_ascii=False), encoding='utf-8')
                os.replace(tmp_, cache_path)
        except (OSError, ValueError):
            pass
    return removed, freed


# ---------------------------------------------------------------- contact sheet (CLI)

def preview(path, ids):
    manifest = parts()
    rows = [('furniture', [(n, Image.open(APP_HOME / v['file'])) for n, v in manifest['parts'].items()]
             + [(f'screen_on_{i}', Image.open(APP_HOME / f['file'])) for i, f in enumerate(manifest['screen_on']['frames'])])]
    for agent_id in ids:
        flat = [(k if not isinstance(v, list) else f'{k}{i + 1}', f) for k, v in person(agent_id).items()
                if k not in ('sit', 'walk', 'doze') for i, f in enumerate(v if isinstance(v, list) else [v])]
        rows.append((f'person {agent_id}  {look(agent_id)}', [(k, Image.open(APP_HOME / f)) for k, f in flat]))
    scale, pad, lab = .4, 10, 16
    heights = [int(max(i.height for _, i in items) * scale) + lab + pad for _, items in rows]
    widths = [sum(int(i.width * scale) + pad for _, i in items) + pad for _, items in rows]
    sheet = Image.new('RGBA', (max(widths), sum(heights) + pad), '#f3efe7')
    draw = ImageDraw.Draw(sheet)
    y = pad
    for (title, items), hgt in zip(rows, heights):
        x = pad
        draw.text((pad, y - 2), title, fill='#444444')
        for name, img in items:
            small = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
            sheet.alpha_composite(small, (x, y + hgt - pad - small.height))
            draw.text((x, y + lab - 2), name, fill='#888888')
            x += small.width + pad
        y += hgt
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert('RGB').save(path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--preview', type=Path, help='write a contact sheet PNG here')
    ap.add_argument('--grid-preview', type=Path, help='write the footprint check sheet PNG here')
    ap.add_argument('--ids', default='demo:a,demo:b,demo:c,demo:d,demo:e,demo:f', help='agent ids to draw in the preview')
    ns = ap.parse_args(argv)
    manifest = parts()
    if ns.grid_preview:
        grid_preview(ns.grid_preview)
    if ns.preview:
        preview(ns.preview, ns.ids.split(','))
    print(json.dumps({'parts': list(manifest['parts']), 'sprite': manifest['sprite'], 'out': str(OUT)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
