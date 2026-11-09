// hakoniwa ★84: the pure rules of the UI parts (no imports: tested with node alone).
// ---- pure rules (tested in test-life.mjs)
export const LEFT_W = { min: 180, max: 480, def: 280 }, RIGHT_W = { min: 320, max: 720 };
// The widths that were saved: anything else becomes the default; a width is kept inside its range, and the right one never wider than 60% of the window.
export function clampWidth(side, w, vw = 1600) {
  const r = side === "left" ? LEFT_W : RIGHT_W, hi = side === "left" ? r.max : Math.min(r.max, Math.max(r.min, Math.round(vw * 0.6)));
  const n = Number(w); if (!Number.isFinite(n)) return side === "left" ? LEFT_W.def : null;
  return Math.max(r.min, Math.min(hi, Math.round(n)));
}
export const cleanWidths = (raw, vw = 1600) => ({ left: clampWidth("left", raw?.left, vw), right: raw?.right == null ? null : clampWidth("right", raw.right, vw) });
// The right window's head (face + name row, chip row, info line, tabs): a narrow window gives the info line two lines; the chips are always one line (cut with "…").
// ★107 W2: the head's content (10 top + 56 face + 6 + 30 chips + 6 + the info line) was taller than the block it sits in, so the tabs under it were pushed 8px out and clipped (the blue line
// was cut off). The info line is now a fixed box (22 / 44 high) and the sums below leave room for the content (headBodyH >= headContentH, tested).
export const RIGHT_HEAD = { name: 64, chips: 30, info: 22, infoNarrow: 44, tabs: 36, pad: 16 };
export const headHeight = (w) => RIGHT_HEAD.name + RIGHT_HEAD.chips + (w < 380 ? RIGHT_HEAD.infoNarrow : RIGHT_HEAD.info) + RIGHT_HEAD.tabs + RIGHT_HEAD.pad;
export const headBodyH = (w) => headHeight(w) - RIGHT_HEAD.tabs;                                      // the head part (everything above the tabs)
export const headContentH = (w) => 10 + 56 + 6 + RIGHT_HEAD.chips + 6 + (w < 380 ? RIGHT_HEAD.infoNarrow : RIGHT_HEAD.info); // what detail.js draws in it (pt 10, face 56, gaps 6)
// ★107 W3: a screen copy (no transcript) starts with Claude Code's fixed start-up block (logo, version, company message, settings warnings). Fold exactly that: from the top to the
// first line of the conversation itself (a prompt "❯" / ">", a "●" reply, a box). Nothing is folded when the logo is not on the screen (it scrolled off) or the block never ends.
export function foldScreenHead(screen) {
  const text = String(screen ?? ""), lines = text.split(/\r?\n/), none = { head: "", rest: text, n: 0 };
  const logo = lines.findIndex((l, i) => i < 12 && /▐▛|▜▌|▝▜|▘▘|Claude Code v?\d/.test(l));
  if (logo < 0) return none;
  let end = -1;
  for (let i = logo + 1; i < lines.length; i++) if (/^\s*(❯|>(\s|$)|●|⏺|╭|╰)/.test(lines[i])) { end = i; break; }
  if (end < 0) return none;
  const head = lines.slice(0, end).join("\n");
  return { head, rest: lines.slice(end).join("\n"), n: lines.slice(0, end).filter((l) => l.trim()).length };
}
// How many letters a chip may show in a window of width w (the rest is "…"), so that the chips stay on one line.
export const chipChars = (w, n = 3) => Math.max(4, Math.floor((w - 32 - n * 22) / (n * 7.5)));
// ★88-6 one rule for a long name (a terminal's title became the name: "デザインチェッカースキルとCMYK検出ツール 返事待ち" was wider than a room): the width counts a
// full-width letter as 1 and a half-width one as 0.5; over `em` it is cut and "…" follows (the "…" takes the last em). Tags: NAME_EM (about 12 full-width letters); hover / chosen / detail show NAME_EM_FULL.
export const NAME_EM = 12, NAME_EM_FULL = 30;
export const nameEm = (t) => [...String(t ?? "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1 : 0.5), 0);
// 25th L4 / 26th: a long name is cut with "…" but never right after a symbol or a half word ("ブログ_設定_…" -> "ブログ_設定…", "ブログ_設…" -> "ブログ…").
// Only a text that ends with "…" is touched; a text without a separator before the end is left as it is. (Moved here from panel.js so clipName and the list share it.)
const CUT_SEP = "[\\s_\\-\\u2013\\u2014\\u2010\\u30FB\\u3001\\u3002,.:;/|()\\uFF08\\uFF09\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\[\\]<>\\uFF1A]";
const CUT_TAIL = new RegExp(`${CUT_SEP}+$`), CUT_FRAG = new RegExp(`^(.*${CUT_SEP})([^\\s_\\-\\u2013\\u2014\\u2010\\u30FB\\u3001\\u3002,.:;/|()\\uFF08\\uFF09\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\[\\]<>\\uFF1A]+)$`);
// 22nd 21-N5: in a bold tag the baseline "…" (U+2026, Segoe UI Bold) looked like a low "_ _". The cut mark is "⋯" (U+22EF, the midline dots; Segoe UI / Yu Gothic have no glyph, so it
// falls to Segoe UI Symbol / Meiryo, both centred). A text ending with either mark is recognised.
export const ELLIP = "⋯";
export const endsCut = (t) => { const s = String(t ?? ""); return s.endsWith("…") || s.endsWith(ELLIP); };
export const tidyCut = (t) => {
  const s = String(t ?? ""); if (!endsCut(s)) return s;
  let b = s.slice(0, -1).replace(CUT_TAIL, "");
  const m = b.match(CUT_FRAG);
  if (m && (/[^\x00-\xff]/.test(m[2]) ? [...m[2]].length <= 1 : m[2].length <= 2)) { const c = m[1].replace(CUT_TAIL, ""); if (c) b = c; } // a one-letter (full-width) or two-letter fragment after a separator is a half word
  return `${b}${ELLIP}`;
};
export const clipName = (t, em = NAME_EM) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (nameEm(s) <= em) return s;
  let w = 0, out = "";
  for (const ch of s) { const cw = ch.charCodeAt(0) > 255 ? 1 : 0.5; if (w + cw > em - 1) break; w += cw; out += ch; }
  return tidyCut(out.replace(/\s+$/, "") + ELLIP); // 26th L4: the same tidy end as the list
};
export const ellipsize = (t, n) => { const s = String(t ?? ""); return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s; };
// ★103-4-2 the shared sizes (1.25-1.5x of before; a thing to press is at least 32px high). Left / right parts import these; one place to change.
export const UI = {
  scale: 1.35,                                        // overall factor used to derive the values below
  hit: 32,                                            // minimum height of anything pressable
  text: { small: 15, body: 17, strong: 19, count: 25, chip: 18 }, // ★8th (3rd) ratio 0.74: the left list (ok at 17 vs codex_3 ~23) is the yardstick; the other parts = codex_3 x 0.74: chip label 18, count 25, right name 22 / tab 17 / bubble 17 / bullet 16 / button 44 / footer 15-16, count 19
  rname: 22, rbody: 17, rlog: 16, btn: 44, // ★8th font8 (2nd): back to the 16:37 values (the left list was big enough; ceiling for the left). codex_3 at the real 1920px width asks for ~21-25 (+6..+9 over these): not applied, values shown to the reviewer
  icon: 24, iconBtn: 32,                              // pencil / trash / x / fold arrows: the icon and its pressable box
  row: 40,                                            // a list row (16:37 value; codex_3 at 1920px = ~47, not applied)
  band: 72,                                           // header height (was 60; codex_3 = 58 but the 56px logo sets it, kept)
  pill: 40,                                           // a header state count (16:37 value; codex_3 at 1920px = ~55, not applied)
  seg: 39,                                            // a view-switch segment (was 28)
};
export const pressable = (h) => Math.max(UI.hit, Math.round(h));
// ★103-2 a header count reaches everyone in its state: each press moves to the next person (wraps). `list` = [{id,status,since}], `curId` = who is chosen now.
export function nextInState(list, state, curId) {
  const xs = (list ?? []).filter((a) => a.status === state).sort((a, b) => state === "done" ? b.since - a.since : a.since - b.since);
  if (!xs.length) return { person: null, index: 0, total: 0 };
  const i = xs.findIndex((a) => a.id === curId), k = i < 0 ? 0 : (i + 1) % xs.length;
  return { person: xs[k], index: k + 1, total: xs.length };
}
// ★103-2 (2nd): a header count lists everyone in its state (same order as above). 0 -> nothing, 1 -> straight to that person, 2+ -> a list under the chip.
export function chipPeople(list, state) {
  return (list ?? []).filter((a) => a.status === state).sort((a, b) => state === "done" ? b.since - a.since : a.since - b.since);
}
export const chipAction = (n) => n <= 0 ? "none" : n === 1 ? "direct" : "list";
// 10th: `row` is the one number for a row's height (two lines: name 17px + room 15px); main.js draws with it and chipListHeight sizes the popup with it.
export const CHIP_LIST = { w: 360, maxRows: 8, pad: 8, row: 56 };
// ★103 (polish): a count with 2+ people shows "▾" (a press opens the list). 14px caret + the pill's 7px gap = CARET_W, counted in bandNeed.
export const CARET = "▾", CARET_W = 14 + 7;
export const PANEL_HINT = "ドラッグで部屋を移動";
export const showCaret =(n) => chipAction(n) === "list";
export const chipListHeight = (n) => Math.min(n, CHIP_LIST.maxRows) * CHIP_LIST.row + CHIP_LIST.pad * 2;
// The band's needed width at a given step, to check 1400 / 1100 px by calculation (the App can't be shot here). All numbers are the drawn sizes in main.js band().
// ★104 the header logo (hakoniwa-logo.png 480x144, 10:3) drawn at 56px high.
export const LOGO_H = 56, LOGO_W = 187;
export const LOGO_HEAD = 44; // tight (< 1250): the leader's head alone (icons/hakoniwa-head.png) at LOGO_HEAD px
export function bandNeed(narrow, tight, n = { counts: 4, cleanup: false }) {
  const pill = (narrow ? 0 : 56) + 9 * 2 + 26 + 6 * (narrow ? 1 : 2) + 22 + 2 + CARET_W;       // mark + (label) + count (+ "i/N" when 2+) + "▾" (2+)
  const cleanup = n.cleanup ? (narrow ? 90 : 220) : 0;
  const sw = tight ? 2 * 44 + 10 : 2 * 112 + 10, usage = tight ? 130 : 210;
  return 16 * 2 + 12 * 5 + (tight ? LOGO_HEAD : LOGO_W) + 1 + n.counts * pill + cleanup + sw + usage + UI.iconBtn + 3 * 34;
}

// A box that has to stay inside its parent's box (a popup / bubble drawn by a part): { x, y, w, h } both.
export const fitsInside = (b, p) => !!b && !!p && b.x >= p.x && b.y >= p.y && b.x + b.w <= p.x + p.w && b.y + b.h <= p.y + p.h;


// ★103-3 (office-region103): the right column as a real layout region ("right" in agent-office.json, hidden until used). Switch: right-region.json {"on": true}.
// Pure plan: what to tell the App for a person / terminal (target), the tab, the folded strip. Same plan -> same key -> nothing is sent twice.
export const REGION = { id: "right", head: "r-head", body: "r-body", stack: "r-body", term: "r-term", chat: "r-chat", tree: "r-tree", foldedW: 44, pickHead: 52, inboxHead: 640 };
export const regionOn = (raw) => { try { return JSON.parse(String(raw ?? "")).on === true; } catch { return false; } };
export function regionPlan({ target, tab = "terminal", collapsed = false, viewW = 1600, rightW = null, topH = 200 } = {}) {
  if (!target) return { key: "hide", sel: null, ops: [["layout.hide", { id: REGION.id }]] };
  // ★106 ②: kind "inbox" = the inbox in the head block, the body hidden (opened by the chips 承認待ち / 報告あり, shared flag hakoniwa.inboxOpen)
  const inbox = target.kind === "inbox";
  const w = collapsed ? REGION.foldedW : clampWidth("right", rightW ?? Math.round(viewW * 0.3), viewW), pick = target.kind === "pick";
  const child = pick || inbox || tab === "terminal" ? REGION.term : tab === "chat" ? REGION.chat : REGION.tree, headH = inbox ? REGION.inboxHead : pick ? REGION.pickHead : topH;
  const key = `${target.kind}|${target.address ?? ""}|${target.id ?? ""}|${child}|${w}|${collapsed}|${headH}`;
  const ops = [];
  if (target.address && !collapsed && child === REGION.term) ops.push(["agent.focus", { terminal: target.address }]);
  ops.push(["layout.show", { id: REGION.id }], ["layout.resize", { id: REGION.id, px: w }]);
  if (inbox) ops.push(["layout.hide", { id: REGION.body }], ["layout.resize", { id: REGION.head, px: headH }]);
  else if (collapsed) ops.push(["layout.hide", { id: REGION.body }]);
  else ops.push(["layout.show", { id: REGION.body }], ["layout.resize", { id: REGION.head, px: headH }], ["layout.select", { stack: REGION.stack, child }]);
  return { key, sel: { kind: target.kind, id: target.id ?? null, address: target.address ?? null, name: target.name ?? "", tab: pick ? "terminal" : tab, collapsed, w }, ops };
}
// ★103-3 the focus moved to terminal `ft` while the region shows `addr`: nothing (same / unknown); "select" the person it moved to (a person of the list: the head follows the body,
// e.g. a toast or an App key moved on); "refocus" only when it moved to a terminal that is not in the list (the body goes back to the head's terminal).
export function regionFocusFix(ft, addr, list) {
  if (!ft || !addr || ft === addr) return { act: "none", id: null };
  const p = (list ?? []).find((x) => x.source === "app" && x.address === ft);
  return p ? { act: "select", id: p.id } : { act: "refocus", id: null };
}

// ★103 (width): the head's chips are planned by pixels, not by a letter count. `chips`: [{ key, text, extra (icon + gap inside the pill), keep (never cut / dropped) }];
// `avail`: the row's width (the region width minus the head's side padding); `fixed`: the width of anything else on the row (the ■ button). A pill is 20px of padding + extra + the
// text; 14px text: a full-width letter 15px, a half-width one 8.5px (on the safe side, so a pill is never cut inside a letter). Cuttable pills share what is left; the one that
// would get under `minPx` is left out (last first). Returns [{ key, text }] in the same order.
export const textPx = (t) => [...String(t ?? "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 15 : 8.5), 0);
export const clipPx = (t, px) => {
  const s = String(t ?? ""); if (textPx(s) <= px) return s;
  let w = textPx("…"), out = ""; for (const ch of s) { const c = textPx(ch); if (w + c > px) break; w += c; out += ch; }
  return out ? `${out}…` : "…";
};
export function fitChips(avail, chips, fixed = 0, minPx = 64, gap = 6) {
  let live = chips.slice();
  for (;;) {
    const keep = live.filter((c) => c.keep), cut = live.filter((c) => !c.keep);
    const used = fixed + gap * Math.max(0, live.length - 1 + (fixed ? 1 : 0)) + live.reduce((n, c) => n + 20 + (c.extra ?? 0), 0) + keep.reduce((n, c) => n + textPx(c.text), 0);
    const left = avail - used, want = cut.reduce((n, c) => n + textPx(c.text), 0);
    if (left >= want || !cut.length) return live.map((c) => ({ key: c.key, text: c.keep || left >= want ? c.text : clipPx(c.text, left / cut.length) }));
    if (left / cut.length >= minPx) return live.map((c) => ({ key: c.key, text: c.keep ? c.text : clipPx(c.text, left / cut.length) }));
    live = live.filter((c) => c !== cut[cut.length - 1]); // too narrow: the last cuttable pill goes
  }
}
