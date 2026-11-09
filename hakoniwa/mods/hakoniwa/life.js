// hakoniwa: the small pure rules of the office's "life" (no gpui, so node can run them: see test-life.mjs).
export const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// The moon's phase from the date: 0 new, 1 waxing crescent, 2 first quarter, 3 waxing gibbous, 4 full, 5 waning gibbous, 6 last quarter, 7 waning crescent.
export function moonPhase(ms = Date.now()) {
  const syn = 29.530589, age = (((ms - Date.UTC(2000, 0, 6, 18, 14)) / 86400000) % syn + syn) % syn;
  return { age, step: Math.floor((age / syn) * 8 + 0.5) % 8 };
}

// Who may take a short break: an idle person who keeps the seat and sits in the lounge queue, about 3 in 10 (stable per person + idle start),
// and never more than a quarter of everybody (at least 1) resting at once.
// ★86 (one-column floor): a waiting person sits at the own desk (key "desk"); the break is the same short walk to the drinks and back with the cup, 1-2 at a time.
export function wantsBreak(a, hasSeat, key, l86 = false) { return a.status === "idle" && (String(key).startsWith("lounge:") || (l86 && String(key) === "desk")) && !!hasSeat && hash(a.id + String(a.since)) % 10 < 3; }
export function breakAllowed(resting, total, l86 = false) { return resting + 1 <= (l86 ? 2 : Math.max(1, Math.floor(total / 4))); }
export const breakSeconds = (id) => 5 + (hash(id) % 4);

// ---- ★101-8 the sofa / nap pictures (a seated armchair, a doze, a sofa) belong to the old two-column floor. On the one-column
// floor (L86) a waiting person sits at the own desk (office.js's read_pc picture, red mug on the desk) and a leaving person only
// walks from the seat to the door: wherever the pose code would fall back to the lounge, it stands instead.
// Returns that picture ("stand") on L86, and null on the old floors (the caller keeps its sofa / nap branches there).
export const l86WaitPose = (l86 = false) => (l86 ? "stand" : null);

// Desk things by state. gb = memory in GB (null: unknown), wk = minutes of work. Returns the picture stage for each prop (-1 / 0 = none).
export function deskStage(gb, wk, nDrinks = 4) {
  const papers = gb == null ? 0 : Math.min(4, Math.floor(gb / 0.5) + 1); // 1..4: more mess
  const drink = wk < 20 ? -1 : Math.min(nDrinks - 1, Math.floor(wk / 45)); // the longer the work, the more cans
  return { papers, drink }; // (★38: the boxes and the desk lamp are no longer drawn)
}

// ---- ★45 a seated person and the desk's things. Higher depth = nearer the viewer.
// Facing away (the usual seat): the person is in front of the whole desk, so the desk slices count too.
// Facing the viewer (a clerk behind the desk): the desk's front board is in front of the person, so only the things on it count;
// the person stays in front of the papers / PC and behind that board.
export function seatFacingViewer(seat, objects, key) {
  const sy = Number(seat?.xy?.[1]);
  if (!Number.isFinite(sy)) return false;
  let y0 = Infinity, y1 = -Infinity;
  for (const o of objects ?? []) {
    if (!o || !Array.isArray(o.rect) || !String(o.id).startsWith(`desk:${key}`)) continue;
    y0 = Math.min(y0, Number(o.rect[1])); y1 = Math.max(y1, Number(o.rect[1]) + Number(o.rect[3]));
  }
  if (Number.isFinite(y0)) return (y0 + y1) / 2 > sy + 4; // the desk's middle is nearer the viewer than the seat
  let py = -Infinity;
  for (const q of Object.values(seat?.props ?? {})) if (Array.isArray(q?.at)) py = Math.max(py, Number(q.at[1]));
  return Number.isFinite(py) && py > sy + 4;
}
export function seatedDepth(seat, desk, objects, id) {
  const key = desk?.seat_id ?? id, things = [], slices = [];
  for (const q of Object.values(seat?.props ?? {})) { const n = Number(q?.depth); if (Number.isFinite(n)) things.push(n); }
  { const n = Number(seat?.laptop?.depth); if (Number.isFinite(n)) things.push(n); }
  for (const o of objects ?? []) { if (o && String(o.id).startsWith(`desk:${key}`)) { const n = Number(o.depth); if (Number.isFinite(n)) slices.push(n); } }
  const base = Number(desk?.seat_depth ?? seat?.depth), thingMax = Math.max(Number.isFinite(base) ? base : 0, ...things);
  if (seatFacingViewer(seat, objects, key)) { // behind the front board, in front of the things
    const board = slices.length ? Math.min(...slices) : Infinity;
    return Math.max(thingMax + 0.01, Math.min(thingMax + 0.5, board - 0.5));
  }
  return Math.max(thingMax, ...slices) + 0.5; // facing away: in front of the whole desk
}

// Stars: only at night with a clear sky; the moon at night with a clear or partly cloudy sky.
export const starsShown = (period, kind) => period === "night" && kind === "clear";
export const moonShown = (period, kind) => period === "night" && ["clear", "partly"].includes(kind);

// Who may leave the desk for an errand: the person who is working never does (the short automatic-approval trip is a walk of its own, not an errand).
// A report going to the counter (done) may stop at the printer; a waiting person (idle) may take a short break in the lounge.
export function errandAllowed(a, key, l86 = false) {
  const k = String(key);
  if (a.status === "working" || a.status === "blocked") return false;
  if (k.startsWith("counter:")) return a.status === "done";
  if (k.startsWith("lounge:")) return a.status === "idle";
  if (k === "desk") return a.status === "idle" && l86; // ★86: a waiting person at the own desk may take a break
  return false;
}

// How the name tags are shown by the number of AGENTS (not of people being drawn): up to 15: a tag with the state mark and the work for everybody;
// 16-30: tags only for waiting / reporting / chosen people, the rest a colour dot; 31+: plates carry the numbers, a few tags, "Zzz" for the sleepers.
export const tierFor = (n) => (n <= 15 ? "tags" : n <= 30 ? "dots" : "dense");

// ---- Usage: only real values. Windows not in use (is_active false), and windows past their reset time, are not shown; the extra spend is one small line;
// Codex says how old its record is (it is read from the newest Codex session log, not asked live).
export const fmtUsd = (cents) => (cents % 100 === 0 ? `$${String(cents / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : `$${(cents / 100).toFixed(2)}`);
export const USAGE_STALE_MS = 15 * 60000; // ★88-6: a Claude usage figure older than this is shown grey with its age (Claude Code refreshes its cache only now and then: 73% stayed up for 2 h while the truth was 100%)
export const usageAge = (w, now) => (w?.fetched_at && now - w.fetched_at > USAGE_STALE_MS ? ageText(now - w.fetched_at) : null);
export const ageText = (ms) => (ms < 60000 ? "いま" : ms < 3600000 ? `${Math.round(ms / 60000)}分前` : `${Math.round(ms / 3600000)}時間前`);
export function usageParts(claude, codex, now, demo) {
  const live = (w) => !!w && w.percent != null && !(w.resets_at != null && Number(w.resets_at) < now);
  const out = { demo: !!demo, claude: null, codex: null };
  if (claude && live(claude.session)) {
    const ex = claude.extra;
    out.claude = { age: usageAge(claude, now), session: claude.session, weekly: (claude.weekly ?? []).filter((w) => w.active !== false && live(w)),
      extra: ex && ex.enabled !== false && ex.used != null && ex.limit != null ? `追加枠 ${fmtUsd(ex.used)} / ${fmtUsd(ex.limit)}` : null };
  }
  if (codex && (live(codex.session) || live(codex.weekly)))
    out.codex = { rows: [codex.session, codex.weekly].filter(live), age: codex.fetched_at && now - codex.fetched_at > 1800000 ? `${ageText(now - codex.fetched_at)}の記録` : null };
  return out;
}
// A state file made by the demo collector says so ("demo": true); it is shown only while the demo is on, and a real state never carries it.
export const stateMatches = (state, demoOn) => !state || (state.demo === true) === !!demoOn;

// ---- The lounge: a waiting person sits. Every real seat is used before any standing point, and a seat is never skipped for being "too close" to another picture.
export const isSeatSpot = (q) => !!q && !Array.isArray(q) && !!q.seat;
export function loungeOrder(spots) { // indices of the lounge spots: seats first (in order), then standing points
  const idx = spots.map((_, i) => i);
  return idx.sort((i, j) => (isSeatSpot(spots[i]) ? 0 : 1) - (isSeatSpot(spots[j]) ? 0 : 1) || i - j);
}
export function loungeAssign(nWaiting, spots) { // who gets which spot, and how many have to stand (0 whenever there are enough seats)
  const order = loungeOrder(spots), places = order.slice(0, nWaiting);
  return { places, standing: Math.max(0, nWaiting - spots.filter(isSeatSpot).length) };
}

// An automatic-approval trip shows the "papers out" picture only while the person is at the approval desk; any other destination ends the trip
// (a person who went back to the desk must type again, never keep a hand raised).
export const tripShowsPapers = (trip, at) => (trip === "ask" || trip === "ok") && String(at).startsWith("approval");
export const tripEndsAt = (trip, key) => !!trip && !String(key).startsWith("approval");

// Every new walk (go) ends the temporary poses of the old move: bowing, an approval trip (unless the new place is the approval desk), a sit-down break, reading.
// Returns the ids to forget from the trips set. Nobody keeps a bow, a raised hand or a coffee cup into the next move.
export function clearTransient(p, key) {
  p.bowing = false; p.sitBreak = null; p.reading = false;
  if (tripEndsAt(p.trip, key)) { p.trip = null; p.evN = 0; p.okAt = 0; return true; }
  return false;
}

// ---- ★26-1 the detail column: the same sections in the same order for every agent. Only the conversation's source differs
// (an App agent's real terminal, or the recorded conversation laid out like a terminal: newest at the bottom).
export function detailSections(hasTerminal, { hasTree = false, canOpen = false } = {}) {
  return ["title", "card", ...(hasTree ? ["tree"] : []), "conversation-head", hasTerminal ? "terminal" : "transcript", ...(canOpen && !hasTerminal ? ["open-button"] : [])];
}
// Height (px) of the mod part above a real terminal: the title row, the card, the family tree (when there is one) and the conversation heading.
// ★47-3 folds: the agent's details (default: one line) and the family tree (default: folded when there are more than 3 children). fold = { card, tree } (true = open, undefined = the default).
// The terminal keeps at least 60% of the column: when the top part would take more than 40% the tree, then the details are folded whatever was asked.
export function foldState(treeRows = 0, fold = {}, paneH = 560) {
  const f = fold ?? {}, kids = Math.max(0, treeRows - 1);
  let cardOpen = f.card === true, treeOpen = treeRows > 1 && (f.tree ?? kids <= 3);
  const high = (c, t) => 58 + (c ? 36 + 184 : 36) + (treeRows > 1 ? (t ? 8 + 16 + 22 + Math.min(14, treeRows) * 25 + (treeRows > 14 ? 16 : 0) : 8 + 26) : 0) + 44 + 24; // ★50-7: +24 of air under the "最近の会話" heading, so the terminal's frame never covers it
  if (high(cardOpen, treeOpen) > paneH * 0.4) treeOpen = false;
  if (high(cardOpen, treeOpen) > paneH * 0.4) cardOpen = false;
  return { cardOpen, treeOpen, height: high(cardOpen, treeOpen) };
}
export const detailTopHeight = (treeRows = 0, fold = {}, paneH = 560) => foldState(treeRows, fold, paneH).height;
// The recorded conversation laid out like a terminal opens at the bottom: the newest messages that fit the height, oldest on top (estimated: a line is 17 px, a message has a 34 px frame).
export function fitTail(msgs, widthPx, heightPx) {
  const perLine = Math.max(8, Math.floor((widthPx - 48) / 7.2)), cost = (m) => (m.role === "tool" ? 34 : 34 + 17 * Math.max(1, Math.ceil(String(m.text ?? "").length / perLine)) );
  const out = []; let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) { const c = cost(msgs[i]) + 8; if (out.length && used + c > heightPx) break; out.unshift(msgs[i]); used += c; }
  return out;
}

// ---- ★28-2 the door. One timeline per entry / exit; the office plays it with timers and the tests read it as data.
// geom: { outside: [x, y] (where somebody appears / vanishes), cells: [{ xy }] (the door's tiles, outside to inside), inside: [x, y] (the first spot past the door) }.
// A segment: { phase: "closed" | "half" | "open" (the door during it), ms, move?: [x, y] (a walk to there), ev?: "appear" | "vanish" }.
// The rules: a walk through the door happens only while the door is "open"; nobody appears or vanishes anywhere but outside; the door is "half" while opening / closing.
export const DOOR_OPEN_MS = 220, DOOR_FULL_MS = 140, DOOR_CLOSE_MS = 260;
export function doorTimeline(kind, geom, walkMs = (a, b) => Math.max(250, Math.hypot(b[0] - a[0], b[1] - a[1]) * 11)) {
  const { outside, cells, inside } = geom, segs = [];
  const through = (from, to) => { // the walk across the doorway
    let at = from; const pts = [...cells.map((c) => c.xy), ...(to ? [to] : [])];
    for (const q of pts) { segs.push({ phase: "open", move: q, ms: Math.round(walkMs(at, q)) }); at = q; }
  };
  const opening = () => segs.push({ phase: "half", ms: DOOR_OPEN_MS }, { phase: "open", ms: DOOR_FULL_MS });
  const closing = () => segs.push({ phase: "half", ms: DOOR_CLOSE_MS }, { phase: "closed", ms: 0 });
  if (kind === "enter") { segs.push({ phase: "closed", ms: 120, ev: "appear", at: outside }); opening(); through(outside, inside); closing(); }
  else { opening(); through(inside, outside); segs[segs.length - 1].ev = "vanish"; closing(); }
  return segs;
}
// What the door looks like now, from everyone's own phase (the highest wins): "open" > "half" > "closed".
export function doorStateOf(phases) { return phases.includes("open") ? "open" : phases.includes("half") ? "half" : "closed"; }

// ---- ★28-1 somebody who cannot get on: how long since they last moved (ms) before the walk is drawn again (3 s) and what is done.
export const STUCK_MS = 3000;
// p: { walking, pathEnd (when the walk should have ended), at, stand, idleSince }. Returns null, "replan" (draw the route again) or "rescue" (move to the nearest walkable tile, then walk again).
export function stuckAction(p, now, tries = 0) {
  const overdue = p.walking && p.pathEnd && now > p.pathEnd + STUCK_MS, lost = !p.walking && p.at && p.stand !== p.at && p.idleSince != null && now - p.idleSince >= STUCK_MS;
  if (!overdue && !lost) return null;
  return tries >= 1 ? "rescue" : "replan";
}

// ---- ★29-2 anybody (in any state) who is not where the state says: what is wrong, and how long to wait before drawing the walk again.
// p: { walking, pathEnd, at, stand, pendKey }, want: the place key the state asks for (null: unknown, not judged), far: standing still but far from the place's point.
// Returns null or { reason, ms }. Reasons: "state-missed" (a state change was not taken up), "off-spot" (stands far from the place), and for a walk that does not end /
// a stop short of the goal the reason the last route gave (p.diag: "no-route" | "no-spot" | "blocked"), "no-route" when it gave none.
export const STUCK_FAST_MS = 1500;
export function stuckCheck(p, want, far = false, now = Date.now()) {
  if (p.walking) return p.pathEnd && now > p.pathEnd + STUCK_MS ? { reason: p.diag ?? "no-route", ms: 0 } : null;
  if (want && p.at !== want && p.pendKey !== want) return { reason: "state-missed", ms: STUCK_FAST_MS };
  if (p.at && p.stand !== p.at) return { reason: p.diag ?? "no-route", ms: STUCK_MS };
  if (far) return { reason: "off-spot", ms: STUCK_FAST_MS };
  return null;
}

// ---- ★29-1 a report is a short trip: seat -> the counter (hand the paper over, 3-4 s) -> back to the seat, the PC still open, "waiting for a reply".
// rep: { since, phase: "go" | "wait" } kept per person (office.reps). While `go` the person holds a place in the counter queue; in `wait` they sit at their own seat
// (and give the queue place up). It ends with the `done` state itself (the collector keeps `done` for 10 min, then it is idle and the usual waiting rules apply).
export const replyWaiting = (rep, a, hasSeat) => !!rep && !!hasSeat && a?.status === "done" && rep.since === a.since && rep.phase === "wait";

// ---- ★47-2 the bird outside is drawn at a fifth of the picture's own size (it looked like a huge shadow on the wall).
export const BIRD_SCALE = 0.2;

// ---- ★26-4 a flock of birds: each bird flaps at its own moment (frame offset and period), and flies a little apart from the others.
export function flockBirds(paths, pick, n) {
  const list = Array.isArray(paths) ? paths : [], first = list.length ? list[pick % list.length] : null;
  if (!first) return [];
  const same = list.filter((q) => q === first || (q.group != null ? q.group === first.group : JSON.stringify(q.clip ?? q.glass ?? null) === JSON.stringify(first.clip ?? first.glass ?? null)));
  const out = []; for (let i = 0; i < Math.max(1, n); i++) { const q = same[i % same.length]; out.push({ path: q, i, lag: i * 380 + hash(`bird${i}`) % 260, phase: (hash(`wing${i}`) % 6) + i, off: same.length >= n ? [0, 0] : [-i * 10, ((i % 3) - 1) * 8] }); } // too few paths: the same one, shifted a little
  return out;
}
export const wingFrame = (tick, phase, count) => (((tick + phase) % count) + count) % count;

// ---- ★38 the legend's marks. Only what office.js really draws: `src` is the drawing code's word.
// `icon` is what the legend draws: a part name from the sheet manifest (a picture), or `glyph` (the same marks the floor draws:
// a disc with ! / ✓, the blue dot, the gold ring, the white "…" bubble, the red mug). ★101-6: one short line each, no brackets.
export const LEGEND_MARKS = [
  { key: "papers", label: "書類の山", meaning: "メモリが多い", src: "deskProps.papers", icon: { part: "desk_papers2" } },
  { key: "drinks", label: "缶・カップ", meaning: "作業が長い", src: "deskProps.drinks", icon: { part: "desk_can1" } },
  { key: "mug", label: "赤いマグ", meaning: "待機", src: "★95 a waiting person has the RED mug", icon: { glyph: "mug" } },
  { key: "work", label: "青い丸", meaning: "作業中", src: "bg(st.color)", icon: { glyph: "dot", color: "#2F80ED" } }, // ★76 (the state marks stay)
  { key: "approve", label: "赤い !", meaning: "承認待ち", src: 'disc("!"', icon: { glyph: "disc", text: "!", color: "#d9480f" } },
  { key: "report", label: "緑の ✓", meaning: "報告あり", src: 'disc("✓"', icon: { glyph: "disc", text: "✓", color: "#1f9d55" } },
  { key: "parent", label: "金の輪", meaning: "リーダー", src: "lead-ring-", icon: { glyph: "ring", color: "#e0a90f" } }, // ★75-1 (was the ★ over the head)
  { key: "talk", label: "…", meaning: "会話中", src: "talk-${id}", icon: { glyph: "bubble" } }, // ★66: the only mark over the head
];

// ---- ★30-8 the desk PC by state (the user's rule), with its picture. The legend shows these five lines with the marks above.
export const LEGEND_PC_RULES = [
  { key: "working", label: "作業中", meaning: "座り、PCでコード", icon: { part: "laptop_on" } },
  { key: "away", label: "承認・報告", meaning: "こちらを向いて立つ（空の手を挙げる＝承認待ち／書類＝報告あり）", icon: { part: "laptop_dim" } },
  { key: "idle", label: "待機", meaning: "席に座る（机に赤いマグ＝指示待ち）", icon: { part: "desk_mug" } }, // ★92 (was: 返事待ち / 休憩 as two more lines: the seated reply and the cup are gone; every idle person holds the red mug)
  { key: "spare", label: "予備の席", meaning: "机だけ", icon: { part: "desk_free" } },
];

// self-review-0505 #7: the folded legend is a small strip of four pictures (the target picture 20261103_211508.png): the desk PC by state.
// Pressing it opens the whole legend again (★43: folded, never gone).
export const LEGEND_STRIP = [
  { key: "working", label: "作業中", part: "laptop_on" },
  { key: "away", label: "承認・報告", part: "laptop_dim" },
  { key: "idle", label: "待機", part: "desk_mug" },
  { key: "spare", label: "予備", part: "desk_free" },
];

// self-review-0505 #10: one kind of room name, the near-white plate in front of the room (the target picture). A room the layout gave no
// plate (★31-3: two rooms facing each other across one aisle) gets one here, in the aisle at its doorway: each slides 1.5 tiles along the
// aisle away from the other, and its arrow points at its own room. Marked `aisle`; returns the scene (changed in place, once per scene).
export function fillPlates(sc) {
  const g = sc?.grid;
  for (const isl of sc?.islands ?? []) {
    if (isl.plate?.at) continue;
    if (sc?.l86 && g?.tw && isl.opening) { // ★100-2 a room the builder gave no plate gets it just OUTSIDE its aisle-side entrance (the opening), never over the doorway
      const at = isl.opening;
      isl.plate = { at: [at[0] + g.tw * 0.68, at[1] + (g.th ?? 0) * 0.68], size: [150, 20], aisle: true };
      continue;
    }
    if (!isl.opening) continue;
    const at = isl.opening, rc = isl.rect ? [isl.rect[0] + isl.rect[2] / 2, isl.rect[1] + isl.rect[3] / 2] : at;
    const dx = rc[0] - at[0], dy = rc[1] - at[1], sl = g?.tw ? (dx < 0 ? -1 : 1) * 1.5 : 0;
    isl.plate = { at: [at[0] - sl * (g?.tw ?? 0) / 2, at[1] + 18 + sl * (g?.th ?? 0) / 2], size: [150, 20], aisle: true, arrow: dy < 0 ? (dx < 0 ? "↖" : "↗") : (dx < 0 ? "↙" : "↘") };
  }
  return sc;
}

// ★39 the commander: an agent with no parent that has children. Returns { commander, kids (count), parent (the parent agent or null) } for the agent `a` in `list`.
export function commanderInfo(a, list) {
  const byId = new Map(list.map((x) => [x.id, x]));
  const parent = a.parent_id ? byId.get(a.parent_id) ?? null : null;
  const kids = list.filter((x) => x.parent_id === a.id).length;
  return { commander: !a.parent_id && kids > 0, kids, parent };
}

// ---- ★64 the App counts its own oddities (office-live): one person's facts at one look (every 2 s, from a timer) -> the kinds seen now and the memo for the next look.
// s: { moving, own (the person's own picture pack), frames (pictures drawn), key (pose), pos (where it is drawn now, on the floor), inLeg (a move is running), away (not at
// the place its state asks for), exempt (in the doorway / leaving / on an errand) }. Kinds: "shadow" (only the shadow: no own picture or none at all), "stomp" (walking
// but not moving for 2 s), "stopped" (not walking, away from its place for 3 s), "slide" (moving without a walking picture). `fresh` = kinds that were not there last look.
export const LIVE_STOMP_MS = 2000, LIVE_STOP_MS = 3000;
export function liveKinds(s, memo = {}, now = Date.now()) {
  const m = { pos: memo.pos ?? null, posAt: memo.posAt ?? now, awayAt: memo.awayAt ?? null, movingAt: s.moving ? (memo.movingAt ?? now) : null, open: memo.open ?? [] };
  if (s.pos && (!m.pos || Math.hypot(s.pos[0] - m.pos[0], s.pos[1] - m.pos[1]) >= 0.5)) { m.pos = [s.pos[0], s.pos[1]]; m.posAt = now; }
  const kinds = [];
  if (!s.own || !s.frames) kinds.push("shadow");
  m.stillAt = s.moving && (s.still ?? true) ? (memo.stillAt ?? now) : null; // s.still: marked as walking, but no move is running (when not given: the drawn place is compared)
  if (s.moving && (s.still === undefined ? now - Math.max(m.posAt, m.movingAt) >= LIVE_STOMP_MS : s.still && now - m.stillAt >= LIVE_STOMP_MS)) kinds.push("stomp");
  if (!s.moving && !s.inLeg && !s.exempt && s.away) { m.awayAt ??= now; if (now - m.awayAt >= LIVE_STOP_MS) kinds.push("stopped"); } else m.awayAt = null;
  if ((s.inLeg && !s.moving) || (s.moving && !/^walk/.test(String(s.key ?? "")))) kinds.push("slide");
  const fresh = kinds.filter((k) => !m.open.includes(k)), gone = m.open.filter((k) => !kinds.includes(k)); m.open = kinds;
  return { kinds, fresh, gone, memo: m };
}

// Z1 (office-fix9a): a message sent through hc arrives as `<hc from="t165 name">body</hc>`; show the body only and the sender small.
export function unwrapHc(t) {
  const s = String(t ?? ""), froms = [];
  const note = (attrs) => { const f = /\bfrom="([^"]*)"/.exec(attrs); if (f && f[1] && !froms.includes(f[1])) froms.push(f[1]); };
  // 19th G4: a long message can arrive cut (no closing tag), so a lone opening tag and a lone closing tag are dropped too
  const text = s.replace(/<hc\b([^>]*)>([\s\S]*?)<\/hc>/g, (_m, attrs, body) => { note(attrs); return body.trim(); })
    .replace(/<hc\b([^>]*)>/g, (_m, attrs) => { note(attrs); return ""; }).replace(/<\/hc>/g, "").trim();
  return { text, from: froms.join(", ") };
}
// 19th G4: the same for a copy of the terminal screen (no transcript): the wrapper becomes a pale heading line "（親 t184 から）" above the body. Display only; nothing sent changes.
export function unwrapHcScreen(t) {
  const s = String(t ?? ""), head = (attrs) => { const f = /\bfrom="([^"]*)"/.exec(attrs); return f && f[1] ? `（親 ${f[1]} から）\n` : ""; };
  return s.replace(/<hc\b([^>]*)>([\s\S]*?)<\/hc>/g, (_m, attrs, body) => head(attrs) + body.trim())
    .replace(/<hc\b([^>]*)>/g, (_m, attrs) => head(attrs)).replace(/<\/hc>/g, "");
}
