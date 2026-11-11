// hakoniwa: ★61-1 rooms (= Herdr App spaces) and stopping an agent, from the office.
// A plate's menu offers 部屋を表示・名前を変える・部屋を閉じる (closing is asked first); "＋ 部屋" opens a small dialog for space.new.
// "止める" (hc interrupt) is asked first too. Nothing is called before the person's button; the logic is in actions.js (tested with fakes).
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, closeOverlay, hc, openOverlay, pickFolder, props, readTextFile, run, setShared, shared, spaces } from "herdr";
import { P, STATE, RIGHT_POP_GAP, chipLeft } from "./common.js";
import { inboxList, inboxHeight, inboxExtraH, INBOX_SLACK } from "./approve.js";
import { icon } from "./icons.js";
import { closeRoom, closeRoomQuestion, findAgent, folderLabel, newRoom, newRoomHeight, normFolder, parseCommand, recentFolders, roomOps, runAgentOps, runMovePlan, spaceForIsland, stopAgent, stopQuestion } from "./actions.js";

export const OP_ERROR_MS = 8000; // ★104 U12
export const REVIEW_COMMANDS =["select", "detail", "plate", "stop", "launch", "panel", "panel-row", "panel-menu", "inbox", "feed", "usage", "chip", "room-new", "space-menu"];

export class RoomPart {
  // ★61-1 review pictures without clicks: herdr-app do hakoniwa.<command>[:<target>] (or the target in <appHome>/hakoniwa-aim.json).
  // select (open the right column), plate (open a plate's menu), stop / room-close (open the question only), room-new / launch (open the dialog).
  // Nothing is started, stopped or closed by these: only what a click would show. Returns true when the command was one of them.
  async reviewCommand(command) {
    const bare = String(command ?? "").split(":")[0];
    if (!REVIEW_COMMANDS.includes(bare)) return false;
    let aim = null;
    if (!String(command).includes(":")) { try { aim = JSON.parse((await readTextFile(`${appHome()}/hakoniwa-aim.json`)) ?? "null"); } catch {} }
    const { name, arg } = parseCommand(command, aim), list = this.items();
    const sel = () => list.find((a) => a.id === shared("hakoniwa.sel")) ?? null;
    if (name === "detail") { const t = findAgent(list, arg); if (t) this.openChat(t); }
    else if (name === "select") {
      const t = findAgent(list, arg); if (!t) return true;
      if (props()?.switch && shared("hakoniwa.view") !== "board") setShared("hakoniwa.pick", { state: t.status, id: t.id, at: Date.now() });
      else this.openChat(t);
    } else if (name === "plate") setShared("hakoniwa.plate", { room: arg, at: Date.now() });
    else if (name === "stop") { const t = arg ? findAgent(list, arg) : sel(); if (t) this.askStop(t); }
    else if (name === "launch") this.openLaunch(arg ? { space: arg } : sel());
    else if (name === "panel") setShared("hakoniwa.panel", { open: arg === "open" ? true : arg === "close" ? false : null, at: Date.now() }); // ★72-3 the left terminals' list: open / close (no arg: the other way)
    else if (name === "panel-menu") { if (arg) setShared("hakoniwa.panel", { open: true, menu: arg, at: Date.now() }); } // ★72-3 a row's ⋯ menu (t8x), for the review pictures
    else if (name === "inbox") { if (arg === "done" || arg === "blocked") this.inboxKey = arg; this.toggleInbox(); } // 14th D2: `inbox:done` opens under the 報告あり chip (default 承認待ち) // 4th W: the chips 承認待ち / 報告あり. 8th Y2: sent again, it closes (the region's flag, or the window by the id kept here)
    else if (name === "room-new") this.openNewRoom(arg || ""); // 5th X5: the make-a-space window (arg: a folder to fill in)
    else if (name === "space-menu") { if (arg) setShared("hakoniwa.panel", { open: true, spaceMenu: arg, at: Date.now() }); } // 5th X5: a heading's ⋯ menu; panel.js (office-fix-left5) reads `spaceMenu`
    else if (name === "feed") this.openFeed(); // the footer's 最近の動き (feed.js)
    else if (name === "usage") this.openUsage(); // the header's chart icon (main.js)
    else if (name === "chip") { const st = STATE[arg ?? "working"]; if (st) this.pressChip(st, list); } // the header's state chips: chip:<working|idle|blocked|done>
    else if (name === "panel-row") { if (arg) setShared("hakoniwa.panel", { open: true, row: arg, at: Date.now() }); } // ★72-3 a row pressed: that terminal (t8x) in the right column's window
    return true;
  }

  // 8th Y2: the inbox window. `overlay.close` (no id) shuts only the top dialog / popup, never a window, so the id from openOverlay is kept
  // and used to close it. One window at a time: opening again closes the old one first (no second window, no moved one).
  closeInboxWin() {
    const id = this.inboxWinId; this.inboxWinId = null; // 18th F3: the window's id is also in shared "hakoniwa.pops" (kind "inbox"), so another copy can close it
    const all = { ...(shared("hakoniwa.pops") ?? {}) }; if (all.inbox) { delete all.inbox; setShared("hakoniwa.pops", all); }
    if (id != null) { try { closeOverlay(id); } catch {} }
    return id != null;
  }
  // 28th P2: the window height asked for these rows (one place: openInboxWin and inboxResize must agree, or a reopen would loop)
  inboxWantH(rows, y) {
    const win = shared("hakoniwa.win"), tb = this.termBox ?? shared("hakoniwa.termBox");
    const hMax = win?.h ? win.h - y - 8 : (tb?.h ?? 600);
    return Math.min(hMax, inboxHeight(rows, shared("hakoniwa.sel")) + inboxExtraH(rows) + (rows.some((a) => a.status === "blocked") ? INBOX_SLACK : 8)); // 25th L2: reports are fixed one-line rows (no wrapped text), so only 8px of margin: the window fits the cards (was +24, about 35px empty below)
  }
  // 28th P2: the window's height is fixed when it opens, so a count that grows right after (a report landing, a state read late) cut the last card (「続きあり」, first open only).
  // Called by the window's own 1.5 s timer (main.js): when the height the rows ask for differs from the open window's, open it again in the same place and for the same chip.
  // The same height does nothing (no flicker); at most once per 1.2 s.
  inboxResize() {
    const cur = shared("hakoniwa.inboxH"), at = shared("hakoniwa.inboxAt");
    if (!cur || !at || !shared("hakoniwa.pops")?.inbox || (this.regionFlag && !this.regionBroken)) return false;
    if (Date.now() - (this.inboxResizedAt ?? 0) < 1200) return false;
    // 28th fix28c: the reopened window's copy may compare before its first read (items() empty → a different height → reopen again, forever). Empty rows are never compared,
    // and the reopens are counted in the shared "hakoniwa.inboxResizeN" (reset to 0 by a person / command opening the inbox, not by this call): 2 at most per open.
    const rows = inboxList(this.items());
    if (!rows.length) return false;
    const n = shared("hakoniwa.inboxResizeN") ?? 0;
    if (n >= 2) return false;
    if (this.inboxWantH(rows, at.y) === cur) return false;
    this.inboxResizedAt = Date.now();
    setShared("hakoniwa.inboxResizeN", n + 1);
    this.openInboxWin({ at: { x: at.x, y: at.y } });
    return true;
  }
  openInboxWin(keep) {
    this.popCloseOthers("inbox"); // 18th F3: one popup at a time (最近の動き・使用量・チップの一覧)
    if (this.regionFlag && !this.regionBroken) return this.openInbox(); // the right region shows it (shared flag; detail.js)
    if (!keep) setShared("hakoniwa.inboxResizeN", 0); // 28th fix28c: a person / command opening resets the reopen count (inboxResize passes `keep`)
    this.closeInboxWin();
    // 14th D2: right under the pressed chip, left edge on the chip (the pressed chip's bounds, or CHIP_X for a command: the 1920px header, measured).
    // It only moves left when it would reach the right window (rl = that window's real left edge, 12th C3), so the usual place does not depend on the frame number.
    // 9th Z4: termBox is the office copy's; the command runs in the band's copy where it is empty, so rightLeft() (feed.js) reads the shared copy / default width.
    const tb = this.termBox ?? shared("hakoniwa.termBox"), rl = this.rightLeft(), w = 480, rows = inboxList(this.items());
    const key = keep ? (shared("hakoniwa.inboxKey")?.key ?? "blocked") : (this.inboxKey ?? "blocked"), b = keep ? null : this.chipBox; this.inboxKey = null; this.chipBox = null; // used once: a later command must not reuse an old press
    setShared("hakoniwa.inboxKey", { key }); // 24th fix24a: the pressed chip's kind, for inbox.js's heading (19th K5); without it the first card's kind leads
    const win = shared("hakoniwa.win"), vw = win?.w ?? 1920, y = keep ? keep.at.y : Math.round(b ? b.y + b.height + 6 : 64);
    let x = keep ? keep.at.x : Math.round(b ? b.x : chipLeft(key, shared("hakoniwa.chipw"))); // 15th E3: the chip's real left, from the measured widths
    if (!keep) x = Math.min(x, rl ? rl - w - RIGHT_POP_GAP : vw - w - 8);
    // 20th H2: asked height = the content (waiting card 175, report 54; the person in the right window has no 「その人を開く」 row) + INBOX_SLACK for a wrapped line, capped at the
    // screen. The height is shared ("hakoniwa.inboxH") so inbox.js counts 「続きあり」 against the window's real height, not the screen's.
    const h = this.inboxWantH(rows, y);
    setShared("hakoniwa.inboxH", h);
    const at = { x: Math.max(8, x), y };
    setShared("hakoniwa.inboxAt", at); // 28th P2: where it opened, for inboxResize
    this.popupDiag?.("inbox", at, w);
    this.inboxWinId = this.popOpen("inbox", key, { mod: "hakoniwa", kind: "window", key: "hakoniwa-inbox", width: w, height: h, ...(at ? { at } : {}), props: { role: "inbox" } });
  }
  // A chip / the command: open when shut, close when open.
  toggleInbox() {
    if (shared("hakoniwa.inboxOpen")?.on) { setShared("hakoniwa.inboxOpen", { on: false, at: Date.now() }); return; }
    if (this.closeInboxWin() || this.popClose("inbox")) return; // 18th F3: the window may have been opened by another copy (its id is in the shared pops)
    this.openInboxWin();
  }

  roomLive() { return !(shared("hakoniwa.demo") || this.feed?.config?.demo); }

  // The room's buttons at the top of a plate's people list. `members`: the island's people (agents). Empty for T3 / TUI rooms and in the demo.
  roomMenu(isl, members) {
    let list = []; try { list = spaces(); } catch {}
    if (String(isl?.key ?? "").startsWith("free:")) return null; // ★68-2 the free desks are not a space
    const sp = spaceForIsland(members, list, isl), ops = roomOps(sp, this.roomLive());
    if (!ops.length) return null;
    const btn = (op) => div().id(`room-${op.key}-${isl.key}`).flex_none().px(6).py(2).rounded(6).border(1).border_color(op.key === "close" ? "#e3a9b3" : P.line).bg(P.white)
      .text_size(10).font_weight(600).text_color(op.key === "close" ? "#d6455d" : P.ink).cursor_pointer().hover((s) => s.bg("#2b3b50"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation(); this.plateOpen = null;
        cx.spawn(async (cx) => { const r = await runAgentOps(run, [op]); this.roomError = r.ok ? null : { key: isl.key, text: r.error }; cx.notify(); });
        cx.notify();
      }).child(op.label);
    return v_flex().gap(3).pb(4).mb(2).border_b(1).border_color("#3b4b60")
      .child(h_flex().gap(4).flex_wrap().children(ops.map(btn)))
      .when(this.roomError?.key === isl.key, (el) => el.child(div().text_size(9).text_color("#d6455d").child(this.roomError.text)));
  }

  askCloseRoom(sp, members) {
    const q = closeRoomQuestion(sp, members);
    openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 440, height: q.strong ? 260 : 220,
      props: { role: "confirm", action: "room-close", title: "공간 닫기", yes: "네, 닫기", space: { id: sp.id, name: sp.name }, text: q.text, strong: q.strong } });
  }

  askStop(a) {
    const q = stopQuestion(a);
    openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 440, height: 210,
      props: { role: "confirm", action: "stop", title: "작업 중단", yes: "네, 중단", address: a.address, source: a.source, text: q.text, strong: q.strong } });
  }

  // The "はい" of the confirm dialog for the room / stop actions (ending an agent stays in chat.js).
  confirmYes(p) {
    if (p.action === "room-close") return closeRoom(run, p.space, true);
    if (p.action === "stop") return stopAgent((_cmd, args) => hc(args), { address: p.address, source: p.source }, true); // the App's own hc(): no PATH lookup
    return null;
  }

  // ★101-3: moving a person to another space is the left list's drag only. The old "スペースへ移す" / "フリーへ" buttons and the
  // picker window are gone (フリー is just another space to drop on).
  // ★104 U10: `onOk(cx)` runs after a move that worked (the left list shows "元に戻す" there). U12: a failure text goes away by itself after 8 s.
  doMove(a, plan, cx, onOk = null) {
    cx.spawn(async (cx) => {
      const r = await runMovePlan(run, hc, plan); this.opError = r.ok ? null : { id: a.id, text: r.error };
      const n = this.opErrorSeq = (this.opErrorSeq ?? 0) + 1;
      if (r.ok) onOk?.(cx);
      else cx.timer?.after(OP_ERROR_MS, (cx2) => { if (this.opErrorSeq === n && this.opError?.id === a.id) { this.opError = null; cx2.notify(); } });
      cx.notify();
    });
  }

  // "＋ 部屋": for the band (placed by the band's owner beside the launch button).
  newRoomButton(compact = false) { // compact (a narrow band): only the "＋"
    return h_flex().id("room-new-btn").flex_none().ml(6).px(compact ? 8 : 10).h(30).gap(6).items_center().rounded(10).border(1).border_color(P.line)
      .bg(P.white).cursor_pointer().hover((s) => s.bg("#253449"))
      .on_click(() => this.openNewRoom())
      .child(icon("room-add", 16, P.blue))
      .when(!compact, (el) => el.child(div().text_size(12).font_weight(600).text_color(P.ink).child("공간")));
  }
  // ★107 the window that makes a space (name + folder). `folder`: the folder filled in when it opens (optional).
  // 18th F6: the recent folders are read first (view.json + the spaces' own, no test folders) so the window is as tall as its content and does not read them again.
  openNewRoom(folder = "") {
    const open = (view) => {
      let sl = []; try { sl = spaces().map((s) => ({ id: s.id, name: s.name, folder: s.folder })); } catch {}
      const recent = recentFolders(view, sl);
      openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 480, height: newRoomHeight(recent), props: { role: "room-new", folder: String(folder ?? ""), recent, spaces: sl } });
    };
    readTextFile(`${appHome()}/view.json`).then((t) => { let v = null; try { v = JSON.parse(String(t ?? "")); } catch {} open(v); }, () => open(null));
  }

  initRoomNew(cx) {
    const p = props() ?? {};
    this.roomForm = { error: null, busy: false, recent: Array.isArray(p.recent) ? p.recent : [], spaces: Array.isArray(p.spaces) ? p.spaces : [] };
    if (Array.isArray(p.recent)) { this.rName = InputState.new({ placeholder: "공간 이름 (프로젝트 이름)" }); this.rFolder = InputState.new({ placeholder: "폴더 (비우면 홈)", value: p.folder ?? "" }); return; } // 18th F6: already read when the window was opened
    this.rName = InputState.new({ placeholder: "공간 이름 (프로젝트 이름)" });
    this.rFolder = InputState.new({ placeholder: "폴더 (비우면 홈)", value: p.folder ?? "" });
    // the folders to pick from: read once, here (never in a render): the spaces' own, then view.json's recent
    cx?.spawn?.(async (cx2) => {
      let view = null, sl = []; try { view = JSON.parse(String(await readTextFile(`${appHome()}/view.json`) ?? "")); } catch {}
      try { sl = spaces().map((s) => ({ id: s.id, name: s.name, folder: s.folder })); } catch {}
      this.roomForm.recent = recentFolders(view, sl); this.roomForm.spaces = sl; cx2.notify();
    });
  }

  roomNewView() {
    const p = props() ?? {}, f = this.roomForm ?? (this.roomForm = { error: null, busy: false });
    const label = (t) => div().text_size(11).font_weight(700).text_color(P.muted).child(t);
    const submit = (_e, cx) => {
      if (f.busy) return;
      const form = { name: this.rName?.value(), folder: this.rFolder?.value() };
      let sl = []; try { sl = spaces().map((s) => ({ id: s.id, name: s.name })); } catch {} // read again now: a room made meanwhile counts
      f.busy = true; f.error = null; cx.notify();
      cx.spawn(async (cx) => {
        const r = await newRoom(run, form, sl);
        f.busy = false;
        if (r.ok) { closeOverlay(p.overlay); return; }
        f.error = r.error; cx.notify();
      });
    };
    const setFolder = (v, cx) => { this.rFolder?.set_value?.(v); f.error = null; cx.notify(); };
    // 8th Y6: gpui-base's Input is unstyled (no frame), so each one sits in a framed box
    const framed = (input) => div().w_full().h(40).px(10).flex().items_center().rounded(8).border(1.5).border_color("#b9b4a6").bg("#1b2637").child(input);
    const chip = (id, text, fn) => div().id(id).flex_none().max_w(200).truncate().px(10).py(4).rounded(8).border(1).border_color(P.line).bg(P.white).text_size(12).text_color(P.ink)
      .cursor_pointer().hover((s) => s.bg("#2b3b50")).on_click((_e, cx) => fn(cx)).child(text);
    return v_flex().id("room-new-root").size_full().p(18).gap(12).bg(P.paper).overflow_hidden()
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } else if (e.key === "enter") { submit(e, cx); cx.stop_propagation(); } })
      .child(div().flex_none().text_size(15).font_weight(700).text_color(P.ink).child("새 공간 (프로젝트)"))
      .child(div().id("room-new-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().gap(12)
        .child(v_flex().gap(5).child(label("이름")).when(!!this.rName, (el) => el.child(framed(Input.new(this.rName)))))
        .child(v_flex().gap(5).child(label("폴더 (공간의 터미널이 시작되는 위치)")).when(!!this.rFolder, (el) => el.child(framed(Input.new(this.rFolder))))
          .child(h_flex().gap(6).child(chip("room-new-pick", "선택…", (cx) => cx.spawn(async (cx2) => { let d = null; try { d = await pickFolder({ prompt: "선택" }); } catch {} if (d) setFolder(normFolder(d), cx2); }))))
          .when((f.recent ?? []).length > 0, (el) => el.child(div().id("room-new-recent-head").text_size(11).text_color(P.muted).child("최근 폴더"))
            .child(h_flex().gap(6).flex_wrap().children((f.recent ?? []).map((d, i) => chip(`room-new-recent-${i}`, folderLabel(d) || d, (cx) => setFolder(d, cx)))))))))
      .child(h_flex().flex_none().gap(10).items_center()
        .child(div().id("room-new-error").flex_1().min_w(0).max_h(36).overflow_hidden().text_size(11).text_color("#d6455d").child(f.error ?? "")) // 19th G2: the error shares the buttons' row (no row reserved for it)
        .child(div().id("room-new-cancel").flex_none().px(16).py(8).rounded(8).border(1).border_color(P.line).bg(P.white).text_size(13).font_weight(700).text_color(P.ink)
          .cursor_pointer().on_click(() => closeOverlay(p.overlay)).child("취소"))
        .child(div().id("room-new-go").flex_none().px(16).py(8).rounded(8).bg("#1e6fe0").text_size(13).font_weight(700).text_color("#ffffff")
          .cursor_pointer().on_click(submit).child(f.busy ? "만드는 중…" : "만들기")));
  }
}
