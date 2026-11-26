"""The flower village's parts, one function at a time (v3: yards on four sides round a small square). Run: python -X utf8 -m unittest hansol/tests/test_meadow_parts.py

Each test checks one function of py/hansol-meadow.py against its docstring, so a function can be written and checked on its own.
"""
import importlib.util
import unittest
from pathlib import Path

PY = Path(__file__).resolve().parents[1] / 'mods/hansol/py'
_M = None


def planner():
    global _M
    if _M is None:
        spec = importlib.util.spec_from_file_location('meadow_parts', PY / 'hansol-meadow.py')
        _M = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_M)
        _M.use_theme()
    return _M


def hue_deg(rgb):
    from PIL import Image
    h, s, v = Image.new('RGB', (1, 1), tuple(rgb)).convert('HSV').getpixel((0, 0))
    return h * 360 / 255, s, v


class RoofRecolor(unittest.TestCase):
    def test_roof_takes_the_colour_walls_stay(self):
        import numpy as np
        m = planner()
        house = m.pieces()['house_r2']
        out = m.roof_recolor(house, '#4d76ad')
        a, b = np.asarray(house), np.asarray(out)
        self.assertEqual(out.size, house.size)
        self.assertTrue((a[..., 3] == b[..., 3]).all(), 'alpha must not change')
        solid = a[..., 3] > 0
        changed = (a[..., :3] != b[..., :3]).any(-1) & solid
        share = changed.sum() / solid.sum()
        self.assertTrue(0.10 <= share <= 0.50, f'{share:.0%} of the house changed (the roof is about a quarter)')
        th = hue_deg((0x4d, 0x76, 0xad))[0]
        ys, xs = np.nonzero(changed)
        far = 0
        for y, x in list(zip(ys, xs))[::97]:
            d = abs(hue_deg(b[y, x, :3])[0] - th)
            far += min(d, 360 - d) > 12
        self.assertLessEqual(far, 2, 'changed pixels take the new hue')
        from PIL import Image
        hsv = np.asarray(house.convert('RGB').convert('HSV')).astype(int)
        pale = solid & (hsv[..., 1] < 80)                  # the cream walls
        self.assertFalse(changed[pale].any(), 'the walls (pale pixels) stay as painted')

    def test_same_colour_twice_same_picture(self):
        import numpy as np
        m = planner()
        house = m.pieces()['house_l']
        self.assertTrue((np.asarray(m.roof_recolor(house, '#5b8a4b')) == np.asarray(m.roof_recolor(house, '#5b8a4b'))).all())


class Site(unittest.TestCase):
    """v3: yards on all four sides round a small square (back: cottages, front: stalls)."""
    LEN = {'right': 'w', 'front_r': 'w', 'left': 'h', 'front_l': 'h'}

    def check(self, order, need):
        m = planner()
        yards, C, R, fdx, fdy = m.site(order, need)
        self.assertEqual([y['g'] for y in yards], order)
        self.assertEqual((C % 2, R % 2), (0, 0))
        sides = {y['side'] for y in yards}
        self.assertEqual(fdx, m.FD if 'front_l' in sides else 2)
        self.assertEqual(fdy, m.FD if 'front_r' in sides else 2)
        px1, py1 = C - 1 - fdx, R - 1 - fdy
        self.assertGreaterEqual(px1 - m.SD, m.PMIN, 'the square is never smaller than PMIN')
        self.assertGreaterEqual(py1 - m.SD, m.PMIN)
        for y in yards:
            self.assertGreaterEqual(2 * y['cols'] * y['rows'], need[y['g']], y)
            s = y['side']
            if s in ('right', 'front_r'):
                self.assertEqual((y['rows'], y['w']), (2, 5 * y['cols'] + 3), y)
                self.assertGreaterEqual(y['x0'], m.SD + m.YGAP)
                self.assertLessEqual(y['x0'] + y['w'], px1 - m.YGAP, 'the front-right corner stays free')
                self.assertEqual((y['y0'], y['h']), (0, m.SD) if s == 'right' else (R - 1 - m.FD, m.FD), y)
            else:
                self.assertEqual((y['cols'], y['h']), (2, 4 * y['rows'] + 5), y)
                self.assertGreaterEqual(y['y0'], m.SD + m.YGAP)
                self.assertLessEqual(y['y0'] + y['h'], py1 - m.YGAP, 'the gate corner stays free')
                self.assertEqual((y['x0'], y['w']), (0, m.SD) if s == 'left' else (C - 1 - m.FD, m.FD), y)
        for side, key in self.LEN.items():
            row = [y for y in yards if y['side'] == side]
            at = 'x0' if key == 'w' else 'y0'
            if row:
                self.assertEqual(row[0][at], m.SD + m.YGAP, side)
            for p, q in zip(row, row[1:]):
                self.assertEqual(q[at] - (p[at] + p[key]), m.YGAP, (p, q))
        for i, a in enumerate(yards):
            for b in yards[i + 1:]:
                apart = (a['x0'] + a['w'] <= b['x0'] or b['x0'] + b['w'] <= a['x0'] or
                         a['y0'] + a['h'] <= b['y0'] or b['y0'] + b['h'] <= a['y0'])
                self.assertTrue(apart, (a, b))
        return yards, C, R

    def test_one(self):
        yards, C, R = self.check(['A'], {'A': 1})
        self.assertEqual(([y['side'] for y in yards], C, R), (['right'], 38, 38))

    def test_three(self):
        yards, C, R = self.check(['E', 'N', 'W'], {'E': 3, 'N': 3, 'W': 2})
        self.assertEqual([(y['g'], y['side'], y['x0'], y['y0'], y['w'], y['h']) for y in yards],
                         [('E', 'right', 18, 0, 13, 16), ('N', 'left', 0, 18, 16, 13), ('W', 'front_r', 18, 35, 13, 14)])
        self.assertEqual((C, R), (38, 50))

    def test_four_one_per_side(self):
        yards, C, R = self.check(list('ABCD'), dict(A=3, B=3, C=3, D=3))
        self.assertEqual([y['side'] for y in yards], ['right', 'left', 'front_r', 'front_l'])
        self.assertEqual((C, R), (50, 50))

    def test_six_crowded(self):
        yards, C, R = self.check(list('ABCDEF'), {'A': 5, 'B': 4, 'C': 3, 'D': 3, 'E': 3, 'F': 2})
        self.assertEqual([y['side'] for y in yards], ['right', 'left', 'front_r', 'front_l', 'left', 'front_r'])


class FenceRun(unittest.TestCase):
    def test_runs_of_four_then_bushes(self):
        m = planner()
        calls = []
        put = lambda *a, **k: calls.append((a, k)) or [0, 0, 1, 1]
        cells = [(x, 15) for x in range(18, 29) if x not in (23, 24)]     # 18..22 (5 cells), a gap, 25..28 (4 cells)
        m.fence_run(put, cells, True, 'fence:g:front')
        got = [(a[0], a[1], a[2], a[3], a[4], k.get('kind')) for a, k in calls]
        self.assertEqual(got, [('fence_r', 18, 15, 4, 1, 'fence'), ('bush', 22, 15, 1, 1, 'bush'), ('fence_r', 25, 15, 4, 1, 'fence')])
        self.assertEqual(calls[0][0][5], 'bs')
        ids = [k['oid'] for _, k in calls]
        self.assertEqual(len(set(ids)), 3)
        self.assertTrue(all(i.startswith('fence:g:front:') for i in ids))

    def test_vertical(self):
        m = planner()
        calls = []
        put = lambda *a, **k: calls.append((a, k)) or [0, 0, 1, 1]
        m.fence_run(put, [(15, y) for y in range(20, 26)], False, 'fence:g:front')
        got = [(a[0], a[1], a[2], a[3], a[4]) for a, k in calls]
        self.assertEqual(got, [('fence_l', 15, 20, 1, 4), ('bush', 15, 24, 1, 1), ('bush', 15, 25, 1, 1)])
        self.assertEqual(calls[0][0][5], 'fs')


class TintYards(unittest.TestCase):
    def test_inner_tiles_take_the_colour(self):
        from PIL import Image
        m = planner()
        hall = m.G.Hall(30, 30, top=260)
        bg = Image.new('RGBA', (hall.W, hall.H), (120, 110, 100, 255))
        out = m.tint_yards(bg.copy(), hall, [{'inner': [5, 5, 4, 3], 'colour': '#4d76ad'}])
        at = lambda gx, gy: tuple(int(round(v)) for v in hall.xy(gx, gy))
        self.assertEqual(bg.getpixel(at(12, 12)), out.getpixel(at(12, 12)), 'outside stays')
        col, sand = (0x4d, 0x76, 0xad), tuple(int(m.SAND[i:i + 2], 16) for i in (1, 3, 5))
        mix = [(c + s) // 2 for c, s in zip(col, sand)]
        want = [round(b * (55 / 255) + c * (200 / 255)) for b, c in zip((120, 110, 100), mix)]
        got = out.getpixel(at(6, 6))[:3]
        self.assertTrue(all(abs(g - w) <= 4 for g, w in zip(got, want)), (got, want))
        edge = out.getpixel(at(5, 6))[:3]
        want_e = [round(b * (40 / 255) + c * (215 / 255)) for b, c in zip((120, 110, 100), col)]
        self.assertTrue(all(abs(g - w) <= 4 for g, w in zip(edge, want_e)), (edge, want_e))


class Palette(unittest.TestCase):
    def test_hues_far_apart(self):                       # two yards side by side never look alike (v2: two blues)
        m = planner()
        hues = [hue_deg([int(c[i:i + 2], 16) for i in (1, 3, 5)])[0] for c in m.COLORS]
        for i, a in enumerate(hues):
            for j, b in enumerate(hues[i + 1:], i + 1):
                d = abs(a - b)
                self.assertGreaterEqual(min(d, 360 - d), 35, (m.COLORS[i], m.COLORS[j]))


if __name__ == '__main__':
    unittest.main()
