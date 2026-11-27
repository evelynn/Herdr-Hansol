// hansol MOSSES layout (layout "mosses", 2026-11-26): the pure part, no gpui / herdr imports (tested by hansol/tests/mosses_model.test.mjs).
// The look follows a 1990s space-ship console: a star map where each star is a work space, each orbit a tab, each planet an agent;
// a dialog bar for system messages, an icon dock for the screens (mail = approvals, message = log, party = roster). Design: hansol/docs/mosses-theme.md.
// Everything is placed on a fixed 1280 x 800 stage that is scaled to the floor (stageFit).

export const STAGE = { w: 1280, h: 800 };
export const CENTRE = { x: 640, y: 330 }; // the hologram's / a star system's centre
export const STATE_COLOUR = { working: "#61afef", blocked: "#ffbf4d", done: "#8fe08a", idle: "#9aa3c4", shell: "#d58cff" };
export const STATES = ["working", "blocked", "done", "idle", "shell"];

// The system's lines (typed into the dialog bar). {s} a star (work space), {n} a count, {who} an agent.
export const MSG = {
  boot: "모세스의 세계에 오신 것을 환영합니다. 에이전트 성단을 스캔했습니다.",
  warpIn: "지금부터 워프를 시작합니다. 충격을 조심하세요.",
  warpDone: "{s} 항성계에 도착했습니다. 워프가 종료되었습니다.",
  warpOut: "성단 전체로 나갑니다.",
  back: "항성계로 돌아갑니다.",
  mail: "메인 데이터베이스에 접근합니다. 승인 요청 {n}건이 있습니다.",
  noMail: "도착한 승인 요청이 없습니다.",
  newMail: "새로운 승인 요청이 도착했습니다. 확인해 보세요.",
  done: "{who}의 작업 보고가 도착했습니다.",
  party: "개인 신상 정보 시스템을 가동시킵니다. 하나, 둘, 연결되었습니다.",
  log: "항해 메시지를 불러옵니다.",
  cancel: "취소되었습니다.",
  need: "먼저 행성(에이전트)을 선택해 주세요.",
  approving: "승인 신호를 보냅니다.",
  denying: "거절 신호를 보냅니다.",
  approved: "승인했습니다. 에이전트가 작업을 계속합니다.",
  denied: "거절했습니다. 에이전트에 알렸습니다.",
  failed: "신호가 닿지 않았습니다. 터미널에서 직접 확인해 주세요.",
  tuiAsk: "이 에이전트는 자기 터미널에서 직접 응답해야 합니다.",
  empty: "에이전트가 없습니다. 성단이 조용합니다.",
};
export const say = (key, vars = {}) => String(MSG[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

const fnv = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const PLANETS = 12; // mosses/planet-0..11.png
export const planetFor = (id) => fnv(`planet:${id}`) % PLANETS;
/** key -> planet for every work space: its own planet's look (hash, then the next free one) while there are no more than PLANETS; the same set gives the same looks in any order. */
export function planetsFor(keys) {
  const out = new Map(), used = new Set();
  for (const k of [...new Set(keys ?? [])].sort()) { let p = planetFor(k); for (let i = 0; i < PLANETS && used.has(p); i++) p = (p + 1) % PLANETS; used.add(p); if (used.size >= PLANETS) used.clear(); out.set(k, p); }
  return out;
}

// The state an agent shows: "shell" (a shell waiting) from the caller's stateKey, else working / blocked / done / idle (anything else: idle).
export const mossState = (status, stateKey) => (stateKey === "shell" ? "shell" : STATES.includes(status) && status !== "shell" ? status : "idle");

/**
 * The work spaces as stars: [{ key, title, tabs: [{ name, ids }] }] ordered by title then key; inside, tabs in the order first met,
 * agents by id. a.island (else `src:` + source) is the star, a.island_title (else space, island, source) its name, a.tab ("" none) the orbit.
 */
export function starGroups(list) {
  const stars = new Map(), byId = (p, q) => (String(p.id) < String(q.id) ? -1 : String(p.id) > String(q.id) ? 1 : 0);
  for (const a of [...(list ?? [])].sort(byId)) {
    const key = a.island ?? `src:${a.source ?? "?"}`;
    let st = stars.get(key);
    if (!st) { st = { key, title: String(a.island_title ?? a.space ?? a.island ?? a.source ?? "?"), tabs: new Map() }; stars.set(key, st); }
    const tn = String(a.tab ?? "");
    if (!st.tabs.has(tn)) st.tabs.set(tn, []);
    st.tabs.get(tn).push(a.id);
  }
  return [...stars.values()].sort((p, q) => p.title.localeCompare(q.title) || (p.key < q.key ? -1 : 1))
    .map((s) => ({ key: s.key, title: s.title, tabs: [...s.tabs].map(([name, ids]) => ({ name, ids })) }));
}

/** The stage (1280 x 800) fitted into the area x0..x0+W, 0..H: scale s (<= 1.6), and the stage's top-left (ox, oy), centred. */
export function stageFit(W, H, x0 = 0) {
  const s = Math.max(0.3, Math.min(1.6, W / STAGE.w, H / STAGE.h));
  return { s, ox: Math.round(x0 + (W - STAGE.w * s) / 2), oy: Math.round((H - STAGE.h * s) / 2) };
}

// Star places on the stage, chosen round the hologram so labels (to the right, above) stay clear of the comm window (560..1040 x 150..272),
// the status panel (14..354 x 328..542), the dock (14..290 x 652..) and the dialog (724.. x 646..).
export const SLOTS = [[430, 170], [1090, 190], [1090, 400], [480, 545], [900, 560], [250, 270], [700, 100], [810, 460], [380, 440], [600, 470],
  [1180, 300], [140, 160], [960, 330], [300, 600], [1000, 110], [520, 360]];
/** n star places: the slots first, then (more than 16) a ring of small extra places round the centre. */
export function starPlaces(n) {
  const out = SLOTS.slice(0, Math.min(n, SLOTS.length)).map(([x, y]) => ({ x, y }));
  for (let i = out.length; i < n; i++) { const k = i - SLOTS.length, a = (k * 137.5 * Math.PI) / 180, r = 150 + (k % 4) * 40; out.push({ x: Math.round(CENTRE.x + r * 1.6 * Math.cos(a)), y: Math.round(CENTRE.y + r * 0.7 * Math.sin(a)) }); }
  return out;
}

/** The orbit (ellipse radii) of tab ti of n tabs: from 230 x 70 out, spread so the outermost stays within 560 x 250. */
export function orbitR(ti, n) {
  const step = n <= 1 ? 0 : Math.min(150, 330 / (n - 1));
  return [230 + ti * step, 70 + ti * step * 0.3];
}

/** Where planet k of m on orbit ti of n sits at time t (seconds): { x, y, front } (front: the lower half, drawn over the sun). */
export function planetPlace(ti, n, k, m, t) {
  const [rx, ry] = orbitR(ti, n), ang = (k / Math.max(1, m)) * Math.PI * 2 + t * (ti % 2 ? -0.05 : 0.07) + ti * 0.7 + 0.6;
  const y = CENTRE.y + ry * Math.sin(ang);
  return { x: Math.round((CENTRE.x + rx * Math.cos(ang)) * 10) / 10, y: Math.round(y * 10) / 10, front: y >= CENTRE.y };
}

/** The text shown `ms` after typing began: two characters every 26 ms (characters, not UTF-16 units). */
export const TYPE_MS = 13;
export function typed(text, ms) {
  const ch = [...String(text ?? "")], n = Math.max(0, Math.floor(Math.max(0, ms) / TYPE_MS));
  return { text: ch.slice(0, n).join(""), done: n >= ch.length };
}

// ---- animation curves (p = elapsed / duration, any number; all return values in 0..1)
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const easeOut = (p) => { const q = clamp01(p); return 1 - (1 - q) ** 3; };
/** A panel materializing: a bright line opens across (width), then down (height), then flickers. { w, h, o } */
export function matCurve(p) {
  const w = easeOut(p / 0.35), h = p < 0.3 ? 0 : easeOut((p - 0.3) / 0.4);
  const o = p <= 0 ? 0 : p < 0.72 ? 1 : p < 0.78 ? 0.45 : p < 0.84 ? 1 : p < 0.9 ? 0.7 : 1;
  return { w, h, o };
}
/** A popup opening: a line grows across (0..0.45), then the box opens down (0.45..1). { w, h } */
export function popCurve(p) { return { w: easeOut(p / 0.45), h: p < 0.45 ? 0 : easeOut((p - 0.45) / 0.55) }; }
/** Warp: the old view goes (0..0.5), the flash (0.5..0.75), the new view comes (0.55..1). */
export function warpCurve(p) {
  return { out: clamp01(1 - p / 0.45), streak: p < 0.85 ? clamp01(p / 0.3) * (1 - clamp01((p - 0.55) / 0.3)) : 0, scale: 0.4 + 2 * clamp01(p / 0.7) ** 2,
    flash: p < 0.45 ? 0 : p < 0.55 ? (p - 0.45) / 0.1 : clamp01(1 - (p - 0.55) / 0.25), into: clamp01((p - 0.55) / 0.45 + 1e-9) };
}

/** The orbits' long radii of one system at tilt T: A1 = the room sideways, A2 = half the room up and down (the height of an orbit is a * T),
 *  R = the planet's radius (fixed: turning the view never resizes a planet). nr orbits, innermost first. */
export function ringsAr(A1, A2, R, nr, T) {
  const aMax = Math.max(60, Math.min(A1, A2 / Math.max(0.05, T))), aMin = Math.min(aMax, R * 1.75);
  return Array.from({ length: Math.max(0, nr) }, (_, k) => (nr <= 1 ? aMin + (aMax - aMin) * 0.85 : aMin + ((aMax - aMin) * k) / (nr - 1)));
}
/** The warp's dark veil: up to fully covered at the switch (the views change unseen), then away. */
export function warpVeil(p) { const sm = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }; return p < 0.5 ? sm(0.12, 0.46, p) : 1 - sm(0.56, 1, p); }

/** The systems in the person's order (shared "hansol.mzOrder": keys); keys not in it keep their place after the ordered ones. */
export function orderSystems(systems, order) {
  const at = new Map((order ?? []).map((k, i) => [k, i]));
  return [...(systems ?? [])].map((s, i) => ({ s, i })).sort((p, q) => (at.get(p.s.key) ?? 1e6 + p.i) - (at.get(q.s.key) ?? 1e6 + q.i)).map((x) => x.s);
}
/** keys with the one at `from` moved to `to` (both clamped). */
export function moveOrder(keys, from, to) {
  const out = [...(keys ?? [])]; if (!out.length) return out;
  const f = Math.max(0, Math.min(out.length - 1, from)), t = Math.max(0, Math.min(out.length - 1, to));
  out.splice(t, 0, ...out.splice(f, 1)); return out;
}
/** The warp's star streaks at p (0..1) round (ox, oy), reach R: [[x0, y0], [x1, y1]] each. inward: they fall back to the centre (leaving a system). */
export function warpLines(p, n, ox, oy, R, inward = false) {
  const q = clamp01(inward ? 1 - p : p), out = [];
  for (let i = 0; i < n; i++) {
    const f = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1), a = i * 2.39996 + f * 0.3; // golden angle: evenly spread
    const head = 12 + f * R * 0.5 + R * 1.6 * q * q * (0.6 + 0.4 * f), tail = Math.max(6 + f * 20, head - (4 + R * 0.55 * q * q));
    if (tail > R * 1.5) continue;
    const c = Math.cos(a), sn = Math.sin(a);
    out.push([[ox + c * tail, oy + sn * tail], [ox + c * head, oy + sn * head]]);
  }
  return out;
}

/** The approvals waiting (blocked), oldest first. */
export const mailList = (list) => (list ?? []).filter((a) => a.status === "blocked").sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || (String(a.id) < String(b.id) ? -1 : 1));

/** Counts per state; stateKey(a) gives "shell" for a shell. */
export function stateCounts(list, stateKey = () => "") {
  const c = Object.fromEntries(STATES.map((k) => [k, 0]));
  for (const a of list ?? []) c[mossState(a.status, stateKey(a))]++;
  return c;
}

/**
 * What changed since the last look: prev = Map id -> status (null the first time: nothing is news then).
 * Returns { next: the new map, news: [{ kind: "ask" | "done", id }] } — "ask": became blocked, "done": became done.
 */
export function newsSince(prev, list) {
  const next = new Map((list ?? []).map((a) => [a.id, a.status])), news = [];
  if (prev) for (const a of list ?? []) {
    const was = prev.get(a.id);
    if (a.status === "blocked" && was !== "blocked") news.push({ kind: "ask", id: a.id });
    else if (a.status === "done" && was !== undefined && was !== "done") news.push({ kind: "done", id: a.id });
  }
  return { next, news };
}

/** A line cut to n characters with "…" (characters, not UTF-16 units). */
export const cut = (s, n) => { const c = [...String(s ?? "")]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
/** "HH:MM" of a Date. */
export const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// The boot lines (blink in one by one), original text.
export const BOOT_LINES = (stars, units) => ["MOSSES OPERATING SYSTEM  V1.5", "HERDR CORE LINK ............ OK", `SCAN AGENT CLUSTER ......... ${stars} STARS / ${units} UNITS`, "MAIL SERVER ................ ONLINE", "WELCOME ABOARD."];
export const BOOT_MS = 3000;

// ---- 2026-11-27 the cluster in 3D (OVERVIEW): each work space a star at P = [X, Y, Z] (Y up, Z toward the viewer at yaw 0), not a grid.
// A drag on the empty floor turns the whole cluster: yaw round Y; T = the tilt (the sine of the view's elevation, as the orbits use it).
const hash01 = (s) => ([...String(s)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000) / 1000;
/** Star i of n's home: spread by the golden angle over the screen at the usual view (free, no rows), its depth taken from its key. */
export function clusterHome(i, n, key, T = 0.42) {
  if (n <= 1) return [0, 0, 0];
  const r = Math.sqrt((i + 0.5) / n), a = i * 2.39996 + 0.9, x = r * Math.cos(a), v = r * Math.sin(a) * 0.9;
  const z = (hash01(key) * 2 - 1) * 0.7 * Math.sqrt(Math.max(0, 1 - x * x)), c = Math.sqrt(1 - T * T);
  return [x, (z * T - v) / c, z];
}
/** P seen at yaw / T: h across, v down (screen), d toward the viewer; z: P's depth on the turned floor (kept when a star is moved). */
export function clusterView(P, yaw, T) {
  const [X, Y, Z] = P, c = Math.sqrt(1 - T * T), cs = Math.cos(yaw), sn = Math.sin(yaw), h = X * cs + Z * sn, z = -X * sn + Z * cs;
  return { h, v: -Y * c + z * T, d: z * c + Y * T, z };
}
/** The star seen at (h, v) with floor depth z: clusterView's inverse. */
export function clusterPoint(h, v, z, yaw, T) {
  const c = Math.sqrt(1 - T * T), cs = Math.cos(yaw), sn = Math.sin(yaw);
  return [h * cs - z * sn, (z * T - v) / c, h * sn + z * cs];
}
const fitOf = (Ps, T, sizes) => { // the spread's bounds do not change with yaw, so turning never zooms
  const c = Math.sqrt(1 - T * T), r = Ps.map(([X, , Z]) => Math.hypot(X, Z));
  return { rw: Math.max(1, ...sizes.map((z) => z[0])), rh: Math.max(1, ...sizes.map((z) => z[1])),
    Bh: Math.max(1e-3, ...r), Bv: Math.max(1e-3, ...Ps.map((p, i) => Math.abs(p[1]) * c + r[i] * T)), Bd: Math.max(1e-3, ...Ps.map((p, i) => r[i] * c + Math.abs(p[1]) * T)) };
};
/** The rooms of stars Ps at yaw / T in a W x H scene. sizes[i] = [w, h]: what system i draws (its name, planet, orbits, name plates), at full size.
 *  -> [{ x, y, w, h, f, d }]: top left and size, f = the scale (1; less only when the rooms cannot all be kept apart), d = depth (-1 far .. 1 near).
 *  The content keeps its size: the stars' spread fits round it. Rooms that meet are pushed apart, then kept on the screen. */
const CORE = 0.94; // only the rooms' empty rims (the orbits' far ends) may touch
export function clusterRooms(Ps, yaw, T, W, H, sizes, GAP = 12) {
  if (!Ps.length) return [];
  const { rw, rh, Bh, Bv, Bd } = fitOf(Ps, T, sizes), base = Ps.map((P) => clusterView(P, yaw, T));
  const keep = (o) => { o.cx = o.w >= W ? W / 2 : Math.max(o.w / 2, Math.min(W - o.w / 2, o.cx)); o.cy = o.h >= H ? H / 2 : Math.max(o.h / 2, Math.min(H - o.h / 2, o.cy)); };
  let out = [];
  for (let shrink = 1; shrink > 0.5; shrink *= 0.94) { // rooms that cannot all be pushed apart are made a little smaller, and pushed again
    out = base.map((q, i) => ({ cx: W / 2 + (q.h / Bh) * (Math.max(0, W - rw) / 2), cy: H / 2 + (q.v / Bv) * (Math.max(0, H - rh) / 2), w: sizes[i][0] * shrink, h: sizes[i][1] * shrink, f: shrink, d: q.d / Bd }));
    out.forEach(keep);
    let moved = true;
    for (let it = 0; it < 60 && moved; it++) {
      moved = false;
      for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j], ox = ((a.w + b.w) / 2) * CORE + GAP - Math.abs(a.cx - b.cx), oy = ((a.h + b.h) / 2) * CORE + GAP - Math.abs(a.cy - b.cy);
        if (ox <= 0.5 || oy <= 0.5) continue;
        moved = true;
        const fx = (a.w + b.w) * CORE + GAP <= W, fy = (a.h + b.h) * CORE + GAP <= H; // the shorter way apart, but not along an axis with no room for both
        if (fx && (ox < oy || !fy)) { const s = a.cx <= b.cx ? -1 : 1; a.cx += (s * ox) / 2; b.cx -= (s * ox) / 2; }
        else { const s = a.cy <= b.cy ? -1 : 1; a.cy += (s * oy) / 2; b.cy -= (s * oy) / 2; }
      }
      out.forEach(keep);
    }
    if (!moved) break;
  }
  return out.map((o) => ({ x: o.cx - o.w / 2, y: o.cy - o.h / 2, w: o.w, h: o.h, f: o.f, d: o.d }));
}
/** Star i moved so its room's centre is at (rcx, rcy) on the screen (its depth kept), held inside the spread's present bounds. */
export function clusterDrop(Ps, i, rcx, rcy, yaw, T, W, H, sizes) {
  const { rw, rh, Bh, Bv } = fitOf(Ps, T, sizes), c = Math.sqrt(1 - T * T), z = clusterView(Ps[i], yaw, T).z;
  const h = ((rcx - W / 2) / Math.max(1, (W - rw) / 2)) * Bh, v = ((rcy - H / 2) / Math.max(1, (H - rh) / 2)) * Bv;
  let [X, Y, Z] = clusterPoint(Math.max(-Bh, Math.min(Bh, h)), v, z, yaw, T);
  const r = Math.hypot(X, Z); if (r > Bh) { X *= Bh / r; Z *= Bh / r; }
  const lim = Math.max(0, (Bv - Math.min(Bh, r) * T) / c); Y = Math.max(-lim, Math.min(lim, Y));
  return [X, Y, Z];
}

// ---- 2026-11-27 an agent's work history (shared "hansol.mzHist": [{ at, text, done }], oldest first) without repeats.
// Two texts are the same work when equal or one is the other cut short (the collector cuts long texts and adds "…").
const workKey = (t) => String(t ?? "").replace(/…$/, "").replace(/\s+/g, " ").trim();
export const sameWork = (a, b) => { const x = workKey(a), y = workKey(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))); };
/** h with text as its newest entry: an earlier entry of the same work moves to the end (the longer text kept), so the list holds max different works. */
export function pushWork(h, text, at, max = 8) {
  const i = h.findIndex((e) => sameWork(e.text, text)), prev = i >= 0 ? h.splice(i, 1)[0] : null;
  h.push({ at, text: prev && workKey(prev.text).length > workKey(text).length ? prev.text : text });
  while (h.length > max) h.shift();
  return h;
}
/** The n latest different works before the current one (newest first). */
export function pastWork(h, task, n) {
  const out = [];
  for (let i = (h ?? []).length - 1; i >= 0 && out.length < n; i--) { const e = h[i]; if (!sameWork(e.text, task) && !out.some((o) => sameWork(o.text, e.text))) out.push(e); }
  return out;
}
