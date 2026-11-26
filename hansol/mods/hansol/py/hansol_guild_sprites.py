#!/usr/bin/env python3
"""The guild hall (dark) layout's pictures: the sheets the user makes from sheets/guild-dark/README.md.

sheets/guild-dark/sheets.json is the one description of the sheets (file, the pieces row by row). This module
finds the pieces of a sheet the same way hansol_sprites.py does (connected parts of the alpha channel, in
reading order) and says, sheet by sheet, whether the count and the rows match - so a sheet that came out with
two pieces stuck together is named before anything is cut.

An image model may give a flat background instead of transparency: then the colour of the four corners is the
background (pixels near it become transparent).
"""
import hashlib
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import hansol_sprites as sp

HERE = Path(__file__).resolve().parent
THEMES = {'guild-dark': ('guild-dark', 'guild', 'guild_sheets'),       # a theme: (its sheets folder under sheets/, its
          'guild-meadow': ('meadow', 'meadow', 'meadow_sheets')}       # app-home output folder, its config.json key)
THEME = 'guild-dark'   # the theme worked from now: guild-dark at import, as it has always been
SHEET_DIR = HERE / 'sheets' / THEMES[THEME][0]
SPEC_FILE = SHEET_DIR / 'sheets.json'
GAP = 2            # grow steps (4 px cells) when joining a piece's bits: pieces closer than ~16 px become one
BG_TOLERANCE = 28  # a flat background: this far (RGB distance) from the corners' colour is still background


def use(theme):
    """Set the theme this module works from: every folder it uses alone (the sheets folder, the app-home output
    folders of the checked and the cut pieces) takes the theme's value again. Import time is guild-dark."""
    global THEME, SHEET_DIR, SPEC_FILE, CHECK_CACHE, CUT_DIR
    THEME = theme
    sheets_dir, out, _ = THEMES[theme]
    SHEET_DIR = HERE / 'sheets' / sheets_dir
    SPEC_FILE = SHEET_DIR / 'sheets.json'
    CHECK_CACHE = sp.APP_HOME / 'hansol-office' / out / 'check-cache.json'
    CUT_DIR = sp.APP_HOME / 'hansol-office' / out / 'cut'


def spec():
    return json.loads(SPEC_FILE.read_text(encoding='utf-8'))


def sheet_dir():
    """config.json office.guild_sheets / meadow_sheets (the theme's key, a folder) overrides the bundled folder."""
    given = sp.office_settings().get(THEMES[THEME][2])
    return Path(given).expanduser() if isinstance(given, str) and given else SHEET_DIR


def source(entry, folder=None):
    """(Path, recolor) of a sheet's PNG: the theme's own folder first (a sheet drawn for this theme wins); a sheet
    that is missing comes from the spec's fallback folder, recolored when the spec says so and the sheet is not one
    of the people sheets (a class sheet: the people as they are); no fallback: the theme's own path, missing as it is."""
    folder = sheet_dir() if folder is None else folder
    own = folder / entry['file']
    if own.is_file():
        return own, False
    s = spec()
    fb = s.get('fallback')
    if isinstance(fb, str) and fb:
        return HERE / 'sheets' / fb / entry['file'], bool(s.get('recolor')) and not entry.get('class')
    return own, False


def brighten(img):
    """A dark sheet turned bright pastel (the meadow's recolor): the value lifted (V' = 0.45 + 0.55 * V ** 0.7, so
    nothing stays really dark), the saturation softened (S' = S * 0.8), the hue kept; pure white stays pure white.
    RGBA: the alpha is untouched."""
    a = np.array(img.convert('RGBA'))
    hsv = np.array(Image.fromarray(a[..., :3], 'RGB').convert('HSV')).astype(np.float32)
    hsv[..., 2] = np.clip(255 * (0.45 + 0.55 * (hsv[..., 2] / 255) ** 0.7), 0, 255)
    hsv[..., 1] = np.clip(hsv[..., 1] * 0.8, 0, 255)
    out = np.array(Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB'))
    out[(a[..., :3] == 255).all(axis=2)] = 255
    a[..., :3] = out
    return Image.fromarray(a, 'RGBA')


def open_sheet(path, recolor):
    """A sheet's PNG as RGBA, brightened right away when it comes recolored from a fallback folder."""
    return brighten(Image.open(path)) if recolor else Image.open(path).convert('RGBA')


def alpha_of(img):
    """The alpha channel; a sheet with no transparency gets one from its corners' colour."""
    rgba = np.array(img.convert('RGBA'))
    a = rgba[..., 3]
    if (a < 250).mean() > 0.05:                 # real transparency
        return a
    rgb = rgba[..., :3].astype(np.int32)
    h, w = a.shape
    corners = np.array([rgb[2, 2], rgb[2, w - 3], rgb[h - 3, 2], rgb[h - 3, w - 3]])
    bg = np.median(corners, axis=0)
    far = np.sqrt(((rgb - bg) ** 2).sum(axis=2)) > BG_TOLERANCE
    return np.where(far, 255, 0).astype(np.uint8)


def piece_rows(alpha):
    """The pieces' boxes grouped in rows (top row first, left to right): a new row starts where a piece's centre is
    lower than the current row's centre by more than 45 % of the pieces' median height."""
    boxes = sp.components(alpha, GAP)
    if not boxes:
        return []
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    limit = 0.45 * float(np.median([b[3] - b[1] for b in boxes]))
    rows, row = [], [boxes[0]]
    for b in boxes[1:]:
        if (b[1] + b[3]) / 2 - sum((r[1] + r[3]) / 2 for r in row) / len(row) > limit:
            rows.append(row)
            row = [b]
        else:
            row.append(b)
    rows.append(row)
    return [sorted(r, key=lambda b: b[0]) for r in rows]


def check_sheet(entry, folder):
    """{key, file, ok, found, expected, rows_found, rows_expected, problem}."""
    want = [len(r) for r in entry['rows']]
    out = {'key': entry['key'], 'file': entry['file'], 'expected': sum(want), 'rows_expected': want,
           'found': 0, 'rows_found': [], 'ok': False, 'problem': None}
    path, recolor = source(entry, folder)
    if not path.is_file():
        out['problem'] = 'missing'
        return out
    try:
        rows = piece_rows(alpha_of(open_sheet(path, recolor)))
    except (OSError, ValueError) as e:
        out['problem'] = f'unreadable: {e}'
        return out
    out['rows_found'] = [len(r) for r in rows]
    out['found'] = sum(out['rows_found'])
    if out['rows_found'] == want:
        out['ok'] = True
    elif out['found'] != out['expected']:
        out['problem'] = f"{out['found']} pieces, expected {out['expected']} (pieces touching, or a loose bit: keep 40 px or more empty between pieces)"
    else:
        out['problem'] = f"rows {out['rows_found']}, expected {want} (keep each row's pieces at one height, rows well apart)"
    return out


CHECK_CACHE = sp.APP_HOME / 'hansol-office' / 'guild' / 'check-cache.json'


def _file_sig(entry, folder):
    try:
        p, recolor = source(entry, folder)
        st = p.stat()
        return f"{st.st_size}-{int(st.st_mtime)}-{hashlib.sha1(json.dumps(entry['rows']).encode()).hexdigest()[:6]}{'-r' if recolor else ''}"
    except OSError:
        return '-'


def check():
    """{ready, total, folder, extra, sheets: [...], missing: [file...]} - ready / total count the required sheets that match exactly;
    extra counts the optional ones (required: false). Each sheet's result is kept in guild/check-cache.json while that sheet's file
    is unchanged (finding the pieces of a big sheet takes seconds)."""
    s, folder = spec(), sheet_dir()
    try:
        got = json.loads(CHECK_CACHE.read_text(encoding='utf-8'))
        per = got.get('per', {}) if got.get('folder') == str(folder) else {}
    except (OSError, ValueError, AttributeError):
        per = {}
    sheets, fresh = [], {}
    for e in s['sheets']:
        sig = _file_sig(e, folder)
        hit = per.get(e['key'])
        res = hit['res'] if hit and hit.get('sig') == sig and sig != '-' else check_sheet(e, folder)
        fresh[e['key']] = {'sig': sig, 'res': res}
        sheets.append(dict(res, required=e.get('required', True)))
    need, extra = [x for x in sheets if x['required']], [x for x in sheets if not x['required']]
    state = {'ready': sum(1 for x in need if x['ok']), 'total': len(need), 'folder': str(folder),
             'extra': {'ready': sum(1 for x in extra if x['ok']), 'total': len(extra),
                       'missing': [x['file'] for x in extra if not x['ok']]},   # the optional sheets: more classes, the writing frames, the standard
             'sheets': sheets, 'missing': [x['file'] for x in need if not x['ok']]}
    if fresh != per:
        try:
            CHECK_CACHE.parent.mkdir(parents=True, exist_ok=True)
            CHECK_CACHE.write_text(json.dumps({'folder': str(folder), 'per': fresh}, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass
    return state


def usable(state=None):
    """{'classes': [classes whose poses and walk sheets are ok, in sheets.json order], 'work': {class: True when its writing frames are ok},
    'g7' / 'g8' / 'g10' / 'g11': True when the standard + plaque / the outside views / the extra things / the see-through windows sheet is ok}."""
    state = state or check()
    ok = {x['key'] for x in state['sheets'] if x['ok']}
    classes = [c for c in spec().get('classes', []) if f'{c}_poses' in ok and f'{c}_walk' in ok]
    return {'classes': classes, 'work': {c: f'{c}_work' in ok for c in classes}, 'g7': 'g7_guild' in ok, 'g8': 'g8_outside' in ok, 'g10': 'g10_decor' in ok, 'g11': 'g11_windows' in ok}


# ---------------------------------------------------------------- cutting (P2)

def sheets_signature(folder=None):
    """Changes when a sheet file changes (size + mtime of every sheet and of sheets.json): the cut pieces are made again."""
    folder = folder or sheet_dir()
    parts = []
    for e in spec()['sheets'] + [{'file': 'sheets.json'}]:
        p, recolor = (SHEET_DIR / 'sheets.json', False) if e['file'] == 'sheets.json' else source(e, folder)
        try:
            st = p.stat()
            parts.append(f"{e['file']}:{st.st_size}:{int(st.st_mtime)}{'-r' if recolor else ''}")
        except OSError:
            parts.append(f"{e['file']}:-")
    return hashlib.sha1('|'.join(parts).encode()).hexdigest()[:12]


CUT_DIR = sp.APP_HOME / 'hansol-office' / 'guild' / 'cut'
CUT_VERSION = 2   # raise when the cutting changes: the pieces are cut again (2: a piece keeps only its own pixels)


def cut_sheet(entry, folder=None):
    """{piece name: RGBA image cropped to its own pixels} (names from sheets.json, in reading order).
    Kept in the theme's own cut/<sheet>-<size>-<mtime>-<rows>/ (finding the pieces of a big sheet takes seconds): a changed sheet is cut again
    and its older cut folder goes."""
    path, recolor = source(entry, folder)
    st = path.stat()
    stem = Path(entry['file']).stem
    key = f"{stem}-{st.st_size}-{int(st.st_mtime)}-{hashlib.sha1((json.dumps([entry['rows'], CUT_VERSION]) + ('-r' if recolor else '')).encode()).hexdigest()[:6]}"
    d = CUT_DIR / key
    names = [n for r in entry['rows'] for n in r]
    if all((d / f'{n}.png').is_file() for n in names):
        out = {}
        for n in names:
            with Image.open(d / f'{n}.png') as im:
                out[n] = im.convert('RGBA')
        return out
    out = _cut_sheet(entry, path, recolor)
    if len(out) == len(names):
        try:
            d.mkdir(parents=True, exist_ok=True)
            for n, im in out.items():
                tmp = d / f'{n}.{os.getpid()}.tmp'
                im.save(tmp, 'PNG', compress_level=1)
                os.replace(tmp, d / f'{n}.png')
            for old in CUT_DIR.glob(f'{stem}-*'):
                if old != d and old.is_dir() and old.name.rsplit('-', 3)[0] == stem:
                    for f in old.glob('*'):
                        f.unlink()
                    old.rmdir()
        except OSError:
            pass
    return out


def _owners(alpha):
    """(each px's piece number or -1, {piece box: number}): the pieces as sp.components finds them (4 px cells grown by GAP),
    so a piece's crop keeps only its own pixels where its box overlaps a neighbour's (a candle tip of the row below)."""
    C = sp.CELL
    h, w = alpha.shape
    small = (alpha[:h // C * C, :w // C * C] > sp.ALPHA_MIN).reshape(h // C, C, w // C, C).any(axis=(1, 3))
    own = np.full(small.shape, -1, np.int32)
    ids = {}
    for i, cells in enumerate(sp.label(sp._grow(small, GAP))):
        ys, xs = zip(*cells)
        own[list(ys), list(xs)] = i
        ids[(min(xs) * C, min(ys) * C, (max(xs) + 1) * C, (max(ys) + 1) * C)] = i
    px = np.full((h, w), -1, np.int32)
    px[:h // C * C, :w // C * C] = np.repeat(np.repeat(own, C, axis=0), C, axis=1)
    return px, ids


def _cut_sheet(entry, path, recolor=False):
    img = open_sheet(path, recolor)
    a = alpha_of(img)
    owner, ids = _owners(a)
    if (np.array(img)[..., 3] < 250).mean() <= 0.05:          # a flat background: the corners' colour becomes transparent
        arr = np.array(img)
        arr[..., 3] = a
        img = Image.fromarray(arr, 'RGBA')
    out = {}
    for names, boxes in zip(entry['rows'], piece_rows(a)):
        for name, b in zip(names, boxes):
            piece = img.crop(b)
            arr = np.array(piece)
            arr[..., 3] = np.where(arr[..., 3] > 8, arr[..., 3], 0)   # the faint haze an image model leaves around a piece
            i = ids.get(tuple(int(v) for v in b))
            if i is not None:
                arr[..., 3] = np.where(owner[b[1]:b[3], b[0]:b[2]] == i, arr[..., 3], 0)
            piece = Image.fromarray(arr, 'RGBA')
            bb = piece.getbbox()
            out[name] = piece.crop(bb) if bb else piece
    return out


def bottom_profile(img):
    """For each column with pixels: the lowest opaque row. Returns (xs, ys) as numpy arrays."""
    a = np.array(img)[..., 3] > 40
    xs = np.nonzero(a.any(axis=0))[0]
    ys = np.array([np.nonzero(a[:, x])[0].max() for x in xs])
    return xs, ys


def orient(img):
    """'bs' when the piece's long base runs like a backslash (upper left -> lower right; it stands against the right back wall,
    its face looking down-left), 'fs' for a slash. From the longer of the two runs of its bottom outline."""
    xs, ys = bottom_profile(img)
    i = int(np.argmax(ys))
    left, right = xs[i] - xs[0], xs[-1] - xs[i]
    return 'bs' if left >= right else 'fs'


def front_corner(img):
    """(x, y) of the lowest point of the bottom outline (the front corner of a thing standing on the floor), in the image's px."""
    xs, ys = bottom_profile(img)
    best = ys.max()
    sel = xs[ys >= best - 1]
    return float(sel.mean()), float(best)


def feet_x(img):
    """The middle of the feet (the opaque pixels of the lowest 6 % of the picture), in the image's px."""
    a = np.array(img)[..., 3] > 60
    h = a.shape[0]
    band = a[int(h * 0.94):, :]
    xs = np.nonzero(band.any(axis=0))[0]
    return float((xs.min() + xs.max()) / 2) if len(xs) else img.size[0] / 2


def scaled(img, s):
    w, h = max(1, round(img.size[0] * s)), max(1, round(img.size[1] * s))
    return img.resize((w, h), Image.LANCZOS)


def mirrored(img):
    return img.transpose(Image.FLIP_LEFT_RIGHT)


# ---------------------------------------------------------------- people (P2)

ROBES = ['#9b1c2e', '#2a4fa8', '#2f6b3a', '#5b2c83', '#1f7a7a', '#b5832a', '#7a4a2a', '#4a5568', '#6d1f4f', '#1f2f5a', '#6b6b2a', '#d8cfb8']


def _pick(key, n):
    return int.from_bytes(hashlib.sha1(key.encode('utf-8')).digest()[:4], 'big') % n


def class_of(agent_id, classes):
    """The class of an agent: a stable pick from its id (independent of the robe)."""
    return classes[_pick(f'{agent_id}|class', len(classes))]


def robe_of(agent_id):
    return ROBES[_pick(f'{agent_id}|robe', len(ROBES))]


HAIRS = [None, (None, 0.45, 0.42), (45, 0.6, 1.7), (6, 1.25, 1.0), (None, 0.1, 1.75), (20, 1.35, 1.3)]   # as drawn, black, blonde, auburn, silver, ginger


def hair_of(agent_id):
    """The agent's hair: an index into HAIRS (its own pick, not the class's nor the robe's)."""
    return _pick(f'{agent_id}|hair', len(HAIRS))


def rehair(img, n):
    """The brown hair (and a brown hat) in the top 42 % of a person's picture: hue / saturation / value of HAIRS[n]."""
    h = HAIRS[n]
    if h is None:
        return img
    hue, ss, vs = h
    a = np.array(img)
    hsv = np.array(Image.fromarray(a[..., :3], 'RGB').convert('HSV')).astype(np.float32)
    al = a[..., 3] > 0
    ys = np.nonzero(al.any(axis=1))[0]
    if not len(ys):
        return img
    top, bot = ys.min(), ys.max()
    rows = np.arange(a.shape[0])[:, None]
    m = al & (rows <= top + (bot - top) * 0.42) & (hsv[..., 0] >= 6) & (hsv[..., 0] <= 30) & (hsv[..., 1] >= 70) & (hsv[..., 2] <= 165)
    if hue is not None:
        hsv[..., 0] = np.where(m, hue * 255 / 360, hsv[..., 0])
    hsv[..., 1] = np.where(m, np.clip(hsv[..., 1] * ss, 0, 255), hsv[..., 1])
    hsv[..., 2] = np.where(m, np.clip(hsv[..., 2] * vs, 0, 255), hsv[..., 2])
    a[..., :3] = np.array(Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB'))
    return Image.fromarray(a, 'RGBA')


def _hsv(hex_):
    c = Image.new('RGB', (1, 1), hex_).convert('HSV').getpixel((0, 0))
    return c


def key_mask(img, key_hex, hue_tol=24):
    """The pixels drawn in the key colour (its hue, saturated enough): a robe, a standard's cloth."""
    kh = _hsv(key_hex)[0]
    rgba = np.array(img)
    hsv = np.array(Image.fromarray(rgba[..., :3], 'RGB').convert('HSV')).astype(np.int32)
    dh = np.abs(hsv[..., 0] - kh)
    dh = np.minimum(dh, 256 - dh)
    return (dh <= hue_tol) & (hsv[..., 1] >= 55) & (rgba[..., 3] > 0)


def recolor(img, key_hex, to_hex, hue_tol=24):
    """The robe: pixels near the key colour's hue (and saturated enough) take the new colour's hue; saturation and value are scaled by
    new / key, so the shading stays."""
    if to_hex.lower() == key_hex.lower():
        return img
    kh, ks, kv = _hsv(key_hex)
    th, ts, tv = _hsv(to_hex)
    rgba = np.array(img)
    hsv = np.array(Image.fromarray(rgba[..., :3], 'RGB').convert('HSV')).astype(np.int32)
    dh = np.abs(hsv[..., 0] - kh)
    dh = np.minimum(dh, 256 - dh)
    sat = (hsv[..., 1] >= 55) & (rgba[..., 3] > 0)
    core = (dh <= hue_tol) & sat
    near = np.array(Image.fromarray(core.astype(np.uint8) * 255, 'L').filter(ImageFilter.MaxFilter(5))) > 0
    mask = core | (near & (dh <= hue_tol * 2) & sat)    # the key colour's edge, blended with the trim or the outline (left pink otherwise)
    out = hsv.copy()
    out[..., 0] = np.where(mask, th, hsv[..., 0])
    out[..., 1] = np.where(mask, np.clip(hsv[..., 1] * (ts / max(1, ks)), 0, 255), hsv[..., 1])
    out[..., 2] = np.where(mask, np.clip(hsv[..., 2] * (tv / max(1, kv)), 0, 255), hsv[..., 2])
    rgb = np.array(Image.fromarray(out.astype(np.uint8), 'HSV').convert('RGB'))
    rgba[..., :3] = rgb
    return Image.fromarray(rgba, 'RGBA')
