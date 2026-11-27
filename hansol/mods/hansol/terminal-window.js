import { div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, closeOverlay, openOverlay, props, shared, setShared, notify, hc, focused } from "herdr";
import { P, STATE, SHELL_STATE, blockedText } from "./common.js";
import { answerOnce, answerLocked, KEY_NOT_SENT } from "./approve.js";
import { icon as svgIcon } from "./icons.js";
import { NEON, LINE, RULE, R_OUT, WORK, WIN_HEAD, WIN_HEAD_SEL, cutTag, cutIconButton } from "./mz-ui.js";

// 2026-11-26 the MOSSES layout (mosses.js): the window's head and grip take its look (the MOSSES palette of common.js, 4 px corners),
// and a waiting question is answered from the head (approve / deny), so the floor needs no second window for it.
const isMosses = () => ["mosses", "terminal"].includes(shared("hansol.layout"));
const look = () => (isMosses() ? { paper: P.paper, line: P.line, ink: P.ink, muted: P.muted, hover: P.white, edge: P.line, font: "Consolas" }
  : { paper: P.paper, line: P.line, ink: P.ink, muted: P.muted, hover: P.press, edge: "#00000000", font: null });
// One answer a question: approve.js answerOnce holds the lock in shared "hansol.mzAnswered", which the floor and the approval cards use too.
const answerStore = { get: () => shared("hansol.mzAnswered"), set: (all) => setShared("hansol.mzAnswered", all) };

// 2026-11-27 the window whose terminal has the keyboard gets a neon outline (head, side strips, grip), so it stands out from the others.
const EDGE_W = 1;
// The neon marks the selected window: the one opened or pressed (head, bottom bar) last, or whose terminal took the keyboard after that.
// Herdr tells only which terminal has the keyboard and can't hand the keyboard to a window's terminal (pane.focus switches the workspace instead),
// so a window just opened is selected while typing still goes elsewhere: the head's "입력" mark shows where typing goes.
const windowTerminals = new Set(); // terminals a window has drawn: a model pane (pane set) or other terminal with the keyboard is not a window's
const keyboardAt = () => { try { const f = focused(); return f?.terminal && !f.pane && windowTerminals.has(f.terminal) ? f.terminal : null; } catch { return null; } };
let seenKey, seenAt = 0; // the keyboard's terminal as last seen, and when it changed (seen on a render: focus changes re-render)
const selectWindow = (address) => { if (address) setShared("hansol.termSel", { address, at: Date.now() }); };
const selectedWindow = () => {
  const k = keyboardAt(), sel = shared("hansol.termSel");
  if (k !== seenKey) { seenKey = k; seenAt = Date.now(); }
  return k && !(sel?.at > seenAt) ? k : sel?.address ?? k;
};
const isActive = (address) => { if (!address) return false; windowTerminals.add(address); return selectedWindow() === address; };
// (MOSSES) the window draws its own frame (frame "none": Herdr's rounded frame clipped a straight outline and showed a second, grey line), rounded as
// every container: the line runs along the head's top and sides, the side strips and the grip's sides and bottom. Selected = the neon line and the
// neon fill, as a selected button; the others: the resting line. Other layouts keep Herdr's frame; the selected window gets neon bars inside it.
const HEAD_BG = WIN_HEAD, HEAD_SEL = WIN_HEAD_SEL; // (2026-11-27: the head a step above the terminal's background, not a bright band over it)
const SEL_LINE = NEON + "b3"; // the selected window's line: 70% neon (four long sides read brighter than a button's)
const edgeColour = (address) => (isActive(address) ? SEL_LINE : isMosses() ? LINE : null);
const outline = (el, address, end) => { const c = edgeColour(address); if (!c) return el;
  if (isMosses()) return el.border_color(c).border_l(1).border_r(1).when(end === "top", (e) => e.border_t(1).rounded_t(R_OUT)).when(end === "bottom", (e) => e.border_b(1).rounded_b(R_OUT));
  return el.child(div().absolute().left(0).right(0).h(EDGE_W).bg(c).when(end === "top", (e) => e.top(0)).when(end === "bottom", (e) => e.bottom(0)))
    .child(div().absolute().left(0).top(0).bottom(0).w(EDGE_W).bg(c)).child(div().absolute().right(0).top(0).bottom(0).w(EDGE_W).bg(c)); };
export function terminalWindowEdge() { const p = props() ?? {}; return div().size_full().bg(edgeColour(p.address) ?? P.paper); }

const GRIP_H = 12; // the resize strip under the terminal (was 22): the terminal keeps the 10 px

export function terminalWindowSpec(address, name, width = 900, height = 720, key, place) {
  const vp = globalThis.window?.viewport_size?.();
  const w = Math.max(360, Math.min(1600, vp?.width ? vp.width - 32 : 1600, Number(width) || 900));
  const h = Math.max(260, Math.min(1100, vp?.height ? vp.height - 32 : 1100, Number(height) || 720));
  const hash = [...String(address)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const at = vp?.width > 0 && vp?.height > 0 ? {
    x: Math.max(0, Math.min(vp.width - w, 40 + (hash % 5) * 55)),
    y: Math.max(0, Math.min(vp.height - h, 80 + (hash % 5) * 45)),
  } : undefined;
  return {
    kind: "window", key: key || `hansol-terminal-${address}`, width: w, height: h, ...(place || at ? { at: place || at } : {}), ...(isMosses() ? { frame: "none" } : {}),
    layout: { type: "column", children: [
      { type: "block", size: { px: 48 }, content: { mod: "hansol", props: { role: "terminal-window-head", address, name, width: w, height: h } } },
      { type: "row", children: [ // thin strips at the sides: the outline's sides when this window is the active one
        { type: "block", size: { px: EDGE_W }, content: { mod: "hansol", props: { role: "terminal-window-edge", address } } },
        { type: "block", content: { terminal: address } },
        { type: "block", size: { px: EDGE_W }, content: { mod: "hansol", props: { role: "terminal-window-edge", address } } },
      ] },
      { type: "block", size: { px: isMosses() ? 26 : GRIP_H }, content: { mod: "hansol", props: { role: "terminal-window-grip", address, name, width: w, height: h } } },
    ] },
  };
}

export function openTerminalWindow(address, name, width, height, options = {}) {
  const all = shared("hansol.terminalWindows") ?? {};
  const previous = all[address];
  const defaults = shared("hansol.terminalDefaultSize") ?? {};
  const key = options.key || previous?.key || `hansol-terminal-${address}`;
  const spec = terminalWindowSpec(address, name, width ?? defaults.width, height ?? defaults.height, key, options.at);
  const id = openOverlay(spec);
  if (!options.key) selectWindow(address); // not when auto-arrange reopens every window
  setShared("hansol.terminalWindows", { ...all, [address]: { id, key, address, name, width: spec.width, height: spec.height } });
  return id;
}

function placeTerminal(p, x, y, width, height) {
  const all = shared("hansol.terminalWindows") ?? {}, prev = all[p.address];
  if (prev?.id) closeOverlay(prev.id);
  const key = `hansol-terminal-${p.address}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  openTerminalWindow(p.address, p.name, width, height, { key, at: { x, y } });
}

// Two columns that always fill the screen: the left one gets floor(n/2) windows, the right one the rest, each column split evenly
// (3 = one tall window at the left, two stacked at the right; the old 2x2 grid left a quarter empty). A window whose terminal has
// ended closed by itself but stayed in the list: it is dropped here instead of opened again.
export function arrangePlan(n, vw, vh, top = 72, gap = 8) {
  if (n <= 0) return [];
  const cols = n === 1 ? [1] : [Math.floor(n / 2), n - Math.floor(n / 2)], w = Math.floor((vw - gap * (cols.length + 1)) / cols.length), out = [];
  cols.forEach((rows, c) => { const h = Math.max(260, Math.floor((vh - top - gap * (rows + 1)) / rows)); for (let r = 0; r < rows; r++) out.push({ x: gap + c * (w + gap), y: top + r * (h + gap), w, h }); });
  return out;
}
function arrangeTerminals() {
  const vp = globalThis.window?.viewport_size?.(), all = shared("hansol.terminalWindows") ?? {};
  const alive = (t) => agents().some((a) => a.address === t) || panes().some((q) => q.terminal === t);
  const entries = Object.values(all).filter((p) => alive(p.address));
  if (entries.length !== Object.keys(all).length) setShared("hansol.terminalWindows", Object.fromEntries(entries.map((p) => [p.address, p])));
  if (!(vp?.width > 0 && vp?.height > 0) || !entries.length) return;
  arrangePlan(entries.length, vp.width, vp.height).forEach((b, i) => placeTerminal(entries[i], b.x, b.y, b.w, b.h));
}

export function terminalWindowHead() {
  const p = props() ?? {}, address = String(p.address ?? "");
  const T = look(), mz = isMosses();
  const button = (id, label, tip, fn) => mz ? cutIconButton(id, 30, 26, label, tip, () => fn()) : div().id(id).flex_none().w(mz ? 30 : 34).h(mz ? 26 : 32).flex().items_center().justify_center()
    .rounded(6).when(mz, (el) => el.border(1).border_color("#00000000")).text_size(mz ? 14 : 16).text_color(mz ? T.muted : T.ink).cursor_pointer().tooltip(tip)
    .hover((s) => (mz ? s.bg(P.raised).border_color(P.blue + "88").text_color("#ffffff") : s.bg(T.hover))).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); fn(); }).child(label);
  // the head's actions are icons (2026-11-27: arrange, save the size, close; chat when on). Drawn (paths): a 2 x 2 grid, a window with a pin, a cross
  const INK = "#a9c4e4", pp = (b, colour) => globalThis.window.paint_path(b.build(), colour).absolute().left(0).top(0).w(30).h(26);
  const box = (x, y, w, h) => [[7 + x, 6.5 + y], [7 + x + w, 6.5 + y], [7 + x + w, 6.5 + y + h], [7 + x, 6.5 + y + h]];
  const icon = (kind) => { const el = div().relative().w(30).h(26);
    if (kind === "save") return el.child(pp(PathBuilder.stroke(1).add_polygon(box(0, 0, 16, 13), true).add_polygon([[7 + 16, 6.5 + 13], [7 + 11, 6.5 + 13]], false), INK)).child(pp(PathBuilder.fill().add_polygon(box(0, 0, 16, 3), true).add_polygon(box(11, 8, 5, 5), true), INK));
    if (kind === "grid") return el.child(pp(PathBuilder.stroke(1).add_polygon(box(0, 0, 7, 5.5), true).add_polygon(box(9, 0, 7, 5.5), true).add_polygon(box(0, 7.5, 7, 5.5), true).add_polygon(box(9, 7.5, 7, 5.5), true), INK));
    return el.child(pp(PathBuilder.stroke(1.4).add_polygon([[10, 8], [20, 18]], false).add_polygon([[20, 8], [10, 18]], false), kind === "close" ? "#f0a0ac" : INK)); };
  const sep = () => div().flex_none().w(1).h(16).bg("#8fb4d82e");
  const activity = (shared("hansol.activities") ?? {})[address] ?? {};
  const agent = agents().find((a) => a.address === address);
  const pane = panes().find((item) => item.terminal === address);
  const workspace = agent?.space_name || spaces().find((item) => item.tabs.some((tab) => tab.id === pane?.tab))?.name;
  const state = agent ? STATE[agent.status] : (pane ? SHELL_STATE : null);
  // (MOSSES) a waiting question: approve / deny here, the same keys the approval card presses
  const ask = mz && agent?.status === "blocked", busy = answerLocked(shared("hansol.mzAnswered")?.[address]);
  // (MOSSES) the floor's button shape: the four corners cut (a path)
  const cutPts = [[10, 0.5], [57.5, 0.5], [57.5, 16], [48, 25.5], [0.5, 25.5], [0.5, 10]], shape = (b, colour) => globalThis.window.paint_path(b.add_polygon(cutPts, true).build(), colour).absolute().left(0).top(0).w(58).h(26);
  const answer = (id, label, want, bg, line, ink) => div().id(id).relative().flex_none().w(58).h(26).flex().items_center().justify_center()
    .child(shape(PathBuilder.fill(), bg)).child(shape(PathBuilder.stroke(1), line))
    .text_size(12).font_weight(700).text_color(ink).cursor_pointer().tooltip(want === "yes" ? "이 요청 승인" : "이 요청 거절")
    .hover((s) => s.text_color("#ffffff")).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (answerLocked(shared("hansol.mzAnswered")?.[address])) return;
      cx.spawn(async (c2) => {
        const res = await answerOnce({ hc, sleep: (ms) => c2.sleep(ms) }, answerStore, address, want);
        if (!res?.ok && res?.reason !== "locked") notify(KEY_NOT_SENT.has(res?.reason) ? { title: "응답 전송 실패", body: "터미널에서 직접 응답해 주세요." } : { title: "응답 확인 안 됨", body: "터미널 화면을 확인해 주세요." });
        c2.notify();
        await c2.sleep(6100); c2.notify(); // a next question right away: the buttons come back when the hold is over
      });
      cx.notify();
    }).child(div().relative().child(label));
  return outline(h_flex().id("terminal-window-head").relative().on_mouse_down("left", () => selectWindow(address)).size_full().px(mz ? 14 : 12).gap(6).items_center().bg(mz ? (isActive(address) ? HEAD_SEL : HEAD_BG) : T.paper)
    .when(!mz, (el) => el.border_b(1).border_color(T.line)).when(mz, (el) => el.child(div().absolute().left(0).right(0).bottom(0).h(1).bg(RULE)))
    .tooltip("제목 표시줄을 끌어 창 이동")
    .when(mz, (el) => { const task = String(activity.full ?? activity.label ?? "").trim(), who = String(p.name || address), tab = shared("hansol.mzUnits")?.[address]; // (MOSSES) the work first, then who and where: as the name plates on the floor
      const sc = state?.color ?? P.blue, sl = state?.label ?? "터미널";
      return el.gap(12)
        .child(div().absolute().left(R_OUT).top(0).w(74).h(2).bg(sc)) // a stretch of the top line in the state's colour (clear of the rounded corner)
        .child(isActive(address) ? cutTag(sl, agent?.status === "working" ? WORK : sc, 22, undefined, true) : cutTag(sl, sc, 22)) // the selected window's state lit (working: the floor's bright teal)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(14).font_weight(600).text_color(agent?.status === "blocked" ? "#ffd9a8" : "#f2f7fd").child((agent?.status === "blocked" && agent.blocked_msg ? String(blockedText(agent)) : "") || task || who))
          .child(div().truncate().text_size(11).text_color(T.muted).child([task ? who : "", [workspace, tab].filter(Boolean).join(" / ")].filter(Boolean).join("   ·   ")))); })
    .when(!mz, (el) => el.child(div().flex_none().max_w(180).truncate().text_size(14).font_weight(700).text_color(T.ink).child(String(p.name || address))))
    .when(!mz && !!workspace, (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).text_color(T.muted).tooltip(`작업공간: ${workspace}`).child(workspace)))
    .when(!mz && !!state, (el) => el.child(div().flex_none().text_size(12).font_weight(700).text_color(state.color).child(state.label)))
    .when(!mz && !!activity.model && !String(p.name || "").includes(activity.model), (el) => el.child(div().flex_none().text_size(12).text_color(T.muted).child(activity.model)))
    .when(!mz, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(T.muted).child(activity.label || "")))
    .when(ask && !busy, (el) => el.child(answer("terminal-approve", "승인", "yes", STATE.blocked.color, STATE.blocked.color, "#140c00")).child(answer("terminal-deny", "거절", "no", P.bg, "#f0788a99", "#f0788a")))
    .when(ask && busy, (el) => el.child(div().flex_none().text_size(12).text_color(STATE.blocked.color).child("응답 전송함…")))
    .when(shared("hansol.chatEnabled")?.on === true, (el) => el.child(button("terminal-chat", svgIcon("chat", 15, mz ? INK : T.ink), "대화창 열기", () => openOverlay({
      mod: "hansol", kind: "window", key: `hansol-chat-${address}`, width: 640, height: 660,
      props: { role: "chat", id: `app:${address}`, address, name: p.name, source: "app" },
    }))))
    .when(keyboardAt() === address, (el) => el.child(div().flex_none().tooltip("키보드 입력이 이 창으로 들어감").child(cutTag("입력 중", NEON, 22, undefined, true))))
    .when(mz, (el) => el.child(sep())).child(button("terminal-arrange", mz ? icon("grid") : "▦", "열린 터미널 자동 정렬", arrangeTerminals))
    .child(button("terminal-save-default", mz ? icon("save") : "▣", "현재 창 크기를 새 팝업의 기본 크기로 저장", () => {
      setShared("hansol.terminalDefaultSize", { width: p.width, height: p.height });
      notify({ title: "기본 창 크기 저장", body: `${p.width} × ${p.height}` });
    }))
    .when(mz, (el) => el.child(sep())).child(button("terminal-close", mz ? icon("close") : "×", "창 닫기 (세션 유지)", () => {
      const all = { ...(shared("hansol.terminalWindows") ?? {}) };
      delete all[address]; setShared("hansol.terminalWindows", all); closeOverlay(p.overlay);
      if (shared("hansol.termSel")?.address === address) setShared("hansol.termSel", null);
    })), address, "top");
}

export function terminalWindowGrip() {
  const p = props() ?? {};
  const T = look(), mz = isMosses();
  const info = () => { const address = String(p.address ?? ""), agent = agents().find((a) => a.address === address), pane = panes().find((item) => item.terminal === address); // (MOSSES) a status line: work space / tab, the model, the window's size
    const ws = agent?.space_name || spaces().find((item) => item.tabs.some((tab) => tab.id === pane?.tab))?.name, tab = shared("hansol.mzUnits")?.[address], model = (shared("hansol.activities") ?? {})[address]?.model;
    const cell = (text, colour) => div().flex_none().whitespace_nowrap().text_size(10.5).text_color(colour ?? T.muted).child(String(text)), dot = () => div().flex_none().w(2).h(2).rounded(1).bg("#8fb4d866");
    const parts = [[ws, tab].filter(Boolean).join(" / "), model].filter(Boolean);
    return h_flex().flex_1().min_w(0).h_full().pl(14).gap(9).items_center().overflow_hidden()
      .child(div().flex_none().w(5).h(5).rounded(3).bg((agent ? STATE[agent.status]?.color : null) ?? P.blue))
      .children(parts.flatMap((x, k) => (k ? [dot(), cell(x)] : [cell(x, "#cfe0f3")])))
      .child(div().flex_1()); };
  const lines = () => globalThis.window.paint_path(PathBuilder.stroke(1.2).add_polygon([[22, 8], [8, 22]], false).add_polygon([[22, 13], [13, 22]], false).add_polygon([[22, 18], [18, 22]], false).build(), P.blue + "b0").absolute().left(0).top(0).w(26).h(26);
  return outline(h_flex().id("terminal-window-grip").relative().on_mouse_down("left", () => selectWindow(String(p.address ?? ""))).size_full().justify_end().items_center().bg(mz ? (isActive(String(p.address ?? "")) ? HEAD_SEL : HEAD_BG) : T.paper)
    .when(!mz, (el) => el.border_t(1).border_color(T.line)).when(mz, (el) => el.child(div().absolute().left(0).right(0).top(0).h(1).bg(RULE)))
    .when(mz, (el) => el.child(info()))
    .child(div().id("terminal-resize").relative().w(mz ? 26 : 36).h_full().cursor_nwse_resize().text_color(T.muted).text_size(11)
      .tooltip("오른쪽 아래 모서리를 끌어 크기 조절").flex().items_center().justify_center().child(mz ? lines() : "◢")
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        const vp = globalThis.window?.viewport_size?.();
        if (!(vp?.width > 0 && vp?.height > 0)) return;
        openOverlay({ mod: "hansol", kind: "window", frame: "none", key: "hansol-resize-surface",
          width: vp.width, height: vp.height, at: { x: 0, y: 0 },
          props: { role: "terminal-resize-surface", address: p.address, name: p.name, width: p.width, height: p.height,
            startX: e.position.x, startY: e.position.y } });
      })), String(p.address ?? ""), "bottom");
}

export function terminalResizeSurface(host) {
  const p = props() ?? {}, pos = host.terminalResizePoint ?? { x: p.startX, y: p.startY };
  const size = (point) => ({
    width: Math.max(360, Number(p.width) + point.x - Number(p.startX)),
    height: Math.max(260, Number(p.height) + point.y - Number(p.startY)),
  });
  const current = size(pos);
  return div().id("terminal-resize-surface").relative().size_full().bg("#00000020").cursor_nwse_resize()
    .on_mouse_move((e, cx) => { host.terminalResizePoint = e.position; cx.notify(); })
    .on_mouse_up("left", (e, cx) => {
      cx.stop_propagation(); const next = size(e.position); host.terminalResizePoint = null;
      closeOverlay(p.overlay); openTerminalWindow(p.address, p.name, next.width, next.height);
    })
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); host.terminalResizePoint = null; closeOverlay(p.overlay); })
    .child(div().absolute().left(Math.max(0, pos.x + 10)).top(Math.max(0, pos.y + 10)).px(8).py(4).rounded(6)
      .bg(P.paper).text_color(P.ink).text_size(12).child(`${Math.round(current.width)} × ${Math.round(current.height)}`));
}
