// hakoniwa: shared state model, colours and small helpers (used by every part).
import { div, svg, image } from "gpui-kit";
import { answeredNow } from "./approve.js";

// ★25-1: the box of a right-hand overlay (the terminal window / the side panel), from the window's real size:
// the right edge is 8px inside the window, the width at most 40% of the window.
// ★103-3: the right window is attached (flush with the right edge and the bottom, like the left list): `edge` is the gap (0 = attached; the old float was 8).
export const RIGHT_EDGE = 0, RIGHT_COLLAPSED_W = 44;
// 12th C3: the App places the attached right window 43px left of the x asked for (asked x 1152 -> real left edge 1109, measured 10b; the right edge is x+width = the screen's edge, so
// a shift and a frame give the same number). Popups keep clear of (asked x - RIGHT_WIN_FRAME). The ONE place for the number; popups end RIGHT_POP_GAP left of that edge.
export const RIGHT_WIN_FRAME = 43, RIGHT_POP_GAP = 8;
// 9th Z3 / 14th D2: where each header chip starts at 1920px wide (measured in the 17:23 picture). The command path (no pointer) uses it for the chip lists and the inbox.
export const CHIP_X = { blocked: 240, working: 392, done: 527, idle: 691 };
// 15th E3: the chips' widths move with the digits (and the words). The band measures each chip's width and the command path adds them up from the first chip's left (CHIP_X.blocked),
// so a command opens under the real chip. `widths` {blocked, working, ...} (px), `order` the chips left to right, 2 = the gap between chips. No measure yet -> the fixed CHIP_X.
export const CHIP_GAP = 2;
export function chipLeft(key, widths, order = ["blocked", "working", "done", "idle"]) {
  const i = order.indexOf(key); if (i < 0) return CHIP_X[key] ?? CHIP_X.blocked;
  let x = CHIP_X.blocked;
  for (let j = 0; j < i; j++) { const w = widths?.[order[j]]; if (!(w > 0)) return CHIP_X[key] ?? CHIP_X.blocked; x += w + CHIP_GAP; }
  return Math.round(x);
}
export function rightOverlayBox(vw, vh, top = 60, want = 720, maxFrac = 0.4, edge = 8) {
  const W = Math.max(200, Math.min(want, Math.round(vw * maxFrac), vw - 16)), H = Math.max(120, Math.min(vh - top - edge, vh - 16));
  return { x: Math.max(edge, Math.round(vw - edge - W)), y: top, width: W, height: H };
}

// The four states (brief 2-1), MECE. "Leaving" is not a state: the agent is gone from the list.
//   blocked  承認待ち  a permission or question needs a person      -> queues at the approval desk
//   working  作業中    processing a turn                             -> own desk, screen moving
//   done     報告待ち  turn finished, result not looked at yet       -> submission counter, holding papers
//   idle     待機      looked at, or no task yet (TUI "unknown" too) -> lounge sofa; long_idle (60 min+) dozes
// The collector and items() normalise every status to one of these keys.
export const STATES = [
  { key: "blocked", label: "承認待ち", color: "#F28C28", wash: "#FFF1DF", place: "approval" },
  { key: "working", label: "作業中", color: "#2F80ED", wash: "#E6F0FD", place: "desk" },
  { key: "done", label: "報告あり", color: "#27AE60", wash: "#E3F5EA", place: "counter" },
  { key: "idle", label: "待機中", color: "#8A94A6", wash: "#ECEFF3", place: "lounge" },
];
export const STATE = Object.fromEntries(STATES.map((s) => [s.key, s]));
export const LONG_IDLE_MS = 60 * 60 * 1000; // a look (dozing, faded bubble), not a state
export const stateOf = (a) => STATE[a.status] ?? STATE.idle;
// 46th 44-L2 (office-fix51b): answered by the terminal key / the card copy saw the dialog gone, hc still says "blocked" for 1-3 s: the left list's dot, the floor's tag and the counts
// show "working" (the right window's head says 処理中… the same way, answeredNow). A copy for drawing only (the list itself keeps hc's state for the window/queue); hc's state changing ends it. Pure.
export const answeredView = (list, apanswered, now = Date.now()) => {
  if (!Array.isArray(list) || !apanswered) return list;
  let out = null;
  list.forEach((a, i) => { if (answeredNow(a, apanswered, now)) { out ??= list.slice(); out[i] = { ...a, status: "working", answered_now: true }; } });
  return out ?? list;
};
export const ROOM = { t3: { title: "T3 Code", color: "#0f766e" }, app: { title: "Herdr App", color: "#6d5bd0" },
  tui: { title: "herdr TUI", color: "#475569" } };
// Names come from config.json office.rooms (title); a room without "match" renames the box of its sources.
export function applyRoomTitles(config) {
  const rooms = config?.office?.rooms ?? config?.officeSettings?.rooms;
  if (!Array.isArray(rooms)) return;
  for (const r of rooms) {
    if (r.match || !r.title) continue;
    for (const src of r.sources ?? [r.key]) if (ROOM[src]) ROOM[src].title = r.title;
  }
}
// Colours from config.json office.colors ({states: {blocked, working, done, idle}, ui: {surface, ink, accent}}).
// A missing value keeps the built-in colour. The wash of a state is its colour thinned toward white.
const hexOk = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const thin = (hex, k) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, "0")).join("");
export function applyColors(config) {
  const cols = config?.office?.colors ?? config?.officeSettings?.colors;
  if (!cols || typeof cols !== "object") return;
  for (const st of STATES) {
    const v = cols.states?.[st.key];
    if (hexOk(v)) { st.color = v; st.wash = thin(v, 0.88); }
  }
  const ui = cols.ui ?? {};
  if (hexOk(ui.surface)) P.paper = ui.surface;
  if (hexOk(ui.ink)) P.ink = ui.ink;
  if (hexOk(ui.accent)) P.blue = ui.accent;
}
// Platform (what the agent runs on / which contract): icon from Herdr app's own icons/.
export const PLATFORM = {
  "claude-code": { name: "Claude Code", icon: "icons/claude.svg" },
  claude: { name: "Claude Code", icon: "icons/claude.svg" },
  copilot: { name: "GitHub Copilot", icon: "icons/copilot.svg", tint: "#24292f" },
  opencode: { name: "OpenCode", icon: "icons/opencode.svg", tint: "#1f2937" },
  codex: { name: "Codex", icon: "icons/codex.svg" },
  cursor: { name: "Cursor", icon: "icons/cursor.svg", tint: "#111827" },
  antigravity: { name: "Antigravity", icon: "icons/antigravity.svg" },
  agy: { name: "Antigravity", icon: "icons/antigravity.svg" },
  gemini: { name: "Gemini", icon: "icons/gemini.svg", tint: "#1a73e8" },
};
export const REFRESH_MS = 4000;
export const P = { ink: "#1F2A37", muted: "#7b8494", line: "#e6e2d8", bg: "#f6f3ec", white: "#ffffff", paper: "#FFFDF8", blue: "#1E6FE0" };

export const dot = (color, size = 7) => div().size(size).rounded(size).bg(color).flex_none();
export const chip = (color, size = 8) => div().size(size).rounded(2).bg(color).flex_none();
export const badge = (text, color, filled = false) => div().flex_none().px(5).py(1).rounded(4)
  .text_size(10).font_weight(600).text_color(filled ? "#ffffff" : color)
  .bg(filled ? color : "#00000000").border(1).border_color(color).child(text);
export const clock = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
export const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "今" : m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
};
export const platform = (a) => PLATFORM[a.app] ?? { name: a.program?.name ?? a.app ?? "agent", icon: a.program?.icon ?? "icons/agent.svg",
  tint: a.program?.tint ? "#374151" : undefined };
export const platformIcon = (a, size) => {
  const p = platform(a);
  return (p.tint ? svg(p.icon).text_color(p.tint) : image(p.icon)).size(size).flex_none();
};
// Memory of an agent's process tree ("350MB", "1.2GB"). undefined: not measured yet (show nothing); null: cannot be measured ("—").
export const fmtMem = (b) => b == null ? "—" : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : `${Math.max(1, Math.round(b / 1048576))}MB`;
export const hasMem = (a) => a.mem_bytes !== undefined;
// Candidates to clean up (long waits that hold memory): state.cleanup.ids, biggest first; lit up only on request.
export const cleanupIds = (state) => state?.cleanup?.ids ?? [];
export const blockedText = (a) => a.blocked_msg || (a.blocked_kind ? `承認（${a.blocked_kind}）` : "承認待ち");
// ★62-2 a tile of a picture cut into tiles, on whole pixels: both edges are rounded (so the right edge of one tile is the left edge of the next at every zoom),
// and `over` px more on the right and the bottom for an opaque tile (the next tile is drawn over it). Returns [left, top, width, height].
export const snapBox = (ox, oy, k, r, over = 0) => {
  const x0 = Math.round(ox + r[0] * k), y0 = Math.round(oy + r[1] * k), x1 = Math.round(ox + (r[0] + r[2]) * k), y1 = Math.round(oy + (r[1] + r[3]) * k);
  return [x0, y0, x1 - x0 + over, y1 - y0 + over];
};
// ★65-2 / self-review #8 #9 (office-polish): who shows no name tag (a colour dot, or "Zzz" when waiting), so tags do not stack into a staircase with
// long crossing lines: in a window's line, everybody behind its head (the approval card names the head's request); in the lounge, everybody once 3 or
// more sit there. Only people who stand or sit still (a walker keeps the tag). The chosen / pointed-at person always has the tag (the caller checks).
// ★70-2: a child (an agent with a parent) never shows a name tag, walking or not: only the dot over its head (its tag covered the talk bubbles of ★66).
// The parent (★) and an agent on its own keep theirs. A child at the head of a window's line keeps its card (the approval / report card is the tag there).
export const quietTagRule = ({ at, status, head, id }) => { // ★72-2 (office-live): a tag only for somebody waiting for approval / reporting (in a window's line: its head only); everybody else a dot
  const m = /^(approval|counter):/.exec(at ?? "");          // (a parent too: the gold ★ over the head and a gold ring at the feet say who leads; chosen / pointed-at people get their tag from `detail`)
  if (status === "blocked" || status === "done") return !!m && (head?.[m[1]] ?? null) !== id;
  return true;
};
// ★62-3 the zoom of 「全体を表示」: 1 for a scene that is scaled to the window anyway; for a native scene (k = zoom) the largest zoom up to 1 at which
// the whole floor fits with a margin (8 px at the sides and the top, 32 px at the bottom for the room signs on the front edge).
export const fitZoom = (sc, W, H) => {
  if (!sc?.native || !(sc.width > 0) || !(sc.height > 0)) return 1;
  return Math.max(0.4, Math.min(1, (W - 16) / sc.width, (H - 40) / sc.height));
};

// ★61 (C8's morning pictures): the first plan for a new cast / size can pass the App's 30 s limit while the pictures are made; the next run
// goes on from what was written. So the first failures say "being prepared" (with how long so far), and only a run of `limit` failures says the error.
export function planWaitText(error, fails = 0, since = null, now = Date.now(), limit = 3) {
  if (error && fails >= limit) return `描けません: ${error}`;
  const s = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  return error || s >= 10 ? `オフィスを準備中…（人と家具の絵を作っています${s ? ` ${s}秒` : ""}）` : "オフィスを準備中…";
}
// ★62-2 a tile cut with `bleed` px of its neighbours (office.py): `clip` is the tile's own rect on whole pixels (snapBox), `img` the whole picture
// inside that clip (relative to it), so the border the App smears when it zooms a picture lies outside the clip. A tile without bleed: clip = null.
export const bleedBox = (ox, oy, k, t, over = 0) => {
  const b = t.bleed ?? 0;
  if (!b) return { clip: null, img: snapBox(ox, oy, k, t.rect, over) };
  const clip = snapBox(ox, oy, k, t.rect, 0), r = t.rect;
  return { clip, img: [ox + (r[0] - b) * k - clip[0], oy + (r[1] - b) * k - clip[1], (r[2] + 2 * b) * k, (r[3] + 2 * b) * k] };
};
