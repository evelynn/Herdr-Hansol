// hakoniwa ③ recent moves + ⑤ OpenCode usage (★106 office-feed106). Methods join AgentHud (main.js); state lives in this.fd (this.feed is the collector's).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, exec, openOverlay, props, readTextFile, setShared, shared, writeTextFile } from "herdr";
// 13th B6: `window` is the ambient gpui Window. Importing `window` from "herdr" (a function: titlebar info) hid it, so viewport_size() threw and winSize() / publishWin() never worked.
const vpSize = () => { try { const v = globalThis.window?.viewport_size?.(); return v && v.width > 0 ? v : null; } catch { return null; } };
import { STATE, P, ago, clock, RIGHT_POP_GAP } from "./common.js";
import { UI } from "./ui-rules.js";
import { icon } from "./icons.js";
import { FEED_FILTERS, trackMoves, addMoves, filterMoves, parseLog, parseOpenCode } from "./feed-rules.js";

const FEED_W = 460, FEED_H = 420, FOOTER_H = 40, FEED_BTN_X = 378 /* where the footer button starts (measured 378 in the 17:23 picture; 440 was a guess) */, USAGE_W = 340, WIN_DEFAULT = { w: 1920, h: 1152 } /* the window measured in usability104 (last resort for `at`) */, STATE_WORD = { working: "作業中", idle: "待機", blocked: "承認待ち", done: "報告" };
export const POP_KINDS = ["feed", "usage", "chip", "inbox"];
const stateWord = (k) => STATE[k]?.label ?? STATE_WORD[k] ?? String(k);

export class FeedPart {
  // The footer calls this on every draw: remembers who changed state (in memory at once; the file is written a moment later, only when something was added).
  feedNote(list, cx) {
    const fd = (this.fd ??= { log: [], seen: null, loaded: false, writing: false });
    if (!fd.loaded) {
      fd.loaded = "loading";
      cx.spawn(async (cx) => { const text = await readTextFile(`${appHome()}/hakoniwa-office/feed.json`).catch(() => null); fd.log = [...fd.log, ...parseLog(text)].slice(0, 100); fd.loaded = true; cx.notify(); });
    }
    if (fd.loaded !== true || this.demo?.()) return; // the made-up people never make entries
    const r = trackMoves(fd.seen ?? Object.fromEntries(list.map((a) => [a.id, a.status])), list, Date.now());
    fd.seen = r.seen;
    if (!r.added.length) return;
    fd.log = addMoves(fd.log, r.added);
    if (fd.writing) return;
    fd.writing = true;
    cx.timer.after(1500, async () => {
      fd.writing = false;
      try { const path = `${appHome()}/hakoniwa-office/feed.json`, prev = await readTextFile(path).catch(() => null); await writeTextFile(path, JSON.stringify({ log: fd.log }), prev); } catch {}
    });
  }

  // W: the click and the review command (room.js `feed`) open the same popup (no pointer known from a command: the App places it)
  // 5th X3: placed right above the footer button. A click knows the button (bounds) or the pointer; a review command knows neither, so it
  // uses the footer's measured size (the whole window's height only when it is tall enough to be the window, else the App places it).
  // 8th Y3: the command is read by the band's copy of the mod, but `fd` (the log, the footer's size) lives in the footer's copy. So the window's size is
  // asked here (window.viewport_size, as chat.js does) and, with no log in this copy, the file is read before the popup opens.
  // 9th Z4: the review command runs in the band's copy, whose window.viewport_size() is the band (70px high) and whose `fd.vp` is never set (the footer is another copy),
  // so the popup got no `at` and the App put it at the pointer (top left, 8,8: measured in usability104 7回目). The footer copy now publishes the window's size as
  // shared "hakoniwa.win" (main.js footer()); it is read here as the last fallback.
  // 10th A3: the footer's own viewport is its 40px block, so the footer copy could never publish the window's size ("hakoniwa.win" was never written, height > 200 never held).
  // The office copy sees the whole window: publishWin() (called from chat.js syncTerm) writes it; here it is read, and the measured 1920x1152 is the last resort so `at` is always set.
  winSize() {
    let vp = vpSize();
    if (!(vp?.height > 200)) vp = this.fd?.vp;
    if (!(vp?.height > 200)) { const w = shared("hakoniwa.win"); if (w?.h > 200) vp = { width: w.w, height: w.h }; }
    return vp?.height > 200 ? vp : null;
  }
  winSizeOrDefault() { return this.winSize() ?? { width: WIN_DEFAULT.w, height: WIN_DEFAULT.h }; }
  publishWin() {
    try {
      const vp = vpSize();
      if (!(vp?.height > 200)) return;
      const w = shared("hakoniwa.win"), nw = Math.round(vp.width), nh = Math.round(vp.height);
      if (w?.w !== nw || w?.h !== nh) setShared("hakoniwa.win", { w: nw, h: nh });
    } catch {}
  }
  // 10th: values for "why is it there" go to a file (console is not visible). Only when the text changed; never throws.
  // 13th B6: `savedAt` is the time of the save; a position that was asked for is named by the caller (`placedAt`), so the two no longer overwrite each other.
  diagWrite(name, obj) {
    const text = JSON.stringify(obj), key = `diag:${name}`;
    this.diagLast ??= {};
    if (this.diagLast[key] === text) return;
    this.diagLast[key] = text;
    const path = `${appHome()}/hakoniwa-office/${name}.json`;
    readTextFile(path).catch(() => null).then((prev) => writeTextFile(path, JSON.stringify({ ...obj, savedAt: new Date().toISOString() }, null, 1), prev)).catch(() => {});
  }
  // 10th A4: the popups (最近の動き・使用量・状態チップの一覧) keep their overlay ids in shared "hakoniwa.pops" ({ feed|usage|chip: { id, key } }) because the click opens them in the
  // footer/band copy and `hakoniwa.close` arrives in the band's copy. Sent again = closes; never a second one; `hakoniwa.close` closes all; a popup that goes by itself (Esc, a click outside) clears its entry (close()).
  // 18th F3: one popup at a time. The inbox window is one of them (kind "inbox": its id is kept here too, so every copy can close it); opening any of the four closes the other three.
  popClose(kind) {
    let any = false;
    if (kind === "inbox" && shared("hakoniwa.inboxOpen")?.on) { setShared("hakoniwa.inboxOpen", { on: false, at: Date.now() }); any = true; } // the right region's copy of the inbox
    const all = { ...(shared("hakoniwa.pops") ?? {}) }, cur = all[kind];
    if (kind === "inbox") this.inboxWinId = null;
    if (!cur) return any;
    delete all[kind]; setShared("hakoniwa.pops", all);
    try { closeOverlay(cur.id); } catch {}
    return true;
  }
  popCloseAll() { let any = false; for (const k of POP_KINDS) any = this.popClose(k) || any; return any; }
  popCloseOthers(kind) { for (const k of POP_KINDS) if (k !== kind) this.popClose(k); }
  popOpen(kind, key, spec) {
    this.popCloseOthers(kind);
    this.popClose(kind);
    const id = openOverlay(spec);
    setShared("hakoniwa.pops", { ...(shared("hakoniwa.pops") ?? {}), [kind]: { id, key } });
    return id;
  }
  popGone() { // the View's close(): this copy is a popup that has gone
    const p = props(), kind = p?.role === "feed" ? "feed" : p?.role === "usage" ? "usage" : p?.role === "state-list" ? "chip" : p?.role === "inbox" ? "inbox" : null;
    if (!kind || p.overlay == null) return;
    const all = { ...(shared("hakoniwa.pops") ?? {}) };
    if (all[kind]?.id === p.overlay) { delete all[kind]; setShared("hakoniwa.pops", all); }
  }
  // 9th Z8/Z4: the left edge of the right window (where the popups must not reach). termBox lives in the office copy only; "hakoniwa.termBox" is its shared copy
  // (written by the office copy, if it does), else the default width of the right window (about 42% of the window, 0.58 from the left: measured 1110 of 1920).
  rightLeft() {
    const b = this.termBox ?? shared("hakoniwa.termBox");
    if (b?.x > 0) return Math.round(b.x) - Math.max(0, Math.round(b.frame ?? 0)); // 12th C3: a window's box holds the x asked for + `frame` (RIGHT_WIN_FRAME); the region's / measured box has frame 0
    const vp = this.winSize();
    return vp?.width > 600 ? Math.round(vp.width * 0.58) : null;
  }
  openFeed() {
    if (this.popClose("feed")) return; // 10th A4: sent / pressed again = closes
    const vp = this.winSizeOrDefault();
    const at = this.fd?.btn ? { x: Math.max(8, Math.round(this.fd.btn.x)), y: Math.max(8, Math.round(this.fd.btn.y - FEED_H - 8)) }
      : this.fd?.at ? { x: Math.max(8, Math.round(this.fd.at.x - 40)), y: Math.max(8, Math.round(this.fd.at.y - FEED_H - 40)) }
      : { x: FEED_BTN_X, y: Math.max(8, Math.round(vp.height - FOOTER_H - FEED_H - 8)) }; // 10th A3: always an `at` (the window's size, else the measured 1920x1152)
    this.diagWrite("feed-place-diag", { winSize: this.winSize(), sharedWin: shared("hakoniwa.win") ?? null, fdVp: this.fd?.vp ?? null, fdBtn: this.fd?.btn ?? null, fdAt: this.fd?.at ?? null, placedAt: at });
    const open = (log) => this.popOpen("feed", "feed", { mod: "hakoniwa", kind: "popup", width: FEED_W, height: FEED_H, at, props: { role: "feed", log } });
    if (this.fd?.log?.length) return open(this.fd.log);
    readTextFile(`${appHome()}/hakoniwa-office/feed.json`).then((t) => open(parseLog(t).slice(0, 100)), () => open([]));
  }

  // Footer button "最近の動き": opens the list upward from the button (the floor is not narrowed).
  feedButton() {
    const n = this.fd?.log?.length ?? 0;
    return h_flex().id("feed-open").flex_none().h(UI.hit).px(12).gap(8).items_center().rounded(8).border(1.5).border_color(P.line).bg("#ffffff")
      .cursor_pointer().hover((s) => s.bg("#f0ede4"))
      .on_mouse_down("left", (e) => { this.fd.at = e?.position ?? null; this.fd.btn = e?.bounds ?? null; })
      .on_click(() => this.openFeed())
      .child(icon("legend", 18, P.muted))
      .child(div().text_size(UI.text.small).font_weight(700).text_color(P.ink).child("最近の動き"))
      .when(n > 0, (el) => el.child(div().text_size(UI.text.small).text_color(P.muted).child(String(n))));
  }

  // Popup body (role "feed"): filter tabs, then newest first: time, who, to which state, and what the agent said (status msg).
  feedView(cx) {
    const p = props(), log = Array.isArray(p.log) ? p.log : [], key = this.fdFilter ?? "all", rows = filterMoves(log, key);
    // 8th Y3: a popup is as big as its content, so the box has a height of its own and the list a fixed one (flex_1 + min_h(0) made it 0 high: only the tabs showed)
    const listH = FEED_H - 20 - UI.seg - 8;
    return v_flex().id("feed-pop").w_full().h(FEED_H).flex_none().p(10).gap(8).bg("#ffffff")
      .on_key_down((e, c) => { if (e.key === "escape") { closeOverlay(p.overlay); c.stop_propagation(); } })
      .child(h_flex().flex_none().gap(6).items_center()
        .children(FEED_FILTERS.map((f) => div().id(`ff-${f.key}`).flex_none().h(UI.seg).px(12).flex().items_center().rounded(8).cursor_pointer()
          .text_size(UI.text.small).when(key === f.key, (el) => el.bg(P.blue).font_weight(700).text_color("#ffffff"))
          .when(key !== f.key, (el) => el.text_color(P.muted).hover((s) => s.bg("#f0ede4")))
          .on_click(() => { this.fdFilter = f.key; cx.notify(); }).child(f.label))))
      .child(v_flex().id("feed-rows").flex_none().h(listH).overflow_y_scrollbar().gap(2)
        .children(rows.length ? rows.map((e, i) => {
          const st = STATE[e.to];
          return h_flex().id(`fr-${i}`).w_full().flex_none().gap(8).px(6).py(5).items_start().rounded(8)
            .child(div().flex_none().w(46).text_size(UI.text.small).text_color(P.muted).child(clock(e.at)))
            .child(st ? this.stateMark(st, 20) : div().flex_none().w(20))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_size(UI.text.small).font_weight(700).text_color(P.ink).child(e.name))
              .child(div().truncate().text_size(UI.text.small).text_color(st?.color ?? P.muted).child(`${stateWord(e.from)} → ${stateWord(e.to)}・${ago(e.at)}前`))
              .when(!!e.msg, (el) => el.child(div().truncate().text_size(UI.text.small).text_color(P.muted).child(e.msg))));
        }) : [div().p(10).text_size(UI.text.small).text_color(P.muted).child(log.length ? "この絞り込みに当てはまる動きはありません" : "まだ動きがありません（状態が変わると、ここに並びます）")]));
  }

  // The usage icon: reads OpenCode's own record first (a few ms, read only), then opens the popup with all three services.
  // 5th X4: under the button (top right). The pointer's x is used when a click gave one; a command uses the band's measured width.
  openUsagePopup(claude, codex, demo) {
    if (this.popClose("usage")) return; // 10th A4: pressed / sent again = closes (no second one)
    const px = this.ub?.x, bw = this.bandW ?? 0, rl = this.rightLeft();
    // 9th Z8: under the button the popup covered the right window's head (name, chips). It now ends 8px left of that window (over the floor), at the same height.
    const clampX = (x) => Math.max(8, Math.round(rl ? Math.min(x, rl - USAGE_W - RIGHT_POP_GAP) : x)); // 12th C3: rl is the window's real left edge
    const at = px != null ? { x: clampX(Math.min(px, (bw || px + USAGE_W) - USAGE_W - 8)), y: Math.round(this.ub.y) }
      : bw > USAGE_W + 16 ? { x: clampX(bw - USAGE_W - 12), y: 60 } : undefined;
    this.popupDiag?.("usage", at, USAGE_W);
    const open = (opencode) => this.popOpen("usage", "usage", { mod: "hakoniwa", kind: "popup", width: USAGE_W, height: 460, ...(at ? { at } : {}), props: { role: "usage", claude, codex, opencode, demo } });
    const py = this.feed?.config?.python, script = `${appHome()}/mods/hakoniwa/opencode-usage.py`;
    if (!py || demo) return open(null);
    exec(py, ["-I", script]).then((r) => open(r.code ? null : parseOpenCode(r.stdout)), () => open(null));
  }
}
