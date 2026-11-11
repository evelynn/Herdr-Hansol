import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, panes, spaces, closeOverlay, openOverlay, props, shared, setShared, notify } from "herdr";
import { P, STATE, SHELL_STATE } from "./common.js";

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
    kind: "window", key: key || `hakoniwa-terminal-${address}`, width: w, height: h, ...(place || at ? { at: place || at } : {}),
    layout: { type: "column", children: [
      { type: "block", size: { px: 48 }, content: { mod: "hakoniwa", props: { role: "terminal-window-head", address, name, width: w, height: h } } },
      { type: "block", content: { terminal: address } },
      { type: "block", size: { px: 22 }, content: { mod: "hakoniwa", props: { role: "terminal-window-grip", address, name, width: w, height: h } } },
    ] },
  };
}

export function openTerminalWindow(address, name, width, height, options = {}) {
  const all = shared("hakoniwa.terminalWindows") ?? {};
  const previous = all[address];
  const defaults = shared("hakoniwa.terminalDefaultSize") ?? {};
  const key = options.key || previous?.key || `hakoniwa-terminal-${address}`;
  const spec = terminalWindowSpec(address, name, width ?? defaults.width, height ?? defaults.height, key, options.at);
  const id = openOverlay(spec);
  setShared("hakoniwa.terminalWindows", { ...all, [address]: { id, key, address, name, width: spec.width, height: spec.height } });
  return id;
}

function placeTerminal(p, x, y, width, height) {
  const all = shared("hakoniwa.terminalWindows") ?? {}, prev = all[p.address];
  if (prev?.id) closeOverlay(prev.id);
  const key = `hakoniwa-terminal-${p.address}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  openTerminalWindow(p.address, p.name, width, height, { key, at: { x, y } });
}

function dockTerminal(p, right) {
  const vp = globalThis.window?.viewport_size?.(); if (!(vp?.width > 0 && vp?.height > 0)) return;
  const w = Math.floor((vp.width - 24) / 2), h = Math.max(260, vp.height - 96);
  placeTerminal(p, right ? vp.width - w - 8 : 8, 72, w, h);
}

function arrangeTerminals() {
  const vp = globalThis.window?.viewport_size?.(), entries = Object.values(shared("hakoniwa.terminalWindows") ?? {});
  if (!(vp?.width > 0 && vp?.height > 0) || !entries.length) return;
  const cols = entries.length === 1 ? 1 : 2, rows = Math.ceil(entries.length / cols), gap = 8;
  const w = Math.floor((vp.width - gap * (cols + 1)) / cols), h = Math.max(260, Math.floor((vp.height - 72 - gap * (rows + 1)) / rows));
  entries.forEach((p, i) => placeTerminal(p, gap + (i % cols) * (w + gap), 72 + Math.floor(i / cols) * (h + gap), w, h));
}

export function terminalWindowHead() {
  const p = props() ?? {}, address = String(p.address ?? "");
  const button = (id, label, tip, fn) => div().id(id).flex_none().w(34).h(32).flex().items_center().justify_center()
    .rounded(6).text_size(16).text_color(P.ink).cursor_pointer().tooltip(tip)
    .hover((s) => s.bg("#314259")).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); fn(); }).child(label);
  const activity = (shared("hakoniwa.activities") ?? {})[address] ?? {};
  const agent = agents().find((a) => a.address === address);
  const pane = panes().find((item) => item.terminal === address);
  const workspace = agent?.space_name || spaces().find((item) => item.tabs.some((tab) => tab.id === pane?.tab))?.name;
  const state = agent ? STATE[agent.status] : (pane ? SHELL_STATE : null);
  return h_flex().id("terminal-window-head").size_full().px(12).gap(6).items_center().bg(P.paper).border_b(1).border_color(P.line)
    .tooltip("제목 표시줄을 끌어 창 이동")
    .child(div().flex_none().max_w(180).truncate().text_size(14).font_weight(700).text_color(P.ink).child(String(p.name || address)))
    .when(!!workspace, (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).text_color(P.muted).tooltip(`작업공간: ${workspace}`).child(workspace)))
    .when(!!state, (el) => el.child(div().flex_none().text_size(12).font_weight(700).text_color(state.color).child(state.label)))
    .when(!!activity.model && !String(p.name || "").includes(activity.model), (el) => el.child(div().flex_none().text_size(12).text_color(P.muted).child(activity.model)))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(P.muted).child(activity.label || ""))
    .when(shared("hakoniwa.chatEnabled")?.on === true, (el) => el.child(button("terminal-chat", "대화", "대화창 열기", () => openOverlay({
      mod: "hakoniwa", kind: "window", key: `hakoniwa-chat-${address}`, width: 640, height: 660,
      props: { role: "chat", id: `app:${address}`, address, name: p.name, source: "app" },
    })).w(48)))
    .child(button("terminal-dock-left", "◧", "왼쪽에 붙이기", () => dockTerminal(p, false)))
    .child(button("terminal-dock-right", "◨", "오른쪽에 붙이기", () => dockTerminal(p, true)))
    .child(button("terminal-arrange", "▦", "열린 터미널 자동 정렬", arrangeTerminals))
    .child(button("terminal-save-default", "기본", "현재 창 크기를 새 팝업의 기본 크기로 저장", () => {
      setShared("hakoniwa.terminalDefaultSize", { width: p.width, height: p.height });
      notify({ title: "기본 창 크기 저장", body: `${p.width} × ${p.height}` });
    }).w(48).text_size(12))
    .child(button("terminal-close", "×", "창 닫기 (세션 유지)", () => {
      const all = { ...(shared("hakoniwa.terminalWindows") ?? {}) };
      delete all[address]; setShared("hakoniwa.terminalWindows", all); closeOverlay(p.overlay);
    }));
}

export function terminalWindowGrip() {
  const p = props() ?? {};
  return h_flex().id("terminal-window-grip").size_full().justify_end().items_center().bg(P.paper).border_t(1).border_color(P.line)
    .child(div().id("terminal-resize").w(44).h_full().cursor_nwse_resize().text_color(P.muted).text_size(16)
      .tooltip("오른쪽 아래 모서리를 끌어 크기 조절").flex().items_center().justify_center().child("◢")
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        const vp = globalThis.window?.viewport_size?.();
        if (!(vp?.width > 0 && vp?.height > 0)) return;
        openOverlay({ mod: "hakoniwa", kind: "window", frame: "none", key: "hakoniwa-resize-surface",
          width: vp.width, height: vp.height, at: { x: 0, y: 0 },
          props: { role: "terminal-resize-surface", address: p.address, name: p.name, width: p.width, height: p.height,
            startX: e.position.x, startY: e.position.y } });
      }));
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
      .bg("#1b2637").text_color("#e7edf6").text_size(12).child(`${Math.round(current.width)} × ${Math.round(current.height)}`));
}
