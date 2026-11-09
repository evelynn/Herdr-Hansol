// hakoniwa floor grid (scene.grid): tiles, paths and the checks. Mixed into AgentHud (like office.js / chat.js).
//
// The scene (from office.py) has: grid {origin, tw, th, cols, rows, walk[row = gy][col = gx]: "." walkable / "#" not},
// objects [{id, kind, file, rect, depth, tiles}], spots with {tile, xy}, desks[id] {seat_tile, seat, chair, screen}.
// A tile (gx, gy) has its centre at origin + ((gx - gy) * tw / 2, (gx + gy) * th / 2); depth of a thing = gx + gy.
// Everything here is used only when the scene has `grid` and `objects`; otherwise the older one-picture floor is drawn.
import { writeTextFile, readTextFile, appHome } from "herdr";

export class GridPart {
  gridOn(sc) { return !!(sc?.grid?.walk && sc.objects); }

  tileXY(sc, [gx, gy]) {
    const g = sc.grid;
    return [g.origin[0] + (gx - gy) * g.tw / 2, g.origin[1] + (gx + gy) * g.th / 2];
  }

  xyTile(sc, [x, y]) {
    const g = sc.grid, u = (x - g.origin[0]) / (g.tw / 2), v = (y - g.origin[1]) / (g.th / 2);
    return [Math.round((u + v) / 2), Math.round((v - u) / 2)];
  }

  depthOfXY(sc, xy) { return (xy[1] - sc.grid.origin[1]) / (sc.grid.th / 2); }

  walkable(sc, gx, gy) {
    const row = sc.grid.walk[gy];
    return !!row && gx >= 0 && gx < row.length && row[gx] === ".";
  }

  tkey([gx, gy]) { return `${gx},${gy}`; }

  // Nearest walkable tile to `tile` that is not in `taken` (a Set of tile keys): breadth first.
  freeNear(sc, tile, taken) {
    const seen = new Set([this.tkey(tile)]), q = [tile];
    while (q.length) {
      const [gx, gy] = q.shift();
      if (this.walkable(sc, gx, gy) && !taken.has(this.tkey([gx, gy]))) return [gx, gy];
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const n = [gx + dx, gy + dy], key = this.tkey(n);
        if (!seen.has(key) && n[0] >= -1 && n[1] >= -1 && n[0] <= sc.grid.cols && n[1] <= sc.grid.rows) { seen.add(key); q.push(n); }
      }
    }
    return tile;
  }

  // A* on the walkable tiles (four neighbours: those run along the floor's own diagonals). Tiles in `blocked` (others standing)
  // cannot be crossed, except the start and the goal. No way: null.
  astar(sc, from, to, blocked) {
    const k0 = this.tkey(from), k1 = this.tkey(to);
    if (k0 === k1) return [from];
    const h = (t) => Math.abs(t[0] - to[0]) + Math.abs(t[1] - to[1]);
    const open = [{ t: from, g: 0, f: h(from) }], best = new Map([[k0, 0]]), prev = new Map();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0], ck = this.tkey(cur.t);
      if (ck === k1) {
        const path = [cur.t];
        for (let k = ck; prev.has(k);) { const p = prev.get(k); path.unshift(p); k = this.tkey(p); }
        return path;
      }
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const n = [cur.t[0] + dx, cur.t[1] + dy], nk = this.tkey(n);
        if (nk !== k1 && !this.walkable(sc, n[0], n[1])) continue; // the goal itself may be a seat (desk tile)
        if (nk !== k1 && blocked?.has(nk)) continue;
        const g = cur.g + 1;
        if (g < (best.get(nk) ?? 1e9)) { best.set(nk, g); prev.set(nk, cur.t); open.push({ t: n, g, f: g + h(n) }); }
      }
    }
    return null;
  }

  // The path as legs of at most 3 tiles in one direction (★89: no 250 ms floor: a short leg slowed the walk down): [{xy, depth, ms}]. `speed` in px/s.
  legsFromPath(sc, path, speed) {
    const legs = [];
    let i = 1;
    while (i < path.length) {
      const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1];
      let j = i;
      while (j + 1 < path.length && j - i < 2 && path[j + 1][0] - path[j][0] === dx && path[j + 1][1] - path[j][1] === dy) j++;
      const from = this.tileXY(sc, path[i - 1]), to = this.tileXY(sc, path[j]);
      const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      legs.push({ tile: path[j], xy: to, depth: this.depthOfXY(sc, mid), ms: Math.round(Math.max(60, Math.hypot(to[0] - from[0], to[1] - from[1]) / speed * 1000)) });
      i = j + 1;
    }
    return legs;
  }

  // ---- ★28: the door and the way to it.
  // The door's geometry from the scene: the tile people pass (door.tile / pass_tile; a wider door has more open_cells side by side), the first walkable tile past it (inside),
  // and the spot outside (where somebody appears and vanishes: door.appear / outside when A gives one, else the tile on the other side of the door).
  doorGeometry(sc) {
    if (!this.gridOn(sc)) return null;
    const d = sc.door ?? {}, open = (d.open_cells ?? d.cells ?? (d.tile ? [d.tile] : [])).filter(Boolean);
    const first = d.pass_tile ?? d.tile ?? open[0];
    if (!first) return null;
    const asXY = (v) => (v == null ? null : Array.isArray(v) ? v : v.xy ?? null);
    // ★55-6 the pass cell: the given one, else the first open cell that has a floor tile beside it (a double door: the first leaf's cell can sit next to a pier, the wall)
    for (const cell of d.pass_tile ? [first] : [first, ...open.filter((c) => !(c[0] === first[0] && c[1] === first[1]))]) {
      const isCell = (t) => open.some((c) => c[0] === t[0] && c[1] === t[1]) || (t[0] === cell[0] && t[1] === cell[1]);
      let insideTile = d.inside?.tile ?? null, unit = null, depthCells = [];
      if (!insideTile) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { // a doorway can be 2-3 tiles deep (the wall is thick): look through it for the first floor tile
        for (let st = 1; st <= 3; st++) { const n = [cell[0] + dx * st, cell[1] + dy * st]; if (this.walkable(sc, n[0], n[1])) { if (!isCell(n)) { insideTile = n; unit = [dx, dy]; depthCells = Array.from({ length: st - 1 }, (_, i) => [cell[0] + dx * (i + 1), cell[1] + dy * (i + 1)]); } break; } }
        if (insideTile) break;
      }
      const outTile = insideTile ? (unit ? [cell[0] - unit[0], cell[1] - unit[1]] : [cell[0] * 2 - insideTile[0], cell[1] * 2 - insideTile[1]]) : null;
      const outside = asXY(d.appear) ?? asXY(d.outside) ?? (outTile ? this.tileXY(sc, outTile) : null);
      if (!outside || !insideTile) continue;
      return { cell, cells: [cell, ...depthCells].map((t) => ({ tile: t, xy: this.tileXY(sc, t) })), insideTile, inside: asXY(d.inside) ?? this.tileXY(sc, insideTile), outside, vanish: asXY(d.vanish) ?? asXY(d.disappear) ?? outside };
    }
    return null;
  }

  // Every tile that can be reached from `goal` over walkable tiles (a wall of people or chairs does not count: only the floor). Breadth first.
  reachableFrom(sc, goal) {
    const seen = new Set([this.tkey(goal)]), q = [goal], out = [];
    while (q.length) {
      const [gx, gy] = q.shift(); out.push([gx, gy]);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const n = [gx + dx, gy + dy], k = this.tkey(n); if (!seen.has(k) && this.walkable(sc, n[0], n[1])) { seen.add(k); q.push(n); } }
    }
    return out;
  }

  // The way from `from` to `to`: first with every wall (people, chairs), then without the people, then with none. When even that finds nothing (the person
  // stands cut off from the goal) the nearest tile that does connect to the goal is taken (rescued: the person is moved there first).
  // Returns { path, reached, rescued: tile | null, tier }.
  routeTo(sc, from, to, walls, seatWalls) {
    const tiers = [walls, seatWalls ?? new Set(), new Set()];
    for (let i = 0; i < tiers.length; i++) { const path = this.astar(sc, from, to, tiers[i]); if (path) return { path, reached: true, rescued: null, tier: i }; }
    const ok = this.reachableFrom(sc, to);
    let best = null, bd = 1e9; for (const t of ok) { const d = Math.abs(t[0] - from[0]) + Math.abs(t[1] - from[1]); if (d < bd) { bd = d; best = t; } }
    if (!best) return { path: [from], reached: false, rescued: null, tier: 3 };
    const path = this.astar(sc, best, to, new Set());
    return { path: path ?? [best], reached: !!path, rescued: best, tier: 3 };
  }

  // Tiles taken by people who stand (or are going to stand) somewhere, except `id`.
  takenTiles(id, wide) {
    const taken = new Set();
    for (const [pid, p] of this.people ?? []) if (pid !== id && p.tile && !p.leaving) {
      taken.add(this.tkey(p.tile));
      if (wide) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) taken.add(this.tkey([p.tile[0] + dx, p.tile[1] + dy])); // a picture is bigger than a tile
    }
    return taken;
  }

  // Where a place key leads in a grid scene: {tile, xy}. The place is moved to a free tile nearby when somebody stands on it.
  gridTarget(sc, id, key, p) {
    const taken = this.takenTiles(id, (p?.bump ?? 0) > 0);
    const spotOf = (s) => (Array.isArray(s) ? { xy: s, tile: this.xyTile(sc, s) } : { xy: s.xy, tile: s.tile ?? this.xyTile(sc, s.xy), facing: s.facing ?? null });
    let t;
    if (key.startsWith("stand:")) { const q = (sc.stand_points ?? [])[Number(key.slice(6))]; if (q?.tile) return { tile: q.tile, xy: q.xy ?? this.tileXY(sc, q.tile), facing: q.facing ?? null }; }
    if (key.startsWith("meet:")) { const [mx, my] = key.slice(5).split(",").map(Number); if (Number.isFinite(mx) && Number.isFinite(my)) { const tile = this.walkable(sc, mx, my) && !taken.has(this.tkey([mx, my])) ? [mx, my] : this.freeNear(sc, [mx, my], taken); return { tile, xy: this.tileXY(sc, tile) }; } } // ★66 a meeting tile (meet.js)
    if (key === "wave") { const q = sc.spots?.wave; if (q?.tile) return { tile: q.tile, xy: q.xy ?? this.tileXY(sc, q.tile), facing: q.facing ?? null }; }
    if (key.startsWith("wait:")) { // seatless people stand in free tiles around the entrance, one each (the door tile itself and every taken tile are kept clear)
      const d = sc.door ?? {}, base = d.tile ? [d.tile[0] + 2, d.tile[1]] : this.xyTile(sc, sc.spots?.entrance?.xy ?? [sc.width / 2, sc.height / 2]);
      const tk = new Set([...taken, ...(d.open_cells ?? [d.tile]).filter(Boolean).map((c) => this.tkey(c)), ...(sc.wait_avoid ?? []).map((c) => this.tkey(c))]), n = Number(key.slice(5)) || 0, around = []; // ★63: never on / in front of the machines' row
      for (let i = 0; i <= n; i++) { const t = this.freeNear(sc, base, new Set([...tk, ...around.map((c) => this.tkey(c))])); around.push(t); }
      const tile = around[n]; return { tile, xy: this.tileXY(sc, tile) };
    }
    if (key === "doorin") { const g = this.doorGeometry(sc); if (g?.insideTile) return { tile: g.insideTile, xy: g.inside }; }
    if (key === "door") { const d = sc.door ?? {}; const s = d.tile ? { tile: d.tile, xy: this.tileXY(sc, d.tile) } : spotOf(d.spot ?? sc.spots.entrance); return s; }
    if (key === "desk") { const d = sc.desks?.[id]; if (d) return { tile: d.seat_tile ?? this.xyTile(sc, d.seat), xy: d.seat }; }
    if (key.startsWith("beside@")) {
      const d = sc.desks?.[key.slice(7)];
      if (d) { const tile = this.freeNear(sc, (d.seat_tile ?? this.xyTile(sc, d.seat)).map((v, i) => v + (i ? 0 : 1)), taken); return { tile, xy: this.tileXY(sc, tile) }; }
    }
    const [kind, i] = key.split(":"), arr = sc.spots?.[kind] ?? [], n = Number(i);
    if (arr.length) {
      if (n < arr.length) t = spotOf(arr[n]);
      else { const last = spotOf(arr[arr.length - 1]); const spotTiles = new Set(arr.map((s) => this.tkey(spotOf(s).tile))); const tile = this.freeNear(sc, last.tile, new Set([...taken, ...spotTiles])); t = { tile, xy: this.tileXY(sc, tile) }; }
    } else t = spotOf(sc.spots?.entrance ?? { xy: [sc.width / 2, sc.height / 2] });
    if (taken.has(this.tkey(t.tile))) { const tile = this.freeNear(sc, t.tile, taken); t = { tile, xy: this.tileXY(sc, tile) }; }
    return t;
  }

  // ---- checks: how many standing people share a tile / stand on a tile nobody may walk on. Written for the test.
  checkLayout(sc, cx) {
    if (!this.gridOn(sc) || Date.now() - (this.checkedAt ?? 0) < 4000) return;
    this.checkedAt = Date.now();
    const seen = new Map();
    let same = 0, blocked = 0;
    for (const [, p] of this.people ?? []) {
      if (!p.tile || p.walking || p.leaving) continue;
      const k = this.tkey(p.tile);
      if (seen.has(k)) same++; else seen.set(k, 1);
      if (!this.walkable(sc, p.tile[0], p.tile[1]) && !p.seated) blocked++;   // a seat is inside its desk's tiles: allowed
    }
    // the pictures' own rectangles (a person is wider than a tile): count overlaps between standing people, and nudge one of each pair
    let rect_overlap = 0;
    const stand = [...(this.people ?? [])].filter(([, p]) => p.pos && !p.walking && !p.leaving && !p.seated && p.last).map(([id, p]) => {
      const f = sc.people?.[id] ?? Object.values(sc.people ?? {})[0] ?? {}, kk = this.poseFiles(f, p.last, p).key;
      const ps = sc.pose_size?.[kk] ?? sc.pose_size?.stand ?? { w: 40, h: 90 };
      return { id, p, x: p.pos[0] - ps.w * 0.35, y: p.pos[1] - ps.h * 0.9, w: ps.w * 0.7, h: ps.h * 0.9 }; // the body, not the transparent margin
    });
    for (let i = 0; i < stand.length; i++) for (let j = i + 1; j < stand.length; j++) {
      const a = stand[i], b = stand[j];
      const inQueue = (q) => /^(approval|counter):/.test(String(q.p.at)) && !!(sc.spots?.[String(q.p.at).split(':')[0]] ?? [])[0]?.facing;
      if (inQueue(a) && inQueue(b)) continue; // a window queue is one line, front to back: the pictures overlap by design, nobody is pushed out of it
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        rect_overlap++;
        if ((b.p.bump ?? 0) < 3) { b.p.bump = (b.p.bump ?? 0) + 1; this.go(b.p, b.id, b.p.at, cx, 0); } // a free tile further off
      }
    }
    const text = JSON.stringify({ at: Date.now(), standing: seen.size, same_tile: same, on_blocked_tile: blocked, rect_overlap });
    const path = `${appHome()}/hakoniwa-office/layout-check.json`;
    cx.spawn(async () => { try { await writeTextFile(path, text, await readTextFile(path)); } catch {} });
  }
}
