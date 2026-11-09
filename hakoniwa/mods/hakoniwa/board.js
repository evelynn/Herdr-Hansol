// hakoniwa wall board: a station-style LED sign drawn with 5x7 dot letters (no pictures: lit dots are small divs).
// The scene gives the face: board = { origin: [x, y] (centre of dot col 0 / row 0), dx: [x, y] (one column on), dy: [x, y] (one row down), cols, rows }.
// Pages change every 10 s; the content is redrawn at least once a minute (the colon blinks natively).
import { div } from "gpui-kit";

const G = {
  "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110", "2": "01110 10001 00001 00010 00100 01000 11111",
  "3": "11110 00001 00001 01110 00001 00001 11110", "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
  "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000", "8": "01110 10001 10001 01110 10001 10001 01110",
  "9": "01110 10001 10001 01111 00001 00010 01100",
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110", C: "01110 10001 10000 10000 10000 10001 01110",
  D: "11100 10010 10001 10001 10001 10010 11100", E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001", I: "01110 00100 00100 00100 00100 00100 01110",
  J: "00111 00010 00010 00010 00010 10010 01100", K: "10001 10010 10100 11000 10100 10010 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 11001 10101 10011 10001 10001 10001", O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000", Q: "01110 10001 10001 10001 10101 10010 01101", R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100", U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100", W: "10001 10001 10001 10101 10101 11011 10001", X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100", Z: "11111 00001 00010 00100 01000 10000 11111",
  "/": "00001 00001 00010 00100 01000 10000 10000", ":": "00000 00100 00100 00000 00100 00100 00000", "-": "00000 00000 00000 11111 00000 00000 00000",
  "°": "01100 10010 10010 01100 00000 00000 00000", ".": "00000 00000 00000 00000 00000 00110 00110", " ": "00000 00000 00000 00000 00000 00000 00000",
};
const GLYPH = Object.fromEntries(Object.entries(G).map(([ch, s]) => [ch, s.split(" ")]));

// 7x7 weather icons ("#" lit)
const ICON = {
  clear: ["#..#..#", ".#####.", "..###..", "#.###.#", "..###..", ".#####.", "#..#..#"],
  night: ["..###..", ".##....", "##.....", "##.....", "##.....", ".##..#.", "..###.."],
  partly: ["..#....", ".###.#.", "..#####", ".#######", "#######", "#######", ".#####."],
  cloudy: ["..###..", ".#####.", "#######", "#######", "#######", ".#####.", "......."],
  rain: ["..###..", ".#####.", "#######", ".#####.", "..#.#..", ".#.#.#.", "#.#.#.."],
  snow: ["..###..", ".#####.", "#######", ".#####.", "#..#..#", "..#.#..", "#..#..#"],
  thunder: ["..###..", ".#####.", "#######", "...##..", "..##...", "...##..", "..#...."],
  fog: [".......", "#######", ".......", "#######", ".......", "#######", "......."],
};
// ★94 the sign is always the same big form with the same words: the grid is ALWAYS BOARD_COLS x BOARD_ROWS dots (the size the full words need: date, week day, time, weather, place,
// WORK / DONE / OK / WAIT unshortened, two-digit counts). A shorter wall (or a smaller face) only makes the DOTS smaller (and the grid sits in the middle of the face); before, the grid followed the wall's
// length, and under 70 columns the sign fell back to a small form with "WK / DN" words (r63, r73). The face's centre stays; the dot's shape (dx : dy) stays.
export const BOARD_COLS = 200, BOARD_ROWS = 44; // (44 rows: the big date/time (14 rows) and the small words (7) keep 7 empty rows between them and around; 200 at the smallest scale need 180 columns with two-digit counts (measured with signPlan); 20 more leave a gap of about 6 dots between the words of the bottom row)
export function fixedBoard(b) {
  if (!b || !(b.cols > 0) || !(b.rows > 0) || !Array.isArray(b.dx) || !Array.isArray(b.dy) || !Array.isArray(b.origin)) return b;
  const f = Math.min(b.cols / BOARD_COLS, b.rows / BOARD_ROWS), r3 = (v) => Math.round(v * 1000) / 1000;
  const dx = [b.dx[0] * f, b.dx[1] * f], dy = [b.dy[0] * f, b.dy[1] * f];
  const cc = (b.cols - 1) / 2, cr = (b.rows - 1) / 2, mc = (BOARD_COLS - 1) / 2, mr = (BOARD_ROWS - 1) / 2; // the middle dot of the old grid and of the new one are the same point
  const mid = [b.origin[0] + b.dx[0] * cc + b.dy[0] * cr, b.origin[1] + b.dx[1] * cc + b.dy[1] * cr];
  return { ...b, cols: BOARD_COLS, rows: BOARD_ROWS, dx: dx.map(r3), dy: dy.map(r3), origin: [r3(mid[0] - dx[0] * mc - dy[0] * mr), r3(mid[1] - dx[1] * mc - dy[1] * mr)] };
}
export const WEATHER_KINDS = ["clear", "partly", "cloudy", "fog", "rain", "snow", "thunder"];

const AMBER = "#ffb020", GREEN = "#3ddc84", RED = "#ff4d4d", DIM = "#2a2218";
const DATE_COL = "#f1e4c4"; // ★97: the date in a pale cream, the time in amber: the two read as two things even when the big form leaves them one dot apart (spacing alone could not: a wider gap loses the big form on 4 of 28 faces)
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// Lit dots of one text line starting at (c0, r0); returns [{c, r, color, blink}] and the width used.
let GID = 0; // ★88-6 each glyph (and icon) gets its own mark `g`: the picture of the board is cut per glyph, so a glyph that moves is still the same file
function text(str, c0, r0, color, blinkColon = false) {
  const out = []; let c = c0;
  for (const ch of String(str).toUpperCase()) {
    const g = GLYPH[ch] ?? GLYPH[" "], gid = ++GID;
    g.forEach((row, r) => { for (let i = 0; i < 5; i++) if (row[i] === "1") out.push({ c: c + i, r: r0 + r, color, blink: blinkColon && ch === ":", g: gid }); });
    c += 6;
  }
  return { dots: out, width: c - c0 };
}

function icon(kind, c0, r0, color) {
  const out = [], gid = ++GID;
  (ICON[kind] ?? ICON.clear).forEach((row, r) => [...row].forEach((v, i) => { if (v === "#") out.push({ c: c0 + i, r: r0 + r, color, g: gid }); }));
  return out;
}

const rowW = (list, sc) => list.reduce((n, [k0, v]) => n + (`${k0} ${v}`.length + 1) * 6 * sc, 0);
// One row of items spread over the full width with equal gaps: the same placement bigSign draws (colour and blink ride along).
function spreadSign(board, list, scOf, r0, rowH) {
  const out = [], spare = board.cols - 2 - list.reduce((n, it) => n + it.w * scOf(it), 0); let x = 1;
  list.forEach((it, i) => {
    const sc = scOf(it), x0 = x + (list.length > 1 ? Math.round((spare * i) / (list.length - 1)) : 0), y0 = r0 + Math.floor((rowH - 7 * sc) / 2);
    for (const d of it.dots) for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) out.push({ ...d, c: x0 + d.c * sc + a, r: y0 + d.r * sc + b });
    x += it.w * sc;
  });
  return out;
}
// ★51-1: how many dots of a row fall on something drawn in front of the board (scene rectangles: [x, y, w, h]).
function dotsHit(board, dots, avoid) {
  let n = 0;
  for (const d of dots) {
    const x = board.origin[0] + d.c * board.dx[0] + d.r * board.dy[0], y = board.origin[1] + d.c * board.dx[1] + d.r * board.dy[1];
    for (const q of avoid) if (x >= q[0] - 2 && x <= q[0] + q[2] + 2 && y >= q[1] - 2 && y <= q[1] + q[3] + 2) { n++; break; }
  }
  return n;
}
// ★51-1: the numbers stay where the sign put them when nothing covers them; when the front room's heads or partitions do, the row rises to the
// lowest place inside the face that is clear, and the date/time row takes the room above it (or under it when there is none).
// ★62-1: the rows keep a gap of `gap` dots (the top row used to end right on the risen numbers), the top row sits in the middle of the room it gets,
// and when that room makes the date/time smaller the words are chosen again for the new size (the words shortened for the larger size,
// "TH", "WK2", "17°", stayed on a board that had room for "THU", "WORK 2", "17°C").
function settleBottom(board, plan, data) {
  const avoid = data?.avoid;
  if (!avoid?.length) return plan;
  const rows = board.rows, cols = board.cols, botH = 7 * plan.bsc, maxR = Math.max(0, rows - botH), cur = Math.min(Math.max(0, plan.botR), maxR);
  const hitsOf = (list, r) => dotsHit(board, spreadSign(board, list, plan.botScale, r, botH), avoid), hits = (r) => hitsOf(plan.bot, r);
  let best = cur, bestN = hits(cur);
  for (let r = cur - 1; r >= 0; r--) { const n = hits(r); if (n < bestN) { best = r; bestN = n; } if (n === 0) break; }
  if (best === cur) return plan;
  const gap = 2, above = best - gap, below = rows - (best + botH) - gap;
  let S, topR;
  if (above >= 7) { S = Math.min(plan.S, Math.floor(above / 7)); topR = Math.floor((above - 7 * S) / 2); }
  else if (below >= 7) { S = Math.min(plan.S, Math.floor(below / 7)); topR = best + botH + gap + Math.floor((below - 7 * S) / 2); }
  else return plan;
  const s2 = Math.min(plan.s, S), topScale = (it) => (it.key === "date" || it.key === "time" ? S : s2);
  let top = plan.top, bot = plan.bot;
  if (S < plan.S && data?.now) { // the longest words that fit at the new size (the same order of choices as signPlan)
    const fits = (list, scOf) => list.reduce((n, it) => n + it.w * scOf(it), 0) + (list.length - 1) * minGapFor(Math.min(...list.map(scOf))) <= cols - 2;
    const vs = signVariants(data, SIGN_STEPS);
    const v = vs.find((x) => x.top.some((i) => i.key === "date") && x.top.some((i) => i.key === "time") && fits(x.top, topScale) && fits(x.bot, plan.botScale) && hitsOf(x.bot, best) <= bestN);
    if (v) { top = v.top; bot = v.bot; }
  }
  return { ...plan, top, bot, topR, botR: best, S, s: s2, rowH: 7 * S, topScale };
}
const numbers4 = (data) => { const wt = data.wait ?? 0; return [["WORK", data.work ?? 0, AMBER], ["DONE", data.done ?? 0, GREEN], ["OK", data.ok ?? 0, GREEN], ["WAIT", wt, wt > 0 ? RED : "#8a7a5a"]]; };
// The numbers are always all four, in this order: WORK, DONE, OK, WAIT (only the numbers change; no paging). One row when they fit at the largest scale, else two rows of two at normal size.
export function numbersLayout(cols, rows, nums4) {
  let bsc = cols >= 120 && rows >= 30 ? 2 : 1; while (bsc > 1 && rowW(nums4, bsc) > cols) bsc--;
  const oneRow = rowW(nums4, bsc) <= cols;
  return { bsc, oneRow, bottomR: rows - (oneRow ? 7 * bsc : 15) };
}
export const textDotCount = (str) => text(str, 0, 0, "#000").dots.length; // (for the tests)

// ★24: the big sign in two rows, each row spread over the full width with equal gaps (measured, not packed to the left).
// Top (large): date, week day, time, weather icon + temperature, place. Bottom (medium): WORK, DONE, OK, WAIT.
// When a row does not fit at some scale the scale goes one step down (no item is dropped); returns null when even scale 1 does not fit.
function item(dots) { // local dots -> { dots shifted to c=0, w (columns), r range 0..6 }
  if (!dots.length) return null;
  const c0 = Math.min(...dots.map((d) => d.c)), c1 = Math.max(...dots.map((d) => d.c));
  return { dots: dots.map((d) => ({ ...d, c: d.c - c0 })), w: c1 - c0 + 1 };
}
const minGapFor = (sc) => Math.max(2, 2 * sc);
export function signLayout(cols, rows, topItems, botItems) {
  const sum = (list, sc) => list.reduce((n, it) => n + it.w * sc, 0), fits = (list, sc) => sum(list, sc) + (list.length - 1) * minGapFor(sc) <= cols - 2;
  for (let tsc = Math.min(6, Math.floor((rows - 6) / 7)); tsc >= 1; tsc--) {
    if (!fits(topItems, tsc)) continue;
    for (let bsc = Math.max(1, Math.min(tsc, Math.ceil(tsc * 2 / 3))); bsc >= 1; bsc--) {
      if (!fits(botItems, bsc) || rows - 7 * tsc - 7 * bsc < 6) continue;
      const m = Math.floor((rows - 7 * tsc - 7 * bsc) / 3); // the top margin, the gap between the rows and the bottom margin: equal
      return { tsc, bsc, topR: m, botR: m + 7 * tsc + m };
    }
  }
  return null;
}
// ★24: when the face is narrow the text goes down a scale first (signLayout); when scale 1 does not fit either, the words are shortened step by step:
// place name (OSAKA -> OSA), the bottom words (WORK 4 -> WK 4 -> WK4), the unit (18°C -> 18°), and only on a very narrow face the place name goes.
const SHORT_KEY = { WORK: "WK", DONE: "DN", OK: "OK", WAIT: "WT" };
export const SIGN_STEPS = [ // [label chars, week day chars, bottom words (0 full, 1 two letters, 2 two letters without the space), unit, keep date+time+weather only]
  // ★62-1 the week day stays 3 letters ("TH" is not read as Thursday): it is dropped whole on a narrow face, never cut to 2
  [8, 3, 0, true, 0], [3, 3, 0, true, 0], [3, 3, 1, true, 0], [3, 3, 2, true, 0], [3, 3, 2, false, 0], [0, 3, 2, false, 0], [0, 0, 2, false, 0], [0, 0, 2, false, 1], [0, 0, 3, false, 1],
];
function signItems(data, step) {
  const now = data.now, pad2 = (n) => String(n).padStart(2, "0"), w = data.weather ?? { kind: "clear" }, [lab, dw, bw, unit, only] = step;
  const ic = w.kind === "clear" && w.is_day === 0 ? "night" : w.kind, tempStr = w.temp != null ? `${Math.round(w.temp)}°${unit ? "C" : ""}` : "", label = lab && w.label ? String(w.label).slice(0, lab) : "";
  const weather = icon(ic, 0, 0, GREEN).concat(tempStr ? text(tempStr, 10, 0, GREEN).dots : []);
  const topItems = [["date", text(`${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`, 0, 0, DATE_COL).dots], ["dow", dw ? text(DOW[now.getDay()].slice(0, dw), 0, 0, AMBER).dots : []], ["time", text(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`, 0, 0, AMBER, true).dots], ["wx", weather], ["label", label ? text(label, 0, 0, GREEN).dots : []]].map(([key, d]) => { const it = item(d); if (it) it.key = key; return it; }).filter(Boolean);
  const wt = data.wait ?? 0, botItems = numbers4(data).map(([k0, v, col]) => item(text(bw === 3 ? `${v}` : bw ? `${SHORT_KEY[k0]}${bw === 2 ? "" : " "}${v}` : `${k0} ${v}`, 0, 0, col).dots.map((d) => (k0 === "WAIT" && wt > 0 ? { ...d, blink: true } : d))));
  return { topItems: only ? topItems.slice(0, 2) : topItems, botItems, labelItem: topItems.find((it) => it.key === "label") ?? null }; // (only: date and time; on a face narrower than about 70 columns)
}
// The choices of words in the order they are tried: each step as it is, then the place name moved to the bottom row, then (★62-1) the week day too
// (a whole "THU" under the numbers reads better than "TH" beside the date).
function signVariants(data, steps) {
  const one = [], lab = [], dow = [];
  for (const step of steps) {
    const it = signItems(data, step), d = it.topItems.find((x) => x.key === "dow");
    one.push({ top: it.topItems, bot: it.botItems });
    if (it.labelItem) lab.push({ top: it.topItems.filter((x) => x.key !== "label"), bot: it.botItems.concat([it.labelItem]) });
    if (d) dow.push({ top: it.topItems.filter((x) => x.key !== "label" && x.key !== "dow"), bot: [d, ...it.botItems, ...(it.labelItem ? [it.labelItem] : [])] });
  }
  return [...one, ...lab, ...dow];
}
// ★27-2: the date and the time are drawn at 1.5x-2x (at least) what the rows used before: they take the scale S, the small items (week day, weather, place)
// keep the old scale s and sit in the middle of the tall row. When that does not fit, the place name is shortened, and then moved to the bottom row.
// `base` (the ★24 layout) is the fallback; the bottom row keeps its old scale.
export function signPlan(board, data) {
  const { cols, rows } = board;
  let base = null;
  for (const step of SIGN_STEPS) { const it = signItems(data, step), lay = signLayout(cols, rows, it.topItems, it.botItems); if (lay) { base = { ...it, lay }; break; } }
  if (!base) return null;
  const s = base.lay.tsc, bsc = base.lay.bsc, want = Math.max(2, Math.ceil(s * 1.5));
  const fits2 = (list, scOf) => list.reduce((n, it) => n + it.w * scOf(it), 0) + (list.length - 1) * minGapFor(Math.min(...list.map(scOf))) <= cols - 2;
  const variants = [];
  variants.push(...signVariants(data, SIGN_STEPS.slice(0, 5)));
  const wordSets = [signVariants(data, SIGN_STEPS.slice(0, 1)), variants, signVariants(data, SIGN_STEPS)]; // ★94 step 1: the unshortened words first (the place name moved to the bottom row is not a shortening: "OSAKA" before "OSA") // ★78 only when the full words do not fit at any size: a narrow face drops the place, the week day, the unit before the big form is given up
  // ★78 the big form (date and time larger than the small items, ★27-2) at every face size: when the full size does not fit, the same form is drawn smaller
  // (the small items, then the bottom row, then the date/time step down) instead of falling back to the ★24 layout.
  for (const vset of wordSets) for (let b2 = bsc; b2 >= 1; b2--) for (let s2 = s; s2 >= 1; s2--) {
    const w2 = b2 === bsc && s2 === s ? want : Math.max(2, s2 + 1);
    for (let S = Math.min(6, Math.floor((rows - 6 - 7 * b2) / 7)); S >= w2; S--) for (const v of vset) {
      const scOf = (it) => (it.key === "date" || it.key === "time" ? S : s2), botOf = () => b2;
      if (!v.top.some((x) => x.key === "date") || !v.top.some((x) => x.key === "time")) continue;
      if (!fits2(v.top, scOf) || !fits2(v.bot, botOf) || rows - 7 * S - 7 * b2 < 6) continue;
      const m = Math.floor((rows - 7 * S - 7 * b2) / 3);
      return settleBottom(board, { top: v.top, bot: v.bot, topScale: scOf, botScale: botOf, topR: m, botR: m + 7 * S + m, rowH: 7 * S, S, s: s2, bsc: b2, base: base.lay, boosted: true }, data);
    }
  }
  return settleBottom(board, { top: base.topItems, bot: base.botItems, topScale: () => base.lay.tsc, botScale: () => base.lay.bsc, topR: base.lay.topR, botR: base.lay.botR, rowH: 7 * base.lay.tsc, S: base.lay.tsc, s: base.lay.tsc, bsc, base: base.lay, boosted: false }, data);
}
function bigSign(board, data) {
  const { cols, rows } = board, plan = signPlan(board, data);
  if (!plan) return null;
  const res = [], put = (list, scOf, r0, rowH) => { for (const d of spreadSign(board, list, scOf, r0, rowH)) res.push(d); }; // a smaller item: in the middle of the row
  put(plan.top, plan.topScale, plan.topR, plan.rowH); put(plan.bot, plan.botScale, plan.botR, 7 * plan.bsc);
  return res.filter((d) => d.c >= 0 && d.c < cols && d.r >= 0 && d.r < rows);
}

// data: { now: Date, weather: {kind, temp, label, is_day}, done, work, wait, top }
export function boardDots(board, data) {
  const { cols, rows } = board, lines = Math.max(1, Math.floor((rows + 1) / 8)), now = data.now;
  if (rows >= 22 && cols >= 70) {
    const two = bigSign(board, data); if (two) return two; // a big sign: everything on one screen. Left: the time at double size (and the date); right: the weather icon, the temperature, the place; bottom row: the numbers
    const w = data.weather ?? { kind: "clear" }, pad2 = (n) => String(n).padStart(2, "0"), res = [];
    const big = (str, c0, r0, color, blink, sc = 2) => { const t = text(str, 0, 0, color, blink); for (const d of t.dots) for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) res.push({ ...d, c: c0 + d.c * sc + a, r: r0 + d.r * sc + b }); return t.width * sc; };
    // The numbers are always all four, in this order: WORK, DONE, OK, WAIT (only the numbers change; no paging). One row when they fit at the largest scale, else two rows of two at normal size.
    const wt = data.wait ?? 0, nums4 = numbers4(data), { bsc, oneRow, bottomR } = numbersLayout(cols, rows, nums4), topH = bottomR - 1, wide = cols >= 70;
    if (topH >= 14 && wide) {
      const tstr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, dateStr = `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${DOW[now.getDay()]}`;
      const ic = w.kind === "clear" && w.is_day === 0 ? "night" : w.kind, tempStr = w.temp != null ? `${Math.round(w.temp)}°C` : "", label = w.label ? String(w.label).slice(0, 8) : "";
      if (topH >= 22) { // a tall face: the time as large as it goes, the date under it at half that size, the weather (icon + temperature + place) at the right, all in proportion
        const maxT = Math.max(2, Math.min(6, Math.floor((topH - 2) / (7 + 4)) + 1)); let tsc = 2;
        for (let t = maxT; t >= 2; t--) { const dsc = Math.max(1, Math.floor(t / 2)); if (29 * t + 2 <= cols * 0.55 && 7 * t + 2 + 7 * dsc <= topH) { tsc = t; break; } }
        const dsc = Math.max(1, Math.floor(tsc / 2)), tw = big(tstr, 1, 0, AMBER, true, tsc);
        big(dateStr, 1, 7 * tsc + 2, AMBER, false, dsc);
        const x0 = 29 * tsc + 6, availW = cols - x0 - 1;
        let ssc = Math.max(1, Math.min(tsc, dsc + 1)); while (ssc > 1 && 7 * ssc + 2 + (tempStr ? 24 * ssc : 0) > availW) ssc--;
        const lsc = Math.max(1, Math.min(dsc, Math.floor(availW / Math.max(1, label.length * 6 + 1)))); while (ssc > 1 && label && 7 * (ssc + 1) + 2 + 7 * lsc > topH) ssc--; // the place name under the icon must stay above the bottom row
        const iy = 0; for (const d of icon(ic, 0, 0, GREEN)) for (let a2 = 0; a2 < ssc + 1; a2++) for (let b2 = 0; b2 < ssc + 1; b2++) res.push({ ...d, c: x0 + d.c * (ssc + 1) + a2, r: iy + d.r * (ssc + 1) + b2 });
        if (tempStr) big(tempStr, x0 + 7 * (ssc + 1) + 3, 1, GREEN, false, Math.max(1, ssc));
        if (label && 7 * (ssc + 1) + 2 + 7 * lsc <= topH) big(label, x0, 7 * (ssc + 1) + 2, GREEN, false, lsc);
      } else { // a shorter face: as before
        const tsc = Math.max(2, Math.min(4, Math.floor(topH / 7), Math.floor((cols * 0.5) / 29))), tw = big(tstr, 1, 0, AMBER, true, tsc);
        res.push(...text(dateStr, tw + 5, 0, AMBER).dots);
        const x0 = tw + 5;
        res.push(...icon(ic, x0, 8, GREEN));
        if (tempStr) res.push(...text(tempStr, x0 + 10, 8, GREEN).dots);
      }
    } else { // narrower: the time at normal size, the date and the weather on the next line
      const t = text(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`, 1, 0, AMBER, true); res.push(...t.dots);
      res.push(...icon(w.kind === "clear" && w.is_day === 0 ? "night" : w.kind, t.width + 3, 0, GREEN));
      if (topH >= 16) res.push(...text(`${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${DOW[now.getDay()]}`, 1, 9, AMBER).dots);
      else if (t.width + 12 + 29 <= cols) res.push(...text(`${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`, t.width + 12, 0, AMBER).dots); // no second line: the short date beside the icon
    }
    // the numbers: one row, or two rows of two (WORK DONE / OK WAIT); WAIT blinks in red while somebody waits
    const lay = oneRow ? [nums4] : [nums4.slice(0, 2), nums4.slice(2)];
    lay.forEach((rowList, ri) => { let c = 1; for (const [k0, v, col] of rowList) { const t = text(`${k0} ${v}`, 0, 0, col), dd = [];
      for (const d of t.dots) for (let a = 0; a < bsc; a++) for (let b = 0; b < bsc; b++) dd.push({ ...d, c: c + d.c * bsc + a, r: bottomR + ri * 8 * bsc + d.r * bsc + b, ...(k0 === "WAIT" && wt > 0 ? { blink: true } : {}) });
      res.push(...dd); c += (t.width + 6) * bsc; } });
    return res.filter((d) => d.c >= 0 && d.c < cols && d.r >= 0 && d.r < rows);
  }
  if (lines === 1) { // a one-line sign (46 x 10 dots): one thing at a time, every 4 s (date, week day, time + icon, temperature, place; then the numbers)
    const pad2 = (n) => String(n).padStart(2, "0"), w = data.weather ?? { kind: "clear" }, wait1 = data.wait ?? 0, r0 = Math.max(0, Math.floor((rows - 7) / 2));
    const items = [
      () => text(`${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`, 1, r0, AMBER).dots,
      () => text(DOW[now.getDay()], 1, r0, AMBER).dots,
      () => { const t = text(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`, 1, r0, AMBER, true); return t.dots.concat(cols >= t.width + 11 ? icon(w.kind === "clear" && w.is_day === 0 ? "night" : w.kind, t.width + 3, r0, GREEN) : []); },
      () => (w.temp != null ? text(`${Math.round(w.temp)}°C`, 1, r0, GREEN).dots : []),
      () => (w.label ? text(String(w.label).slice(0, 7), 1, r0, GREEN).dots : []),
      () => text(`DONE ${data.done ?? 0}`, 1, r0, GREEN).dots,
      () => text(`WORK ${data.work ?? 0}`, 1, r0, AMBER).dots,
    ];
    const seq = []; items.forEach((f, i) => { seq.push(f); if (wait1 > 0 && i % 2 === 1) seq.push(() => text(`WAIT ${wait1}`, 1, r0, RED, true).dots.map((d) => ({ ...d, blink: true }))); }); // waiting for approval: the red WAIT comes round more often
    const dots1 = seq[Math.floor(now.getTime() / 4000) % seq.length]();
    return dots1.filter((d) => d.c < cols && d.r < rows);
  }
  const slot = Math.floor(now.getTime() / 10000), wait = data.wait ?? 0;
  const page = wait > 0 ? (slot % 3 === 0 ? 1 : 2) : (slot % 2 === 0 ? 1 : 2); // waiting for approval: page 2 comes first and more often
  const out = [], put = (t, line) => { if (t.dots.length) out.push(...t.dots.filter((d) => d.c < cols)); return t; };
  const pad = (n) => String(n).padStart(2, "0");
  if (page === 1) {
    put(text(`${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${DOW[now.getDay()]}`, 1, 0, AMBER), 0);
    if (lines >= 2) {
      const t = put(text(`${pad(now.getHours())}:${pad(now.getMinutes())}`, 1, 8, AMBER, true), 1);
      const w = data.weather ?? { kind: "clear" };
      if (cols >= t.width + 11) out.push(...icon(w.kind === "clear" && w.is_day === 0 ? "night" : w.kind, t.width + 3, 8, GREEN));
      else if (lines < 3 && w.temp != null) put(text(`${Math.round(w.temp)}°`, t.width + 2, 8, GREEN), 1);
    }
    if (lines >= 3 && data.weather) put(text(`${data.weather.temp != null ? Math.round(data.weather.temp) + "°C " : ""}${String(data.weather.label ?? "").slice(0, 8)}`, 1, 16, GREEN), 2);
  } else {
    const rowsList = [];
    if (wait > 0) rowsList.push([`WAIT ${wait}`, RED, true]);
    rowsList.push([`DONE ${data.done ?? 0}`, GREEN, false], [`WORK ${data.work ?? 0}`, AMBER, false]);
    rowsList.slice(0, lines).forEach(([s, col, blink], i) => { const t = put(text(s, 1, i * 8, col), i); if (blink) for (const d of t.dots) d.blink = true; });
  }
  return out;
}

// The elements: unlit dots are not drawn (the picture already has the dark LED face); lit dots are small divs.
export function boardElements(board, dots, ox, oy, k) {
  const pitch = Math.hypot(board.dy[0], board.dy[1]) || 4, d = Math.max(1.6, pitch * k * 0.62);
  return dots.map((p, n) => {
    const x = board.origin[0] + p.c * board.dx[0] + p.r * board.dy[0], y = board.origin[1] + p.c * board.dx[1] + p.r * board.dy[1];
    // ★54 one call fewer per dot (size for w+h) and no id on a still dot: a board is ~1000 of these and every native call counts in a render's time budget
    const el = (p.blink ? div().id(`led-${n}`) : div()).absolute().left(ox + x * k - d / 2).top(oy + y * k - d / 2).size(d).rounded(d).bg(p.color);
    return p.blink ? el.loop("opacity", { from: 0.15, to: 1, period: 1000 }) : el;
  });
}
