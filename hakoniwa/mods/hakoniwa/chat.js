// hakoniwa conversation (role "chat" window, and the Office side panel). Mixed into AgentHud.
import { div, image } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { appHome, closeOverlay, exec, openOverlay, props, readTextFile, run, setShared, settings, shared, writeTextFile } from "herdr";
// 13th B1/B6: `window` here is the ambient gpui Window (viewport_size / bounds). fix11b imported `window` from "herdr" (a function: titlebar info) which hid it, so viewport_size() threw on every call and the
// code fell back to left.width+268 (= 2188 wide): the right window was asked for x=1313 w=875, i.e. 268px past the screen edge (bubbles / the send button cut at x=1920). Never import `window` from "herdr" here.
const vpSize = () => { try { const v = globalThis.window?.viewport_size?.(); return v && v.width > 0 ? v : null; } catch { return null; } };
const winBounds = () => { try { const b = globalThis.window?.bounds?.(); return b && b.width > 0 ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; } catch { return null; } };
import { rightOverlayBox, RIGHT_EDGE, RIGHT_COLLAPSED_W, RIGHT_WIN_FRAME, STATE, ROOM, P, dot, chip, badge, clock, ago, platform, platformIcon, stateOf, blockedText } from "./common.js";
import { fitTail, unwrapHc } from "./life.js";
import { tabFor } from "./detail.js";
import { headHeight } from "./ui-rules.js";
import { fitScreenLines, stripTerminalFrame } from "./tool-lines.js";
import { iconBtn } from "./ui.js";
import { icon } from "./icons.js";
import { endAgent, endQuestion, runAgentOps } from "./actions.js";

// Long unbroken text (paths, commands) gets break points so it wraps inside the panel instead of running off it.
const ZW = "​";
const imgLine = (t) => String(t ?? "").replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_m, u) => `画像: ${String(u).split(/[\\/]/).pop().split("?")[0] || u}`); // a picture in Markdown: one short line, no thumbnail
const soft = (t) => imgLine(String(t ?? "")).replace(/([/\\_,&|;=-])(?=\S)/g, "$1" + ZW).replace(/(\S{24})(?=\S)/g, "$1" + ZW);

// 17th E4 (office-fix17b): the card measured on the real window (12th, 1920x1152): 126 px high with a one-line ask (the block was 176: ~42 px of empty paper under the card).
// card = border 2 + padding 20 + title 22 + gaps 12 + ask (16px text: 26 per line) + buttons 44 -> 126 for one line. The block adds the 8 px the card wrapper keeps above it (detail.js approvalAsk pt 8).
// The ask's lines are estimated from the window's width (a long path wraps to a second line; the ask is never cut): 16 px per wide letter, 9 per narrow one. The 26 per line is the 1.6 line height
// measured on the 11 / 12 px labels (18 / 19), not measured on a two-line card.
// 34th A6 MEASURED (11/8, a real window 738 wide, Write ask): card 170 = border 2 + padding 20 + what 2 lines 50 + gap 6 + buttons 44 + gap 6 + hint 2 lines 42; the orange record 56; no ask line (it shows only before the what lines load).
// APPROVE_CARD = 66 = border 2 + padding 20 + buttons 44; + APPROVE_WHAT 56 + APPROVE_HINT 48 = 170 (exact; the 98 left 32 px empty). While the heading is drawn (no orange record) the hint is left out, so the card still fits (28 + 56 + 66 = 150).
const APPROVE_CARD = 66, APPROVE_LINE = 26, APPROVE_TOP = 0, APPROVE_GAP = 0; // 34th 33-A2/A6: the card sits on the orange record (no strip above: APPROVE_TOP = the wrapper's pt, APPROVE_GAP = the block's pt in detail.js approveBlockView; keep the three 0). 98 = 126 - 28: the 「承認を待っています」 heading (title 22 + gap 6) is no longer drawn while the orange record is shown (31-Y1) -- derived from the code, not measured on a window
export function approveLines(text, width) {
  const inner = Math.max(120, (Number(width) || 0) - 54); // wrapper px 14 x2 + card px 12 x2 + border 2
  let n = 0;
  for (const ln of String(text ?? "").split(/\r?\n/)) n += Math.max(1, Math.ceil([...ln].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 16 : 9), 0) / inner));
  return Math.min(4, n);
}
const APH_REOPEN_MAX = 2; // 34th 33-A4: how many times the window may be opened again for a longer ask alone, per waiting episode (the same cap as the inbox's: fix28c)
export const YOUNG_MS = 3000; // 43rd 41-I4: how long a new copy may draw 「読み込み中…」 for a screen that is not yet a conversation
const MISS_GRACE = 3000; // 33rd 32-Z1: how long a not-yet-found person is drawn blank before the reason shows
const COMPOSER_HINT = 29; // 32nd 31-Y6: the pale line above the input while the person waits (detail.js composer-hint: 13px text -> 21 + the composer's gap 8); added to the input block (72) and taken off the conversation's room
const APPROVE_HINT = 48; // 20th H5 / 19th K2: the two pale lines under the buttons (13px text -> 21 x 2 + the card's gap 6); always reserved (the window is not opened again when the buttons appear)
const APPROVE_WHAT = 56; // 22nd N2: the "what is asked" lines over the description (detail.js approvalAsk, 15px mono, at most two: 24 x 2 + the gap 2 + the card's gap 6); always reserved, like the hint (it is read after the window opens)
export const approveHeight = (text, width) => APPROVE_TOP + APPROVE_CARD + APPROVE_HINT + APPROVE_WHAT + APPROVE_LINE * (Math.min(2, approveLines(text, width)) - 1); // 39th 37-E1: the ask paragraph is clamped to 2 lines (approve.js clampAsk), so the estimate never counts more than 2 (the card stays inside the block, buttons visible)

// 20th H1 (office-fix20a): the right window's conversation shows the newest messages that fit, with a "↑ 前の発言を読む（N 件）" row above (a press goes back one more screen).
// The heights are built from the parts of panelMessage (name row 13px -> 21, gap 3, bubble py 10 x2, 17px text at the 1.6 line height -> 27, rows gap 8); NOT measured on a captured window
// (install is the parent's), so the numbers live here only: if a capture shows the cut is off, change CONV and nothing else.
// 21st I1 (office-fix21a): measured on the 16th capture (office-ux16): one text line is 28 (was 27), name + gap + rowGap is 34 (was 32: gap 3 -> 5).
export const CONV = { name: 21, gap: 5, padY: 20, line: 28, rowGap: 8, toolRow: 30, toolBox: 44, older: 40, wide: 17, narrow: 9, padX: 58, headRow: 44, input: 72 };
const convWidthOf = (text) => [...String(text ?? "")].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? CONV.wide : CONV.narrow), 0);
export const convLines = (text, width) => {
  const inner = Math.max(120, (Number(width) || 0) - CONV.padX);
  return String(text ?? "").split(/\r?\n/).reduce((n, ln) => n + Math.max(1, Math.ceil(convWidthOf(ln) / inner)), 0);
};
export const convCost = (m, width, afterTool = false) => m?.role === "tool" ? CONV.toolRow + (afterTool ? 0 : CONV.toolBox)
  : CONV.name + CONV.gap + CONV.padY + CONV.line * convLines(unwrapHc(m?.text).text, width) + CONV.rowGap;
// -> { msgs (the part to draw, oldest first), hidden (older messages not drawn; a cut-down one counts as 1), partial (the one message left is shown from its end) }.
// back = how many more screens were asked for by the "前の発言" row. A single message taller than the window is shown from its end (the tail lines), never from its start.
// 21st I2/I4: any message that does not fit (the newest, or the next older one when the window still has room left, e.g. while an approval is waiting) is shown from its end, as much as the
// height left allows; its first line says how many lines were left out ("… 前の N 行"). A tail is only drawn when at least MIN_TAIL lines of it fit (otherwise a sliver is not worth a line).
const MIN_TAIL = 3;
function tailOf(m, width, avail, force) {
  const inner = Math.max(120, (Number(width) || 0) - CONV.padX), room = Math.floor((avail - (CONV.name + CONV.gap + CONV.padY + CONV.rowGap)) / CONV.line) - 1; // -1: the "…" line
  const use = force ? Math.max(4, room) : room;
  if (!force && use < MIN_TAIL) return null;
  const text = unwrapHc(m.text).text, total = convLines(text, width), lines = text.split(/\r?\n/), keep = []; let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) { const k = Math.max(1, Math.ceil(convWidthOf(lines[i]) / inner)); if (keep.length && n + k > use) break; keep.unshift(lines[i]); n += k; }
  if (keep.length === 1 && n > use) { const t = [...keep[0]]; keep[0] = t.slice(Math.max(0, t.length - Math.floor(inner / CONV.narrow) * use)).join(""); n = use; }
  const left = Math.max(1, total - n);
  return { ...m, text: `… 前の ${left} 行\n${keep.join("\n")}` };
}
export function fitConversation(msgs, width, height, back = 0) {
  const all = Array.isArray(msgs) ? msgs : [], budget = Math.max(CONV.line * 4, Number(height) || 0) * (1 + Math.max(0, back | 0)) - CONV.older;
  const costs = all.map((m, i) => convCost(m, width, i > 0 && all[i - 1]?.role === "tool"));
  let used = 0, from = all.length;
  for (let i = all.length - 1; i >= 0; i--) { if (from < all.length && used + costs[i] > budget) break; used += costs[i]; from = i; }
  const shown = all.slice(from);
  if (shown.length === 1 && costs[from] > budget && shown[0].role !== "tool") return { msgs: [tailOf(shown[0], width, budget, true)], hidden: from + 1, partial: true };
  const p = from - 1, older = p >= 0 ? all[p] : null;
  if (older && older.role !== "tool") { const t = tailOf(older, width, budget - used, false); if (t) return { msgs: [t, ...shown], hidden: p + 1, partial: true }; } // hidden counts the cut one
  return { msgs: shown, hidden: from, partial: false };
}

export class ChatPart {
  initChat(cx) {
    // 34th 34-B4: a window opened again at a change of state (the approval answered) is a new copy with no data, so it drew only 「読み込み中…」 for a moment. The last read of the same person (shared, under 2 min old) is kept on screen until the new read lands.
    let seed = null; try { const cc = shared("hakoniwa.chatcache"), pid = (this.bodyProps?.() ?? props())?.id; if (cc?.data && pid && cc.id === pid && Date.now() - (cc.at ?? 0) < 120000) { seed = cc.data; this.seedBlocked = cc.st === "blocked"; } } catch {} // 41st 39-G1 (office-fix46a): st = whether the person waited for approval when that screen was read
    this.chat = { loading: true, data: seed };
    if (seed && (this.bodyProps?.() ?? props())?.role === "chat-body") this.traceChat({ ev: "seed", id: (this.bodyProps?.() ?? props())?.id, seedBlocked: !!this.seedBlocked, seedAt: shared("hakoniwa.chatcache")?.at ?? null });
    try { this.msgState = InputState.new({ placeholder: "メッセージ、またはコマンドを入力…" }); } catch { this.msgState = null; } // ★105 R8 the composer's input (made here, never in render)
    try { this.rejectState = InputState.new({ placeholder: "却下の理由（任意）…" }); } catch { this.rejectState = null; } // 24th Q2: the same input while the person waits for approval (InputState has no way to change a placeholder later, so a second state)
    this.chatStartAt = Date.now(); // 43rd 41-I4: when this copy began (detail.js draws 「読み込み中…」 instead of the start-up banner for its first ~3 s while the screen is not yet a conversation)
    // 43rd 41-I2 (office-fix48a): a copy opened FOR a waiting person (props ap === 1, a seed read while it waited, or the card block itself) is a new copy that never saw the switch to "waiting", so the
    // watch below never logs blocked-in for it and the buttons came ~3.5 s late. It reads the state, the screen and the card's options once, at its start (logged as blocked-in with fromInit).
    { const p0 = this.bodyProps?.() ?? props(), r0 = p0?.role, forBlocked = (r0 === "chat-body" && (p0?.ap === 1 || !!this.seedBlocked)) || r0 === "chat-approve";
      cx.spawn(async (cx) => {
        await this.loadConfig();
        if (!forBlocked) { await this.loadChat(cx); return; }
        this.traceChat({ ev: "blocked-in", id: p0?.id ?? null, fromInit: true, ap: p0?.ap ?? null, seedBlocked: !!this.seedBlocked });
        try { await this.load(); } catch {}
        const a0 = p0?.id ? this.items().find((x) => x.id === p0.id) : null;
        this.chatKey = this.chatWatchKey(a0); // the poll below must not read the same screen a second time for the same state
        await Promise.all([this.loadChat(cx, true), a0?.status === "blocked" ? this.loadApproval(a0, cx) : null]);
      }); }
    // ★106: the screen of every waiting App person is read once per change of state (id|since), so the card / inbox can show the buttons (never in render)
    this.watchApprovals(cx);
    // ★109 (office-verify6): the window's blocks (chat-body, chat-input) and the region's rchat never ran the feed (main.js returns early for them), so items()
    // had only the live overlay; read the collector's state file here too (cheap: an unchanged text returns false) so the person is found as in the head.
    // 27th T4 (office-fix32a): the input's guide ("却下の理由（任意）…" while waiting) and the approval card follow the person's status, but the status can change in the live overlay without the state
    // file changing (load() then returns false and nothing redrew), so the old guide stayed after the question was answered. waitSeen = the "id|waiting" last drawn: a change of it redraws too.
    // 40th 38-F2 (office-fix45b): the watch ticks every 0.5 s (was 1.5 s) but reads the state file only every 3rd tick, or every tick while the person waits for approval (this.fastWatch), so a rejection by the terminal key
    // is seen within ~0.5 s. At the moment the waiting person turns into "not waiting", unblockedAt is set; the screen copy read before it still ends with the dialog, so detail.js hides the orange record / 「承認を待っています」
    // until a read that STARTED after unblockedAt lands (chatDataFrom), and this timer asks for that read at once (chat-body only). Every step is logged to chat-watch.json (ev "unblocked" / "reread") with the time.
    this.watchTick = 0;
    cx.timer.every(500, (cx2) => { this.watchTick = (this.watchTick ?? 0) + 1;
      if (this.chatYoungShown && Date.now() - (this.chatStartAt ?? 0) >= YOUNG_MS) { this.chatYoungShown = false; cx2.spawn(async (cx3) => cx3.notify()); } // 43rd 41-I4: the 「読み込み中…」 line ends by itself after YOUNG_MS (a fresh agent that really shows its banner then gets it drawn)
      if (this.feed.config && (this.fastWatch || this.watchTick % 3 === 0)) cx2.spawn(async (cx3) => { try {
      const changed = await this.load(), id = (this.bodyProps?.() ?? props())?.id, a = id ? this.items().find((x) => x.id === id) : null;
      { const eff = a ? (() => { try { return this.liveOf(a)?.status ?? a.status; } catch { return a.status; } })() : null, wasBlocked = this.lastEff === "blocked", hadEff = this.lastEff !== undefined; this.lastEff = eff; this.fastWatch = eff === "blocked";
        // 42nd 40-H2 (office-fix47a): the moment the person turns into "waiting" the screen is read at once (it was up to ~4.5 s later: the poll), so the orange record and the card's options come with the state
        if (eff === "blocked" && !wasBlocked && hadEff && props()?.role === "chat-body" && !this.chat?.busy) { this.traceChat({ ev: "blocked-in", id, since: a?.since ?? null }); this.chatKey = this.chatWatchKey(a); this.loadChat(cx3, true); }
        if (eff === "blocked") this.unblockedAt = null;
        else if (wasBlocked && eff) { this.unblockedAt = Date.now(); if (props()?.role === "chat-body") this.traceChat({ ev: "unblocked", id, status: eff, headerStatus: a?.status ?? null, since: a?.since ?? null }); }
        if (this.unblockedAt && (this.chatDataFrom ?? 0) < this.unblockedAt && props()?.role === "chat-body" && !this.chat?.busy) { this.traceChat({ ev: "reread", id, afterMs: Date.now() - this.unblockedAt }); this.chatKey = this.chatWatchKey(a); this.loadChat(cx3, true); } }
      const ws = a ? (this.missGraceOver(true), `${a.id}|${(() => { try { return this.liveOf(a)?.status ?? ""; } catch { return ""; } })()}|${(shared("hakoniwa.seenstate") ?? {})[a.id]?.status ?? ""}|${(shared("hakoniwa.apanswered") ?? {})[a.id]?.at ?? ""}|${a.status === "blocked"}`) : (id ? `miss|${this.missGraceOver(false)}` : null); // 33rd 32-Z1: redraw once more when the grace for a not-yet-found person ends
      if (changed || ws !== this.waitSeen) { this.waitSeen = ws; cx3.notify(); }
    } catch {} }); });
    // ★111 Y1 (office-fix8a): the window's conversation (chat-body) was read once at start and never again, so the 2nd and later turns never showed (only the
    // region's rchat watched the person's state). Here: read again when the person's id|status|since changes (a new turn / answer), and every ~5s while
    // the person is working (a long turn adds lines without a state change). Quiet: the old lines stay on screen, no "読み込み中" flash.
    if (props()?.role === "chat-body") this.watchChat(cx);
  }

  // 33rd 32-Z1: a window opened again at a change of state has not read the list for its first ~1.5 s, so the person is "not found" at first. MISS_GRACE ms of that are drawn blank (no reason, no id);
  // only a person still missing after it gets the reason. found = true resets the clock.
  missGraceOver(found) { if (found) { this.missAt = null; return false; } if (this.missAt == null) { this.missAt = Date.now(); try { const p = this.bodyProps?.() ?? props(); this.rightDiag("person-miss", { role: p?.role ?? null, id: p?.id ?? null, ap: p?.ap ?? null, apH: p?.apH ?? null }); } catch {} } return Date.now() - this.missAt >= MISS_GRACE; }
  chatYoung() { return props()?.role === "chat-body" && Date.now() - (this.chatStartAt ?? 0) < YOUNG_MS; } // 43rd 41-I4 (detail.js)
  effBlocked(id) { try { const a = id ? this.items().find((x) => x.id === id) : null; return !!a && (this.liveOf(a)?.status ?? a.status) === "blocked"; } catch { return false; } }
  chatWatchKey(a) { return a ? `${a.id}|${a.status}|${a.since}` : null; }
  // 25th R1 (office-fix30a): the values of every decision below go to hakoniwa-office/chat-watch.json (the last 60: time, id, status, since, key, changed / poll / busy, and what each read
  // returned), so a missed refresh can be read from the file. Found in the code: a waiting person's conversation is a screen copy drawn from its top in a plain scroll, so a 2nd turn
  // sat below the window while the state key had changed correctly (detail.js fitScreen now keeps the newest lines).
  traceChat(ev) {
    try {
      this.chatTrace = [...(this.chatTrace ?? []), { t: new Date().toISOString().slice(11, 23), role: props()?.role ?? null, ...ev }].slice(-60);
      const path = `${appHome()}/hakoniwa-office/chat-watch.json`, text = JSON.stringify(this.chatTrace, null, 1);
      readTextFile(path).catch(() => null).then((prev) => writeTextFile(path, text, prev)).catch(() => {});
    } catch {}
  }
  // The window's conversation is read again when the person's id|status|since changes, and every ~4.5 s while the person works OR waits for approval (a screen read at the moment the
  // state flips can come before the dialog is drawn). A read that has been "busy" for over 20 s is taken as lost (a hung read must not stop every later one).
  chatPollNow(a, tick) { return !!a && (a.status === "working" || a.status === "blocked") && tick % 3 === 0; }
  watchChat(cx) {
    this.chatTick = 0;
    cx.timer.every(1500, (cx2) => {
      const id = (this.bodyProps?.() ?? props())?.id, a = id ? this.items().find((x) => x.id === id) : null, k = this.chatWatchKey(a);
      if (!k) return;
      this.chatTick = (this.chatTick ?? 0) + 1;
      const changed = k !== this.chatKey, poll = this.chatPollNow(a, this.chatTick), stuck = !!this.chat?.busy && Date.now() - (this.chatBusyAt ?? 0) > 20000, busy = !!this.chat?.busy && !stuck;
      if (changed || stuck || (poll && busy)) this.traceChat({ ev: "tick", id, status: a.status, since: a.since, key: k, prevKey: this.chatKey ?? null, changed, poll, busy, stuck });
      if ((changed || poll) && !busy) { this.chatKey = k; this.loadChat(cx2, true); }
    });
  }

  async loadChat(cx, quiet = false) {
    const c = this.feed.config, p = (this.bodyProps?.() ?? props());
    if (!c) { this.chat = { loading: false, data: { error: this.feed.error } }; cx.notify(); return; }
    const prev = this.chat?.data ?? null;
    this.chat = { loading: !quiet || !prev, data: prev, busy: true }; this.chatBusyAt = Date.now();
    if (!quiet || !prev) cx.notify();
    const t0 = Date.now(), blk0 = this.effBlocked(p.id); // 40th 38-F2: when this read STARTED (a read begun before a rejection can still return the dialog)
    try {
      const r = await exec(c.python, [c.collector, "--conversation", p.id, "--limit", "60"]);
      this.chat = { loading: false, data: r.code ? { error: (r.stderr || "").trim().split("\n").pop() } : JSON.parse(r.stdout), at: Date.now() };
      if (!r.code) this.chatDataFrom = t0;
      if (!r.code && props()?.role === "chat-body") { try { setShared("hakoniwa.chatcache", { id: p.id, data: this.chat.data, at: this.chat.at, st: (blk0 || this.effBlocked(p.id)) ? "blocked" : "other" }); } catch {} } // 34-B4: read by initChat of the next copy of this window
    } catch (e) { this.chat = { loading: false, data: { error: String(e) } }; }
    if (props()?.role === "chat-body") { const d = this.chat?.data, sl = String(d?.screen ?? "").split(/\r?\n/).filter((x) => x.trim()); this.traceChat({ ev: "loaded", id: p?.id, quiet, kind: d?.kind ?? null, msgs: d?.messages?.length ?? 0, screenLines: sl.length, lastLine: String(sl[sl.length - 1] ?? "").slice(0, 60), error: d?.error ? String(d.error).slice(0, 80) : null }); }
    cx.notify();
  }

  chatView() {
    const p = props(), d = this.chat?.data, room = ROOM[p.source] ?? { title: p.source, color: P.muted };
    const btn = (id, label, fn) => div().id(id).flex_none().px(9).py(4).rounded(5).border(1).border_color(P.line)
      .bg(P.white).text_size(11).text_color(P.ink).cursor_pointer().hover((s) => s.bg("#f1f3f6")).on_click(fn).child(label);
    const head = h_flex().flex_none().h(46).px(14).gap(8).items_center().bg("#fafbfc").border_b(1).border_color(P.line)
      .child(badge(room.title, room.color, true))
      .child(platformIcon(p, 14))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_weight(700).text_color(P.ink).truncate().child(p.name ?? p.id))
        .child(h_flex().gap(4).items_center().child(chip(p.color ?? P.muted, 8))
          .child(div().text_size(10).text_color(P.muted).child(p.model ?? "モデル不明"))))
      .child(btn("chat-reload", "再読込", (_e, cx) => cx.spawn(async (cx) => this.loadChat(cx))))
      .when(p.source === "app", (el) => el.child(btn("chat-open", "端末を開く", () => run("agent.focus", { terminal: p.address }))))
      .child(btn("chat-close", "閉じる", () => closeOverlay(p.overlay)));
    let body;
    if (this.chat?.loading && !d) body = div().p(16).text_size(12).text_color(P.muted).child("読み込み中…");
    else if (d?.error && !(d.messages?.length || d.screen)) body = div().p(16).text_size(12).text_color("#d6455d").child(String(d.error ?? ""));
    else if (d?.kind === "screen") body = div().p(12).text_size(11).text_color(P.ink)
      .font_family(settings().font_family ?? "Consolas").child(String(stripTerminalFrame(d.screen).text || "（画面が空です）")); // 28th 27-U1/U2
    else body = v_flex().gap(8).p(12).children((d?.messages ?? []).slice().reverse().map((m, i) => this.message(m, i)));
    return v_flex().id("chat-root").size_full().bg(P.white)
      .child(head)
      .child(div().flex_none().px(14).py(4).text_size(10).text_color(P.muted).bg("#fcfcfd").border_b(1).border_color(P.line)
        .child(d?.kind === "screen" ? "会話の記録が無いため、端末の画面を表示しています" : "新しい順（上が最新）"))
      .child(div().id("chat-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }

  // 10th A2: the shared "hakoniwa.termBox" is the OUTER box of the right column (its left edge is what the popups keep clear of). Region mode never wrote it, and the value
  // is persisted, so the old window mode's x (1152 = 1920-768) stayed while the region really starts at 1110 (= 1920-810). Region mode publishes its own box here (this.termBox stays null:
  // the floor already ends where the region starts). The plan's width is `hakoniwa.rsel`.w; the window's width is the office copy's viewport. The numbers are also written to
  // hakoniwa-office/right-edge-diag.json (when they change) so a wrong edge can be traced.
  shareRegionBox() {
    const vp = vpSize() ?? (shared("hakoniwa.win")?.w > 0 ? { width: shared("hakoniwa.win").w, height: shared("hakoniwa.win").h } : null);
    const rs = shared("hakoniwa.rsel"), w = this.regionShown && rs?.w > 0 ? Math.round(rs.w) : 0, vw = vp?.width > 0 ? Math.round(vp.width) : 0, vh = vp?.height > 0 ? Math.round(vp.height) : 0;
    const box = w && vw > w ? { x: vw - w, y: 60, w, h: Math.max(120, vh - 60) } : null;
    const sig = box ? `${box.x}|${box.y}|${box.w}|${box.h}` : "-";
    if (this.regionBoxSig === sig) return;
    this.regionBoxSig = sig;
    this.rightDiag("region", { regionW: w || null, box });
    setShared("hakoniwa.termBox", box);
  }

  // 13th B6: one place that writes the numbers behind the right window's place (hakoniwa-office/right-edge-diag.json; only when they change). Written from the window path too
  // (right-region.json is off, so shareRegionBox never ran and the file was never made). `placedAt` = the position asked for; `savedAt` = the time of the save (diagWrite).
  rightDiag(mode, extra = {}) {
    try {
      this.diagWrite?.("right-edge-diag", { mode, viewport: (() => { const v = vpSize(); return v ? { w: Math.round(v.width), h: Math.round(v.height) } : null; })(), win: shared("hakoniwa.win") ?? null,
        office: this.left ? { w: Math.round(this.left.width), h: Math.round(this.left.height) } : null, rightW: this.rightW ?? null, rsel: shared("hakoniwa.rsel") ?? null,
        termBox: this.termBox ?? null, sharedTermBox: shared("hakoniwa.termBox") ?? null, rwin: shared("hakoniwa.rwin") ?? null, ...extra });
    } catch {}
  }

  // 12th C3: the place a popup (受け箱 `inbox` / 使用量 `usage`) was asked for, next to the window's left edge it keeps clear of: `popup.right` must be <= `windowLeft - RIGHT_POP_GAP`.
  popupDiag(kind, at, width) {
    try {
      const wl = this.rightLeft?.() ?? null;
      this.rightDiag(`popup-${kind}`, { popup: { kind, at: at ?? null, width, right: at ? Math.round(at.x + width) : null }, windowLeft: wl, frame: RIGHT_WIN_FRAME });
    } catch {}
  }

  // 13th B1/B2: the right window's own copy (chat-body / chat-input blocks, called from render in detail.js) reports the size and place the App really gave it
  // (`hakoniwa.rwin`: viewport w/h + window.bounds()). The office copy compares it with what was asked for (measuredBox) and the diag file keeps both.
  probeRightWin() {
    const vp = vpSize(); if (!vp) return;
    const b = winBounds(), w = Math.round(vp.width), h = Math.round(vp.height), sig = `${w}x${h}|${b ? `${b.x},${b.y},${b.w},${b.h}` : "-"}`;
    if (this.rwinSig === sig) return;
    this.rwinSig = sig;
    setShared("hakoniwa.rwin", { w, h, bounds: b, role: props()?.role ?? null, at: Date.now() });
  }

  // 20th H1: the size of the conversation area of the right window = the window (termBox, as asked) minus the blocks around it (head + tabs, the refresh row, the approval block, the input).
  // viewport_size() is the whole App window (not this block), so it is not used. null = the window's box is not known: the caller draws everything (the old plain scroll).
  convBox(a) {
    const tb = this.termBox ?? shared("hakoniwa.termBox"); if (!(tb?.w > 0) || !(tb?.h > 0)) return null;
    // 33rd 32-Z1: a = the stand-in detail.js makes for a window just opened for a waiting person (fromProps: the list is not read yet): the block's height is the window's own apH
    const ap = a?.status === "blocked" ? (a.fromProps ? Number(a.apH) : approveHeight(blockedText(a), tb.w)) + APPROVE_GAP : 0;
    return { w: tb.w, h: Math.max(0, tb.h - headHeight(tb.w) - CONV.headRow - ap - CONV.input - (a?.status === "blocked" ? COMPOSER_HINT : 0)) };
  }
  // 20th H1: how many more screens the "前の発言" row went back for this person (a new person starts at 0).
  fitConv(msgs, a) { const bx = this.convBox(a); return bx ? fitConversation(msgs, bx.w, bx.h, this.convBackOf(a?.id)) : { msgs, hidden: 0, partial: false }; } // (detail.js calls this: it does not import chat.js, which imports detail.js)
  // 25th R1: the newest lines of a screen copy that fit the window (detail.js chatBodyView). `cut` = the dialog was cut (a pale line "下のカードで答えてください" sits below: 30 px).
  fitScreen(text, a, cut) { const bx = this.convBox(a); return bx ? fitScreenLines(text, bx.w, bx.h - (typeof cut === "number" ? cut : cut ? 30 : 0), this.convBackOf(a?.id)) : { text, hidden: 0 }; }
  convBackMore(id) { this.convBack = this.convBackOf(id) + 1; } // 21st I5: one more screen (the 「↑ 前の発言を読む」 press, and the review command hakoniwa.convback)
  convBackOf(id) { if (this.convBackId !== id) { this.convBackId = id; this.convBack = 0; } return this.convBack ?? 0; }

  // 34th 33-A4: the approval block's height for one waiting episode (same person, same width) only grows: a shorter ask later does not change the window's key. null = the episode ended.
  // 39th 37-E2 (office-fix44a): the block's height comes from what the card really is NOW: the larger of the estimate (approveHeight) and the card's own measured height (shared "hakoniwa.apmeasure".card,
  // written by detail.js apMeasure) when that was measured in the last 15 s. apHold still keeps the larger and the re-open cap (APH_REOPEN_MAX) is unchanged, so a 2nd card with more lines than the 1st
  // grows the block (at most twice) instead of keeping the 1st card's height and cutting the line under the buttons.
  apNeed(want, W) {
    const est = approveHeight(blockedText(want), W);
    try { const m = (shared("hakoniwa.apmeasure") ?? {}).card; if (m && Number.isFinite(m.h) && m.h > 0 && Date.now() - (m.at ?? 0) < 15000 && m.w > 0 && Math.abs(m.w - (W - 28)) < 40) return Math.max(est, Math.ceil(m.h) + 2); } catch {}
    return est;
  }
  apHold(id, W, h) { if (id == null) { this.apKeep = null; return 0; } const k = this.apKeep; if (k && k.id === id && k.W === W) { if (h > k.h) k.h = h; return k.h; } this.apKeep = { id, W, h }; return h; }

  // 13th B2: the left edge popups keep clear of is the window's real edge. When the window's own copy reported a plausible size (a whole window: tall, not wider than 70% of the
  // office window) and the office window's width is known, the attached window starts at (office window width - its real width); termBox follows (rightTaken() uses its w too).
  measuredBox() {
    const m = shared("hakoniwa.rwin"), win = shared("hakoniwa.win"), tb = this.termBox;
    if (!tb || this.rightCollapsed || !(win?.w > 0) || !(m?.w >= 300) || !(m?.h >= 300) || m.w > win.w * 0.7) return;
    const x = Math.round(win.w - m.w), nb = { ...tb, x, w: Math.round(m.w), frame: 0 }; // 12th C3: a measured x is the real edge (no frame)
    if (nb.x === tb.x && nb.w === tb.w && !tb.frame) return;
    this.rightDiag("window-measured", { requested: { x: tb.x, w: tb.w }, measured: { x, w: nb.w } });
    this.termBox = nb; setShared("hakoniwa.termBox", nb);
  }

  // The chosen App agent's own terminal, in a window at the right of the Office (an App agent only: `{ terminal: address }` is a herdr-core terminal).
  syncTerm(sel, list, left, cx) {
    const a = sel && list.find((x) => x.id === sel), want = a && this.open && a.source === "app" && a.address && !(shared("hakoniwa.demo") || this.feed.config?.demo) ? a : null;
    if (want) this.termPick = null; // ★72-3: choosing a person ends a terminal picked from the left list
    const pick = !want && this.termPick?.address && !(shared("hakoniwa.demo") || this.feed.config?.demo) ? this.termPick : null;
    this.publishWin?.(); // 10th A3: the window's size for the other copies (feed.js winSize)
    this.apTrack(want, cx); // 46th 44-L1 (office-fix51a): when the office copy learns the shown person waits, and the 0.5 s watch that redraws it at once
    if (this.syncRegion?.(want, pick, left, list, cx)) { this.shareRegionBox(); if (this.termKey) { try { closeOverlay(this.termId); } catch {} this.termKey = null; this.termId = null; } return !!(want || pick); } // ★103-3 (office-region103) the real layout region (switch: right-region.json); false = the window below
    this.regionBoxSig = null; // window mode writes the shared box itself; region mode must write again when it returns
    if (pick) { // ★72-3: a terminal picked from the left list (a shell, or an agent's terminal): the real terminal in the same window, no detail part
      const vp0 = vpSize();
      const vw0 = vp0?.width > 0 ? vp0.width : left.width + 268, vh0 = vp0?.height > 0 ? vp0.height : left.height + 60;
      const col0 = !!this.rightCollapsed, b0 = rightOverlayBox(vw0, vh0, 60, col0 ? RIGHT_COLLAPSED_W : (this.rightW ?? Math.round(left.width * 0.46)), this.rightW ? 0.6 : 0.4, RIGHT_EDGE), W0 = col0 ? RIGHT_COLLAPSED_W : b0.width, H0 = Math.min(b0.height, Math.max(240, Math.round(left.height))), sig0 = `pick|${pick.address}|${pick.name ?? ""}|${W0}|${col0}`; // ★103-3 attached to the right edge; ★103-4 the folded strip
      if (this.termKey === sig0) { this.measuredBox(); return true; }
      try {
        this.termId = openOverlay({ kind: "window", key: "hakoniwa-term", width: W0, height: H0, at: { x: col0 ? b0.x + b0.width - W0 : b0.x, y: b0.y }, layout: col0 ? { type: "block", content: { mod: "hakoniwa", props: { role: "detail", collapsed: true, name: pick.name ?? pick.address } } } : { type: "column", children: [
          { type: "block", size: { px: 52 }, content: { mod: "hakoniwa", props: { role: "pick-head", name: pick.name ?? pick.address } } }, // ★81 a thin head: name, シェル, 折りたたむ, × 閉じる (★103-4: 52px, buttons 32px+)
          { type: "block", content: { terminal: pick.address } }] } });
        this.termKey = sig0; this.termBox = { x: col0 ? b0.x + b0.width - W0 : b0.x, y: b0.y, w: W0, h: H0, frame: RIGHT_WIN_FRAME }; setShared("hakoniwa.termBox", this.termBox); return true;
      } catch (e) { this.termKey = null; this.termFail = String(e); this.termPick = null; return false; }
    }
    if (!want) {
      if (this.termKey) { try { closeOverlay(this.termId); } catch {} this.termKey = null; this.termId = null; }
      this.termBox = null; setShared("hakoniwa.termBox", null); this.apKeep = null;
      return false;
    }
    const vp = vpSize();
    const vw = vp?.width > 0 ? vp.width : left.width + 268, vh = vp?.height > 0 ? vp.height : left.height + 60; // the window's real size (the office's own size + the sidebar only as a fallback)
    const colW = !!this.rightCollapsed, bx = rightOverlayBox(vw, vh, 60, colW ? RIGHT_COLLAPSED_W : (this.rightW ?? Math.round(left.width * 0.46)), this.rightW ? 0.6 : 0.4, RIGHT_EDGE), W = colW ? RIGHT_COLLAPSED_W : bx.width, H = Math.min(bx.height, Math.max(240, Math.round(left.height))); // ★103-3 attached; ★103-4 folded
    if (this.detailTabFor !== want.id) { this.detailTabFor = want.id; this.detailTab = "chat"; } // ★84 another person: the first tab again; ★106 V1: the conversation
    const kidsN = this.familyRows(want, list).length - 1, tab = tabFor(this.detailTab, true, kidsN), topH = headHeight(W), ap = tab === "chat" && want.status === "blocked", apH = ap ? this.apHold(want.id, W, this.apNeed(want, W)) : (this.apHold(null), 0), sig = `${want.id}|${want.address}|${topH}|${tab}|${W}|${colW}|${ap ? "ap" + apH : ""}`; // 13th D1: ap = a person waiting for approval gets a card block above the input (the window is opened again when it starts / ends) // ★84 the head is a fixed height from the width; the tab is in the key (the window is opened again)
    if (this.termKey === sig) { this.measuredBox(); return true; }
    // 34th 33-A4 (office-fix39b): what changed in the key at each re-open is written to right-edge-diag.json ("window-reopen": n, changed, from, to). An apH-only change while the card is
    // already there (the ask text got longer) re-opens at most APH_REOPEN_MAX times per waiting episode (the window vanishes for a frame each time); a shrink never re-opens (apHold keeps the larger).
    const parts = { id: want.id, address: want.address ?? null, topH, tab, W, colW, ap: ap ? 1 : 0, apH }, prev = this.termParts?.key === this.termKey ? this.termParts : null;
    if (prev) {
      const changed = Object.keys(parts).filter((k) => parts[k] !== prev[k]);
      if (changed.length === 1 && changed[0] === "apH" && ap && prev.ap === 1) { if ((this.apReopenN ?? 0) >= APH_REOPEN_MAX) { this.measuredBox(); return true; } this.apReopenN = (this.apReopenN ?? 0) + 1; }
      else if (changed.includes("ap")) this.apReopenN = 0;
      this.reopenN = (this.reopenN ?? 0) + 1;
      const from = {}, to = {}; for (const k of changed) { from[k] = prev[k]; to[k] = parts[k]; }
      this.rightDiag("window-reopen", { reopen: { n: this.reopenN, apReopenN: this.apReopenN ?? 0, changed, from, to } });
      if (changed.includes("ap") || changed.includes("apH")) this.traceApprove?.({ ev: "sync-reopen", id: want.id, changed, ap: parts.ap, apH: parts.apH, status: want.status, since: want.since ?? null }); // 46th 44-L1
    } else { this.apReopenN = 0; this.reopenN = 0; if (ap) this.traceApprove?.({ ev: "sync-open", id: want.id, ap: 1, apH, status: want.status, since: want.since ?? null }); } // 46th 44-L1: a window first opened for a person who already waits
    try {
      this.termId = openOverlay({ kind: "window", key: "hakoniwa-term", width: W, height: H, at: { x: colW ? bx.x + bx.width - W : bx.x, y: bx.y },
        layout: colW ? { type: "block", content: { mod: "hakoniwa", props: { role: "detail", collapsed: true, id: want.id, name: want.name, face: this.faceFile(want) ?? null } } } : { type: "column", children: [
          { type: "block", size: { px: topH }, content: { mod: "hakoniwa", props: { role: "detail", paneH: H, paneW: W, tab, id: want.id, name: want.name, color: want.color, face: this.faceFile(want) ?? null } } }, // the head + tabs
          { type: "block", content: tab === "terminal" ? { terminal: want.address } : { mod: "hakoniwa", props: { role: tab === "chat" ? "chat-body" : "tree-body", id: want.id, name: want.name ?? "", source: want.source, ap: ap ? 1 : 0, apH } } }, // 33rd 32-Z1: ap / apH = the approval block is in this window (a copy that has not read the list yet sizes itself by them)
          ...(ap ? [{ type: "block", size: { px: apH + APPROVE_GAP }, content: { mod: "hakoniwa", props: { role: "chat-approve", id: want.id, name: want.name ?? "", source: want.source, ap: 1 } } }] : []), // 17c: the one approval block; its height carries the blank strip above the card (detail.js approveBlockView pt), no second block
          ...(tab === "chat" ? [{ type: "block", size: { px: 72 + (ap ? COMPOSER_HINT : 0) }, content: { mod: "hakoniwa", props: { role: "chat-input", id: want.id, name: want.name ?? "", source: want.source, address: want.address ?? null, ap: ap ? 1 : 0 } } }] : [])] } }); // the body: the real terminal, or the conversation / tree; X1 (★108): the input is a block of its own (a fixed 72px at the window's bottom), not a flex child that may be pushed out
      this.termKey = sig; this.termParts = { key: sig, ...parts }; this.termBox = { x: colW ? bx.x + bx.width - W : bx.x, y: bx.y, w: W, h: H, frame: RIGHT_WIN_FRAME }; setShared("hakoniwa.termBox", this.termBox); // ★37-1 where the window is (the wheel over it is the window's); 12th C3: x is the x ASKED; the real left edge is x - frame
      this.rightDiag("window-open", { requested: { width: W, height: H, at: { x: this.termBox.x, y: bx.y } }, windowLeft: this.termBox.x - RIGHT_WIN_FRAME, frame: RIGHT_WIN_FRAME, vp: { w: vw, h: vh }, usedFallbackSize: !(vp?.width > 0) });
      return true;
    } catch (e) { this.termKey = null; this.termFail = String(e); return false; }
  }

  // 46th 44-L1 (office-fix51a): the window's pieces were made +0.05..3.2 s after the state said "blocked" (44th: +3.1, +1.25, +0.05, +3.2, +1.44), so 3 of 5 times the buttons were not there before a person answered.
  // The window is made again by syncTerm (the key gets "ap"), which runs only when the office draws. Two things here: (1) apTrack writes to approve-trace.json when this copy first saw the shown person's state change
  // (ev "sync-status": from / to, via = select | list | watch | live: what drew) and when it made the window again (ev "sync-reopen" / "sync-open", chat.js syncTerm); (2) a 0.5 s watch of the shown App person only
  // (never the others) asks for one more draw the moment "waiting or not" differs from what the last draw saw, so the window is not left to the next draw of the list (4 s collector / 1.5 s state file).
  apTrack(want, cx) {
    try {
      const tr = (this.apSeen ??= { id: null, st: null, feed: null, pending: null }), id = want?.id ?? null, st = want?.status ?? null;
      if (id !== tr.id || st !== tr.st) {
        const same = id !== null && id === tr.id, via = !same ? "select" : this.apWatchHit ? "watch" : this.feed?.text !== tr.feed ? "list" : "live";
        if (want && (st === "blocked" || (same && tr.st === "blocked"))) this.traceApprove?.({ ev: "sync-status", id, from: same ? tr.st : null, to: st, via, since: want.since ?? null });
        tr.id = id; tr.st = st;
      }
      tr.feed = this.feed?.text; tr.pending = null; this.apWatchHit = false;
      if (want && !this.apWatchTimer && cx?.timer?.every) this.apWatchTimer = cx.timer.every(500, (c) => this.apWatchTick(c));
    } catch {}
  }
  apWatchTick(c) {
    try {
      if (this.retired) { try { this.apWatchTimer?.cancel?.(); } catch {} this.apWatchTimer = null; return; }
      const tr = this.apSeen, id = tr?.id; if (id == null || !this.open || this.demo?.()) return;
      const blocked = this.items().find((x) => x.id === id)?.status === "blocked";
      if (blocked === (tr.st === "blocked") || tr.pending === blocked) return;
      tr.pending = blocked; this.apWatchHit = true; c.notify(); // one draw per change (the next draw clears pending)
    } catch {}
  }

  // ---- Office side panel (right of the floor): the chosen session's conversation.
  // Reloads when the session changes, or when its state changes (a new turn / answer).
  syncPanel(id, list, cx) {
    // The panel is first drawn off-screen, then moved in on the next frame: so "left" really animates.
    if (!this.panelShown && !this.panelArming) {
      this.panelArming = true;
      cx.timer.after(60, (cx) => { this.panelArming = false; this.panelShown = true; cx.notify(); });
    }
    const a = list.find((x) => x.id === id);
    if (!a) { this.panel = null; return; }
    const sig = `${a.id}|${a.status}|${a.since}`;
    if (this.panel?.sig === sig || this.panel?.loading || !this.feed.config) return;
    if (shared("hakoniwa.demo") || this.feed.config?.demo) { // demo: nothing to read
      const now = Date.now(), nm = a.name || "作業";
      const min = (n) => now - n * 60000;
      const rows = [{ role: "user", at: min(12), text: `「${nm}」を進めてください` },
        { role: "assistant", at: min(11), text: "まず関連するファイルを確認します。" },
        { role: "tool", at: min(10), text: "関連ファイルを確認" }];
      if (a.status === "blocked") rows.push({ role: "assistant", at: min(4), text: `次の操作を実行してよいですか: ${a.blocked_msg || "確認が必要です"}` });
      else if (a.status === "done") rows.push({ role: "tool", at: min(3), text: "テストを実行" }, { role: "assistant", at: min(2), text: "作業が終わりました。結果を報告します。" });
      else if (a.status === "working") rows.push({ role: "assistant", at: min(5), text: "修正を進めています。終わったらテストを流します。" }, { role: "tool", at: min(2), text: "ファイルを編集" });
      else rows.push({ role: "assistant", at: min(6), text: "完了しました。次の指示を待っています。" });
      this.panel = { sig, id: a.id, loading: false, data: { messages: rows } }; // a made-up conversation that fits this agent
      return;
    }
    this.panel = { sig, id: a.id, loading: true, data: this.panel?.id === a.id ? this.panel.data : null };
    this.loadPanel(a, cx);
  }

  loadPanel(a, cx) {
    const c = this.feed.config;
    const sig = this.panel?.sig ?? `${a.id}|${a.status}|${a.since}`;
    this.panel = { ...(this.panel ?? {}), sig, id: a.id, loading: true };
    cx.spawn(async (cx) => {
      let data;
      try {
        const r = await exec(c.python, [c.collector, "--conversation", a.id, "--limit", "60"]);
        data = r.code ? { error: (r.stderr || "").trim().split("\n").pop() } : JSON.parse(r.stdout);
      } catch (e) { data = { error: String(e) }; }
      if (this.panel?.id === a.id) this.panel = { ...this.panel, loading: false, data };
      cx.notify();
    });
  }

  // The face: the top of the person's standing picture, cropped to a square. `file` is given where the scene is not at hand (the detail window).
  faceFile(a) {
    let f = this.scene?.people?.[a.id]?.stand ?? this.scene?.people?.[a.id]?.sit;
    if (Array.isArray(f)) f = f[0];
    return f;
  }
  face(a, size, file) {
    const f = file ?? this.faceFile(a);
    const box = div().flex_none().w(size).h(size).rounded(10).overflow_hidden().relative().bg("#EDE6D8");
    if (!f) return box.flex().items_center().justify_center().child(platformIcon(a, Math.round(size * 0.5))); // no picture yet: the program's icon, not an empty square
    const w = size * 1.9;
    return box.child(image(f).absolute().left((size - w) / 2).top(-size * 0.08).w(w).h(w * 1.56));
  }

  // The family tree rows: the top ancestor, then everyone below (indented). [[agent, depth]]
  familyRows(a, list) {
    const byId = new Map(list.map((x) => [x.id, x])); let root = a, guard = 0;
    while (root.parent_id && byId.has(root.parent_id) && guard++ < 12) root = byId.get(root.parent_id);
    const rows = []; const walk = (n, depth, seen) => { rows.push([n, depth]); for (const k of list.filter((x) => x.parent_id === n.id && !seen.has(x.id)).sort((m, o) => (m.since ?? 0) - (o.since ?? 0))) walk(k, depth + 1, new Set([...seen, k.id])); };
    walk(root, 0, new Set([root.id]));
    return rows;
  }

  // Ask whether to end an agent (and its children): a dialog with a question, "はい" and "いいえ". Nothing is ended before "はい".
  askEnd(a, list) {
    const q = endQuestion(a, list);
    openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 440, height: q.strong ? 270 : 220,
      props: { role: "confirm", id: a.id, name: a.name ?? a.address, address: a.address, source: a.source, text: q.text, strong: q.strong } });
  }

  // ★30-7: run the chosen App operation; a failure stays on this agent's card (no error window).
  doAgentOps(a, ops, cx) {
    cx.spawn(async (cx) => {
      const r = await runAgentOps(run, ops);
      this.opError = r.ok ? null : { id: a.id, text: r.error };
      cx.notify();
    });
  }

  // Role "detail": the mod part of the window that holds an App agent's real terminal (the terminal itself is the block below it).
  detailView() {
    const p = props(), list = this.items(), a = list.find((x) => x.id === p.id);
    const slide = { select: (n) => setShared("hakoniwa.pick", { state: n.status, id: n.id, at: Date.now() }), close: () => { setShared("hakoniwa.close", { at: Date.now() }); closeOverlay(p.overlay); },
      collapse: (on) => setShared("hakoniwa.rcollapse", { on: !!on, at: Date.now() }) }; // ★103-4 the folded strip / back (the office instance reads it)
    if (p.collapsed) return this.collapsedStrip(a, p, slide);
    // 45th 43-K1 (office-fix50a): a window made again at a change of state (the approval asked / answered) is a new copy that has not read the list, or lost the person for a moment: its head said 「このエージェントは見つかりません」
    // for that moment. Same grace as the input (MISS_GRACE): blank (or 「読み込み中…」 while the list is empty) first, the reason only for a person still missing after it. Logged (approve-trace.json: detail-miss).
    if (!a) {
      this.detMissAt ??= Date.now();
      if (!this.detMissLogged) { this.detMissLogged = true; try { this.traceApprove?.({ ev: "detail-miss", id: p.id ?? null, n: list.length, ids: list.map((x) => x.id).slice(0, 8), live: list.filter((x) => x.live).length, feedLoaded: !!this.feed?.state, name: p.name ?? null }); } catch {} } // 46th 44-L3: the id looked for next to the ids of the list (feedLoaded = the collector's state is read in this copy; live = rows of the live overlay)
      const over = Date.now() - this.detMissAt >= MISS_GRACE;
      return v_flex().size_full().bg(P.paper).child(over ? div().p(16).text_size(14).text_color(P.muted).child("このエージェントは見つかりません") : list.length ? div() : div().p(16).text_size(14).text_color(P.muted).child("読み込み中…"));
    }
    this.detMissAt = null; this.detMissLogged = false;
    const tab = tabFor(p.tab, true, this.familyRows(a, list).length - 1); // ★84 head + tabs; the body under it is the window's next block
    // ★103-3 (2nd) a press on the head never drags the window (attached). ★105 N6: this comment sat after the call on the same line and swallowed `.children(...)`: the head was empty
    return v_flex().id("detail-root").size_full().overflow_hidden().bg(P.paper).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).children(this.detailHead(a, list, slide, { width: p.paneW, tab, hasTerminal: true, face: p.face, onTab: (k) => setShared("hakoniwa.tab", { id: a.id, tab: k, at: Date.now() }) }));
  }

  // ★81 Role "pick-head": the thin head over a shell picked from the left list. "× 閉じる" asks the office to drop the pick (hakoniwa.close).
  pickHeadView(pp) {
    const p = pp ?? props();
    // ★103-3 (2nd) a press on the head never drags the window (attached). ★105 N6: the same swallowed-by-comment slip (the border was lost)
    return h_flex().id("pick-head-root").size_full().px(14).gap(10).items_center().bg(P.paper).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).border_b(1).border_color(P.line)
      .child(div().flex_1().min_w(0).truncate().text_size(16).font_weight(700).text_color(P.ink).child(p.name ?? ""))
      .child(div().flex_none().px(8).py(3).rounded(6).bg("#e7e5df").text_size(13).font_weight(700).text_color("#7a766b").child("シェル"))
      .child(iconBtn("pick-fold", "right", () => setShared("hakoniwa.rcollapse", { on: true, at: Date.now() }), { size: 36, isize: 20 })) // ★103-4 fold to the edge
      .child(iconBtn("pick-close", "x", () => { setShared("hakoniwa.close", { at: Date.now() }); }, { size: 36, isize: 20 })); // ★104 U13: × as an icon, like the agent head
  }

  // ★103-4 the right window folded to a thin strip at the right edge: an arrow that opens it again, the face, and × (all 36px+ to press).
  collapsedStrip(a, p, slide) {
    // ★103-3 (2nd) a press on the head never drags the window (attached). ★105 N6: the same swallowed-by-comment slip (the border was lost)
    return v_flex().id("detail-folded").size_full().items_center().py(10).gap(12).bg(P.paper).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).border_l(1).border_color(P.line)
      .child(iconBtn("unfold-btn", "left", () => slide.collapse(false), { size: 36, isize: 20 }))
      .child(div().flex_none().text_size(14).text_color(P.muted).child("開く")) // ★104 U2: the arrow alone does not say what it does
      .child(a ? this.face(a, 32, p.face) : div().flex_none().w(32).h(32).rounded(8).bg("#e7e5df"))
      .child(iconBtn("folded-close", "x", (cx) => slide.close(cx), { size: 36, isize: 20 }));
  }

  // Role "confirm": the question before an agent is ended. Only "はい" calls the App.
  confirmView() {
    const p = props(), btn = (id, label, fn, color, fill) => div().id(id).flex_none().px(16).py(8).rounded(8).border(1).border_color(color).bg(fill ?? P.white)
      .text_size(13).font_weight(700).text_color(fill ? "#ffffff" : color).cursor_pointer().hover((s) => s.opacity(0.85)).on_click(fn).child(label);
    const yes = () => { if (p.action) this.confirmYes(p); else endAgent(run, { address: p.address, source: p.source }, true); closeOverlay(p.overlay); }; // ★61-1 room-close / stop: room.js
    return v_flex().id("confirm-root").size_full().p(18).gap(14).bg(P.paper).overflow_hidden() // ★95-7: a long question scrolls; the buttons stay
      .child(div().flex_none().text_size(15).font_weight(700).text_color(P.ink).child(p.title ?? "セッションを終える"))
      .child(div().id("confirm-scroll").flex_1().min_h(0).overflow_y_scrollbar().text_size(13).text_color(p.strong ? "#b3261e" : P.ink).child(String(p.text ?? "")))
      .child(h_flex().flex_none().gap(10).justify_end()
        .child(btn("confirm-no", "いいえ", () => closeOverlay(p.overlay), P.line))
        .child(btn("confirm-yes", p.yes ?? "はい、終える", yes, "#d6455d", "#d6455d")));
  }

  // `slide`: { width (the Office's width), open, close() }. The panel is an overlay that slides in from the right.
  // An App agent with a real terminal never comes here (its column is the "detail" window); everybody else gets the same column with the record in place of the terminal.
  chatPanel(id, list, slide) {
    const a = list.find((x) => x.id === id), W = Math.min(Math.round(slide.width * 0.4), Math.max(280, Math.round(slide.width / 3))); // a third, never over 40%
    if (!slide.open) this.panelShown = false;
    const shown = slide.open && !!this.panelShown;
    const frame = v_flex().id("chat-panel").absolute().top(0).left(shown ? slide.width - W - 8 : slide.width + 12).w(W).h_full().overflow_hidden() // the right edge 8px inside
      .bg(P.paper).border_l(1).border_color(P.line)
      .transition("left", { duration: 240, easing: "ease-out" })
      .on_click((_e, cx) => cx.stop_propagation()) // a click inside is not a click on the empty floor
      .when(!!this.focusH, (el) => el.track_focus(this.focusH)) // the handle exists once something was clicked (render cannot make one)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { slide.close(cx); cx.stop_propagation(); return; }
        if ((e.key === "up" || e.key === "down") && this.treeOrder?.length) { // the family tree: up / down moves the choice (and the office follows)
          const i = this.treeOrder.indexOf(id), j = Math.max(0, Math.min(this.treeOrder.length - 1, i + (e.key === "down" ? 1 : -1))), t = list.find((x) => x.id === this.treeOrder[j]);
          if (t && t.id !== id) slide.select(t, cx); cx.stop_propagation();
        }
      });
    if (!a) return frame.child(h_flex().flex_none().px(16).pt(14).pb(10).items_center().child(div().flex_1().text_size(17).font_weight(700).text_color(P.ink).child("エージェント詳細")));
    const d = this.panel?.id === a.id ? this.panel.data : null, loading = this.panel?.loading, msgs = d?.messages ?? [], plat = platform(a);
    const kidsN = this.familyRows(a, list).length - 1, tab = tabFor(this.detailTab, false, kidsN), rows = this.familyRows(a, list); this.treeOrder = rows.length > 1 ? rows.map(([n]) => n.id) : [];
    const parts = this.detailHead(a, list, slide, { width: W, tab, hasTerminal: false, onTab: (k, cx) => { this.detailTab = k; cx.notify(); } }); // ★84
    const room = Math.max(120, (slide.height ?? 560) - headHeight(W) - 12);
    let body;
    if (loading && !d) body = div().p(12).text_size(12).text_color(P.muted).child("読み込み中…");
    else if (d?.error && !(msgs.length || d.screen)) body = div().p(12).text_size(12).text_color(/デモ/.test(d.error) ? P.muted : "#d6455d").child(String(d.error ?? ""));
    else if (d?.kind === "screen") body = div().p(12).text_size(11).text_color(P.ink)
      .font_family(settings().font_family ?? "Consolas").child(String(stripTerminalFrame(d.screen).text || "（画面が空です）")); // 28th 27-U1/U2
    else if (tab === "tree") body = v_flex().p(10).gap(2).children(rows.map(([n, depth]) => { const ks = stateOf(n), me = n.id === a.id;
      return h_flex().id(`tree-${n.id}`).gap(6).px(6).py(4).items_center().rounded(7).cursor_pointer().hover((e) => e.bg("#f3efe4")).when(me, (e) => e.bg("#e8f0fe")).on_click((_e, cx) => slide.select(n, cx))
        .child(div().flex_none().w(depth * 14)).child(div().flex_none().w(10).text_size(10).text_color(P.muted).child(depth ? "└" : "")).child(dot(ks.color, 8)).child(platformIcon(n, 12))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(me ? 700 : 400).text_color(P.ink).child(String(n.name || n.address || ""))).child(div().flex_none().text_size(10).font_weight(600).text_color(ks.color).child(`${ks.label} ${ago(n.since)}`)); }));
    else body = v_flex().min_h_full().gap(8).px(14).py(6).children(this.messageList(fitTail(msgs, W, room), plat.name, a.status)); // Z7: oldest on top, newest below; a short record packs to the top (fitTail keeps the newest when it is long)
    return frame.children(parts)
      .child(div().id("panel-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(body))
      .when(a.source === "tui", (el) => el.child(v_flex().flex_none().px(14).pt(8).pb(12).gap(4).items_center() // ★74-3: a herdr TUI agent: read here, instruct by herdr agent prompt (no App-only buttons)
        .when(!!a.address, (e2) => e2.child(h_flex().id("panel-tui-send").w_full().h(36).items_center().justify_center().gap(8).rounded(10).bg(P.blue).cursor_pointer()
          .hover((s) => s.bg("#1860c4")).on_click((_e, cx) => { cx.stop_propagation(); this.openTuiPrompt(a); })
          .child(div().text_size(13).font_weight(700).text_color("#ffffff").child("指示を送る"))))
        .child(div().text_size(10).text_color(P.muted).child(a.address ? "herdr TUI のエージェントです（読む・指示のみ）" : "herdr TUI のエージェントです（宛先が決まらないため読むだけ）"))));
  }

  // ★105 R7: a run of tool rows becomes one dark box (the "実行ログ"); the other messages are bubbles.
  // ★110 (office-fix7): the mark of a tool row is not always a check. A tool row is only "done" when something came after it; the newest row of a blocked agent waits
  // for approval, of a working agent it is still running; the data's own flag (error / is_error / status) wins when it is there. `dark`: on the dark 実行ログ box.
  toolMark(m, last, status, dark = false) {
    const st = String(m.status ?? "").toLowerCase();
    if (m.error || m.is_error || /^(error|failed|fail)$/.test(st)) return { glyph: "✕", label: "失敗", color: dark ? "#f87171" : "#d6455d" };
    if (/^(pending|waiting|blocked)$/.test(st) || (last && status === "blocked")) return { glyph: "…", label: "承認待ち", color: dark ? "#fbbf24" : "#b7791f" };
    if (/^(running|working|in_progress)$/.test(st) || (last && status === "working")) return { glyph: "…", label: "実行中", color: dark ? "#60a5fa" : "#2563eb" };
    return { glyph: "✓", label: "", color: dark ? "#4ade80" : STATE.done.color };
  }
  markEl(mk) { return h_flex().flex_none().gap(4).items_center().text_color(mk.color).child(mk.label ? div().text_size(11).child(mk.label) : div()).child(div().child(mk.glyph)); }

  messageList(msgs, agentName, status) {
    const out = []; let run = [];
    const flush = () => { if (!run.length) return; const rows = run; run = [];
      out.push(v_flex().id(`pm-log-${out.length}`).w_full().gap(4).px(14).py(10).rounded(10).bg("#14213d")
        .child(h_flex().gap(6).items_center().child(icon("terminal", 14, "#cbd5e1")).child(div().text_size(15).font_weight(700).text_color("#cbd5e1").child("実行ログ（直近）")))
        .children(rows.map(({ m, last }, j) => h_flex().id(`pm-log-${out.length}-${j}`).w_full().gap(8).items_center().font_family("Consolas").text_size(16).text_color("#e5e7eb")
          .child(div().flex_1().min_w(0).truncate().child(String(m.text ?? "").split(/\r?\n/)[0])).child(this.markEl(this.toolMark(m, last, status, true)))))); };
    msgs.forEach((m, i) => { if (m.role === "tool") run.push({ m, last: i === msgs.length - 1 }); else { flush(); out.push(this.panelMessage(m, i, agentName, i === msgs.length - 1, status)); } });
    flush();
    return out;
  }

  // One line of the conversation: who, when, what. A tool's work is a small row with its mark (✓ done / … waiting or running / ✕ failed).
  panelMessage(m, i, agentName, last = false, status = null) {
    if (m.role === "tool") return h_flex().id(`pm-${i}`).w_full().gap(8).px(10).py(6).items_center().rounded(6).bg("#f6f7f9") // 22nd N7: a pale fill and a thin pale frame (the same two colours as detail.js's screen-tool), muted text: a record, not something said
      .border(1).border_color("#e3e6ec").text_size(16).text_color(P.muted)
      .child(div().flex_1().min_w(0).truncate().child(String(m.text ?? "").split("\n")[0])).child(this.markEl(this.toolMark(m, last, status)));
    const user = m.role === "user", { text: body, from } = unwrapHc(m.text);
    // ★105 (codex_3): a rounder bubble (12), the agent's in a pale blue, the time at the right end of the name row
    return v_flex().id(`pm-${i}`).w_full().gap(3)
      .child(h_flex().gap(6).items_center().text_size(13)
        .child(div().font_weight(700).text_color(user ? P.blue : P.ink).child(user ? "あなた" : agentName))
        .when(!!from, (e) => e.child(div().id(`pm-from-${i}`).flex_none().text_size(11).text_color(P.muted).tooltip(String(from)).child("親から")))
        .child(div().flex_1())
        .child(div().flex_none().text_color(P.muted).child(m.at ? clock(m.at) : "")))
      .child(div().w_full().px(14).py(10).rounded(12).bg(user ? "#d6e6fb" : "#e8f0fe").border(user ? 1 : 0).border_color("#9bbdf0").text_size(17).text_color(P.ink).child(soft(body)));
  }

  message(m, i) {
    const who = { user: ["あなた", "#2f7cf6", "#eef4ff"], assistant: ["エージェント", "#39a380", "#f3faf6"],
      tool: ["ツール", "#89909d", "#f6f7f9"] }[m.role] ?? [m.role, P.muted, P.bg];
    return v_flex().id(`msg-${i}`).w_full().gap(3).px(10).py(7).rounded(7).bg(who[2])
      .child(h_flex().gap(6).items_center().text_size(10)
        .child(div().font_weight(700).text_color(who[1]).child(who[0]))
        .child(div().text_color(P.muted).child(m.at ? clock(m.at) : "")))
      .child(div().w_full().text_size(m.role === "tool" ? 11 : 12).text_color(P.ink).child(String(m.text ?? "")));
  }
}
