#!/usr/bin/env python3
"""Build the agent HUD's Office floor: one isometric room-floor PNG assembled from PNG parts.

Static things (desks, chairs, plants, sofa, reception, partitions, doors) are transparent PNGs cut from the
sheet (hakoniwa_sprites.parts() / sheet/manifest.json) and pasted as they are, scaled by one factor.  Only the
parts that do not exist yet (floor boards, back walls) have a plain placeholder; when the sheet gets
'floor_tile' / 'wall_left' / 'wall_right' parts they are used instead (see PLACEHOLDER below).
Moving things are NOT in the floor: people (hakoniwa_sprites.person(id)), the lit monitor screens
(screen_on, two frames), the door (closed / open PNG) and the front glass (foreground).

Layout: one room per box (T3 Code, Herdr App, herdr TUI while it has agents) with a desk per agent plus a free
desk, in front of them the lobby: entrance door + reception, approval desk, submit counter, small lounge.

Input:  --agents '[{"id","source","parent_id"}...]'  (color / status are ignored)
Output: stdout JSON; paths relative to ~/.config/herdr-app; all coordinates are pixels of the floor PNG.
        Desk memory: desks.json (desks-demo.json for ids starting with "demo:") in the out dir.
"""
import argparse
import hashlib
import io
import json
import math
import os
import random
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

sys.dont_write_bytecode = True   # ★108: in the layout collection's copy this folder is inside mods/<name>/, where a __pycache__ would reload the mod
sys.path.insert(0, str(Path(__file__).resolve().parent))

APP_HOME = Path(os.environ.get('HERDR_APP_HOME') or Path.home() / '.config' / 'herdr-app')
OUT_DIR = APP_HOME / 'hakoniwa-office'
MANIFEST = OUT_DIR / 'sheet' / 'manifest.json'

TW, TH = 48, 24                  # one tile on screen (isometric 2:1)
WALL_H = 128
FLOOR_AISLE = (221, 208, 196)                            # #ddd0c4: aisles, lobby
FLOOR_EDGE = (179, 160, 151)                             # #b3a097: the floor's thickness on the two front edges
ISLAND_FLOORS = [(96, 110, 131), (75, 119, 124), (184, 143, 122)]   # slate #606e83, deep teal #4b777c, taupe #b88f7a: one per island, in turn
RUG_COLOR = (221, 208, 196)                              # ★44-1: the lounge floor is the office floor (FLOOR_AISLE), no colour of its own
MARGIN = 24
S = 0.32                         # scale of furniture parts (sheet pixels -> floor pixels)
PK = 0.30                        # scale of people images
K = 1.0                          # whole-floor scale: --box makes the floor exactly the size it is shown at
SCALE_STEP = 0.25                # ★90 (C): the whole floor is made at quarter steps: a resize inside a step reuses every picture (band/obj6/floor)
PX_, PY_ = 4, 4                  # desk block (cells): along x (desk 3 + aisle), along y (desk 2 + chair + aisle)
DESK_W, DESK_D = 3, 2            # a desk's cells; ART_D is the depth the desk picture itself spans (for its scale)
ART_D = 1.5
DESK_HOLD = 3600
SPOT_DX, SPOT_DY, QROWS = 1.7, 1.6, 3
PLANK_K = 1.0                                # B's plank (2 tiles of 120 px) spans 1.5 of our cells: two planks make the 3 cells of one seat
FRONT_WINDOWS = False                        # ★59: undo ★26-4 — back to the r25 layout (chairs on the near side, no staff_sit in the scene; the front-window path stays unused)
STAFF_BACK = .4                               # ★52-4: the window clerk's chair, in cells from the desk's back edge (its rows are y0, y0+1)
WIN_X0, WIN_GAP = 6, 2                      # ★26-4: the first window's x and the cells between the two (each is 4 x 2 cells)
DESK_GAP = 0.6                              # ★46 (A9): one table per seat: this much floor (cells) between two seats' desks
ROW_PITCH = 5                               # cells between two rows of seats: the pictures of one row do not reach the next
SEATS_PER_ROW = 6                           # (unused since ★30-2) a long desk was at most this many seats
LSTRIP = 4                                                # ★86: the strip along the left wall beside the rooms (the door and the drinks stand in it; the rooms start right of it)
L86 = os.environ.get('HERDR_L86', '1') != '0'               # ★86 (ON; HERDR_L86=0 gives the old two-column floor): ONE column of rooms stacked down-left, a shallow lobby (door), no break room / approval desk / counter (HERDR_L86=0: the old two-column floor)
AISLE_W = 3                                 # ★30-2: the middle aisle (islands touch the left and the right outer wall)
ISLAND_PAD = 2                              # ★30-3: the island is 3 * seats + this many cells wide (was 4)
ISLAND_SEATS = 5                            # ★30-2: every island is the same size: ONE row of this many seats (two of them side by side fit the floor's width)
QLEN = 4                                    # the line behind a window: up to this many people in one straight line
QCAP = 3                                    # people lined up (one column) behind one window; more stand on the nearest free cells
LCAP = 4                                    # armchair spots in the lounge: 3 cells apart along x and 4 along y, so the pictures do not overlap
LOUNGE_W = 7                                # width of the lounge block (cells)       # the queues stand behind the windows: QROWS deep, one more column per QROWS people
NO_LINTEL = True                            # ★27-4: the islands' openings have no frame with a bar on top: the partitions just stop
LSTEP_X = 3                                 # ★26-2: sitting points of the lounge: 3 cells apart along x and 3 along y
LSTEP_Y = 3
LB_X0 = 5                                   # ★83-1: the break room's first column (x 1 the drinks, x 2-3 their standing points, x 4: a sitter there covers the vending machine)
LB_ROWS_MIN = 6                             # ★83-1: its rows at least
LB_ROWS_MAX = 9                             # ★83-1: more rows than this: a second band in front of the right column's rooms
LB_CELLS = 6                                # ★83-1: band cells per sitting point (the packing of take(): about 1 in 6 cells)
LOBBY_EXTRA = 0                             # ★57-3 (A12): rows added to the lobby by main()'s retry (the big approval card found no room); 99 = the depth as before A12


def LOUNGE_CAND(n_, idle_):
    """waiting_seated (A10): on the 3 x 3 grid a sitting point right in front of another (one step along x and y: the same screen column) covers it and is
    dropped, about 1 in 3 when many wait. The candidates (and the lounge's rows): the planned points, or 1.6 x (the people waiting + 1) when that is
    more, so that everybody who waits still sits (few waiting: nothing changes)."""
    return max(n_, math.ceil(1.6 * (idle_ + 1)) if idle_ > 0 else 0)
LCOLS = 4                                  # the lounge's own columns
TEAM_RUGS = [(255, 196, 120), (140, 196, 255), (196, 156, 255), (140, 226, 176), (255, 160, 186), (236, 226, 110)]
ZONES = [('t3', 'T3 Code'), ('app', 'Herdr App'), ('tui', 'herdr TUI')]
PLACEHOLDER = {'floor_a': (196, 140, 92), 'floor_b': (186, 130, 84), 'lobby_a': (214, 178, 134), 'lobby_b': (206, 168, 124),
               'wall_l': (232, 226, 218), 'wall_r': (222, 216, 208)}


# ---------------------------------------------------------------- parts and people
BAND_DEADLINE = 10.0                                      # seconds after the start of a run: no new band is begun after this (a band takes 3-6 s; the App's limit is 30 s)


def PERIOD_ORDER():
    h_ = time.localtime().tm_hour
    first_ = 'night' if h_ >= 19 or h_ < 5 else 'morning' if h_ < 10 else 'day' if h_ < 16 else 'evening'
    return [first_] + [q_ for q_ in ('morning', 'day', 'evening', 'night') if q_ != first_]


FURN_SCALE = {'equip_vending': 3.0, 'equip_water': 3.0, 'equip_mfp': 3.0, 'equip_printer': 1.5, 'equip_files': 3.0, 'equip_rack': 1.2, 'equip_coat': 1.2,
              'equip_coffee': 3.0, 'deco_whiteboard': 3.0, 'deco_bookshelf': 3.0, 'deco_fridge': 3.0, 'deco_locker': 3.0, 'deco_microwave': 2.4, 'deco_shredder': 2.4, 'deco_recycle': 2.4, 'deco_cafe': 2.0, 'deco_hightable': 2.0, 'deco_bench': 2.0, 'deco_counter': 2.4, 'deco_barstool': 1.7, 'deco_welcome': 3.0}              # ★69: the five isometric machines are drawn at one scale (sprites ISO_K): one factor for all, the vending machine as tall as before. ★20-1: against a person (about 190 pack px); ★42: the vending machine, the water server and the copier / printer twice as big (taller than a plant; the vending machine a little taller than the entrance's door); ★52-5 (A10): the water server 1.44 -> 2.0 (still read small: about 2/3 of the vending machine)
SHREDDER_RATIO = .85                                       # ★102: the shredder's (opaque) height against the copier's: 0.8-0.9
TRASH_SCALE = .5                                          # ★50-6: a bin about knee-high (was as tall as a person; the one by the entrance looked bigger than the vending machine)
EQUIP_FOOT = {'equip_vending': [(0, 0), (-1, 0)], 'equip_mfp': [(0, 0), (-1, 0)], 'deco_counter': [(0, 0), (-1, 0)]}   # ★42: the cells a machine takes, from its cell; ★69: 2 along the wall x 1 deep (the isometric pictures: vending 1.6 x 1.0, copier 1.5 x 1.0); the others keep 1 x 1
# ★63: the fixed machines' row on the left wall, from the door towards the rooms: (part, rows along the wall). The vending machine takes 2 rows.
# ★74-7: only the drinks corner (the coffee machine, the water server, the vending machine); the copier and the file cabinet moved to EQUIP_BACK.
EQUIP_ROW = (('equip:coffee', 'equip_coffee', 1), ('equip:water', 'equip_water', 1), ('equip:vending', 'equip_vending', 2))
if os.environ.get('HERDR_L86', '1') != '0':
    EQUIP_ROW = ()                                  # ★88-1: the left wall holds only the door: the vending machine on the lower-left room's front partition, the water server and the coffee machine on each room's side partition
# ★74-7: the copier and the file cabinet back to back on the outside of the front partition of the left column's front room (the outermost
# partition, facing the lobby; the _R pictures, front +y): (id, part, the anchor cell's x from the room's x). The row is the room's y + h.
EQUIP_BACK = (('equip:mfp', 'equip_mfp', 3),)
EQUIP_BACK_VEND = ('equip:vending', 'equip_vending', 9)   # ★88-1: _R (front +y), back to back on the lowest-left room's front partition (L86)
EQUIP_ROW_N = sum(n_ for *_, n_ in EQUIP_ROW)
COLD = [False]                                            # ★A4-0: a view / weather band of this floor size is not made yet: not made in this run (30 s limit), made apart (spawn_warm)
BUILD_BANDS = bool(os.environ.get('HERDR_OFFICE_WARM') or os.environ.get('HERDR_OFFICE_BANDS'))     # the apart run and the tests make the bands in the run itself
EARLY = {'args': None, 'state': None, 'done': False}     # ★A8: main() fills it; the first COLD spawns the apart warm run at once (the App may stop this run at 30 s before it reaches main()'s end)


def early_warm(out_dir):
    if EARLY['done'] or EARLY['args'] is None or WARM or os.environ.get('HERDR_OFFICE_NO_SPAWN'):
        return
    EARLY['done'] = True
    try:
        (out_dir / 'warm-args.json').write_text(json.dumps(EARLY['args'], ensure_ascii=False), encoding='utf-8')
        if EARLY['state'] is not None:                      # the K this run chose, so that the apart run makes the pictures of the same scale
            (out_dir / 'desks.json').write_text(json.dumps(EARLY['state'], ensure_ascii=False), encoding='utf-8')
        spawn_warm(out_dir)
    except Exception:
        pass


STALE = [False]                                           # the sprite pack on disk is older than the code: drawn with it as it is, rebuilt apart
WARM = bool(os.environ.get('HERDR_OFFICE_WARM'))           # the apart run (--warm): builds the pack and the people, no time limit


def pack_state(sp):
    """('current' | 'stale' | 'none', the saved manifest): `stale` = another version or sheets, but every picture of it is still there."""
    try:
        saved = json.loads(MANIFEST.read_text(encoding='utf-8'))
        files_ok = all((APP_HOME / v['file']).is_file() for v in saved['parts'].values())
    except (OSError, ValueError, KeyError, AttributeError):
        return 'none', None
    if not files_ok:
        return 'none', None
    if sp is not None and saved.get('version') == getattr(sp, 'VERSION', None) and saved.get('stamp') == sp.sheet_hash():
        return 'current', saved
    return 'stale', saved


def load_parts():
    try:
        import hakoniwa_sprites as sp
    except Exception:
        sp = None
    if sp is not None and hasattr(sp, 'parts') and not WARM:
        state, saved = pack_state(sp)
        if state == 'stale':                                  # never build here: the App stops a run after 30 s
            STALE[0] = True
            return saved.get('parts', saved), sp, saved
    if sp is not None and hasattr(sp, 'parts'):
        try:
            pack = sp.parts()
            return pack.get('parts', pack), sp, pack
        except Exception:
            pass
    try:
        pack = json.loads(MANIFEST.read_text(encoding='utf-8'))
        return pack['parts'], sp, pack
    except (OSError, ValueError):
        return {}, sp, {}


def open_png(rel):
    return Image.open(APP_HOME / rel).convert('RGBA')


def scaled(part, k=None):
    k = (S if k is None else k) * K
    im = open_png(part['file'])
    w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
    return im.resize((w, h), Image.LANCZOS), (part['foot'][0] * k, part['foot'][1] * k)


def fallback_person(agent_id):
    m = json.loads(MANIFEST.read_text(encoding='utf-8'))['people']
    colors = sorted(m['sit_a'])
    c = colors[int(hashlib.sha1(agent_id.encode()).hexdigest(), 16) % len(colors)]
    pick = {'sit': 'sit_a', 'stand': 'stand', 'walk': 'walk_1', 'hold': 'hold', 'doze': 'doze'}
    return {pose: (m[src].get(c) or m['sit_a'][c])['file'] for pose, src in pick.items() if src in m or pose == 'sit'}


T_START = time.time()
TIME_BUDGET = 1e9 if os.environ.get('HERDR_OFFICE_WARM') else float(os.environ.get('HERDR_OFFICE_BUDGET') or 6)      # seconds spent on making new people per run (the App stops a run after 30 s)
_MADE = []
LEADERS = set()                                          # ★92 ids of the agents who have workers in this run (they wear the black jacket; set by build())
_SPENT = [0.0]


def own_cached(agent_id):
    """The person's OWN pictures from an earlier run (any pack version: the look is fixed by the id), or None. Never another person's."""
    try:
        cache = json.loads((APP_HOME / 'hakoniwa-office' / 'sheet' / 'people-cache.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    for k_ in ((str(agent_id) + '#L',) if str(agent_id) in LEADERS else ()) + (str(agent_id),):   # ★92 a leader's own black-jacket pictures first
        e = cache.get(k_)
        if isinstance(e, dict) and e.get('poses') and all((APP_HOME / f_).is_file() for f_ in e.get('files', [])):
            return e['poses']
    return None


def standin_person(agent_id):
    """A stand-in for a person whose own pictures are not made yet: the pictures of ANOTHER person that are already written (chosen by the id, so the same
    one every time). The person's own pictures replace it (new file names) once the apart run has made them. None when nobody has pictures yet."""
    try:
        cache = json.loads((APP_HOME / 'hakoniwa-office' / 'sheet' / 'people-cache.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    ok = [k for k in sorted(cache) if isinstance(cache[k], dict) and cache[k].get('poses') and all((APP_HOME / f_).is_file() for f_ in cache[k].get('files', []))]
    if not ok:
        return None
    return cache[ok[int(hashlib.sha1(str(agent_id).encode('utf-8')).hexdigest(), 16) % len(ok)]]['poses']


def person_files(sp, agent_id):
    """A person's pictures. Making a new person takes about a second: once TIME_BUDGET seconds went into it in this run, the rest get their OWN earlier pictures
    when there are any, else None (the plan leaves them out and the mod does not draw them until the apart run has made them). A person never takes
    another person's look: that is what made clothes and hair change on screen once the right pictures arrived."""
    if STALE[0]:                                              # the pack is old: the person's own earlier pictures; no new person is made here
        mine = own_cached(agent_id)
        if mine:
            return mine
        return standin_person(agent_id) or (fallback_person(agent_id) if not (APP_HOME / 'hakoniwa-office' / 'sheet' / 'people-cache.json').is_file() else None)       # ★A8 (★37-3): a stand-in, not nobody
    if _MADE and (_SPENT[0] > TIME_BUDGET or time.time() - T_START > 1.5 * TIME_BUDGET):
        COLD[0] = True                                         # the rest are made in the apart run (spawn_warm)
        early_warm(OUT_DIR)
        mine = own_cached(agent_id)
        if mine:
            return mine
        return standin_person(agent_id)                        # ★A8 (★37-3): never nobody (a shadow with an open PC)
    t0 = time.time()
    res = person_files_(sp, agent_id)
    _SPENT[0] += time.time() - t0 if time.time() - t0 > .15 else 0       # a person that was already there costs nothing
    _MADE.append(res)
    return res


def person_files_(sp, agent_id):
    pool = int(os.environ.get('HERDR_PERSON_POOL') or 0)        # tests: many agents share a few looks (the pictures are made once)
    leader = str(agent_id) in LEADERS                          # ★92 a leader (an agent with workers) wears the black jacket
    if pool:
        agent_id = f'pool:{int(hashlib.sha1(str(agent_id).encode("utf-8")).hexdigest(), 16) % pool}'
    if sp is not None and hasattr(sp, 'person'):
        return sp.person(agent_id, leader=True) if leader else sp.person(agent_id)
    return fallback_person(agent_id)


# ---------------------------------------------------------------- desk memory
DEFAULT_ROOMS = [{'key': k, 'title': t, 'sources': [k]} for k, t in ZONES]


def room_of(a, rooms):
    for r in rooms:
        m = r.get('match')
        if m and all(a.get(k) == v for k, v in m.items()):
            return r['key']
        if not m and a.get('source') in r.get('sources', [r['key']]):
            return r['key']
    return rooms[-1]['key']


def group_by_rooms(agents, rooms):
    groups = {r['key']: [] for r in rooms}
    for a in sorted(agents, key=lambda a: a['id']):
        groups[room_of(a, rooms)].append(a)
    return groups


def group_agents(agents):
    groups = {k: sorted([a for a in agents if a.get('source') == k], key=lambda a: a['id']) for k, _ in ZONES}
    known = {a['id'] for g in groups.values() for a in g}
    groups['tui'] += sorted([a for a in agents if a['id'] not in known], key=lambda a: a['id'])
    return groups


def group_keys(agents):
    """id -> the "team" an agent belongs to (None: none). App: a parent and its children; TUI: the name before the first "-"."""
    parents = {a.get('parent_id') for a in agents if a.get('parent_id')}
    keys = {}
    for a in agents:
        if a.get('source') == 'tui':
            name = str(a.get('name') or '')
            keys[a['id']] = 'tui:' + name.split('-')[0] if '-' in name else None
        else:
            keys[a['id']] = a.get('parent_id') or (a['id'] if a['id'] in parents else None)
    return keys


def team_roots(agents, rooms, group_fn=None):
    """id -> id of the head of its team, for teams of two or more in one room. App: parent_id (grandchildren
    follow their parent); herdr TUI: "<head>-<job>" belongs to the agent named "<head>"."""
    byid = {a['id']: a for a in agents}
    room = {a['id']: (group_fn(a) if group_fn else room_of(a, rooms)) for a in agents}
    parent = {}
    for a in agents:
        p = a.get('parent_id')
        if p in byid and p != a['id'] and room[p] == room[a['id']]:
            parent[a['id']] = p
    # herdr TUI: "<head>-<job>" is in the team "<head>" (the agent named "<head>", if there is one, leads it)
    heads = {}
    for a in agents:
        name = str(a.get('name') or '')
        if a.get('source') == 'tui' and '-' not in name:
            heads.setdefault(name, a['id'])
    for a in agents:
        name = str(a.get('name') or '')
        if a['id'] in parent or a.get('source') != 'tui' or '-' not in name:
            continue
        pre = name.split('-')[0]
        parent[a['id']] = heads.get(pre, 'tui:' + pre)     # without a head agent the team has the prefix as its key

    def root(i):
        seen = set()
        while i in parent and i not in seen:
            seen.add(i)
            i = parent[i]
        return i
    roots = {a['id']: root(a['id']) for a in agents}
    size = {}
    for r in roots.values():
        size[r] = size.get(r, 0) + 1
    return {i: r for i, r in roots.items() if size[r] >= 2}


def assign(zs, members, now, step, spare=1, keys=None):
    """Stable slots: an id keeps its slot; a departed id's slot is held DESK_HOLD seconds; the room only grows,
    in `step` desks, always with a free desk (at least 2)."""
    slots = zs.setdefault('slots', {})
    present = {a['id'] for a in members}
    for aid in [k for k, v in slots.items() if k not in present and now - v[1] > DESK_HOLD]:
        del slots[aid]
    for a in members:
        if a['id'] in slots:
            slots[a['id']][1] = now
            continue
        taken = {v[0] for v in slots.values()}
        free = [n for n in range(len(taken) + len(members) + 2) if n not in taken]
        mates = [slots[b['id']][0] for b in members if b['id'] in slots and keys and keys.get(a['id']) and keys.get(b['id']) == keys.get(a['id'])]
        # a new seat goes next to its team's seats; people already seated keep theirs
        n = min(free, key=lambda f: min(abs(f - m) for m in mates)) if mates else free[0]
        slots[a['id']] = [n, now]
    need = max([v[0] + 1 for v in slots.values()] + [0]) + spare
    zs['cap'] = max(1, need)               # free desks = spare + reserved ones; no ratchet
    return {slots[a['id']][0]: a for a in members}


# ---------------------------------------------------------------- floor assembly
class Iso:
    """Floor tile coordinates -> pixels. Everything is laid out in base pixels and scaled by K here."""
    def __init__(self, ox, oy):
        self.ox, self.oy = ox, oy

    def __call__(self, x, y, z=0):
        return round((self.ox + (x - y) * TW / 2) * K, 1), round((self.oy + (x + y) * TH / 2 - z) * K, 1)

    def inv(self, px, py):
        """Floor pixels -> tile coordinates (x, y) at height 0."""
        u, v = px / K - self.ox, py / K - self.oy
        return (u * 2 / TW + v * 2 / TH) / 2, (v * 2 / TH - u * 2 / TW) / 2


def runs_down_right(part):
    """True if the piece runs from upper-left to lower-right (a wall along x); False if down-left (along y)."""
    im = open_png(part['file'])
    a = im.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    w, h = a.size
    top = a.getbbox()[1]
    strip = a.crop((0, top, w, min(h, top + max(3, h // 12))))
    bb = strip.getbbox()
    return (bb[0] + bb[2]) / 2 < w / 2


_GAPS = {}


def bottom_gap(part):
    """Pixels (unscaled) between the foot row of a wall part and the last opaque row of its middle column: the walls' sheared bottom edge lies
    higher than their lowest corner, so with the foot on the floor line a white band is left between wall and floor."""
    key = part['file']
    if key not in _GAPS:
        a_ = np.asarray(open_png(key).getchannel('A')) > 128
        fx_ = min(max(int(round(part['foot'][0])), 0), a_.shape[1] - 1)
        rows_ = np.nonzero(a_[:, fx_])[0]
        _GAPS[key] = max(0, int(part['foot'][1]) - int(rows_.max())) if len(rows_) else 0
    return _GAPS[key]


def paste_part(img, part_im, foot, at):
    img.alpha_composite(part_im, (round(at[0] - foot[0]), round(at[1] - foot[1])))


TAIL_MAX = 60                                                   # the approval card's tail (card bottom to the desk's top) is never longer than this
QCLEAR = 4                                                      # the first places of each queue (the ones people stand in) the card keeps clear of
CARD_SMALL = (96, 32)                                          # the small card (no room for the full one): C draws a one-line card of about this size
CARD_W2 = 108                                                   # the big card's narrower width (the request's line is cut shorter)
CARD_W, CARD_H = 120, 56                                       # the approval card's size (C's mod), for placing the plates clear of it
PLATE_W_S = 120
PLATE_W, PLATE_H = 190, 28                                     # an island plate's size (70 % of the first one, text 11 px), for placing them clear of each other
MOON_SYNODIC = 29.530589
MOON_EPOCH = 947182440.0                                      # 2000-01-06 18:14 UTC (a new moon), in unix seconds


def moon_age(now=None):
    """Days since the last new moon (0..29.53) at unix time `now` (default: the present)."""
    t = now if now else time.time()
    t = t / 1000 if t > 1e11 else t
    return ((t - MOON_EPOCH) / 86400) % MOON_SYNODIC


def moon_phase(age):
    """0..7 from the new moon: new, waxing crescent, first quarter, waxing gibbous, full, waning gibbous, last quarter, old crescent."""
    return int(age / MOON_SYNODIC * 8 + .5) % 8


def night_sky_for(glass_geo, bird_paths, scale, now=None):
    """★15: where the moon may move and where stars may twinkle: the upper part of the window glass storey, inside the glass only.
    moon_path: per wall a line (from -> to, scene pixels) with the clip box it stays in; star_rects: per window pane a rectangle
    in the upper 40 % of its glass, inside the pane's slanted corners. All scene pixels."""
    age = moon_age(now)
    rects, paths = [], []
    for key_ in ('x', 'y'):
        side_rects = []
        for ox_, oy_, q_, sn_ in sorted(glass_geo.get(key_, []), key=lambda g_: g_[0] + g_[2][0][0]):
            (tlx, tly), (trx, try_), (brx, bry), (blx, bly) = q_
            x0, x1 = max(tlx, blx) + ox_, min(trx, brx) + ox_
            y0 = max(tly, try_) + oy_
            y1 = min(bly, bry) + oy_
            hh = y1 - y0
            if x1 - x0 < 5 or hh < 6:                          # (★A4: the 2-cell windows are narrow when the floor is shown small: smaller margins, not dropped)
                continue
            mg_ = min(4.0, (x1 - x0) / 4)
            side_rects.append([round(x0 + mg_, 1), round(y0 + 4, 1), round(x1 - x0 - 2 * mg_, 1), round(max(2.0, .4 * hh - 4), 1)])
        rects += side_rects
        if side_rects:                                             # the moon's line: from the middle of the first pane's star rectangle to the last one's
            a_, b_ = side_rects[0], side_rects[-1]
            clip = [min(r_[0] for r_ in side_rects), min(r_[1] for r_ in side_rects), max(r_[0] + r_[2] for r_ in side_rects) - min(r_[0] for r_ in side_rects),
                    max(r_[1] + r_[3] for r_ in side_rects) - min(r_[1] for r_ in side_rects)]
            paths.append({'side': sn_, 'from': [round(a_[0] + a_[2] / 2, 1), round(a_[1] + a_[3] / 2, 1)], 'to': [round(b_[0] + b_[2] / 2, 1), round(b_[1] + b_[3] / 2, 1)],
                          'clip': [round(v_, 1) for v_ in clip]})
    return {'moon_age': round(age, 1), 'moon_phase': moon_phase(age), 'moon_path': paths, 'star_rects': rects}



def room_dims(cap):
    """cols, rows, width, depth in cells. Width is a multiple of 3 (the glass pieces are 3 cells); one row of cells
    along the back wall, then per desk row: 2 cells of desk, the chair cell, an aisle."""
    cols = 2 if cap <= 4 else 3 if cap <= 9 else 4
    rows = math.ceil(cap / cols)
    return cols, rows, 3 * math.ceil((cols * PX_ + 1) / 3), rows * PY_ + 1


def chair_mark(im, top_frac=0.0):
    """Centre of the blue chair seat of a picture (desk or typing person), in pixels."""
    a = np.array(im.convert('RGBA')).astype(int)
    m = (a[..., 2] > 110) & (a[..., 2] - a[..., 0] > 60) & (a[..., 3] > 40)
    m[:int(im.height * top_frac)] = False
    ys, xs = np.nonzero(m)
    return (xs.mean(), ys.mean()) if len(xs) else (im.width / 2, im.height * .65)



def screen_frames(parts):
    """The lit screens: diff of desk_on and desk_off gives the screen pixels; frame B scrolls them down 2 px."""
    on, off = open_png(parts['desk_on']['file']), open_png(parts['desk_off']['file'])
    w, h = min(on.width, off.width), min(on.height, off.height)
    on, off = on.crop((0, 0, w, h)), off.crop((0, 0, w, h))
    diff = ImageChops.difference(on.convert('RGB'), off.convert('RGB')).convert('L').point(lambda v: 255 if v > 48 else 0)
    box = diff.getbbox()
    if not box:
        return None
    mask = diff.crop(box)
    a = on.crop(box)
    a.putalpha(mask)
    shifted = Image.new('RGBA', a.size, (0, 0, 0, 0))
    shifted.paste(a.crop((0, 0, a.width, a.height - 6)), (0, 6))
    shifted.paste(a.crop((0, a.height - 6, a.width, a.height)), (0, 0))
    b = Image.new('RGBA', a.size, (0, 0, 0, 0))
    b.paste(shifted, (0, 0), mask)
    return (a, b, box, on.size)


def save_atomic(im, path, fmt='PNG'):
    """Write to a temporary name and rename, so a reader never sees half a picture (several runs share the folder)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.stem}.{os.getpid()}.tmp')
    im.save(tmp, fmt)
    try:
        os.replace(tmp, path)
    except PermissionError:          # the App has this picture open (Windows): the same name holds the same picture, keep it
        try:
            os.unlink(tmp)
        except OSError:
            pass
        if not path.exists():
            raise


def part_file(out_dir, parts, name, w, h):
    """A part resized to w x h and written once under <out>/scaled (named by size); path relative to the app."""
    path = out_dir / 'scaled' / f'{name}-v6-{w}x{h}.png'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        save_atomic(open_png(parts[name]['file']).resize((w, h), Image.LANCZOS), path)
    return rel(path)


PERSON_STEPS = (1.5, 2.0)          # ★90 (C) App memory: two steps only. The floor's K stops at 2.0, so 2.0 is the largest ever needed; a small
                                   # window shrinks the 1.5 set a little (no set is blown up). Was six steps: one set per step, 22-106 MB each.


def person_k(k_):
    """The step the people's pictures are made at for the floor scale k_: the smallest step not below it (the App only shrinks them a little, never
    blows them up). Every new k made a whole set (650-1600 pictures) and the App keeps every picture it has read: 288 -> 530 MB in 10 minutes.
    ★90 (C): with two steps and the floor's K on quarter steps, only these two sets can ever be made."""
    return next((s_ for s_ in PERSON_STEPS if s_ >= k_ - 1e-9), PERSON_STEPS[-1])


def person_file(out_dir, rel_png, factor):
    """A person's picture at this scale (the name carries the content hash and the scale), written once."""
    path = out_dir / 'scaled' / f'{Path(rel_png).stem}-v6-k{round(factor * 1000)}.png'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        im = open_png(rel_png)
        save_atomic(im.resize((max(1, round(im.width * factor)), max(1, round(im.height * factor))), Image.LANCZOS), path)
    return rel(path)


def cells_rect(x, y, w, h):
    return [(gx, gy) for gx in range(x, x + w) for gy in range(y, y + h)]


def dfs_order(members):
    """Depth first: a parent, then its first child and that child's children, then the next child (ids break ties)."""
    ids = {a['id'] for a in members}
    kids = {}
    for a in members:
        p = a.get('parent_id')
        kids.setdefault(p if p in ids and p != a['id'] else None, []).append(a['id'])
    order, seen = [], set()

    def walk(i):
        if i in seen:
            return
        seen.add(i)
        order.append(i)
        for c in sorted(kids.get(i, [])):
            walk(c)
    for r in sorted(kids.get(None, [])):
        walk(r)
    for a in sorted(ids):                                   # a parent cycle: whatever is left
        walk(a)
    return order


FREE_PREFIX = 'free:'                                       # ★68-2: the island of the people in no space (the collector's island 'free:フリーデスク')
FREE_KEY = FREE_PREFIX + 'フリーデスク'                       # ★72-1: the collector's FREE_ISLAND (its place is kept while nobody is in it)


def is_free(key):                                          # ★68-2: OFF until the free desk stops moving rooms (1 room / 4 rooms: rooms moved). Then: str(key).startswith(FREE_PREFIX)
    return False


PLANT_KINDS = ('plant', 'plant_boxwood', 'plant_snake', 'plant_fig', 'plant_monstera', 'plant_palm')   # ★75-3: the old potted plant + T3's five
PLANT_SMALL = ('plant', 'plant_boxwood', 'plant_snake')                  # (inside a room's corner: narrow ones, they stand beside the desks)
PLANT_PER_ROOM = {'corner': 2, 'front': 2, 'side': 0}                    # ★75-4: how many of each sort of place a room gets (fixed mode); side 0: the middle aisle is 3 cells, a plant there narrows the way (island_aisle_ok / passage_clear)


def plant_spots(I_):
    """★75-4: every place round a room where a plant may stand: {cell, where (corner / front / side), back (the cells' side it leans on), kinds}.
    front = the row in front of the front partition (outside, the lobby / aisle side), side = the cells beside the side partition on the aisle,
    corner = the room's inner corners at its right end (x + w - 2: the desks start at x + 1, so that column is free): the back one (y + 1, the
    room's top-right on screen) and the front one (y + h - 2, its bottom-right), then the left end's front (x + 1, y + h - 2). In order of preference."""
    x0_, y0_, w_, h_ = I_['x'], I_['y'], I_['w'], I_['h']
    if L86:                                                                # ★91: one plant at the room's top (back) vertex: the cell beside the desks' row at the left end (min x, min y + 1), leaning on the left partition
        return [{'cell': (x0_ + 1, y0_ + 2), 'where': 'corner', 'back': (-1, 0), 'kinds': PLANT_SMALL}]
    out_ = [{'cell': (x0_ + w_ - 2, y0_ + 1), 'where': 'corner', 'back': (1, 0), 'kinds': PLANT_SMALL},
            {'cell': (x0_ + w_ - 2, y0_ + h_ - 2), 'where': 'corner', 'back': (1, 0), 'kinds': PLANT_SMALL},
            {'cell': (x0_ + 1, y0_ + h_ - 2), 'where': 'corner', 'back': (-1, 0), 'kinds': PLANT_SMALL}]
    xs_ = list(range(x0_ + 1, x0_ + w_ - 1))
    xs_ = xs_ if I_.get('col', 0) == 0 else xs_[::-1]                    # from the outer wall's side inwards
    out_ += [{'cell': (x_, y0_ + h_), 'where': 'front', 'back': (0, -1), 'kinds': PLANT_KINDS} for x_ in xs_[::3]]
    xa_ = x0_ + w_ if I_.get('col', 0) == 0 else x0_ - 1                  # the aisle side
    out_ += [{'cell': (xa_, y_), 'where': 'side', 'back': (-1 if I_.get('col', 0) == 0 else 1, 0), 'kinds': PLANT_KINDS} for y_ in range(y0_ + h_ - 2, y0_, -2)]
    return out_


def choose_plant_spots(spots, key, seed=None):
    """★75-4: the spots a room gets and the kind on each. seed None: fixed (the first PLANT_PER_ROOM of each sort in order; the kind from the room's
    key and the spot's number). A seed: the spots of each sort shuffled and the kinds drawn by random.Random(f"{seed}:{key}") (the same every time
    for that room and seed). The caller skips a spot that is taken and goes on with the next ones."""
    import random
    rng_ = random.Random(f'{seed}:{key}') if seed is not None else None
    base_ = sum(ord(ch_) for ch_ in str(key))
    out_ = []
    for where_, n_ in PLANT_PER_ROOM.items():
        cands_ = [dict(sp_) for sp_ in spots if sp_['where'] == where_]
        if rng_:
            rng_.shuffle(cands_)
        for i_, sp_ in enumerate(cands_):
            sp_['kind'] = rng_.choice(sp_['kinds']) if rng_ else sp_['kinds'][(base_ + 2 * i_ + len(out_)) % len(sp_['kinds'])]
            sp_['quota'] = n_
            out_.append(sp_)
    return out_


def plan_islands(agents, cfg, state, room_cfg, per_row, width_min=36, hold_ids=None):
    """Group the agents (an island per space; per box with group_by "source"), seat them, size and place the islands.
    Seats: an island keeps `owners` (seat index -> agent id, in desks.json); a person who has gone frees the seat, a new one
    takes the first free seat (else the next one), always with a free seat left over. An island keeps its place; one that
    grows is moved only if it no longer fits; when an island has vanished, the rest is packed again."""
    group_by = cfg.get('group_by', 'space')
    members = {}
    byid_ = {a['id']: a for a in agents}

    def top_(a):                                                  # ★17-7: a child sits in its parent's island (grandchildren follow): the head of its chain
        seen_ = {a['id']}
        while a.get('parent_id') in byid_ and a['parent_id'] not in seen_:
            seen_.add(a['parent_id'])
            a = byid_[a['parent_id']]
        return a
    for a in agents:
        if group_by != 'source' and top_(a) is not a:
            h_ = top_(a)
            if str(h_.get('island') or '').startswith(FREE_PREFIX) and a.get('island') and not str(a['island']).startswith(FREE_PREFIX):
                continue                                          # ★88-6: a worker in a real space whose leader is in no space (the free desk) stays in its own space's room
            a['island'], a['island_title'] = h_.get('island'), h_.get('island_title')
    for a in agents:
        if group_by == 'source':
            k = room_of(a, room_cfg)
            t = next((r.get('title', r['key']) for r in room_cfg if r['key'] == k), k)
        else:
            k = a.get('island') or f"{a.get('source') or 'app'}:{a.get('source') or 'app'}"
            t = a.get('island_title') or k.split(':', 1)[-1]
        a['_island'], a['_title'] = k, t
        members.setdefault(k, []).append(a)
    empty_title, empty_source = {}, {}
    if group_by != 'source':                                      # ★61-1: a space with nobody in it (a shell only, or just made with ＋部屋) is still a room: an empty island
        for r_ in cfg.get('empty_rooms') or []:
            k_ = str((r_ or {}).get('key') or '')
            if k_ and k_ not in members:
                members[k_] = []
                empty_title[k_] = str(r_.get('title') or k_.split(':', 1)[-1])
                empty_source[k_] = str(r_.get('source') or k_.split(':', 1)[0] or 'app')
    # ★72-1 / ★68-2: the free desk's place is always kept (a 5-seat room in its own slot), drawn only when somebody is in it: a person in no space
    # coming or going changes neither the floor's size nor any room's place (the hole it left let the rooms behind it move up, and back).
    phantom_free = (not L86) and group_by != 'source' and not any(str(k_).startswith(FREE_PREFIX) for k_ in members)
    if phantom_free:
        members[FREE_KEY] = []
        empty_title[FREE_KEY], empty_source[FREE_KEY] = FREE_KEY.split(':', 1)[-1], 'app'
    mem = state.setdefault('islands', {})
    # ★30-2: every island has the same size (ONE row of ISLAND_SEATS seats). A space gets ceil((people + 1) / seats) islands of that size: the extra
    # ones are keyed "<key>~2", "<key>~3"... Only the people who hold a seat (hold_ids; None = everybody) sit; the rest of the space has no seat.
    N_ = max(2, int(cfg.get('island_seats', ISLAND_SEATS)))
    hold_set = {a['id'] for a in agents} if hold_ids is None else set(hold_ids)
    # ★40: ONE island (room) per space; its width is fixed and it grows in depth: R rows of N_ seats. ★74-5: R = ceil(people / N_) (at least 1): the 6th
    # person opens the second row (was ceil((people + 1) / N_), which kept a whole row of empty desks at 5, 10...)
    rows_of = {k: max(1, math.ceil(len(members[k]) / N_)) for k in members}
    # ★65 1-2: a room with nobody in it (a shell only, or just made with ＋部屋) is a small corner: its plate, its "＋" and one desk.
    # ★72-1: a room with anybody in it, working or waiting, is N_ seats wide from its first person on (the width never follows the people's
    # statuses: a waiting person's room was a corner and widened when the work began); the free desk is never a corner.
    cols_of = {k: (N_ if members[k] or str(k).startswith(FREE_PREFIX) else 1) for k in members}
    for k in members:
        if cols_of[k] == 1:
            rows_of[k] = 1
    sub_keys = {k: [k] for k in members}
    valid_keys = set(members)
    repack = False
    for k in [k for k in mem if k not in valid_keys]:
        del mem[k]
        repack = repack or not str(k).startswith(FREE_PREFIX)   # ★68-2: the free desk coming and going moves no room (even while is_free is off: its slot is left as a hole, the next free desk takes it again)
    if repack:
        for st in mem.values():
            for key in ('x', 'y'):
                st.pop(key, None)
        state['band_w'] = 0
    islands = {}
    for k in sorted(members):
        order_all = dfs_order(members[k])
        horder = [i_ for i_ in order_all if i_ in hold_set]
        hset = set(horder)
        keys_ = sub_keys[k]
        owners_by, taken_ = {}, set()
        for q_ in keys_:                                     # who keeps which seat (a person who left or stopped holding frees it)
            st = mem.setdefault(q_, {})
            cap_ = cols_of[k] * rows_of[k]
            ow_ = [o if (o in hset and o not in taken_) else None for o in st.get('owners', [])][:cap_]
            ow_ += [None] * (cap_ - len(ow_))
            taken_.update(o for o in ow_ if o)
            owners_by[q_] = ow_
        for i_ in horder:                                    # a new holder takes the first free seat (there is one: seats >= people, ★74-5)
            if i_ in taken_:
                continue
            for q_ in keys_:
                if None in owners_by[q_]:
                    owners_by[q_][owners_by[q_].index(None)] = i_
                    taken_.add(i_)
                    break
        by_id_ = {a['id']: a for a in members[k]}
        for q_ in keys_:
            ow_ = owners_by[q_]
            mem[q_]['owners'] = ow_
            sit_ = [by_id_[o] for o in ow_ if o]
            mem_list = list(sit_)
            if q_ == k:                                      # the people without a seat stay with the space's first island (its plate / chip)
                mem_list += [a for a in members[k] if a['id'] not in taken_]
            for a in sit_:
                a['_island'] = q_
            islands[q_] = {'key': q_, 'title': members[k][0]['_title'] if members[k] else empty_title.get(k, k), 'members': mem_list, 'order': [o for o in order_all if o in {a['id'] for a in sit_}],
                           'owners': ow_, 'cols': cols_of[k], 'rows': rows_of[k], 'row_sizes': [cols_of[k]] * rows_of[k], 'w': 3 * math.ceil((3 * max(cols_of[k], 2) + ISLAND_PAD) / 3), 'h': 2 + ROW_PITCH * rows_of[k],
                           'source': max({a.get('source') for a in members[k]}, key=lambda s_: sum(1 for a in members[k] if a.get('source') == s_)) if members[k] else empty_source.get(k, 'app')}
    iw_ = 3 * math.ceil((3 * N_ + ISLAND_PAD) / 3)
    # slots: 0 = left column / row 0, 1 = right column / row 0, 2 = left / row 1, ... Rows go on towards the lobby. An island keeps its slot; a new one takes the
    # first free slot; when an island has vanished everybody is given a slot again (in key order), so there is no hole.
    if repack:
        for st in mem.values():
            st.pop('slot', None)
    rooms_ = {k_: I_ for k_, I_ in islands.items() if not is_free(k_)}     # ★68-2 (office-polish): the free desk has no slot: it is placed after the rooms
    taken_slots = {mem[k]['slot'] for k in rooms_ if 'slot' in mem[k]}
    for k in sorted(rooms_, key=lambda k_: ('slot' not in mem[k_], str(k_).startswith(FREE_PREFIX), mem[k_].get('slot', 0), k_)):   # ★72-1: the free desk after the rooms that come with it
        if str(k).startswith(FREE_PREFIX) and mem[k].get('slot', 1) % 2 == 0:     # ★74-7: the free desk in the right column (the left column's front room carries the copier)
            taken_slots.discard(mem[k].pop('slot'))
        if 'slot' not in mem[k]:
            mem[k]['slot'] = next(n_ for n_ in range(10 ** 4) if n_ not in taken_slots and (n_ % 2 == 1 or not str(k).startswith(FREE_PREFIX)))
            taken_slots.add(mem[k]['slot'])
    two_cols_ = False if L86 else any(mem[k]['slot'] % 2 == 1 for k in rooms_)
    # ★30-2 (16:12): the left column on the left wall, the right column on the right wall, one aisle (AISLE_W cells) between;
    # ★60-1 (A12): with the left column only (one room), the floor is one column wide (+ the aisle on the rooms' open side)
    # ★72-1: both columns keep a room's width whatever is in them, and the floor is always two columns wide (withdraws ★60-1's one-column floor and
    # ★65 1-2's narrow right column): one person coming or going (a new space, the free desk, a corner) never makes the office wider or narrower.
    w_col_ = [iw_, iw_]
    band_w = max(width_min, (iw_ + LSTRIP + 3) if L86 else (w_col_[0] + w_col_[1] + AISLE_W))   # ★86: the way along the rooms' open side is one column
    state['band_w'] = band_w
    ycol_ = {}
    for k in sorted(rooms_, key=lambda k_: mem[k_]['slot']):   # in slot order, so a column's earlier rooms are placed first
        I = islands[k]
        col_ = 0 if L86 else mem[k]['slot'] % 2
        I['x'] = LSTRIP if L86 else (0 if col_ == 0 else band_w - w_col_[1])           # ★65 1-2: the right column's rooms share its left edge (a corner that grows to a room moves nobody)
        I['y'] = ycol_.get(col_, 0)                            # ★31-3: rooms in a column share one wall (no 2-cell gap; never y = 1 or 2); ★40: the heights differ
        ycol_[col_] = I['y'] + I['h'] - 1
        I['col'] = col_
    for k in [k_ for k_ in islands if is_free(k_)]:          # ★68-2 (office-polish): the free desk (people in no space) right in front of the rooms, at the
        I = islands[k]                                       # top of the lobby, in the shorter column (the left one when the right is too narrow for it)
        cols_ok_ = [0] + ([1] if two_cols_ and w_col_[1] >= I['w'] else [])
        col_ = min(cols_ok_, key=lambda c_: (ycol_.get(c_, 0), c_))
        I['x'] = LSTRIP if L86 else (0 if col_ == 0 else band_w - w_col_[1])
        I['y'] = ycol_.get(col_, 0)                            # (★31-3: it shares the wall of the room behind it, like the rooms of a column)
        I['col'], I['free'] = col_, True
        ycol_[col_] = I['y'] + I['h'] - 1
    for k, I in islands.items():
        mem[k].update({'x': I['x'], 'y': I['y'], 'w': I['w'], 'h': I['h']})
    droom = max((i['y'] + i['h'] for i in islands.values()), default=5) + 1
    if phantom_free:                                          # ★72-1: kept (its slot, its rows in droom), not drawn
        islands.pop(FREE_KEY, None)
    return islands, band_w, droom


def build(agents, state, now, out_dir, cfg=None, view=None, debug=False):
    """Lay the office out on a grid of floor cells (1 cell = one tile = about one person or chair).
    Every fixed thing is an object with the cells it occupies; none may overlap. People, spots and the walkable
    map come from the free cells. Depth of an object = gx + gy of its front-most cell (long things are cut into
    strips, one per screen column, each with its own depth)."""
    global S, PK, K
    LEADERS.clear(); LEADERS.update(str(a['parent_id']) for a in agents if a.get('parent_id') and any(b.get('id') == a['parent_id'] for b in agents))   # ★92
    parts, sp, pack = load_parts()
    if 'desk_off' in parts:                                   # furniture scale: the desk art fills 3 x 1.5 tiles
        S = round((DESK_W + ART_D) * TW / 2 / (parts['desk_off']['w'] * .95), 3)
        PK = S                                                # people are drawn at the furniture scale
    cfg = cfg or {}
    wall_h = WALL_H                                           # as high as B's outer wall piece (the room above the floor grows with the wall)
    for wn_ in ('wall_tall_left', 'wall_tall_right', 'wall_window_left'):
        if wn_ in parts:
            wall_h = max(WALL_H, math.ceil(parts[wn_]['h'] * 0.30) + 6)
            break
    wall_h = max(wall_h, 157)                                 # ★19-1: never lower than the morning's walls (r14: 157 px), whichever wall pieces the pack has
    room_cfg = cfg.get('rooms') or DEFAULT_ROOMS
    per_row = int(cfg.get('seats_per_row', SEATS_PER_ROW))
    shared = state['shared'] = 4 * math.ceil(max(len(agents), 1) / 4)
    qcols = max(1, math.ceil(min(shared, QCAP) / QROWS))                 # queue columns behind each window
    place_w = max(5, 2 * qcols + 2)                         # ★17-3: small windows, close to the entrance
    has_status = any('status' in a_ for a_ in agents)
    need = (sum(1 for a_ in agents if a_.get('status') == 'idle') + 3) if has_status else len(agents)   # waiting now + a little spare (★A4: 3; everybody who waits sits)
    n_idle_ = min(shared, sum(1 for a_ in agents if a_.get('status') == 'idle')) if has_status else 0
    seat_est_ = min(shared, need) + (1 if min(shared, need) > 2 else 0)        # ★26-2: the lounge's size follows the number of sitting points (waiting people + a spare)
    lounge_cols_ = max(2, math.ceil(math.sqrt(max(seat_est_, 1))))
    lounge_rows_ = math.ceil(max(LOUNGE_CAND(seat_est_, n_idle_), 1) / lounge_cols_)
    lounge_w = max(LOUNGE_W, LSTEP_X * lounge_cols_ + 3)
    LD_ = 2                                                   # ★77-1: rows kept free between the rooms' front partition (the copier, the file cabinet) and the break room
    LX0_ = 8                                                  # ★77-1: the lounge starts right of the drinks strip (x 1-4) and its walkway (x 5): the break room
    lw_min_ = max(LOUNGE_W, lounge_w + 4) if shared > 24 else LOUNGE_W   # (a crowd needs a wider break room: it widens the rooms' band too, not only the floor)
    lobby_w = LX0_ + lw_min_ + 2 + 2 * (place_w + 2)         # ★77-1: the break room, one free column, then the two windows (further in, towards the rooms' side)
    hold_s = 0.0                                              # ★30-8: no seat is kept for a waiting person

    def holds(a_):                                            # ★30-8: working / away at a window: the seat is theirs; waiting (idle): no seat, they go to the lounge at once
        return L86 or a_.get('status') != 'idle'                # ★86: everybody keeps the own seat (waiting people sit at their desk)
    holders = [a_ for a_ in agents if holds(a_)]
    out_seatless = [a_['id'] for a_ in agents if a_ not in holders]
    islands, band_w, droom = plan_islands(agents, cfg, state, room_cfg, per_row, (0 if L86 else lobby_w), {a_['id'] for a_ in holders})   # ★30-2: fixed islands (one row of ISLAND_SEATS seats); the seats go to the holders only
    if L86:
        lobby_w = 0
    if lobby_w < band_w:                                      # a full rectangle: no L-shaped gap beside the lobby
        lobby_w = band_w
    floor_w = max(band_w, lobby_w)
    gk = team_roots(holders, room_cfg, lambda a_: a_.get('_island'))
    lobby_y = droom + 1                                       # the row `droom` is a free row between the islands and the lobby
    # ★50-4 (A9): the scale K still follows the lobby as it was (the lounge above the window columns), so K does not change; only the floor shrinks
    lobby_dk = max(11, 5 + min(shared, QLEN), LSTEP_Y * lounge_rows_ + 6 + min(shared, QLEN))
    # ★50-5 (A9): the lobby is cut like the rooms above it: the left column = the entrance and the two windows, the right column = the lounge, as wide as a
    # room and against the right outer wall (bottom right on screen, symmetric with the windows about the middle aisle). The depth is the larger of the two.
    iw_std_ = 3 * math.ceil((3 * max(2, int(cfg.get('island_seats', ISLAND_SEATS))) + ISLAND_PAD) / 3)       # (a room's width, also with no room at all)
    # ★77-1: the lounge moves beside the drinks (left wall, in front of the machines) as the break room; the approval desk and the submit counter go further
    # in (right of it). The extra width of the floor goes to the lounge (as before), never to a gap in front of the windows.
    lx0 = LX0_
    lounge_w = max(LOUNGE_W, floor_w - (lx0 + 2 + 2 * (place_w + 2)), lw_min_)
    lounge_w = max(lounge_w, LOUNGE_W)
    #      # (not from the number who wait: the floor's width must not change with it, ★72-1)
    places_x = lx0 + lounge_w + 2
    floor_w = floor_w if L86 else max(floor_w, places_x + 2 * (place_w + 2))
    wk_ = max(floor_w, 2 * iw_std_ + AISLE_W, lobby_w) + 1    # ★60-1 (A12): K as for the two columns' width (the floor is smaller, the things keep their size)
    lounge_w = max(LOUNGE_W, lounge_w)
    lounge_cols_ = max(1, (lounge_w - 2) // LSTEP_X)
    lounge_rows_ = math.ceil(max(LOUNGE_CAND(seat_est_, n_idle_), 1) / lounge_cols_)
    stand_rows_ = 2 * math.ceil(max(0, min(shared, 24) - seat_est_) / max(1, lounge_w // 2))     # the standing places in front of the sitting points (all who share the lounge)
    stand_old_ = 0 if (has_status and n_idle_ == 0) else stand_rows_      # (the depth as before A12: the retry below falls back to it)
    if has_status:                                            # ★57-3 (A11, A12): with statuses the sitting points cover everybody who waits (+ spares): no standing rows
        stand_rows_ = 0
    # ★57-3 (A12): the lounge needs its last sitting row + the rug's front row + the label row + 1 free row (was a whole LSTEP_Y + 2 more), the windows
    # their line (5 + QLEN); the old floor of 11 rows is gone (the door's wall below sets its own minimum)
    lobby_d = max(5 + min(shared, QLEN), 3 + LD_ + LSTEP_Y * (max(lounge_rows_, 3) - 1) + 3 + stand_rows_ + (4 if shared > 24 else 0))
    W = floor_w + 1                                           # one free cell beyond the rightmost thing
    D = lobby_y + lobby_d
    D_in = D - 1                                              # the last row is a free margin
    ENT = 'entrance' if 'entrance_closed' in parts else 'door'              # B's entrance section (3 cells: the opening is the first 2) or the old door
    DOOR_SEG = max(2, len((parts.get(ENT + '_closed') or {}).get('footprint') or [0, 0]))
    DOOR_N = 1 if L86 else (2 if ENT == 'entrance' else 1)                    # ★27-3 (A10): the entrance is two sections side by side (twice as wide), one picture
    DOOR_W = DOOR_SEG * DOOR_N
    # ★57-1 (A10): the left wall of the lobby holds the drinks row (4 rows, ★55) behind the entrance: 4 + 1 free + the door + 1 free + the margin row.
    # With the double door (6) and 2 free rows on each side, a 12-row lobby (the real data) had 2 rows left and the row fell back to the right corner.
    # ★57-3 (A12): the left wall's run starts at the first row free of the left rooms (their box margin), often above lobby_y; and when the back wall has
    # a run of 4 free cells outside the board (the right column's top is empty: the drinks go there, ★59), the left wall holds only the door
    left0_ = 1 if L86 else max((I_['y'] + I_['h'] for I_ in islands.values() if I_.get('col', 0) == 0), default=lobby_y - 1) + 1   # ★86: the left wall beside the rooms is free (the strip)
    bcfg0_ = cfg.get('board') if isinstance(cfg.get('board'), dict) else {}
    bc0_ = 2 * math.ceil(max(2, int(bcfg0_.get('cells', max(14, min(21, int(max(W, lobby_y + max(lobby_d, DOOR_W + 6)) * .4) + 4))))) / 2)
    if L86:
        bc0_ = min(bc0_, 2 * ((W - 8) // 2))                  # ★86: the board fills the narrow back wall (one column of rooms), big as ★78-1; ★91: the last 4 cells (the aisle) are left for the vending machine on the back wall
    ua00_ = (2 if L86 else round(W * .5 - bc0_ / 2)) if ('wall_plain' in parts and W > bc0_ + (2 if L86 else 8)) else None
    ax0_ = max((I_['x'] + I_['w'] for I_ in islands.values() if I_.get('col', 0) == 0), default=None)
    ax1_ = min((I_['x'] for I_ in islands.values() if I_.get('col', 0) == 1), default=None)
    run_b0_ = [x_ for x_ in range(1, W - 1) if x_ != band_w - 1 and not (ua00_ is not None and ua00_ - 3 <= x_ <= ua00_ + bc0_ + 2)
               and not (ax0_ is not None and ax1_ is not None and ax0_ - 1 <= x_ <= ax1_)
               and not any(I_['x'] - 1 <= x_ <= I_['x'] + I_['w'] and I_['y'] - 1 <= 4 for I_ in islands.values())]
    back_room_ = any(all(x_ - i_ in run_b0_ for i_ in range(4)) for x_ in run_b0_)
    # ★63 (office-polish): the machines have ONE place in every scene: the left wall beside the entrance, from the door towards the rooms (the copier, the
    # file cabinet, the coffee machine, the water server, the vending machine 2 x 2 = 6 rows) after the door's free row. The lobby is deep enough for it
    # whatever the back wall has (back_room_ no longer moves them there).
    left_need_ = max(DOOR_W + 2, DOOR_W + 3 + EQUIP_ROW_N - (lobby_y - left0_))   # the margin row + the door + 1 free + the machines' rows, above the rooms' corner
    lobby_d = max(lobby_d, left_need_)                        # ★57-3 (A11): the door's free row on its far side is the margin row (was +7: one empty row more at the front)
    lobby_old_ = max(11, 5 + min(shared, QLEN), 3 + LD_ + LSTEP_Y * lounge_rows_ + 2 + stand_old_ + (4 if shared > 24 else 0), DOOR_W + 6)
    lobby_d = min(max(lobby_d, lobby_old_), lobby_d + LOBBY_EXTRA)        # ★57-3 (A12): main() builds again 1 row deeper (then as before) when the big approval card found no room
    # ★83-1: the break room is the band between the drinks (left wall) and the left rooms' front partition (the copier, the file cabinet, the plants):
    # x from LB_X0 (the drinks' two standing columns stay free) to 2 cells short of the middle aisle, y from LD_ rows below the partition's outer row
    # to 2 rows above the entrance. The way from the door to the rooms (the rows of the door, along x, then up the aisle) keeps nothing of it.
    # The lobby is made deep enough for its sitting points (the door moves to the front; the floor's width does not change, ★72-1).
    lb_x1_ = min((ax0_ if ax0_ is not None else iw_std_ + 1) - 3, W - 3)
    lb_cols_ = max(1, lb_x1_ - LB_X0 + 1)
    lb_need_ = max(math.ceil(LB_CELLS * LOUNGE_CAND(seat_est_, n_idle_) / lb_cols_), math.ceil(min(shared, 24) / lb_cols_) if not has_status else 0)
    # A crowd (more than LB_ROWS_MAX rows beside the drinks): the same band also in front of the right column's rooms (one free column beside the aisle,
    # to the right wall), so the floor does not grow so deep; the way (the door's rows, the aisle) stays free all the same.
    rb_x0_, rb_x1_ = ((ax1_ + 2), W - 3) if ax1_ is not None else (None, None)
    if lb_need_ > LB_ROWS_MAX and rb_x0_ is not None and rb_x1_ >= rb_x0_:
        lb_need_ = math.ceil(lb_need_ * lb_cols_ / (lb_cols_ + rb_x1_ - rb_x0_ + 1))
    else:
        rb_x0_ = rb_x1_ = None
    lb_rows_ = LB_ROWS_MIN + 3 * max(0, math.ceil((lb_need_ - LB_ROWS_MIN) / 3))     # (in steps of 3 rows: one more person does not deepen the floor)
    lobby_d = max(lobby_d, LD_ + 3 + lb_rows_ + DOOR_W)
    lobby_short_ = lobby_d < lobby_old_
    if L86:
        lobby_d = 3                                           # 93: the counter desks left the lobby: back to the small lobby; ★86: only the free front row(s): the door and the drinks stand in the strip beside the rooms
    D = lobby_y + lobby_d
    D_in = D - 1
    door_row0 = (lobby_y - DOOR_W - 1) if L86 else (D_in - DOOR_W)   # ★86: the door stands in the strip beside the last room (a shallow front band)
    door_row0 = max(door_row0, 3) if L86 else door_row0   # (the entrance:: DOOR_W rows of the left wall from here (1 free row in front of it)
    lb_y0_, lb_y1_ = lobby_y + 1 + LD_, door_row0 - 2           # ★83-1: the break room's rows (see lb_rows_)
    lb_spans_ = [(LB_X0, lb_x1_)] + ([(rb_x0_, rb_x1_)] if rb_x0_ is not None else [])   # its columns: beside the drinks (+ the crowd's band)

    def floor_ok(x_, y_):                                     # one rectangle: the diamond between the two outer walls
        return 0 <= x_ < W and 0 <= y_ < D

    def inner(x_, y_):                                        # not on the floor's edge: all 8 neighbours are floor too
        return all(floor_ok(x_ + dx_, y_ + dy_) for dx_ in (-1, 0, 1) for dy_ in (-1, 0, 1))
    ox = D * TW / 2 + MARGIN
    oy = wall_h + MARGIN
    width0 = (W + D) * TW / 2 + 2 * MARGIN
    height0 = (W + D) * TH / 2 + wall_h + 14 + 2 * MARGIN
    K = 1.0
    if view:                                                 # draw at the size it is shown at: no scaling blur in the mod
        Dk_ = max(D, lobby_y + lobby_dk)                      # ★50-4 (A9): K as for the old, deeper lobby (the floor is smaller, the things keep their size)
        Wk_ = max(W, wk_)
        if L86:
            Dk_, Wk_ = D, W                                   # ★86: K for the floor as it is (the old deep lobby no longer exists)
        width_k, height_k = (Wk_ + Dk_) * TW / 2 + 2 * MARGIN, (Wk_ + Dk_) * TH / 2 + wall_h + 14 + 2 * MARGIN
        K = max(.25, min(2.0 if L86 else 2.5, math.floor(min(view[0] / width_k, view[1] / height_k) / SCALE_STEP) * SCALE_STEP))  # ★90 (C): the largest quarter step that still fits the view
        # the scale is changed only when the floor no longer fits (then to the new fit), or when the fit is a whole step above
        # (then up to the fit): one person more or less rarely changes it, and the window's exact size does not matter
        kprev = state.get('k')
        if kprev and kprev <= K + 1e-9 and K - kprev < .15:
            K = kprev
        state['k'] = K
    width, height = round(width0 * K), round(height0 * K)
    iso = Iso(ox, oy)

    bg = Image.new('RGBA', (width, height), (0, 0, 0, 0))     # floor, back walls, rugs, floor marks: nothing that stands
    d = ImageDraw.Draw(bg, 'RGBA')

    def poly(pts, fill, outline=None):
        d.polygon(pts, fill=fill, outline=outline)

    kr = 0.30 if 'wall_plain' in parts or 'floor_tile' in parts else S
    # the floor: flat colours (one polygon for the aisles, one per island, the rug later), the thickness on the two front edges
    t_ = max(2, round(8 * K))
    for a_pt, b_pt in ((iso(0, D), iso(W, D)), (iso(W, 0), iso(W, D))):
        poly([a_pt, b_pt, (b_pt[0], b_pt[1] + t_), (a_pt[0], a_pt[1] + t_)], FLOOR_EDGE + (255,))
    tuck_ = 7                                                 # the floor reaches a few pixels up under the walls: no hairline between wall and floor
    p00_, pW0_ = iso(0, 0), iso(W, 0)
    poly([(p00_[0], p00_[1] - tuck_), (pW0_[0], pW0_[1] - tuck_), iso(W, D), iso(0, D)], FLOOR_AISLE + (255,))
    tint_mem = state.setdefault('islands', {})
    for k_ in sorted(islands, key=lambda q_: (tint_mem.get(q_, {}).get('tint', 99), q_)):
        mem_ = tint_mem.setdefault(k_, {})
        if 'tint' not in mem_:                                # the colour is remembered: the next free one in turn
            used_t = {m_.get('tint') for m_ in tint_mem.values() if m_.get('tint') is not None}
            mem_['tint'] = next(i_ for i_ in range(len(used_t) + 1) if i_ not in used_t)
        I_ = islands[k_]
        poly([iso(I_['x'], I_['y']), iso(I_['x'] + I_['w'], I_['y']), iso(I_['x'] + I_['w'], I_['y'] + I_['h']), iso(I_['x'], I_['y'] + I_['h'])],
             ISLAND_FLOORS[mem_['tint'] % len(ISLAND_FLOORS)] + (255,))
    outside_all = []

    def glass_quad(im_):
        """The window glass (the blue pane) of a wall piece as 4 corners (top-left, top-right, bottom-right, bottom-left) in the piece's pixels."""
        a_ = np.asarray(im_.convert('RGBA')).astype(int)
        m_ = (a_[..., 3] > 200) & (a_[..., 2] > a_[..., 0] + 25) & (a_[..., 2] > 120)
        ys_, xs_ = np.nonzero(m_)
        if len(xs_) < 50:
            return None
        x0_, x1_ = int(xs_.min()), int(xs_.max())
        lc, rc = ys_[xs_ <= x0_ + 2], ys_[xs_ >= x1_ - 2]
        return [[x0_, int(lc.min())], [x1_, int(rc.min())], [x1_, int(rc.max())], [x0_, int(lc.max())]]
    wall_pieces = []                                          # every piece of the outer walls (the mod draws their frames over the view)
    board_info = None
    board_span = None
    glass_geo = {'x': [], 'y': []}                            # per wall: (x, y of the piece, the glass's 4 corners in piece pixels, side name)
    tall = dict((pack.get('life') or {}).get('tall') or {})
    w2i = (pack.get('life') or {}).get('window2')
    use_w2 = bool(not os.environ.get('HERDR_OFFICE_NO_W2') and w2i and 'window2' in parts and 'wall_plain1' in parts and runs_down_right(parts['window2']))      # ★17-5: the 2-cell window (window2, wall_plain1, wall_post)

    def mask_quad(im_):
        """The glass shape of a mask picture (alpha) as 4 corners: top-left, top-right, bottom-right, bottom-left (the piece's pixels)."""
        a_ = np.asarray(im_.convert('RGBA'))[..., 3] > 128
        ys_, xs_ = np.nonzero(a_)
        x0_, x1_ = int(xs_.min()), int(xs_.max())
        lc, rc = ys_[xs_ <= x0_ + 2], ys_[xs_ >= x1_ - 2]
        return [[x0_, int(lc.min())], [x1_, int(rc.min())], [x1_, int(rc.max())], [x0_, int(lc.max())]]

    def w2_fill(g0, g1):
        ln_ = g1 - g0
        if ln_ < .05:
            return []
        k_ = math.ceil(ln_ - .05)
        return [('plain1', g0 + (j_ + .5) * ln_ / k_) for j_ in range(k_)]

    def w2_zone(a, b):
        """Between a and b (cells along the wall): window (2 cells), wall (1 cell), window ... flush at both ends; a short stretch gets walls only."""
        ln_ = b - a
        n_ = max(1, int((ln_ + 1) / 3 + .5))
        while n_ > 1 and ln_ < 2 * n_:
            n_ -= 1
        if ln_ < 2 - .01:
            return w2_fill(a, b)
        if n_ == 1:
            c_ = a + ln_ / 2
            return w2_fill(a, c_ - 1) + w2_fill(c_ + 1, b) + [('window', c_)]
        g_ = (ln_ - 2 * n_) / (n_ - 1)
        res_ = []
        for i_ in range(n_):
            if i_:
                res_ += w2_fill(a + i_ * 2 + (i_ - 1) * g_ + 0, a + i_ * 2 + i_ * g_)
        return res_ + [('window', a + 1 + i_ * (2 + g_)) for i_ in range(n_)]
    wnames = ('wall_tall_left', 'wall_tall_right') if 'wall_tall_left' in parts and 'wall_tall_right' in parts else ('wall_window_left', 'wall_window_right')
    wall_masks = {}                                           # side name -> the glass mask picture (piece scale)
    if wnames[0] in parts and wnames[1] in parts:
        pieces = [parts[wnames[0]], parts[wnames[1]]]
        px_ = next((q for q in pieces if runs_down_right(q)), pieces[0])      # the wall along x (y = 0)
        py_ = next((q for q in pieces if q is not px_), pieces[1])            # the wall along y (x = 0)
        side_name = {True: 'left' if px_ is parts[wnames[0]] else 'right', False: 'left' if py_ is parts[wnames[0]] else 'right'}

        def plain_part(name, along_x):
            q = parts.get(name)
            if not q:
                return None
            if along_x or 'flip' not in q:
                return q
            return {'file': q['flip']['file'], 'foot': [q['w'] - q['foot'][0], q['foot'][1]], 'w': q['w'], 'h': q['h']}
        for part_, along_x in ((px_, True), (py_, False)):
            sn_ = side_name[along_x]
            if use_w2:
                part_ = plain_part('window2', along_x)
            wim, wfoot = scaled(part_, kr)
            pitch = 2.0 if use_w2 else wim.width * .92 / (TW / 2 * K)
            length = W if along_x else D
            tl_ = tall.get(sn_) if not use_w2 else None
            if use_w2:
                fim, ffoot = scaled({'file': w2i['frame'], 'foot': w2i['foot']}, kr)
                mim, _mfoot = scaled({'file': w2i['mask'], 'foot': w2i['foot']}, kr)
                mraw_ = open_png(w2i['mask'])
                if not along_x:
                    fim, mim, mraw_ = ImageOps.mirror(fim), ImageOps.mirror(mim), ImageOps.mirror(mraw_)
                ffile = rel(write_png(out_dir / 'scaled', f'frame2-{sn_}', fim))
                mfile = rel(write_png(out_dir / 'scaled', f'mask2-{sn_}', mim))
                wall_masks[sn_] = mim
                qp_ = mask_quad(mraw_)
                tall[sn_] = {'glass': {'x0': qp_[0][0], 'x1': qp_[1][0], 'top_y0': qp_[0][1], 'slope': (qp_[1][1] - qp_[0][1]) / max(1, qp_[1][0] - qp_[0][0]),
                                       'h': qp_[3][1] - qp_[0][1]}}
                quad_ = [[x_ * kr * K, y_ * kr * K] for x_, y_ in qp_]
            elif tl_:
                fim, ffoot = scaled({'file': tl_['frame'], 'foot': tl_['foot']}, kr)
                ffile = rel(write_png(out_dir / 'scaled', f'frame-{sn_}', fim))
                mim, _mfoot = scaled({'file': tl_['mask'], 'foot': tl_['foot']}, kr)
                wall_masks[sn_] = mim
                g_ = tl_['glass']
                quad_ = [[g_['x0'], g_['top_y0']], [g_['x1'], g_['top_y0'] + g_['slope'] * (g_['x1'] - g_['x0'])],
                         [g_['x1'], g_['top_y0'] + g_['slope'] * (g_['x1'] - g_['x0']) + g_['h']], [g_['x0'], g_['top_y0'] + g_['h']]]
                quad_ = [[x_ * kr * K, y_ * kr * K] for x_, y_ in quad_]
            else:
                quad_ = glass_quad(wim)
            bcfg_ = cfg.get('board') if isinstance(cfg.get('board'), dict) else {}
            bc_ = 2 * math.ceil(max(2, int(bcfg_.get('cells', max(14, min(21, int(max(W, D) * .4) + 4))))) / 2)              # the board wall: plain pieces (2 cells each) under the board
            if L86:
                bc_ = min(bc_, 2 * ((W - 8) // 2))
                bcfg_ = dict(bcfg_, cells=bc_)
            board_on_x = True                                                          # ★55 (A10, with office-equip3): always the back wall (above the rooms), as with W >= D; on the left wall (D > W) it took the whole lobby wall from the machines
            if along_x:
                hw_ = wim.width / (TW * K)                         # half a piece in cells: the end pieces stop at the floor's corners
                if board_on_x and 'wall_plain' in parts and length > bc_ + (2 if L86 else 8):
                    ua0_ = 2 if L86 else round(length * .5 - bc_ / 2)            # (★91: with L86 from the left, the aisle's end stays free) in the middle of the back wall (seen from the entrance, above the islands' glass)
                    board_span = (ua0_, ua0_ + bc_, max(2, int(bcfg_.get('cells', max(14, min(21, int(max(W, D) * .4) + 4))))), int(bcfg_.get('rows', 30)), 'x')
                    nl_, nr_ = math.ceil(ua0_ / pitch), math.ceil((length - ua0_ - bc_) / pitch)
                    plan = [('window', max((n_ + .5) * ua0_ / nl_, hw_)) for n_ in range(nl_)]
                    plan += [('plain', ua0_ + .75 + 1.5 * i_) for i_ in range(math.ceil(bc_ / 1.5))]
                    plan += [('window', min(ua0_ + bc_ + (n_ + .5) * (length - ua0_ - bc_) / nr_, length - hw_)) for n_ in range(nr_)]
                else:
                    n_x = math.ceil(length / pitch)
                    plan = [('window', min(max((n_ + .5) * length / n_x, hw_), length - hw_)) for n_ in range(n_x)]
            else:
                lo_, hi_ = door_row0 - 2, door_row0 + DOOR_W + 2                 # the entrance: a plain piece (2 cells) on each side of the door
                if not board_on_x and lo_ - bc_ >= 3 and 'wall_plain' in parts:
                    board_span = (lo_ - bc_, lo_, max(2, int(bcfg_.get('cells', max(14, min(21, int(max(W, D) * .4) + 4))))), int(bcfg_.get('rows', 30)), 'y')
                seg_end = board_span[0] if board_span and board_span[4] == 'y' else lo_
                n1 = math.ceil(max(seg_end, 0) / pitch)
                plan = [('window', max((n_ + .5) * seg_end / n1, wim.width / (TW * K))) for n_ in range(n1)] if seg_end > 0 else []
                if board_span and board_span[4] == 'y':
                    plan += [('plain', seg_end + .75 + 1.5 * i_) for i_ in range(math.ceil(bc_ / 1.5))]            # 1.5 cells apart: the pieces overlap, no gap
                plan += [('plain', door_row0 - 1.5), ('plain', door_row0 - .5), ('plain', min(door_row0 + DOOR_W + .5, length - hw_)), ('light' if plain_part('wall_light', False) else 'plain', min(door_row0 + DOOR_W + 1.5, length - hw_))]   # ★57-1: never past the floor's corner
                n2 = math.ceil((length - hi_) / pitch)
                plan += [('window', min(hi_ + (n_ + .5) * (length - hi_) / n2, length - wim.width / (TW * K))) for n_ in range(n2)]
            if use_w2:                                             # windows only outside the board's stretch and the entrance's walls
                if along_x:
                    zones_ = [(0, ua0_), (ua0_ + bc_, length)] if board_span and board_span[4] == 'x' else [(0, length)]
                else:
                    zones_ = ([(0, seg_end)] if seg_end > 0 else []) + [(hi_, length)]
                plan = [it_ for it_ in plan if it_[0] != 'window']
                for z0_, z1_ in zones_:
                    plan += w2_zone(z0_, z1_)
                plan.sort(key=lambda it_: it_[0] == 'window')      # the walls first, the windows over them
            wi_, nwin_, plan2_ = 0, sum(1 for k0_, _m0 in plan if k0_ == 'window'), []
            for k_, m_ in plan:                                    # ★17-5: window, window, wall, window, window, wall...  (until the 2-cell window piece comes: two of today's pieces = one window)
                if not use_w2 and k_ == 'window' and wi_ % 3 == 2 and wi_ < nwin_ - 1:       # (never the last window: the end piece must stop at the floor's corner)
                    n_p_ = max(1, math.ceil(pitch / 1.5))              # plain pieces 1.5 cells apart overlap: no gap in the wall
                    plan2_ += [('plain', m_ + (j_ - (n_p_ - 1) / 2) * 1.5) for j_ in range(n_p_)]
                else:
                    plan2_.append((k_, m_))
                wi_ += 1 if k_ == 'window' else 0
            plan = plan2_
            for kind_, mid in plan:
                at_w = iso(mid, 0) if along_x else iso(0, mid)
                if kind_ == 'window':
                    at_w = (at_w[0], at_w[1] + bottom_gap(part_) * kr * K)
                    paste_part(bg, wim, wfoot, at_w)
                    ox_, oy_ = round(at_w[0] - wfoot[0]), round(at_w[1] - wfoot[1])
                    if use_w2:
                        wall_pieces.append({'rect': [ox_, oy_, fim.width, fim.height], 'part': f'wall_window_{sn_}', 'side': sn_, 'file': ffile, 'mask': mfile, 'cells': 2})
                    elif tl_:
                        wall_pieces.append({'rect': [ox_, oy_, fim.width, fim.height], 'part': f'wall_window_{sn_}', 'side': sn_, 'file': ffile})
                    if quad_:
                        glass_geo['x' if along_x else 'y'].append((ox_, oy_, quad_, sn_))
                        if mid + pitch / 2 <= length + .3 and len(glass_geo['x' if along_x else 'y']) % 2 == 1:   # (legacy `outside` list)
                            xs_g, ys_g = [p_[0] + ox_ for p_ in quad_], [p_[1] + oy_ for p_ in quad_]
                            outside_all.append({'side': 'x' if along_x else 'y', 'rect': [min(xs_g), min(ys_g), max(xs_g) - min(xs_g), max(ys_g) - min(ys_g)],
                                                'poly': [[p_[0] + ox_, p_[1] + oy_] for p_ in quad_], 'piece_rect': [ox_, oy_, wim.width, wim.height],
                                                'part': f'wall_window_{sn_}', 'span': [mid - pitch / 2, mid + pitch / 2]})
                else:
                    pp_ = plain_part({'plain': 'wall_plain', 'plain1': 'wall_plain1'}.get(kind_, 'wall_light'), along_x)
                    if not pp_:
                        continue
                    pim, pfoot = scaled(pp_, kr)
                    at_w = (at_w[0], at_w[1] + bottom_gap(pp_) * kr * K)
                    paste_part(bg, pim, pfoot, at_w)
                    ox_, oy_ = round(at_w[0] - pfoot[0]), round(at_w[1] - pfoot[1])
                    ent = {'rect': [ox_, oy_, pim.width, pim.height], 'part': {'plain': 'wall_plain', 'plain1': 'wall_plain1'}.get(kind_, 'wall_light'),
                           'side': sn_, 'flip': not along_x, 'file': rel(write_png(out_dir / 'scaled', f'{kind_}-{sn_}', pim))}
                    if kind_ == 'light' and parts['wall_light'].get('light'):
                        lx_, ly_ = parts['wall_light']['light']
                        if not along_x:
                            lx_ = parts['wall_light']['w'] - lx_
                        ent['light'] = [round(ox_ + lx_ * kr * K, 1), round(oy_ + ly_ * kr * K, 1)]
                    wall_pieces.append(ent)
        if use_w2 and 'wall_post' in parts:                   # the back corner: a post over the seam of the two walls
            pim, pfoot = scaled(parts['wall_post'], kr)
            at_w = iso(0, 0)
            at_w = (at_w[0], at_w[1] + bottom_gap(parts['wall_post']) * kr * K)
            paste_part(bg, pim, pfoot, at_w)
            ox_, oy_ = round(at_w[0] - pfoot[0]), round(at_w[1] - pfoot[1])
            wall_pieces.append({'rect': [ox_, oy_, pim.width, pim.height], 'part': 'wall_post', 'side': 'corner', 'file': rel(write_png(out_dir / 'scaled', 'post', pim))})
        a_bg_ = np.array(bg)                                  # ★A4: a one-pixel transparent hole between two wall pieces (a rounding seam) is filled from the pixel above
        hole_ = (a_bg_[1:-1, :, 3] < 40) & (a_bg_[:-2, :, 3] > 200) & (a_bg_[2:, :, 3] > 100)
        if hole_.any():
            hy_, hx_ = np.nonzero(hole_)
            a_bg_[hy_ + 1, hx_] = a_bg_[hy_, hx_]
            bg.paste(Image.fromarray(a_bg_, 'RGBA'))
    else:                                                    # PLACEHOLDER walls
        poly([iso(0, 0), iso(0, D), iso(0, D, wall_h), iso(0, 0, wall_h)], PLACEHOLDER['wall_l'] + (255,))
        poly([iso(0, 0), iso(W, 0), iso(W, 0, wall_h), iso(0, 0, wall_h)], PLACEHOLDER['wall_r'] + (255,))

    # ---- the grid: what stands where
    occ = {}                                                  # cell -> object id
    registry = []                                             # fixed things, in the order they were placed
    warnings = []

    def can(cells):
        return all(floor_ok(c[0], c[1]) and c not in occ for c in cells)

    def add(oid, kind, cells, im=None, foot=None, at=None, required=False, attach=False):
        """Place a thing on cells. Overlaps are never made: a required thing that does not fit is dropped with a
        warning, an optional one is silently skipped. `attach`: sits on another thing (a mug on a table)."""
        cells = [tuple(c) for c in cells]
        if not attach:
            if not can(cells):
                if required:
                    warnings.append(f'{oid}: the cells {cells[:4]} are taken or off the floor; not placed')
                return False
            for c in cells:
                occ[c] = oid
        registry.append({'id': oid, 'kind': kind, 'cells': cells, 'im': im, 'foot': foot, 'at': at, 'seq': len(registry)})
        return True

    def place(oid, kind, part_name, x0, y0, w=1, h=1, k=None, required=False, attach=False):
        """A part on the w x h cells starting at (x0, y0); 1 x 1 things stand in the middle of the cell, bigger ones
        have their picture's bottom centre on the front corner."""
        if part_name not in parts:
            return False
        if k is None:
            k = kr * TRASH_SCALE if part_name == 'trash' else kr if part_name in ('reception', 'picture') else S
        im, foot = scaled(parts[part_name], k)
        at = iso(x0 + .5, y0 + .5) if (w == 1 and h == 1) else iso(x0 + w, y0 + h)
        return add(oid, kind, cells_rect(x0, y0, w, h), im, foot, at, required, attach)

    out = {'zones': [], 'desks': {}, 'spots': {'rooms': {}}, 'width': width, 'height': height, 'islands': [], 'seats': {}}
    out['l86'] = bool(L86)                                    # ★86: the mod keeps everybody at the own desk (stands up in place for an approval / a report)
    out['iso'] = {'ox': ox, 'oy': oy, 'k': K, 'tw': TW, 'th': TH}                      # ★102: the tests read the floor's pixel -> cell map from here
    out['seatless'] = out_seatless                            # waiting longer than seat_hold_min: no seat, they stay in the lounge
    out['seat_hold_min'] = hold_s / 60
    rug_items = []                                            # (kind, key, cells, colour): not baked into the background (they change often)
    people = {}

    def person_cache(aid):
        if aid not in people:
            people[aid] = person_files(sp, aid)
        return people[aid]

    # ---- the pictures used by the islands (the sheet's parts; plain drawn stand-ins until they exist)
    def pt(a_, b_, z_=0):
        """Final pixels, from the front corner of a footprint, of the point `a_` cells back along -x, `b_` cells back along -y, `z_` px up."""
        return ((b_ - a_) * (TW / 2) * K, -(a_ + b_) * (TH / 2) * K - z_ * K)

    def drawn(polys):
        """RGBA image of coloured polygons given as (points, fill, outline); returns (image, foot) with foot = the front corner."""
        xs_ = [q[0] for p_, _, _ in polys for q in p_]
        ys_ = [q[1] for p_, _, _ in polys for q in p_]
        mx, my = math.floor(min(xs_)) - 1, math.floor(min(ys_)) - 1
        im = Image.new('RGBA', (math.ceil(max(xs_)) - mx + 2, math.ceil(max(ys_)) - my + 2), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        for p_, fill_, line_ in polys:
            dr.polygon([(q[0] - mx, q[1] - my) for q in p_], fill=fill_, outline=line_)
        return im, (-mx, -my)

    def plank_stand_in():
        top = [pt(0, 0, 12), pt(3, 0, 12), pt(3, 1, 12), pt(0, 1, 12)]
        return drawn([([pt(0, 0, 12), pt(3, 0, 12), pt(3, 0, 0), pt(0, 0, 0)], (176, 138, 92, 255), (90, 66, 40, 255)),
                      ([pt(0, 0, 12), pt(0, 1, 12), pt(0, 1, 0), pt(0, 0, 0)], (196, 158, 108, 255), (90, 66, 40, 255)),
                      (top, (228, 186, 128, 255), (110, 80, 48, 255))])

    def laptop_stand_in(state_):
        base = [pt(0, 0, 12), pt(1.2, 0, 12), pt(1.2, .9, 12), pt(0, .9, 12)]
        polys = []
        if state_ != 'closed':
            panel = [pt(0, .9, 12), pt(1.2, .9, 12), pt(1.2, .9, 21), pt(0, .9, 21)]
            polys.append((panel, (28, 40, 78, 255) if state_ == 'on' else (34, 36, 42, 255), (20, 22, 28, 255)))
        polys.append((base, (70, 74, 82, 255), (24, 26, 32, 255)))
        im, foot = drawn(polys)
        return im, foot, (pt(0, .9, 21)[0] + foot[0], pt(0, .9, 21)[1] + foot[1], abs(pt(1.2, .9, 21)[0] - pt(0, .9, 21)[0]), 9 * K)

    plank_parts = {k_: parts.get(f'plank_{k_}') for k_ in ('left', 'mid', 'right')}
    laptop_parts = {k_: parts.get(f'laptop_{k_}') for k_ in ('off', 'on', 'closed')}

    def seat_plank(kind_a, kind_b, x0_, y0_, gap_=0.0):
        """The desk of one seat (3 cells along x, 1 deep): two of the sheet's planks (1.5 cells each) side by side as one picture,
        its foot on the front corner of the 3 cells. Without the sheet's planks, a drawn board.
        ★46 (A9): gap_ > 0 = a table of its own: the two planks overlap in the middle so the desk is 3 - gap_ cells long, centred on the
        3 cells, with gap_ cells of floor between it and the next seat's desk (one desk = one seat, the count is seen at a glance).
        ★70-1: with the pack's `desk_iso` (one top, 2:1 isometric) the desk is that ONE picture, its cells (1.5 x .9) centred on the seat's
        3 cells, its back on the cells' back edge (y0): no two planks, no seam in the top."""
        di_ = parts.get('desk_iso')
        if di_ and gap_:
            d_im, d_ft = scaled(di_, S * PLANK_K)
            ln_, dp_ = (di_.get('cells') or [1.5, .9])[:2]
            fc_, fd_ = iso(x0_ + 1.5 + ln_ / 2, y0_ + max(1, dp_)), iso(x0_ + 3, y0_ + 1)   # the desk's own front corner (back on y0, a deeper top reaches over the tucked chair); the caller's foot point
            return d_im, (d_ft[0] + fd_[0] - fc_[0], d_ft[1] + fd_[1] - fc_[1])
        if not (plank_parts.get(kind_a) or plank_parts.get('mid')):
            return plank_stand_in()
        a_im, a_ft = scaled(plank_parts.get(kind_a) or plank_parts['mid'], S * PLANK_K)
        b_im, b_ft = scaled(plank_parts.get(kind_b) or plank_parts['mid'], S * PLANK_K)
        fa_, fb_ = iso(x0_ + 1.5 + gap_ / 2, y0_ + 1), iso(x0_ + 3 - gap_ / 2, y0_ + 1)
        if gap_:
            fd_ = iso(x0_ + 3, y0_ + 1)                          # the foot stays on the 3 cells' front corner (the caller places it there)
            left = min(fa_[0] - a_ft[0], fb_[0] - b_ft[0])
            top = min(fa_[1] - a_ft[1], fb_[1] - b_ft[1])
            right = max(fa_[0] - a_ft[0] + a_im.width, fb_[0] - b_ft[0] + b_im.width)
            bottom = max(fa_[1] - a_ft[1] + a_im.height, fb_[1] - b_ft[1] + b_im.height)
            im = Image.new('RGBA', (math.ceil(right - left), math.ceil(bottom - top)), (0, 0, 0, 0))
            im.alpha_composite(a_im, (round(fa_[0] - a_ft[0] - left), round(fa_[1] - a_ft[1] - top)))
            im.alpha_composite(b_im, (round(fb_[0] - b_ft[0] - left), round(fb_[1] - b_ft[1] - top)))
            return im, (fd_[0] - left, fd_[1] - top)
        left = min(fa_[0] - a_ft[0], fb_[0] - b_ft[0])
        top = min(fa_[1] - a_ft[1], fb_[1] - b_ft[1])
        right = max(fa_[0] - a_ft[0] + a_im.width, fb_[0] - b_ft[0] + b_im.width)
        bottom = max(fa_[1] - a_ft[1] + a_im.height, fb_[1] - b_ft[1] + b_im.height)
        im = Image.new('RGBA', (math.ceil(right - left), math.ceil(bottom - top)), (0, 0, 0, 0))
        im.alpha_composite(a_im, (round(fa_[0] - a_ft[0] - left), round(fa_[1] - a_ft[1] - top)))
        im.alpha_composite(b_im, (round(fb_[0] - b_ft[0] - left), round(fb_[1] - b_ft[1] - top)))
        return im, (fb_[0] - left, fb_[1] - top)

    # ---- glass around an island: 3-cell pieces along x (the front one has a doorway in its middle) and along y
    KP = (3 * (TW / 2) / parts['partition_left']['w']) if 'partition_left' in parts else None      # the one scale of every glass piece / doorway frame
    cands = [parts[k_] for k_ in ('partition_left', 'partition_right') if k_ in parts]
    along_x = along_y = door_im = None
    if cands:
        along_x = next((q for q in cands if runs_down_right(q)), cands[0])
        along_y = next((q for q in cands if q is not along_x), along_x)
        door_im = scaled(parts['partition_doorway'], KP if KP else 3 * (TW / 2) / parts['partition_doorway']['w']) if 'partition_doorway' in parts else None


    def shorten(im, ft, n, down_right):
        """A 3-cell glass piece made n (1 or 2) cells long without making it lower: a slice is cut out of the middle and the two halves are joined
        (the right half moves along the wall's slope). The foot stays at the bottom edge's middle."""
        w, h = im.size
        d = max(1, round((3 - n) * (TW / 2) * K))
        xa = int(round(ft[0] - d / 2))
        xb = xa + d
        al = np.asarray(im.getchannel('A')) > 40

        def bottom(x_):
            rows_ = np.nonzero(al[:, min(max(x_, 0), w - 1)])[0]
            return int(rows_.max()) if len(rows_) else h - 1
        gap_ = ft[1] - bottom(int(round(ft[0])))
        sh = max(1, round(d * .5))
        yl, yr = (sh, 0) if down_right else (0, sh)              # down-right wall: the right half is higher; down-left: lower
        canvas = Image.new('RGBA', (w - d, h + sh), (0, 0, 0, 0))
        canvas.alpha_composite(im.crop((0, 0, xa, h)), (0, yl))
        canvas.alpha_composite(im.crop((xb, 0, w, h)), (xa, yr))
        return canvas, (xa, bottom(max(xa - 1, 0)) + yl + gap_)

    def piece(part_, cells_n):
        im3, ft3 = scaled(part_, KP if KP else cells_n * (TW / 2) / open_png(part_['file']).width)
        if cells_n >= 3 or not KP:
            return im3, ft3
        return shorten(im3, ft3, cells_n, runs_down_right(part_))

    def door_pic(name, native_along_x, along_x, at, which=None):
        """(file, rect) of a door part for a wall along x / y: B's pictures are drawn for one direction, the other uses the mirrored one."""
        q = parts.get(name)
        if not q:
            return None
        src = q.get(which) if which else q
        if not src:
            return None
        mirrored = native_along_x != along_x and 'flip' in q
        f_ = src['file']
        foot = list(q['foot'])
        if mirrored:
            fp_ = APP_HOME / 'hakoniwa-office' / 'scaled' / f'mirror-{Path(f_).stem}.png'
            if not fp_.exists():
                save_atomic(ImageOps.mirror(open_png(f_)), fp_)
            f_, foot = rel(fp_), [q['w'] - foot[0], foot[1]]
        im_, ft_ = scaled({'file': f_, 'foot': foot}, KP if (name == 'doorway2' and KP) else kr)
        return {'file': rel(write_png(out_dir / 'scaled', 'door2', im_)), 'rect': [round(at[0] - ft_[0], 1), round(at[1] - ft_[1], 1), im_.width, im_.height]}

    def door_set(along_x, at):
        """frame (doorway2) and leaves (door2_closed / half / open), each with its back and front half, for the mod."""
        if 'doorway2' not in parts:
            return None
        res = {'frame': dict(door_pic('doorway2', True, along_x, at), back=door_pic('doorway2', True, along_x, at, 'back'),
                             front=door_pic('doorway2', True, along_x, at, 'front')), 'leaf': {}}
        for st_ in ('closed', 'half', 'open'):
            nm_ = f'door2_{st_}'
            if nm_ in parts:
                res['leaf'][st_] = dict(door_pic(nm_, False, along_x, at), back=door_pic(nm_, False, along_x, at, 'back'),
                                        front=door_pic(nm_, False, along_x, at, 'front'))
        return res

    # ---- islands side by side share ONE wall column; a doorway in it joins the two rooms (the middle cell is free: walkable)
    door_skip, island_doors = set(), []
    door_y = None
    if door_im:
        door_y = (ImageOps.mirror(door_im[0]), (door_im[0].width - door_im[1][0], door_im[1][1]))

    def free_rows(I_, y_):                                    # a row between the desk rows (no desk, no seat) inside the island
        return I_['y'] + 1 <= y_ <= I_['y'] + I_['h'] - 2 and (y_ - I_['y'] - 1) % ROW_PITCH >= 2
    keys_ = sorted(islands)
    for ka_ in keys_:
        for kb_ in keys_:
            A_, B_ = islands[ka_], islands[kb_]
            if ka_ == kb_ or A_['x'] + A_['w'] - 1 != B_['x']:
                continue
            xs_ = B_['x']
            lo_, hi_ = max(A_['y'], B_['y']) + 1, min(A_['y'] + A_['h'], B_['y'] + B_['h']) - 2
            mid_y = (lo_ + hi_) / 2
            wide_ = 'doorway2' in parts
            nd_ = 4 if wide_ else 3
            cand_ = [y_ for y_ in range(lo_, hi_ + 2 - nd_) if all(free_rows(A_, y_ + d_) and free_rows(B_, y_ + d_) for d_ in range(nd_))]
            if not cand_ or not door_y:
                continue
            ys_ = min(cand_, key=lambda y_: (abs(y_ + nd_ / 2 - mid_y), y_))
            cells3 = [(xs_, ys_ + d_) for d_ in range(nd_)]
            door_skip |= set(cells3[1:-1] if (wide_ and NO_LINTEL) else cells3)         # ★27-4: no frame with a bar over the opening: the glass pieces end beside the open cells
            at_d = iso(xs_ + .5, ys_ + nd_ / 2)
            if wide_ and NO_LINTEL:
                pass
            elif wide_:
                dp_ = door_pic('doorway2', True, False, at_d)
                dim_ = open_png(dp_['file'])
                add(f'doorway:{ka_}|{kb_}', 'partition', [cells3[0], cells3[-1]], dim_, (at_d[0] - dp_['rect'][0], at_d[1] - dp_['rect'][1]), at_d)
            else:
                add(f'doorway:{ka_}|{kb_}', 'partition', [cells3[0], cells3[2]], door_y[0], door_y[1], iso(xs_ + .5, ys_ + 1.5))
            island_doors.append({'between': [ka_, kb_], 'cell': [xs_, ys_ + 1], 'tiles': [list(c_) for c_ in cells3],
                                 'open_cells': [list(c_) for c_ in (cells3[1:-1] if wide_ else cells3[1:2])], 'pack': door_set(False, at_d) if (wide_ and not NO_LINTEL) else None})
    out['island_doors'] = island_doors

    seat_at = {}                                              # seat id -> (x0, y0) of its plank
    room_cells, room_pack = {}, {}
    # ★31-3: an island that shares its front wall with the next row has no aisle in front; its plate goes on the middle-aisle side.
    stacked_front = {k for k, I_ in islands.items()
                     if any(J_['y'] == I_['y'] + I_['h'] - 1 and J_['x'] == I_['x'] for J_ in islands.values() if J_ is not I_)}
    for k, I in islands.items():
        X, Y, w, h = I['x'], I['y'], I['w'], I['h']
        n_seats = len(I['owners'])
        x_start = X + 1 + ((w - 2) - 3 * I['cols']) // 2
        # ★30-2 (16:12): the island's opening is in the side that faces the middle aisle (the left column's right edge, the right column's left edge), in the
        # free rows between the desk row and the seat row (Y+3 .. Y+h-2): 2 cells wide, centred. A gap in the partition, no frame (NO_LINTEL).
        xs_open = X + w - 1 if I.get('col', 0) == 0 else X
        free_ys = [y_ for y_ in range(Y + 1, Y + 1 + ROW_PITCH) if free_rows(I, y_)]        # ★40: the opening is in the first free block (between the 1st desk row and the 2nd row / the front wall)
        nd_open = 2 if 'doorway2' in parts else 1
        y_open0 = free_ys[0] + (len(free_ys) - nd_open) // 2
        open_cells = [(xs_open, y_open0 + d_) for d_ in range(nd_open)]
        open_cell = open_cells[0]
        island_pack = None
        door_cells_here = set()
        if along_x:
            skip = set(open_cells) | door_skip
            # ★31-3: the shared wall column is claimed once (occ); the later island skips those cells in its edge run
            edges = [('t', [(x_, Y) for x_ in range(X, X + w)], along_x), ('b', [(x_, Y + h - 1) for x_ in range(X, X + w)], along_x),
                     ('l', [(X, y_) for y_ in range(Y + 1, Y + h - 1)], along_y), ('r', [(X + w - 1, y_) for y_ in range(Y + 1, Y + h - 1)], along_y)]
            for tag_, cells_e, part_e in edges:
                run = []
                for c_ in cells_e + [None]:
                    if c_ is not None and c_ not in occ and c_ not in skip and c_[0] > 0 and c_[1] > 0 and c_[0] < band_w - 1:   # x = 0 / y = 0: the outer wall is the island's wall; ★30-2: x = band_w - 1: the right outer wall too
                        run.append(c_)
                        continue
                    if run:                                                # a run of free cells: pieces of at most 3 cells, as even as possible (4 = 2 + 2, never 3 + a
                        k_pc = math.ceil(len(run) / 3)                     # lonely 1-cell glass square at the end)
                        sizes_ = [len(run) // k_pc + (1 if i_ < len(run) % k_pc else 0) for i_ in range(k_pc)]
                        i0 = 0
                        for n_ in sizes_:
                            chunk = run[i0:i0 + n_]
                            i0 += n_
                            pim, pfoot = piece(part_e, n_)
                            add(f'partition:{k}:{tag_}{chunk[0][0]}-{chunk[0][1]}', 'partition', chunk, pim, pfoot,
                                iso(sum(q[0] for q in chunk) / n_ + .5, sum(q[1] for q in chunk) / n_ + .5))
                    run = []
        out['spots']['rooms'][k] = open_cell
        room_cells[k] = open_cells
        room_pack[k] = island_pack
        seat_ids = []
        seat_pos = [(r2_, c2_) for r2_, sz_ in enumerate(I['row_sizes']) for c2_ in range(sz_)]
        for i_, owner in enumerate(I['owners']):
            r_, c_ = seat_pos[i_]
            cols_r = I['row_sizes'][r_]
            x0, y0 = x_start + 3 * c_, Y + 1 + ROW_PITCH * r_
            pim, pfoot = seat_plank('left', 'right', x0, y0, DESK_GAP)      # ★46: every seat its own table (both ends), never one long desk
            if not add(f'desk:{k}#{i_}', 'desk', cells_rect(x0, y0, 3, 1), pim, pfoot, iso(x0 + 3, y0 + 1), required=True):
                continue
            sid = f'{k}#{i_}'
            seat_ids.append(sid)
            seat_at[sid] = (x0, y0)
            sx, sy = x0 + 1, y0 + 1                              # the seat: the cell in front of the middle of the 3 cells
            cx_, cy_ = iso(sx + .5, sy + .5)                     # the centre of the seat cell (where the chair stands)
            anchors = pack.get('people_anchor') or {}
            fa = pack.get('fa') or {}
            sc_p = PK * K                                        # people scale
            tp, st_ = anchors.get('type_pc'), anchors.get('stand')
            # the picture's bottom centre (where the mod puts it) is the chair's centre moved by the pose's anchor offset
            foot_xy = [cx_ + ((st_[0] - tp[0]) * sc_p if tp and st_ else 0), cy_ + ((st_[1] - tp[1]) * sc_p if tp and st_ else 0)]
            lap = {}
            if all(laptop_parts.values()) and fa.get('hand') and (fa.get('laptop') or {}).get('keyboard_center'):
                kbs = fa['laptop']['keyboard_center']
                hand = (cx_ + fa['hand'][0] * sc_p, cy_ + fa['hand'][1] * sc_p)       # the fingertips
                rects = {}
                for s_ in ('off', 'on', 'closed'):
                    lim, lfoot = scaled(laptop_parts[s_], S)
                    kb = kbs.get(f'laptop_{s_}') or kbs['laptop_on']
                    lap[s_] = rel(write_png(out_dir / 'scaled', f'lap-{s_}', lim))
                    rects[s_] = [round(hand[0] - kb[0] * S * K, 1), round(hand[1] - kb[1] * S * K, 1), lim.width, lim.height]
                lrect = rects['on']
                scr = (fa.get('screen') or {}).get('rect') or (fa['laptop'].get('screen_rect'))
                srect = [round(lrect[0] + scr[0] * S * K, 1), round(lrect[1] + scr[1] * S * K, 1), round(scr[2] * S * K, 1), round(scr[3] * S * K, 1)]
                faces = []
                for f_ in ((fa.get('screen') or {}).get('faces') or []):
                    fw_, fh_ = max(1, round(srect[2])), max(1, round(srect[3] * 3))
                    fp_ = out_dir / 'scaled' / f'face-{Path(f_).stem}-{fw_}x{fh_}.png'
                    if not fp_.exists():
                        save_atomic(open_png(f_).resize((fw_, fh_), Image.NEAREST), fp_)
                    faces.append(rel(fp_))
                lap.update({'rects': rects})
            else:                                                # drawn stand-ins until the sheet's laptops are in the pack
                for s_ in ('off', 'on', 'closed'):
                    lim, lfoot, _ = laptop_stand_in(s_)
                    lap[s_] = rel(write_png(out_dir / 'scaled', f'lap-{s_}', lim))
                lim0, lfoot0, sr_ = laptop_stand_in('on')
                fpt = iso(x0 + 1.5 + .6, y0 + .8)
                lrect = [round(fpt[0] - lfoot0[0], 1), round(fpt[1] - lfoot0[1], 1), lim0.width, lim0.height]
                srect = [round(lrect[0] + sr_[0], 1), round(lrect[1] + sr_[1], 1), round(sr_[2], 1), round(sr_[3], 1)]
                faces = []
            lap.update({'rect': lrect, 'depth': x0 + 1 + y0, 'screen': {'rect': srect, 'faces': faces, 'loop_h': round(srect[3], 1)}})
            px0_, px1_ = (x0 + .8, x0 + 2.2) if 'desk_iso' in parts else (x0 + .5, x0 + 2.45)     # ★70-1: on the one-top desk (2 cells, x0 + .5 .. x0 + 2.5)
            props_ = {'papers': {'at': [round(v_, 1) for v_ in iso(px0_, y0 + .45, 14)], 'depth': x0 + y0 + 2.1},
                      'drink': {'at': [round(v_, 1) for v_ in iso(px1_, y0 + .5, 14)], 'depth': x0 + y0 + 2.1},
                      'box': {'at': [round(v_, 1) for v_ in iso(x0 + 2.4, y0 + 1.6)], 'depth': x0 + y0 + 3.0}}
            out['seats'][sid] = {'props': props_, 'island': k, 'n': i_, 'tile': [sx, sy], 'xy': [round(foot_xy[0], 1), round(foot_xy[1], 1)], 'anchor_xy': [cx_, cy_],
                                 'depth': sx + sy, 'owner': owner, 'laptop': lap}
            if owner:
                out['desks'][owner] = {'seat_id': sid, 'seat_tile': [sx, sy], 'seat': [round(foot_xy[0], 1), round(foot_xy[1], 1)], 'chair': None}
        # ceiling lights (one soft pool of light per two seats, between the desk rows): the mod switches them on at night when somebody sits here
        for r2_ in range(I['rows']):
            for c2_ in range(0, I['row_sizes'][r2_], 2):
                lx_, ly_ = x_start + 3 * c2_ + 3, Y + 1 + ROW_PITCH * r2_ + 3.5
                out.setdefault('lights', []).append({'island': k, 'at': [round(v_, 1) for v_ in iso(lx_, ly_)], 'size': [round(6 * TW * K, 1), round(6 * TH * K, 1)]})
        # a plant and a bin in the island's corners, where they fit
        place(f'plant:{k}', 'plant', 'plant', X + 1, Y + 1, 1, 1, .3)
        place(f'trash:{k}', 'trash', 'trash', X + w - 2, Y + h - 2, 1, 1)
        ring_pts = [iso(X, Y), iso(X + w, Y), iso(X + w, Y + h), iso(X, Y + h)]
        xs_, ys_ = [q[0] for q in ring_pts], [q[1] for q in ring_pts]
        # ★31-3: stacked islands share their front wall — label on the aisle opening; plate is omitted later (no lobby-side aisle)
        if k in stacked_front:
            ax_ = (X + w + .55) if I.get('col', 0) == 0 else (X - .55)
            ay_ = sum(c_[1] for c_ in open_cells) / len(open_cells) + .5
            front_ = [X + w if I.get('col', 0) == 0 else X, Y, Y + h, 'aisle']
            lab_ = iso(ax_, ay_)
            plate_init = None
        else:
            front_ = [X, Y + h, X + w]
            lab_ = iso(X + w / 2, Y + h + .6)
            plate_init = {'at': [round(v_, 1) for v_ in iso(X + w / 2, Y + h + .55)], 'depth': round(X + w / 2 + Y + h + .55, 2)}
        entry = {'key': k, 'title': I['title'], 'source': I['source'], **({'corner': True} if I['cols'] == 1 else {}),   # ★65 1-2: nobody sits here: a small corner (one desk)
                 'tiles': [list(c_) for c_ in cells_rect(X + 1, Y + 1, w - 2, h - 2)],
                 'rect': [round(min(xs_), 1), round(min(ys_), 1), round(max(xs_) - min(xs_), 1), round(max(ys_) - min(ys_), 1)],
                 'label': [round(lab_[0], 1), round(lab_[1], 1)],
                 'front': front_,
                 'opening': list(iso(sum(c_[0] for c_ in open_cells) / len(open_cells) + .5, sum(c_[1] for c_ in open_cells) / len(open_cells) + .5)), 'seats': seat_ids,
                 'open_cells': [list(c_) for c_ in open_cells], 'door': island_pack}
        if plate_init:
            entry['plate'] = plate_init
        out['islands'].append(entry)

    # team rugs: a pale rug under every seat block of a team (neighbouring blocks join), and a zone for the label
    team_zones = []
    for n_, root_ in enumerate(sorted(set(gk.values()))):
        members_ = {i_ for i_, r_ in gk.items() if r_ == root_}
        col_ = TEAM_RUGS[n_ % len(TEAM_RUGS)]
        pts_all, rug_cells = [], []
        for sid, st_ in out['seats'].items():
            if st_['owner'] in members_:
                x0, y0 = seat_at[sid]
                quad = [iso(x0, y0), iso(x0 + 3, y0), iso(x0 + 3, y0 + 3), iso(x0, y0 + 3)]
                pts_all += quad
                rug_cells += cells_rect(x0, y0, 3, 3)
        if pts_all:
            xs_, ys_ = [q[0] for q in pts_all], [q[1] for q in pts_all]
            head = next((a_ for a_ in agents if a_['id'] == root_), None)
            team_zones.append({'key': f'team:{root_}', 'kind': 'team',
                               'title': (head or {}).get('name') or (root_[4:] if root_.startswith('tui:') else root_),
                               'children': len(members_) - (1 if head else 0), 'tiles': [list(c_) for c_ in rug_cells],
                               'label': [round((min(xs_) + max(xs_)) / 2, 1), round(min(ys_) + 6 * K, 1)],
                               'rect': [round(min(xs_), 1), round(min(ys_), 1), round(max(xs_) - min(xs_), 1), round(max(ys_) - min(ys_), 1)]})
    out['zones'] += team_zones
    out['tags_short'] = K < .8

    # ---- lobby: entrance door, reception, the two windows with their queues, the lounge
    door_y = door_row0
    for c_ in cells_rect(0, door_y, 2, DOOR_W):
        add('doorzone', 'door', [c_], required=True)         # the door and the space its leaf swings through
    if board_span and glass_geo[board_span[4]]:
        # the board: a dark frame and a black face as high as the window glass, `cells` wide, centred on the plain pieces; the dot grid is only listed
        b0_, b1_, bcells_, brows_, baxis_ = board_span
        ox_g, oy_g, q_g, _sg = glass_geo[baxis_][0]
        xg_ = ox_g + q_g[0][0]
        if baxis_ == 'y':
            u_g = (iso(0, 0)[0] - xg_) / (TW / 2 * K)                 # the wall coordinate of the glass's left edge
            yline_ = iso(0, u_g)[1]
        else:
            u_g = (xg_ - iso(0, 0)[0]) / (TW / 2 * K)
            yline_ = iso(u_g, 0)[1]
        z_wall_ = getattr(sp, 'WALL_END', 376) * kr                 # ★19-2: the board is as high as the outer wall (not only as the window glass): from just above the floor to just under the top
        z_bot_ = z_wall_ * .10
        z_top_ = z_wall_ * .93
        uc_ = (b0_ + b1_) / 2
        ua_, ub_ = uc_ - bcells_ / 2, uc_ + bcells_ / 2           # ua_ < ub_: ub_ is the left (front) end on the screen
        fr_ = .06                                                 # the bezel
        def pt_(u_, z_):
            return iso(0, u_, z_) if baxis_ == 'y' else iso(u_, 0, z_)
        if baxis_ == 'y':                                         # on the left wall the larger u is the left (front) end on the screen
            lu_, ru_, dl_ = ub_, ua_, -1
        else:
            lu_, ru_, dl_ = ua_, ub_, 1
        outer_ = [pt_(lu_, z_top_), pt_(ru_, z_top_), pt_(ru_, z_bot_), pt_(lu_, z_bot_)]                   # TL, TR, BR, BL
        du_, dz_ = bcells_ * fr_ * .6, (z_top_ - z_bot_) * fr_ * 1.4
        face_ = [pt_(lu_ + dl_ * du_, z_top_ - dz_), pt_(ru_ - dl_ * du_, z_top_ - dz_), pt_(ru_ - dl_ * du_, z_bot_ + dz_), pt_(lu_ + dl_ * du_, z_bot_ + dz_)]
        xs_b = [p_[0] for p_ in outer_]
        ys_b = [p_[1] for p_ in outer_]
        bx0, by0 = math.floor(min(xs_b)) - 1, math.floor(min(ys_b)) - 1
        bim = Image.new('RGBA', (math.ceil(max(xs_b)) - bx0 + 2, math.ceil(max(ys_b)) - by0 + 2), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bim)
        bd.polygon([(x_ - bx0, y_ - by0) for x_, y_ in outer_], fill=(46, 48, 54, 255))
        bd.polygon([(x_ - bx0, y_ - by0) for x_, y_ in face_], fill=(12, 13, 16, 255))
        tl_, tr_, br_, bl_ = face_
        ncols_ = max(100, round(brows_ * math.hypot(tr_[0] - tl_[0], tr_[1] - tl_[1]) / max(1.0, math.hypot(bl_[0] - tl_[0], bl_[1] - tl_[1]))))
        dxv_ = ((tr_[0] - tl_[0]) / ncols_, (tr_[1] - tl_[1]) / ncols_)
        dyv_ = ((bl_[0] - tl_[0]) / brows_, (bl_[1] - tl_[1]) / brows_)
        org_ = (tl_[0] + dxv_[0] / 2 + dyv_[0] / 2, tl_[1] + dxv_[1] / 2 + dyv_[1] / 2)
        for r_ in range(brows_):                                   # the dots, switched off: a faint grid
            for c_ in range(ncols_):
                cx_, cy_ = org_[0] + c_ * dxv_[0] + r_ * dyv_[0] - bx0, org_[1] + c_ * dxv_[1] + r_ * dyv_[1] - by0
                bd.point((round(cx_), round(cy_)), fill=(38, 40, 46, 255))
        out['board'] = {'file': rel(write_png(out_dir / 'scaled', 'board', bim)), 'rect': [bx0, by0, bim.width, bim.height], 'side': side_name[baxis_ == 'x'], 'axis': baxis_,
                        'outer': [[round(x_, 1), round(y_, 1)] for x_, y_ in outer_], 'face': [[round(x_, 1), round(y_, 1)] for x_, y_ in face_],
                        'cols': ncols_, 'rows': brows_, 'origin': [round(org_[0], 2), round(org_[1], 2)], 'dx': [round(dxv_[0], 3), round(dxv_[1], 3)],
                        'dy': [round(dyv_[0], 3), round(dyv_[1], 3)], 'cells': bcells_, 'span': [b0_, b1_], 'depth': 0}
    else:
        out['board'] = None
    for wp_ in wall_pieces:                                  # ★62-2 a clear margin round each wall piece: zoomed, the App smears a picture's outer pixel (a thin line at every joint)
        if wp_.get('file') and not wp_.get('mask'):
            wp_['file'], wp_['rect'] = clear_margin(out_dir, wp_['file'], wp_['rect'])
    out['wall_pieces'] = wall_pieces
    for wp_ in wall_pieces:                                   # the wall lamp beside the entrance: a light pool that stays on all night
        if wp_.get('light'):
            out.setdefault('lights', []).append({'island': 'lamp:wall', 'at': wp_['light'], 'size': [round(4 * TW * K, 1), round(4 * TH * K, 1)]})
    bands = {}
    bird_paths = []
    glass_pack_ = {sn_: t_['glass'] for sn_, t_ in tall.items() if use_w2 and t_ and t_.get('glass')}      # ★21: the 2-cell window's own glass (pack px): the bands are as tall as it

    def cut_cache(*key_parts):
        """A cut view / weather picture depends only on the wall's geometry, the scale and the pack's version: look it up, else make it and write it down."""
        key = hashlib.sha1(json.dumps([key_parts, getattr(sp, 'VERSION', 0)], default=str).encode()).hexdigest()[:14]
        fp = out_dir / 'scaled' / f'cut-{key}.json'
        try:
            d = json.loads(fp.read_text(encoding='utf-8'))
            if (APP_HOME / d['file']).is_file():
                return d, fp
        except (OSError, ValueError, KeyError):
            pass
        return None, fp

    def cut_save(fp, d):
        tmp = fp.with_name(f'{fp.stem}.{os.getpid()}.tmp')
        tmp.write_text(json.dumps(d), encoding='utf-8')
        replace_or_keep(tmp, fp)                     # ★61: a parallel run writing the same cut must not fail this one
        return d
    if hasattr(sp, 'outside_band') and not STALE[0] and glass_geo['x'] and glass_geo['y'] and wall_masks:
        for key_, along_x_, offset_ in (('x', True, 0.0), ('y', False, .6)):
            g_ = glass_geo[key_]
            sname_ = g_[0][3]
            xmin_ = min(ox_ + min(q_[0][0], q_[3][0]) for ox_, oy_, q_, _s in g_)
            xmax_ = max(ox_ + max(q_[1][0], q_[2][0]) for ox_, oy_, q_, _s in g_)
            ox0_, oy0_, q0_, _s0 = min(g_, key=lambda t_: t_[0] + t_[2][0][0])
            pieces_key = sorted((g_t[0], g_t[1]) for g_t in g_)
            for per_ in PERIOD_ORDER():
                hit_, ckf_ = cut_cache('band2', sname_, per_, round(xmax_ - xmin_), offset_, pieces_key, round(K, 4))
                if hit_:
                    bands.setdefault(sname_, {})[per_] = hit_
                    continue
                if not BUILD_BANDS and time.time() - T_START > BAND_DEADLINE:       # the App stops a run after 30 s: until BAND_DEADLINE seconds bands are made here (the current time of day first), the rest in the next run / the apart run
                    COLD[0] = True
                    early_warm(out_dir)
                    continue
                try:
                    fsc_ = kr * K                                  # B's band is made in the pack's pixels (the glass 220 high): made for this wall's length, then shrunk to the scene's scale
                    b_ = sp.outside_band(per_, sname_, (xmax_ - xmin_) / fsc_, offset_, geo=glass_pack_.get(sname_))
                except Exception:
                    continue
                bim = open_png(b_['file'])
                bim = bim.resize((max(1, round(bim.width * fsc_)), max(1, round(bim.height * fsc_))), Image.LANCZOS)
                b_ = dict(b_, edge0=[b_['edge0'][0] * fsc_, b_['edge0'][1] * fsc_])
                bx_, by_ = round(xmin_), round(oy0_ + q0_[0][1] - b_['edge0'][1])
                cut_ = Image.new('L', bim.size, 0)                           # the union of the glass of every window piece, on the band's canvas
                for ox_, oy_, q_, _s in g_:
                    m_ = wall_masks[sname_].getchannel('A') if wall_masks[sname_].mode == 'RGBA' else wall_masks[sname_].convert('L')
                    layer_ = Image.new('L', bim.size, 0)
                    layer_.paste(m_, (ox_ - bx_, oy_ - by_))
                    cut_ = ImageChops.lighter(cut_, layer_)
                a_ = np.array(bim)
                a_[..., 3] = np.minimum(a_[..., 3], np.array(cut_))
                bands.setdefault(sname_, {})[per_] = cut_save(ckf_, {'file': rel(write_png(out_dir / 'scaled', f'band-{per_}-{sname_}', Image.fromarray(a_, 'RGBA'))),
                                                                     'rect': [bx_, by_, bim.width, bim.height]})
            # the birds' way along this wall: the middle line of the glass storey, with the storey's top and bottom edges and its bounding box
            tl_x = tall.get(sname_) or {}
            gl_ = tl_x.get('glass')
            if gl_:
                sl_ = gl_['slope']
                hh_ = gl_['h'] * kr * K
                y_at = lambda x_: oy0_ + q0_[0][1] + sl_ * (x_ - (ox0_ + q0_[0][0]))
                ys_all = [y_at(xmin_), y_at(xmax_), y_at(xmin_) + hh_, y_at(xmax_) + hh_]
                bw_ = .61 * hh_ / 2                                   # the bird's picture stays inside the storey also at both ends
                bird_paths.append({'side': sname_, 'from': [round(xmin_ + bw_, 1), round(y_at(xmin_ + bw_) + hh_ / 2, 1)], 'to': [round(xmax_ - bw_, 1), round(y_at(xmax_ - bw_) + hh_ / 2, 1)],
                                   'clip': [round(xmin_, 1), round(min(ys_all), 1), round(xmax_ - xmin_, 1), round(max(ys_all) - min(ys_all), 1)],
                                   'top': [[round(xmin_, 1), round(y_at(xmin_), 1)], [round(xmax_, 1), round(y_at(xmax_), 1)]], 'slope': sl_, 'glass_h': round(hh_, 1),
                                   'bird': [round(.61 * hh_, 1), round(.55 * hh_, 1)]})     # the bird's picture size: its corners stay inside the glass storey on this line
    out['bird_paths'] = bird_paths
    out['night_sky'] = night_sky_for(glass_geo, bird_paths, kr * K, now)
    overlays = {}                                             # weather layers cut by the glass of the wall's windows; fixed names: a change of weather makes no new picture
    kinds_ = ((pack.get('life') or {}).get('weather') or {}).get('kinds') or {}
    if hasattr(sp, 'weather_band') and not STALE[0] and bands and wall_masks and kinds_:
        layer_frames = {'cloud_light': [0], 'cloud_dark': [0], 'fog': [0], 'rain': [0, 1, 2], 'snow': [0, 1, 2]}
        built = {}
        for key_, along_x_, offset_ in (('x', True, 0.0), ('y', False, .6)):
            g_ = glass_geo[key_]
            sname_ = g_[0][3]
            xmin_ = min(ox_ + min(q_[0][0], q_[3][0]) for ox_, oy_, q_, _s in g_)
            xmax_ = max(ox_ + max(q_[1][0], q_[2][0]) for ox_, oy_, q_, _s in g_)
            ox0_, oy0_, q0_, _s0 = min(g_, key=lambda t_: t_[0] + t_[2][0][0])
            pieces_key = sorted((g_t[0], g_t[1]) for g_t in g_)
            for layer_, frames_ in layer_frames.items():
                for fr_i in frames_:
                    hit_, ckf_ = cut_cache('wx2', layer_, fr_i, sname_, round(xmax_ - xmin_), offset_, pieces_key, round(K, 4))
                    if hit_:
                        built[(sname_, layer_, fr_i)] = hit_
                        continue
                    if not BUILD_BANDS and time.time() - T_START > BAND_DEADLINE:
                        COLD[0] = True
                        early_warm(out_dir)
                        continue
                    try:
                        fsc_ = kr * K
                        b_ = sp.weather_band(layer_, sname_, (xmax_ - xmin_) / fsc_, fr_i, offset_, geo=glass_pack_.get(sname_))
                    except Exception:
                        continue
                    bim = open_png(b_['file'])
                    bim = bim.resize((max(1, round(bim.width * fsc_)), max(1, round(bim.height * fsc_))), Image.LANCZOS)
                    b_ = dict(b_, edge0=[b_['edge0'][0] * fsc_, b_['edge0'][1] * fsc_])
                    bx_, by_ = round(xmin_), round(oy0_ + q0_[0][1] - b_['edge0'][1])
                    cut_ = Image.new('L', bim.size, 0)
                    for ox_, oy_, q_, _s in g_:
                        m_ = wall_masks[sname_].getchannel('A') if wall_masks[sname_].mode == 'RGBA' else wall_masks[sname_].convert('L')
                        layer_im = Image.new('L', bim.size, 0)
                        layer_im.paste(m_, (ox_ - bx_, oy_ - by_))
                        cut_ = ImageChops.lighter(cut_, layer_im)
                    a_ = np.array(bim)
                    a_[..., 3] = np.minimum(a_[..., 3], np.array(cut_))
                    built[(sname_, layer_, fr_i)] = cut_save(ckf_, {'file': rel(write_png(out_dir / 'scaled', f'wx-{layer_}{fr_i}-{sname_}', Image.fromarray(a_, 'RGBA'))),
                                                                    'rect': [bx_, by_, bim.width, bim.height]})
        for sname_ in {k_[0] for k_ in built}:
            overlays[sname_] = {}
            for kind_, layers_ in kinds_.items():
                lst_ = []
                for layer_ in layers_:
                    for fr_i in layer_frames.get(layer_, [0]):
                        ent_ = built.get((sname_, layer_, fr_i))
                        if ent_:
                            lst_.append(dict(ent_, layer=layer_, **({'frame': fr_i} if len(layer_frames.get(layer_, [0])) > 1 else {})))
                overlays[sname_][kind_] = lst_
    out['weather_overlays'] = overlays
    out['outside_bands'] = bands
    # ★15 / A9's rest (A10): the stars and the moon's line come from the glass geometry, but the night band (the real glass) can slant a few px off it along
    # a long wall when the floor is shown small (60 people / 12 spaces, K 0.25: up to 5.6 px at the far end). Fit them into the band's own glass.
    try:
        gl_ = np.zeros((int(height), int(width)), bool)
        for side_ in bands.values():
            nb_ = (side_ or {}).get('night')
            if nb_ and nb_.get('file'):
                a_ = np.asarray(open_png(nb_['file']))[..., 3] > 40
                bx_, by_ = int(nb_['rect'][0]), int(nb_['rect'][1])
                h_, w_ = min(a_.shape[0], gl_.shape[0] - by_), min(a_.shape[1], gl_.shape[1] - bx_)
                if h_ > 0 and w_ > 0 and bx_ >= 0 and by_ >= 0:
                    gl_[by_:by_ + h_, bx_:bx_ + w_] |= a_[:h_, :w_]

        def col_span(x0_, x1_):                                   # the rows that are glass in every column x0..x1 (None: some column has none)
            lo_, hi_ = -1, 10 ** 9
            for xq_ in range(max(0, int(x0_)), min(gl_.shape[1] - 1, int(x1_)) + 1):
                ys_ = np.nonzero(gl_[:, xq_])[0]
                if not len(ys_):
                    return None
                lo_, hi_ = max(lo_, int(ys_.min())), min(hi_, int(ys_.max()))
            return (lo_, hi_) if hi_ > lo_ else None
        if gl_.any():
            ns_ = out['night_sky']
            fit_ = []
            for r_ in ns_['star_rects']:
                sp_ = col_span(r_[0], r_[0] + r_[2])
                if not sp_:
                    continue
                y_ = max(r_[1], sp_[0] + 1)
                hh_ = min(r_[1] + r_[3], sp_[1] - 1) - y_
                if hh_ >= 1.5:
                    fit_.append([r_[0], round(y_, 1), r_[2], round(hh_, 1)])
            ns_['star_rects'] = fit_
            for m_ in ns_['moon_path']:
                for end_ in ('from', 'to'):
                    sp_ = col_span(m_[end_][0], m_[end_][0])
                    if sp_ and not (sp_[0] < m_[end_][1] < sp_[1]):
                        m_[end_][1] = round(min(max(m_[end_][1], sp_[0] + 1), sp_[1] - 1), 1)
    except Exception as e_:                                       # never lose the scene for the stars
        warnings.append(f'night sky fit: {e_}')
    out['outside'] = [{k_: v_ for k_, v_ in o_.items() if k_ != 'span'} for o_ in outside_all
                      if not (o_['side'] == 'y' and o_['span'][1] > door_y - .5 and o_['span'][0] < door_y + DOOR_W - .5)]
    out['spots']['entrance'] = {'tile': [2, door_y], 'xy': list(iso(2.5, door_y + .5))}
    if ENT + '_closed' in parts:
        def left_wall(part_):                                 # the entrance is drawn along x; on the left wall (along y) the mirrored picture
            if 'flip' in part_ and ENT == 'entrance':
                return {'file': part_['flip']['file'], 'foot': [part_['w'] - part_['foot'][0], part_['foot'][1]]}
            return part_

        def half_of(part_, which):                            # the back / front half of a picture, mirrored like the whole one on the left wall
            h_ = part_.get(which)
            if not h_:
                return None
            if 'flip' in part_ and ENT == 'entrance':
                m_ = ImageOps.mirror(open_png(h_['file']))
                fp_ = APP_HOME / 'hakoniwa-office' / 'scaled' / f'halfmirror-{Path(h_["file"]).stem}.png'
                if not fp_.exists():
                    save_atomic(m_, fp_)
                return {'file': rel(fp_), 'foot': [part_['w'] - part_['foot'][0], part_['foot'][1]]}
            return {'file': h_['file'], 'foot': part_['foot']}
        names = ('closed', 'half', 'open')
        scl = {n_: scaled(left_wall(parts[f'{ENT}_{n_}']) if f'{ENT}_{n_}' in parts else left_wall(parts[ENT + '_closed']), kr) for n_ in names}
        gap_ = bottom_gap(left_wall(parts[ENT + '_closed'])) * kr * K if ENT == 'entrance' else 0
        # ★57-4 (A10): ONE frame with two leaves, DOOR_N times as wide (★27-3): the section's picture stretched along the left wall (x doubled, sheared
        # along the wall's slope so the verticals stay vertical and the top / bottom edges keep the wall's slant), about its foot (the footprint's middle).
        # Two pictures side by side looked like two doors with a post between them.
        r_ = -(TH / TW)                                       # the left wall's slope on screen (it runs down-left)

        def stretch(im, ft):
            if DOOR_N == 1:
                return im, ft
            w_, h_ = im.size
            fx_, fy_ = ft
            s_ = DOOR_N
            fy2_ = fy_ + abs(r_) * (s_ - 1) * (w_ - fx_)       # the foot moves down by the shear of the part right of it
            w2_, h2_ = s_ * w_, math.ceil(h_ + abs(r_) * (s_ - 1) * w_) + 1
            # inverse map: x = x' / s; y = y' - fy2 + fy - r (s - 1) (x - fx)
            a_, d_ = 1 / s_, -r_ * (s_ - 1) / s_
            f_ = -fy2_ + fy_ + r_ * (s_ - 1) * fx_
            return im.transform((w2_, h2_), Image.AFFINE, (a_, 0, 0, d_, 1, f_), resample=Image.NEAREST), (s_ * fx_, fy2_)
        at = iso(0, door_y + DOOR_W / 2) if ENT == 'entrance' else iso(0.05, door_y + DOOR_W / 2 - .5)
        at = (at[0], at[1] + gap_)                            # where the section picture's bottom was (its foot lies (h - fy) above)
        pics_ = {}
        for n_ in names:
            im_, ft_ = scl[n_]
            pics_[n_] = (stretch(im_, ft_), (at[0], at[1] - (im_.height - ft_[1])))
        lft_ = min(fs_[0] - p_[1][0] for p_, fs_ in pics_.values())
        top_ = min(fs_[1] - p_[1][1] for p_, fs_ in pics_.values())
        rgt_ = max(fs_[0] - p_[1][0] + p_[0].width for p_, fs_ in pics_.values())
        bot_ = max(fs_[1] - p_[1][1] + p_[0].height for p_, fs_ in pics_.values())
        cw, ch = math.ceil(rgt_ - lft_) + 1, math.ceil(bot_ - top_) + 1

        def canvas_of(im, ft):
            canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            im2_, ft2_ = stretch(im, ft)
            fs_ = (at[0], at[1] - (im.height - ft[1]))
            canvas.alpha_composite(im2_, (max(0, round(fs_[0] - ft2_[0] - lft_)), max(0, round(fs_[1] - ft2_[1] - top_))))
            return rel(write_png(out_dir, 'part-door', canvas))
        files = [canvas_of(*scl[n_]) for n_ in names]
        rect = [round(lft_, 1), round(top_, 1), cw, ch]
        nop_ = DOOR_N * (DOOR_SEG - 1)                        # the opening: the first 2 of 3 cells, stretched (4 of 6); the post: the rest
        open_ = [[0, door_y + j_] for j_ in range(nop_)]
        piers_ = [[0, door_y + j_] for j_ in range(nop_, DOOR_W)]
        out['door'] = {'tile': [0, door_y], 'spot': out['spots']['entrance']['xy'], 'rect': rect, 'closed': files[0], 'half': files[1],
                       'open': files[2], 'depth': 0 + door_y + 1, 'width': DOOR_W, 'leaves': DOOR_N,
                       'open_cells': open_, 'pier': piers_[-1], 'piers': piers_}
        for which in ('back', 'front'):                       # the leaves in front of / behind the people walking through (cut in the middle of the opening)
            if all(which in parts[f'{ENT}_{n_}'] for n_ in names if f'{ENT}_{n_}' in parts):
                out['door'][which] = {n_: canvas_of(*scaled(half_of(parts[f'{ENT}_{n_}'], which), kr)) for n_ in names if f'{ENT}_{n_}' in parts}
    # ★42 (review r22): no reception desk by the entrance any more (a small desk without a label between the entrance and the approval desk)
    names = {'approval': '승인 데스크', 'counter': '제출 창구', 'lounge': '대기실'}
    spots = {}
    heads = {}
    def card_spot(rect_, cw_, extra=(), size=None, step=3):
        """★16-2: the approval card (CW_ x CH_, bottom middle at the point) just above the approval desk: the tail from the card's bottom to the desk's top is
        at most TAIL_MAX px long. It may lie over an island's floor, a partition or an outer wall, but over no person / desk / window desk / lamp
        (`extra`), and wholly inside the picture's drawn area (not in the sky above the walls). Nearest first. None: no room."""
        CW_, CH_ = size or (CARD_W, CARD_H)
        alpha_ = bg.getchannel('A')

        def inside_bg(cx_, cy_):
            for gx_ in range(0, int(CW_) + 1, 8):
                for gy_ in range(0, int(CH_) + 1, 6):
                    for px_, py_ in ((round(cx_ - CW_ / 2 + gx_), round(cy_ - CH_ + gy_)), (int(cx_ - CW_ / 2 + gx_), int(cy_ - CH_ + gy_))):   # ★A9: rounded and cut (the check's way)
                        if not (0 <= px_ < alpha_.width and 0 <= py_ < alpha_.height) or alpha_.getpixel((px_, py_)) == 0:
                            return False
            return True
        top_ = rect_[1]
        cands_ = []
        for dx_ in [0] + [q_ * sg_ for q_ in range(4, 241, 4) for sg_ in (1, -1)]:      # ★A3: right above the desk first, then as far to either side as the tail may lean
            for tail_ in range(8, TAIL_MAX - 1, step):               # the tail's length: the nearest first (★A9: step 1 = the fine search, last resort)
                cands_.append((rect_[0] + cw_ / 2 + dx_, top_ - tail_))
        for cx_, cy_ in cands_:
            cx_ = min(max(cx_, CW_ / 2 + 6), width - CW_ / 2 - 6)
            box_ = (cx_ - CW_ / 2, cy_ - CH_, cx_ + CW_ / 2, cy_)
            if cy_ - CH_ >= 0 and not any(                           # ★A9: the cheap overlap test before the alpha samples
                    min(box_[2], e_[2]) - max(box_[0], e_[0]) > 0 and min(box_[3], e_[3]) - max(box_[1], e_[1]) > 0 for e_ in extra) and inside_bg(cx_, cy_):
                return [round(cx_, 1), round(cy_, 1)]
        return None

    def card_least(rect_, cw_, extra, must=(), size=None):
        """★A9: no clear place: the place (clear of `must`, on the drawn picture) that hides the fewest of `extra`; nearest first among equals. None: none."""
        CW_, CH_ = size or CARD_SMALL
        alpha_ = bg.getchannel('A')
        hit_ = lambda b_, e_: min(b_[2], e_[2]) - max(b_[0], e_[0]) > 0 and min(b_[3], e_[3]) - max(b_[1], e_[1]) > 0
        best_ = None
        for dx_ in [0] + [q_ * sg_ for q_ in range(4, 241, 4) for sg_ in (1, -1)]:
            for tail_ in range(8, TAIL_MAX - 1, 3):
                cx_ = min(max(rect_[0] + cw_ / 2 + dx_, CW_ / 2 + 6), width - CW_ / 2 - 6)
                cy_ = rect_[1] - tail_
                box_ = (cx_ - CW_ / 2, cy_ - CH_, cx_ + CW_ / 2, cy_)
                if cy_ - CH_ < 0 or any(hit_(box_, e_) for e_ in must):
                    continue
                n_ = sum(1 for e_ in extra if hit_(box_, e_))
                if best_ is not None and n_ >= best_[0]:
                    continue
                if all(0 <= round(cx_ - CW_ / 2 + gx_) < alpha_.width and 0 <= round(cy_ - CH_ + gy_) < alpha_.height
                       and alpha_.getpixel((round(cx_ - CW_ / 2 + gx_), round(cy_ - CH_ + gy_))) != 0
                       for gx_ in range(0, int(CW_) + 1, 8) for gy_ in range(0, int(CH_) + 1, 6)):
                    best_ = (n_, [round(cx_, 1), round(cy_, 1)])
                    if n_ == 0:
                        return best_[1]
        return best_[1] if best_ else None

    out['windows'] = {}
    win_geom, block_x_w = {}, {}                                  # ★26-4: the turned windows: (the line's x, the head's y, the line's step along y); the overflow block
    for n, kind in enumerate(('approval', 'counter', 'lounge')):
        px = places_x + n * (place_w + 2)
        xc = px + place_w // 2
        if kind == 'lounge':
            # ★26-2: the lounge is only a frame (rug + sitting points): no sofa, no armchairs, no low table
            spots[kind] = []
            if not (has_status and n_idle_ == 0):                # ★57-3 (A10): nobody waits: no 「控室」 label and no lounge range (the points stay for the mod)
                out['zones'].append({'key': kind, 'title': names[kind], 'label': list(iso(lx0 + lounge_w / 2, lobby_y + 2, 100))})   # ★50-5 (A9): over the lounge itself
            continue
        fw_ = [parts.get(f'win_{kind}_front_empty'), parts.get(f'win_{kind}_front_full')]
        if FRONT_WINDOWS and all(fw_) and all('flip' in q_ for q_ in fw_):
            # ★26-4 (A9, plan B): the window at the lobby's back row, in front of the left column's rooms: the mirrored "front" picture (its long side
            # along x); the clerk sits on the rooms' side (row y0) and faces the entrance's side (+y); the line stands in front of the desk (+y), one per
            # cell, facing the desk. The lobby keeps its depth (★50-4).
            x0_w = WIN_X0 + n * (4 + WIN_GAP)
            y0_w = lobby_y
            xc = x0_w + 2
            wcells = [(x0_w + a_, y0_w + b_) for a_, b_ in fw_[0]['flip']['footprint']]
            add(f'window:{kind}', 'window', wcells, required=True)
            ims = [scaled({'file': q_['flip']['file'], 'foot': q_['flip']['anchor']}, S) for q_ in fw_]
            at_ = iso(x0_w + .5, y0_w + .5)
            lft_ = min(at_[0] - ft_[0] for im_, ft_ in ims)
            top_ = min(at_[1] - ft_[1] for im_, ft_ in ims)
            cw_ = math.ceil(max(at_[0] - ft_[0] + im_.width for im_, ft_ in ims) - lft_)
            ch_ = math.ceil(max(at_[1] - ft_[1] + im_.height for im_, ft_ in ims) - top_)
            rect_ = [round(lft_, 1), round(top_, 1), cw_, ch_]
            files_ = []
            for im_, ft_ in ims:
                cv_ = Image.new('RGBA', (cw_, ch_), (0, 0, 0, 0))
                cv_.alpha_composite(im_, (round(at_[0] - ft_[0] - lft_), round(at_[1] - ft_[1] - top_)))
                files_.append(rel(write_png(out_dir, f'win-{kind}', cv_)))
            staff_ = {}
            sx_, sy_ = iso(xc + .5, y0_w + .5)
            nc_ = [parts.get(f'win_{kind}_front_nochair_empty'), parts.get(f'win_{kind}_front_nochair_full')]
            if all(nc_) and all('flip' in q_ for q_ in nc_):         # the pictures without the clerk's chair: C draws the clerk (pose `staff_sit`) on them
                for key_, q_ in zip(('empty', 'full'), nc_):
                    im_, ft_ = scaled({'file': q_['flip']['file'], 'foot': q_['flip']['anchor']}, S)
                    cv_ = Image.new('RGBA', (cw_, ch_), (0, 0, 0, 0))
                    cv_.alpha_composite(im_, (round(at_[0] - ft_[0] - lft_), round(at_[1] - ft_[1] - top_)))
                    staff_[key_] = rel(write_png(out_dir, f'win-{kind}-nochair', cv_))
                an_ = pack.get('people_anchor') or {}
                if an_.get('staff_sit') and an_.get('stand'):
                    # ★52-4 (A10): the clerk's chair at the middle of the desk's long side (x0+2 of its 4 cells), just behind the desk (STAFF_BACK cells
                    # into its 2 rows from the rooms' side): that point -> the person canvas's bottom centre (the mod's `xy`) with the pose's anchor
                    # (people_anchor.staff_sit, mirrored for the flipped picture), as for the seats' foot_xy.
                    a_ = np.asarray(Image.open(APP_HOME / staff_['empty']).convert('RGBA'))[..., 3] > 128      # the desk's middle along x: the centre
                    yy_, xx_ = np.nonzero(a_)                                                               # of its picture, in cells (iso inverted)
                    bx_, by_ = lft_ + (xx_.min() + xx_.max()) / 2, top_ + (yy_.min() + yy_.max()) / 2
                    o0_, e1_, e2_ = iso(0, 0), iso(1, 0), iso(0, 1)
                    e1_, e2_ = (e1_[0] - o0_[0], e1_[1] - o0_[1]), (e2_[0] - o0_[0], e2_[1] - o0_[1])
                    gx_ = ((bx_ - o0_[0]) * e2_[1] - (by_ - o0_[1]) * e2_[0]) / (e1_[0] * e2_[1] - e1_[1] * e2_[0])
                    gy_ = ((by_ - o0_[1]) * e1_[0] - (bx_ - o0_[0]) * e1_[1]) / (e1_[0] * e2_[1] - e1_[1] * e2_[0])
                    cfx_, cfy_ = iso(gx_ - gy_ + y0_w + 1, y0_w + STAFF_BACK)     # the picture's height lifts its centre by -d in x and y alike: the
                                                                                  # ground's middle along x is gx - (gy - (y0 + 1)) (the desk's 2 rows)
                    ax_, ay_ = 2 * an_['stand'][0] - an_['staff_sit'][0], an_['staff_sit'][1]
                    sx_, sy_ = cfx_ + (an_['stand'][0] - ax_) * PK * K, cfy_ + (an_['stand'][1] - ay_) * PK * K
            entry = {'empty': files_[0], 'full': files_[1], 'rect': rect_, 'tiles': [list(c_) for c_ in wcells], 'depth': (x0_w + 3) + (y0_w + 1),
                     'front': True, 'facing': 'dl', 'queue_dir': [0, 1],
                     'staff': dict(staff_, pose='staff_sit', tile=[xc, y0_w], xy=[round(sx_, 1), round(sy_, 1)], flip=True)}
            if kind == 'approval' and 'glow_alert' in parts:
                gs_ = round(cw_ * .2)
                entry['alert'] = {'file': part_file(out_dir, parts, 'glow_alert', gs_, gs_),
                                  'rect': [round(rect_[0] + cw_ * .7 - gs_ / 2, 1), round(rect_[1] + ch_ * .12 - gs_ / 2, 1), gs_, gs_]}
            if kind == 'approval':
                entry['card_at'] = [round(min(max(rect_[0] + cw_ / 2, CARD_W / 2 + 6), width - CARD_W / 2 - 6), 1), round(rect_[1] - 4, 1)]
            entry['chair_tile'] = [xc, y0_w]                           # the clerk's seat: the queue's head faces it along the y axis
            out['windows'][kind] = entry
            out.setdefault('lights', []).append({'island': kind, 'at': [round(v_, 1) for v_ in iso(x0_w + 2, y0_w + 1)],
                                                 'size': [round(5 * TW * K, 1), round(5 * TH * K, 1)]})
            win_geom[kind] = (xc, y0_w + 2, 1)
            heads[kind] = (xc, y0_w + 2)
            block_x_w[kind] = (x0_w - 1, 6)
            spots[kind] = []
            out['zones'].append({'key': kind, 'title': names[kind], 'label': list(iso(xc - 1.2, y0_w + 2.6, 84))})
            continue
        # a window: the desk seen from the inside (its empty chair is the viewer's seat) at the front edge;
        # people queue behind it (one per 2 cells) and face the viewer
        win = [parts.get(f'win_{kind}_empty'), parts.get(f'win_{kind}_full')]
        wcells = cells_rect(xc - 1, D_in - 2, 3, 2)
        add(f'window:{kind}', 'window', wcells, required=True)
        if all(win):
            ims = [scaled(w_, S) for w_ in win]
            cw_, ch_ = max(im_.width for im_, _ in ims), max(im_.height for im_, _ in ims)
            at_ = iso(xc + 2, D_in)
            rect_ = [round(at_[0] - cw_ / 2, 1), round(at_[1] - ch_, 1), cw_, ch_]
            files_ = []
            for im_, ft_ in ims:
                cv_ = Image.new('RGBA', (cw_, ch_), (0, 0, 0, 0))
                cv_.alpha_composite(im_, (round(cw_ / 2 - ft_[0]), ch_ - im_.height))
                files_.append(rel(write_png(out_dir, f'win-{kind}', cv_)))
            entry = {'empty': files_[0], 'full': files_[1], 'rect': rect_, 'tiles': [list(c_) for c_ in wcells],
                     'depth': (xc + 1) + (D_in - 1)}
            if kind == 'approval' and 'glow_alert' in parts:    # the warning light (top left of the turned desk): C blinks it
                gs_ = round(cw_ * .34)
                entry['alert'] = {'file': part_file(out_dir, parts, 'glow_alert', gs_, gs_),
                                  'rect': [round(rect_[0] + cw_ * .25 - gs_ / 2, 1), round(rect_[1] + ch_ * .13 - gs_ / 2, 1), gs_, gs_]}
            if kind == 'approval':                               # ★14: where C puts the approval card: just above the desk's picture, in its middle
                entry['card_at'] = [round(min(max(rect_[0] + cw_ / 2, CARD_W / 2 + 6), width - CARD_W / 2 - 6), 1), round(rect_[1] - 4, 1)]      # provisional: placed for real after the queues are known
            entry['chair_tile'] = [xc, D_in - 1]                  # the seat behind the desk: the queue's head faces it along the y axis
            out['windows'][kind] = entry
            wx_ = [c_[0] for c_ in wcells]
            wy_ = [c_[1] for c_ in wcells]
            out.setdefault('lights', []).append({'island': kind, 'at': [round(v_, 1) for v_ in iso((min(wx_) + max(wx_)) / 2 + .5, (min(wy_) + max(wy_)) / 2 + .5)],
                                                 'size': [round(5 * TW * K, 1), round(5 * TH * K, 1)]})
        heads[kind] = (xc, D_in - 4)
        spots[kind] = []
        out['zones'].append({'key': kind, 'title': names[kind], 'label': list(iso(xc + .5, D_in - .6, 84))})
    # ★25-2: the floor in front of the board (the two cells next to its wall, a cell more at each end) takes no furniture, equipment, table or chair
    board_keep = set()
    if board_span:
        for a_ in range(board_span[0] - 1, board_span[1] + 2):
            for d_ in (1, 2):
                board_keep.add((a_, d_) if board_span[4] == 'x' else (d_, a_))
    out['board_keep'] = [list(c_) for c_ in sorted(board_keep)]
    # ★55: every fixed thing stands with its back against an outer wall (x = 0: the left wall with the entrance; y = 0: the back wall with the windows and
    # the board) or a room's partition; nothing alone in the open lobby or the middle aisle. A wall run: the cells along an outer wall that are lobby floor
    # (outside every room's box and its wall ring, not the middle aisle, not the entrance's rows, not in front of the board's face: a tall machine there
    # would hide its text). The drinks row (the vending machine 2 x 2, the water server, the coffee machine, a free cell, the plant) takes the first place
    # that holds it: along the left wall from the rooms' corner towards the entrance, else along the back wall; only when neither has room (the board on the
    # left wall and both columns full), the old place at the right column's front room (backs to its partition), with a warning.
    isl_box_ = [(I_['x'] - 1, I_['y'] - 1, I_['x'] + I_['w'], I_['y'] + I_['h']) for I_ in islands.values()]
    aisle_x0_ = max((I_['x'] + I_['w'] for I_ in islands.values() if I_.get('col', 0) == 0), default=None)
    aisle_x1_ = min((I_['x'] for I_ in islands.values() if I_.get('col', 0) == 1), default=None)
    rooms_y1_ = max((I_['y'] + I_['h'] for I_ in islands.values()), default=0)

    def lobby_cell(c_):
        return (inner(*c_) and not any(b_[0] <= c_[0] <= b_[2] and b_[1] <= c_[1] <= b_[3] for b_ in isl_box_)
                and not (aisle_x0_ is not None and aisle_x1_ is not None and aisle_x0_ - 1 <= c_[0] <= aisle_x1_ and c_[1] <= rooms_y1_))

    def under_board(axis_, u_):                                            # the wall coordinate u_ lies in front of the board (with a margin for a wide picture)
        return bool(board_span) and board_span[4] == axis_ and board_span[0] - 3 <= u_ <= board_span[1] + 2
    door_rows_ = set(range(door_y - 1, door_y + DOOR_W + 1))             # ★57-1 (A10): one free row on each side of the door (the swing is 1 row: near() above)
    run_left = [y_ for y_ in range(1, D_in) if y_ not in door_rows_ and not under_board('y', y_) and all(lobby_cell((x_, y_)) for x_ in (1, 2, 3, 4))]
    # ★59: x == band_w - 1 is the rooms' right wall strip (not walkable for y < lobby_y); a machine there gets a stand on the wall
    run_back = [x_ for x_ in range(1, W) if x_ != band_w - 1 and not under_board('x', x_) and all(lobby_cell((x_, y_)) for y_ in (1, 2, 3, 4))]
    rl_, rb_ = set(run_left), set(run_back)
    out['wall_runs'] = {'left': run_left, 'back': run_back}                 # (for the tests / a look at why a machine went where it went)
    left_plans, back_plans, corner_plans = [], [], []                       # [(items [(oid, part, anchor, flipped)], plant cell or None, reserved cells)]
    for y0_ in run_left:                                                    # the left wall: facing +x (★58: native equip art faces +x), from the back towards the door
        if all(y0_ + i_ in rl_ for i_ in range(4)):
            pl_ = None                                                      # (the plant: after the copier, at the row's open end; see below)
            left_plans.append(([('equip:vending', 'equip_vending', (1, y0_ + 1), True), ('equip:water', 'equip_water', (1, y0_ + 2), True),
                                ('equip:coffee', 'equip_coffee', (1, y0_ + 3), True)], pl_,
                               {(x_, y0_ + i_) for x_ in (1, 2, 3, 4) for i_ in range(6)}))
    for xe_ in sorted(run_back, reverse=True):                              # the back wall: facing +y (★58: flip equip art faces +y), from the right towards the aisle
        if all(xe_ - i_ in rb_ for i_ in range(4)):
            pl_ = (xe_ - 5, 1) if xe_ - 4 in rb_ and xe_ - 5 in rb_ else None
            # ★60-3 (A12): as on the left wall, the vending machine (2 x 2) at the far end and the small ones nearer the viewer (larger x): at the near end
            # it hid the water server and the coffee machine standing beside it on the far side
            back_plans.append(([('equip:vending', 'equip_vending', (xe_ - 2, 1), False), ('equip:water', 'equip_water', (xe_ - 1, 1), False),
                                ('equip:coffee', 'equip_coffee', (xe_, 1), False)], pl_,
                               {(xe_ - i_, y_) for y_ in (1, 2, 3, 4) for i_ in range(6 if pl_ else 4)}))
    corner_y = max((I_['y'] + I_['h'] for I_ in islands.values() if I_.get('col') == 1), default=1)
    corner_x = W - 3 if corner_y < lobby_y else W - 2                     # (above the lobby the column x = band_w - 1 is the rooms' right outer wall: not walkable)
    for dy0_ in (0, 1, 2):                                                  # the last resort: backs to the right column's front room's partition
        y_r = corner_y + dy0_
        corner_plans.append(([('equip:vending', 'equip_vending', (corner_x, y_r), False), ('equip:water', 'equip_water', (corner_x - 2, y_r), False),
                              ('equip:coffee', 'equip_coffee', (corner_x - 3, y_r), False)], (corner_x - 5, y_r),
                             {(x_, y_) for x_ in range(corner_x - 5, W - 1) for y_ in range(y_r, y_r + 3)}))
    # ★59: windows stay on the r25 front row; if the left-wall drinks would sit between the door and the rooms (and block that walk), prefer the back wall
    # ★63 (office-polish): withdraws ★59's "prefer the back wall" and ★55's search for a free run: the one fixed row (EQUIP_ROW) on the left wall, from the
    # door's free row towards the rooms, comes first and is reserved before the lounge's places. The old plans stay only as a fallback (with a warning).
    y_f, fixed_items_ = door_y - 3, []                                 # (door_y - 2 and - 1: the entrance's swing, kept free by forbid)
    for oid_f, part_f, n_f in EQUIP_ROW:
        fixed_items_.append((oid_f, part_f, (1, y_f), True))              # (the vending machine's cell is its row nearer the door; it also takes y - 1)
        y_f -= n_f
    fixed_res_ = {(x_, y_) for x_ in (1, 2, 3, 4) for y_ in range(y_f, door_y - 2)}
    out['equip_row'] = {'from_door': [door_y - y_ for *_, (_x, y_), _fl in fixed_items_], 'door_y': door_y}
    drink_plans = [(fixed_items_, (1, y_f), fixed_res_)] + left_plans + back_plans + corner_plans
    if L86:
        drink_plans = []                                                # ★88-1: no drinks row in the lobby (see EQUIP_BACK_VEND and the rooms' side machines)
    n_wall_plans = len(drink_plans) - len(corner_plans)
    corner_res = set(drink_plans[0][2]) if drink_plans else set()
    # decor in the lobby: the bin at the left wall by the entrance (★55: the plants of the open lobby floor are gone; plants stand at walls and room corners)
    for oid, kind, part_, x_, y_, w_, h_, k_ in (('trash:lobby-a', 'trash', 'trash', 1, D_in - 1, 1, 1, None),):
        if (x_, y_) in board_keep or (x_, y_) in corner_res or L86:      # (★91 with L86: the bin goes to the end of the office things' row, below)
            continue
        place(oid, kind, part_, x_, y_, w_, h_, k_)
    wall_objects = []                                      # hung on the left wall: placed by the wall's cells (rows), never twice on the same
    wall_taken = set()

    def hang(oid, kind, part_name, row, z):
        cells_ = {row, row + 1}
        if part_name not in parts or cells_ & wall_taken or row < 0 or row + 1 >= D:
            return
        wall_taken.update(cells_)
        im_, ft_ = scaled(parts[part_name], kr)
        paste_part(bg, im_, ft_, iso(0, row + .4, z))
        wall_objects.append({'id': oid, 'kind': kind, 'wall': 'left', 'rows': sorted(cells_)})
    hang('picture:entrance', 'picture', 'picture', door_row0 - 2, 46)    # beside the entrance on its plain pieces (★57-4: the wide door's own rows showed it through the opening)
    out['wall_objects'] = wall_objects

    # ---- the standing places. Each is a free cell, and the pictures of the people standing on them (their visible boxes)
    # must not overlap: queues behind the windows (head right behind the desk's middle), armchairs and standing places in the lounge.
    # ★50-5 (A9): lx0 / lounge_w were set with the lobby's size (the right column, against the right outer wall)
    block_x = {'approval': places_x, 'counter': places_x + place_w + 2, 'lounge': lx0}
    block_w = {'approval': place_w, 'counter': place_w, 'lounge': lounge_w}
    for kind_, (bx_, bw_) in block_x_w.items():                # ★26-4: the turned windows' overflow cells (beside and in front of their line)
        block_x[kind_], block_w[kind_] = bx_, bw_
    block_x['lounge'], block_w['lounge'] = LB_X0, max(1, lb_x1_ - LB_X0 + 1)      # ★83-1: the band beside the drinks
    heads['lounge'] = ((LB_X0 + lb_x1_) // 2, (lb_y0_ + lb_y1_) // 2)
    scale_ = PK * K

    def pbox(poses, fallback):
        """Visible box of the pictures (offsets from the foot, final pixels): the union over the poses of the first person."""
        for a_ in [x for x in agents if person_cache(x['id'])][:1]:
            files = person_cache(a_['id'])
            boxes = []
            for pose in poses:
                v = files.get(pose)
                v = v[0] if isinstance(v, (list, tuple)) and v else v
                if isinstance(v, str) and v.endswith('.png'):
                    if view:                                   # measure the picture as it is shown (the resize blurs the edge a little)
                        im = open_png(person_file(out_dir, v, PK * person_k(K)))
                        f_ = K / person_k(K)                   # (made at the step, shown at K)
                    else:
                        im, f_ = open_png(v), scale_
                    bb = im.getchannel('A').getbbox()
                    if bb:
                        boxes.append(tuple(c_ * f_ for c_ in ((bb[0] - im.width / 2), (bb[1] - im.height), (bb[2] - im.width / 2), (bb[3] - im.height))))
            if boxes:
                return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
        return fallback
    box_stand = pbox(('front_wait', 'front_raise', 'front_give', 'stand'), (-29 * K, -90 * K, 29 * K, 0))
    box_arm = pbox(('sofa', 'doze'), (-36 * K, -84 * K, 36 * K, 0))
    box_seat = pbox(('type_pc',), None) or pbox(('type',), (-33 * K, -84 * K, 33 * K, 0))
    taken = []
    for dsk_ in out['desks'].values():                 # people at their desks never have a standing place on them
        taken.append((dsk_['seat'][0] + box_seat[0], dsk_['seat'][1] + box_seat[1], dsk_['seat'][0] + box_seat[2], dsk_['seat'][1] + box_seat[3]))
    def visible_rect(it_):                              # the opaque part of a placed picture, in scene pixels
        bb_ = it_['im'].getchannel('A').point(lambda v_: 255 if v_ > 40 else 0).getbbox()
        if not bb_ or not it_.get('at'):
            return None
        ox_, oy_ = it_['at'][0] - it_['foot'][0], it_['at'][1] - it_['foot'][1]
        return (ox_ + bb_[0], oy_ + bb_[1], ox_ + bb_[2], oy_ + bb_[3])
    for it_ in registry:                                # the sofa's picture: nobody stands or sits where it would hide them
        if it_['kind'] == 'sofa' and it_['im'] is not None:
            r0_ = visible_rect(it_)
            if r0_:
                taken.append(r0_)
    used = set()
    taken_dep = {}                                            # ★83-1: taken rect -> the x + y of the person's cell (only the break room's)
    spawn = {(2, door_y), (3, door_y), (2, door_y + 1)}
    refresh_res = set(corner_res)                             # ★A3 / ★42: the refresh corner (its fixed place): kept free of the lounge's standing places
    used |= refresh_res
    clear_n = {}

    def rect_at(cell, box):
        x_, y_ = iso(cell[0] + .5, cell[1] + .5)
        return (x_ + box[0], y_ + box[1], x_ + box[2], y_ + box[3])

    def free_cell(cell):
        return cell not in used and cell not in occ and cell not in spawn and inner(*cell)

    def take(kind, cells_, box, want):
        for cell in cells_:
            if len(spots[kind]) >= want:
                break
            if not free_cell(cell):
                continue
            r_ = rect_at(cell, box)
            if all(min(r_[2], t_[2]) - max(r_[0], t_[0]) <= 1 or min(r_[3], t_[3]) - max(r_[1], t_[1]) <= 1 for t_ in taken):
                spots[kind].append(cell)
                used.add(cell)
                taken.append(r_)
                if kind == 'lounge':
                    taken_dep[r_] = cell[0] + cell[1]           # ★83-1: a sitter in the break room: drawn after any thing behind it (furn)

    def facing_to(cell, target):
        """The nearest of the 4 diagonal directions (screen) from a cell towards another cell: +x = dr, -x = ul, +y = dl, -y = ur."""
        dx, dy = target[0] - cell[0], target[1] - cell[1]
        if abs(dx) > abs(dy):
            return 'dr' if dx > 0 else 'ul'
        return 'dl' if dy >= 0 else 'ur'

    def block_cells(kind):
        hx, hy = heads[kind]
        if kind == 'lounge':                                  # ★83-1: the band(s) of the break room
            return sorted((abs(x_ - hx) + abs(y_ - hy), x_, y_) for x0_, x1_ in lb_spans_ for x_ in range(x0_, x1_ + 1) for y_ in range(lb_y0_, lb_y1_ + 1))
        return sorted(((abs(x_ - hx) + abs(y_ - hy), x_, y_) for x_ in range(block_x[kind], block_x[kind] + block_w[kind])
                       for y_ in range(lobby_y, D_in)))

    qline = {}
    for kind in ('approval', 'counter'):                # one straight line from the desk's middle, 1 cell apart, away from the desk;
        xc_ = block_x[kind] + place_w // 2              # the head is one free cell behind the desk, facing the chair ("dl": down-left)
        want_ = min(shared, QLEN)
        for r_ in range(want_):
            cell = (win_geom[kind][0], win_geom[kind][1] + win_geom[kind][2] * r_) if kind in win_geom else (xc_, D_in - 4 - r_)   # ★26-4: the turned windows' line runs to +y
            if not free_cell(cell):
                break
            spots[kind].append(cell)
            used.add(cell)
            taken.append(rect_at(cell, box_stand))
        qline[kind] = len(spots[kind])
        if qline[kind] < want_:
            warnings.append(f'{kind}: the line has room for {qline[kind]} of {want_} people')
    spots['lounge'] = []
    # ★26-2: the lounge is a frame (a rug and sitting points) only; the chair comes with the person's sitting picture (like a work seat). The points lie
    # on a grid (3 cells along x, 3 along y), at least as many as the people who wait.
    want_arm = min(shared, need)
    seat_total = want_arm + (1 if want_arm > 2 else 0)
    arm_cells, group_of = [], {}
    l_cols = max(1, (lounge_w - 2) // LSTEP_X)
    # ★65-1 (office-polish): groups of 4 armchairs that face each other (the two on the left turn right, the two on the right turn left, a gap between the
    # pairs), one screen row per group (the seats share x + y: their pictures never cover each other), groups side by side along x, then one row nearer.
    # The old grid follows as spare points, so the number of seats is never smaller than before.
    lounge_facing, lounge_mids = {}, []
    # ★83-1: the sitting points fill the break-room band (beside the drinks, in front of the rooms' partition), back rows first, each row of the
    # screen from left to right; a point whose picture would cover another's is skipped (take). The left half turns right, the right half left.
    for x0_, x1_ in lb_spans_:                                          # (the band beside the drinks first; a crowd's second band after it)
        lb_mid_ = (x0_ - lb_y1_ + x1_ - lb_y0_) / 2                     # the band's middle screen column (x - y)
        for _, u_, x_, y_ in sorted((x_ + y_, x_ - y_, x_, y_) for x_ in range(x0_, x1_ + 1) for y_ in range(lb_y0_, lb_y1_ + 1) if (x_ - y_) % 2 == 0):
            arm_cells.append((x_, y_))
            lounge_facing[(x_, y_)] = 'dr' if u_ < lb_mid_ else 'dl'
    n_taken0_ = len(taken)
    take('lounge', arm_cells, box_arm, min(want_arm, len(arm_cells)))
    n_taken1_ = len(taken)
    n_arm = len(spots['lounge'])
    g_seats_ = [c_ for c_ in spots['lounge'][:n_arm] if c_ in lounge_facing]
    lounge_label_ = None
    if g_seats_:                                                            # ★65-1: the lounge's name right in front of its groups (in the middle of them all, just below the front-most seat), not at the floor's edge
        pts_ = [iso(c_[0] + .5, c_[1] + .5) for c_ in g_seats_]
        lounge_label_ = [round((min(p_[0] for p_ in pts_) + max(p_[0] for p_ in pts_)) / 2, 1), round(max(p_[1] for p_ in pts_) + TH * K * .5, 1)]
    seat_set_ = set(spots['lounge'][:n_arm])
    in_lounge_ = lambda c_: lx0 <= c_[0] <= lx0 + lounge_w - 1 and lobby_y + 1 <= c_[1] <= D_in - 2
    lounge_mids = [m_ for m_ in lounge_mids if all(c_ in seat_set_ for c_ in m_['inner'])]   # (only between two who can sit there)
    for m_ in lounge_mids:
        m_['plants'] = [c_ for c_ in m_['plants'] if in_lounge_(c_) and free_cell(c_)]
        used.update(m_['plants'])                                      # (no standing point on them; freed just before they are placed)
    take('lounge', [(c_[1], c_[2]) for c_ in block_cells('lounge')], box_stand, shared)         # then standing places on the rug
    for kind in ('approval', 'counter', 'lounge'):
        clear_n[kind] = len(spots[kind])
        cap_ = shared if kind == 'lounge' else min(shared, QLEN)       # ★17-3: a line of 3-4 at a window; more people are told by the card ("承認待ち n件")
        if len(spots[kind]) < cap_:                  # the rest: the nearest free cells (the pictures may overlap there)
            for _, x_, y_ in block_cells(kind):
                if len(spots[kind]) >= cap_:
                    break
                if free_cell((x_, y_)):
                    spots[kind].append((x_, y_))
                    used.add((x_, y_))
        if len(spots[kind]) < cap_:
            warnings.append(f'{kind}: only {len(spots[kind])} of {cap_} standing places')
    out['layout_clear'] = clear_n
    # ★50-5 (A9): the lounge's extent is shown by a row of plants (the floor keeps the office colour, no furniture): along its aisle side (x = lx0 - 1, an
    # opening of 3 cells at the middle row of sitting points), every 2 cells. The rooms close it at the back, the outer walls / floor edge at the right and front.
    # ★52-2 (A10): a row of plants along a diagonal read as a stray line and one stood on a sitter's head. Now only the lounge's corners (the aisle side,
    # behind the sitting row and in front of the last row; the front right corner), none within 2 cells of a sitting / standing point nor just in front of
    # one (a plant 1-3 cells nearer the viewer on the same screen column hides the head). The 「控室」 label: on the rug's front edge (below).
    # ★55-3: no plants around the lounge any more: they stood in the open floor between the lounge and the windows, in the people's way. The lounge's
    # extent is told by its label; plants stand only at the walls, the partitions and the rooms' corners.
    lounge_frame = []
    out['lounge_frame'] = [list(c_) for c_ in lounge_frame if str(occ.get(c_, '')).startswith('plant:lounge-frame')]

    # ---- furniture and equipment (B's store_* / equip_*): along the walls and in corners; never on a path, a door's front, a queue or a standing place
    forbid = set()

    def near(cells_, rx=1, ry=1):
        for x_, y_ in cells_:
            for dx_ in range(-rx, rx + 1):
                for dy_ in range(-ry, ry + 1):
                    forbid.add((x_ + dx_, y_ + dy_))
    near([c_ for k_ in ('approval', 'counter', 'lounge') for c_ in spots[k_]])
    near(cells_rect(0, door_y - 1, 4, DOOR_W + 2), 1, 1)                      # the entrance and its swing
    for cells_ in room_cells.values():                                        # the islands' openings: the cells and 2 cells before and behind them
        near(cells_, 2, 1)                                                    # ★30-2: the openings are in the side walls: 2 cells before and behind along x
    for d_ in island_doors:
        near([tuple(c_) for c_ in d_['tiles']], 2, 1)
    for kind_ in ('approval', 'counter'):                                     # each queue's column and the desk's front
        xq_ = block_x[kind_] + place_w // 2
        near([(xq_, y_) for y_ in range(lobby_y, D_in)], 1, 0)
    near([c_ for w_ in out['windows'].values() for c_ in map(tuple, w_['tiles'])], 1, 1)
    ap_w_ = out['windows'].get('approval')                    # ★A3: no furniture where the approval card (CARD_W x CARD_H, above the desk) is to hang
    card_zone = set()                                         # ★55: except the machines against the left wall (the card hangs over that wall when the desk is near it)
    if ap_w_ and not L86:
        cx0_, cy0_ = ap_w_['rect'][0] + ap_w_['rect'][2] / 2, ap_w_['rect'][1] - 8
        for y_ in range(1, D):
            for x_ in range(1, W):
                fx_, fy_ = iso(x_ + .5, y_ + .5)
                if abs(fx_ - cx0_) <= CARD_W / 2 + 6 and cy0_ - CARD_H - 4 <= fy_ - 6 <= cy0_ + 30:
                    card_zone.add((x_, y_))
    targets = [c_ for k_ in ('approval', 'counter', 'lounge') for c_ in spots[k_]] + [c_[0] for c_ in room_cells.values()] + [(2, door_y)]

    def reach_seen():
        seen_ = {(2, door_y)}
        todo_ = [(2, door_y)]
        while todo_:
            x_, y_ = todo_.pop()
            for dx_, dy_ in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c_ = (x_ + dx_, y_ + dy_)
                if c_ not in seen_ and 0 < c_[0] < W and 0 < c_[1] < D and floor_ok(*c_) and c_ not in occ:
                    seen_.add(c_)
                    todo_.append(c_)
        return seen_

    def reachable():                                                          # every place and every island opening can still be reached from the entrance
        seen_ = reach_seen()
        return all(c_ in seen_ or any((c_[0] + dx_, c_[1] + dy_) in seen_ for dx_, dy_ in ((1, 0), (-1, 0), (0, 1), (0, -1))) for c_ in targets)   # an armchair is furniture: its front must be reachable
    furniture_log = []

    def wall_at(c_):                                                          # ★55: an outer wall (x = 0 / y = 0) or a room's partition
        return c_[0] <= 0 or c_[1] <= 0 or str(occ.get(tuple(c_), '')).startswith(('partition:', 'doorway:'))

    furn_why = {}                                                             # ★63: why furn() last refused a thing (for the tests and a look at a scene)
    out['furn_why'] = furn_why

    def back_gap(im_, ft_, at_, flipped):
        """★63: how far (in cells) the picture's back stands from the outer wall's face. Facing +x (back on the left wall x = 0) the leftmost opaque column
        is the back corner's vertical edge and its lowest pixel the corner on the floor; facing +y (the back wall y = 0) the rightmost one. None: no picture."""
        a_ = np.asarray(im_.getchannel('A')) > 40
        ys_, xs_ = np.nonzero(a_)
        if not len(xs_):
            return None
        col_ = xs_.min() if flipped else xs_.max()
        sel_ = np.abs(xs_ - col_) <= 1
        px_ = at_[0] - ft_[0] + col_ + (0 if flipped else 1)
        py_ = at_[1] - ft_[1] + ys_[sel_].max() + 1
        gx_, gy_ = iso.inv(px_, py_)
        return float(gx_ if flipped else gy_)

    back_part_ids = set()                                     # ★83-2: things with their back on a partition's outer face

    def partition_face(cells_, bx_, by_, im_, ft_, at_, flipped):
        """★75-2: where (gy when facing +y, gx when facing +x) the outer face of the partition behind a thing meets the floor, at the screen column of
        the thing's back corner: the lowest opaque pixel of that partition piece's picture in that column. None: no partition piece there."""
        behind_ = {(c_[0] - bx_, c_[1] - by_) for c_ in cells_} - set(cells_)
        a_ = np.asarray(im_.getchannel('A')) > 40
        xs_ = np.nonzero(a_.any(axis=0))[0]
        if not len(xs_):
            return None
        px_ = at_[0] - ft_[0] + (xs_.min() if flipped else xs_.max() + 1)
        for r_ in registry:
            if r_['kind'] != 'partition' or r_.get('im') is None or not behind_ & set(r_['cells']):
                continue
            col_ = int(round(px_ - (r_['at'][0] - r_['foot'][0]))) - (0 if flipped else 1)
            if not 0 <= col_ < r_['im'].width:
                continue
            pa_ = np.asarray(r_['im'].getchannel('A'))[:, col_] > 40
            if not pa_.any():
                continue
            py_ = r_['at'][1] - r_['foot'][1] + np.nonzero(pa_)[0].max() + 1
            gx_, gy_ = iso.inv(px_, py_)
            return float(gx_ if flipped else gy_)
        return None

    def furn(oid, kind, part_name, cell, flipped, leds=False, near_board=False, clear_of=None, back=True, over_card=False, hide_ok=False):
        """B's part on its footprint from `cell`. ★58 `flipped`: face +x / back on the left wall (False = face +y / back on the back wall). Native equip
        art faces +x (lower-right); flip art faces +y (lower-left) — isometric 90° = a left-right mirror. ★42: EQUIP_FOOT machines take those cells
        (swapped when facing +x) and stand in their middle; `near_board`: may stand in front of the board; `clear_of(rect)`: False when the picture
        would cover something. ★55 `back`: cells behind it (-x when facing +x, else -y) are an outer wall or a partition."""
        q_ = parts.get(part_name)
        if not q_:
            return False
        opts_ = [q_] + ([q_['flip']] if 'flip' in q_ else [])
        along_y_ = [o_ for o_ in opts_ if any(b_ for a_, b_ in o_['footprint'])]
        along_x_ = [o_ for o_ in opts_ if not any(b_ for a_, b_ in o_['footprint'])]
        # ★58: square machines / EQUIP_FOOT: pick art by facing (native=+x, flip=+y). Elongated parts without EQUIP_FOOT still match footprint axis.
        if EQUIP_FOOT.get(part_name) or len(q_['footprint']) <= 1:
            v_ = q_ if flipped else (q_['flip'] if 'flip' in q_ else q_)
        elif flipped:
            v_ = (along_y_ or [opts_[-1]])[0]
        else:
            v_ = (along_x_ or [opts_[0]])[0]
        fp_ = EQUIP_FOOT.get(part_name)
        if fp_:
            fp_ = [(b_, a_) for a_, b_ in fp_] if flipped else fp_
        cells_ = [(cell[0] + a_, cell[1] + b_) for a_, b_ in (fp_ or v_['footprint'])]
        if any(c_ in forbid or (c_ in card_zone and not over_card) or c_ in used or c_ in spawn or (c_ in board_keep and not near_board) or not inner(*c_) or c_ in occ or c_[0] < 1 or c_[1] < 1 for c_ in cells_):
            furn_why[oid] = 'cells ' + ' '.join(f'{c_}:' + ''.join(k_ for k_, b_ in (('f', c_ in forbid), ('c', c_ in card_zone and not over_card), ('u', c_ in used), ('s', c_ in spawn), ('b', c_ in board_keep and not near_board), ('i', not inner(*c_)), ('o', str(occ.get(c_, '')) if c_ in occ else '')) if b_) for c_ in cells_)
            return False
        bx_, by_ = (1, 0) if flipped else (0, 1)
        if back and not all((c_[0] - bx_, c_[1] - by_) in cells_ or wall_at((c_[0] - bx_, c_[1] - by_)) for c_ in cells_):
            furn_why[oid] = 'back'; return False
        im_, ft_ = scaled({'file': v_['file'], 'foot': v_['anchor']}, kr * FURN_SCALE.get(part_name, 1.0))        # ★20-1: real sizes against a person
        at_ = iso(sum(c_[0] for c_ in cells_) / len(cells_) + .5, sum(c_[1] for c_ in cells_) / len(cells_) + .5) if fp_ else iso(cell[0] + .5, cell[1] + .5)
        gap_ = None
        if back and all((c_[0] - bx_ <= 0) if flipped else (c_[1] - by_ <= 0) for c_ in cells_ if (c_[0] - bx_, c_[1] - by_) not in cells_):
            gap_ = back_gap(im_, ft_, at_, flipped)                            # ★63: the back stands on the outer wall's face (x = 0 / y = 0): no floor between
            if gap_ is not None and -2 < gap_ < 2.6:                          # (an empty margin cell at x / y = 0 + the picture's own transparent edge; ★69: -2, the isometric copier is deeper than its cell and stood into the wall)
                s0_, s1_ = iso(0, 0), (iso(gap_, 0) if flipped else iso(0, gap_))
                at_ = (round(at_[0] - (s1_[0] - s0_[0]), 1), round(at_[1] - (s1_[1] - s0_[1]), 1))
                gap_ = back_gap(im_, ft_, at_, flipped)
        elif back:                                                             # ★75-2: the back on a partition's outer face (back to back): no floor between
            g0_ = back_gap(im_, ft_, at_, flipped)
            face_ = partition_face(cells_, bx_, by_, im_, ft_, at_, flipped)
            if g0_ is not None and face_ is not None and -2 < g0_ - face_ < 2.6:
                d_ = g0_ - face_
                s0_, s1_ = iso(0, 0), (iso(d_, 0) if flipped else iso(0, d_))
                at_ = (round(at_[0] - (s1_[0] - s0_[0]), 1), round(at_[1] - (s1_[1] - s0_[1]), 1))
                gap_ = back_gap(im_, ft_, at_, flipped) - face_
                back_part_ids.add(oid)                                         # ★83-2: drawn after the partition pieces behind it (below)
        rect_ =(at_[0] - ft_[0], at_[1] - ft_[1], at_[0] - ft_[0] + im_.width, at_[1] - ft_[1] + im_.height)
        bb_ = im_.getchannel('A').point(lambda v2_: 255 if v2_ > 40 else 0).getbbox()
        vis_ = (rect_[0] + bb_[0], rect_[1] + bb_[1], rect_[0] + bb_[2], rect_[1] + bb_[3]) if bb_ else rect_
        dep_ = max(c_[0] + c_[1] for c_ in cells_)                             # ★83-1: a person in front of it (a larger x + y) is drawn over it, not hidden
        if not hide_ok and any(min(vis_[2], t_[2]) - max(vis_[0], t_[0]) > 1 and min(vis_[3], t_[3]) - max(vis_[1], t_[1]) > 1 for t_ in taken if not taken_dep.get(t_, -1) > dep_):
            furn_why[oid] = 'taken'; return False                                                       # its picture would hide somebody who stands or sits near
        if clear_of and not clear_of(vis_):
            furn_why[oid] = 'clear'; return False
        n_reg = len(registry)
        if not add(oid, kind, cells_, im_, ft_, at_):
            furn_why[oid] = 'add'; return False
        if not reachable():                                                    # it must not cut a way: take it back
            for c_ in cells_:
                occ.pop(c_, None)
            del registry[n_reg:]
            furn_why[oid] = 'reach'; return False
        info_ = {'id': oid, 'cells': cells_, 'part': part_name, 'front': [1, 0] if flipped else [0, 1],      # ★58: +x (native art) or +y (flip art)
                 'mirrored': v_ is not q_}                                                                   # True when the flip picture is used
        if gap_ is not None:
            info_['back_gap_px'] = round(gap_ * K * math.hypot(TW / 2, TH / 2), 2)        # ★63: back face to the wall's face, screen px along the floor (tests: <= 1)
        if leds and v_.get('leds'):
            info_['leds'] = [[round(at_[0] - ft_[0] + x_ * kr * K, 1), round(at_[1] - ft_[1] + y_ * kr * K, 1)] for x_, y_ in v_['leds']]
        furniture_log.append(info_)
        return True

    # ★42 / ★55: no drawn places (★20-2/3, ★25-3 and ★28-3 are withdrawn): every machine has a fixed place, its back against an outer wall or a partition.
    # The drinks row (see drink_plans above), the copier (an outer wall, else the outside of a room's front partition, back to back), one file cabinet
    # on the left wall.
    def plant_at(oid, c_, backed=True, over_card=False, art='plant', board_ok=False, k_pl=.3):
        art = art if art in parts else 'plant'                              # ★75-3: one of the plants (the old potted plant when that picture is missing)
        if c_ in forbid or (c_ in card_zone and not over_card) or c_ in used or c_ in spawn or c_ in occ or (c_ in board_keep and not board_ok) or not inner(*c_) or c_[0] < 1 or c_[1] < 1 or 'plant' not in parts:
            return False
        if backed and not any(wall_at((c_[0] + dx_, c_[1] + dy_)) for dx_, dy_ in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            return False                                                    # ★55: a plant stands at a wall, a partition or a room's corner
        n_reg = len(registry)
        if not place(oid, 'plant', art, c_[0], c_[1], 1, 1, k_pl):
            return False
        if not reachable():
            occ.pop(c_, None)
            del registry[n_reg:]
            return False
        furniture_log.append({'id': oid, 'cells': [c_], 'part': 'plant', **({'art': art} if art != 'plant' else {})})
        return True

    def take_back(n0_):                                                     # take the things placed since furniture_log[n0_] back
        for f_u in furniture_log[n0_:]:
            for c_u in f_u['cells']:
                occ.pop(tuple(c_u), None)
            registry[:] = [r_ for r_ in registry if r_['id'] != f_u['id']]
        del furniture_log[n0_:]
    used -= refresh_res                                                     # now the corner is built
    bd_ = out.get('board')

    def off_board(vis_):
        if not bd_ or not bd_.get('face'):
            return True
        quad_ = bd_['face']
        box_ = [(vis_[0], vis_[1]), (vis_[2], vis_[1]), (vis_[2], vis_[3]), (vis_[0], vis_[3])]
        for poly_ in (quad_, box_):                                         # the separating axis test of two convex shapes
            for i_ in range(len(poly_)):
                ex_, ey_ = poly_[(i_ + 1) % len(poly_)][0] - poly_[i_][0], poly_[(i_ + 1) % len(poly_)][1] - poly_[i_][1]
                nx_, ny_ = -ey_, ex_
                pa_ = [nx_ * p_[0] + ny_ * p_[1] for p_ in quad_]
                pb_ = [nx_ * p_[0] + ny_ * p_[1] for p_ in box_]
                if max(pa_) <= min(pb_) + 1e-6 or max(pb_) <= min(pa_) + 1e-6:
                    return True
        return False
    # the drinks row: the first plan that fits whole (the plant may stay out); ★50-6: the plant at the row's open end, a free cell between
    out['refresh_corner'] = None
    for n_p, (items_, pl_, _res) in enumerate(drink_plans):
        n0_ = len(furniture_log)
        if all(furn(oid_, 'equipment', part_n, anc_, fl_, clear_of=off_board, over_card=fl_) for oid_, part_n, anc_, fl_ in items_):
            if pl_:
                plant_at('plant:refresh', pl_, over_card=pl_[0] == 1)
            out['refresh_corner'] = list(items_[0][2]) if items_ else None
            if n_p > 0:                                                     # ★63: the fixed row did not fit (the tests count this)
                warnings.append('equip: the fixed row beside the entrance does not fit: a searched place is used')
            if n_p >= n_wall_plans:
                warnings.append('refresh: no outer wall run in the lobby (the board covers it): the drinks row stands at a room front partition')
            break
        take_back(n0_)
    if drink_plans and not out['refresh_corner']:                           # ★57-3 (A12): a lobby too shallow for the drinks row must show in the tests
        warnings.append('refresh: no plan of the drinks row fits')
    # the copier (the multifunction printer): ★55-2 its back against an outer wall (the left wall's run, a free cell away from the drinks row, else the
    # back wall's run), else against the outside of a room's front partition (back to back, facing the lobby), never in a doorway's front or the aisle
    drink_cells_ = {tuple(c_) for f_ in furniture_log if f_['part'] != 'plant' for c_ in f_['cells']}
    cop_ = [((1, y_), True) for y_ in run_left] + [((x_, 1), False) for x_ in sorted(run_back, reverse=True)]
    for I_ in sorted(islands.values(), key=lambda I_: (I_.get('col', 0), -I_['y'])):
        yf_ = I_['y'] + I_['h']                                             # ★57-1 (A10): the row right in front of the front partition (y + h - 1):
        xs_ = list(range(I_['x'], I_['x'] + I_['w']))                       # one row further (as before) never had its back on the partition
        xs_ = xs_ if I_.get('col', 0) == 0 else xs_[::-1]                   # from the outer wall's side (the rooms' corner) inwards
        cop_ += [((x_, yf_), False) for x_ in xs_ if inner(x_, yf_) and not (aisle_x0_ is not None and aisle_x1_ is not None and aisle_x0_ - 1 <= x_ <= aisle_x1_)]
    # ★74-7: first the fixed place: back to back on the outside of the front partition of the left column's front room (the outermost partition
    # of that column, facing the lobby), the _R pictures (front +y). Always the same cells from that room's front-left corner; the old search below
    # stays only as a fallback (with a warning, the tests count it).
    left_rooms_ = [I_ for I_ in islands.values() if I_.get('col', 0) == 0]
    if L86 and left_rooms_:                                                 # ★91: where things stand (visibility first; the drinks together, the office things together)
        R_ = max(left_rooms_, key=lambda I_: I_['y'] + I_['h'])
        yb_ = R_['y'] + R_['h']
        out['equip_row']['lobby'] = {}
        out['equip_row']['vend_why'] = {}
        placed_deco_ = []
        top_I_ = min(islands.values(), key=lambda I_: I_['y'])
        xa_ = top_I_['x'] + top_I_['w']                                     # the aisle's first cell, beside the rooms' right partitions (x + w - 1)
        # 1. the drinks (hot water, rest) together at the top of the aisle, right of the board: the vending machine _R on the back wall (y = 1), the others _L down the aisle on the rooms' right partitions
        vend_ok_ = furn('equip:vending', 'equipment', 'equip_vending', (xa_ + 1, 1), False, near_board=True, clear_of=off_board)
        if not vend_ok_:
            vend_ok_ = furn('equip:vending', 'equipment', 'equip_vending', (xa_ + 1, 1), False, near_board=True, clear_of=off_board, hide_ok=True)
        if vend_ok_:
            out['equip_row']['lobby']['equip:vending'] = [xa_ + 1, 1]
        else:
            warnings.append(f'equip: the vending machine does not fit on the back wall at the top of the aisle: {furn_why.get("equip:vending")}')
        op_all_ = {c_[1] for cells_o in room_cells.values() for c_ in cells_o} | {c_[1] for d_o in island_doors for c_ in d_o['tiles']}      # 93: the rooms' openings (nothing within 2 rows of them: the way in stays clear)
        rows_all_ = [y_ for y_ in range(3, R_['y'] + R_['h']) if all(abs(y_ - o_y) >= 1 for o_y in op_all_) and (xa_ - 1, y_) in occ and str(occ[(xa_ - 1, y_)]).startswith('partition:')]
        rows_ = list(rows_all_)
        fridge_y_ = None
        for oid_s, part_s in (('equip:coffee', 'equip_coffee'), ('equip:water', 'equip_water'), ('decor:deco_fridge', 'deco_fridge'), ('decor:deco_microwave', 'deco_microwave')):
            placed_ = False
            min_d_ = 2 if part_s in ('deco_fridge', 'deco_microwave') else 1                  # (the tall ones keep 2 rows from a room's opening, the small ones 1)
            for hide_s in (False, True):
                for y_s in [y_ for y_ in rows_ if all(abs(y_ - o_y) >= min_d_ for o_y in op_all_) and (part_s != 'deco_microwave' or fridge_y_ is None or y_ - fridge_y_ == 1) and (part_s != 'deco_fridge' or any((y_ + 1) == r2_ and all(abs(r2_ - o_y) >= 2 for o_y in op_all_) for r2_ in rows_))] or [y_ for y_ in rows_ if all(abs(y_ - o_y) >= min_d_ for o_y in op_all_)]:
                    had_f_ = (xa_, y_s) in forbid
                    forbid.discard((xa_, y_s))
                    if furn(oid_s, 'equipment', part_s, (xa_, y_s), True, near_board=True, clear_of=off_board, hide_ok=hide_s):
                        if hide_s:
                            furniture_log[-1]['hides'] = True
                        rows_ = [y_ for y_ in rows_ if y_ > y_s]
                        placed_ = True
                        out['equip_row']['lobby'][oid_s] = [xa_, y_s]
                        if part_s == 'deco_fridge':
                            fridge_y_ = y_s
                        break
                    if had_f_:
                        forbid.add((xa_, y_s))
                if placed_:
                    break
            if not placed_ and oid_s.startswith('equip:'):                   # (the fridge, microwave and bin are extras: a small floor goes without them)
                warnings.append(f'equip: {oid_s} does not fit on a right partition in the aisle: {furn_why.get(oid_s)}')
        # 2. the office things together on the lowest room's front face (its outer side, _R): copier + shredder, two lockers, bookshelf, bin
        # ★99: copier and shredder touch, the two lockers touch (0..2 px, slid below), the file cabinet is gone
        nxt_ = 2
        prev_row_ = None
        n0_b = len(furniture_log)
        # ★102: measure by the pictures' own feet. The floor extent of a picture = for the lowest opaque pixel of every column, the cell coordinates (iso inverted);
        # its min / max over the columns is where the thing's edge stands on the floor (a round pot too). Walls: x = 0 / y = 0; a partition: its own lowest pixels.
        U_ = K * math.hypot(TW / 2, TH / 2)                                        # screen px along the floor per cell

        def reg_(oid_):
            return next((r_ for r_ in reversed(registry) if r_['id'] == oid_), None)

        def foot_ext_(r_):                                                         # (gx min, gx max, gy min, gy max) in cells
            a_ = np.asarray(r_['im'].getchannel('A')) > 40
            cols_ = np.nonzero(a_.any(axis=0))[0]
            ys_ = a_.shape[0] - 1 - np.argmax(a_[::-1, :], axis=0)
            cols_ = list(cols_)
            while len(cols_) > 2 and abs(int(ys_[cols_[0]]) - int(ys_[cols_[1]])) > 2:       # (a lid / leaf overhanging the foot is not the foot: drop the end columns until the line is continuous)
                cols_.pop(0)
            while len(cols_) > 2 and abs(int(ys_[cols_[-1]]) - int(ys_[cols_[-2]])) > 2:
                cols_.pop()
            ox_, oy_ = r_['at'][0] - r_['foot'][0], r_['at'][1] - r_['foot'][1]
            pts_ = [iso.inv(ox_ + c_ + .5, oy_ + ys_[c_] + 1) for c_ in cols_]
            return min(p_[0] for p_ in pts_), max(p_[0] for p_ in pts_), min(p_[1] for p_ in pts_), max(p_[1] for p_ in pts_)

        def shift_(r_, dgx_, dgy_):                                                # move a placed picture by (dgx_, dgy_) cells
            s0_, s1_ = iso(0, 0), iso(dgx_, dgy_)
            r_['at'] = (round(r_['at'][0] + s1_[0] - s0_[0], 1), round(r_['at'][1] + s1_[1] - s0_[1], 1))

        def part_line_(r_):                                                        # gy where the partition behind r_ (facing +y) meets the floor (median of its pieces' lowest pixels); None: none there
            behind_ = {(c_[0] + dx_, c_[1] - 1) for c_ in r_['cells'] for dx_ in (-1, 0, 1)}
            vals_ = []
            for p_ in registry:
                if p_['kind'] != 'partition' or p_.get('im') is None or not behind_ & {tuple(q_) for q_ in p_['cells']}:
                    continue
                pa_ = np.asarray(p_['im'].getchannel('A')) > 40
                po_, py0_ = p_['at'][0] - p_['foot'][0], p_['at'][1] - p_['foot'][1]
                for col_ in range(pa_.shape[1]):
                    px_ = po_ + col_ + .5
                    if pa_[:, col_].any():
                        vals_.append(iso.inv(px_, py0_ + pa_.shape[0] - int(np.argmax(pa_[::-1, col_])))[1])
            return float(np.median(vals_)) if vals_ else None

        h_mfp_ = h_sh1_ = None                                                     # ★102: the shredder is 0.85 times the copier's height (opaque pixels), as the user wants
        for pn_, fs_ in (('equip_mfp', FURN_SCALE['equip_mfp']), ('deco_shredder', 1.0)):
            q0_ = parts.get(pn_)
            if q0_:
                im0_, _ft0 = scaled({'file': q0_['file'], 'foot': q0_['anchor']}, kr * fs_)
                bb0_ = im0_.getchannel('A').point(lambda v2_: 255 if v2_ > 40 else 0).getbbox()
                if bb0_:
                    h_mfp_, h_sh1_ = (bb0_[3] - bb0_[1], h_sh1_) if pn_ == 'equip_mfp' else (h_mfp_, bb0_[3] - bb0_[1])
        if h_mfp_ and h_sh1_:
            FURN_SCALE['deco_shredder'] = round(SHREDDER_RATIO * h_mfp_ / h_sh1_, 3)
        office_row_ = (('equip:mfp', 'equip_mfp', 1), ('decor:deco_shredder', 'deco_shredder', 1),
                       ('decor:deco_locker:0', 'deco_locker', 1), ('decor:deco_locker:1', 'deco_locker', 2),
                       ('decor:deco_bookshelf', 'deco_bookshelf', 1))                         # (★102: the bins are placed after the row, on the partition's own span, see below)
        for oid_b, part_b, step_b in office_row_:
            for hide_b in (False, True):
                got_b = None
                for dx_b in range(max(nxt_, 1), R_['w'] - 1):
                    if furn(oid_b, 'equipment', part_b, (R_['x'] + dx_b, yb_), False, near_board=True, clear_of=off_board, hide_ok=hide_b):
                        got_b = dx_b
                        if hide_b:
                            furniture_log[-1]['hides'] = True
                        break
                if got_b is not None:
                    break
            if got_b is None:
                if oid_b.startswith('equip:'):                                          # (the lockers, bookshelf, bin and shredder are extras: a small floor goes without them)
                    warnings.append(f'equip: {oid_b} does not fit on the front partition of {R_["key"]}: {furn_why.get(oid_b)}')
            else:
                nxt_ = got_b + step_b                                                      # 99: shredder / lockers in touching cells; the bin right beside the bookshelf
                r_new_ = reg_(oid_b)                                                       # ★102: the pictures are wider than their cell: keep the row's things from sinking into each other, and leave the cells they spill into free
                if r_new_ and r_new_.get('im') is not None:
                    if prev_row_ and reg_(prev_row_):
                        g_row_ = foot_ext_(r_new_)[0] - foot_ext_(reg_(prev_row_))[1]
                        if g_row_ < 0 or oid_b in ('decor:deco_shredder', 'decor:deco_locker:1'):      # (the shredder stands at the copier's foot and the lockers side to side; the others only never overlap)
                            shift_(r_new_, -g_row_, 0)
                    if oid_b == 'decor:deco_shredder':
                        pl_ = part_line_(r_new_)
                        if pl_ is not None:
                            shift_(r_new_, 0, pl_ - foot_ext_(r_new_)[2])
                    nxt_ = max(nxt_, int(math.ceil(foot_ext_(r_new_)[1] - R_['x'] - .05)))
                    prev_row_ = oid_b
        # ★102: the bins stand with their back on the partition, so their whole foot must lie on the partition's span (the row's end is past it), clear of the others' feet,
        # the sorting bin touching the bookshelf (beside it) and the small bin beside the sorting bin.
        span_x_ = [q_ for p_ in registry if p_['kind'] == 'partition' and p_.get('im') is not None for q_ in {c_[0] for c_ in p_['cells'] if c_[1] == yb_ - 1}]
        span_ = (min(span_x_), max(span_x_) + 1) if span_x_ else None

        def put_bin_(oid_, part_n_, as_furn_, anchor_):
            row_ids_ = ('equip:mfp', 'decor:deco_shredder', 'decor:deco_locker:0', 'decor:deco_locker:1', 'decor:deco_bookshelf', 'decor:deco_recycle')
            ra_ = reg_(anchor_)
            ea_ = foot_ext_(ra_) if ra_ else None
            acx_ = int((ea_[0] + ea_[1]) / 2) if ea_ else R_['x'] + 6
            for dx_t in sorted(range(1, R_['w'] - 1), key=lambda d_: (abs(R_['x'] + d_ - acx_), d_)):
                c_t = (R_['x'] + dx_t, yb_)
                n_f_ = len(furniture_log)
                if as_furn_:
                    ok_t_ = furn(oid_, 'equipment', part_n_, c_t, False, near_board=True, clear_of=off_board)
                else:
                    ok_t_ = c_t not in occ and c_t not in forbid and c_t not in used and wall_at((c_t[0], c_t[1] - 1)) and place(oid_, 'trash', 'trash', c_t[0], c_t[1], 1, 1, None)
                if not ok_t_:
                    continue
                r_t_ = reg_(oid_)
                pl_ = part_line_(r_t_)
                if pl_ is not None:
                    shift_(r_t_, 0, pl_ - foot_ext_(r_t_)[2])
                e_t_ = foot_ext_(r_t_)
                others_ = [foot_ext_(reg_(i_)) for i_ in row_ids_ if i_ != oid_ and reg_(i_)]
                if ea_ is not None and ra_ is not None:                                 # touch the anchor (the nearer side that is free)
                    for tgt_ in ((ea_[0] - e_t_[1]), (ea_[1] - e_t_[0])):
                        r2_ = dict(r_t_)
                        shift_(r_t_, tgt_, 0)
                        e2_ = foot_ext_(r_t_)
                        if not any(e2_[0] < e_[1] - .02 and e2_[1] > e_[0] + .02 for e_ in others_) and span_ and span_[0] - .05 <= e2_[0] and e2_[1] <= span_[1] + .05:
                            e_t_ = e2_
                            break
                        r_t_['at'] = r2_['at']
                if span_ and not (span_[0] - .05 <= e_t_[0] and e_t_[1] <= span_[1] + .05) or any(e_t_[0] < e_[1] - .02 and e_t_[1] > e_[0] + .02 for e_ in others_):
                    for c_u in (furniture_log[n_f_:] and [c2_ for f_u in furniture_log[n_f_:] for c2_ in f_u['cells']] or [c_t]):
                        occ.pop(tuple(c_u), None)
                    registry[:] = [q_ for q_ in registry if q_['id'] != oid_]
                    del furniture_log[n_f_:]
                    back_part_ids.discard(oid_)
                    continue
                return True
            if as_furn_:
                warnings.append(f'equip: {oid_} does not fit on the partition of {R_["key"]}: {furn_why.get(oid_)}')
            return False
        put_bin_('decor:deco_recycle', 'deco_recycle', True, 'decor:deco_bookshelf')
        put_bin_('trash:lobby-a', 'trash', False, 'decor:deco_recycle' if reg_('decor:deco_recycle') else 'decor:deco_bookshelf')
        out['equip_row']['back'] = {'room': R_['key'], 'cells': sorted([c_[0] - R_['x'], c_[1] - yb_] for f_ in furniture_log[n0_b:] for c_ in f_['cells'])}
        # 3. a whiteboard in each room, on its left partition's inner face (_L, the wall that rises to the right)
        for I_d in sorted(islands.values(), key=lambda I_: I_['y']):
            done_w_ = False
            for hide_w in (False, True):
                for dy_d in (4, 5, 6, 7):
                    if furn(f'decor:deco_whiteboard:{I_d["key"]}', 'equipment', 'deco_whiteboard', (I_d['x'] + 1, I_d['y'] + dy_d), True, near_board=True, clear_of=off_board, hide_ok=hide_w):
                        if hide_w:
                            furniture_log[-1]['hides'] = True
                        placed_deco_.append('deco_whiteboard')
                        done_w_ = True
                        break
                if done_w_:
                    break
        def mask_(r_, d_=0):                                     # the opaque pixels of a placed picture on the floor's canvas (d_: grown by d_ px)
            a_ = r_['im'].getchannel('A').point(lambda v2_: 255 if v2_ > 40 else 0)
            if d_:
                a_ = a_.filter(ImageFilter.MaxFilter(2 * d_ + 1))
            return np.asarray(a_) > 0, round(r_['at'][0] - r_['foot'][0]), round(r_['at'][1] - r_['foot'][1])

        def touches_(a_, b_):
            (ma_, ax_, ay_), (mb_, bx_, by_) = a_, b_
            x0_, y0_, x1_, y1_ = max(ax_, bx_), max(ay_, by_), min(ax_ + ma_.shape[1], bx_ + mb_.shape[1]), min(ay_ + ma_.shape[0], by_ + mb_.shape[0])
            return x1_ > x0_ and y1_ > y0_ and bool((ma_[y0_ - ay_:y1_ - ay_, x0_ - ax_:x1_ - ax_] & mb_[y0_ - by_:y1_ - by_, x0_ - bx_:x1_ - bx_]).any())
        def pair_gap_(ida_, idb_):                                   # 95: the pixel gap between two placed pictures (0..6, 99 = more)
            ra_ = next((r_ for r_ in reversed(registry) if r_['id'] == ida_), None)
            rb_ = next((r_ for r_ in reversed(registry) if r_['id'] == idb_), None)
            if ra_ is None or rb_ is None:
                return None
            for d_ in range(0, 7):
                if touches_(mask_(ra_, d_), mask_(rb_)):
                    return d_
            return 99

        def slide_touch_(ida_, idb_, steps_=40):                    # ★99: move idb_'s picture along the wall (-x) until it touches ida_ (0 px)
            ra_ = next((r_ for r_ in reversed(registry) if r_['id'] == ida_), None)
            rb_ = next((r_ for r_ in reversed(registry) if r_['id'] == idb_), None)
            if ra_ is None or rb_ is None:
                return False
            base_, ma_ = rb_['at'], mask_(ra_, 2)
            if touches_(ma_, mask_(rb_)):
                return True
            for k_ in range(1, steps_ + 1):
                s0_, s1_ = iso(0, 0), iso(-.05 * k_, 0)
                rb_['at'] = (round(base_[0] + s1_[0] - s0_[0], 1), round(base_[1] + s1_[1] - s0_[1], 1))
                if touches_(ma_, mask_(rb_)):
                    return True
            rb_['at'] = base_
            return False

        out['equip_row']['pair_gaps'] = {'fridge-microwave': pair_gap_('decor:deco_fridge', 'decor:deco_microwave'), 'shelf-bin': pair_gap_('decor:deco_bookshelf', 'decor:deco_recycle'),
                                         'copier-shredder': None, 'locker-locker': None}      # (★102: both are measured on the pictures' feet, below)
        # 4. 93: two counter desks on the door's wall at its far end (the window side, the rooms' top), side by side with a free cell between them, a bar stool in front of each; no other counter
        n_cnt_ = 0
        for y_c in (3, 5, 7, 9, 11):
            if n_cnt_ >= 3:
                break
            had_k_ = [(c_, c_ in forbid) for c_ in ((1, y_c), (1, y_c - 1), (2, y_c))]
            for c_k, _h in had_k_:
                forbid.discard(c_k)
            if furn(f'decor:deco_counter:{n_cnt_}', 'equipment', 'deco_counter', (1, y_c), True, near_board=True, clear_of=off_board):
                placed_deco_.append('deco_counter')
                if furn(f'decor:deco_barstool:{n_cnt_}', 'equipment', 'deco_barstool', (2, y_c), True, near_board=True, clear_of=off_board, back=False) or furn(f'decor:deco_barstool:{n_cnt_}', 'equipment', 'deco_barstool', (2, y_c), True, near_board=True, clear_of=off_board, back=False, hide_ok=True):
                    placed_deco_.append('deco_barstool')
                    it_s, it_c = registry[-1], next(r_ for r_ in reversed(registry) if r_['id'] == f'decor:deco_counter:{n_cnt_}')

                    base_at_, mc_ = it_s['at'], mask_(it_c, 2)
                    touched_ = False
                    for k_s in range(0, 41):                                 # the stool slides along -x towards the counter until the two pictures touch (within 2 px)
                        s0_, s1_ = iso(0, 0), iso(-.05 * k_s, 0)
                        it_s['at'] = (round(base_at_[0] + s1_[0] - s0_[0], 1), round(base_at_[1] + s1_[1] - s0_[1], 1))
                        if touches_(mc_, mask_(it_s)):
                            touched_ = True
                            break
                    if not touched_:
                        it_s['at'] = base_at_
                    furniture_log[-1]['counter_touch'] = bool(touched_)
                    furniture_log[-1]['counter_gap_px'] = 0.0 if touched_ else 99.0
                if n_cnt_ >= 1:
                    furniture_log[-1].setdefault('pair_gap_px', pair_gap_(f'decor:deco_counter:{n_cnt_ - 1}', f'decor:deco_counter:{n_cnt_}'))
                n_cnt_ += 1
            else:
                for c_k, h_k in had_k_:
                    if h_k:
                        forbid.add(c_k)
        # 5. two round tables on the floor's bottom corner (the open lobby, far from the two back walls)
        n_cf_ = 0
        for y_t, x_t in sorted(((y0_, x0_) for y0_ in range(D_in - 2, max(door_y, yb_ + 1), -1) for x0_ in range(W - 3, 6, -1) if x0_ <= xa_ - 2 or y0_ >= yb_ + 2), key=lambda q_: ((W - 3 - q_[1]) ** 2 + (D_in - 2 - q_[0]) ** 2, q_)):      # nearest the south corner first
            if True:
                if n_cf_ < 2 and any(abs(x_t - c_[0]) + abs(y_t - c_[1]) < 3 for f_ in furniture_log if f_['part'] == 'deco_cafe' for c_ in f_['cells']):
                    continue
                if n_cf_ >= 2:
                    continue
                had_c_ = (x_t, y_t) in forbid                                # (the corner of the floor: the standing-point margins of the lobby need not keep it free)
                forbid.discard((x_t, y_t))
                if furn(f'decor:deco_cafe:{n_cf_}', 'equipment', 'deco_cafe', (x_t, y_t), False, near_board=True, clear_of=off_board, back=False):
                    placed_deco_.append('deco_cafe')
                    n_cf_ += 1
                elif had_c_:
                    forbid.add((x_t, y_t))
                if not (n_cf_ and False):
                    out['equip_row'].setdefault('cafe_why', {})[f'{x_t},{y_t}'] = furn_why.get(f'decor:deco_cafe:{n_cf_}')
        # 6. ★99/★100-1: the open floor holds only the round tables; a plant at the counter run's far (top) end, one beside the vending machine,
        # and the welcome board by the entrance door (front +x, never mirrored) with a plant beside it. None of them may cut a way.
        cnt_cells_ = [c_ for f_ in furniture_log if f_['part'] == 'deco_counter' for c_ in f_['cells']]
        if cnt_cells_:
            top_y_ = min(c_[1] for c_ in cnt_cells_)
            for art_p, c_ in (('plant_snake', (1, top_y_ - 1)), ('plant_boxwood', (2, top_y_ - 1)), ('plant_snake', (1, top_y_ - 2))):
                if plant_at('plant:counter-end', c_, backed=True, art=art_p, board_ok=True, k_pl=.45):      # ★102: about 1.5 times as big
                    placed_deco_.append(art_p)
                    break
        vend_f_ = next((f_ for f_ in furniture_log if f_['id'] == 'equip:vending'), None)
        if vend_f_:
            vc_ = vend_f_['cells']
            x0v_, x1v_ = min(c_[0] for c_ in vc_), max(c_[0] for c_ in vc_)
            for k_p, c_ in enumerate(((x1v_ + 1, 1), (x0v_ - 1, 1), (x0v_, 2), (x1v_, 2), (x1v_ + 1, 2), (x0v_, 3), (x1v_ + 1, 3))):
                art_p = ('plant_boxwood', 'plant_snake', 'plant_fig', 'plant_palm')[k_p % 4]
                if plant_at(f'plant:vending-{k_p}', c_, backed=True, art=art_p, board_ok=True, k_pl=.45):      # ★102: about 1.5 times as big
                    placed_deco_.append(art_p)
                    break
        wy_ = door_y + DOOR_W + 1                                        # ★100-1 just below the door: the door's swing rows (and the way in front) stay free
        if 'deco_welcome' in parts:
            wc_ = None
            for c_w in ((1, wy_), (1, wy_ + 1), (2, wy_), (2, wy_ + 1), (1, wy_ - 1), (1, door_y - 1), (1, door_y - 2)):     # ★100-1 the lobby floor beside the door (the open floor is a walk cell: freed as for the tables; reachable() keeps the way)
                had_w_ = c_w in forbid
                forbid.discard(c_w)
                got_w_ = False
                for hide_w in (False, True):
                    if furn('decor:deco_welcome', 'furniture', 'deco_welcome', c_w, True, near_board=True, clear_of=off_board, back=False, hide_ok=hide_w):
                        if hide_w:
                            furniture_log[-1]['hides'] = True
                        got_w_ = True
                        break
                if got_w_:
                    placed_deco_.append('deco_welcome')
                    wc_ = c_w
                    break
                if had_w_:
                    forbid.add(c_w)
            pc_ = ([(wc_[0], wc_[1] + 1), (wc_[0], wc_[1] - 1), (wc_[0] + 1, wc_[1]), (wc_[0] + 1, wc_[1] - 1), (wc_[0] + 1, wc_[1] + 1)] if wc_ else [(1, wy_ - 1), (2, wy_), (2, wy_ - 1), (1, wy_ + 1)])
            for k_p, c_ in enumerate(pc_):
                art_p = ('plant_boxwood', 'plant_snake', 'plant_fig')[k_p % 3]
                had_p_ = c_ in forbid
                forbid.discard(c_)
                if plant_at('plant:welcome', c_, backed=True, art=art_p):
                    placed_deco_.append(art_p)
                    break
                if had_p_:
                    forbid.add(c_)
        # ★102: flush to the cell, measured on the pictures' feet (gaps in screen px along the floor; 0 = the opaque edges touch). `gaps102` is what the tests and the notes read.
        g102_ = out['equip_row']['gaps102'] = {}
        log102_ = {f_['id']: f_ for f_ in furniture_log}

        def note_(key_, **kw_):
            g102_.setdefault(key_, {}).update({k2_: round(v2_, 2) for k2_, v2_ in kw_.items() if v2_ is not None})

        def back_wall_(oid_, key_, axis_):                                         # axis_ 0: the left wall (x = 0); 1: the back wall (y = 0)
            r_ = reg_(oid_)
            if not r_ or r_.get('im') is None:
                return None
            e_ = foot_ext_(r_)
            d_ = e_[0] if axis_ == 0 else e_[2]
            shift_(r_, -d_ if axis_ == 0 else 0, -d_ if axis_ == 1 else 0)
            e2_ = foot_ext_(r_)
            note_(key_, **{('back_left_px' if axis_ == 0 else 'back_back_px'): (e2_[0] if axis_ == 0 else e2_[2]) * U_})
            return r_

        def back_part_(oid_, key_):                                                # the back on a partition's outer face
            r_ = reg_(oid_)
            if not r_ or r_.get('im') is None:
                return None
            pl_ = part_line_(r_)
            if pl_ is None:
                note_(key_, back_part_px=None, no_partition=1)
                return r_
            shift_(r_, 0, pl_ - foot_ext_(r_)[2])
            note_(key_, back_part_px=(foot_ext_(r_)[2] - pl_) * U_)
            return r_

        def side_(oid_a, oid_b, key_):                                             # b (larger x) touches a: gap along x between a's right edge and b's left edge
            ra_, rb_ = reg_(oid_a), reg_(oid_b)
            if not ra_ or not rb_ or ra_.get('im') is None or rb_.get('im') is None:
                return None
            shift_(rb_, foot_ext_(ra_)[1] - foot_ext_(rb_)[0], 0)
            note_(key_, side_px=(foot_ext_(rb_)[0] - foot_ext_(ra_)[1]) * U_)
            return rb_

        vp_ = next((f_['id'] for f_ in furniture_log if f_['id'].startswith('plant:vending')), None)
        if vp_:                                                                    # 1. the vending machine's plant: back on the back wall, its side on the machine's end
            back_wall_(vp_, 'vending-plant', 1)
            side_('equip:vending', vp_, 'vending-plant')
            log102_[vp_]['k'] = .45
        if reg_('plant:counter-end'):                                              # 2. the far plant: in the corner, one face on each wall
            back_wall_('plant:counter-end', 'corner-plant', 0)
            back_wall_('plant:counter-end', 'corner-plant', 1)
            log102_['plant:counter-end']['k'] = .45
        if reg_('decor:deco_welcome'):                                             # 3. the welcome board and its plant against the door's wall
            back_wall_('decor:deco_welcome', 'welcome-board', 0)
            if reg_('plant:welcome'):
                back_wall_('plant:welcome', 'welcome-plant', 0)
                rb_w_, rp_w_ = reg_('decor:deco_welcome'), reg_('plant:welcome')
                eb_w_, ep_w_ = foot_ext_(rb_w_), foot_ext_(rp_w_)
                if ep_w_[2] >= eb_w_[2]:                                           # the plant on the board's +y side (the way it is placed): its side on the board's foot, no overlap
                    shift_(rp_w_, 0, eb_w_[3] - ep_w_[2])
                    note_('welcome-plant', side_px=(foot_ext_(rp_w_)[2] - eb_w_[3]) * U_)
        if reg_('decor:deco_shredder'):                                            # 4. the shredder (placed beside the copier above): measure
            r_sh_, r_cp_ = reg_('decor:deco_shredder'), reg_('equip:mfp')
            note_('shredder', side_px=(foot_ext_(r_sh_)[0] - foot_ext_(r_cp_)[1]) * U_ if r_cp_ else None)
            back_part_('decor:deco_shredder', 'shredder')
            bb_s_ = r_sh_['im'].getchannel('A').point(lambda v2_: 255 if v2_ > 40 else 0).getbbox()
            bb_c_ = r_cp_['im'].getchannel('A').point(lambda v2_: 255 if v2_ > 40 else 0).getbbox() if r_cp_ else None
            if bb_s_ and bb_c_:
                note_('shredder', height_ratio=(bb_s_[3] - bb_s_[1]) / (bb_c_[3] - bb_c_[1]))
        for oid_t_, key_t_ in (('decor:deco_recycle', 'bin'), ('trash:lobby-a', 'bin-small')):    # 5. the bins: back on the partition
            if reg_(oid_t_):
                back_part_(oid_t_, key_t_)
        if reg_('decor:deco_locker:0') and reg_('decor:deco_locker:1'):            # 6. the two lockers: side to side, 0 px
            for k_l_ in (0, 1):
                back_part_(f'decor:deco_locker:{k_l_}', f'locker{k_l_}')
            side_('decor:deco_locker:0', 'decor:deco_locker:1', 'lockers')
        for k_g_, oid_g_ in (('vending-plant', vp_), ('corner-plant', 'plant:counter-end'), ('welcome-board', 'decor:deco_welcome'), ('welcome-plant', 'plant:welcome'),
                             ('shredder', 'decor:deco_shredder'), ('bin', 'decor:deco_recycle'), ('bin-small', 'trash:lobby-a'), ('locker0', 'decor:deco_locker:0'), ('locker1', 'decor:deco_locker:1')):
            f_g_ = log102_.get(oid_g_) if oid_g_ else None
            if f_g_ is not None and k_g_ in g102_:
                bk_ = [v2_ for k2_, v2_ in g102_[k_g_].items() if k2_.startswith('back_')]
                if bk_:
                    f_g_['back_gap_px'] = round(max(bk_, key=abs), 2)                  # the tests read this: the largest back gap measured on the picture
        out['equip_row']['pair_gaps']['copier-shredder'] = g102_.get('shredder', {}).get('side_px')
        out['equip_row']['pair_gaps']['locker-locker'] = g102_.get('lockers', {}).get('side_px')
        out['equip_row']['decor'] = placed_deco_

    if left_rooms_ and not L86:
        R_ = max(left_rooms_, key=lambda I_: I_['y'] + I_['h'])
        yb_ = R_['y'] + R_['h']
        n0_b = len(furniture_log)
        if all(furn(oid_b, 'equipment', part_b, (R_['x'] + dx_b, yb_), False, near_board=True, clear_of=off_board) for oid_b, part_b, dx_b in EQUIP_BACK):
            out['equip_row']['back'] = {'room': R_['key'], 'cells': sorted([c_[0] - R_['x'], c_[1] - yb_] for f_ in furniture_log[n0_b:] for c_ in f_['cells'])}
        else:
            why_b = {oid_b: furn_why.get(oid_b) for oid_b, *_ in EQUIP_BACK}
            take_back(n0_b)
            warnings.append(f'equip: the copier / file cabinet do not fit on the front partition of {R_["key"]}: {why_b}')
    if False:                                                               # ★89: (withdrawn) one water server and one coffee machine for the whole office, in the lobby (above): _L (front +x), back on the room's side partition, in the aisle
        out['equip_row']['side'] = {}
        why_s = out['equip_row']['side_why'] = {}
        for I_ in sorted(islands.values(), key=lambda I_: I_['y']):
            xs_ = I_['x'] + I_['w']                                         # the aisle cell beside the right partition (x + w - 1; I_ is the outer box)
            op_ys_ = {c_[1] for o_ in out['islands'] if o_['key'] == I_['key'] for c_ in o_.get('open_cells') or []}
            ys_ = [y_ for y_ in range(I_['y'] + 1, I_['y'] + I_['h'] - 1) if y_ not in op_ys_]
            got_ = []
            for oid_s, part_s in (('equip:water', 'equip_water'), ('equip:coffee', 'equip_coffee')):
                oid_k = f'{oid_s}:{I_["key"]}'
                placed_ = False
                for hide_s in (False, True):                                # (a room whose every row would hide a seated person: the machine goes in anyway, last)
                    for y_s in (ys_ if oid_s == 'equip:water' else ys_[::-1]):
                        if y_s in got_:
                            continue
                        n0_s = len(furniture_log)
                        had_f_ = (xs_, y_s) in forbid                       # (the openings' margin: beside the opening is the place of a side machine)
                        forbid.discard((xs_, y_s))
                        if furn(oid_k, 'equipment', part_s, (xs_, y_s), True, near_board=True, clear_of=off_board, hide_ok=hide_s):
                            furniture_log[-1]['room'] = I_['key']
                            if hide_s:
                                furniture_log[-1]['hides'] = True
                            got_.append(y_s)
                            placed_ = True
                            break
                        if had_f_:
                            forbid.add((xs_, y_s))
                        if len(furniture_log) > n0_s:
                            take_back(n0_s)
                        why_s.setdefault(I_['key'], []).append((oid_s[6:], y_s, furn_why.get(oid_k)))
                    if placed_:
                        break
                if not placed_:
                    warnings.append(f'equip: {oid_s} of {I_["key"]} does not fit on its side partition: {furn_why.get(oid_k)}')
            out['equip_row']['side'][I_['key']] = got_
    out['board_printer'] = next((list(f_['cells'][0]) for f_ in furniture_log if f_['id'] == 'equip:mfp'), None)     # (the copier's cell; the key keeps its old name)
    for c_, fl_ in ([] if out['board_printer'] else cop_):                  # ★63: already in the fixed row
        if any(abs(c_[0] - d_[0]) <= 1 and abs(c_[1] - d_[1]) <= 1 for d_ in drink_cells_):
            continue                                                        # (a free cell between it and the drinks row)
        if furn('equip:mfp', 'equipment', 'equip_mfp', c_, fl_, near_board=True, clear_of=off_board, over_card=fl_):
            out['board_printer'] = list(c_)
            break
    if not out['board_printer'] and not (L86 and not islands):
        warnings.append('equip:mfp: no free cell against an outer wall or a partition')
    # ★99: the file cabinet is gone (it was the search fallback on the left wall too)
    if out['refresh_corner'] and not any(f_['id'] == 'plant:refresh' for f_ in furniture_log):     # the left wall's row: the plant at its open end
        ends_ = [c_[1] for f_ in furniture_log if f_['id'].startswith('equip:') for c_ in f_['cells'] if c_[0] == 1]
        for y_p in ([y_ for y_ in run_left if ends_ and y_ > max(ends_)] + [y_ for y_ in reversed(run_left) if ends_ and y_ < min(ends_)]):
            if plant_at('plant:refresh', (1, y_p), over_card=True):
                break
    # ★63 (office-live 07:03): the entrance's waiting tiles (wait:N in the mod) never on or right in front of a machine of the left wall's row: the
    # machines' cells and one cell in front of them (+x), for the mod's freeNear
    eq_cells_ = {tuple(c_) for f_ in furniture_log if f_['id'].startswith('equip:') for c_ in f_['cells'] if c_[0] <= 2}
    out['wait_avoid'] = sorted([list(c_) for c_ in eq_cells_ | {(c_[0] + 1, c_[1]) for c_ in eq_cells_}])
    out['refresh_table'] = None                                             # ★55-4: no standing table (nor the café set) in the open lobby
    # ★75-3 / ★75-4: plants round the rooms, chosen from a list of the places a plant may stand (plant_spots: the outside of the front partition, the
    # outside of the side partition on the aisle, the room's left-top and right-bottom inner corners), each with its kinds. Fixed now (the first
    # spots of each sort, a kind from the room's key); cfg "plant_seed" (a number) picks the spots and kinds at random per room with that seed
    # (the same in every scene of that room: nothing moves while the scene stays). Never on a way, a door's front, a queue or in front of a machine.
    machine_near_ = {(c_[0] + dx_, c_[1] + dy_) for f_ in furniture_log if f_['id'].startswith('equip:') for c_ in f_['cells'] for dx_ in (-2, -1, 0, 1, 2) for dy_ in (-1, 0, 1, 2)}   # ★83-2: ±2 along x (the big fig hid the file cabinet's front)
    seed_p = cfg.get('plant_seed')
    for n_c, I_ in enumerate(sorted(islands.values(), key=lambda I_: (I_.get('col', 0), I_['y']))):
        got_p = {}
        for n_s, sp_ in enumerate(choose_plant_spots(plant_spots(I_), I_['key'], seed_p)):
            c_ = sp_['cell']
            if sp_['where'] != 'corner' and any(J_ is not I_ and J_['x'] <= c_[0] < J_['x'] + J_['w'] and J_['y'] <= c_[1] < J_['y'] + J_['h'] for J_ in islands.values()):
                continue                                                    # (outside: never in another room, e.g. the room in front of it)
            if got_p.get(sp_['where'], 0) >= sp_['quota'] or c_ in machine_near_ or any(abs(c_[0] - q_[0]) <= 1 and abs(c_[1] - q_[1]) <= 1 for f_ in furniture_log for q_ in map(tuple, f_['cells'])):
                continue
            if plant_at(f'plant:{sp_["where"]}-{n_c}-{n_s}', c_, backed=True, art=sp_['kind'], board_ok=L86 and sp_['where'] == 'corner'):
                got_p[sp_['where']] = got_p.get(sp_['where'], 0) + 1
    lamp_done = False
    # ★A4-2c: the floor lamp is one of the left wall's pieces (against the wall); never alone in the open floor
    for f_l in furniture_log:
        if f_l['part'] == 'equip_lamp':
            lamp_done = True
            c_ = tuple(f_l['cells'][0])
            at_l = iso(c_[0] + .5, c_[1] + .5)
            out.setdefault('lights', []).append({'island': 'lamp:floor', 'at': [round(at_l[0], 1), round(at_l[1] - 70 * K, 1)], 'size': [round(5 * TW * K, 1), round(5 * TH * K, 1)]})
    # ★25-3: what stands outside each island is drawn per island, from the island's own id (the same island always gets the same: a redraw changes nothing):
    # 0-2 pieces (a plant, a file cabinet, a whiteboard, a small printer, a coat stand), each at a place drawn from the outer ring of the island (its corners and
    # sides), never at a door or in front of one. Islands differ: nothing forces a plant into every corner.
    isl_door_zone = set()
    for d_ in island_doors:
        isl_door_zone |= {(c_[0] + dx_, c_[1] + dy_) for c_ in map(tuple, d_['tiles']) for dx_ in range(-2, 3) for dy_ in range(-2, 3)}
    for cells_ in room_cells.values():                                      # ★59: also the room's opening into the lobby (one-island spaces have no island_doors)
        isl_door_zone |= {(c_[0] + dx_, c_[1] + dy_) for c_ in map(tuple, cells_) for dx_ in range(-3, 4) for dy_ in range(-3, 4)}
    deco_kinds = [('plant', None, None), ('plant', None, None),
                  ('coat', 'equip_coat', 'equipment')]          # ★42: no file cabinet, printer or whiteboard among the drawn pieces (the machines have fixed places; a lone whiteboard in the aisle looked lost)
    out['island_deco'] = {}
    _lc = [I_['x'] + I_['w'] for I_ in islands.values() if I_.get('col') == 0]
    _rc = [I_['x'] for I_ in islands.values() if I_.get('col') == 1]
    aisle_cols_ = set(range(max(_lc), min(_rc))) if _lc and _rc else set()      # ★A8: the middle aisle stays free of pieces (the ring's corner cells reach into it)
    deco_n, deco_cap = {}, max(1, len(islands) // 2)                  # ★25-3: one kind of piece stands at no more than half of the islands
    def way_lengths():                                                        # steps from the entrance to every place (a cell or its nearest neighbour)
        d_ = {(2, door_y): 0}
        q_ = [(2, door_y)]
        for x_, y_ in q_:                                                     # (a breadth-first walk: the list grows while it is read)
            for dx_, dy_ in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c_ = (x_ + dx_, y_ + dy_)
                if c_ not in d_ and 0 < c_[0] < W and 0 < c_[1] < D and floor_ok(*c_) and c_ not in occ:
                    d_[c_] = d_[(x_, y_)] + 1
                    q_.append(c_)
        return {t_: min([d_[n_] + (0 if n_ == t_ else 1) for n_ in [t_] + [(t_[0] + a_, t_[1] + b_) for a_, b_ in ((1, 0), (-1, 0), (0, 1), (0, -1))] if n_ in d_], default=None) for t_ in targets}

    def longer_way(base_):
        now_ = way_lengths()
        return any(base_[t_] is not None and (now_[t_] is None or now_[t_] > base_[t_]) for t_ in targets)
    way_base = way_lengths()
    for n_m, m_ in enumerate(lounge_mids):                                 # self-review #13 (office-polish): each lounge group: a plant at its ends
        used.difference_update(m_['plants'])
        for n_p, c_m in enumerate(m_['plants']):                          # (not plant_at: the lounge's standing points make all of it `forbid`; a point ON the cell still blocks)
            if c_m in occ or c_m in spawn or not inner(*c_m) or 'plant' not in parts:
                continue
            r0_m = len(registry)
            if not place(f'plant:lounge-{n_m}-{n_p}', 'plant', 'plant', c_m[0], c_m[1], 1, 1, .3):
                continue
            if not reachable() or longer_way(way_base):
                occ.pop(c_m, None)
                del registry[r0_m:]
                continue
            furniture_log.append({'id': f'plant:lounge-{n_m}-{n_p}', 'cells': [c_m], 'part': 'plant'})
    way_base = way_lengths()
    for k_ in sorted(islands, key=str):
        I_ = islands[k_]
        rg_ = random.Random(int(hashlib.sha1(('deco|' + str(k_)).encode('utf-8')).hexdigest()[:12], 16))
        n_want = rg_.choice([0, 0, 1, 1, 1, 2, 2])
        ring_ = ([(x_, I_['y'] - 1) for x_ in range(I_['x'] - 1, I_['x'] + I_['w'] + 1)] + [(x_, I_['y'] + I_['h']) for x_ in range(I_['x'] - 1, I_['x'] + I_['w'] + 1)]
                 + [(I_['x'] - 1, y_) for y_ in range(I_['y'], I_['y'] + I_['h'])] + [(I_['x'] + I_['w'], y_) for y_ in range(I_['y'], I_['y'] + I_['h'])])
        ring_ = [c_ for c_ in ring_ if c_ not in isl_door_zone and c_ not in board_keep and c_[0] not in aisle_cols_
                 and c_[1] != I_['y'] + I_['h']]                  # ★52-5 (A10): the room's plate stands along the front edge: no piece there
        rg_.shuffle(ring_)
        kinds_ = list(deco_kinds)
        rg_.shuffle(kinds_)
        got_ = []
        for name_, part_n, kind_n in kinds_:
            if len(got_) >= n_want:
                break
            if name_ in got_ or deco_n.get(name_, 0) >= (max(1, len(islands) // 3) if name_ == 'coat' else deco_cap) or (name_ == 'plant' and 'plant' not in parts) or (part_n and part_n not in parts):
                continue
            for c_ in ring_:
                if any(str(occ.get((c_[0] + dx_, c_[1] + dy_), '')).startswith(f'deco:{name_}') for dx_ in range(-2, 3) for dy_ in range(-2, 3)):
                    continue                                   # (two islands' like pieces never stand side by side)
                if name_ == 'plant' and any(str(occ.get((c_[0] + dx_, c_[1] + dy_), '')).startswith('trash') for dx_ in range(-3, 4) for dy_ in range(-3, 4)
                                            if abs(dx_ + dy_) <= 3 and abs(dx_ - dy_) <= 1):
                    continue                                   # ★52-5 (A10): nor in front of / against the room's bin (the same screen column)
                fl0_ = rg_.random() < .5                       # ★55: the coat stand turns its back to the wall / partition beside it
                n0_d = len(furniture_log)
                if (plant_at(f'deco:plant:{k_}', c_) if name_ == 'plant' else (furn(f'deco:{name_}:{k_}', kind_n, part_n, c_, fl0_) or furn(f'deco:{name_}:{k_}', kind_n, part_n, c_, not fl0_))):
                    if longer_way(way_base):                   # ★55-5 / ★63 (office-polish): a piece that makes any way from the entrance longer is taken back
                        take_back(n0_d)
                        continue
                    got_.append(name_)
                    deco_n[name_] = deco_n.get(name_, 0) + 1
                    break
        out['island_deco'][str(k_)] = got_
    # ★17-2: no poles and no signboards (the label plate "承認デスク" / "提出カウンター" is C's white rounded plate at sign_at: just over the window desk)
    out['poles'] = []
    for kind_ in ('approval', 'counter'):
        w_ = (out.get('windows') or {}).get(kind_)
        if w_:
            r_ = w_['rect']
            w_['sign_at'] = [round(r_[0] + r_[2] / 2, 1), round(r_[1] - 6, 1)]
            w_['sign_size'] = [66, 18]
    out['furniture'] = furniture_log
    # standing points at the coffee machine, water server, vending machine, copier and printer: the free cell in front (never at a door, a queue's
    # place or on the same cell as another point), reachable from the entrance
    door_buf = set()
    for cells_ in room_cells.values():
        for x_, y_ in cells_:
            door_buf |= {(x_ + dx_, y_ + dy_) for dx_ in (-1, 0, 1) for dy_ in range(-2, 3)}
    for d_ in island_doors:
        door_buf |= {(c_[0] + dx_, c_[1] + dy_) for c_ in map(tuple, d_['tiles']) for dx_ in range(-2, 3) for dy_ in range(-1, 2)}
    door_buf |= {(x_, y_) for x_ in range(0, 4) for y_ in range(door_y - 1, door_y + DOOR_W + 1)}
    seen_all = reach_seen()
    stand_points, taken_pts = [], set()
    for f_ in furniture_log:
        if f_['part'] not in ('equip_coffee', 'equip_water', 'equip_vending', 'coffee_table', 'equip_mfp', 'equip_printer'):
            continue
        x_, y_ = f_['cells'][0]
        n_pt_ = 0
        fx_, fy_ = f_.get('front') or (0, 1)                                 # ★42: first the cells in front of what it faces (two rows), then its sides
        fc_ = {tuple(c0_) for c0_ in f_['cells']}
        if f_['part'] == 'coffee_table':
            fronts_ = [(x_ - 1, y_), (x_ - 1, y_ - 1), (x_ - 1, y_ + 1), (x_ + 1, y_), (x_ + 2, y_), (x_, y_ + 1), (x_, y_ - 1), (x_ - 2, y_)]
        else:
            fronts_ = [(c0_[0] + fx_ * k0_, c0_[1] + fy_ * k0_) for k0_ in (1, 2) for c0_ in sorted(fc_)]
            fronts_ += [(c0_[0] + fy_ * s0_, c0_[1] + fx_ * s0_) for s0_ in (1, -1) for c0_ in sorted(fc_)]
            fronts_ = [c0_ for c0_ in dict.fromkeys(fronts_) if c0_ not in fc_]
        for c_ in fronts_:
            if (c_ in occ or c_ in used or c_ in spawn or c_ in door_buf or c_ in taken_pts or not inner(*c_) or c_ not in seen_all or (L86 and c_[0] >= W - 2)
                    or any(abs(c_[0] - q_[0]) <= 0 and abs(c_[1] - q_[1]) <= 0 for q_ in used)):
                continue
            taken_pts.add(c_)
            stand_points.append({'for': f_['id'], 'part': f_['part'], 'tile': list(c_), 'xy': [round(v_, 1) for v_ in iso(c_[0] + .5, c_[1] + .5)],
                                 'facing': facing_to(c_, (x_, y_)), **({'room': f_['room']} if f_.get('room') else {})})
            n_pt_ += 1
            if n_pt_ >= (1 if (f_.get('room') or (L86 and f_['part'] in ('equip_coffee', 'equip_water'))) else 2 if f_['part'] in ('equip_coffee', 'equip_water', 'equip_vending', 'coffee_table') else 1):      # ★A3: two places in front of every drinks machine / at the standing table
                break
    # ★55-4: no café set (the round table, the high counter with its stools) and no stools in the open lobby: nobody sits on a break; a break is a
    # drink standing at the machine (the mod: no seat points, no sitting)
    seat_pts_ = []
    out['cafe'] = {}
    for q_ in seat_pts_:
        stand_points.append({'for': 'break', 'part': 'break_seat', 'seat': q_['seat'], 'tile': list(q_['cell']), 'xy': [round(v_, 1) for v_ in iso(q_['cell'][0] + .5, q_['cell'][1] + .5)],
                             'facing': facing_to(q_['cell'], q_['to']), **({'seat_on': True} if q_.get('on') else {})})
        used.add(q_['cell'])
    out['stand_points'] = stand_points
    # T3 (r38-exit, office-polish): no plant on the 4 cells next to a machine's standing point, nor over the picture of somebody standing there
    eq_pts_ = [tuple(q_['tile']) for q_ in stand_points if str(q_.get('part', '')).startswith('equip_')]
    near_pts_ = {(x_ + dx_, y_ + dy_) for x_, y_ in eq_pts_ for dx_, dy_ in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))}
    pt_boxes_ = [rect_at(c_, box_stand) for c_ in eq_pts_]
    for f_p in [f_ for f_ in furniture_log if f_['part'] == 'plant']:
        cs_ = [tuple(c_) for c_ in f_p['cells']]
        vr_ = [r_ for it_ in registry if it_['id'] == f_p['id'] for r_ in [visible_rect(it_)] if r_]
        if any(c_ in near_pts_ for c_ in cs_) or any(min(r_[2], q_[2]) - max(r_[0], q_[0]) > 1 and min(r_[3], q_[3]) - max(r_[1], q_[1]) > 1 for r_ in vr_ for q_ in pt_boxes_):
            for c_ in cs_:
                occ.pop(c_, None)
            registry[:] = [it_ for it_ in registry if it_['id'] != f_p['id']]
            furniture_log.remove(f_p)
    out['spots']['wave'] = {'tile': [2, door_y + 1], 'xy': [round(v_, 1) for v_ in iso(2.5, door_y + 1.5)], 'facing': facing_to((2, door_y + 1), (0, door_y + 1))}
    out['layout_queue'] = qline
    out['layout_boxes'] = {'stand': [round(v, 1) for v in box_stand], 'armchair': [round(v, 1) for v in box_arm], 'seat': [round(v, 1) for v in box_seat]}
    out['layout_arm'] = n_arm

    ls_ = list(spots['lounge'][:n_arm]) or [(lx0 + 1, lobby_y + 4), (lx0 + 4, lobby_y + 4)]      # the armchairs only: the standing places lie outside
    # the rug is the box of the places (armchairs and standing points) and one cell around it, nothing more
    rx0, rx1 = min(c_[0] for c_ in ls_) - 2, max(c_[0] for c_ in ls_) + 1      # an armchair's picture reaches 1-2 cells back: the rug covers all of it
    ry0, ry1 = min(c_[1] for c_ in ls_) - 2, max(c_[1] for c_ in ls_) + 1
    lounge_rug = [c_ for c_ in cells_rect(rx0, ry0, rx1 - rx0 + 1, ry1 - ry0 + 1) if floor_ok(*c_)]
    if lounge_rug:
        xs_, ys_ = [c_[0] for c_ in lounge_rug], [c_[1] for c_ in lounge_rug]
        x0_, x1_, y0_, y1_ = min(xs_), max(xs_) + 1, min(ys_), max(ys_) + 1
        if not (has_status and n_idle_ == 0):                    # ★57-3 (A10): no range when nobody waits
            rug_items.append(('lounge', 'lounge', list(lounge_rug), RUG_COLOR + (255,)))
        out.setdefault('lights', []).append({'island': 'lounge', 'at': [round(v_, 1) for v_ in iso((x0_ + x1_) / 2, (y0_ + y1_) / 2)],
                                             'size': [round(min(8, x1_ - x0_ + 2) * TW * K, 1), round(min(8, x1_ - x0_ + 2) * TH * K, 1)]})
        for z_ in out['zones']:
            if z_.get('key') == 'lounge':
                z_['tiles'] = [list(c_) for c_ in lounge_rug]
                z_['label'] = lounge_label_ or list(iso((x0_ + x1_) / 2, y1_ - .45, 0))   # ★52-2 (A10): on the rug's front edge (floor, inside the lounge, at the front row's feet; the back edge put it among the sitters' heads)
                if lounge_label_:
                    z_['label_group'] = True                       # ★65-1: the mod puts the name at `label` (not at the rug's front edge)

    # ---- the objects (cut into strips where they are long), and the baked picture kept for older mods
    def strips(item):
        im, foot, at, cells = item['im'], item['foot'], item['at'], item['cells']
        tlx, tly = at[0] - foot[0], at[1] - foot[1]
        ucells = {}
        for gx_, gy_ in cells:
            ucells.setdefault(gx_ - gy_, []).append(gx_ + gy_)
        if len(ucells) <= 1 or item['kind'] in ('chair', 'plant', 'trash', 'prop'):
            return [(im, tlx, tly, max(gx_ + gy_ for gx_, gy_ in cells), 0)]
        wstrip = (TW / 2) * K
        base = ox * K
        pieces_ = []
        u0, u1 = math.floor((tlx - base) / wstrip + .5), math.floor((tlx + im.width - base) / wstrip + .5)
        for u in range(u0, u1 + 1):
            xl = max(round(tlx), round(base + (u - .5) * wstrip))
            xr_ = min(round(tlx) + im.width, round(base + (u + .5) * wstrip) + 1)     # ★70-1: 1 px over the next strip (the same pixels): no seam when the App zooms
            if xr_ - xl < 1:
                continue
            piece_ = im.crop((xl - round(tlx), 0, xr_ - round(tlx), im.height))
            if piece_.getchannel('A').getbbox() is None:
                continue
            near = min(ucells, key=lambda uc: (abs(uc - u), -max(ucells[uc])))
            pieces_.append((piece_, xl, tly, max(ucells[near]), len(pieces_)))
        return pieces_

    objects = []
    # rugs: painted into the background as ONE seamless shape per rug (a mask of all its cells: no lines between cells, no darker overlaps).
    # The background goes out in 256 x 256 pieces named by content, so a rug that changes makes new pieces only where it lies.
    layer = Image.new('RGBA', bg.size, (0, 0, 0, 0))
    for kind_, key_, cells_, col_ in rug_items:
        mask_ = Image.new('L', bg.size, 0)
        md_ = ImageDraw.Draw(mask_)
        for gx_, gy_ in cells_:
            md_.polygon([iso(gx_, gy_), iso(gx_ + 1, gy_), iso(gx_ + 1, gy_ + 1), iso(gx_, gy_ + 1)], fill=255)
        solid_ = Image.new('RGBA', bg.size, tuple(col_[:3]) + (0,))
        solid_.putalpha(mask_.point(lambda v_, a_=col_[3]: v_ * a_ // 255))
        layer = Image.alpha_composite(layer, solid_)
    out['rugs'] = []                                         # (older: one picture per cell; now in the background)
    bg = Image.alpha_composite(bg, layer)
    bg_full = bg
    baked = bg_full.copy()
    piece_of = {}                                             # ★56-2 (office-perf2) object id -> (picture, x, y) for the depth bands below
    for item in sorted(registry, key=lambda i: (max((c[0] + c[1] for c in i['cells']), default=0), i['seq'])):
        if item['im'] is None:
            continue
        for piece_, px_, py_, depth_, n_ in strips(item):
            baked.alpha_composite(piece_, (round(px_), round(py_)))
            piece_of[f'{item["id"]}:{n_}'] = (piece_, round(px_), round(py_))
            objects.append({'id': f'{item["id"]}:{n_}', 'kind': item['kind'], 'file': rel(write_png(out_dir / 'scaled', 'obj6', piece_)),
                            'rect': [round(px_, 1), round(py_, 1), piece_.width, piece_.height], 'depth': depth_,
                            'tiles': [list(c_) for c_ in item['cells']]})
    # ★83-2: a thing back to back with a partition stands in front of every piece of that partition behind it: a piece one cell to the right along the
    # partition has a larger x + y and was drawn over the thing's side (the glass across the file cabinet). Only the strips that meet such a piece
    # on screen go up, just above it (+0.05: a person on the cell in front, at x + y + 1, still comes later).
    for o_ in objects:
        oid_ = o_['id'].rsplit(':', 1)[0]
        if oid_ not in back_part_ids:
            continue
        ys0_, xs0_ = min(c_[1] for c_ in o_['tiles']), min(c_[0] for c_ in o_['tiles'])
        fl_ = next((f_['front'] == [1, 0] for f_ in furniture_log if f_['id'] == oid_), False)
        r0_ = o_['rect']
        for p_ in objects:
            if p_['kind'] != 'partition' or p_['depth'] < o_['depth']:
                continue
            if not all((c_[0] < xs0_) if fl_ else (c_[1] < ys0_) for c_ in p_['tiles']):
                continue
            r1_ = p_['rect']
            if min(r0_[0] + r0_[2], r1_[0] + r1_[2]) - max(r0_[0], r1_[0]) > 0 and min(r0_[1] + r0_[3], r1_[1] + r1_[3]) - max(r0_[1], r1_[1]) > 0:
                o_['depth'] = round(p_['depth'] + .05, 2)
    objects.sort(key=lambda o: o['depth'])
    # ★56-2 (office-perf2) the furniture that never moves, baked into one picture per depth and per touching group: the mod draws
    # these few pictures where it drew hundreds of objects, and puts the people between them by the same depth as before (an object's
    # depth is a whole number, and everything of one depth is drawn together anyway, in this list's order). Seats that a sitting person
    # replaces (chair, armchair, sofa) and the doorways stay single. Names come from the pixels: a plan that keeps a group keeps its file.
    bands = []
    by_depth = {}
    for o_ in objects:
        if o_['kind'] not in ('chair', 'armchair', 'sofa') and not o_['id'].startswith('doorway:') and o_['id'] in piece_of:
            by_depth.setdefault(o_['depth'], []).append(o_)
    for depth_, group_ in sorted(by_depth.items()):
        spans_ = []                                           # [x0, x1, [objects]] side by side, merged where they touch
        for o_ in sorted(group_, key=lambda q_: piece_of[q_['id']][1]):
            im_, x_, y_ = piece_of[o_['id']]
            if spans_ and x_ <= spans_[-1][1] + TW * K * 8:       # a gap is clear (it covers nothing): up to 8 tiles are joined (demo 20: 297 things -> ~60 pictures, ~2.5 Mpx)
                spans_[-1][1] = max(spans_[-1][1], x_ + im_.width)
                spans_[-1][2].append(o_)
            else:
                spans_.append([x_, x_ + im_.width, [o_]])
        for x0_, x1_, members_ in spans_:
            members_.sort(key=lambda q_: group_.index(q_))    # drawn in the order the mod drew them one by one
            y0_ = min(piece_of[q_['id']][2] for q_ in members_)
            y1_ = max(piece_of[q_['id']][2] + piece_of[q_['id']][0].height for q_ in members_)
            band_im = Image.new('RGBA', (x1_ - x0_, y1_ - y0_), (0, 0, 0, 0))
            for q_ in members_:
                im_, x_, y_ = piece_of[q_['id']]
                band_im.alpha_composite(im_, (x_ - x0_, y_ - y0_))
            M_ = 2                                            # ★62-2 a clear margin: zoomed, the App smears the outer pixel of a picture (thin lines at the furniture's edges)
            band_m_ = Image.new('RGBA', (band_im.width + 2 * M_, band_im.height + 2 * M_), (0, 0, 0, 0)); band_m_.paste(band_im, (M_, M_))
            bands.append({'depth': depth_, 'file': rel(write_png(out_dir / 'scaled', 'band', band_m_)), 'rect': [x0_ - M_, y0_ - M_, x1_ - x0_ + 2 * M_, y1_ - y0_ + 2 * M_],
                          'ids': [q_['id'] for q_ in members_]})
    out['object_bands'] = bands
    for f_ in furniture_log:                                  # the server rack's lights (pixels in the scene): the mod lays small lights on them
        if f_.get('leds'):
            for o_ in objects:
                if o_['id'].rsplit(':', 1)[0] == f_['id'] or o_['id'] == f_['id']:
                    o_['leds'] = f_['leds']
    out['objects'] = objects

    # ---- spots with their cells; the walkable map
    def spot(c_):
        return {'tile': [c_[0], c_[1]], 'xy': list(iso(c_[0] + .5, c_[1] + .5))}
    for kind in ('approval', 'counter', 'lounge'):
        out['spots'][kind] = [dict(spot(c_), **({'seat': ('armchair' if i_ < n_arm else None), 'object': None, 'bring_chair': i_ < n_arm, **({'facing': lounge_facing[tuple(c_)]} if i_ < n_arm and tuple(c_) in lounge_facing else {})} if kind == 'lounge' else {'facing': facing_to(c_, (out['windows'].get(kind) or {}).get('chair_tile') or (c_[0], D_in))})) for i_, c_ in enumerate(spots[kind])]  # ★26-2: the first places are sitting points (the person's picture brings the chair, no furniture is placed); the rest are standing points
    for k_, c_ in list(out['spots']['rooms'].items()):
        out['spots']['rooms'][k_] = dict(spot(c_), cells=[list(q_) for q_ in room_cells.get(k_, [c_])])
    # the people who gave their seat up (waiting more than seat_hold_min) have a place each in the lounge: an index into spots.lounge, never the same one
    out['seatless_place'] = {aid_: min(i_, max(0, len(out['spots']['lounge']) - 1)) for i_, aid_ in enumerate(out_seatless)}
    out['spots']['facing'] = 'front'                         # the queues face the viewer
    out['grid'] = {'origin': [round(ox * K, 1), round(oy * K, 1)], 'tw': round(TW * K, 2), 'th': round(TH * K, 2), 'cols': W, 'rows': D,
                   # ★30-2/★31-3: right outer wall blocks walking only on the island band (lobby / lounge may use that column)
                   'walk': [''.join('#' if (x_, y_) in occ or not floor_ok(x_, y_) or x_ == 0 or y_ == 0 or (x_ == band_w - 1 and y_ < lobby_y) else '.' for x_ in range(W)) for y_ in range(D)],
                   'floor': [''.join('1' if floor_ok(x_, y_) else '0' for x_ in range(W)) for y_ in range(D)]}
    # ★16-8/9: the island plates lie in the aisle in front of their island (centre of the aisle row), slid along the front edge until the plate hides no
    # person and no other plate / the approval card / the entrance label; the entrance label hangs above the door
    if out.get('door'):
        dr_ = out['door']['rect']
        ll_ = iso(3.6, door_y + DOOR_W - DOOR_SEG - 4.2)     # ★27-3 (A10): where it was before the double door (it would block the left room's plate); ★A3 review 11: on the floor in front of the door, at the feet of the people waiting there
        out['door']['label_at'] = [round(ll_[0], 1), round(ll_[1] + 6, 1)]
    # ★A3: the card is placed first (the big one if there is any room); if that leaves an island without a plate, again with room kept for the plates
    noplate_ = set()
    for reserve_ in (0, 1):
        # ★16-2: the approval card on the lobby floor: clear of the islands, both desks, the people of both queues and the entrance label; no room: small, over the desk's head
        ap_ = (out.get('windows') or {}).get('approval')
        for k_ in ('card_small', 'card_fallback', 'card_tail'):
            (ap_ or {}).pop(k_, None)
        if ap_ and ap_.get('card_at'):
            extra_ = [(w_['rect'][0], w_['rect'][1], w_['rect'][0] + w_['rect'][2], w_['rect'][1] + w_['rect'][3]) for w_ in out['windows'].values()]
            extra_ += [(o_['rect'][0], o_['rect'][1], o_['rect'][0] + o_['rect'][2], o_['rect'][1] + o_['rect'][3]) for o_ in out.get('objects', [])
                       if o_['kind'] not in ('partition', 'prop', 'window', 'pole') and o_.get('rect')]
            extra_ += [(sp_['xy'][0] - 15, sp_['xy'][1] - 42, sp_['xy'][0] + 15, sp_['xy'][1] + 3) for sp_ in out['spots'].get('lounge', [])[:(out.get('layout_clear') or {}).get('lounge', 0)]]
            qn_ = {'approval': sum(1 for a2_ in agents if a2_.get('status') == 'blocked'), 'counter': sum(1 for a2_ in agents if a2_.get('status') == 'done')}   # who stands in the two lines now
            for kd_ in ('approval', 'counter'):
                ap_['queue_n' if kd_ == 'approval' else 'queue_n_counter'] = min(qn_[kd_], QCLEAR)
                extra_ += [(sp_['xy'][0] - 15, sp_['xy'][1] - 42, sp_['xy'][0] + 15, sp_['xy'][1] + 3) for sp_ in out['spots'].get(kd_, [])[:min(qn_[kd_], QCLEAR)]]
            if out.get('door') and out['door'].get('label_at'):
                lx_, ly_ = out['door']['label_at']
                extra_.append((lx_ - 36, ly_ - 9, lx_ + 36, ly_ + 9))
            for i2_ in [i3_ for i3_ in out['islands'] if i3_['key'] in noplate_]:             # ★A3: (2nd pass only) room is kept for each island's small plate, in the middle of its front edge
                I2_ = islands[i2_['key']]
                for u2_ in range(I2_['x'], I2_['x'] + I2_['w'] + 1, 2):             # the whole front edge of an island that found no room for its plate (the card steps aside)
                    pa_ = iso(u2_, I2_['y'] + I2_['h'] + .55)
                    extra_.append((pa_[0] - PLATE_W_S / 2, pa_[1] - PLATE_H / 2, pa_[0] + PLATE_W_S / 2, pa_[1] + PLATE_H / 2))
            for st2_ in out['seats'].values():
                extra_.append((st2_['xy'][0] - 15, st2_['xy'][1] - 42, st2_['xy'][0] + 15, st2_['xy'][1] + 3))
                lr2_ = (st2_['laptop'].get('rects') or {}).get('on')
                if lr2_:
                    extra_.append((lr2_[0], lr2_[1], lr2_[0] + lr2_[2], lr2_[1] + lr2_[3]))
            spot_, ap_['card_size'] = None, list(CARD_SMALL)
            for csz_ in ((CARD_W, CARD_H), (CARD_W2, CARD_H)):                # ★A3: the big card (heading + the request's line + the button); a bit narrower if it must; only then the small one
                spot_ = card_spot(ap_['rect'], ap_['rect'][2], extra_, csz_)
                if spot_:
                    ap_['card_size'] = list(csz_)
                    break
            if spot_:
                ap_['card_at'], ap_['card_small'] = spot_, False
                ap_['card_tail'] = [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] + 2, 1)]     # the speech bubble's tail points at the desk
            elif card_spot(ap_['rect'], ap_['rect'][2], extra_, CARD_SMALL):      # a small card, as near as there is room
                ap_['card_at'], ap_['card_small'] = card_spot(ap_['rect'], ap_['rect'][2], extra_, CARD_SMALL), True
                ap_['card_tail'] = [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] + 2, 1)]
            elif (fine_ := card_spot(ap_['rect'], ap_['rect'][2], extra_, CARD_SMALL, step=1)):   # ★A9: the 3 px steps can jump a narrow gap (12 people / 4 spaces: just above the entrance's label)
                ap_['card_at'], ap_['card_small'] = fine_, True
                ap_['card_tail'] = [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] + 2, 1)]
            elif (least_ := card_least(ap_['rect'], ap_['rect'][2], extra_, [(w_['rect'][0], w_['rect'][1], w_['rect'][0] + w_['rect'][2], w_['rect'][1] + w_['rect'][3]) for w_ in out['windows'].values()]
                                       + ([(out['door']['label_at'][0] - 36, out['door']['label_at'][1] - 9, out['door']['label_at'][0] + 36, out['door']['label_at'][1] + 9)] if (out.get('door') or {}).get('label_at') else []))):
                # ★A8/A9: no clear place (a crowded lounge, e.g. 60 people): never over the entrance's label or a window desk, and over as few people as there may be
                ap_['card_at'], ap_['card_small'], ap_['card_fallback'] = least_, True, True
                ap_['card_tail'] = [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] + 2, 1)]
            else:                                                       # a small card right over the desk's head (the nearest place on the drawn picture, whatever is there)
                ap_['card_at'] = card_spot(ap_['rect'], ap_['rect'][2], (), CARD_SMALL) or [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] - 4, 1)]
                ap_['card_small'] = True
                ap_['card_fallback'] = True                                # no clear place at all: right over the desk, whatever is there
                ap_['card_tail'] = [round(ap_['rect'][0] + ap_['rect'][2] / 2, 1), round(ap_['rect'][1] + 2, 1)]
        hard = []                                                     # the card and the entrance label: no plate on them
        ap_ = (out.get('windows') or {}).get('approval')
        if ap_ and ap_.get('card_at'):
            cx_, cy_ = ap_['card_at']
            cw2_, ch2_ = ap_['card_size']
            hard.append((cx_ - cw2_ / 2, cy_ - ch2_, cx_ + cw2_ / 2, cy_))
        if out.get('door') and out['door'].get('label_at'):
            lx_, ly_ = out['door']['label_at']
            hard.append((lx_ - 36, ly_ - 9, lx_ + 36, ly_ + 9))
        hard += [(w_['rect'][0], w_['rect'][1], w_['rect'][0] + w_['rect'][2], w_['rect'][1] + w_['rect'][3]) for w_ in out['windows'].values()]     # nor on the two window desks
        hard += [(o_['rect'][0], o_['rect'][1], o_['rect'][0] + o_['rect'][2], o_['rect'][1] + o_['rect'][3]) for o_ in out.get('objects', []) if o_['kind'] in ('reception', 'sofa', 'armchair', 'storage', 'equipment') and o_.get('rect')]
        plants_ = [(o_['rect'][0], o_['rect'][1], o_['rect'][0] + o_['rect'][2], o_['rect'][1] + o_['rect'][3]) for o_ in out.get('objects', []) if o_['kind'] == 'plant' and o_.get('rect')]
        heads_ = {}                                                   # island key -> the boxes of its own people and laptops (a plate must never hide these)
        for sid_, st_ in out['seats'].items():
            x_, y_ = st_['xy']
            lst_ = heads_.setdefault(st_['island'], [])
            lst_.append((x_ - 15, y_ - 42, x_ + 15, y_ + 3))
            lr_ = (st_['laptop'].get('rects') or {}).get('on')
            if lr_:
                lst_.append((lr_[0], lr_[1], lr_[0] + lr_[2], lr_[1] + lr_[3]))
        placed_ = []
        o0_, e1_, e2_ = iso(0, 0), iso(1, 0), iso(0, 1)
        m11_, m12_, m21_, m22_ = e1_[0] - o0_[0], e2_[0] - o0_[0], e1_[1] - o0_[1], e2_[1] - o0_[1]
        det_ = m11_ * m22_ - m12_ * m21_

        def floor_xy(px_, py_):                                         # the cell coordinates of a screen point taken on the floor plane
            dx_, dy_ = px_ - o0_[0], py_ - o0_[1]
            return ((dx_ * m22_ - dy_ * m12_) / det_, (m11_ * dy_ - m21_ * dx_) / det_)

        def off_walls(b_):                                              # ★16: a plate's corners lie on the floor side of both outer walls' foot lines
            return all(min(floor_xy(x_, y_)) >= .3 for x_ in (b_[0], b_[2]) for y_ in (b_[1], b_[3]))

        def ov_(a_, b_):
            return max(0.0, min(a_[2], b_[2]) - max(a_[0], b_[0])) * max(0.0, min(a_[3], b_[3]) - max(a_[1], b_[1]))
        for isl_ in sorted(out['islands'], key=lambda i_: (islands[i_['key']]['y'], islands[i_['key']]['x'])):
            I_ = islands[isl_['key']]
            own_ = heads_.get(isl_['key'], [])
            others_ = [b_ for k_, l_ in heads_.items() if k_ != isl_['key'] for b_ in l_]
            best_ = None
            nmw_ = sum(12 if ord(c_) > 255 else 7 for c_ in str(isl_.get('title', ''))[:6])      # ★A3: the plate's real width: badge + name + "N人" (+ the 承認 chip), as C / the preview draw it
            chip_ = 50 if any(m_.get('status') == 'blocked' for m_ in islands[isl_['key']]['members']) else 0      # the 承認 chip is drawn only when somebody waits for an approval
            pw_s_, pw_f_ = 8 + 26 + 6 + nmw_ + 8 + 36 + 8, 8 + 26 + 6 + nmw_ + 8 + 36 + chip_ + 8
            aisle_plate_ = isl_['key'] in stacked_front                   # ★31-3: shares its front wall — no lobby-side aisle for a plate
            if L86:                                                       # ★100-2 the room's name just outside its aisle-side entrance (the opening), never over the doorway
                best95_ = None
                op_ = [tuple(c_) for c_ in (isl_.get('open_cells') or [])]
                for sz95_ in ((pw_f_ + 6, PLATE_H), (8 + 26 + 6 + nmw_ + 8 + 6, PLATE_H)):
                    for (cx_, cy_) in op_:
                        for dx_, dy_ in ((1.35, .25), (1.75, .15), (1.15, .75), (2.2, .25), (.95, -.35), (1.35, -.55)):
                            at_ = iso(cx_ + dx_, cy_ + dy_)
                            b_ = (at_[0] - sz95_[0] / 2, at_[1] - sz95_[1] / 2, at_[0] + sz95_[0] / 2, at_[1] + sz95_[1] / 2)
                            if b_[0] < 0 or b_[2] > width or b_[1] < 0 or b_[3] > height or not off_walls(b_) or any(ov_(b_, q_) > 0 for q_ in hard + plants_ + placed_ + own_):
                                continue
                            cost_ = sum(ov_(b_, q_) for q_ in others_)
                            if best95_ is None or cost_ < best95_[0]:
                                best95_ = (cost_, at_, b_, cx_ + dx_ + cy_ + dy_ + 1.0, sz95_)
                            if cost_ == 0:
                                break
                        if best95_ and best95_[0] == 0:
                            break
                    if best95_:
                        break
                if best95_:
                    isl_['plate'] = {'at': [round(best95_[1][0], 1), round(best95_[1][1], 1)], 'depth': round(best95_[3], 2), 'size': list(best95_[4]), 'behind': best95_[0] > 0}
                    placed_.append(best95_[2])
                else:
                    isl_.pop('plate', None)
                continue
            if aisle_plate_ and not L86:                                  # (★88-6: with L86 every room's plate hangs inside the room, at its back)
                isl_.pop('plate', None)                                   # ★31-3: skip plate (middle aisle is too tight for 2 columns × N rows)
                continue
            # ★52-5 (A10): first the plates that hide no plant, inside the room's own span (a little further into the aisle allowed); then as before
            span_ = I_['w'] / 2
            in_dvs_ = tuple(-(I_['h'] - d_) for d_ in (1.5, 1.1, 1.9, 2.3, 0.8, 2.7, 3.1, 3.5, 3.9, 4.3, 4.7)) if L86 else ()      # ★88-6: with L86 the plate hangs inside its own room at the back (never on the lobby floor away from the room)
            in_plans_ = (((pw_f_ + 6, PLATE_H), hard + plants_, span_, in_dvs_), ((pw_s_ + 6, PLATE_H), hard + plants_, span_, in_dvs_), ((8 + 26 + 6 + nmw_ + 8 + 6, PLATE_H), hard, span_ + 4, in_dvs_)) if L86 else ()
            for sz_, hd_, lim_, dvs_ in in_plans_ + (() if L86 else (((pw_f_ + 6, PLATE_H), hard + plants_, span_, (.7, .9, .55, 1.0)), ((pw_s_ + 6, PLATE_H), hard + plants_, span_, (.7, .9, .55, 1.0)),
                                         ((pw_f_ + 6, PLATE_H), hard, 99, (.7, .9, .55, 1.0)), ((pw_s_ + 6, PLATE_H), hard, 99, (.7, .9, .55, 1.0)), ((8 + 26 + 6 + nmw_ + 8 + 6, PLATE_H), hard, 99, (.7, .9, .55, 1.0)))):   # the full plate, one without the chip, then the name only (★91 with L86 only the plates inside the room; the mod hangs the rest inside, fillPlates)
                for du_ in [0] + [q_ * sg_ for q_ in range(1, 60) for sg_ in (1, -1)]:
                    u_ = I_['x'] + I_['w'] / 2 + du_ * 1.0
                    if not (I_["x"] - 6 <= u_ <= I_["x"] + I_["w"] + 6) or abs(du_) > lim_:     # ★A3: along the front edge, not past its ends
                        continue
                    for dv_ in dvs_:                                 # ★A4 (d): on the aisle side of the front partition (half a cell or more), so the partition never hides the name;                   # within one cell of the front edge; the island's own floor / partitions may lie under it
                        at_ = iso(u_, I_['y'] + I_['h'] + dv_)
                        b_ = (at_[0] - sz_[0] / 2, at_[1] - sz_[1] / 2, at_[0] + sz_[0] / 2, at_[1] + sz_[1] / 2)
                        if L86 and dvs_ == in_dvs_:                                    # ★91: the plate's centre lies on the room's own floor (never out in the aisle)
                            gx_p, gy_p = floor_xy(at_[0], at_[1])
                            if not (I_['x'] + 1.5 <= gx_p <= I_['x'] + I_['w'] - 1.5 and I_['y'] + 1 <= gy_p <= I_['y'] + I_['h'] - 1):
                                continue
                        if b_[0] < 0 or b_[2] > width or b_[1] < 0 or b_[3] > height or not off_walls(b_) or any(ov_(b_, q_) > 0 for q_ in hd_ + placed_ + own_):
                            continue
                        cost_ = sum(ov_(b_, q_) for q_ in others_)       # somebody of another island seen behind the plate: the least of those
                        if best_ is None or cost_ < best_[0]:
                            best_ = (cost_, at_, b_, u_ + I_['y'] + I_['h'] + dv_, sz_)
                        if cost_ == 0:
                            break
                    if best_ and best_[0] == 0:
                        break
                if best_:
                    break
            if best_:
                isl_['plate'] = {'at': [round(best_[1][0], 1), round(best_[1][1], 1)], 'depth': round(best_[3], 2), 'size': list(best_[4]), 'behind': best_[0] > 0}
                placed_.append(best_[2])
            else:                                                       # nowhere clear: no plate (C draws none), better than one that hides somebody
                isl_.pop('plate', None)
        # ★31-3: stacked (front=='aisle') islands omit plates on purpose — not a “no room” case for the card's second pass
        noplate_ = {i_['key'] for i_ in out['islands']
                    if not i_.get('plate') and not (isinstance(i_.get('front'), list) and len(i_['front']) >= 4 and i_['front'][3] == 'aisle')}
        if reserve_ == 1 or not noplate_ or not 1 < len(out['islands']) <= 6:
            break
    out['layout'] = {'objects': len(registry), 'warnings': warnings, 'clear': out.pop('layout_clear', {}), 'armchairs': out.pop('layout_arm', 0), 'boxes': out.pop('layout_boxes', {}), 'queue': out.pop('layout_queue', {})}
    out['background'] = rel(write_png(out_dir, 'bg', bg_full))      # whole picture, kept for older mods
    # ★62-2 each piece carries BLEED px of its neighbours on every side ('bleed'): the App smears a picture's outer pixel when it zooms it, which showed every
    # seam as a thin grey line; the mod cuts the piece back to 'rect' with a clip, so the smeared border lies outside what is seen.
    BLEED = 2
    tiles = []                                               # the background in 256 x 256 pieces named by their content: what does not change keeps its name
    for ty_ in range(0, height, 256):
        for tx_ in range(0, width, 256):
            core_ = (tx_, ty_, min(tx_ + 256, width), min(ty_ + 256, height))
            if bg.crop(core_).getchannel('A').getbbox() is None:
                continue
            piece_ = bg.crop((core_[0] - BLEED, core_[1] - BLEED, core_[2] + BLEED, core_[3] + BLEED))
            tiles.append({'file': rel(write_png(out_dir / 'scaled', 'bgt', piece_)), 'rect': [tx_, ty_, core_[2] - core_[0], core_[3] - core_[1]], 'bleed': BLEED})
    out['background_tiles'] = tiles
    shades = []                                              # the same pieces as one dark navy where the background is opaque: the mod lays it at the hour's opacity
    for t_ in tiles:                                         # (it depends on the floor's shape only, not on rugs: it changes only when the floor does)
        rx_, ry_, rw_, rh_ = t_['rect']
        alpha_ = bg.crop((rx_ - BLEED, ry_ - BLEED, rx_ + rw_ + BLEED, ry_ + rh_ + BLEED)).getchannel('A').point(lambda v_: 255 if v_ > 127 else 0)
        sh_ = Image.new('RGBA', (rw_ + 2 * BLEED, rh_ + 2 * BLEED), (12, 20, 52, 0))
        sh_.putalpha(alpha_)
        shades.append({'file': rel(write_png(out_dir / 'scaled', 'shade', sh_)), 'rect': t_['rect'], 'bleed': BLEED})
    out['shade_tiles'] = shades
    out['scene_id'] = Path(out['background']).stem.split('-')[-1]      # changes whenever the floor is different: lets the mod drop a stale scene
    if debug:
        dbg = bg.copy()
        dd = ImageDraw.Draw(dbg, 'RGBA')
        owners = {}
        for y_ in range(D):
            for x_ in range(W):
                if not floor_ok(x_, y_):
                    continue
                quad = [iso(x_, y_), iso(x_ + 1, y_), iso(x_ + 1, y_ + 1), iso(x_, y_ + 1)]
                if (x_, y_) in occ:
                    col = owners.setdefault(occ[(x_, y_)].split(':')[0], (230, 70, 70, 120))
                    dd.polygon(quad, fill=col, outline=(120, 20, 20, 200))
                else:
                    dd.polygon(quad, outline=(40, 120, 60, 110))
        for kind, col in (('approval', (245, 158, 11, 255)), ('counter', (34, 197, 94, 255)), ('lounge', (60, 120, 255, 255))):
            for s_ in out['spots'][kind]:
                p = s_['xy']
                dd.ellipse([p[0] - 5 * K, p[1] - 5 * K, p[0] + 5 * K, p[1] + 5 * K], fill=col)
        for dsk_ in out['desks'].values():
            p = iso(dsk_['seat_tile'][0] + .5, dsk_['seat_tile'][1] + .5)
            dd.ellipse([p[0] - 5 * K, p[1] - 5 * K, p[0] + 5 * K, p[1] + 5 * K], fill=(250, 220, 40, 255))
        out['debug_overlay'] = rel(write_png(out_dir, 'debug', dbg))

    # ---- people: with --box the pictures are redrawn at the floor's scale (placed 1:1 by the mod, no blur)
    factor = PK * person_k(K)                                # made at the step at or above K; drawn at pose_size (K) by the mod: the App shrinks them
    native = bool(view)

    def at_scale(v):
        if isinstance(v, (list, tuple)):
            return [at_scale(x) for x in v]
        if isinstance(v, dict):                              # walk_gif, flip, ...: the sprites module's own groups
            return {k_: at_scale(x) for k_, x in v.items()}
        if not isinstance(v, str) or not v.endswith('.png'):
            return v                                         # GIFs are left as they are
        return person_file(out_dir, v, factor) if native else v

    people = {a['id']: {pose: at_scale(v) for pose, v in person_cache(a['id']).items()} for a in agents if person_cache(a['id'])}   # nobody without pictures of their own (never another person's)
    pose_size = {}
    for files in people.values():
        for pose, rel_ in files.items():
            if pose not in pose_size and (isinstance(rel_, str) or (isinstance(rel_, list) and rel_ and isinstance(rel_[0], str))):
                im = open_png(rel_[0] if isinstance(rel_, (list, tuple)) else rel_)
                f_ = K / person_k(K) if native else PK         # the size it is drawn at (K), from the picture made at the step
                pose_size[pose] ={'w': round(im.width * f_, 1), 'h': round(im.height * f_, 1)}
        break
    out['people'] = people
    out['people_scale'] = 1.0 if native else PK
    out['native'] = native
    out['scale'] = K
    out['pose_size'] = pose_size
    stand = pose_size.get('stand') or next(iter(pose_size.values()), {'w': 30, 'h': 90})
    out['sprite'] = {'w': stand['w'], 'h': stand['h']}
    if 'shadow' in parts:                                   # soft ellipse under the feet (centre = the foot point)
        sw = max(8, round(stand['w'] * .55))
        sh = max(3, round(sw * parts['shadow']['h'] / parts['shadow']['w']))
        out['sprite']['shadow'] = {'file': part_file(out_dir, parts, 'shadow', sw, sh), 'w': sw, 'h': sh,
                                   'foot': [sw / 2, sh / 2]}
    if lobby_short_ and len(agents) <= 15 and ((out.get('windows') or {}).get('approval') or {}).get('card_small'):
        out['_lobby_retry'] = True                            # ★57-3 (A12): the shallower lobby left no room for the big card (15 or fewer people): main() builds again deeper
    if L86:                                                   # ★86: no approval desk / submit counter / break room any more: the mod draws nothing for them (their signs, desks, labels)
        out['windows'] = {}
        out['zones'] = [z_ for z_ in out.get('zones', []) if z_.get('key') not in ('approval', 'counter', 'lounge')]
        warnings[:] = [w_ for w_ in warnings if not str(w_).startswith(('window:', 'approval', 'counter', 'lounge'))]       # ★88-1: nothing of them is drawn: their cells need no warning
    return baked, Image.new('RGBA', (1, 1), (0, 0, 0, 0)), None, out


def scaled_gif(out_dir, part, size):
    """The scrolling-code GIF (a part of the sheet) resized to the screen's size, once. Every frame keeps a 1-bit
    transparency (the alpha cut at 50% after the resize, so the screen's shape stays and nothing turns into a black
    rectangle). Falls back to None."""
    try:
        from PIL import ImageSequence, ImageOps
        path = out_dir / 'scaled' / f'screen-scroll-v2-{Path(part["file"]).stem}-{size[0]}x{size[1]}.gif'
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            src = Image.open(APP_HOME / part['file'])
            frames, durations = [], []
            for f in ImageSequence.Iterator(src):
                rgba = f.convert('RGBA').resize(size, Image.LANCZOS)
                alpha = rgba.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
                pal = Image.new('RGB', size, (0, 0, 0))
                pal.paste(rgba.convert('RGB'), mask=alpha)
                pal = pal.quantize(255)                        # indices 0..254; 255 stays free for "transparent"
                pal.paste(255, mask=ImageOps.invert(alpha))
                frames.append(pal)
                durations.append(f.info.get('duration', src.info.get('duration', 100)))
            frames[0].save(path, save_all=True, append_images=frames[1:], loop=0, disposal=2, transparency=255,
                           duration=durations)
        return rel(path)
    except Exception:
        return None


def write_png(out_dir, prefix, im):
    """Save with a name from the pixels' hash; nothing is encoded when the file already exists."""
    p = out_dir / f'{prefix}-{hashlib.sha1(f"{im.mode}{im.size}".encode() + im.tobytes()).hexdigest()[:10]}.png'
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f'{p.stem}.{os.getpid()}.tmp')
        im.save(tmp, 'PNG', compress_level=3)
        replace_or_keep(tmp, p)
    else:
        try:                                                   # ★72-1: used again = new: the prunes (oldest first, and the tests' tidy-up) never take a picture a scene uses now
            os.utime(p)
        except OSError:
            pass
    return p


_MARGIN_MEMO = {}


def clear_margin(out_dir, file_, rect_, m=2):
    """★62-2 the same picture with m clear pixels round it, and its rect grown by m on every side (nothing moves on screen)."""
    key_ = (file_, m)
    if key_ not in _MARGIN_MEMO:
        src_ = Image.open(APP_HOME / file_).convert('RGBA')
        big_ = Image.new('RGBA', (src_.width + 2 * m, src_.height + 2 * m), (0, 0, 0, 0)); big_.paste(src_, (m, m))
        _MARGIN_MEMO[key_] = rel(write_png(out_dir / 'scaled', 'wm', big_))
    return _MARGIN_MEMO[key_], [rect_[0] - m, rect_[1] - m, rect_[2] + 2 * m, rect_[3] + 2 * m]


def replace_or_keep(tmp, path):
    """os.replace, but when another run (the apart warm, a second plan) holds or has just written the same name, the file that is there is kept
    (the names carry the content, so it is the same thing) and the temporary one is dropped. Only a missing target is an error."""
    try:
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        if not path.exists():
            raise


def rel(p):
    try:
        return p.relative_to(APP_HOME).as_posix()
    except ValueError:
        return str(p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--agents', default='')
    ap.add_argument('--out', type=Path, default=OUT_DIR)
    ap.add_argument('--demo', action='store_true', help='demo data: never read or write desks.json')
    ap.add_argument('--box', default='')
    ap.add_argument('--config', default='', help='office config JSON: rooms, spare_desks')
    ap.add_argument('--now', type=float, default=None)
    ap.add_argument('--warm', action='store_true', help='build the sprite pack and the people for these agents (no output; the apart run after a version change)')
    ap.add_argument('--max-seconds', type=float, default=0, help='stop this run after so many seconds (the apart warm run: 300)')
    ap.add_argument('--warm-last', action='store_true', help='--warm for the agents of the last run (install does this once)')
    ap.add_argument('--debug', action='store_true', help='also write debug_overlay: the grid, the cells things occupy and the spots')
    ns = ap.parse_args(argv)
    if ns.warm_last:                                          # the agents / box / options of the last normal run
        try:
            last = json.loads((ns.out / 'warm-args.json').read_text(encoding='utf-8'))
            ns.agents, ns.box, ns.config, ns.demo = last['agents'], last.get('box', ''), last.get('config', ''), last.get('demo', False)
        except (OSError, ValueError, KeyError):
            return 0
        ns.warm = True
    if ns.agents.startswith('@'):
        ns.agents = Path(ns.agents[1:]).read_text(encoding='utf-8')
    if ns.max_seconds > 0:                                  # a limit on time (and so on memory): the process ends itself, the lock is cleaned by its age
        import threading
        _t_ = threading.Timer(ns.max_seconds, lambda: os._exit(3))
        _t_.daemon = True
        _t_.start()
    if ns.warm:
        os.environ['HERDR_OFFICE_WARM'] = '1'
        global WARM, TIME_BUDGET, BUILD_BANDS
        WARM, TIME_BUDGET, BUILD_BANDS = True, 1e9, True      # (BUILD_BANDS was decided at import time, before this switch: the apart run built no band)
    agents = [a for a in json.loads(ns.agents) if isinstance(a, dict) and a.get('id')]
    ns.out.mkdir(parents=True, exist_ok=True)
    (ns.out / 'scaled').mkdir(parents=True, exist_ok=True)
    demo = ns.demo or any(str(a['id']).startswith('demo:') for a in agents)
    state_file = ns.out / 'desks.json'
    state = {}
    if not demo:                                  # the demo never reserves desks: it is laid out afresh every time
        try:
            state = json.loads(state_file.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            state = {}
    try:
        box = tuple(int(float(v)) for v in ns.box.lower().split('x')) if ns.box else None
        box = box if box and len(box) == 2 and min(box) > 80 else None
    except ValueError:
        box = None
    EARLY['args'] = {'agents': ns.agents, 'box': ns.box, 'config': ns.config, 'demo': demo}
    EARLY['state'] = None if demo else state
    if not ns.warm and not os.environ.get('HERDR_OFFICE_NO_LOCK'):
        import atexit
        _pl = plan_single_flight(ns.out, demo)                  # ★88-6 one plan at a time (waits for a running one, up to 25 s)
        atexit.register(plan_release, _pl)
    _wd = None if ns.warm else start_watchdog(ns.out)           # ★88-6
    if not ns.warm and not os.environ.get('HERDR_OFFICE_NO_TRACE'):
        start_sampler(ns.out)                                   # ★88-6 (slow runs only: see plan-trace.txt)
    global LOBBY_EXTRA
    for extra_ in (0, 1, 99):                     # ★57-3 (A12): the lobby as shallow as its things allow; deeper only when the big approval card found no room
        LOBBY_EXTRA = extra_
        img, fore, bb, out = build(agents, state, time.time() if ns.now is None else ns.now, ns.out,
                                   json.loads(ns.config) if ns.config else None, box, ns.debug)
        if not out.pop('_lobby_retry', False):
            break
    if not demo:
        state_file.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    out['file'] = rel(write_png(ns.out, 'building', img))
    out['foreground'] = []
    if bb:
        out['foreground'] = [{'file': rel(write_png(ns.out, 'front', fore.crop(bb))), 'rect': [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]]}]
    for pat, keep in (('building-*.png', 4), ('front-*.png', 4), ('bg-*.png', 6), ('debug-*.png', 2)):
        def mtime(p_):
            try:
                return p_.stat().st_mtime
            except OSError:
                return 0
        for old in sorted(ns.out.glob(pat), key=mtime)[:-keep]:
            old.unlink(missing_ok=True)
    try:                                          # keep the generated pictures under the size limit (the scene on screen is kept)
        import hakoniwa_sprites as sp_
        keep, stack = [], [out]
        while stack:
            v = stack.pop()
            if isinstance(v, dict):
                stack += list(v.values())
            elif isinstance(v, (list, tuple)):
                stack += list(v)
            elif isinstance(v, str) and v.startswith('hakoniwa-office/'):
                keep.append(v)
        # the pictures of the people in this scene (all their poses, not only the ones drawn now) are kept too: a person whose
        # files have been pruned is made again, which takes seconds
        try:
            cache = json.loads((APP_HOME / 'hakoniwa-office' / 'sheet' / 'people-cache.json').read_text(encoding='utf-8'))
            for a_ in agents:
                pool_ = int(os.environ.get('HERDR_PERSON_POOL') or 0)
                key_ = f'pool:{int(hashlib.sha1(str(a_["id"]).encode("utf-8")).hexdigest(), 16) % pool_}' if pool_ else str(a_['id'])
                ent_ = cache.get(key_) or {}
                keep += [f_ for f_ in ent_.get('files', []) if isinstance(f_, str)]
                stack = [ent_.get('poses')]
                while stack:
                    v = stack.pop()
                    if isinstance(v, dict):
                        stack += list(v.values())
                    elif isinstance(v, (list, tuple)):
                        stack += list(v)
                    elif isinstance(v, str) and v.startswith('hakoniwa-office/'):
                        keep.append(v)
        except (OSError, ValueError):
            pass
        stamp_ = ns.out / 'prune.stamp'                # stat-ing 24 000 files takes seconds: at most once in 10 minutes
        try:
            fresh_ = time.time() - stamp_.stat().st_mtime < 600
        except OSError:
            fresh_ = False
        if not fresh_ and (ns.warm or time.time() - T_START < 12):   # ★61: a long run (a new cast's first plan) leaves the ~9 s prune to a later one (the App stops a run at 30 s)
            sp_.prune(keep)
            stamp_.write_text(str(time.time()), encoding='utf-8')
    except Exception:
        pass
    if ns.warm:
        (ns.out / 'warm.lock').unlink(missing_ok=True)
    else:
        try:                                          # what `--warm-last` (install) and the apart rebuild need
            (ns.out / 'warm-args.json').write_text(json.dumps({'agents': ns.agents, 'box': ns.box, 'config': ns.config, 'demo': demo}, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass
        if (STALE[0] or COLD[0]) and not os.environ.get('HERDR_OFFICE_NO_SPAWN'):
            spawn_warm(ns.out)
    if _wd is not None:
        _wd.cancel()
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
    return 0


WARM_MAX_S = 300                                            # the apart run stops itself after this many seconds (a runaway one once took 9.5 GB)


def warm_lock_busy(lock):
    """★88-6: a warm run is going on. It stops itself after WARM_MAX_S, so a lock older than that (plus a minute) is a run that died: it no longer blocks the next one (was 15 minutes)."""
    try:
        return lock.exists() and time.time() - lock.stat().st_mtime < WARM_MAX_S + 60
    except OSError:
        return False


WATCHDOG_S = float(os.environ.get('HERDR_OFFICE_WATCHDOG') or 20)    # ★88-6 a normal run still working after this long starts the apart warm run (the App stops a run at 30 s)


def pid_alive(pid):
    """Is this process still running? (Windows: OpenProcess + exit code 259 = STILL_ACTIVE; never os.kill(pid, 0), which is not a probe there.)"""
    try:
        pid = int(pid)
        if pid <= 0:
            return False
        if os.name != 'nt':
            os.kill(pid, 0)
            return True
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)              # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong(0)
        ok_ = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok_) and code.value == 259
    except Exception:
        return False


PLAN_WAIT_S = float(os.environ.get('HERDR_OFFICE_PLAN_WAIT') or 25)      # the App stops a run at 30 s: waiting for the running one longer than this is no use
PLAN_LOCK_STALE_S = 240


def plan_single_flight(out_dir, demo=False, wait_s=None):
    """★88-6 (plan-trace.txt, 00:56): three plan runs were working at the same time on the same pictures (the App starts a new one every time the last
    was stopped at 30 s, from several windows), each slowed by the others, none finished in 30 s, the next three started ... A run now waits (up to
    PLAN_WAIT_S) for a running plan of the same kind to end, then takes the lock; its own work is then mostly in the cache the other one filled.
    Returns the lock path (release with plan_release)."""
    wait_s = PLAN_WAIT_S if wait_s is None else wait_s
    lock = Path(out_dir) / ('plan-demo.lock' if demo else 'plan.lock')
    t0 = time.time()
    while True:
        try:
            age = time.time() - lock.stat().st_mtime
            holder = int(lock.read_text(encoding='utf-8').strip() or 0)
        except (OSError, ValueError):
            break                                              # no lock
        if holder == os.getpid() or age > PLAN_LOCK_STALE_S or not pid_alive(holder):
            break                                              # ours, too old, or its run has gone
        if time.time() - t0 >= wait_s:
            break                                              # waited long enough: go on anyway (a stuck holder must not stop the plans for good)
        time.sleep(0.4)
    try:
        lock.write_text(str(os.getpid()), encoding='utf-8')
    except OSError:
        pass
    return lock


def plan_release(lock):
    try:
        if lock.exists() and lock.read_text(encoding='utf-8').strip() == str(os.getpid()):
            lock.unlink()
    except (OSError, ValueError):
        pass


def start_sampler(out_dir, after=5.0, every=2.0, max_bytes=200_000):
    """★88-6: where is a SLOW run waiting? From `after` s on, every `every` s the main thread's stack (the 6 innermost frames) is appended to
    plan-trace.txt (the App stops a run at 30 s: no end-of-run log is ever written). Nothing is written by a run that ends before `after`.
    Daemon thread, a few KB per slow run; the file is cut to its newest half at max_bytes."""
    import threading, traceback
    main_id = threading.main_thread().ident

    def loop():
        t0 = time.time()
        time.sleep(after)
        while True:
            try:
                fr = sys._current_frames().get(main_id)
                if fr is not None:
                    st = traceback.extract_stack(fr)[-6:]
                    line = '%s +%.1fs pid=%d | %s' % (time.strftime('%H:%M:%S'), time.time() - t0, os.getpid(), ' > '.join('%s:%d %s' % (Path(f.filename).name, f.lineno, f.name) for f in st)) + chr(10)
                    p = Path(out_dir) / 'plan-trace.txt'
                    old = p.read_text(encoding='utf-8') if p.exists() else ''
                    if len(old) > max_bytes:
                        old = old[len(old) // 2:]
                    p.write_text(old + line, encoding='utf-8')
            except Exception:
                pass
            time.sleep(every)
    th = threading.Thread(target=loop, daemon=True)
    th.start()
    return th


def start_watchdog(out_dir, seconds=None):
    """★88-6: the apart warm run (no time limit) starts at WATCHDOG_S, not only when a COLD band is found: a run that the App cuts at 30 s again and again
    (new people / pictures, a busy PC) leaves what it made on disk, so the next plan is quick. Returns the timer (cancel() it when the run ends first)."""
    import threading
    seconds = WATCHDOG_S if seconds is None else seconds
    if seconds <= 0:
        return None
    t = threading.Timer(seconds, lambda: early_warm(out_dir))
    t.daemon = True
    t.start()
    return t


def spawn_warm(out_dir):
    """The pack is old: rebuild it (and make the people) in a run of its own, with no time limit, apart from this one (the App stops a run after 30 s).
    One at a time (warm.lock); a lock older than 15 minutes is a run that died."""
    lock = out_dir / 'warm.lock'
    try:
        if warm_lock_busy(lock):
            return
        lock.write_text(str(os.getpid()), encoding='utf-8')
        flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--warm-last', '--out', str(out_dir), '--max-seconds', str(WARM_MAX_S)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    except OSError:
        pass


if __name__ == '__main__':
    raise SystemExit(main())
