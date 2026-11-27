// MOSSES shapes and colours in one place (2026-11-27, design docs/mosses-theme.md "디자인 규칙").
// The rule by role: what is pressed (buttons, tabs, tags) has two opposite corners cut at 45 degrees (top left, bottom right);
// what holds things (windows, panels, cards, menus) is rounded: R_OUT outside, R_IN for what sits inside a panel or window.
// Selected = the neon line at full strength with a faint neon fill; at rest = LINE.
import { div, PathBuilder } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared } from "herdr";

export const NEON = "#56d3ea", NEON_FILL = NEON + "1c", LINE = "#8fb4d84d", RULE = "#8fb4d833", R_OUT = 10, R_IN = 6;
// A window: its body (the terminal's background too: layouts/hansol.json colors.background) is the panels' colour, its head and foot a step above;
// a selected window's head and foot carry a 6% neon fill.
export const WORK = "#3ee6d2"; // working, lit (STATE.working.color is a dark teal: too dim on the dark plates)
export const WIN_BG = "#0a1323", WIN_HEAD = "#0c182b", WIN_HEAD_SEL = "#102336";
const KO = "Malgun Gothic";
export const isMz = () => { try { return ["mosses", "terminal"].includes(shared("hansol.layout")); } catch { return false; } };

// A text's width estimate (CJK a full em, a space a third, others 0.6 em): fixed-size plates are cheaper than rows sized by their content.
export const textW = (s, size) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? size : ch === " " ? size * 0.32 : size * 0.6), 0);
const paint = (b, colour) => globalThis.window.paint_path(b.build(), colour);
export const cutBox = (w, h, c) => [[c, 0.5], [w - 0.5, 0.5], [w - 0.5, h - c], [w - c, h - 0.5], [0.5, h - 0.5], [0.5, c]];
// A fixed-size cut plate (fill + 1 px line); the caller adds its content (absolute) on top.
export const cutPlate = (w, h, c, fill, line) => {
  const pts = cutBox(w, h, c), at = (e) => e.absolute().left(0).top(0).w(w).h(h);
  return div().relative().flex_none().w(w).h(h).child(at(paint(PathBuilder.fill().add_polygon(pts, true), fill))).child(at(paint(PathBuilder.stroke(1).add_polygon(pts, true), line)));
};
// The ends of a cut row: as wide as its content (a wedge each side, the middle a bordered strip).
const wedge = (h, c, fill, line, right) => { const pts = right ? [[0, 0.5], [c - 0.5, 0.5], [c - 0.5, h - c], [0, h - 0.5]] : [[c, 0.5], [0.5, c], [0.5, h - 0.5], [c, h - 0.5]], at = (e) => e.absolute().left(0).top(0).w(c).h(h);
  return div().relative().flex_none().w(c).h(h).child(at(paint(PathBuilder.fill().add_polygon(pts, true), fill))).child(at(paint(PathBuilder.stroke(1).add_polygon(pts, false), line))); };
export const cutRow = (el, h, c, fill, line, mid) => el.child(wedge(h, c, fill, line, false)).child(mid.flex_none().h(h).bg(fill).border_t(1).border_b(1).border_color(line)).child(wedge(h, c, fill, line, true));
// A small label (a state, a count, a tab): its colour's faint fill and line, corners cut. strong: the line at full strength (a lit button's neon).
// A fixed-size plate (2 paths; a cut row is 4): the status panel draws many of these on every refresh (2026-11-28: 4-path tags made the floor's
// draw 65% slower and its render was sometimes cut off, "This view could not be re-rendered: interrupted").
export const cutTag = (text, colour, h = 17, font = KO, strong = false) => {
  const t = String(text), size = h > 18 ? 11 : 10, c = h > 18 ? 6 : 5, w = Math.ceil(textW(t, size) + 2 * c + 6);
  return cutPlate(w, h, c, colour + (strong ? "1c" : "22"), strong ? colour : colour + "66")
    .child(div().absolute().left(0).top(0).w(w).h(h).flex().items_center().justify_center().whitespace_nowrap().text_size(size).font_family(font).font_weight(600).text_color(colour).child(t));
};
// An icon button (w x h, corners cut): bare at rest, the neon line and fill under the pointer (always when on). Stops the press (a window's head drags otherwise).
export const cutIconButton = (id, w, h, content, tip, press, on = false) => div().id(id).relative().flex_none().w(w).h(h).cursor_pointer().when(!!tip, (e) => e.tooltip(tip))
  .child(div().absolute().left(0).top(0).w(w).h(h).flex().items_center().justify_center().child(content))
  .child(div().absolute().left(0).top(0).w(w).h(h).opacity(on ? 1 : 0).hover((s) => s.opacity(1)).child(cutPlate(w, h, 7, NEON_FILL, NEON + "aa"))) // on top: shown under the pointer
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); press(cx); });
