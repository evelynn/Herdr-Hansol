// hakoniwa ★84: the small parts the header, the left list and the right window share (icon buttons, a switch, tabs, a menu, the in-place rename,
// the drag handle) and the pure rules behind them (widths, the right head's height, "does a box stay inside its parent").
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { P } from "./common.js";
import { icon } from "./icons.js";

export * from "./ui-rules.js";
import { RIGHT_HEAD, UI } from "./ui-rules.js";

// ---- parts
// A small icon button. opts: { size (box, 24), isize (picture, 14), color, red, disabled, active }. A disabled one does nothing (and is pale).
export function iconBtn(id, name, fn, opts = {}) {
  const box = opts.size ?? 24, col = opts.disabled ? "#c3beb1" : opts.red ? "#d6455d" : opts.color ?? P.muted;
  // 5th X7: opts.frame = a thin frame always on (the button looks pressable), a darker fill on hover (the "⋯" of the left list)
  const el = h_flex().id(id).flex_none().w(box).h(box).items_center().justify_center().rounded(6).when(!!opts.active, (e) => e.bg("#e8f0fe")).when(!!opts.frame && !opts.disabled, (e) => e.border(1).border_color("#d9d3c4").bg("#faf8f2"))
    .when(!!opts.tip, (e) => e.tooltip(String(opts.tip))) // ★107 W8: opts.tip = the pointer's tooltip (what the icon does)
    .child(icon(name, opts.isize ?? 14, col));
  return opts.disabled ? el : el.cursor_pointer().hover((s) => s.bg(opts.red ? "#FDE8E8" : opts.frame ? "#e6e2d8" : "#f0ede4")).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); });
}
// Tabs with a line under the chosen one. items: [{ key, label, icon?, count? }].
// ★105 opts.equal: the tabs share the row equally, centred, bigger text, the blue line spans the whole tab (the target's "会話｜端末"). Default: as before.
export function tabs(id, items, value, fn, opts = {}) {
  if (opts.equal) {
    // ★106 V2: the blue line is its own 3px bar INSIDE the tab (above the row's 1px rule), not a border on the tab's bottom edge (that edge was cut by the head's height)
    return h_flex().id(id).flex_none().w_full().h(RIGHT_HEAD.tabs).pb(1).border_b(1).border_color(P.line)
      .children(items.map((it) => v_flex().id(`${id}-${it.key}`).flex_1().min_w(0).h_full().cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); fn(it.key, cx); })
        .child(h_flex().flex_1().min_h(0).gap(6).items_center().justify_center()
          .child(icon(it.icon ?? "more", 18, it.key === value ? P.blue : P.muted))
          .child(div().text_size(UI.text.body).font_weight(it.key === value ? 700 : 500).text_color(it.key === value ? P.blue : P.muted).child(it.label + (it.count != null ? ` ${it.count}` : ""))))
        .child(div().flex_none().w_full().h(3).bg(it.key === value ? P.blue : "#00000000"))));
  }
  return h_flex().id(id).flex_none().h(RIGHT_HEAD.tabs).px(14).gap(18).items_end().border_b(1).border_color(P.line)
    .children(items.map((it) => h_flex().id(`${id}-${it.key}`).flex_none().h_full().gap(5).pb(7).items_end().cursor_pointer()
      .when(it.key === value, (e) => e.border_b(2).border_color(P.blue))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(it.key, cx); })
      .child(icon(it.icon ?? "more", 14, it.key === value ? P.blue : P.muted))
      .child(div().text_size(UI.text.small).font_weight(it.key === value ? 700 : 500).text_color(it.key === value ? P.blue : P.muted).child(it.label + (it.count != null ? ` ${it.count}` : "")))));
}
// The "⋯" menu: items [{ id, label, fn, danger }], the danger ones (end) in red.
export function menuList(id, items) {
  return v_flex().id(id).w(176).p(4).gap(1).rounded(10).bg("#ffffff").border(1).border_color(P.line)
    .children(items.map((it) => div().id(`${id}-${it.id}`).px(10).py(6).rounded(6).text_size(UI.text.small).text_color(it.danger ? "#d6455d" : P.ink).cursor_pointer()
      .hover((s) => s.bg(it.danger ? "#FDE8E8" : "#f3efe4")).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); it.fn(cx); }).child(it.label)));
}
// The in-place rename: the input (the current name is in it from the start: the caller made the InputState with it) + ✓ and ×. Enter / Esc too.
// ★96-2: ONE look for the rename input on both sides (framed, white, the text size of the name it replaces, ✓ and ×). `size` = that text size (12 list, 16 right column).
export function inlineRename(id, state, ok, cancel, size = 12) {
  return h_flex().id(id).flex_1().min_w(0).gap(4).items_center().px(6).py(2).rounded(7).border(1).border_color(P.blue).bg("#ffffff").text_size(size)
    .on_key_down((e, cx) => { if (e.key === "enter") { ok(cx); cx.stop_propagation(); } else if (e.key === "escape") { cancel(cx); cx.stop_propagation(); } })
    .child(div().flex_1().min_w(0).text_size(size).child(Input.new(state)))
    .child(iconBtn(`${id}-ok`, "check", ok, { size: UI.hit, color: "#27AE60" })).child(iconBtn(`${id}-no`, "x", cancel, { size: UI.hit }));
}
// ★96-2 the input of a rename: the current name in it, focused and all selected (typing replaces it). Made in an event handler, never in render.
export const renameState = (value) => { const v = String(value ?? ""), s = InputState.new({ value: v }); try { s.focus(); s.set_selected_range({ start: 0, end: v.length }); } catch {} return s; };
// A drag handle on the border between two columns: flush with the edge (no gap), a colour and the resize cursor on hover. `onDown(e, cx)` starts the drag.
export function splitHandle(id, onDown, active = false) {
  return div().id(id).absolute().top(0).h_full().w(6).cursor_col_resize().hover((s) => s.bg("#2F80ED55")).when(active, (e) => e.bg("#2F80ED88")).on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onDown(e, cx); });
}
