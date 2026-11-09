// hakoniwa ★66: two agents who message each other (hc send) meet on the floor for a few seconds and talk ("…" bubbles, in turns),
// then go back to where their state puts them. The messages come from the collector (state.messages: [{at, from, to}], agent ids).
// Same room: two free tiles of the aisle between their seats; different rooms: the middle of the lobby. Facing each other.
// Only people who are settled (at their desk or in the lounge, not walking / on an errand / an approval or report trip / at the door).
// The same pair at most once in 3 minutes; at most 2 pairs at once. A state change ends it at once (resetForChange calls meetEnd).

export const MEET_TALK_MS = 5000;      // the talk: "…" in turns, about 4-6 s
export const MEET_TURN_MS = 1250;      // one bubble's turn
export const MEET_PAIR_GAP_MS = 75000;   // ★71-2: the same two at most once in 75 s (was 3 min: a parent and a child almost never showed)
export const MEET_MAX = 3;                // at most 3 pairs at once (was 2)
export const MEET_HOLD_MS = 60000;       // ★71-2: a message waits up to 60 s for the two to be free (was dropped at once)
export const MEET_WALK_MS = 25000;
export const MEET_FAR_TILES = 14;           // ★88-6 a meeting point further than this (walking tiles) for somebody is moved to a nearer one
     // somebody who has not arrived by then: the meeting is called off

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Is this person free to go and meet? (p: the office's person; a: the agent)
export function meetFree(a, p, now = Date.now(), l86 = false) {
  if (!a || !p || p.leaving || p.doorEntering || p.walking || p.trip || p.meet || p.bowing) return false;
  if (p.busy && now < p.busy && !p.onBreak) return false; // ★71-2: a break is cut short for a talk (the coffee stays in hand); other errands are waited for
  if (p.onBreak) return true;
  if (a.status === "blocked") return false; // on the way to the approval desk
  const at = String(p.at ?? "");
  if (a.status === "done") return at === "desk" && (l86 || p.stand === "desk"); // ★86: a report stands at the own desk with the papers: it may talk too // a report: only once it is back at the desk (waiting for a reply), never on the way to the counter
  return at === "desk" || /^lounge:\d+$/.test(at);
}

// May a pair meet now? last: Map pairKey -> time of the last meeting; active: number of meetings going on.
export function meetAllowed(fromA, toA, pf, pt, last, active, now = Date.now(), l86 = false) {
  if (!fromA || !toA || fromA.id === toA.id || active >= MEET_MAX) return false;
  const k = pairKey(fromA.id, toA.id);
  if (last?.has(k) && now - last.get(k) < MEET_PAIR_GAP_MS) return false;
  return meetFree(fromA, pf, now, l86) && meetFree(toA, pt, now, l86);
}

// Facing each other on two neighbouring tiles (+x is down-right on the screen, +y down-left).
export function meetFacing(tA, tB) {
  const dx = tB[0] - tA[0], dy = tB[1] - tA[1];
  if (dx > 0) return ["dr", "ul"];
  if (dx < 0) return ["ul", "dr"];
  if (dy > 0) return ["dl", "ur"];
  return ["ur", "dl"];
}

// Whose bubble shows: side 0 (the sender) first, then in turns. null: the talk is over (or not begun).
export function talkTurn(talkAt, now = Date.now(), talkEnd = 0) {
  if (!talkAt || now < talkAt || now >= (talkEnd || talkAt + MEET_TALK_MS)) return null; // ★74-1 talkEnd: pushed back by every new message of the pair
  return Math.floor((now - talkAt) / MEET_TURN_MS) % 2;
}

// The new messages of the state: [{at, from, to}] after `seen` (ms). Returns { fresh, seen }.
export function freshMessages(messages, seen) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.from && m.to && Number(m.at) > seen);
  return { fresh: list.sort((m, n) => m.at - n.at), seen: list.reduce((s, m) => Math.max(s, Number(m.at)), seen) };
}

export class MeetPart {
  // From sync(): start a meeting for each new message (state.messages). The first look only learns what is there.
  meetFromState(list, cx) {
    const msgs = this.feed?.state?.messages;
    if (!Array.isArray(msgs)) return;
    if (this.meetSeen === undefined) { this.meetSeen = msgs.reduce((s, m) => Math.max(s, Number(m?.at) || 0), Date.now() - 15000); }
    const { fresh, seen } = freshMessages(msgs, this.meetSeen);
    this.meetSeen = seen;
    // ★71-2 new messages wait (up to 60 s) until both are free; the same pair waits once (the newest message)
    this.meetQueue ??= [];
    for (const m of fresh) { if (this.meetExtend(m.from, m.to)) continue; // ★74-1 the pair is talking now: the talk goes on (nobody walks off between 2-3 exchanges)
 const k = pairKey(m.from, m.to); this.meetQueue = this.meetQueue.filter((q) => pairKey(q.from, q.to) !== k); this.meetQueue.push({ from: m.from, to: m.to, at: Date.now() }); }
    if (!this.meetQueue.length) return;
    const byId = new Map(list.map((a) => [a.id, a])), now = Date.now();
    this.meetQueue = this.meetQueue.filter((q) => now - q.at < MEET_HOLD_MS && byId.has(q.from) && byId.has(q.to) && !this.meetEvent(byId.get(q.from), byId.get(q.to), cx));
    if (this.meetQueue.length && !this.meetRetry) this.meetRetry = cx.timer.after(1500, (cx) => { this.meetRetry = null; cx.notify(); }); // look again soon (a draw runs sync, which calls this)
  }

  // Two neighbouring free tiles: in the aisle between two seats of one room, else in the lobby's middle. null when there is none.
  meetTiles(sc, idA, idB) {
    if (!this.gridOn?.(sc)) return null;
    const dA = sc.desks?.[idA], dB = sc.desks?.[idB], pa = this.people.get(idA), pb = this.people.get(idB);
    const tileOf = (d, p) => d?.seat_tile ?? (p?.tile ?? (p?.pos ? this.xyTile(sc, p.pos) : null));
    const ta = tileOf(dA, pa), tb = tileOf(dB, pb);
    let mid;
    if (ta && tb && Math.abs(ta[0] - tb[0]) + Math.abs(ta[1] - tb[1]) <= 10 && dA && dB) mid = [Math.round((ta[0] + tb[0]) / 2), Math.round((ta[1] + tb[1]) / 2) + 1]; // one room: just off the desks, in the aisle
    else if (sc.l86) mid = [Math.max(2, sc.grid.cols - 3), Math.round(ta && tb ? (ta[1] + tb[1]) / 2 : sc.grid.rows / 2)]; // ★86: two rooms: the way along the rooms' open side (the one-column floor has no lobby middle)
    else {
      const door = this.doorGeometry?.(sc)?.insideTile ?? sc.door?.tile ?? [Math.floor(sc.grid.cols / 2), 1];
      const lounge = sc.spots?.lounge?.[0]?.tile, counter = sc.spots?.counter?.[0]?.tile;
      const far = lounge ?? counter ?? [Math.floor(sc.grid.cols / 2), Math.floor(sc.grid.rows / 2)];
      mid = [Math.round((door[0] + far[0]) / 2), Math.round((door[1] + far[1]) / 2)]; // the lobby's middle: between the entrance and the lounge
    }
    const taken = new Set([...this.takenTiles(idA, true), ...this.takenTiles(idB, true)]);
    const ring8 = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (const m of this.meets?.values() ?? []) for (const t of m.tiles) for (const [dx, dy] of ring8) taken.add(this.tkey([t[0] + dx, t[1] + dy])); // ★73-1 another pair's point and the tiles around it (a picture is wider than a tile: two pairs side by side looked like 4 people on one spot)
    for (const d of Object.values(sc.desks ?? {})) if (d?.seat_tile) taken.add(this.tkey(d.seat_tile)); // every seat, empty ones too
    for (const q of Object.values(sc.seats ?? {})) if (q?.tile) taken.add(this.tkey(q.tile));
    for (const q of sc.spots?.lounge ?? []) { const t = Array.isArray(q) ? q : q?.tile; if (t) taken.add(this.tkey(t)); }
    for (const [pid, q] of this.people ?? []) if (pid !== idA && pid !== idB && !q.leaving) { const t = q.curTile ?? (q.pos ? this.xyTile(sc, q.pos) : null); if (t) for (const [dx, dy] of ring8) taken.add(this.tkey([t[0] + dx, t[1] + dy])); } // where people stand now (not only where they are going)
    // (office-live) not in a window's queue, the entrance or the wave spot, nor right beside them: the lobby talk stood in the approval queue
    const tileOfSpot = (q) => (Array.isArray(q) ? q : q?.tile) ?? null, sp = sc.spots ?? {};
    for (const q of [...(sp.approval ?? []), ...(sp.counter ?? []), sp.entrance, sp.wave, ...(sc.wait_avoid ?? [])]) { const t = tileOfSpot(q); if (!t) continue; for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) taken.add(this.tkey([t[0] + dx, t[1] + dy])); }
    const tA = this.freeNear(sc, mid, taken);
    if (!this.walkable(sc, tA[0], tA[1]) || taken.has(this.tkey(tA))) return null;
    // ★88-6 two tiles apart first (a person's picture is wider than a tile: neighbours stood half inside each other), next to each other only when nothing else is free
    const pairAt = (t) => {
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tB = [t[0] + dx, t[1] + dy], md = [t[0] + dx / 2, t[1] + dy / 2];
        if (this.walkable(sc, tB[0], tB[1]) && !taken.has(this.tkey(tB)) && (Math.abs(dx) + Math.abs(dy) === 1 || this.walkable(sc, md[0], md[1]))) return [t, tB];
      }
      return null;
    };
    const first = pairAt(tA);
    // ★88-6 the way there: a point on the far side of a partition made a 35-tile walk round the room for a point 3 tiles away (the U-turns of e2e89's meetpace lines).
    // Walking distances from both seats (one flood fill each); when the first point costs more than MEET_FAR_TILES for somebody, the point with the shortest walk for the slower one wins.
    const tiles0 = (p, d) => p?.curTile ?? d?.seat_tile ?? null, sA = tiles0(pa, dA), sB = tiles0(pb, dB);
    if (first && sA && sB) {
      const flood = (start) => { const d = new Map([[this.tkey(start), 0]]), q = [start]; for (let i = 0; i < q.length; i++) { const [x, y] = q[i], dd = d.get(this.tkey(q[i])); if (dd >= 60) continue; for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [x + ox, y + oy], k = this.tkey(n); if (d.has(k) || !this.walkable(sc, n[0], n[1])) continue; d.set(k, dd + 1); q.push(n); } } return d; };
      const dA2 = flood(sA), dB2 = flood(sB), cost = (pr) => Math.max(dA2.get(this.tkey(pr[0])) ?? 999, dB2.get(this.tkey(pr[1])) ?? 999);
      if (cost(first) > MEET_FAR_TILES) {
        let best = first, bestC = cost(first);
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
          const t = [mid[0] + dx, mid[1] + dy];
          if (!this.walkable(sc, t[0], t[1]) || taken.has(this.tkey(t))) continue;
          const pr = pairAt(t); if (!pr) continue;
          const c = cost(pr) + (Math.abs(dx) + Math.abs(dy)) * 0.05;
          if (c < bestC) { best = pr; bestC = c; }
        }
        if (bestC < cost(first)) {                                // (side 0 is the sender: the tile nearer to each walker goes to that walker)
          const near0 = (dA2.get(this.tkey(best[0])) ?? 999) + (dB2.get(this.tkey(best[1])) ?? 999) <= (dA2.get(this.tkey(best[1])) ?? 999) + (dB2.get(this.tkey(best[0])) ?? 999);
          return near0 ? best : [best[1], best[0]];
        }
      }
    }
    return first;
  }

  meetEvent(fromA, toA, cx) {
    const sc = this.scene; if (!sc || !this.people) return false;
    this.meets ??= new Map(); this.meetLast ??= new Map();
    const pf = this.people.get(fromA?.id), pt = this.people.get(toA?.id), now = Date.now();
    if (!meetAllowed(fromA, toA, pf, pt, this.meetLast, this.meets.size, now, !!sc.l86)) return false;
    const tiles = this.meetTiles(sc, fromA.id, toA.id);
    if (!tiles) return false;
    const key = pairKey(fromA.id, toA.id), face = meetFacing(tiles[0], tiles[1]);
    const m = { key, ids: [fromA.id, toA.id], tiles, face, arrived: new Set(), talkAt: 0, at: now };
    this.meets.set(key, m); this.meetLast.set(key, now);
    m.after = m.ids.map((id, side) => (tcx) => { // (★89 kept on the meeting: a new floor plan sends the walkers on again with the same arrival, facing read at the time)
      const p = this.people.get(id); if (!p || p.meet !== key) return null;
      p.facing = m.face[side]; m.arrived.add(id);
      if (m.arrived.size === 2 && !m.talkAt) this.meetTalk(m, tcx ?? cx);
      return null;
    });
    m.ids.forEach((id, side) => {
      const p = this.people.get(id);
      if (p.onBreak) { if (p.breakJ >= 0) this.breakTaken?.delete(p.breakJ); p.breakJ = -1; p.onBreak = false; p.sitBreak = null; } // ★71-2 the break ends here: off to talk, coffee in hand
      p.meet = key; p.meetSide = side; p.busy = now + MEET_WALK_MS + MEET_TALK_MS + 5000;
      this.go(p, id, `meet:${tiles[side][0]},${tiles[side][1]}`, cx, side ? 300 : 0, m.after[side]);
    });
    this.meetNote?.({ kind: "meet", ids: m.ids, tiles, same: !!(this.scene?.desks?.[m.ids[0]] && this.scene?.desks?.[m.ids[1]]) });
    m.giveUp = cx.timer.after(MEET_WALK_MS, (cx) => { if (this.meets.get(key) === m && !m.talkAt) { this.meetEnd(key, cx); cx.notify(); } });
    return true;
  }

  // ★89 a new floor plan during a meeting: the talk goes on. The meeting point is moved to the new plan's coordinates (the same rule as at the start) and the
  // two walk on to it from where they are (no turn back to the seat); no free point in the new plan: they keep the old tiles and talk where they are.
  meetRewalk(sc, cx) {
    for (const m of [...(this.meets?.values() ?? [])]) {
      const ps = m.ids.map((id) => this.people?.get(id));
      if (ps.some((p) => !p || p.meet !== m.key || p.leaving)) continue;
      this.meets.delete(m.key); let tiles = null; try { tiles = this.meetTiles(sc, m.ids[0], m.ids[1]); } catch {} this.meets.set(m.key, m);
      if (tiles) { m.tiles = tiles; m.face = meetFacing(tiles[0], tiles[1]); }
      m.ids.forEach((id, side) => {
        const p = ps[side], key = `meet:${m.tiles[side][0]},${m.tiles[side][1]}`;
        if (!p.walking && !p.pathEnd && p.at === key) { const w = this.spot(sc, id, key, p); p.pos = [w.x, w.y]; p.dur = 0; p.moveUntil = 0; if (w.tile) p.curTile = w.tile; p.facing = m.arrived.has(id) ? m.face[side] : p.facing; return; } // already there: set down on the same tile of the new plan // already there, the same place
        if (!m.talkAt) m.arrived.delete(id);
        ++p.tok; p.walking = false; p.pathEnd = 0; p.pend = null; p.pendKey = null; // the old walk's timers die with the token; the moving picture goes on (moveUntil stays)
        if (this.gridOn?.(sc) && p.pos) p.curTile = this.xyTile(sc, p.pos);
        p.tile = null; this.go(p, id, key, cx, 0, m.after[side]);
      });
      m.giveUp?.cancel?.(); if (!m.talkAt) m.giveUp = cx.timer.after(MEET_WALK_MS, (cx) => { if (this.meets.get(m.key) === m && !m.talkAt) { this.meetEnd(m.key, cx); cx.notify(); } });
    }
  }

  // ★74-1 a new message between two who are meeting: both stay put (facing each other) until MEET_TALK_MS after the newest message.
  meetExtend(from, to) {
    const m = this.meets?.get(pairKey(from, to)); if (!m) return false;
    const end = Date.now() + MEET_TALK_MS;
    if (m.talkAt) m.talkEnd = Math.max(m.talkEnd ?? 0, end);
    for (const id of m.ids) { const p = this.people?.get(id); if (p && p.meet === m.key) p.busy = Math.max(p.busy ?? 0, end + 5000); }
    return true;
  }

  meetTalk(m, cx) {
    m.talkAt = Date.now(); m.talkEnd = m.talkAt + MEET_TALK_MS; this.meetNote?.({ kind: "meet-talk", ids: m.ids, walk: m.talkAt - m.at });
    const tick = (cx) => { if (this.meets.get(m.key) !== m) return; if (Date.now() >= m.talkEnd) { this.meetEnd(m.key, cx); cx.notify(); return; } cx.notify(); m.timer = cx.timer.after(MEET_TURN_MS, tick); };
    cx.notify(); m.timer = cx.timer.after(MEET_TURN_MS, tick);
  }

  // Over (or called off): both go back to where their state puts them now. `except`: somebody whose state changed (sync sends them on).
  meetEnd(key, cx, except = null) {
    const m = this.meets?.get(key); if (!m) return;
    this.meets.delete(key); this.meetNote?.({ kind: "meet-end", ids: m.ids, talked: m.talkAt ? Date.now() - m.talkAt : 0, why: except ? `state:${except}` : m.talkAt ? "done" : "no-arrival" });
    try { m.timer?.cancel?.(); m.giveUp?.cancel?.(); } catch {}
    for (const id of m.ids) {
      const p = this.people?.get(id); if (!p || p.meet !== key) continue;
      p.meet = null; p.meetSide = null; p.busy = 0; p.facing = null;
      if (id === except || p.leaving || !cx) continue;
      const k = this.keysNow?.get(id) ?? "desk";
      p.meetBack = true; this.goTo ? this.goTo(p, id, k, cx) : this.go(p, id, k, cx, 0); cx.timer.after(8000, () => { p.meetBack = false; }); // ★89 the way back is marked for live-check's pace count (until the walk ends or 8 s)
    }
  }

  // ★66 a line for live-check.jsonl (written with its next look): when meetings start, talk and end
  meetNote(o) { (this.liveNotes ??= []).push(JSON.stringify({ t: new Date().toISOString(), ...o })); if (this.liveNotes.length > 50) this.liveNotes.splice(0, this.liveNotes.length - 50); }

  // The "…" bubble over a person while they talk (side 0 first, then in turns). null when not talking.
  meetBubble(id, p) {
    const m = p?.meet && this.meets?.get(p.meet);
    if (!m || !m.talkAt || p.walking) return null;
    const turn = talkTurn(m.talkAt, Date.now(), m.talkEnd);
    return turn === null ? null : { mine: turn === p.meetSide };
  }
}
