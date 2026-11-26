"""The third background, the flower village ("guild-meadow"): its own planner py/hansol-meadow.py.

Design v3: py/sheets/meadow/DESIGN.md. Each workspace is a fenced yard in its colour with its tables and a name sign: on the back
edges with a cottage roofed in that colour, on the front edges with a market stall under an awning in it; the fountain square in the
middle. Everybody keeps to their
own seat in every state (l86 true, as the guild hall). Run: python -X utf8 -m unittest hansol/tests/test_meadow_plaza.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path

PY = Path(__file__).resolve().parents[1] / 'mods/hansol/py'
PLANNER = PY / 'hansol-meadow.py'
GUILD = PY / 'hansol-guild.py'
GUILD_SCENE_ID = 'edfd8c56e1'     # hansol-guild.py --demo --agents AGENTS --box 1280x800 before the meadow planner existed


def agents(*spaces):
    """spaces: (title, people) pairs -> the agent list office.js hands the planner."""
    return [{'id': f'demo:{t.lower()}-{i}', 'source': 'app', 'island': f'demo:{t}', 'island_title': t}
            for t, n in spaces for i in range(n)]


AGENTS = agents(('North', 3), ('West', 2), ('East', 3))          # 8 people in 3 workspaces


def run(script, home, *args):
    env = dict(os.environ, HERDR_APP_HOME=home, PYTHONIOENCODING='utf-8')
    return subprocess.run([sys.executable, '-X', 'utf8', str(script), *args], capture_output=True, text=True,
                          encoding='utf-8', env=env, timeout=900)


def last_json(text):
    return json.loads(text[text.rindex('\n{') + 1:] if '\n{' in text else text[text.index('{'):])


def plan(home, people=AGENTS, script=PLANNER):
    r = run(script, home, '--demo', '--agents', json.dumps(people), '--box', '1280x800')
    assert r.returncode == 0, r.stderr[-3000:]
    return last_json(r.stdout), r.stdout


def walkable(sc, t):
    g = sc['grid']
    return 0 <= t[0] < g['cols'] and 0 <= t[1] < g['rows'] and g['walk'][t[1]][t[0]] == '.'


def inside_of_door(sc):
    """The first floor tile through the doorway (as grid.js doorGeometry looks for it)."""
    d = sc['door']
    for cell in [d['tile'], *d.get('open_cells', [])]:
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            for st in (1, 2, 3):
                n = (cell[0] + dx * st, cell[1] + dy * st)
                if walkable(sc, n) and list(n) not in d.get('open_cells', []):
                    return n
    return None


def reachable(sc, start):
    seen, q = {tuple(start)}, deque([tuple(start)])
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            n = (x + dx, y + dy)
            if n not in seen and walkable(sc, n):
                seen.add(n)
                q.append(n)
    return seen


def base_id(oid):
    return oid.rsplit(':', 1)[0]          # slices are '<object id>:<n>'


def places(sc):
    """Every place a person stays: (kind, tile, xy) for the seats, the queues and the stumps."""
    out = [('seat', s['tile'], s['xy']) for s in sc['seats'].values()]
    for kind in ('approval', 'counter', 'lounge'):
        out += [(kind, q['tile'], q['xy']) for q in sc['spots'].get(kind) or []]
    return out


BODY = (20, 80, 40, 76)          # a person's body inside their picture: left / up from the feet, width, height (px)


def hidden_share(sc, home, tile, xy, cache={}):
    """How much of a person standing at xy is painted over by things drawn in front of them (depth beyond the tile's)."""
    from PIL import Image
    x0, y0 = round(xy[0] - BODY[0]), round(xy[1] - BODY[1])
    cover = Image.new('L', (BODY[2], BODY[3]), 0)
    for o in sc['objects']:
        if o['depth'] <= sum(tile) + 0.5 or not o.get('file'):
            continue
        rx, ry, rw, rh = o['rect']
        if rx >= x0 + BODY[2] or ry >= y0 + BODY[3] or rx + rw <= x0 or ry + rh <= y0:
            continue
        key = (o['file'], round(rw), round(rh))
        if key not in cache:
            cache[key] = Image.open(Path(home) / o['file']).convert('RGBA').resize(key[1:]).getchannel('A')
        cover.paste(255, (round(rx) - x0, round(ry) - y0), cache[key].point(lambda v: 255 if v > 40 else 0))
    return sum(1 for v in cover.getdata() if v) / (BODY[2] * BODY[3])


def contrast(a, b):
    """WCAG contrast ratio of two '#rrggbb' colours (or RGB tuples)."""
    def lum(c):
        if isinstance(c, str):
            c = [int(c[i:i + 2], 16) for i in (1, 3, 5)]
        ch = [(v / 255 / 12.92) if v / 255 <= 0.03928 else ((v / 255 + 0.055) / 1.055) ** 2.4 for v in c[:3]]
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def covered(sc, home, rect, depth, cache={}):
    """The share of a picture rect [x, y, w, h] painted over by things drawn in front of depth."""
    from PIL import Image
    x0, y0, w, h = (round(v) for v in rect)
    cover = Image.new('L', (max(1, w), max(1, h)), 0)
    for o in sc['objects']:
        if o['depth'] <= depth or not o.get('file'):
            continue
        rx, ry, rw, rh = o['rect']
        if rx >= x0 + w or ry >= y0 + h or rx + rw <= x0 or ry + rh <= y0:
            continue
        key = (o['file'], round(rw), round(rh))
        if key not in cache:
            cache[key] = Image.open(Path(home) / o['file']).convert('RGBA').resize(key[1:]).getchannel('A')
        cover.paste(255, (round(rx) - x0, round(ry) - y0), cache[key].point(lambda v: 255 if v > 40 else 0))
    return sum(1 for v in cover.getdata() if v) / (max(1, w) * max(1, h))


def key_left(im):
    """The share of a picture's painted pixels still in the robe key's hue band (magenta, 305 +- 40 degrees), pale ones too."""
    import numpy as np
    from PIL import Image
    a = np.array(im.convert('RGBA'))
    hsv = np.array(Image.fromarray(a[..., :3]).convert('HSV')).astype(int)
    solid = a[..., 3] >= 128
    d = np.abs(hsv[..., 0] * 360 / 255 - 305)
    d = np.minimum(d, 360 - d)
    return ((d <= 40) & (hsv[..., 1] >= 25) & (hsv[..., 2] >= 60) & solid).sum() / max(1, solid.sum())


class Plaza(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp(prefix='plaza-test-')
        cls.sc, cls.raw = plan(cls.home)

    def test_contract(self):
        sc = self.sc
        for k in ('width', 'height', 'native', 'file', 'scene_id', 'grid', 'background_tiles', 'objects', 'door',
                  'spots', 'seats', 'desks', 'islands', 'people', 'pose_size', 'sprite', 'clock', 'lights',
                  'stand_points'):
            self.assertIn(k, sc)
        self.assertEqual(sc['theme'], 'guild-meadow')
        self.assertIs(sc['l86'], True)                        # everybody keeps to their own seat (as the guild hall)
        self.assertEqual(sc['backdrop'], '#2a2d31')
        self.assertIs(sc['native'], True)
        g = sc['grid']
        self.assertEqual((g['tw'], g['th']), (48, 24))
        self.assertEqual(len(g['walk']), g['rows'])
        self.assertEqual(len(g['floor']), g['rows'])
        self.assertTrue(all(len(r) == g['cols'] and set(r) <= {'.', '#'} for r in g['walk']))
        self.assertTrue(all(len(r) == g['cols'] for r in g['floor']))

    def test_everyone_keeps_their_seat(self):
        sp = self.sc['spots']
        for kind in ('approval', 'counter', 'lounge'):
            self.assertFalse(sp.get(kind), f'no {kind} place: people stay at their seats')
        tiles = [tuple(s['tile']) for s in self.sc['seats'].values()]
        self.assertEqual(len(tiles), len(set(tiles)))
        for t in tiles:
            self.assertTrue(walkable(self.sc, t), t)

    def test_yards(self):                                # each workspace is its own fenced yard, apart from the others
        sc = self.sc
        ids = {base_id(o['id']) for o in sc['objects']}
        rects = []
        for isl in sc['islands']:
            g = isl['key']
            self.assertTrue(isl.get('color', '').startswith('#'), g)
            x0, y0, w, h = isl['yard']
            ix, iy, iw, ih = isl['inner']
            self.assertTrue(x0 <= ix and y0 <= iy and ix + iw <= x0 + w and iy + ih <= y0 + h, isl)
            for sid in isl['seats']:
                tx, ty = sc['seats'][sid]['tile']
                self.assertTrue(ix <= tx < ix + iw and iy <= ty < iy + ih, f'{sid} {sc["seats"][sid]["tile"]} outside its yard')
            self.assertTrue(f'cottage:{g}' in ids or f'stall:{g}' in ids, f'{g}: a cottage (back) or a stall (front)')
            self.assertIn(f'sign:{g}', ids)
            self.assertTrue([i for i in ids if i.startswith(f'fence:{g}:')], g)
            rects.append((g, x0, y0, w, h))
        for i, (g, ax, ay, aw, ah) in enumerate(rects):
            for k, bx, by, bw, bh in rects[i + 1:]:
                gap = max(bx - (ax + aw), ax - (bx + bw), by - (ay + ah), ay - (by + bh))
                self.assertGreaterEqual(gap, 2, f'yards {g} and {k} are {gap} tiles apart')

    def test_reachable_from_the_gate(self):
        start = inside_of_door(self.sc)
        self.assertIsNotNone(start, 'no floor tile through the gate')
        ok = reachable(self.sc, start)
        targets = [s['tile'] for s in self.sc['seats'].values()]
        targets += [p['tile'] for p in self.sc['stand_points']]
        for t in targets:
            self.assertIn(tuple(t), ok, f'{t} cannot be reached from the gate')

    def test_objects_block_their_tiles(self):
        sc, owner = self.sc, {}
        seat_tiles = {tuple(s['tile']) for s in sc['seats'].values()}
        for o in sc['objects']:
            for t in o.get('tiles') or []:
                t = tuple(t)
                if t in seat_tiles:
                    continue
                self.assertEqual(sc['grid']['walk'][t[1]][t[0]], '#', (o['id'], t))
                b = base_id(o['id'])
                self.assertEqual(owner.setdefault(t, b), b, f'{o["id"]} and {owner[t]} stand on {t}')

    def test_a_square_not_a_hall(self):
        kinds = {o['kind'] for o in self.sc['objects']}
        for k in ('fountain', 'notice_board', 'post_box', 'house', 'fence', 'sign', 'lamp', 'tree'):
            self.assertIn(k, kinds)
        self.assertFalse([k for k in kinds if 'wall' in k], kinds)
        self.assertNotIn('hansol-office/guild/', self.raw)
        files = set(re.findall(r'hansol-office/[^"\\]+\.(?:png|gif)', self.raw))
        self.assertTrue(files)
        for f in files:
            self.assertTrue(f.startswith('hansol-office/meadow/'), f)
            self.assertTrue((Path(self.home) / f).is_file(), f)

    def test_a_yard_per_workspace(self):
        sc = self.sc
        self.assertEqual(sorted(i['title'] for i in sc['islands']), ['East', 'North', 'West'])
        homes = {base_id(o['id']) for o in sc['objects'] if o['id'].startswith(('cottage:', 'stall:'))}
        self.assertEqual(len(homes), 3)
        self.assertEqual(len({i['color'] for i in sc['islands']}), 3, 'every yard has its own colour')
        for isl in sc['islands']:
            self.assertTrue(isl.get('plate') or isl.get('banner'), isl['key'])
            for sid in isl['seats']:
                self.assertEqual(sc['seats'][sid]['island'], isl['key'])
        owners = [s['owner'] for s in sc['seats'].values() if s.get('owner')]
        self.assertEqual(len(owners), len(set(owners)))
        for a in AGENTS:
            d = sc['desks'][a['id']]
            self.assertEqual(sc['seats'][d['seat_id']]['owner'], a['id'])
            self.assertEqual(sc['seats'][d['seat_id']]['island'], a['island'])

    def test_people(self):
        sc = self.sc
        for a in AGENTS:
            pack = sc['people'][a['id']]
            for k in ('stand', 'front_give', 'type_pc', 'read_pc'):
                self.assertTrue(pack.get(k), (a['id'], k))
                self.assertIn(k, sc['pose_size'])
            self.assertEqual(set(pack['walk8_frames']), {'dl', 'dr', 'ul', 'ur'})

    def test_nobody_hidden(self):                        # a person at any place shows: at most a quarter painted over by things in front
        for kind, tile, xy in places(self.sc):
            share = hidden_share(self.sc, self.home, tile, xy)
            self.assertLessEqual(share, 0.25, f'{kind} at {tile}: {share:.0%} of the person is hidden')

    def test_seat_at_its_table(self):                    # a seat is in front of the middle of its own table's front side (not at an end)
        sc = self.sc
        for sid, s in sc['seats'].items():
            tiles = {tuple(x) for o in sc['objects'] if base_id(o['id']) == f'desk:{sid}' for x in o['tiles']}
            self.assertTrue(tiles, sid)
            xs, front = sorted({x for x, _ in tiles}), max(y for _, y in tiles)
            self.assertEqual(s['tile'], [xs[len(xs) // 2], front + 1], f'{sid} at {s["tile"]}, table x {xs}, front row {front}')

    def test_clock_readable(self):                       # v2: light words on a light board, the time-of-day word unseen
        from PIL import Image
        c = self.sc['clock']
        im = Image.open(Path(self.home) / c['plaque']).convert('RGBA')
        fx, fy, fw, fh = c['face']
        W, H = im.size
        face = im.crop((round(W * fx), round(H * fy), round(W * (fx + fw)), round(H * (fy + fh))))
        px = [p for p in face.getdata() if p[3] > 200]
        mean = [sum(p[i] for p in px) / len(px) for i in range(3)]
        self.assertGreaterEqual(contrast(c['ink'], mean), 4.5, (c['ink'], mean))
        self.assertGreaterEqual(contrast(c['ink2'], mean), 3.0, (c['ink2'], mean))
        self.assertGreaterEqual(c['size'][0], 130, 'room for "hh:mm" and the time-of-day word')

    def test_night_darkens_the_village(self):           # out of doors: the App lays this colour over everything
        tod = self.sc['tod']
        night = tod['night']
        self.assertRegex(night, r'^#[0-9a-f]{8}$')
        self.assertTrue(0x20 <= int(night[7:9], 16) <= 0x48, 'a night tint, not darkness (2026-11-26: 0x90 was too dark)')
        self.assertLess(sum(int(night[i:i + 2], 16) for i in (1, 3, 5)), 200, 'a dark colour')
        self.assertRegex(tod['evening'], r'^#[0-9a-f]{8}$')

    def test_a_small_square(self):                       # v2: the square was ~half of the village and nearly empty
        g, (px0, py0, px1, py1) = self.sc['grid'], self.sc['square']
        share = (px1 - px0) * (py1 - py0) / (g['cols'] * g['rows'])
        self.assertLessEqual(share, 0.25, f'the square is {share:.0%} of the village')
        self.assertGreaterEqual(min(px1 - px0, py1 - py0), 18)

    def test_signs_show(self):                           # every yard's name board: at most a quarter painted over
        for isl in self.sc['islands']:
            share = covered(self.sc, self.home, isl['banner']['face'], isl['plate']['depth'])
            self.assertLessEqual(share, 0.25, f"{isl['key']} sign {share:.0%} hidden")

    def test_lamps_light_the_night(self):
        lamps = {base_id(o['id']) for o in self.sc['objects'] if o['kind'] == 'lamp'}
        lights = [l for l in self.sc['lights'] if l.get('kind') == 'lamp']
        self.assertGreaterEqual(len(lamps), 2)
        self.assertEqual(len(lights), len(lamps))
        for l in lights:
            self.assertTrue(0 <= l['at'][0] <= self.sc['width'] and 0 <= l['at'][1] <= self.sc['height'], l)
            self.assertEqual(len(l['size']), 2)

    def test_clock(self):
        c = self.sc['clock']
        self.assertEqual(len(c['at']), 2)
        self.assertEqual(len(c['size']), 2)
        self.assertEqual(len(c['face']), 4)
        self.assertTrue((Path(self.home) / c['plaque']).is_file())

    def test_same_input_same_plan(self):
        again, _ = plan(self.home)
        self.assertEqual(again['scene_id'], self.sc['scene_id'])

    def test_preview(self):
        out = Path(self.home) / 'preview.png'
        r = run(PLANNER, self.home, '--demo', '--agents', json.dumps(AGENTS), '--box', '1280x800', '--preview', str(out))
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertGreater(out.stat().st_size, 10000)

    def test_settings_accepted(self):                   # office.js adds --config when the user has office settings
        r = run(PLANNER, self.home, '--demo', '--agents', json.dumps(AGENTS), '--box', '1280x800', '--config', '{}')
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])


class Sizes(unittest.TestCase):
    def test_four_sides(self):                           # 4 workspaces: one yard on each side, all seen, all reachable
        home = tempfile.mkdtemp(prefix='plaza-four-')
        people = agents(('Atlas', 2), ('Bridge', 1), ('Kb', 2), ('Mes', 3))
        sc, _ = plan(home, people)
        C, R = sc['grid']['cols'], sc['grid']['rows']
        sides = set()
        for isl in sc['islands']:
            x0, y0, w, h = isl['yard']
            sides.add('right' if y0 == 0 else 'left' if x0 == 0 else 'front_r' if y0 + h == R - 1 else
                      'front_l' if x0 + w == C - 1 else '?')
        self.assertEqual(sides, {'right', 'left', 'front_r', 'front_l'})
        stalls = {base_id(o['id']) for o in sc['objects'] if o['id'].startswith('stall:')}
        self.assertEqual(len(stalls), 2, 'the two front yards have stalls')
        ok = reachable(sc, inside_of_door(sc))
        for kind, tile, xy in places(sc):
            self.assertIn(tuple(tile), ok, (kind, tile))
            share = hidden_share(sc, home, tile, xy)
            self.assertLessEqual(share, 0.25, f'{kind} at {tile}: {share:.0%} hidden')
        for isl in sc['islands']:
            share = covered(sc, home, isl['banner']['face'], isl['plate']['depth'])
            self.assertLessEqual(share, 0.25, f"{isl['key']} sign {share:.0%} hidden")
        g, (px0, py0, px1, py1) = sc['grid'], sc['square']
        self.assertLessEqual((px1 - px0) * (py1 - py0) / (C * R), 0.25)
        bushes = {base_id(o['id']) for o in sc['objects'] if o['kind'] == 'bush'}
        beds = {base_id(o['id']) for o in sc['objects'] if o['kind'] == 'flower_bed'}
        self.assertLessEqual(len(bushes), 0.06 * C * R, f'{len(bushes)} bushes: a carpet of them (v3 first try)')
        self.assertGreaterEqual(len(beds), 12, 'the empty corners are flower fields')
        d = sc['door']
        share = covered(sc, home, d['rect'], d['depth'] + 0.5)
        self.assertLessEqual(share, 0.25, f'the gate is {share:.0%} hidden')

    def test_one_to_twenty_people(self):
        for people, spaces in ((agents(('Solo', 1)), 1),
                               (agents(('A', 5), ('B', 4), ('C', 3), ('D', 3), ('E', 3), ('F', 2)), 6)):
            with self.subTest(people=len(people)):
                home = tempfile.mkdtemp(prefix='plaza-size-')
                sc, _ = plan(home, people)
                self.assertEqual(len(sc['islands']), spaces)
                self.assertEqual(set(sc['desks']), {a['id'] for a in people})
                start = inside_of_door(sc)
                ok = reachable(sc, start)
                for s in sc['seats'].values():
                    self.assertIn(tuple(s['tile']), ok)
                C, R, SD = sc['grid']['cols'], sc['grid']['rows'], 16     # SD: the yards' strip (hansol-meadow.py)
                beds = set()
                for o in sc['objects']:
                    m = re.fullmatch(r'flower_bed:(\d+)-(\d+)', base_id(o['id']))
                    if m and SD <= int(m[1]) < C - 1 and SD <= int(m[2]) < R - 1:
                        beds.add(m[0])
                if spaces == 6:          # a big square gets gardens in its quarters, not only the fountain
                    self.assertGreaterEqual(len(beds), 3, sorted(beds))
                else:
                    self.assertEqual(beds, set())


class Recolour(unittest.TestCase):
    def test_no_key_colour_left(self):                   # the painted robes take the new colour all over (no pink patches)
        import importlib.util
        from PIL import Image
        spec = importlib.util.spec_from_file_location('meadow_planner', PLANNER)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.use_theme()
        for f in sorted((PY / 'sheets/meadow').glob('c-*-poses.png')):
            left = key_left(m.gs.recolor(Image.open(f).convert('RGBA'), '#D02FC0', '#2a4fa8'))
            self.assertLessEqual(left, 0.005, f'{f.name}: {left:.2%} still magenta')

class Sheets(unittest.TestCase):
    def test_check_ready(self):
        r = run(PLANNER, tempfile.mkdtemp(prefix='plaza-check-'), '--check')
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        st = last_json(r.stdout)
        self.assertEqual(st['ready'], st['total'], st)


class GuildUnchanged(unittest.TestCase):
    def test_guild_scene_id(self):
        sc, _ = plan(tempfile.mkdtemp(prefix='plaza-guild-'), script=GUILD)
        self.assertEqual(sc['theme'], 'guild-dark')
        self.assertEqual(sc['scene_id'], GUILD_SCENE_ID)


if __name__ == '__main__':
    unittest.main()
