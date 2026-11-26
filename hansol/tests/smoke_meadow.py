"""One builder of py/hansol-meadow.py checked inside a real plan, before the other builders exist.

    python -X utf8 hansol/tests/smoke_meadow.py <build_yard|build_front_yard|build_corner|build_plaza|build_edges|lay_floor>

Builders whose body is still `raise NotImplementedError(...)` are swapped for stand-ins that do nothing (lay_floor: an empty
picture, build_corner: a hall rect), the plan runs on the 8-person demo, and the named builder's own checks run. Exit 0 = pass.
"""
import importlib.util
import inspect
import json
import os
import sys
import tempfile
from pathlib import Path

PY = Path(__file__).resolve().parents[1] / 'mods/hansol/py'
BUILDERS = ('build_yard', 'build_front_yard', 'build_corner', 'build_plaza', 'build_edges', 'lay_floor')


def main(unit):
    os.environ.setdefault('HERDR_APP_HOME', tempfile.mkdtemp(prefix='meadow-smoke-'))
    spec = importlib.util.spec_from_file_location('meadow_smoke', PY / 'hansol-meadow.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.use_theme()
    from PIL import Image
    stand_ins = {'build_corner': lambda v: [0, 0, 100, 100], 'build_plaza': lambda v, fx0, fy0: None,
                 'build_edges': lambda v, yards, plaza: None,
                 'lay_floor': lambda v, yards, plaza: Image.new('RGBA', (v.hall.W, v.hall.H), (0, 0, 0, 0))}
    for name in BUILDERS:
        if name != unit and 'raise NotImplementedError(' in inspect.getsource(getattr(m, name)):
            if name in ('build_yard', 'build_front_yard'):
                sys.exit(f'{name} must exist before the other builders can be checked')
            setattr(m, name, stand_ins[name])
    calls = {}
    real = getattr(m, unit)

    def spy(*a, **k):
        calls['args'] = a
        calls['result'] = real(*a, **k)
        return calls['result']
    setattr(m, unit, spy)
    agents = [{'id': f'demo:{t.lower()}-{i}', 'source': 'app', 'island': f'demo:{t}', 'island_title': t}
              for t, n in (('North', 3), ('West', 2), ('East', 3)) for i in range(n)]
    sc = m.plan(agents, demo=True)
    json.dumps(sc)
    kinds = {}
    for o in sc['objects']:
        kinds.setdefault(o['kind'], set()).add(o['id'].rsplit(':', 1)[0])
    bad = []

    def need(cond, msg):
        if not cond:
            bad.append(msg)

    walk = sc['grid']['walk']
    if unit == 'build_yard':
        need(len(sc['islands']) == 3, f"3 islands, got {len(sc['islands'])}")
        need(set(sc['desks']) == {a['id'] for a in agents}, 'every agent has a desk')
        need(len(kinds.get('house', ())) == 3, f"3 cottages, got {sorted(kinds.get('house', ()))}")
        need(len(kinds.get('sign', ())) == 3, 'a sign per yard')
        need(len(kinds.get('lamp', ())) == 3, 'a lamp per yard gate')
        need(any(i.startswith('fence:') for i in kinds.get('fence', ())), 'fences')
        for isl in sc['islands']:
            ix, iy, iw, ih = isl['inner']
            for sid in isl['seats']:
                tx, ty = sc['seats'][sid]['tile']
                need(ix <= tx < ix + iw and iy <= ty < iy + ih, f'{sid} outside its inner yard')
                need(walk[ty][tx] == '.', f'{sid} seat tile blocked')
            for k in ('plate', 'banner', 'yard', 'inner', 'color', 'rect', 'label'):
                need(k in isl, f"island {isl['key']} lacks {k}")
    elif unit == 'build_front_yard':
        need(len(sc['islands']) == 3, f"3 islands, got {len(sc['islands'])}")
        need(set(sc['desks']) == {a['id'] for a in agents}, 'every agent has a desk')
        need(len(kinds.get('stall', ())) == 1, f"1 stall (the front yard), got {sorted(kinds.get('stall', ()))}")
        need(len([i for i in kinds.get('house', ()) if i.startswith('cottage:')]) == 2, 'the 2 back yards keep their cottages')
        need(len(kinds.get('sign', ())) == 3, 'a sign per yard')
        need(len(kinds.get('lamp', ())) >= 3, 'a lamp per yard gate (and the square lamps)')
        front = [i for i in sc['islands'] if 'stall:' + i['key'] in kinds.get('stall', ())]
        need(len(front) == 1, 'the stall belongs to a yard')
        for isl in front:
            g = isl['key']
            need(any(i.startswith(f'fence:{g}:') for i in kinds.get('fence', ()) | kinds.get('bush', ())), 'its fences')
            ix, iy, iw, ih = isl['inner']
            need(isl['yard'][1] + isl['yard'][3] == sc['grid']['rows'] - 1, 'on the front edge (gy = R - 2 is its last row)')
            for sid in isl['seats']:
                tx, ty = sc['seats'][sid]['tile']
                need(ix <= tx < ix + iw and iy <= ty < iy + ih, f'{sid} outside its inner yard')
                need(walk[ty][tx] == '.', f'{sid} seat tile blocked')
            for k in ('plate', 'banner', 'yard', 'inner', 'color', 'rect', 'label'):
                need(k in isl, f"island {g} lacks {k}")
            x0, y0 = isl['yard'][:2]
            need(walk[y0][x0 + 1] == '.' and walk[y0][x0 + 2] == '.', 'the gate (towards the square) stays open')
    elif unit == 'build_corner':
        need('hall' in kinds.get('house', ()), 'the hall')
        need(kinds.get('notice_board') and kinds.get('post_box'), 'notice board and post box')
        need(len(kinds.get('tree', ())) >= 4, 'trees in the corner')
        need(any(p['part'] == 'board' for p in sc['stand_points']), 'the board wander point')
        r = calls['result']
        need(isinstance(r, list) and len(r) == 4 and r[2] > 200, f'returns the hall rect, got {r}')
    elif unit == 'build_plaza':
        need(kinds.get('fountain'), 'the fountain')
        need(len(kinds.get('lamp', ())) >= 3 + 2, f"yard lamps + square lamps, got {len(kinds.get('lamp', ()))}")
        need(len(kinds.get('decor', ())) >= 5, f"benches, well, cart, planters .., got {sorted(kinds.get('decor', ()))}")
        need(sum(1 for p in sc['stand_points'] if p['part'] in ('fountain', 'bench', 'well')) >= 3, 'wander points on the square')
    elif unit == 'build_edges':
        need(len(kinds.get('flower_bed', ())) >= 3, 'flower beds on the front')
        front = [i for i in kinds.get('fence', ()) if not i.startswith('fence:')]
        need(len(front) >= 3, 'front fences')
        need(len(kinds.get('bush', ())) >= 5, 'bushes in the gaps')
        need(len(kinds.get('bush', ())) <= 0.06 * sc['grid']['cols'] * sc['grid']['rows'], 'no carpet of bushes (v3 first try: 1 in 3 gap tiles)')
        need(len(kinds.get('flower_bed', ())) >= 8, 'flower fields in the gaps (and beds on the front)')
        dr = sc['door']['tile'][1]
        need(walk[dr][2] == '.' and walk[dr][3] == '.', 'the gate stays free')
    elif unit == 'lay_floor':
        bg = calls['result']
        need(bg.size == (sc['width'], sc['height']), 'floor picture size')
        hx, hy = sc['width'] // 2, sc['height'] // 2
        need(bg.getbbox() is not None, 'the floor is drawn')
        isl = sc['islands'][0]
        ix, iy, iw, ih = isl['inner']
        g = sc['grid']
        cx = g['origin'][0] + ((ix + iw // 2) - (iy + ih // 2)) * g['tw'] / 2
        cy = g['origin'][1] + ((ix + iw // 2) + (iy + ih // 2)) * g['th'] / 2
        px = bg.getpixel((int(cx), int(cy)))
        col = tuple(int(isl['color'][i:i + 2], 16) for i in (1, 3, 5))
        need(px[3] == 255, 'the yard floor is opaque')
        print('yard pixel', px[:3], 'colour', col)
    else:
        sys.exit(f'unknown unit {unit}')
    print(unit, 'OK' if not bad else 'FAIL')
    for b in bad:
        print(' -', b)
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
