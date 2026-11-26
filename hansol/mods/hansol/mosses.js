// hansol MOSSES layout (layout "mosses"): the HUD of a carrier travelling through space. Mixed into AgentHud (main.js).
// 2026-11-26 (4th design). Two instruments on one screen, over the view of space:
//   NAV RADAR (3D)   a work space = a planetary system: its planet on a tilted radar plane, one orbit per tab, each agent a satellite
//                    standing above the plane on a stem. One press on a satellite opens its channel (its terminal window) and locks it.
//                    Two views: CLUSTER (every system; the pointer on a moon shows its card) and SYSTEM (one entered system, every moon with its card);
//                    a loading screen between them. A satellite is a moon (a natural one) on its orbit's line.
//   COMM TERMINAL    INCOMING (the waiting approvals: the request, approve / deny / open), CHANNELS (every satellite as a row), COMM LOG.
// Every number is real (states, elapsed times, counts, times). Thin luminous lines on translucent plates; the depth comes from the
// pictures of mosses/ (made by hansol/tools/mosses-assets.py from noise and geometry). Colours: P and STATE of common.js.
// Pure parts: mosses-model.js. Design: hansol/docs/mosses-theme.md.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { hc, setShared, shared, notify, window as herdrWindow } from "herdr";
import { P, stateOf, blockedText, platform, STATE, activityText } from "./common.js";
import { answerOnce, answerLocked, KEY_NOT_SENT, seenNext, approvalPlan } from "./approve.js";
import { openTerminalWindow } from "./terminal-window.js";
import { icon } from "./icons.js";
import { starGroups, mailList, newsSince, planetsFor, clamp01, easeOut, orderSystems, moveOrder, warpLines, warpCurve, ringsAr, warpVeil } from "./mosses-model.js";

const A = "mods/hansol/mosses";
const KO = "Malgun Gothic", MONO = "Consolas";
const RADIUS = 8, TICK_MS = 40, SLOW_MS = 5000, MOVE_MS = 1500, BOOT_MS = 2400, IN_MS = 500, LOCK_MS = 380, TILT = 0.42;
// 2026-11-27 warp (a press on a planet), an agent's arrival / departure, the turning of the radar plane (a drag on the empty floor)
const WARP_MS = 1100, WARP_SWITCH = 550, FX_MS = 900, TILT_MIN = 0.12, TILT_MAX = 0.9, ORBIT_MS = 33;
// 2026-11-26 the colours of the concept picture (navy glass, a cyan accent, pale thin lines): the same set as P of common.js, so the windows match
const WORK = "#3ee6d2"; // 2026-11-27 working stands out from idle: brighter, moving; idle is dimmed
// Around a moon each mark has its own lane (px past the moon's edge), so they never cross (2026-11-27):
// the state ring (ask pulse included), working or shell arcs (never both: one state), the selected ring, the sub-agents' dots.
const MENU_W = 236, MENU_H = 38; // the planet menu's buttons
const LANE = { ring: 4, act: 10, mark: 14, sub: 21 }, MARKS_MAX = 10; // (more than 10: the count stays on the name plate)
// The band's labels in English (2026-11-27: no Korean on the top band; the Korean name stays in the tooltip)
const BAND_EN = { blocked: "APPROVAL", working: "WORKING", done: "DONE", idle: "IDLE", shell: "SHELL" };
const SHELL_C = "#c4a8ff";
const sc = (key) => (key === "working" ? WORK : (STATE[key] ?? STATE.idle).color);
// A card's state bar: working = wider and breathing, idle = faint.
const stateBar = (key) => div().flex_none().w(key === "working" ? 4 : 3).h(40).rounded(1).bg(sc(key) + (key === "idle" ? "66" : "")).when(key === "working", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1100 }));
const CARD_BG = { blocked: "#2a1c0ccc", working: "#0b2b2ee6" }, CARD_EDGE = { blocked: STATE.blocked.color + "aa", working: WORK + "66" };
const EDGE = "#56d3ea", GLASS = "#0a1323d9", GLASS_HEAD = "#101d33e6", RULE = "#8fb4d833", ROSE = "#f0788a", PALE = "#a9c4e4";
const pad2 = (n) => String(n).padStart(2, "0");
const hms = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const cap = (t, c) => div().flex_none().whitespace_nowrap().text_size(10.5).font_weight(500).text_color(c ?? P.muted).child(String(t));
const nameOf = (a) => a.name || platform(a).name;
const taskOf = (a) => { const t = a.status === "blocked" ? String(blockedText(a) ?? "") : ""; const v = t || activityText(a); return v === nameOf(a) ? "" : v; };
const paint = (path, bg) => globalThis.window.paint_path(path.build(), bg);
const glowKey = (st) => (["working", "blocked", "done", "idle", "shell"].includes(st.key) ? st.key : "idle");
// ellipses (an orbit seen at an angle) into one path: list of [cx, cy, rx, ry]
function ellipses(list, dash) {
  let b = PathBuilder.stroke(1);
  if (dash) b = b.dash_array(dash);
  for (const [cx, cy, rx, ry] of list) for (let i = 0; i <= 72; i++) { const q = (i / 72) * Math.PI * 2, x = cx + rx * Math.cos(q), y = cy + ry * Math.sin(q); b = i ? b.line_to(x, y) : b.move_to(x, y); }
  return b;
}

// The one button shape: 26 px high, two opposite corners cut at 45 degrees (a path: fill + a 1 px line). kind: "line" | "ok" (amber, filled) | "no" (rose line).
const textW = (s, size) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? size : ch === " " ? size * 0.32 : size * 0.6), 0);
const cutBox = (w, h, c) => [[c, 0.5], [w - 0.5, 0.5], [w - 0.5, h - c], [w - c, h - 0.5], [0.5, h - 0.5], [0.5, c]]; // two opposite corners cut (top left, bottom right): a sharp, slanted plate
const wedge = (h, c, fill, line, right) => { const pts = right ? [[0, 0.5], [c - 0.5, 0.5], [c - 0.5, h - c], [0, h - 0.5]] : [[c, 0.5], [0.5, c], [0.5, h - 0.5], [c, h - 0.5]], at = (e) => e.absolute().left(0).top(0).w(c).h(h);
  return div().relative().flex_none().w(c).h(h).child(at(paint(PathBuilder.fill().add_polygon(pts, true), fill))).child(at(paint(PathBuilder.stroke(1).add_polygon(pts, false), line))); };
const cutRow = (el, h, c, fill, line, mid) => el.child(wedge(h, c, fill, line, false)).child(mid.flex_none().h(h).bg(fill).border_t(1).border_b(1).border_color(line)).child(wedge(h, c, fill, line, true));
function button(id, label, kind, press) {
  const amber = STATE.blocked.color, k = { line: ["#0f1c30d0", EDGE + "aa", "#e8f0fa", EDGE + "2e"], ok: [amber, "#ffd9a8", "#140c00", "#ffb45e"], no: ["#2a0c1cb0", ROSE + "bb", ROSE, ROSE + "30"] }[kind];
  const w = Math.ceil(textW(label, 12) + 34), h = 26, c = 10, pts = cutBox(w, h, c);
  return div().id(id).relative().flex_none().w(w).h(h).cursor_pointer()
    .child(paint(PathBuilder.fill().add_polygon(pts, true), k[0]).absolute().left(0).top(0).w(w).h(h))
    .child(paint(PathBuilder.stroke(1).add_polygon(pts, true), k[1]).absolute().left(0).top(0).w(w).h(h))
    .child(div().id(`${id}-in`).absolute().left(c).top(3).w(w - c * 2).h(h - 6).flex().items_center().justify_center().whitespace_nowrap().text_size(12).font_family(KO).font_weight(700).text_color(k[2]).hover((s) => s.bg(k[3])).child(label))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); press(cx); });
}
// A plate of translucent glass: a 1 px luminous line, a brighter title strip (a short bar, the title, a note on the right). A column; add the body to it.
function plate(title, note, accent) {
  return v_flex().w_full().bg(GLASS).border(1).border_color(accent ? accent + "88" : "#8fb4d83d").rounded(RADIUS).overflow_hidden()
    .child(h_flex().flex_none().h(28).px(12).gap(8).items_center().border_b(1).border_color(RULE).bg(GLASS_HEAD)
      .child(div().flex_none().w(2).h(10).bg(accent ?? EDGE)).child(cap(title, accent ?? "#dcecff")).child(div().flex_1()).child(cap(note ?? "")));
}
// Four thin corner marks round a box (the frame of an instrument)
function corners(el, w, h, colour, L = 14) {
  for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    el.child(div().absolute().left(sx ? w - L : 0).top(sy ? h - 1 : 0).w(L).h(1).bg(colour)).child(div().absolute().left(sx ? w - 1 : 0).top(sy ? h - L : 0).w(1).h(L).bg(colour));
  return el;
}

// ---- The orbits (2026-11-27, the 6th design). The moons move in a view of their own (a nested view: cx.new), which alone is redrawn about 25 times a second;
// the floor around it is not. A moon's place is a function of the clock only (angle = phase + 2 pi * now / period), so it is on its orbit in every frame.
// Everything in this view is a PATH: boxes, pictures and text are placed on whole screen dots (measured: a slow move shows as 1-dot jumps), a path is not.
// So the moons, their state rings, their trails and the lines to their name plates are paths, a few for all the moons together (the cost does not grow with the element count);
// the name plates (text) stand still on the floor. The floor's draw writes what there is to show into SCENE; this view reads it.
// yaw / tilt: the radar plane as turned by a drag (mzDragMove); ghosts: moons of agents just gone (their last place, fading out); last: id -> the moon's place drawn last.
const SCENE = { on: false, w: 0, h: 0, bodies: [], hot: null, yaw: 0, tilt: TILT, ghosts: [], last: new Map(), fxUntil: 0 };
const circle = (x, y, r, n = 18) => { const pts = []; for (let i = 0; i < n; i++) { const q = (i / n) * Math.PI * 2; pts.push([x + r * Math.cos(q), y + r * Math.sin(q)]); } return pts; };
const alpha = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
class MzOrbit extends View {
  // about 30 frames a second (the orbits are slow); 60 while something arrives, leaves or the plane is turned
  init(_p, cx) { let last = 0; cx.timer.every(16, (c) => { const t = Date.now(); if (!SCENE.on || herdrWindow()?.visible === false || t - last < (SCENE.fxUntil > t ? 15 : ORBIT_MS)) return; last = t; c.notify(); }); }
  render() {
    const W = SCENE.w, H = SCENE.h, el = div().absolute().left(0).top(0).w(W).h(H);
    const ms = Date.now(); SCENE.ghosts = SCENE.ghosts.filter((g) => ms - g.at < FX_MS);
    if (!SCENE.on || (!SCENE.bodies.length && !SCENE.ghosts.length && !SCENE.orbits?.length)) return el;
    SCENE.n = (SCENE.n ?? 0) + 1;
    const now = ms / 1000, T = SCENE.tilt, put = (b, colour) => el.child(paint(b, colour).absolute().left(0).top(0).w(W).h(H));
    const ARS = (SCENE.orbits ?? []).map((o) => ringsAr(o.A1, o.A2, o.R, o.nr, T));
    { const lines = new Map(), add = (key, pts) => { if (pts.length > 1) lines.set(key, (lines.get(key) ?? PathBuilder.stroke(1)).add_polygon(pts, false)); };
      (SCENE.orbits ?? []).forEach((o, i) => ARS[i].forEach((a) => { let run = [], front = []; // the far half fainter and hidden behind the planet's disc, the near half over it
        for (let j = 0; j <= 48; j++) { const q = Math.PI + (j / 48) * Math.PI, px = o.cx + a * Math.cos(q), py = o.cy + a * T * Math.sin(q); if (Math.hypot(px - o.cx, py - o.cy) < o.R - 1) { add(o.colour + "3c", run); run = []; } else run.push([px, py]); }
        add(o.colour + "3c", run);
        for (let j = 0; j <= 48; j++) { const q = (j / 48) * Math.PI; front.push([o.cx + a * Math.cos(q), o.cy + a * T * Math.sin(q)]); }
        add(o.colour + "8a", front); }));
      for (const [colour, b] of lines) put(b, colour); }
    let dark = PathBuilder.fill(), lit = PathBuilder.fill(), lead = PathBuilder.stroke(1), ends = PathBuilder.fill(), hot = null, mark = null, sub = null, shell = null, act = null, subRim = null, shRim = null, shDot = null, nBody = 0;
    const at = new Map(), burst = []; SCENE.last = new Map();
    const trail = [PathBuilder.stroke(1.6), PathBuilder.stroke(1.4), PathBuilder.stroke(1.2)], used = [0, 0, 0], rings = new Map(), hits = [];
    const fx = (SCENE.fx ?? 0) > ms, B = SCENE.bodies;
    for (const b of SCENE.bodies) {
      b.ar = ARS[b.si]?.[b.k] ?? b.R * 2;
      const q = b.phase + SCENE.yaw + (now / b.period) * Math.PI * 2, s = Math.sin(q), x = b.cx + b.ar * Math.cos(q), y = b.cy + b.ar * T * s;
      const born = b.born ? clamp01((ms - b.born) / FX_MS) : 1, grow = born < 1 ? easeOut(born / 0.6) * (1 + 0.3 * Math.sin(Math.PI * clamp01(born / 0.8))) : 1; // arriving: grows from a point, overshoots a little
      const rr = (b.z / 2) * (1 + 0.16 * s) * grow;
      if (born < 1) { SCENE.fxUntil = Math.max(SCENE.fxUntil, ms + 50); burst.push([x, y, rr, born, EDGE]); }
      const under = (px, py, sn) => sn < 0 && Math.hypot(px - b.cx, py - b.cy) < b.R - 1; // behind the planet's disc
      if (born >= 0.5) for (let k = 0; k < 3; k++) { const pts = []; // the trail: three pieces along the orbit behind the moon, each fainter
        for (let i = 0; i <= 5; i++) { const a = q - (k * 5 + i) * 0.045, sn = Math.sin(a), px = b.cx + b.ar * Math.cos(a), py = b.cy + b.ar * T * sn; if (!under(px, py, sn)) pts.push([px, py]); }
        if (pts.length > 1) { trail[k] = trail[k].add_polygon(pts, false); used[k]++; } }
      { const ex = b.lx - 28, runs = [[[b.lx, b.ly], [ex, b.ly]]]; let run = runs[0];
        for (let i = 1; i <= 14; i++) { const px = ex + ((x - ex) * i) / 14, py = b.ly + ((y - b.ly) * i) / 14;
          if (s < 0 && Math.hypot(px - b.cx, py - b.cy) < b.R + 4) run = null; else { if (!run) { run = []; runs.push(run); } run.push([px, py]); } }
        const isHot = SCENE.hot === b.a.id;
        for (const pts of runs) if (pts.length > 1) { if (isHot) hot = (hot ?? PathBuilder.stroke(1.4)).add_polygon(pts, false); else lead = lead.add_polygon(pts, false); }
        ends = ends.add_polygon(circle(b.lx, b.ly, 1.6, 8), true); }
      at.set(b.a.id, [x, y]);
      if (under(x, y, s)) continue;
      SCENE.last.set(b.a.id, { x, y, rr, colour: stateOf(b.a).color });
      nBody++;
      { const nSub = fx && b === B[0] ? 3 : Number(b.a.helpers) || 0, nSh = fx && b === B[0] ? 2 : Number(b.a.shells) || 0, m = Math.min(MARKS_MAX, nSub + nSh);
        for (let i = 0; i < m; i++) { // as many markers as sub-agents and shells, evenly spaced round the moon (cyan dot = sub-agent, violet square = shell)
          const q2 = now * 0.9 + (i / m) * Math.PI * 2, mx = x + (rr + LANE.sub) * Math.cos(q2), my = y + (rr + LANE.sub) * Math.sin(q2);
          if (i < Math.min(nSub, m)) { subRim = (subRim ?? PathBuilder.fill()).add_polygon(circle(mx, my, 4.6, 12), true); sub = (sub ?? PathBuilder.fill()).add_polygon(circle(mx, my, 3.4, 12), true); }
          else { shRim = (shRim ?? PathBuilder.fill()).add_polygon([[mx - 4.4, my - 4.4], [mx + 4.4, my - 4.4], [mx + 4.4, my + 4.4], [mx - 4.4, my + 4.4]], true); shDot = (shDot ?? PathBuilder.fill()).add_polygon([[mx - 3.2, my - 3.2], [mx + 3.2, my - 3.2], [mx + 3.2, my + 3.2], [mx - 3.2, my + 3.2]], true); } }
        if (stateOf(b.a).key === "shell" || (fx && b === B[1])) for (let k = 0; k < 3; k++) { const pts = []; // a shell command waits: three arcs turning round the moon
          for (let i = 0; i <= 6; i++) { const q2 = now * 1.3 + (k / 3) * Math.PI * 2 + i * 0.15; pts.push([x + (rr + LANE.act) * Math.cos(q2), y + (rr + LANE.act) * Math.sin(q2)]); }
          shell = (shell ?? PathBuilder.stroke(1.6)).add_polygon(pts, false); } }
      { const a = b.a, d = Math.max(30, rr * 2 + 18); // the moon itself is pressed like its name plate (a box on whole dots is fine for a target)
        hits.push(div().id(`mz-b-${a.id}`).absolute().left(x - d / 2).top(y - d / 2).w(d).h(d).rounded(d / 2).cursor_pointer().hover((h2) => h2.bg(EDGE + "24"))
          .tooltip(`${taskOf(a) || nameOf(a)} — 눌러서 열기`).on_hover((hv) => { if (hv) SCENE.hot = a.id; else if (SCENE.hot === a.id) SCENE.hot = null; })
          .on_mouse_down("left", (_e, c) => c.stop_propagation()).on_click((_e, c) => { c.stop_propagation(); SCENE.open?.(a, c); })); }
      dark = dark.add_polygon(circle(x, y, rr), true); lit = lit.add_polygon(circle(x - rr * 0.28, y - rr * 0.28, rr * 0.55, 14), true);
      const ask = b.a.status === "blocked", sk = stateOf(b.a).key, work = sk === "working", key = sc(sk) + (b.sel || ask || work ? "ff" : sk === "idle" ? "70" : "e0");
      rings.set(key, (rings.get(key) ?? PathBuilder.stroke(work ? 1.8 : 1.4)).add_polygon(circle(x, y, rr + LANE.ring + (ask ? 1.4 * (1 + Math.sin(now * 4.5)) : work ? 0.8 * (1 + Math.sin(now * 1.6)) : 0), 24), true));
      if (work) for (let k = 0; k < 2; k++) { const pts = []; // working: two bright arcs turning round the moon (idle has none)
        for (let i = 0; i <= 10; i++) { const q2 = now * 2.6 + k * Math.PI + i * 0.17; pts.push([x + (rr + LANE.act) * Math.cos(q2), y + (rr + LANE.act) * Math.sin(q2)]); }
        act = (act ?? PathBuilder.stroke(2.2)).add_polygon(pts, false); }
      if (b.sel || SCENE.hot === b.a.id) mark = (mark ?? PathBuilder.stroke(1.2).dash_array([3, 3])).add_polygon(circle(x, y, rr + LANE.mark, 32), true); // the marked one: a dashed cyan ring
    }
    trail.forEach((b, k) => { if (used[k]) put(b, PALE + ["8c", "4a", "20"][k]); });
    put(lead, PALE + "30"); put(ends, EDGE + "90");
    if (hot) put(hot, EDGE);
    if (nBody) { put(dark, "#16243a"); put(lit, "#8ea6c2"); }
    if (mark) put(mark, EDGE);
    for (const [colour, b] of rings) put(b, colour);
    if (subRim) put(subRim, "#06121f"); if (shRim) put(shRim, "#06121f"); // (a dark rim keeps the markers readable on a planet)
    if (sub) put(sub, "#7ff0ff");
    if (shDot) put(shDot, "#c4a8ff");
    if (shell) put(shell, "#b59cff");
    if (act) put(act, WORK);
    const dots = (x, y, r, n, size, spin) => { let d = PathBuilder.fill(); for (let i = 0; i < n; i++) { const q = spin + (i / n) * Math.PI * 2; d = d.add_polygon(circle(x + r * Math.cos(q), y + r * 0.8 * Math.sin(q), size, 6), true); } return d; };
    for (const [x, y, rr, p, colour] of burst) { const e = easeOut(p), o = 1 - p; // an agent arrives: two rings open out, sparks fall in onto the moon
      put(PathBuilder.stroke(1.8).add_polygon(circle(x, y, rr + 4 + 38 * e, 32), true), colour + alpha(o));
      put(PathBuilder.stroke(1.2).add_polygon(circle(x, y, rr + 3 + 18 * e, 28), true), "#ffffff" + alpha(o * 0.8));
      put(dots(x, y, rr + 6 + 44 * (1 - e), 8, 1.8, p * 2), "#dff8ff" + alpha(o)); }
    for (const g of SCENE.ghosts) { const p = clamp01((ms - g.at) / FX_MS), e = easeOut(p), o = 1 - p; SCENE.fxUntil = Math.max(SCENE.fxUntil, ms + 50); // an agent leaves: the moon shrinks away, a ring and sparks fly out
      if (p < 0.7) { put(PathBuilder.fill().add_polygon(circle(g.x, g.y, g.rr * (1 - p / 0.7)), true), "#16243a"); put(PathBuilder.stroke(1.4).add_polygon(circle(g.x, g.y, (g.rr + 4) * (1 - p / 0.7), 24), true), g.colour + alpha(o)); }
      put(PathBuilder.stroke(1.6).add_polygon(circle(g.x, g.y, g.rr + 4 + 46 * e, 32), true), ROSE + alpha(o * 0.9));
      put(dots(g.x, g.y, g.rr + 6 + 42 * e, 10, 2 * o + 0.4, 0.3), "#ffd6de" + alpha(o)); }
    { let link = null, pulse = null; // work handed from one agent to another: a dashed line from the leader's moon, a dot running along it
      for (const [from, to] of [...(SCENE.links ?? []), ...(fx && B.length > 2 ? [[B[B.length - 1].a.id, B[B.length - 2].a.id]] : [])]) { const p0 = at.get(from), p1 = at.get(to); if (!p0 || !p1) continue;
        link = (link ?? PathBuilder.stroke(1.2).dash_array([4, 4])).add_polygon([p0, p1], false);
        const f = (now * 0.4) % 1; pulse = (pulse ?? PathBuilder.fill()).add_polygon(circle(p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, 2.4, 10), true); }
      if (link) put(link, EDGE + "aa");
      if (pulse) put(pulse, "#ffffff"); }
    for (const hit of hits) el.child(hit);
    { const c = SCENE.carry; if (c?.d?.on && c.d.px != null) el.child(image(c.src).absolute().left(c.d.px - c.x0 - c.size / 2).top(c.d.py - c.y0 - c.size / 2).w(c.size).h(c.size).opacity(0.85)); }
    return el;
  }
}

// ---- The warp between the views (2026-11-27): star streaks fly out of the pressed planet (or fall back in, leaving a system), a flash, then the new view.
// Its own view, redrawn only while it runs (the floor is not); the view itself changes at WARP_SWITCH, under the flash.
const WARP = { at: 0, x: 0, y: 0, inward: false, w: 0, h: 0, slow: 1 };
class MzWarp extends View {
  init(_p, cx) { cx.timer.every(16, (c) => { if (Date.now() - WARP.at < WARP_MS * WARP.slow + 40 && herdrWindow()?.visible !== false) c.notify(); }); }
  render() {
    const t = (Date.now() - WARP.at) / WARP.slow, W = WARP.w, H = WARP.h, el = div().absolute().left(0).top(0).w(W).h(H);
    if (t < 0 || t >= WARP_MS || !W) return el;
    const p = t / WARP_MS, k = warpCurve(p), veil = warpVeil(p), inn = WARP.inward, half = p < 0.5;
    const go = easeOut(clamp01(p / 0.5)), ox = WARP.x + (W / 2 - WARP.x) * go, oy = WARP.y + (H / 2 - WARP.y) * go, D = Math.hypot(W, H), R = D * 0.6;
    const put = (b, colour) => el.child(paint(b, colour).absolute().left(0).top(0).w(W).h(H));
    // the planet: entering, the camera dives into it (it grows past the screen); leaving, it falls away from the camera into the middle
    const pl = WARP.look;
    if (pl?.src) { const q = inn ? (half ? 0 : clamp01((p - 0.5) / 0.5)) : clamp01(p / 0.5), sz = inn ? pl.size * 3.2 * (1 - easeOut(q)) + 8 : pl.size * (1 + 11 * q * q * q);
      const px = inn ? W / 2 : WARP.x + (W / 2 - WARP.x) * easeOut(q), py = inn ? H / 2 : WARP.y + (H / 2 - WARP.y) * easeOut(q), o = inn ? (half ? 0 : 1 - q * q) : 1 - clamp01((p - 0.32) / 0.18);
      if (o > 0.01 && (inn ? !half : half)) el.child(image(pl.src).absolute().left(px - sz / 2).top(py - sz / 2).w(sz).h(sz).opacity(o)); }
    el.child(div().absolute().left(0).top(0).w(W).h(H).bg("#01030c").opacity(veil));
    // the star streaks in three depths: far ones thin and slow, near ones thick, bright at the head, tinted cyan and violet
    for (const [n, f, w0, colour, o] of [[90, 0.75, 0.9, "#9fb8ff", 0.55], [70, 1, 1.4, "#dff2ff", 0.9], [26, 1.25, 2.6, EDGE, 1]]) {
      let tail = PathBuilder.stroke(w0), head = PathBuilder.stroke(w0 * 1.5);
      for (const [[x0, y0], [x1, y1]] of warpLines(Math.min(1.2, p * f), n, ox, oy, R * f, inn)) {
        const far = Math.hypot(x1 - ox, y1 - oy) >= Math.hypot(x0 - ox, y0 - oy), [hx, hy] = far ? [x1, y1] : [x0, y0], [bx, by] = far ? [x0, y0] : [x1, y1];
        tail = tail.add_polygon([[bx, by], [hx, hy]], false); head = head.add_polygon([[bx + (hx - bx) * 0.7, by + (hy - by) * 0.7], [hx, hy]], false); }
      put(tail, colour + alpha(k.streak * o * 0.45)); put(head, colour + alpha(k.streak * o)); }
    // the core: a soft glow where the streaks come from; after the switch a ring of light opens out (no white flash over the screen)
    const g = 60 + 260 * k.streak;
    el.child(image(`${A}/glow-white.png`).absolute().left(ox - g / 2).top(oy - g / 2).w(g).h(g).opacity(0.5 * k.streak));
    if (!half) { const q = clamp01((p - 0.5) / 0.5), r = 20 + D * 0.55 * easeOut(q), o = (1 - q) ** 1.5;
      put(PathBuilder.stroke(2.4).add_polygon(circle(W / 2, H / 2, r, 72), true), EDGE + alpha(o * 0.8));
      put(PathBuilder.stroke(1).add_polygon(circle(W / 2, H / 2, r * 0.82, 64), true), "#dff2ff" + alpha(o * 0.5));
      el.child(image(`${A}/glow-blue.png`).absolute().left(W / 2 - r).top(H / 2 - r).w(r * 2).h(r * 2).opacity(o * 0.35)); }
    return el;
  }
}

export class MossesPart {
  mzInit() {
    if (!this.mz) this.mz = { t0: Date.now(), bootAt: Date.now(), prev: null, busyUntil: Date.now() + BOOT_MS + 2000, slowAt: 0, answering: new Map(), log: [], lastSel: null, selAt: 0, booted: false, placed: new Set() };
  }
  // The clock, started from init (main.js; a timer made in a draw never redraws). While something moves it redraws every 40 ms; otherwise every second (the orbits).
  mzStartTimer(cx) {
    try { this.mzOrbit = cx.new(MzOrbit); } catch (e) { this.mzOrbit = null; }
    try { this.mzWarp = cx.new(MzWarp); } catch (e) { this.mzWarp = null; }
    cx.timer.every(TICK_MS, (c) => {
      const m = this.mz;
      if (!m || !this.isMosses() || shared("hansol.view") === "board") { SCENE.on = false; return; } // (the board shows no floor: nothing to move, the orbits' view stops too)
      const now = Date.now();
      if (now < m.busyUntil) { c.notify(); return; }
      if (now - m.slowAt >= SLOW_MS) { m.slowAt = now; c.notify(); }
    });
  }
  mzBusy(ms) { this.mz.busyUntil = Math.max(this.mz.busyUntil, Date.now() + ms); }
  mzLog(text, colour) { const m = this.mz; m.log.push({ at: Date.now(), text: String(text), colour }); if (m.log.length > 40) m.log.shift(); }
  // One press on a satellite: it is locked and its channel opens (an App agent's terminal window; anyone else's conversation).
  mzOpen(a, cx) {
    this.selId = a.id; this.panel = null; this.open = false; this.termPick = null;
    setShared("hansol.sel", a.id);
    if (a.source === "app" && a.address && !this.demo?.()) openTerminalWindow(a.address, a.name || a.title || a.address); else this.openChat?.(a);
    this.mzLog(`채널 개방 · ${nameOf(a)}`);
    cx.notify();
  }
  // An App agent with an address can be answered from here (the keys go to its screen); a TUI agent is answered in its own terminal.
  mzCanAnswer(a) { return !!this.demo?.() || (a.source === "app" && !!a.address); }
  // No second press while an answer is on its way or just over: the lock is approve.js answerOnce's (shared "hansol.mzAnswered" by address),
  // the same one the terminal window's head and the approval cards use. (The demo has no address: its lock is local.)
  mzAnswering(a) { const t = this.mz.answering.get(a.id); return (t != null && (t === 0 || Date.now() - t < 6000)) || answerLocked(shared("hansol.mzAnswered")?.[a.address]); }
  mzAnswer(a, want, cx) {
    const m = this.mz, yes = want === "yes", who = nameOf(a), word = typeof want === "object" ? `선택 ${want.n}` : yes ? "승인" : "거절";
    if (!this.mzCanAnswer(a)) { this.mzLog(`응답 불가 · ${who} · 자기 터미널에서 응답 필요`, STATE.blocked.color); cx.notify(); return; }
    if (this.mzAnswering(a)) return;
    this.mzLog(`${word} 송신 · ${who}`);
    const done = (res, c2) => {
      const ok = !!res?.ok;
      if (res?.reason === "locked") { c2.notify(); return; } // another surface was pressed first: its answer stands
      if (ok) { try { const prev = shared("hansol.seenstate") ?? {}, n = seenNext({ ...a, status: "working" }, prev[a.id]); if (n) setShared("hansol.seenstate", { ...prev, [a.id]: n }); } catch {} } // (as the approval card, detail.js: the other copies hide their buttons)
      this.mzLog(ok ? `${word} 수신 확인 · ${who}` : KEY_NOT_SENT.has(res?.reason) ? `송신 실패 · ${who} · 터미널에서 직접 응답 필요` : `응답 확인 안 됨 · ${who} · 터미널 화면 확인 필요`, ok ? STATE.done.color : ROSE);
      if (!ok) { try { notify(KEY_NOT_SENT.has(res?.reason) ? { title: "응답 전송 실패", body: `${who} · 터미널에서 직접 응답해 주세요.` } : { title: "응답 확인 안 됨", body: `${who} · 터미널 화면을 확인해 주세요.` }); } catch {} }
      this.mzBusy(6400); c2.notify();
    };
    if (this.demo?.()) { m.answering.set(a.id, 0); cx.timer.after(900, (c2) => { m.answering.set(a.id, Date.now()); done({ ok: true }, c2); }); cx.notify(); return; }
    const store = { get: () => shared("hansol.mzAnswered"), set: (all) => setShared("hansol.mzAnswered", all) };
    cx.spawn(async (c2) => done(await answerOnce({ hc, sleep: (ms) => c2.sleep(ms) }, store, a.address, want), c2));
    this.mzBusy(32000); // (the "sending" line is redrawn until the answer is over)
    cx.notify();
  }


  // ---- the two views. CLUSTER: every planetary system (work space). SYSTEM: one entered system, its planet big, its satellites with their data.
  // The view is shared ("hansol.mzView": { key }) because the band (its own copy of this class) shows and changes it too.
  // 2026-11-27 a planet's right-press menu (RADAR: a callout tied to the planet; BOARD: the column head's planet). Later features add an item in mzMenuItems.
  mzMenuItems(s) { // one item per feature; a feature with more to it opens its own window (Git: changes, remote and tools are sides of the Git window)
    return [["git", "GIT", "커밋 그래프 · 변경, 원격, 도구는 Git 창에서", (cx) => this.gitOpenFor(s.units, s.title, cx)]];
  }
  // The menu's rows [{ el, h, btn }]: the system's name, then per section a small head and its buttons (each button gets a stub line from the spine).
  mzMenuRows(id, s, done) {
    const btn = (k, label, sub, act) => h_flex().id(`${id}-${k}`).w(MENU_W).h(MENU_H).px(10).gap(8).items_center().rounded(3).bg("#0a1626ee").border(1).border_color(EDGE + "55").cursor_pointer()
      .hover((h) => h.bg("#12304af5").border_color(EDGE))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); done(cx); act(cx); }) // (on the press: a popover may close before a click completes)
      .child(div().flex_none().w(2).h(18).bg(EDGE + "aa"))
      .child(v_flex().min_w(0).gap(1).child(div().truncate().text_size(12.5).font_family(KO).font_weight(600).text_color("#f2f7fd").child(label)).child(div().truncate().text_size(10).font_family(KO).text_color(P.muted).child(sub)));
    const rows = [{ h: 22, el: h_flex().w(MENU_W).h(22).items_center().gap(7).child(div().text_size(9).text_color(EDGE).child("◆")).child(div().truncate().text_size(12.5).font_family(KO).font_weight(600).text_color("#f2f7fd").child(String(s.title))) }];
    for (const [k, label, sub, act] of this.mzMenuItems(s)) rows.push({ h: MENU_H, btn: true, el: btn(k, label, sub, act) });
    return rows;
  }
  mzMenuOpenAt(s, cx) { this.mzMenuOpen = { key: s.key, at: Date.now() }; cx.notify(); }
  mzMenuClose(cx) { if (!this.mzMenuOpen) return false; this.mzMenuOpen = null; cx.notify(); return true; }
  // RADAR: a callout out of the planet, as the name plates are tied to their moons: a line from the planet's edge, a spine, a stub to each button.
  mzCallout(lx, ly, s, cx0, cy0, R, w, h) { // -> a layer the size of the scene, put last on the floor (above the moons, the plates, the inbox and the list)
    const el = div().absolute().left(lx).top(ly).w(w).h(h);
    const rows = this.mzMenuRows("mz-menu", s, (c) => this.mzMenuClose(c)), GAP = 5, H2 = rows.reduce((t, r) => t + r.h + GAP, -GAP);
    const right = cx0 + R * 0.7 + 62 + MENU_W < w - 6, sgn = right ? 1 : -1, q = right ? -Math.PI / 4 : (-3 * Math.PI) / 4;
    const ax = cx0 + R * Math.cos(q), ay = cy0 + R * Math.sin(q), ex = ax + sgn * 26, ey = ay - 26, sx = ex + sgn * 22, bx = right ? sx + 14 : sx - 14 - MENU_W;
    const top = Math.max(6, Math.min(h - H2 - 6, ey - 30));
    let y = top, line = PathBuilder.stroke(1.2).add_polygon([[ax, ay], [ex, ey], [sx, ey]], false), lo = ey, hi = ey;
    const box = v_flex().absolute().left(bx - 8).top(top - 8).p(8).gap(GAP).rounded(6).bg("#07111ffa").border(1).border_color(EDGE + "55").shadow_lg(); // (solid: nothing under it shows through)
    for (const r of rows) { if (r.btn) { const my = y + r.h / 2; line = line.add_polygon(right ? [[sx, my], [bx, my]] : [[bx + MENU_W, my], [sx, my]], false); lo = Math.min(lo, my); hi = Math.max(hi, my); } box.child(r.el); y += r.h + GAP; }
    line = line.add_polygon([[sx, lo], [sx, hi]], false);
    el.child(paint(PathBuilder.stroke(1).dash_array([3, 3]).add_polygon(circle(cx0, cy0, R + 6, 48), true), EDGE + "66").absolute().left(0).top(0).w(w).h(h)); // the chosen planet
    el.child(box);
    el.child(paint(line, EDGE + "cc").absolute().left(0).top(0).w(w).h(h));
    el.child(paint(PathBuilder.fill().add_polygon(circle(ax, ay, 3.2, 12), true).add_polygon(circle(sx, ey, 2, 8), true), EDGE).absolute().left(0).top(0).w(w).h(h));
    return el;
  }
  // BOARD: the column head's planet opens the same rows in a popover, hung off a plain spine.
  mzMenuPopover(id, s, trigger) {
    const open = this.mzMenuOpen?.key === s.key && this.mzMenuOpen.board, done = (c) => this.mzMenuClose(c);
    const rows = this.mzMenuRows(id, s, done);
    return Popover.new(id).mouse_button("right").anchor("top_left").trigger(trigger)
      .open(!!open).on_open_change((o, cx) => { this.mzMenuOpen = o ? { key: s.key, at: Date.now(), board: true } : null; cx.notify(); })
      .content(div().ml(12).mt(4).p(8).rounded(6).bg("#07111ffa").border(1).border_color(EDGE + "55").shadow_lg() // (solid: the cards under it do not show through)
        .child(v_flex().pl(14).gap(5).border_l(1).border_color(EDGE + "cc")
          .children(rows.map((r) => r.btn ? h_flex().items_center().ml(-14).child(div().w(14).h(1).bg(EDGE + "cc")).child(r.el) : r.el))));
  }
  mzEnter(key) { setShared("hansol.mzView", { key: key ?? null, at: Date.now() }); }
  // The warp from (x, y) on the floor (a pressed planet; leaving: the middle), the view changing under its flash. One at a time.
  mzWarpStart(key, x, y, look = null) { if (Date.now() - WARP.at < WARP_MS * WARP.slow) return false; Object.assign(WARP, { at: Date.now(), x, y, inward: key == null, look, slow: WARP.nextSlow || 1, nextSlow: 0 }); return true; } // look: { src, size } the planet dived into / left
  mzWarpTo(key, x, y, cx, look = null) { if (this.mzWarpStart(key, x, y, look)) cx.timer.after(WARP_SWITCH * WARP.slow, () => this.mzEnter(key)); }

  // ---- dragging on the floor: the empty floor turns the radar plane (left / right: round, up / down: tilt); a planet in the cluster is moved to another place.
  mzDragMove(e, cx) {
    const m = this.mz, p = e?.local_position, d = m?.pdrag ?? m?.rdrag; if (!d || !p) return;
    if (e.pressed_button !== "left") { this.mzDragEnd(cx); return; } // the button went up outside the floor
    const dx = p.x - d.x, dy = p.y - d.y;
    if (!d.on && Math.hypot(dx, dy) < 5) return;
    const first = !d.on; d.on = true; SCENE.fxUntil = Date.now() + 300; // (the moons' view runs at 60 a second; the floor is redrawn only when what it shows changes)
    if (d === m.pdrag) { d.px = p.x; d.py = p.y; const g = m.grid, cell = g ? `${Math.floor((p.x - g.x) / g.cw)},${Math.floor((p.y - g.y) / g.ch)}` : "";
      if (first || cell !== d.cell) { d.cell = cell; cx.notify(); } return; } // the target cell's frame and the faded planet
    SCENE.tilt = Math.max(TILT_MIN, Math.min(TILT_MAX, d.tilt + dy * 0.003));
    SCENE.yaw = d.yaw + dx * 0.008;
    if (first) cx.notify(); // the "시점 초기화" button
  }
  mzDragEnd(cx) {
    const m = this.mz, pd = m?.pdrag, rd = m?.rdrag; if (!pd && !rd) return;
    m.pdrag = m.rdrag = null;
    if (pd?.on && m.grid && pd.px != null) { const g = m.grid; // where it was let go: the cell under the pointer
      const col = Math.max(0, Math.min(g.cols - 1, Math.floor((pd.px - g.x) / g.cw))), row = Math.max(0, Math.floor((pd.py - g.y) / g.ch)), to = Math.min(g.keys.length - 1, row * g.cols + col);
      if (to !== pd.i) { setShared("hansol.mzOrder", moveOrder(g.keys, pd.i, to)); this.mzLog(`작업 공간 위치 변경 · ${pd.title}`); } }
    if (pd?.on || rd?.on) this.dragAt = Date.now(); // (office.js justDragged: the click that ends a drag opens nothing)
    cx.notify();
  }

  // ---- the top band in the MOSSES layout (main.js band()): the mark, where you are (CLUSTER / SYSTEM), the state counts, the link, the switches
  mzBand(list, x) {
    const cur = starGroups(list).find((s) => s.key === shared("hansol.mzView")?.key), picked = shared("hansol.pick")?.state;
    const crumb = (id, label, on, press) => cutRow(h_flex().id(id).flex_none().items_center(), 24, 8, on ? EDGE + "1c" : "#00000000", on ? EDGE : "#00000000",
      h_flex().px(4).items_center().child(div().max_w(200).truncate().text_size(11).font_weight(600).text_color(on ? EDGE : P.muted).when(!!press, (e2) => e2.hover((s) => s.text_color("#ffffff"))).child(label)))
      .when(!!press, (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); press(); }));
    const chip = (st) => {
      const people = x.members(st.key), n = people.length, sel = picked === st.key && n > 0, hot = st.key === "blocked" && n > 0;
      const dot = div().flex_none().w(7).h(7).rounded(4).bg(st.color), num = div().flex_none().text_size(13).font_family(MONO).font_weight(700).text_color(st.color).child(pad2(n));
      return cutRow(h_flex().id(`pill-${st.key}`).flex_none().items_center(), 28, 9, sel ? st.color + "22" : "#0a132399", sel ? st.color : hot ? st.color + "88" : "#8fb4d82e",
        h_flex().px(3).gap(7).items_center().tooltip(st.label).when(n > 0, (el) => el.hover((s) => s.bg(st.color + "22")))
          .child(hot ? dot.loop("opacity", { from: 0.35, to: 1, period: 700 }) : dot)
          .when(!x.narrow, (el) => el.child(div().flex_none().text_size(11).font_weight(600).text_color(n ? P.ink : P.muted).child(BAND_EN[st.key] ?? st.label)))
          .child(num).when(!!x.caret(n), (el) => el.child(div().text_size(10).text_color(P.muted).child(x.caret(n)))))
        .when(n === 0, (el) => el.opacity(0.45)).when(n > 0, (el) => el.cursor_pointer())
        .on_mouse_down("left", (e) => { this.chipBox = e?.bounds ?? null; })
        .on_size_change((size) => { const w = Math.round(size?.width ?? 0), prev = shared("hansol.chipw") ?? {}; if (w > 0 && prev[st.key] !== w) setShared("hansol.chipw", { ...prev, [st.key]: w }); })
        .on_click((e) => this.pressChip(st, people, e));
    };
    const iconTool = (id, name, tip, colour) => cutRow(h_flex().id(id).flex_none().items_center().cursor_pointer().tooltip(tip), 28, 9, "#0a132399", "#8fb4d84d",
      h_flex().w(22).h(20).justify_center().items_center().hover((s) => s.bg(EDGE + "22")).child(icon(name, 15, colour)));
    const chatOn = shared("hansol.chatEnabled")?.on === true;
    const root = h_flex().id("hud-band").size_full().px(16).gap(12).items_center().bg("#0a1323").rounded(10).border(1).border_color("#8fb4d82e").text_color(P.ink)
      .on_size_change((size, cx) => { const was = this.bandW ?? 1920, now = size?.width ?? was; this.bandW = now; if ((was < 1500) !== (now < 1500) || (was < 1250) !== (now < 1250)) cx.notify(); })
      .child(div().flex_none().w(22).h(22).child(svg(`${A}/ring-seg.svg`).absolute().w(22).h(22).text_color(EDGE).spin(9000)).child(div().absolute().left(9).top(9).w(4).h(4).rounded(2).bg("#ffffff")))
      .child(div().flex_none().whitespace_nowrap().text_size(15).font_weight(700).text_color("#f2f7fd").child("MOSSES"))
      .when(!x.tight, (el) => el.child(cap("Spatial Workspace")))
      .child(h_flex().flex_none().ml(8).gap(2).items_center()
        .child(crumb("mz-crumb-cluster", "CLUSTER", !cur, cur ? () => this.mzEnter(null) : null))
        .child(div().text_size(11).text_color(P.line).child("/"))
        .child(crumb("mz-crumb-system", cur ? `SYSTEM · ${cur.title}` : "SYSTEM", !!cur, null)))
      .child(div().w(1).h(20).bg("#8fb4d82e").flex_none())
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().children(x.states.map((st) => chip(st))))
      .child(h_flex().flex_none().gap(6).items_center().child(div().w(6).h(6).rounded(3).bg(STATE.done.color).loop("opacity", { from: 0.4, to: 1, period: 1600 })).child(cap(`Linked · ${pad2(list.length)}`, P.ink)))
      .when(!!x.sw, (el) => { const view = shared("hansol.view") === "board" ? "board" : "office";
        const seg = (key, label) => div().id(`view-${key}`).flex_none().h(20).px(11).flex().items_center().rounded(2).text_size(11.5).font_weight(600).cursor_pointer()
          .bg(view === key ? EDGE + "26" : "#00000000").text_color(view === key ? EDGE : P.muted).hover((s) => s.text_color("#ffffff"))
          .on_click(() => { setShared("hansol.view.at", Date.now()); setShared("hansol.view", key); }).child(label);
        return el.child(cutRow(h_flex().flex_none().items_center(), 28, 9, "#0a132399", "#8fb4d84d", h_flex().gap(2).items_center().child(seg("office", "RADAR")).child(seg("board", "BOARD")))); })
      .child(iconTool("hansol-chat-option", "chat", chatOn ? "대화 탭: 켬 (누르면 끔)" : "대화 탭: 끔 (누르면 켬)", chatOn ? EDGE : EDGE + "77")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared("hansol.chatEnabled", { on: shared("hansol.chatEnabled")?.on !== true }); cx.notify(); }))
      .child(iconTool("hansol-settings", "settings", "설정: 레이아웃 선택 · Herdr 앱 설정", EDGE)
        .on_mouse_down("left", (e, cx) => { this.setBox = e?.bounds ?? null; cx.stop_propagation(); })
        .on_click(() => this.openSettingsMenu()));
    if (x.win) root.child(x.win);
    return div().size_full().px(10).py(6).bg("#050914").child(root);
  }

  // ---- the status line under the floor in the MOSSES layout (main.js footer())
  mzFooter(n, spaces, fresh) {
    const fact = (k, v) => h_flex().flex_none().gap(7).items_center().child(cap(k)).child(div().text_size(12.5).font_family(MONO).text_color("#f2f7fd").child(String(v)));
    return h_flex().id("hud-footer").size_full().px(20).gap(22).items_center().bg("#050914").border_t(1).border_color("#8fb4d81a").text_color(P.ink)
      .child(fact("SATELLITES", pad2(n))).child(fact("SYSTEMS", pad2(spaces))).child(h_flex().flex_none().gap(7).items_center().child(cap("SYNC")).child(div().text_size(11.5).text_color(P.muted).child(fresh)))
      .child(div().flex_1());
  }

  // The work spaces as systems in the person's order, with their agents by orbit (tab); shared by RADAR and BOARD.
  mzSystems(list) {
    const byId = new Map(list.map((a) => [a.id, a]));
    const systems = orderSystems(starGroups(list), shared("hansol.mzOrder")).map((s) => ({ ...s, rings: s.tabs.map((tb) => tb.ids.map((id) => byId.get(id)).filter(Boolean)).filter((r) => r.length) })).map((s) => ({ ...s, units: s.rings.flat() }));
    return { byId, systems, units: systems.flatMap((s) => s.units) };
  }
  // What both views keep up to date on every draw: each terminal's tab, the work history and the status rows (shared), the news (log, toasts).
  mzTrack(list, units, byId, now, cx) {
    const m = this.mz, amber = STATE.blocked.color;
    { const ids = Object.fromEntries(units.filter((a) => a.address).map((a) => [a.address, `T${a.tab || "-"}`])), key = JSON.stringify(ids); // each terminal's tab for the terminal windows' heads (never set in a draw)
      if (key !== m.idsKey) { m.idsKey = key; cx.timer.after(0, () => setShared("hansol.mzUnits", ids)); } }
    { const hist = (m.hist ??= JSON.parse(JSON.stringify(shared("hansol.mzHist") ?? {}))); let dirty = false; // what each agent worked on, as its work title changed (the last 8)
      for (const a of units) { const text = a.status === "blocked" ? "" : activityText(a), h = (hist[a.id] ??= []), last = h[h.length - 1];
        if (text && last?.text !== text) { h.push({ at: now, text }); if (h.length > 8) h.shift(); dirty = true; }
        else if (a.status === "done" && last && !last.done) { last.done = now; dirty = true; } }
      for (const id of Object.keys(hist)) if (!byId.has(id) && now - (hist[id][hist[id].length - 1]?.at ?? 0) > 86400000) { delete hist[id]; dirty = true; }
      const rows = units.map((a) => ({ id: a.id, address: a.source === "app" ? a.address ?? null : null, name: nameOf(a), space: String(a.island_title ?? a.space ?? ""), tab: a.tab ?? null, st: stateOf(a).key, task: taskOf(a), el: this.elapsedText?.(a) ?? "",
        helpers: Number(a.helpers) || 0, shells: Number(a.shells) || 0, parent: a.parent_id ?? null, kids: units.filter((x) => x.parent_id === a.id).length })), key = JSON.stringify(rows);
      if (dirty || key !== m.boardKey) { m.boardKey = key; const copy = JSON.parse(JSON.stringify(hist)); cx.timer.after(0, () => { setShared("hansol.mzBoard", { at: Date.now(), rows }); if (dirty) setShared("hansol.mzHist", copy); }); } }
    { const first = m.prev == null, { next, news } = newsSince(m.prev, list); m.prev = next;
      if (!first) for (const n of news) { const a = byId.get(n.id); if (a) this.mzLog(`${n.kind === "ask" ? "승인 요청 수신" : "작업 보고 수신"} · ${nameOf(a)}`, n.kind === "ask" ? amber : STATE.done.color);
        if (a && n.kind === "ask") { try { notify({ title: "승인 요청", body: `${String(blockedText(a) ?? "").slice(0, 80)} · ${String(a.island_title ?? a.space ?? "")}` }); } catch {} } } }
  }

  /** The whole MOSSES floor into `shell` (the office's root); returns this.floorTail(...). left: { width, height } of the floor. */
  mossesFloor(shell, list, sel, left, termOn, cx) {
    this.mzInit();
    const m = this.mz, now = Date.now();
    list = list ?? []; m.nFloor = (m.nFloor ?? 0) + 1;
    { const rq = shared("hansol.mosses"); if (rq?.at && rq.at !== m.cmdAt) { m.cmdAt = rq.at; if (now - rq.at < 15000) { // a review command (herdr-app do hansol.mosses:<what>, room.js)
      const [what, arg] = String(rq.cmd).split(":");
      if (what === "peek") m.peek = arg !== "off"; else if (what === "boot") { m.bootAt = now; this.mzBusy(BOOT_MS + 2000); } else if (what === "stat") cx.timer.after(0, () => setShared("hansol.mzStat", { n: SCENE.n ?? 0, floor: m.nFloor, draw: this.drawMs ?? null, at: Date.now() })); else if (what === "fx") SCENE.fx = now + 30000; else if (what === "openid") m.openId = String(rq.cmd).slice(7); else if (what === "lock") m.lockN = Number(arg) || 0; else if (what === "open") m.openN = Number(arg) || 0; else if (what === "enter") { m.enterN = arg == null ? -1 : Number(arg) || 0; WARP.nextSlow = Math.max(1, Number(String(rq.cmd).split(":")[2]) || 1); } // enter:<n>[:<slow>] (slow: the warp n times slower, for the review pictures) else if (what === "view") { const [, yw, tl] = String(rq.cmd).split(":"); SCENE.yaw = Number(yw) || 0; SCENE.tilt = Math.max(TILT_MIN, Math.min(TILT_MAX, Number(tl) || TILT)); } else if (what === "order") { const [, f, t] = String(rq.cmd).split(":"); m.orderReq = [Number(f) - 1, Number(t) - 1]; } // view:<yaw>:<tilt> = as a drag on the empty floor; order:<from>:<to> = as a planet dragged to another place (1-based) // enter:<n> = into the n-th system, enter:0 = back to the cluster // lock:<n> = lock the n-th satellite without opening its channel
    } } }
    const x0 = Math.max(this.termPanel && !this.demo?.() ? this.panelWidth() : 0, m.peek ? Math.round(left.width * 0.49) : 0); // peek: the review pictures (the console in the right half)
    const W = Math.max(0, left.width - this.fitMargin() - x0), H = left.height;
    // the view of space: the picture covers the floor, a layer of stars drifts across it (the carrier is under way)
    { const k = Math.max(left.width / 1920, left.height / 1200);
      shell.child(div().absolute().left(0).top(0).w(left.width).h(left.height).bg("#01030c").overflow_hidden()
        .child(image(`${A}/space.jpg`).absolute().left((left.width - 1920 * k) / 2).top((left.height - 1200 * k) / 2).w(1920 * k).h(1200 * k))
        .child(image(`${A}/stars.png`).absolute().top(0).w(1600).h(900).opacity(0.8).loop("left", { from: 0, to: -260, period: 120000 }))
        .child(image(`${A}/stars.png`).absolute().top(120).w(2240).h(1260).opacity(0.5).loop("left", { from: -80, to: -620, period: 120000 }))
        .child(image(`${A}/stars.png`).absolute().left(-420).top(-260).w(1920).h(1080).loop("opacity", { from: 0.05, to: 0.4, period: 5200 })) // the stars twinkle: two still layers that fade in and out at their own pace
        .child(image(`${A}/stars.png`).absolute().left(260).top(-90).w(2600).h(1460).loop("opacity", { from: 0.35, to: 0.04, period: 8600 }))); }
    if (W < 360 || H < 240) return this.floorTail(shell, list, sel, left, termOn, cx);

    // ---- the data: systems (work spaces), satellites (agents, numbered in the systems' order), incoming (waiting approvals)
    const { byId, systems, units } = this.mzSystems(list);
    if (m.orderReq) { const [f, t] = m.orderReq, keys = systems.map((s) => s.key); m.orderReq = null; cx.timer.after(0, () => setShared("hansol.mzOrder", moveOrder(keys, f, t))); }
    { const seen = (m.seen ??= new Set()), born = (m.born ??= new Map()), gone = (m.gone ??= new Map()), first = !m.seenInit; m.seenInit = true; // arrivals and departures (none on the first look)
      for (const a of units) if (!seen.has(a.id)) { seen.add(a.id); if (!first) { born.set(a.id, now); gone.delete(a.id); this.mzBusy(FX_MS); } }
      for (const id of [...seen]) if (!byId.has(id)) { seen.delete(id); born.delete(id); const at = SCENE.last.get(id), pl = m.plates?.get(id);
        if (at) SCENE.ghosts.push({ ...at, at: now }); if (pl) gone.set(id, { ...pl, at: now }); this.mzBusy(FX_MS); }
      for (const [id, t] of born) if (now - t > FX_MS) born.delete(id);
      for (const [id, g] of gone) if (now - g.at > FX_MS) gone.delete(id); }
    if (m.lockN) { const a = units[m.lockN - 1]; m.lockN = 0; if (a) { this.selId = a.id; sel = a.id; } }
    if (m.openId) { const a = units.find((x) => x.id === m.openId); m.openId = null; if (a) cx.timer.after(0, (c2) => this.mzOpen(a, c2)); }
    if (m.openN) { const a = units[m.openN - 1]; m.openN = 0; if (a) cx.timer.after(0, (c2) => this.mzOpen(a, c2)); } // open:<n> = as a press on the n-th satellite
    const alerts = mailList(list), amber = STATE.blocked.color;
    this.mzTrack(list, units, byId, now, cx);
    if (!m.booted && now - m.bootAt >= BOOT_MS) { m.booted = true; this.mzLog(`통신망 연결 · 행성계 ${systems.length} · 위성 ${units.length} · 수신 대기 ${alerts.length}`); }
    if (sel !== m.lastSel) { m.lastSel = sel; m.selAt = now; this.mzBusy(LOCK_MS + 700); }

    // ---- the frame: the scene (title, systems, the moons' own view) and one inbox
    const PAD = 22, X = x0 + PAD, AW = W - PAD * 2, TOP = 16, HEAD = 62, wide = AW >= 760;
    const RW = wide ? 380 : AW, PW = wide ? AW - RW - 18 : 0, SY = TOP + HEAD, SH = H - SY - 12;
    const root = div().id("mz-root").absolute().left(0).top(0).w(left.width).h(left.height)
      .on_mouse_down("right", (_e, c2) => this.mzMenuClose(c2))
      .on_mouse_down("left", (e, c2) => { this.mzMenuClose(c2); const p = e?.local_position; if (!p) return; c2.stop_propagation(); m.rdrag = { x: p.x, y: p.y, yaw: SCENE.yaw, tilt: SCENE.tilt, on: false }; }) // (a press on anything pressable stops before this)
      .on_mouse_move((e, c2) => this.mzDragMove(e, c2)).on_mouse_up("left", (_e, c2) => this.mzDragEnd(c2)).on_hover((h, c2) => { if (!h) this.mzDragEnd(c2); });
    root.child(div().id("mz-empty").absolute().left(0).top(0).w(left.width).h(left.height).on_click((_e, c2) => { if (this.justDragged?.()) return; c2.stop_propagation(); if (this.open || this.termPick || this.selId) this.closePanel(c2); }));
    WARP.w = left.width; WARP.h = left.height;
    if (m.enterN != null) { const k = m.enterN > 0 ? systems[m.enterN - 1]?.key : null; m.enterN = null; const L = m.look?.get(k), P0 = k ? m.platesAt?.get(k) : null; this.mzWarpTo(k, ...(P0 ? P0.slice(0, 2) : [X + PW / 2, SY + SH / 2]), cx, L != null ? { src: `${A}/planet-${L}.png`, size: P0?.[2] ?? 160 } : null); }
    const cur = systems.find((s) => s.key === shared("hansol.mzView")?.key) ?? null; // the entered system (null: the cluster)
    if (!cur && shared("hansol.mzView")?.key != null && m.booted) cx.timer.after(0, () => this.mzEnter(null)); // the entered system is gone: the view is the cluster for good
    if ((cur?.key ?? null) !== m.viewKey) { const first = m.viewKey === undefined; m.viewAt = first ? 0 : now; m.viewKey = cur?.key ?? null; this.mzBusy(1200); if (m.booted) this.mzLog(cur ? `행성계 진입 · ${cur.title}` : "성단 화면 복귀");
      if (!first && now - WARP.at > WARP_MS * WARP.slow) Object.assign(WARP, { at: now - WARP_SWITCH, x: X + PW / 2, y: SY + SH / 2, inward: !cur, look: null, slow: 1 }); } // changed elsewhere (the band's CLUSTER): the warp's second half
    const vp = easeOut((now - (m.viewAt ?? 0)) / 700); // the view's change: 0 -> 1
    if (cur) { const S = Math.round(left.height * (0.86 + 0.08 * vp)); // inside a system: its planet close by, low on the left
      shell.child(image(`${A}/limb.png`).absolute().left(x0 - Math.round(S * 0.08)).top(left.height - Math.round(S * 0.86)).w(S).h(S).opacity(0.6 * vp)); }
    m.mid = [X + PW / 2, SY + SH / 2];
    this.mzTitle(root, X, TOP, systems, units, cur);
    SCENE.on = false; this.mzTop = null;
    if (PW > 0) { this.mzScene(root, X, SY, PW, SH, systems, sel, cur);
      if (this.mzOrbit) root.child(div().absolute().left(X).top(SY).w(0).h(0).child(this.mzOrbit)); }
    this.mzChoices(alerts, cx);
    const shown = this.mzShown(alerts, now);
    this.mzInbox(root, X + (wide ? PW + 18 : 0), wide ? TOP : SY, RW, H - (wide ? TOP : SY) - 12, shown, units);
    shell.child(root);
    if (this.mzWarp) shell.child(div().absolute().left(0).top(0).w(0).h(0).child(this.mzWarp));
    if (now - m.bootAt < BOOT_MS) this.mzBoot(shell, x0, W, left, now - m.bootAt, systems.length, units.length, alerts.length);
    const out = this.floorTail(shell, list, sel, left, termOn, cx);
    if (this.mzTop) out.child(this.mzTop); // the planet menu: over everything on the floor
    return out;
  }

  // ---- the title: where you are (the cluster, or one system and the way back)
  mzTitle(root, x, y, systems, units, cur) {
        root.child(h_flex().absolute().left(x).top(y).gap(14).items_center()
      .child(div().flex_none().text_size(38).font_weight(200).text_color(PALE).child(cur ? "02" : "01"))
      .child(v_flex().gap(3)
        .child(div().whitespace_nowrap().text_size(22).font_weight(300).text_color("#f2f7fd").child(cur ? String(cur.title) : "OVERVIEW"))
        .child(cap(cur ? `PLANETARY SYSTEM  ·  ${cur.units.length} AGENTS  ·  ${cur.rings.length} TABS  ·  빈 곳 드래그: 시점 회전` : `STAR CLUSTER  ·  ${systems.length} WORKSPACES  ·  ${units.length} AGENTS  ·  행성 드래그: 위치 변경  ·  빈 곳 드래그: 시점 회전`)))
      .when(!!cur, (el) => el.child(div().ml(10).child(button("mz-back", "‹  모든 작업 공간", "line", (c2) => this.mzWarpTo(null, ...(this.mz.mid ?? [x, y]), c2, this.mz.look?.has(cur.key) ? { src: `${A}/planet-${this.mz.look.get(cur.key)}.png`, size: 300 } : null)))))
      .when(SCENE.yaw !== 0 || SCENE.tilt !== TILT, (el) => el.child(div().ml(cur ? 0 : 10).child(button("mz-view-reset", "시점 초기화", "line", (c2) => { SCENE.yaw = 0; SCENE.tilt = TILT; c2.notify(); })))));
  }

  // ---- the scene: each system's planet, orbit lines, name and name plates (all still), and what the moons' view needs (SCENE)
  mzScene(root, x, y, w, h, systems, sel, cur) {
    const big = !!cur, shown = big ? [cur] : systems, n = shown.length, amber = STATE.blocked.color;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), cw = w / cols, ch = h / rows, bodies = [];
    const el = div().absolute().left(x).top(y).w(w).h(h), lh = big ? 66 : 50, m = this.mz, now = Date.now(), pd = m.pdrag?.on && !big ? m.pdrag : null, orbits = [];
    m.grid = big ? null : { x, y, cw, ch, cols, keys: shown.map((s) => s.key) };
    const look = planetsFor(systems.map((s) => s.key)); // every work space its own planet (taken over the whole cluster, so it keeps it inside)
    m.plates = new Map(); // id -> its name plate as drawn (kept for the fade-out when the agent goes)
    SCENE.carry = null;
    let menuAt = null;
    if (pd) { const col = Math.max(0, Math.min(cols - 1, Math.floor((pd.px - x) / cw))), row = Math.max(0, Math.min(rows - 1, Math.floor((pd.py - y) / ch))); // a planet being moved: where it will land
      if (row * cols + col < n) el.child(div().absolute().left(cw * col + 6).top(ch * row + 6).w(cw - 12).h(ch - 12).rounded(RADIUS).border(1).border_color(EDGE + "aa").bg(EDGE + "10")); }
    shown.forEach((s, i) => {
      const col = i % cols, row = Math.floor(i / cols), nr = s.rings.length, ox = big ? 0 : cw * col, oy = big ? 0 : ch * row, vw = big ? w : cw, vh = big ? h : ch;
      const lw = Math.max(170, Math.min(big ? 340 : 250, vw * (big ? 0.27 : 0.35) - 14)), lx0 = ox + vw - lw - 8;
      const cx0 = ox + (lx0 - ox) * 0.5, cy0 = oy + vh * 0.5 + (big ? 0 : 18);
      const A1 = (lx0 - ox) * 0.5 - 26, A2 = vh * 0.5 - (big ? 40 : 58), aRef = Math.max(60, Math.min(A1, A2 / TILT)); // the planet sized at the usual tilt: turning never resizes it
      const R = Math.max(20, Math.min(big ? 130 : 54, aRef * (big ? 0.34 : 0.3))), IMG = R * 3.2, si = orbits.length;
      if (!big) (m.platesAt ??= new Map()).set(s.key, [x + cx0, y + cy0, IMG]);
      const ask = s.units.filter((a) => a.status === "blocked").length, done = s.units.filter((a) => a.status === "done").length;
      if (this.mzMenuOpen?.key === s.key && !this.mzMenuOpen.board) menuAt = [s, cx0, cy0, R];
      orbits.push({ cx: cx0, cy: cy0, R, A1, A2, nr, colour: ask ? amber : PALE }); // the orbit lines follow the tilt: drawn by the moons' view (MzOrbit), not here
      el.child(image(`${A}/glow-blue.png`).absolute().left(cx0 - R * 2.6).top(cy0 - R * 2.6).w(R * 5.2).h(R * 5.2).opacity(0.3).loop("opacity", { from: 0.2, to: 0.36, period: 7000 }));
      const moving = pd?.key === s.key;
      el.child(image(`${A}/planet-${look.get(s.key)}.png`).absolute().left(cx0 - IMG / 2).top(cy0 - IMG / 2).w(IMG).h(IMG).opacity(moving ? 0.3 : 1));
      if (big) el.child(div().id("mz-big-hit").absolute().left(cx0 - R).top(cy0 - R).w(R * 2).h(R * 2).rounded(R).on_mouse_down("right", (_e, c2) => { c2.stop_propagation(); this.mzMenuOpenAt(s, c2); })); // the entered planet: only the right-press menu (a left drag still turns the view)
      if (!big) { // a press on the planet (or the system's name) warps into it; a drag on the planet moves the system to another place
        const go = (c2) => { if (this.justDragged?.()) return; this.mzWarpTo(s.key, x + cx0, y + cy0, c2, { src: `${A}/planet-${look.get(s.key)}.png`, size: IMG }); };
        el.child(div().id(`mz-enter-${i}`).absolute().left(cx0 - R).top(cy0 - R).w(R * 2).h(R * 2).rounded(R).cursor_pointer().border(1).border_color("#00000000").hover((s2) => s2.border_color(EDGE))
          .tooltip(`${s.title} — 눌러서 진입 · 끌어서 위치 변경 · 오른쪽 클릭: 메뉴`).on_mouse_down("right", (_e, c2) => { c2.stop_propagation(); this.mzMenuOpenAt(s, c2); })
          .on_mouse_down("left", (e, c2) => { c2.stop_propagation(); const p = e?.local_position; if (!p) return; // in the root's coordinates (the moves are read on the root)
            m.pdrag = { key: s.key, i, title: s.title, x: x + cx0 - R + p.x, y: y + cy0 - R + p.y, on: false }; })
          .on_click((_e, c2) => { c2.stop_propagation(); go(c2); }));
        el.child(v_flex().id(`mz-sys-${i}`).absolute().left(ox + 4).top(oy + 6).gap(3).cursor_pointer().on_mouse_down("left", (_e, c2) => c2.stop_propagation()).on_click((_e, c2) => { c2.stop_propagation(); go(c2); })
          .child(div().max_w(vw - 30).truncate().text_size(17).font_weight(600).text_color("#f2f7fd").child(String(s.title)))
          .child(h_flex().gap(8).items_center().child(cap(`${s.units.length} Agents`)).when(ask > 0, (e2) => e2.child(cap(`승인 대기 ${ask}`, amber))).when(done > 0, (e2) => e2.child(cap(`작업 보고 ${done}`, STATE.done.color)))));
        if (moving) SCENE.carry = { src: `${A}/planet-${look.get(s.key)}.png`, size: IMG, x0: x, y0: y, d: pd }; // the planet under the pointer: drawn by MzOrbit as the pointer moves (the floor is not redrawn)
      }
      // the name plates: a still column beside the system (text that moves is placed on whole dots and shakes); a thin line ties each to its moon
      const flat = s.rings.flatMap((ring, k) => ring.map((a, j) => ({ a, k, j, of: ring.length }))), fit = Math.max(1, Math.floor((vh - (big ? 30 : 70)) / lh)), list = flat.slice(0, flat.length > fit ? fit - 1 : fit);
      const y0 = Math.max(oy + (big ? 10 : 56), cy0 - (Math.min(flat.length, fit) * lh) / 2);
      list.forEach(({ a, k, j, of }, li) => {
        const st = stateOf(a), isAsk = a.status === "blocked", task = taskOf(a), on = a.id === sel, ly = y0 + li * lh, born = m.born?.get(a.id), work = st.key === "working", idle = st.key === "idle", colr = sc(st.key);
        m.plates.set(a.id, { lx: lx0, ly, lw, lh, text: task || nameOf(a), colour: colr, view: m.viewKey ?? null });
        el.child(v_flex().id(`mz-l-${a.id}`).absolute().left(lx0).top(ly).w(lw).h(lh - 8).pl(13).pr(10).justify_center().gap(2).rounded(4).bg(on ? "#12304af2" : isAsk ? "#2a1c0cd0" : work ? "#0b2b2ec4" : "#00000000").border(1).border_color(on ? EDGE : isAsk ? amber + "cc" : work ? WORK + "55" : "#00000000").cursor_pointer()
          .opacity(born && now - born < 120 ? 0 : 1).transition("opacity", { duration: 600, easing: "ease-out" }) // a new agent's plate fades in
          .child(div().absolute().left(2).top((lh - 8 - 28) / 2).w(work ? 3 : 2).h(28).bg(colr + (idle ? "55" : "dd")).when(work, (e2) => e2.loop("opacity", { from: 0.35, to: 1, period: 1100 })))
          .tooltip(`${nameOf(a)} · ${String(a.island_title ?? a.space ?? "")} / T${a.tab || "-"}`)
          .hover((h2) => h2.bg("#15294af5").border_color(EDGE)).on_hover((hv) => { if (hv) SCENE.hot = a.id; else if (SCENE.hot === a.id) SCENE.hot = null; })
          .on_mouse_down("left", (_e, c2) => c2.stop_propagation()).on_click((_e, c2) => { c2.stop_propagation(); this.mzOpen(a, c2); })
          .child(div().truncate().text_size(big ? 13.5 : 12.5).font_family(KO).font_weight(600).text_color(isAsk ? "#ffd9a8" : idle ? "#aab6c6" : "#f2f7fd").child(task || nameOf(a)))
          .child(h_flex().gap(6).items_center().overflow_hidden().child(div().flex_none().w(6).h(6).rounded(3).bg(colr).when(work, (e2) => e2.loop("opacity", { from: 0.3, to: 1, period: 700 }))).child(div().flex_none().whitespace_nowrap().text_size(10.5).font_family(KO).font_weight(work ? 700 : 400).text_color(colr).child(st.label))
            .child(div().min_w(0).truncate().text_size(10.5).font_family(KO).text_color(P.muted).child(this.elapsedText?.(a) ?? "")).child(div().flex_1())
            .when(Number(a.helpers) > 0, (e2) => e2.child(cap(`서브 ${a.helpers}`, EDGE))).when(Number(a.shells) > 0, (e2) => e2.child(cap(`셸 ${a.shells}`, SHELL_C))).when(!!a.parent_id, (e2) => e2.child(cap("↳ 연계", EDGE)))
            .child(div().flex_none().text_size(10).font_family(MONO).text_color("#6d83a3").child(`T${a.tab || "-"}`))));
        bodies.push({ a, cx: cx0, cy: cy0, R, si, k, phase: (j / of) * Math.PI * 2 + k * 2.1 + (look.get(s.key) % 5), period: (big ? 150 : 130) + k * 45, z: big ? 20 : 14, lx: lx0, ly: ly + (lh - 8) / 2, sel: on, born });
      });
      if (flat.length > list.length) el.child(div().absolute().left(lx0 + 4).top(y0 + list.length * lh + 4).child(cap(`+${flat.length - list.length} · 행성을 눌러 전체 보기`, EDGE)));
    });
    for (const [id, g] of m.gone ?? []) if (g.view === (m.viewKey ?? null) && !m.plates.has(id)) // a gone agent's plate: drawn once more where it was, fading out (same id: the fade starts from the last look)
      el.child(v_flex().id(`mz-l-${id}`).absolute().left(g.lx).top(g.ly).w(g.lw).h(g.lh - 8).pl(13).justify_center().opacity(now - g.at < 40 ? 1 : 0).transition("opacity", { duration: 600, easing: "ease-in" })
        .child(div().absolute().left(2).top((g.lh - 8 - 28) / 2).w(2).h(28).bg(ROSE)).child(div().truncate().text_size(12.5).font_family(KO).font_weight(600).text_color("#f2f7fd").child(g.text)).child(cap("연결 종료", ROSE)));
    this.mzTop = menuAt ? this.mzCallout(x, y, ...menuAt, w, h) : null;
    root.child(el);
    m.look = look;
    Object.assign(SCENE, { on: true, w, h, bodies, orbits, open: (a, c) => this.mzOpen(a, c), links: bodies.filter((b) => b.a.parent_id).map((b) => [b.a.parent_id, b.a.id]) });
  }

  // The inbox's requests; review (hansol.mosses:fx): a made-up request with three choices, to look at the buttons (its address does not exist: a press sends nothing).
  mzShown(alerts, now) {
    const m = this.mz;
    if (!alerts.length && (SCENE.fx ?? 0) > now) { const fake = { id: "fx-ask", source: "app", address: "fx-none", status: "blocked", since: now, blocked_msg: "Bash 실행 승인 요청: npm run build", island_title: "MX-MES", tab: 2, name: "Claude Code" };
      m.plans.set(fake.id, { key: "fx", at: now, reading: false, plan: { readable: true, yes: 1, no: 3, options: [{ n: 1, label: "Yes", kind: "yes" }, { n: 2, label: "Yes, and don't ask again for npm run commands", kind: "yes" }, { n: 3, label: "No, and tell Claude what to do differently", kind: "no" }] } }); return [fake]; }
    return alerts;
  }
  // ---- BOARD in the MOSSES layout (2026-11-27): a column per work space (in the OVERVIEW's order), a card per agent, the inbox on the right.
  // A column's head goes to RADAR and into that system; a card opens the agent's channel (as a moon). The data is the RADAR's (mzSystems, mzTrack).
  mzBoardView(list, cx) {
    this.mzInit(); list = list ?? [];
    const now = Date.now(), size = this.mzBoardSize ?? this.left ?? { width: 1200, height: 700 }, W = size.width, H = size.height;
    const { byId, systems, units } = this.mzSystems(list);
    this.mzTrack(list, units, byId, now, cx);
    const alerts = mailList(list); this.mzChoices(alerts, cx);
    const look = planetsFor(systems.map((s) => s.key)), hist = shared("hansol.mzHist") ?? {}, sel = shared("hansol.sel"), amber = STATE.blocked.color;
    const RANK = { blocked: 0, working: 1, done: 2, idle: 3, shell: 4 }, PAD = 16, RW = W >= 900 ? 380 : 0, k = Math.max(W / 1920, H / 1200);
    const CW = W - PAD * 2 - (RW ? RW + 14 : 0), colW = Math.max(300, Math.min(440, systems.length ? (CW - 12 * (systems.length - 1)) / systems.length : CW));
    const tag = (text, colour) => div().flex_none().h(17).px(6).flex().items_center().rounded(3).bg(colour + "22").text_size(10).font_family(KO).font_weight(600).text_color(colour).child(text);
    const card = (a) => {
      const st = stateOf(a), ask = a.status === "blocked", on = a.id === sel, task = taskOf(a), past = (hist[a.id] ?? []).filter((h) => h.text !== task).slice(-2).reverse();
      return h_flex().id(`mzb-c-${a.id}`).flex_none().w_full().gap(10).items_start().px(10).py(9).rounded(6).cursor_pointer()
        .bg(on ? "#12304af2" : CARD_BG[st.key] ?? GLASS).border(1).border_color(on ? EDGE : CARD_EDGE[st.key] ?? "#8fb4d82e").opacity(st.key === "idle" && !on ? 0.72 : 1).hover((s) => s.bg("#15294af0").border_color(EDGE))
        .on_mouse_down("left", (_e, c) => c.stop_propagation()).on_click((_e, c) => { c.stop_propagation(); this.mzOpen(a, c); })
        .child(stateBar(st.key))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().max_h(40).overflow_hidden().text_size(13.5).font_family(KO).font_weight(600).text_color(ask ? "#ffd9a8" : st.key === "working" ? "#ffffff" : "#c9d3df").child(task || nameOf(a)))
          .child(h_flex().gap(7).items_center().overflow_hidden().child(tag(st.key === "working" ? `● ${st.label}` : st.label, sc(st.key))).child(div().flex_none().text_size(11).font_family(MONO).text_color("#b9cbe0").child(`T${a.tab || "-"}`))
            .child(div().min_w(0).truncate().text_size(11).font_family(KO).text_color(P.muted).child(nameOf(a)))
            .child(div().flex_none().text_size(11).font_family(KO).text_color(P.muted).child(this.elapsedText?.(a) ?? ""))
            .when(Number(a.helpers) > 0, (e) => e.child(tag(`서브 ${a.helpers}`, EDGE))).when(Number(a.shells) > 0, (e) => e.child(tag(`셸 ${a.shells}`, SHELL_C))).when(!!a.parent_id, (e) => e.child(tag("↳ 연계", EDGE))))
          .when(past.length > 0, (e) => e.child(v_flex().mt(2).pt(4).gap(2).border_t(1).border_color("#8fb4d81a")
            .children(past.map((h) => h_flex().gap(8).items_center().child(div().flex_none().w(34).text_size(10.5).font_family(MONO).text_color("#6d83a3").child(hms(h.at).slice(0, 5)))
              .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(KO).text_color("#9fb3cc").child(h.text)))))));
    };
    const column = (s, i) => {
      const counts = Object.entries(RANK).map(([key]) => [key, s.units.filter((a) => stateOf(a).key === key).length]).filter(([, n]) => n > 0), ask = s.units.some((a) => a.status === "blocked");
      const sorted = [...s.units].sort((p, q) => RANK[stateOf(p).key] - RANK[stateOf(q).key] || (p.since ?? 0) - (q.since ?? 0));
      return v_flex().id(`mzb-col-${i}`).flex_none().w(colW).h_full().gap(8)
        .child(h_flex().id(`mzb-h-${i}`).relative().flex_none().h(56).px(10).gap(10).items_center().rounded(8).bg(GLASS_HEAD).border(1).border_color(ask ? amber + "88" : "#8fb4d83d").cursor_pointer()
          .hover((e) => e.border_color(EDGE)).tooltip(`${s.title} — 눌러서 RADAR에서 진입 · 오른쪽 클릭 메뉴`)
          .on_mouse_down("left", (_e, c) => c.stop_propagation()).on_click((_e, c) => { c.stop_propagation(); setShared("hansol.view.at", Date.now()); setShared("hansol.view", "office"); this.mzEnter(s.key); })
          .child(this.mzMenuPopover(`mzb-menu-${i}`, s, image(`${A}/planet-${look.get(s.key)}.png`).flex_none().w(40).h(40)))
          .child(v_flex().flex_1().min_w(0).gap(3).child(div().truncate().text_size(15).font_weight(600).text_color("#f2f7fd").child(String(s.title)))
            .child(h_flex().gap(8).items_center().child(cap(`${s.units.length} AGENTS`)).children(counts.map(([key, n]) => h_flex().gap(4).items_center().child(div().w(6).h(6).rounded(3).bg(STATE[key]?.color ?? P.muted)).child(cap(String(n), STATE[key]?.color)))))))
        .child(v_flex().id(`mzb-body-${i}`).flex_1().min_h(0).overflow_y_scroll().gap(6).children(sorted.map(card)));
    };
    const root = div().id("mzb-root").relative().size_full().overflow_hidden().bg("#01030c")
      .on_size_change((sz, c) => { const o = this.mzBoardSize; if (!o || Math.abs(o.width - sz.width) > 1 || Math.abs(o.height - sz.height) > 1) { this.mzBoardSize = sz; c.notify(); } })
      .child(image(`${A}/space.jpg`).absolute().left((W - 1920 * k) / 2).top((H - 1200 * k) / 2).w(1920 * k).h(1200 * k).opacity(0.8)) // (still: no drifting star layers on the board)
      .child(h_flex().id("mzb-cols").absolute().left(PAD).top(PAD).w(CW).h(H - PAD * 2).gap(12).items_start().overflow_x_scroll()
        .children(systems.length ? systems.map(column) : [div().p(20).text_size(13).font_family(KO).text_color(P.muted).child("표시할 에이전트 없음")]));
    if (RW) this.mzInbox(root, W - PAD - RW, PAD, RW, H - PAD * 2, this.mzShown(alerts, now), units, true);
    return root;
  }

  // ---- the inbox: the approval requests, each with the choices its terminal shows (the work reports are in the status panel below).
  // The choices are read from the terminal's screen (hc read -> approve.js approvalPlan), once a request and again every 3 s while the screen cannot be read.
  mzChoices(alerts, cx) {
    const m = this.mz, plans = (m.plans ??= new Map()), now = Date.now();
    for (const id of plans.keys()) if (!alerts.some((a) => a.id === id)) plans.delete(id);
    if (this.demo?.()) return;
    for (const a of alerts) { if (!this.mzCanAnswer(a)) continue;
      const key = `${a.id}|${a.since ?? ""}|${a.blocked_msg ?? ""}`, e = plans.get(a.id);
      if (e && e.key === key && (e.reading || e.plan?.readable || now - e.at < 3000)) continue;
      plans.set(a.id, { key, plan: e?.key === key ? e.plan : null, at: now, reading: true });
      cx.timer.after(0, async (c2) => { let plan = null; try { plan = approvalPlan((await hc(["read", a.address]))?.stdout ?? ""); } catch {}
        if (plans.get(a.id)?.key === key) plans.set(a.id, { key, plan, at: Date.now(), reading: false });
        try { c2.notify(); } catch {} }); }
  }
  mzInbox(root, x, y, w, hMax, alerts, units, board = false) { // board: the BOARD's right column (the inbox alone, the full height: the cards are the status)
    const m = this.mz, amber = STATE.blocked.color, n = alerts.length;
    const where = (a) => `${String(a.island_title ?? a.space ?? "")} / T${a.tab || "-"}`;
    const item = (a, colour, title, acts) => v_flex().px(12).py(10).gap(6).border_t(1).border_color(RULE)
      .child(div().id(`mz-it-${a.id}`).max_h(54).overflow_hidden().text_size(13).font_family(KO).font_weight(600).text_color("#f2f7fd").tooltip(`${String(title).slice(0, 600)}\n${nameOf(a)}`).child(String(title).slice(0, 300)))
      .child(h_flex().gap(6).items_center().child(div().flex_none().w(6).h(6).rounded(3).bg(colour)).child(div().min_w(0).truncate().text_size(11).font_family(KO).text_color("#b9cbe0").child(where(a)))
        .child(div().flex_1()).child(cap(this.elapsedText?.(a) ?? "", colour)))
      .child(acts);
    const section = (label, count, colour) => h_flex().flex_none().h(26).px(12).gap(8).items_center().bg(GLASS_HEAD).border_t(1).border_color(RULE).child(div().flex_none().w(2).h(10).bg(colour)).child(cap(label, colour)).child(div().flex_1()).child(cap(pad2(count), colour));
    const body = v_flex().id("mz-inbox-body").flex_1().min_h(0).overflow_y_scroll();
    if (alerts.length) body.child(section("승인 요청", alerts.length, amber));
    for (const a of alerts) {
      const acts = v_flex().gap(6), opts = m.plans?.get(a.id)?.plan?.options ?? null, openBtn = button(`mz-open-${a.id}`, "열기", "line", (c2) => this.mzOpen(a, c2));
      if (!this.mzCanAnswer(a)) acts.child(h_flex().gap(6).items_center().child(div().text_size(11.5).font_family(KO).text_color(P.muted).child("자기 터미널에서 응답 필요")).child(div().flex_1()).child(openBtn));
      else if (this.mzAnswering(a)) acts.child(h_flex().gap(6).items_center().child(div().text_size(11.5).font_family(KO).text_color(amber).loop("opacity", { from: 0.4, to: 1, period: 900 }).child(m.answering.get(a.id) === 0 || shared("hansol.mzAnswered")?.[a.address]?.busy ? "송신 중…" : "수신 확인 대기 중…")).child(div().flex_1()).child(openBtn));
      else if (opts?.length) { // the terminal's own choices, one button each (pressed = that number is sent)
        for (const o of opts) { const full = `${o.n}. ${o.label}${o.cont ? " " + o.cont : ""}`, txt = [...full].length > 44 ? [...full].slice(0, 43).join("") + "…" : full;
          acts.child(h_flex().id(`mz-optrow-${a.id}-${o.n}`).tooltip(full).child(button(`mz-opt-${a.id}-${o.n}`, txt, o.kind === "yes" ? (o === opts.find((x) => x.kind === "yes") ? "ok" : "line") : o.kind === "no" ? "no" : "line", (c2) => this.mzAnswer(a, { n: o.n, label: o.label }, c2)))); }
        acts.child(h_flex().child(div().flex_1()).child(openBtn)); }
      else acts.child(h_flex().gap(6).items_center().child(button(`mz-yes-${a.id}`, "승인", "ok", (c2) => this.mzAnswer(a, "yes", c2))).child(button(`mz-no-${a.id}`, "거절", "no", (c2) => this.mzAnswer(a, "no", c2)))
        .child(cap(m.plans?.get(a.id)?.reading ? "선택지 읽는 중…" : "")).child(div().flex_1()).child(openBtn));
      body.child(item(a, amber, blockedText(a) || "승인 요청", acts));
    }
    if (!n) body.child(v_flex().px(12).py(12).gap(4).border_t(1).border_color(RULE).child(div().text_size(12.5).font_family(KO).text_color("#dcecff").child("응답할 승인 요청 없음")));
    const inbox = v_flex().id("mz-inbox").flex_none().w_full().max_h(Math.round(hMax * (board ? 1 : 0.5))).bg(GLASS).border(1).border_color(alerts.length ? amber + "88" : "#8fb4d83d").rounded(10).overflow_hidden()
      .on_mouse_down("left", (_e, c2) => c2.stop_propagation())
      .child(h_flex().flex_none().h(40).px(12).gap(8).items_center()
        .child(div().text_size(14).font_weight(600).text_color("#f2f7fd").child("INBOX")).child(cap("승인 요청")).child(div().flex_1())
        .child(div().flex_none().h(20).px(8).flex().items_center().rounded(10).bg(n ? amber + "2a" : "#8fb4d81a").text_size(11).font_family(MONO).text_color(n ? amber : P.muted).child(pad2(n))))
      .child(body);
    root.child(v_flex().absolute().left(x).top(y).w(w).h(hMax).gap(12).child(inbox).when(!board, (e) => e.child(this.mzStatusPanel())));
  }

  // ---- the status panel (under the inbox): every agent at a glance, what it does now and what it did.
  // It reads what the floor publishes: shared "hansol.mzBoard" (the agents) and "hansol.mzHist" (id -> [{ at, text, done }], the work titles as they changed).
  mzStatusPanel() {
    const rows = shared("hansol.mzBoard")?.rows ?? [], hist = shared("hansol.mzHist") ?? {}, amber = STATE.blocked.color, hm = (ms) => hms(ms).slice(0, 5);
    const groups = []; for (const r of rows) { let g = groups.find((x) => x.space === r.space); if (!g) groups.push((g = { space: r.space, rows: [] })); g.rows.push(r); }
    const open = (r) => { if (r.address) openTerminalWindow(r.address, r.name); else setShared("hansol.mosses", { cmd: `openid:${r.id}`, at: Date.now() }); };
    const chip = (text, colour) => div().flex_none().h(17).px(6).flex().items_center().rounded(3).bg(colour + "22").text_size(10).font_family(KO).font_weight(600).text_color(colour).child(text);
    const body = v_flex().id("mzs-body").flex_1().min_h(0).overflow_y_scroll().px(10).pb(10).gap(4);
    for (const g of groups) {
      body.child(h_flex().flex_none().h(34).gap(8).items_end().pb(5).child(div().text_size(14).font_weight(600).text_color("#f2f7fd").child(String(g.space || "—"))).child(cap(`${g.rows.length} AGENTS`)).child(div().flex_1().h(1).mb(4).bg(RULE)));
      for (const r of g.rows) { const st = STATE[r.st] ?? STATE.idle, past = (hist[r.id] ?? []).filter((h) => h.text !== r.task).slice(-3).reverse(), leader = r.parent ? rows.find((x) => x.id === r.parent) : null;
        body.child(h_flex().id(`mzs-${r.id}`).flex_none().ml(leader ? 16 : 0).gap(10).items_start().px(10).py(8).rounded(6).bg(CARD_BG[r.st] ?? "#0d1a2e99").border(1).border_color(CARD_EDGE[r.st] ?? "#8fb4d824").opacity(r.st === "idle" ? 0.72 : 1).cursor_pointer()
          .hover((s) => s.bg("#15294acc").border_color(EDGE)).on_hover((hv) => { if (hv) SCENE.hot = r.id; else if (SCENE.hot === r.id) SCENE.hot = null; }).on_mouse_down("left", (_e, c) => c.stop_propagation()).on_click((_e, c) => { c.stop_propagation(); open(r); })
          .child(stateBar(st.key))
          .child(v_flex().flex_1().min_w(0).gap(4)
            .child(div().max_h(40).overflow_hidden().text_size(14).font_family(KO).font_weight(600).text_color(r.st === "blocked" ? "#ffd9a8" : r.st === "working" ? "#ffffff" : "#c9d3df").child(r.task || r.name))
            .child(h_flex().gap(7).items_center().overflow_hidden().child(chip(r.st === "working" ? `● ${st.label}` : st.label, sc(r.st))).child(div().flex_none().text_size(11).font_family(KO).text_color("#b9cbe0").child(`T${r.tab || "-"}`))
              .child(div().min_w(0).truncate().text_size(11).font_family(KO).text_color(P.muted).child(r.name)).child(div().flex_none().text_size(11).font_family(KO).text_color(P.muted).child(r.el || ""))
              .when(r.helpers > 0, (e2) => e2.child(chip(`서브에이전트 ${r.helpers}`, EDGE))).when(r.shells > 0, (e2) => e2.child(chip(`셸 ${r.shells}`, SHELL_C))).when(r.kids > 0, (e2) => e2.child(chip(`연계 ${r.kids}`, EDGE)))
              .when(!!leader, (e2) => e2.child(chip(`↳ ${String(leader.task || leader.name).slice(0, 18)}`, EDGE))))
            .when(past.length > 0, (e2) => e2.child(v_flex().mt(3).pt(5).gap(3).border_t(1).border_color("#8fb4d81a")
              .children(past.map((h) => h_flex().gap(8).items_center().child(div().flex_none().w(34).text_size(10.5).font_family(MONO).text_color("#6d83a3").child(hm(h.at)))
                .child(div().flex_none().w(4).h(4).rounded(2).bg(h.done ? STATE.done.color : "#6d83a3")).child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(KO).text_color("#9fb3cc").child(h.text))
                .when(!!h.done, (e3) => e3.child(div().flex_none().text_size(10).font_family(KO).text_color(STATE.done.color).child("완료")))))))
            .when(!past.length, (e2) => e2.child(div().text_size(10.5).font_family(KO).text_color("#6d83a3").child("이전 작업 기록 없음 (이 화면을 켠 뒤부터 기록)")))));
      }
    }
    if (!rows.length) body.child(div().py(20).text_size(12.5).font_family(KO).text_color(P.muted).child("표시할 에이전트 없음"));
    return v_flex().id("mz-status").flex_1().min_h(0).w_full().bg(GLASS).border(1).border_color("#8fb4d83d").rounded(10).overflow_hidden().on_mouse_down("left", (_e, c2) => c2.stop_propagation())
      .child(h_flex().flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(RULE)
        .child(div().text_size(14).font_weight(600).text_color("#f2f7fd").child("AGENT STATUS")).child(cap("지금 하는 일 · 지금까지 한 일")).child(div().flex_1())
        .child(div().flex_none().h(20).px(8).flex().items_center().rounded(10).bg("#8fb4d81a").text_size(11).font_family(MONO).text_color(P.muted).child(pad2(rows.length))))
      .child(body);
  }

  // ---- start-up: the checks with the real counts, a progress line, then the instruments open (a press skips it)
  mzBoot(shell, x0, W, left, t, nSys, nUnits, nAlert) {
    const fade = t < BOOT_MS - 350 ? 1 : clamp01((BOOT_MS - t) / 350), bw = Math.min(460, W - 60), bx = x0 + (W - bw) / 2, by = left.height / 2 - 130;
    const ov = div().id("mz-boot").absolute().left(0).top(0).w(left.width).h(left.height).bg("#01030ce6").opacity(fade)
      .on_mouse_down("left", (_e, c2) => c2.stop_propagation()).on_click((_e, c2) => { c2.stop_propagation(); this.mz.bootAt = Date.now() - BOOT_MS; this.mzBusy(2000); c2.notify(); });
    const lines = [["COMM LINK", "ONLINE", STATE.done.color], ["PLANETARY SYSTEMS", pad2(nSys), "#eaf3ff"], ["SATELLITES TRACKED", pad2(nUnits), "#eaf3ff"], ["INCOMING", pad2(nAlert), nAlert ? STATE.blocked.color : "#eaf3ff"], ["NAV RADAR", "READY", STATE.done.color]];
    const emb = div().flex_none().w(72).h(72)
      .child(svg(`${A}/ring-seg.svg`).absolute().w(72).h(72).text_color(EDGE).spin(5000)).child(svg(`${A}/ring-dash.svg`).absolute().left(10).top(10).w(52).h(52).text_color("#dcecff").spin(12000))
      .child(div().absolute().left(33).top(33).w(6).h(6).rounded(3).bg("#ffffff"));
    const box = v_flex().absolute().left(bx).top(by).w(bw).gap(7)
      .child(h_flex().gap(14).items_center().child(emb).child(v_flex().gap(3).child(div().whitespace_nowrap().text_size(24).font_weight(600).text_color("#eaf3ff").child("MOSSES")).child(cap("NAV RADAR · COMM TERMINAL · START-UP", EDGE))))
      .child(div().mt(6).w_full().h(1).bg(EDGE + "66"));
    lines.forEach(([k, v, c], i) => { const at = 250 + i * 320; if (t > at) box.child(h_flex().h(20).gap(8).items_center().child(div().whitespace_nowrap().text_size(12).font_family(MONO).text_color(P.muted).child(k)).child(div().flex_1().h(1).bg(RULE))
      .child(div().whitespace_nowrap().text_size(12).font_family(MONO).text_color(t > at + 200 ? c : P.muted).child(t > at + 200 ? v : "…"))); });
    box.child(div().mt(6).w_full().h(2).bg(RULE).child(div().h(2).w(bw * clamp01(t / (BOOT_MS - 450))).bg(EDGE)));
    shell.child(ov.child(box));
  }
}
