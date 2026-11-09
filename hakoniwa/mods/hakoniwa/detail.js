// hakoniwa ★84: the right column (an agent's detail): a head (face, name + pencil / trash, ×; state chip + ■, kind, model, parent; one grey info line) and tabs
// "ターミナル｜会話｜チーム N". The body under the tabs is the real terminal block (App agents), or the conversation, or the family tree.
// Few buttons: ■ stops (working only), the pencil renames in place, the trash ends this session (asked first), × closes. Mixed into AgentHud.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { closeOverlay, hc, openOverlay, props, setShared, settings, shared, spaces } from "herdr";
import { P, dot, ago, STATE, platform, platformIcon, stateOf, fmtMem, blockedText } from "./common.js";
import { commanderInfo, unwrapHcScreen } from "./life.js";
import { isWorker, teamFixPlan, teamSpaceState } from "./actions.js";
import { iconBtn, tabs, menuList, inlineRename, renameState } from "./ui.js";
import { fitChips, headBodyH, foldScreenHead, RIGHT_HEAD, UI, NAME_EM, clipName } from "./ui-rules.js";
import { tidyCut } from "./ui-rules.js";
import { approvalPlan, answerApproval, stripApprovalDialog, REASON_TEXT, liveState, seenNext, askInRecord, clampAsk, dropWhatTip, inboxWhat } from "./approve.js";
import { answeredPlan, readSeenNext, needsApprovalRead, planIsAsk } from "./approve.js"; // 42nd 40-H1 (separate line: test-life reads the line above)
import { rereadDue, screenBodyMode, composerStandIn } from "./approve.js"; // 43rd office-fix48a (separate line, as above)
import { approvalLoading, answeredNow } from "./approve.js"; // 44th office-fix49a (separate line, as above)
import { appHome, readTextFile, writeTextFile } from "herdr"; // 45th office-fix50a (separate line): the approval trace file
import { approvalDetailLines } from "./approve-view.js";
import { splitToolBlocks, markPending, askLine, stripTerminalFrame, openApprovalCut, endLabel, toolLabel, workLabel, toolMark, endRejected, dropTipLines } from "./tool-lines.js";
import { inboxView } from "./inbox.js";
const APPROVE_HINT = "#5a6272"; // 26th M3: the approval card's two-line hint (P.muted #7b8494 was faint on the pale orange)
// ★103-4: every press target of the head is BTN px or more (32px minimum) and the text is 1.25-1.5x the old size.
const BTN = 36, BICON = 20;
const FROM_NAME = "#a3aab4"; // 25th R5: the parent's name beside 「（親から）」 (paler than P.muted)
const TOOL_BG = "#f6f7f9", TOOL_BORDER = "#e3e6ec"; // 22nd N7: a tool record's pale fill and thin frame (chat.js uses the same two for the transcript's tool row)
const PEND_EXTRA = 44; // 27th T1: the pinned record's label + frame + gap (px), taken off the fit's height (its lines are counted by the fit)
const PEND_BG = "#fff1df", PEND_BORDER = "#f2c58a", PEND_TEXT = "#8a4a06"; // 26th S2: the record being asked about = the approval card's own colours (the earlier records stay pale)
const END_BORDER ="#f0d2d8", END_GAP = 14; // 22nd N3: the pale frame of 「終える」 and the extra space between it and 「窓をたたむ」「×」 (6 of the row's gap + 14 = 20 px)

export const DETAIL_TABS = (hasTerminal, kids) => [
  ...(hasTerminal ? [{ key: "terminal", label: "ターミナル", icon: "terminal" }] : []), { key: "chat", label: "会話", icon: "chat" },
  ...(kids > 0 ? [{ key: "tree", label: "チーム", icon: "tree", count: kids }] : [])];
// The tab that really exists for this person (an old choice that is gone falls back to the first).
export const tabFor = (want, hasTerminal, kids) => { const t = DETAIL_TABS(hasTerminal, kids); return t.some((x) => x.key === want) ? want : t[0].key; };

export class DetailPart {
  // The actions of one agent (data, so the window and the tests share them). ★101-3: moving spaces is the left list's drag only (no move / free
  // items). ★97: the one remaining item is putting a split team into one room (a manual press); the others are stop (the list) and end.
  agentMenuItems(a, list = [], withStop = false) {
    if (a?.source !== "app" || !a.address) return [];
    let sl = []; try { sl = spaces(); } catch {}
    const items = [];
    if (this.roomLive?.() && !isWorker(a, list)) { // ★85-4 a worker stays in its leader's room
      const st = teamSpaceState(a, list, sl), failed = !!this._teamFailed?.has(a.address);
      // ★97 the leader and its workers are in different rooms: only the press puts them together (the free-leader case is done by itself; if that
      // failed the same item is offered). With "auto" the leader goes to the workers, with "manual" the workers come to the leader (labels).
      if (st?.state === "manual" || (st?.state === "auto" && failed)) items.push({ id: "merge", label: "チームを1つの部屋にまとめる", fn: (cx) => this.doMove(a, teamFixPlan(a, list, sl), cx) });
    }
    if (withStop && a.status === "working") items.push({ id: "stop", label: "止める", fn: () => this.askStop(a) }); // (the window has its own ■)
    items.push({ id: "end", label: "終える", danger: true, fn: () => this.askEnd(a, list) });
    return items;
  }

  // Rename in place (the tab's name is the agent's name; `tab.rename {id, name}`): the input starts with the current name.
  startRename(a) { this.renaming = { id: a.id, state: renameState(a.name || a.address || "") }; }
  // ★96-3: a new name is the terminal's `display` label (hc label <t> display=<name>; Japanese is fine, the hc name is not touched), for a leader, a worker and a lone one alike.
  // `dispNow` shows it at once; items() drops it when the collector's labels.display has caught up.
  doRename(a, cx) {
    const name = String(this.renaming?.state?.value() ?? "").trim(); this.renaming = null;
    if (name && name !== a.name && a.address) {
      (this.dispNow ??= new Map()).set(a.address, name);
      cx.spawn(async (cx) => {
        try { const r = await hc(["label", a.address, `display=${name}`]); if (r?.code) throw new Error(String(r.stderr || `hc label: ${r.code}`).slice(0, 160)); }
        catch (e) { this.dispNow?.delete(a.address); this.opError = { id: a.id, text: String(e?.message ?? e), at: Date.now() }; }
        cx.notify();
      });
    }
    cx.notify();
  }

  // The head + the tabs. opts: { width, tab (the shown one), onTab(key, cx), face, hasTerminal }. `slide`: { select, close }.
  detailHead(a, list, slide, opts = {}) {
    this.seeState(a); // 38th 36-D2: the head's state (it is the first to say 作業中) is what the card block and the conversation compare with
    const ansNow = (() => { try { return answeredNow(a, shared("hakoniwa.apanswered")); } catch { return false; } })(); // 44th 42-J3: answered by the terminal key / the card copy saw the dialog gone, hc still says blocked: 「処理中…」
    const st = ansNow ? { ...STATE.working, label: "処理中…" } : stateOf(a), plat = platform(a), W = opts.width ?? 420;
    const demo = !!(shared("hakoniwa.demo") || this.feed.config?.demo), ci = commanderInfo(a, list), kids = this.familyRows(a, list).length - 1;
    const real = a.source === "app" && !!a.address && !demo;
    const items = this.agentMenuItems(a, list), renaming = !!this.renaming && this.renaming.id != null && this.renaming.id === a.id ? this.renaming : null;
    let sl = []; try { sl = spaces(); } catch {}
    const canRename = real, mergeItem = items.find((x) => x.id === "merge"); // ★96-2: any App person (the leader, a worker, a lone one: as the left list)
    const project = a.cwd ? String(a.cwd).split(/[\\/]/).filter(Boolean).pop() : null;
    const info = [a.source === "app" ? "Herdr App" : (platform(a).name), project, a.mem_bytes != null ? fmtMem(a.mem_bytes) : null].filter(Boolean).join(" · ");
    // ★104 U1: only a pill that can be pressed (the parent) has a frame (and the hand cursor, below); the others are plain text (same width: the plan counts the padding).
    const pill = (...k) => h_flex().min_w(0).overflow_hidden().whitespace_nowrap().gap(6).px(10).py(4).items_center().rounded(8).text_size(14).text_color(P.ink).children(k);
    const pressPill = (...k) => pill(...k).border(1).border_color(P.line).bg("#f0ede4").hover((s) => s.bg("#e8e3d6"));
    const nameRow = h_flex().gap(6).items_center().min_w(0)
      .child(renaming ? inlineRename("rename", renaming.state, (cx) => this.doRename(a, cx), (cx) => { this.renaming = null; cx.notify(); }, 20)
        : div().min_w(0).flex_1().h(30).overflow_hidden().truncate().text_size(22).font_weight(700).text_color(P.ink).child(String(a.name || a.address || "")))   // ★88-6 the whole name, up to two lines beside the face (was cut at the width)
      .when(!!renaming, (e) => e.child(div().flex_1()))
      // ★97 a split team: the press that puts it in one room (★101-4: not inside a "⋯" menu any more)
      .when(!renaming && !!mergeItem, (e) => e.child(div().id("merge-btn").flex_none().h(BTN).px(10).flex().items_center().rounded(8).bg("#fdf1d6").text_size(14).font_weight(700).text_color("#8a6a12")
        .cursor_pointer().hover((s) => s.bg("#fbeccb")).on_click((_e, cx) => { cx.stop_propagation(); this.menuFor = null; mergeItem.fn(cx); }).child("まとめる")))
      // ★101-4 the pencil (rename) and the trash (end this session, asked first) stand where the "⋯" was
      // ★105 (codex_3, decision 2): "終える" is a red-framed button with a label (the trash icon + text); the confirm dialog stays (askEnd)
      .when(!renaming && canRename, (e) => e.child(iconBtn("rename-btn", "pencil", (cx) => { this.startRename(a); cx.notify(); }, { size: BTN, isize: BICON }))
        .child(h_flex().id("end-btn").tooltip("この端末（セッション）を閉じます。押すとまず確認が出ます。作業中の途中の作業は止まり、元に戻せません").flex_none().h(BTN).px(10).gap(6).items_center().rounded(8).border(1).border_color(END_BORDER).bg("#ffffff").cursor_pointer() // 22nd N3: a pale frame (the red text and icon stay: it is the dangerous one), and a gap before the fold / close buttons
          .hover((s) => s.bg("#FDE8E8")).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.askEnd(a, list); })
          .child(icon("trash", 16, "#d6455d")).child(div().text_size(14).font_weight(700).text_color("#d6455d").child("終える")))
        .child(div().id("end-gap").flex_none().w(END_GAP)))
      .child(iconBtn("fold-btn", "right", () => slide.collapse?.(true), { size: BTN, isize: BICON, tip: "窓をたたむ: 右端の細い帯にたたみます（「開く」で戻せます）。エージェントは止まりません" })) // 26th S4: slide.collapse only sets hakoniwa.rcollapse (the window's width); nothing is sent to the agent
      //// ★103-4 fold to the right edge (the arrow points where it goes); 13th D5: tooltip
      .child(iconBtn("close-btn", "x", (cx) => slide.close(cx), { size: BTN, isize: BICON, tip: "窓を閉じる: この右の窓を閉じるだけです。エージェントは止まらず、一覧に残ります" })); // 26th S4: slide.close only asks the App to close the window (hakoniwa.close); 「終える」 is the one that ends the session
    // ★103 (width): the chips are planned by pixels on the real width (fitChips): the state chip stays whole, the others are cut with "…" or left out when they do not fit
    // 19th K6 (codex_3): one row = state + model (the program's name, the folder and the memory go to the tooltips of these two); the leader's mark says only "リーダー" (the head count is its tooltip).
    // 26th M2: the leader's name in the mark is cut at about 12 letters (tidy: no symbol / half word before "…", as L4); the whole name is its tooltip.
    const parentFull = ci.parent ? String(ci.parent.name || ci.parent.address || "") : "", parentShort = tidyCut(clipName(parentFull, NAME_EM));
    const stText = ansNow ? st.label : `${st.label} ${ago(a.since)}`, stopOn = a.status === "working" && real, kidsText = ci.commander && !ci.parent ? "リーダー" : null;
    // 27th T5 (office-fix32a): the leader's chip ("リーダー: 点検: 26回目の使いやす") was cut by the row's edge with no mark: the row is only as wide as the estimate (textPx) says, and a real pill is a little
    // wider, so the planned text was chopped by the clip. CHIP_SAFE leaves that much room so the plan cuts first, and a text the plan cut ends with "⋯" (tidyCut: no half word / symbol before it).
    const CHIP_SAFE = 24, chipsIn = [
      { key: "st", text: stText, extra: 9 + 6, keep: true },
      { key: "model", text: a.model_label ?? plat.name ?? "モデル不明", extra: 15 + 6 },
      ...(ci.parent ? [{ key: "parent", text: `リーダー: ${parentShort}`, extra: 14 + 6 }] : []),
      ...(kidsText ? [{ key: "kids", text: kidsText, extra: 6 }] : []),
    ];
    const plan = fitChips(W - 28 - CHIP_SAFE, chipsIn, stopOn ? BTN : 0, 64).map((c) => (c.text !== chipsIn.find((x) => x.key === c.key)?.text ? { ...c, text: tidyCut(c.text) } : c)); // ★104 U1: a chip that would get under 64px (about 4 letters) is left out, not shown as "Cla…"
    const txt = (k) => plan.find((c) => c.key === k)?.text;
    const chips = h_flex().flex_none().h(RIGHT_HEAD.chips).gap(6).items_center().overflow_hidden()
      // ★106 V7: the state chip is a label, not a button: a pale wash of its colour and no frame (the framed ones are the pressable ones: parent), and no hand cursor
      .child(pill(dot(st.color, 9), div().text_color(st.color).font_weight(700).child(txt("st") ?? stText)).bg(st.wash ?? P.white).id("head-state").tooltip(info))
      .when(stopOn, (e) => e.child(iconBtn("stop-btn", "stop", () => this.askStop(a), { size: BTN, isize: BICON, red: true, tip: "止める（作業を中断）: 押すと確認が出て、「はい」で作業を止めます" }))) // 37th 35-C5: the label-less red square says what it does (askStop = a confirm dialog first)
      // ★106 (remaining gap 7) / 19th K6: the program's icon and the model in ONE frame ("Sonnet", no ▾: it cannot be chosen here); the program's name is the tooltip
      .when(txt("model") != null, (e) => e.child(pill(platformIcon(a, 15), div().child(txt("model"))).border(1).border_color(P.line).bg(P.white).id("head-model").tooltip(plat.name)))
      .when(!!ci.parent && txt("parent") != null, (e) => e.child(pressPill(iconBtnless("link"), div().child(txt("parent"))).id("kin-parent").tooltip(`リーダー: ${parentFull}`).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); slide.select(ci.parent, cx); })))
      .when(!!kidsText && txt("kids") != null, (e) => e.child(pill(div().text_color("#d4a017").font_weight(700).child(txt("kids"))).id("head-leader").tooltip(`ワーカー ${ci.kids}人`)));
    // ★107 W2: the head is a box of a fixed height (headBodyH) that holds its content (headContentH), so the tabs under it keep their 36px and the blue line is not clipped.
    // A failure (★104 U12: gone after 8 s or with ×) takes the info line's place instead of adding a row.
    const err = this.opError?.id === a.id && !(this.opError.at && Date.now() - this.opError.at > 8000);
    const infoH = W < 380 ? RIGHT_HEAD.infoNarrow : RIGHT_HEAD.info;
    const head = v_flex().flex_none().relative().h(headBodyH(W)).overflow_hidden().px(14).pt(10).gap(6).bg(P.paper)
      .child(h_flex().flex_none().gap(10).items_center().child(this.face(a, 56, opts.face)).child(v_flex().flex_1().min_w(0).child(nameRow)))
      .child(chips)
      .child(err ? h_flex().flex_none().h(infoH).gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(14).text_color("#d6455d").child(String(this.opError.text ?? "失敗しました")))
        .child(iconBtn("operr-close", "x", (cx) => { this.opError = null; cx.notify(); }, { size: infoH, isize: 14 }))
        : div().flex_none().h(infoH)); // 19th K6: the place / folder / memory line is gone from the head (the state chip's tooltip); the slot stays so RIGHT_HEAD's heights hold (a failure still takes it)
    const tb = tabs("dtabs", DETAIL_TABS(opts.hasTerminal, kids), opts.tab, (k, cx) => opts.onTab(k, cx), { equal: true }); // ★105 R5
    return [head, tb];
  }

  // The old "⋯" popup (role "agent-menu"): kept for callers, the head no longer opens it (★101-4).
  openAgentMenu(a) { this.menuFor = this.menuFor === a.id ? null : a.id; }
  agentMenuView() {
    const p = props(), list = this.items(), a = list.find((x) => x.id === p.id);
    if (!a) return div();
    return menuList("amenu", this.agentMenuItems(a, list).map((it) => ({ ...it, fn: (cx) => { closeOverlay(p.overlay); it.fn(cx); } })));
  }

  // ★106 ①: what a waiting person asks (status kind + msg from hc) and the two answers. `this.apprs` (id -> {key, plan, busy, result}) is filled by
  // loadApproval (reads the terminal screen once per change of state, never in render). Only the user presses; nothing here is pressed by itself.
  // 45th office-fix50a: every read of a waiting person's options / every change of what the card draws goes to hakoniwa-office/approve-trace.json (the last 200, shared by all copies: read, add, write).
  // `copy` tells the window's pieces (and a window made again at a change of state) apart; `ap` = the hc status / since the copy had, `key` = id|since. Diagnostic only: nothing reads it back.
  traceApprove(ev) {
    try {
      this.apCopy ??= Math.random().toString(36).slice(2, 6);
      const row = { t: new Date().toISOString().slice(11, 23), copy: this.apCopy, role: props()?.role ?? null, ...ev }, path = `${appHome()}/hakoniwa-office/approve-trace.json`;
      this.apTraceQ = (this.apTraceQ ?? Promise.resolve()).then(async () => {
        for (let n = 0; n < 6; n++) { // copies write at the same moment: a write whose base changed is refused, so read again and retry
          const prev = await readTextFile(path).catch(() => null); let arr = []; try { const j = JSON.parse(prev || "[]"); if (Array.isArray(j)) arr = j; } catch {}
          arr.push(row);
          try { await writeTextFile(path, JSON.stringify(arr.slice(-200)), prev); return; } catch {}
        }
      }).catch(() => {});
    } catch {}
  }
  // 45th 43-K2 (office-fix50a): the window is made again while the person still waits (the key changes: a taller card = apH, the state moves), and every new copy of the card began with no entry = 「承認の内容を読み込み中…」
  // again although the buttons were already shown (the old copy's options are gone with it). The options a copy read are kept in the shared "hakoniwa.apcache" (id -> { key, plan, detail, at }); a copy with no entry of its
  // own for the SAME waiting episode (same key) starts from it (apSeed). Never for an answered episode (apanswered), and the cache is dropped when an answer is sent / noticed.
  apSeed(a) {
    try {
      const c = (shared("hakoniwa.apcache") ?? {})[a?.id], key = `${a?.id}|${a?.since}`; if (!c || c.key !== key || !planIsAsk(c.plan) || !(Date.now() - (c.at ?? 0) < 20000)) return null;
      if ((shared("hakoniwa.apanswered") ?? {})[a.id]?.key === key) return null;
      return { key, plan: c.plan, detail: c.detail ?? null, busy: false, result: null, at: c.at, tries: 0, seeded: true };
    } catch { return null; }
  }
  apCache(a, e) { try { const pc = shared("hakoniwa.apcache") ?? {}; if (e) setShared("hakoniwa.apcache", { ...pc, [a.id]: { key: e.key, plan: e.plan, detail: e.detail ?? null, at: Date.now() } }); else if (pc[a.id]) { const { [a.id]: _x, ...rest } = pc; setShared("hakoniwa.apcache", rest); } } catch {} }
  approvalEntry(a) { return a ? this.apprs?.get(a.id) ?? this.apSeed(a) : null; }
  async loadApproval(a, cx) {
    if (!a || a.status !== "blocked" || a.source !== "app" || !a.address) { this.apprs?.delete(a?.id); return; }
    const key = `${a.id}|${a.since}`, cur = (this.apprs ??= new Map()).get(a.id);
    if (!needsApprovalRead(cur, key)) return;
    const base = cur ?? this.apSeed(a); // 45th 43-K2: a new copy starts from the options another copy of this same waiting episode read (see apSeed)
    const tries0 = base?.key === key && !planIsAsk(base.plan) && !base.answered ? base.tries ?? 0 : 0; // 42nd: unreadable reads so far in this episode (the re-read gap grows with it)
    // 44th 42-J1: a re-read of the same episode keeps what the entry had (plan / detail; an unreadable plan draws 「承認の内容を読み込み中…」 while it is in the fast phase: approvalLoading), so the card does not
    // flip back to a bare `plan: null` entry on every read. A new episode starts empty.
    const same = base?.key === key;
    this.traceApprove({ ev: "load", id: a.id, key, prevKey: cur?.key ?? null, newEp: !same, hadPlan: planIsAsk(cur?.plan), since: a.since ?? null, tries: tries0 });
    this.apprs.set(a.id, { key, plan: same ? base.plan ?? null : null, busy: false, result: same ? base.result : null, at: Date.now(), tries: tries0, ...(same && base.detail ? { detail: base.detail } : {}), ...(same && base.answered ? { answered: true } : {}) });
    try {
      const r = await hc(["read", a.address]), scr = r?.stdout ?? "", plan = approvalPlan(scr), prevRead = shared("hakoniwa.apread") ?? {}, now = Date.now();
      // 42nd 40-H1: an unreadable screen after the options were once read in this same waiting episode = answered (the state is not caught up yet): no orange card, no 「端末で答えてください」
      const answered = answeredPlan(plan, prevRead[a.id], key, now), ns = readSeenNext(plan, key, now);
      if (ns) try { setShared("hakoniwa.apread", { ...prevRead, [a.id]: ns }); } catch {}
      this.apprs.set(a.id, { key, plan, detail: approvalDetailLines(scr), busy: false, result: null, at: now, tries: planIsAsk(plan) || answered ? 0 : tries0 + 1, ...(answered ? { answered: true } : {}) }); // 22nd N2: what is asked, from the dialog on the screen
      { const en = this.apprs.get(a.id); if (planIsAsk(plan)) this.apCache(a, en); else if (answered) this.apCache(a, null); }
      this.traceApprove({ ev: "read", id: a.id, key, readable: planIsAsk(plan), yes: plan.yes ?? null, no: plan.no ?? null, tries: this.apprs.get(a.id)?.tries ?? null, answered });
      if (answered) { try { const pa = shared("hakoniwa.apanswered") ?? {}; setShared("hakoniwa.apanswered", { ...pa, [a.id]: { key, at: now } }); } catch {} } // read by the conversation copy: its orange record is the same old dialog
    } catch { this.apprs.set(a.id, { key, plan: approvalPlan(""), detail: approvalDetailLines(""), busy: false, result: null, at: Date.now(), tries: tries0 + 1 }); }
    cx?.notify?.();
  }
  // 43rd 41-I1 (office-fix48a): the card block only. While the buttons are shown the screen is read again about every second (rereadDue); a screen whose dialog is gone after its options were read
  // in this episode = answered (the same `answered` as 40-H1: no buttons, no card), without waiting for the state. The entry is never reset while it reads (the buttons do not flash 「読み込み中…」).
  async recheckApproval(a, cx) {
    const key = `${a.id}|${a.since}`; if (!rereadDue(this.apprs?.get(a.id), key)) return;
    const rr = (this.apRr ??= new Set()); if (rr.has(a.id)) return; rr.add(a.id);
    try {
      const r = await hc(["read", a.address]), plan = approvalPlan(r?.stdout ?? ""), now = Date.now(), e = this.apprs.get(a.id);
      if (!e || e.key !== key || e.busy || e.answered) return; // answered by a button / another read meanwhile
      { const rv = `${key}|${planIsAsk(plan)}`; if (this.apRv !== rv) { this.apRv = rv; this.traceApprove({ ev: "reread", id: a.id, key, readable: planIsAsk(plan), answered: !planIsAsk(plan) && answeredPlan(plan, (shared("hakoniwa.apread") ?? {})[a.id], key, now) }); } } // only when the result changes (it runs every ~1 s)
      if (planIsAsk(plan)) { // still asking: the time of the read moves, and so does the shared "options were read" stamp (45th office-fix50a: it was written once at the first read and expired after READ_SEEN_MS = 2 min, so a long wait never noticed an answer given in the terminal: answered stayed false)
        this.apprs.set(a.id, { ...e, at: now }); this.apCache(a, { ...e, at: now });
        try { const ns = readSeenNext(plan, key, now); if (ns) setShared("hakoniwa.apread", { ...(shared("hakoniwa.apread") ?? {}), [a.id]: ns }); } catch {}
        return;
      }
      if (answeredPlan(plan, (shared("hakoniwa.apread") ?? {})[a.id], key, now)) {
        this.apprs.set(a.id, { ...e, answered: true, at: now, tries: 0 }); this.apCache(a, null);
        try { const pa = shared("hakoniwa.apanswered") ?? {}; setShared("hakoniwa.apanswered", { ...pa, [a.id]: { key, at: now } }); } catch {}
        cx?.notify?.();
      }
    } catch {} finally { rr.delete(a.id); }
  }
  watchApprovals(cx) { // (started by initChat and by the inbox window)
    cx.timer.every(500, (cx) => { // 42nd 40-H2: 0.5 s (was 2 s): the buttons come as soon as the state says "blocked"; the screen is read only when needsApprovalRead says so
      let list = []; try { list = this.items?.() ?? []; } catch {}
      for (const a of list) if (a.status === "blocked" && a.source === "app" && a.address) { const sm = (this.apSince ??= new Map()), was = sm.get(a.id); if (was !== a.since) { sm.set(a.id, a.since); if (was !== undefined) this.traceApprove({ ev: "since-change", id: a.id, from: was, to: a.since ?? null, msg: String(a.msg ?? "").slice(0, 40) }); } } // 45th office-fix50a
      for (const a of list) if (a.status === "blocked" && a.source === "app" && a.address) { const e = this.apprs?.get(a.id); if (needsApprovalRead(e, `${a.id}|${a.since}`)) cx.spawn(async (cx) => this.loadApproval(a, cx)); } // 42nd 40-H1/H2: also re-reads an entry that was unreadable (1 s) or answered (4 s)
      if (props()?.role === "chat-approve") for (const a of list) if (a.status === "blocked" && a.source === "app" && a.address && rereadDue(this.apprs?.get(a.id), `${a.id}|${a.since}`)) cx.spawn(async (cx) => this.recheckApproval(a, cx)); // 43rd 41-I1: the card block only (the others and the inbox stay as they are)
      if (this.apprs) for (const id of [...this.apprs.keys()]) if (!list.some((x) => x.id === id && x.status === "blocked")) this.apprs.delete(id);
    });
  }
  // ★106 ②: open the inbox. Region on: the right region shows it (shared flag, read by syncRegion); off: a window of its own.
  openInbox() {
    if (this.regionFlag && !this.regionBroken) { setShared("hakoniwa.inboxOpen", { on: true, at: Date.now() }); return; }
    // X2 (★108): never over the right window: when it is open (termBox = where it is) the inbox sits at its left edge; the height is the right window's (no big empty space under the cards)
    const tb = this.termBox, w = 440, n = Math.max(1, this.items().filter((a) => a.status === "blocked" || a.status === "done").length), h = Math.min(tb?.h ?? 600, 130 + n * 120);
    openOverlay({ mod: "hakoniwa", kind: "window", key: "hakoniwa-inbox", width: w, height: h, ...(tb && tb.x - w - 8 >= 0 ? { at: { x: tb.x - w - 8, y: tb.y } } : {}), props: { role: "inbox" } });
  }
  // 38th 36-D2 (office-fix43b): the newest state each copy saw per person (shared "hakoniwa.seenstate"); liveOf draws a stale "blocked" row as what the newer copy saw (no card, no buttons).
  seeState(a) {
    try { const prev = shared("hakoniwa.seenstate") ?? {}, n = seenNext(a, prev[a?.id]); if (n) setShared("hakoniwa.seenstate", { ...prev, [a.id]: n }); } catch {}
    return a;
  }
  liveOf(a) { try { return liveState(this.seeState(a), shared("hakoniwa.seenstate")); } catch { return a; } }
  askApprove(a, want, cx) {
    const e = this.approvalEntry(a); if (!a?.address || e?.busy) return;
    this.apprs.set(a.id, { ...(e ?? { key: `${a.id}|${a.since}`, plan: null }), busy: true, result: null }); cx.notify();
    cx.spawn(async (cx) => {
      let res;
      try { res = await answerApproval({ hc, sleep: (ms) => cx.sleep(ms) }, a.address, want); } catch (err) { res = { ok: false, reason: "send-failed", detail: String(err?.message ?? err) }; }
      if (res.ok) this.apCache(a, null);
      if (res.ok) { try { const prev = shared("hakoniwa.seenstate") ?? {}, n = seenNext({ ...a, status: "working" }, prev[a.id]); if (n) setShared("hakoniwa.seenstate", { ...prev, [a.id]: n }); } catch {} } // 38th 36-D2: an answer that moved the state hides the card in every copy at once
      const cur = this.apprs.get(a.id) ?? {};
      this.apprs.set(a.id, { ...cur, busy: false, plan: res.ok ? null : cur.plan, key: res.ok ? null : cur.key, result: res.ok ? { ok: true, text: want === "no" ? "却下しました" : "承認しました", at: Date.now() } : { ok: false, text: REASON_TEXT[res.reason] ?? "答えられませんでした", at: Date.now() } });
      if (res.ok && want === "no") { try { this.rejectState?.focus(); } catch {} } // 27th T4: after 却下 the keyboard goes to the reason input (it works where the input is in this same window, e.g. the region; the window's input block is another view: nothing happens there)
      cx.notify();
    });
  }
  // The answer buttons for one person (the right column and the inbox cards share them). null when nothing is to be asked.
  approveButtons(a, opts = {}) {
    a = this.liveOf(a); // 38th 36-D2: no buttons for a row another copy already saw as not waiting
    if (!a || a.status !== "blocked") return null;
    const e = this.approvalEntry(a), plan = e?.plan, h = opts.h ?? 44, id = opts.idp ?? "approve";
    { // 45th office-fix50a: what this card draws, logged when it changes (loading / buttons / terminal / busy / none)
      const drawn = e?.answered ? "none" : e?.busy ? "busy" : approvalLoading(e) ? "loading" : (!plan?.readable || (plan.yes == null && plan.no == null)) ? "terminal" : "buttons", dk = `${id}|${a.id}|${drawn}|${e?.key ?? ""}`, dm = (this.apDrawn ??= new Map());
      if (dm.get(`${id}|${a.id}`) !== dk) { dm.set(`${id}|${a.id}`, dk); this.traceApprove({ ev: "draw", id: a.id, idp: id, drawn, key: e?.key ?? null, tries: e?.tries ?? null, answered: !!e?.answered }); }
    }
    if (e?.answered) return null; // 42nd 40-H1: answered in the terminal, the state is not caught up: nothing to ask (no 「端末で答えてください」, which is only for a dialog that was never readable)
    const note = e?.result && Date.now() - e.result.at < 8000 ? e.result : null;
    const noteView = note ? div().text_size(13).text_color(note.ok ? "#2f9e6f" : "#d6455d").child(note.text) : null;
    const btn = (key, label, ic, fn, fill) => h_flex().id(`${id}-${key}-${a.id}`).flex_1().h(h).gap(6).items_center().justify_center().rounded(8).border(1).border_color(fill ? P.blue : P.line).bg(fill ? P.blue : "#ffffff")
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(icon(ic, 18, fill ? "#ffffff" : P.ink)).child(div().text_size(17).font_weight(700).text_color(fill ? "#ffffff" : P.ink).child(label));
    if (e?.busy) return v_flex().gap(4).child(div().text_size(14).text_color(P.muted).child("送っています…"));
    // 34th 34-B2: one Japanese line while the buttons are not there yet (the buttons themselves are unchanged)
    if (approvalLoading(e)) return v_flex().gap(4).child(div().id("approval-loading").text_size(14).text_color(P.muted).child("承認の内容を読み込み中…")).when(!!noteView, (x) => x.child(noteView));
    if (!plan.readable || (plan.yes == null && plan.no == null)) return v_flex().gap(4).child(div().text_size(14).text_color("#8a6a12").child("端末で答えてください")).when(!!noteView, (x) => x.child(noteView));
    return v_flex().gap(4).child(h_flex().gap(8)
      .when(plan.yes != null, (x) => x.child(btn("yes", "承認", "check", (cx) => this.askApprove(a, "yes", cx), true)))
      .when(plan.no != null, (x) => x.child(btn("no", "却下", "x", (cx) => this.askApprove(a, "no", cx), false))))
      .when(!!noteView, (x) => x.child(noteView));
  }
  // The card under the head: what is asked (hc status kind + msg).
  // 32nd 31-Y1 (office-fix37a): true when the conversation shows the orange 「承認待ち／Write(…)」 record (the same test as chatBodyView's `pe`), so the card need not say it again.
  // Original heading row (to restore): see done2-W.md office-fix37a. Without it the card starts at the question and the buttons.
  pendingRecordShown(a) {
    if (a?.status !== "blocked") return false;
    try {
      const d = this.chat?.data; if (d?.kind !== "screen") return false;
      const sd = stripApprovalDialog(unwrapHcScreen(d.screen)); if (!sd.cut) return false;
      const f = foldScreenHead(sd.text);
      return markPending(splitToolBlocks(f.n > 0 ? f.rest : sd.text)).some((b) => b.pending);
    } catch { return false; }
  }
  // 38th 36-D3 (office-fix43b): the text of that orange record ("" when it is not shown), compared with hc's ask line (askInRecord)
  pendingRecordText(a) {
    if (!this.pendingRecordShown(a)) return "";
    try { const sd = stripApprovalDialog(unwrapHcScreen(this.chat.data.screen)), f = foldScreenHead(sd.text); return String(markPending(splitToolBlocks(f.n > 0 ? f.rest : sd.text)).find((b) => b.pending)?.text ?? ""); } catch { return ""; }
  }
  // 34th (office-fix40a, A6): the real height of each part of the approval card and of the turn-end line, written to right-edge-diag.json as "approve-measure" (the looks are unchanged).
  // The window's pieces are separate copies (the card block, the conversation), so they meet in shared "hakoniwa.apmeasure": { part: { w, h, at } } (an old `at` = that part was not drawn lately).
  // "end-text" is the text's own height inside the 20px end row: above 20 means the row clips the 16px text.
  apMeasure(key) {
    return (size) => {
      const h = Math.round(size?.height ?? 0), w = Math.round(size?.width ?? 0), prev = shared("hakoniwa.apmeasure") ?? {};
      if (prev[key]?.h === h && prev[key]?.w === w) return;
      const next = { ...prev, [key]: { w, h, at: Date.now() } };
      // One file per part (approve-measure-<part>.json): successive writes to the one right-edge-diag.json lost each other (diagWrite swaps against the text it read; 11/8 measured: only the first 5 writes landed)
      try { setShared("hakoniwa.apmeasure", next); const p = this.bodyProps?.() ?? props(); this.diagWrite?.(`approve-measure-${key}`, { part: key, w, h, at: next[key].at, role: p?.role ?? null, ap: p?.ap ?? null, apH: p?.apH ?? null, headed: next.heading?.at > Date.now() - 3000 }); } catch {}
    };
  }
  approvalAsk(a) {
    a = this.liveOf(a);
    if (!a || a.status !== "blocked") return null;
    if (this.approvalEntry(a)?.answered) return div().id("approval-answered").flex_none(); // 42nd 40-H1: answered in the terminal (the options were read once, the screen has no dialog now): no orange card until the state catches up
    const cardW =Number((shared("hakoniwa.apmeasure") ?? {}).card?.w) || 0, askFull = askLine(blockedText(a), inboxWhat(this.approvalEntry(a))), askClamp = clampAsk(askFull, cardW, 2); // 39th 37-E1: the paragraph is at most 2 lines (buttons always fit); the whole text is the tooltip
    const headed = !this.pendingRecordShown(a), dupAsk = askInRecord(blockedText(a), this.pendingRecordText(a)); // 38th 36-D3: hc's "approve PowerShell: <command>" paragraph is left out when the orange record shows that command (the buttons are unchanged)
    return v_flex().id("approval-ask-wrap").flex_none().px(14) // 34th 33-A2: no pt: with the orange record above (headed = false) the card starts at its bottom edge (one card); chat.js APPROVE_TOP = 0
      .child(v_flex().id("approval-ask").gap(6).px(12).py(10).bg("#fff1df").border(1).border_color("#f2c58a").on_size_change(this.apMeasure("card")).when(headed, (x) => x.rounded(10)).when(!headed, (x) => x.rounded_b(10))
        .when(headed, (x) => x.child(h_flex().id("approval-heading").gap(6).items_center().on_size_change(this.apMeasure("heading")).child(dot(STATE.blocked.color, 10)).child(div().text_size(14).font_weight(700).text_color("#8a4a06").child("承認を待っています"))))
        .when(!!this.approvalEntry(a)?.detail, (x) => x.child(v_flex().id("approval-what").gap(2).on_size_change(this.apMeasure("what")).children((this.approvalEntry(a).detail ?? []).map((t, i) => { const w1 = dropWhatTip(t), c1 = clampAsk(w1, cardW, 1); return div().id(`approval-what-${i}`).min_w(0).text_size(15).font_weight(i === 0 ? 700 : 400).text_color(P.ink).font_family(settings().font_family ?? "Consolas").tooltip(w1).child(c1.text); })))) // 39th 37-E4: no "· Tip: ..." after the first line; 37-E1: each line is at most one line (the reserved two), the whole text is the tooltip
        .when(askLine(blockedText(a), inboxWhat(this.approvalEntry(a))) !== "" && !dupAsk, (x) => x.child(div().id("approval-ask-line").text_size(16).text_color(P.ink).on_size_change(this.apMeasure("askline")).tooltip(askFull).child(askClamp.text))) // 27th T2: not again what the heading says; a path only as its file name
        .child(div().id("approval-buttons").on_size_change(this.apMeasure("buttons")).child(this.approveButtons(a)))
        .when(!headed && this.approvalEntry(a)?.plan?.no != null, (x) => x.child(v_flex().id("approval-no-hint").on_size_change(this.apMeasure("hint"))
          .child(div().text_size(13).text_color(APPROVE_HINT).child("承認: このまま続けます"))
          .child(div().text_size(13).text_color(APPROVE_HINT).child("却下: 止めます"))))); // 43rd 41-I5: the input's own line above it already says where the reason goes (「却下のあと、理由はここに書いて送信」); was 「却下: 止めます。そのあと下の欄で理由を送信（理由は省略可）」 // 34th 33-A8: 「理由は省略可」 added (what 却下 does is unchanged) // 26th S1: 却下 presses the "No" number (answerApproval) = the agent stops; the reason is typed in the input below and goes with hc send (text + Enter) as the next message, not with the 却下 press // 26th M3: one step darker than P.muted (size unchanged). 20th H5 / 19th K2: what 承認 and 却下 do (two lines; Esc = no; the next instruction goes in the input)
  }
  // ★106 ②: the inbox (cards of the people who wait or report); the right window shows it when nobody is chosen.
  inboxView() { return inboxView(this); }

  // 19th G1 (paused): following the end of the conversation would need a `list` with a VirtualListScrollHandle, but the list route showed an empty conversation (office-ux15).
  // The caller keeps the plain scroll; the fitted conversation (fitConversation, newest first) already shows the latest. The list-route code was removed (tidy22); see oc-g1-list.md for the plan.
  tailScroll(els, id, sig) {
    return null;
  }

  // Role "chat-body": the conversation under the tabs (the "会話" tab of the window).
  chatBodyView() {
    if (props()?.role === "chat-body") this.probeRightWin?.(); // 13th B1/B2: report the size the App really gave this window (read by the office copy)
    const p = (this.bodyProps?.() ?? props()), d = this.chat?.data, list = this.items(), found = this.liveOf(list.find((x) => x.id === p.id)), msgs = d?.messages ?? [], plat = found ? platform(found) : { name: p.name ?? "" };
    // 33rd 32-Z1: a window opened again for a waiting person has not read the list yet (found = nothing): its props say it waits (the card is its own block), so `a` is a stand-in
    // that waits (fromProps: chat.js convBox takes the block's height from apH), and it is drawn as waiting from the first frame
    const a = found ?? (p.ap === 1 && p.apH > 0 ? { id: p.id, status: "blocked", fromProps: true, apH: p.apH } : undefined);
    let body, tail = null, pin = null; // 27th T1: pin = the open record + the "answer below" line under the scroll
    if (this.chat?.loading && !d) body = div().p(14).text_size(15).text_color(P.muted).child("読み込み中…");
    else if (d?.error && !(msgs.length || d.screen)) body = div().p(14).text_size(15).text_color("#d6455d").child(String(d.error ?? ""));
    else if (d?.kind === "screen" && screenBodyMode(unwrapHcScreen(d.screen), msgs.length, this.chatYoung?.()) === "loading") { this.chatYoungShown = true; body = div().id("chat-young-loading").p(14).text_size(15).text_color(P.muted).child("読み込み中…"); } // 43rd 41-I4: a copy that began moments ago whose screen is still the start-up banner (not a conversation yet): one line, not the banner (the watch redraws after YOUNG_MS)
    else if (d?.kind === "screen") { // ★107 W3: a copy of the screen (no transcript). Claude Code's fixed start-up block is folded to one line (foldScreenHead); a press opens it. Not guessed: only that block.
      const sd0 = a?.status === "blocked" ? stripApprovalDialog(unwrapHcScreen(d.screen)) : openApprovalCut(unwrapHcScreen(d.screen)), sd = sd0.cut ? sd0 : { ...sd0, text: stripTerminalFrame(sd0.text).text }, f = // 30th 29-W1: a state that is not yet "blocked" but a screen that already ends with the dialog is cut too (openApprovalCut) // 28th 27-U1/U2: the terminal's own input box and footer are cut from the end, so the last reply is the end of the conversation
 foldScreenHead(sd.text), open = !!this.screenHeadOpen, mono = (t) => div().text_size(16).text_color(P.ink).font_family(settings().font_family ?? "Consolas").child(String(t));
      // 27th T1 (office-fix32a): on the 2nd approval the open Write record sat below the window (the plain scroll starts at the top and the estimate of the rows fell short by the framed record's own label), so it is drawn
      // OUTSIDE the scroll, right under it (`pin`), and the fit leaves room for it (PEND_EXTRA = its label + frame; its lines are counted by the fit itself).
      const pend0 = sd.cut ? markPending(splitToolBlocks(f.n > 0 ? f.rest : sd.text)).find((b) => b.pending) : null;
      const scr = dropTipLines(f.n > 0 ? f.rest : (sd.text || "（画面が空です）")); // 34th 33-A1: the Tip lines (working) are out before the rows are counted
      const sf = this.fitScreen ? this.fitScreen(scr, a ?? { id: p.id }, (sd.cut ? 30 + (pend0 ? PEND_EXTRA : 0) : 0) - (sd.cut && a?.status === "blocked" ? 30 : 0)) : { text: scr, hidden: 0 }; // 25th R1: newest lines that fit (the plain scroll starts at the top, so a 2nd turn fell below the window)
      const showHead = f.n > 0 && sf.hidden === 0; // 34th 34-B8: one rule for every state (working / done / waiting): the start-up band is drawn only when nothing older is folded above the visible lines (it is the very top of the screen)
      const elapsed = Math.max(0, Math.min(30, Math.floor((Date.now() - (this.chat?.at ?? Date.now())) / 1000))); // 34th 34-B7: seconds since the screen was read; the spinner row's seconds = the last read + that
      const allBlocks = (sd.cut ? markPending(splitToolBlocks(sf.text)) : splitToolBlocks(sf.text)).map((b) => b.kind === "work" && elapsed > 0 ? { ...b, text: advanceWork(b.text, elapsed) } : b);
      body = v_flex().p(12).gap(2).on_size_change(this.apMeasure("conv-body")).when(a?.status === "blocked" && sf.hidden > 0, (e) => e.min_h_full().justify_end()) // 38th 36-D4: only a conversation that is folded (older lines hidden) sits at the bottom; one that fits starts at the top (no blank above it) // 37th 35-C2: while the card waits the lines sit at the bottom of the scroll (right above the record / card), so the room the estimate leaves over is above them, not between the record and the card; conv-body / conv-frame (approve-measure-*.json) = the real heights, to compare after install // 32nd 31-Y7: the rows (instruction / record / reply / 完了) are closer (gap 6 -> 2; the tool record's py 4 -> 2); text sizes unchanged; the fit's estimates (SCREEN) are on the safe side, so only more room is left
        .when(showHead,(e) => e.child(h_flex().id("screen-head-toggle").flex_none().h(UI.hit).px(10).gap(6).items_center().rounded(8).bg("#f0ede4").cursor_pointer().hover((s) => s.bg("#e8e3d6"))
          .on_click((_e, cx) => { cx.stop_propagation(); this.screenHeadOpen = !open; cx.notify(); })
          .child(icon(open ? "down" : "right", 14, P.muted)).child(div().text_size(14).text_color(P.muted).child(open ? "起動時の表示をたたむ" : `起動時の案内（${f.n}行）はたたんでいます。押すと開きます`))))
        .when(showHead && open, (e) => e.child(mono(f.head)))
        .when(sf.hidden > 0, (e) => e.child(h_flex().id("chat-older").flex_none().h(UI.hit).px(12).gap(6).items_center().rounded(8).bg("#f0ede4").cursor_pointer().hover((s) => s.bg("#e8e3d6")) // 25th R1: the screen copy shows its newest lines (a press goes back one more screen)
          .on_click((_e, cx) => { cx.stop_propagation(); this.convBackMore(a?.id ?? p.id); cx.notify(); })
          .tooltip(`古いやりとりを表示（上に ${sf.hidden} 行）`) // 34th 34-B5: the terminal's line count (it jumps between states) is the tooltip, not the label
          .child(div().text_size(14).font_weight(700).text_color(P.muted).child("↑ 古いやりとりを表示"))))
        .when(!sd.cut || String(f.n > 0 ? f.rest : sd.text).trim() !== "", (e) => e.children(allBlocks.flatMap((blk, i) => blk.pending ? [] : [blk.kind === "tool" // 22nd N7: a tool record (Searched… / Write(…) and its ⎿ lines) in a pale thin frame, apart from what was said
          ? div().id(`screen-tool-${i}`).w_full().px(8).py(1).rounded(6).border(1).border_color(TOOL_BORDER).bg(TOOL_BG).text_size(16).text_color(P.muted).font_family(settings().font_family ?? "Consolas").tooltip(String(blk.text).trim()).child(toolMark(blk.text) ? h_flex().id(`screen-tool-row-${i}`).gap(6).child(div().id(`screen-tool-mark-${i}`).flex_none().text_size(16).font_weight(700).text_color(toolMark(blk.text) === "ok" ? STATE.done.color : "#d6455d").child(toolMark(blk.text) === "ok" ? "✓" : "✕")).child(div().min_w(0).child(toolLabel(blk.text))) : toolLabel(blk.text)) // 34th 33-A7: a small ✓ (created / edited) or ✕ (rejected) in front // 31st 30-X5: a known search / read record reads in Japanese (the original is the tooltip)
          : blk.kind === "work" ? div().id(`screen-work-${i}`).w_full().text_size(16).text_color(P.muted).font_family(settings().font_family ?? "Consolas").child(workLabel(blk.text)) // 34th 33-A1: the spinner line "Frolicking… (3s · …)" -> 「作業中…（3秒）」
          : blk.kind === "end" ? div().id(`screen-end-${i}`).w_full().h(20).text_size(16).text_color(P.muted).font_family(settings().font_family ?? "Consolas").child(div().id(`screen-end-text-${i}`).on_size_change(this.apMeasure("end-text")).child(endLabel(blk.text, endRejected(allBlocks, i)))) // 34th 33-A7: after a 「却下しました」 record it reads 「却下で終了（3秒）」 // 23rd P4: the turn-end line in a pale text // 30th 29-W5: a known form ("✻ Churned for 3s · done 6:35") reads 「完了（3秒）」, an unknown one stays
          : blk.kind === "from" ? h_flex().id(`screen-from-${i}`).w_full().gap(8).items_center().text_size(blk.again ? 12 : 16).text_color(P.muted).font_family(settings().font_family ?? "Consolas").tooltip(String(blk.title)).child(String(blk.label)).when(!!blk.name, (e) => e.child(div().id(`screen-from-name-${i}`).text_size(12).text_color(FROM_NAME).child(String(blk.name)))) // 25th R5: the parent's name beside it in pale small text // 23rd P5: 「（親から）」; the address and name are the tooltip
          : mono(blk.text)])));
      // 27th T1: the open record and the "answer below" line stand right under the scroll (never cut off, whatever the row estimate)
      const pe = allBlocks.find((b) => b.pending);
      const joined = a?.status === "blocked" && !!pe; // 34th 33-A2: the orange record and the card below it are one card (same x and width, no strip, the record's lower border and corners are the card's)
      const staleDialog = props()?.role === "chat-body" && a?.status !== "blocked" && ((!!this.unblockedAt && (this.chatDataFrom ?? 0) < this.unblockedAt) || (!!this.seedBlocked && this.chatDataFrom == null)); // 41st 39-G1: a reopened window draws the screen it was handed from the cache (read while the person waited) until its own first read lands; 40th 38-F2: the person stopped waiting after this screen was read: its dialog is old, so no orange record / 「承認を待っています」 until a newer read lands
      const ansA = props()?.role === "chat-body" && a?.status === "blocked" ? (shared("hakoniwa.apanswered") ?? {})[a.id] : null, answeredDialog = !!ansA && ansA.key === `${a.id}|${a.since}` && (ansA.at ?? 0) > (this.chatDataFrom ?? 0); // 42nd 40-H1: the card copy read a screen without the dialog after it had read the options = answered; this copy's screen (read before that) still ends with the dialog, so its orange record is old too
      if (answeredDialog) body = body.child(div().id("answered-working").w_full().text_size(16).text_color(P.muted).font_family(settings().font_family ?? "Consolas").child("作業中…")); // 44th 42-J5: right after an answer the working line comes first (the screen read before it still ends with the dialog)
      if (sd.cut && !a?.stale && !staleDialog && !answeredDialog) pin = v_flex().id("screen-pin").flex_none().px(joined ? 14 : 12).pb(joined ? 0 : 6).gap(6).bg(P.paper)
        .when(!!pe, (e) => e.child(v_flex().id("screen-tool-pending").w_full().gap(2).px(joined ? 12 : 8).py(4).on_size_change(this.apMeasure("record")).bg(PEND_BG).border(1).border_color(PEND_BORDER).when(joined, (x) => x.rounded_t(10).border_b(0)).when(!joined, (x) => x.rounded(6)).child(div().text_size(12).font_weight(700).text_color(PEND_TEXT).child("承認待ち")).child(div().text_size(16).text_color(P.ink).font_family(settings().font_family ?? "Consolas").child(String(pe.text))))) // 26th S2: the open question
        .when(!(a?.status === "blocked" && !!pe) && a?.status !== "blocked", (e) => e.child(div().id("approve-dialog-note").flex_none().text_size(14).text_color(P.muted).child(a?.status === "blocked" ? "↓ 下のカードで答えてください" : "承認を待っています"))); // 31st 30-X1: with the orange 「承認待ち」 heading (pe) and the card there (blocked) the line is not drawn; the switch-over seconds keep 「承認を待っています」 // 30th 29-W1: the card is not there until the state is "blocked" // 18th F2: the dialog is cut (the card below asks the same); a pale line says where to answer
    }
    else {
      // 20th H1: the newest messages that fit, oldest on top; a row above says how many older ones are not drawn (a press goes back one more screen). The scroll stays as a safety.
      { // 21st I5: the review command hakoniwa.convback (main.js) = a press on 「↑ 前の発言を読む」. The first look only remembers the stamp (an old command does not apply).
        const cb = shared("hakoniwa.convback");
        if (this.convbackSeen === undefined) this.convbackSeen = cb?.at ?? null;
        else if (cb?.at && cb.at !== this.convbackSeen) { this.convbackSeen = cb.at; this.convBackMore(a?.id ?? p.id); }
      }
      const fit = this.fitConv(msgs, a ?? { id: p.id }), els = this.messageList(fit.msgs, a ? plat.name : (p.name || "エージェント"), a?.status), last = msgs[msgs.length - 1];
      tail = this.tailScroll(els, `${p.id ?? ""}`, `${msgs.length}|${String(last?.text ?? "").length}|${a?.status ?? ""}`);
      if (!tail) body = v_flex().min_h_full().gap(8).px(14).py(8)
        .when(fit.hidden > 0, (e) => e.child(h_flex().id("chat-older").flex_none().h(UI.hit).px(12).gap(6).items_center().rounded(8).bg("#f0ede4").cursor_pointer().hover((s) => s.bg("#e8e3d6"))
          .on_click((_e, cx) => { cx.stop_propagation(); this.convBackMore(a?.id ?? p.id); cx.notify(); })
          .child(div().text_size(14).font_weight(700).text_color(P.muted).child(`↑ 前の発言を読む（${fit.hidden} 件）`))))
        .children(els);
    }
    // ★107 W3: the root clips (overflow_hidden) and the scroll takes what is left (flex_1, min_h 0), so the composer below it stays at the window's bottom however long the text is
    // 13th D1: the approval card is pinned right above the input (codex_3): it is not in the scroll, so it does not move with the conversation.
    // The window (role chat-body) shows it as its own block between the conversation and the input (approveBlockView); the region (rchat) keeps it here.
    return v_flex().id("chat-body-root").size_full().overflow_hidden().bg(P.paper)
      .child(h_flex().flex_none().px(14).py(4).justify_end().child(iconBtn("chat-refresh", "refresh", (cx) => cx.spawn(async (cx) => this.loadChat(cx)), { size: BTN, isize: BICON })))
      .child(v_flex().id("chat-body-frame").flex_1().min_h(0).relative().overflow_hidden().on_size_change(this.apMeasure("conv-frame")) // 18th F4: a soft fade at the bottom edge of the scroll says "there is more", so a cut last line does not look broken
        .child(tail ?? div().id("chat-body-scroll").size_full().overflow_y_scrollbar().child(body))
        .child(v_flex().id("chat-body-fade").absolute().left(0).right(0).bottom(0).h(FADE_H).children(FADE_ALPHA.map((o) => div().flex_1().w_full().bg(P.paper).opacity(o)))))
      .when(!!pin, (e) => e.child(pin))
      .when(props()?.role !== "chat-body" && !!a && a.status === "blocked", (e) => e.child(this.approvalAsk(a)))
      .when(props()?.role !== "chat-body", (e) => e.child(this.composer(a))); // the window (role chat-body) has the input as its own block (composerView); the region (rchat) keeps it here
  }
  // 13th D1: the window's approval block (between chat-body and chat-input). It exists only while the person waits (chat.js adds the block then); blank otherwise.
  approveBlockView() {
    const p = (this.bodyProps?.() ?? props()), a = this.liveOf(this.items().find((x) => x.id === p.id)); // 38th 36-D2: a row another copy saw as not waiting draws no card
    // 34th 33-A2: no blank strip above the card any more (chat.js APPROVE_GAP = 0): the orange record (pin) is joined to it
    return v_flex().id("chat-approve-root").size_full().bg(P.paper).child(a && a.status === "blocked" ? this.approvalAsk(a) : div());
  }
  // X1: the input as a block of its own (window layout, fixed height at the bottom)
  composerView() {
    this.probeRightWin?.(); // 13th B1/B2
    const p = (this.bodyProps?.() ?? props()), a = this.liveOf(this.items().find((x) => x.id === p.id));
    // ★109: say why (not a blank). 33rd 32-Z1: but not in the first MISS_GRACE ms after a window is opened again (the list is not read yet: blank), and never with the internal id (it is the tooltip)
    const over = this.missGraceOver ? this.missGraceOver(!!a) : !a;
    const standIn = a ? null : composerStandIn(p); // 43rd 41-I3 (office-fix48a): a copy that has not read the list yet (or lost the person for a moment, e.g. the 2-3 s after an answer) still draws the input from its props (id / address / source; waiting = ap)
    return v_flex().id("composer-root").size_full().bg(P.paper).child(a ? this.composer(a) : standIn ? this.composer(standIn) : over ? div().id("composer-miss").px(14).pt(8).text_size(13).text_color(P.muted).tooltip(`id: ${String(p.id ?? "なし")}`).child("入力欄: 相手が見つかりません") : div());
  }

  // ★105 R8/R9: under the conversation, a person waiting for approval gets two buttons (the keys go to its terminal: Enter = the chosen "yes", Esc = refuse,
  // then say what to fix), and an App person gets the input + send (hc send: the text and Enter). Attach and ">_" are not made (no file picker API; see the table).
  composer(a) {
    const real = !!a && a.source === "app" && !!a.address && !(shared("hakoniwa.demo") || this.feed.config?.demo);
    if (!real) return div();
    // 45th 43-K4 (office-fix50a): once the dialog is answered (the card copy / the terminal key marked it: apanswered) hc still says "blocked" for 1-3 s; the input is the normal one then, with no 「却下のあと…」 line
    const answeredIn = (() => { try { return answeredNow(a, shared("hakoniwa.apanswered")); } catch { return false; } })();
    const waiting = a.status === "blocked" && !answeredIn, st = (waiting && this.rejectState) || this.msgState; // 24th Q2: while the person waits for approval the input says 「却下の理由（任意）…」
    const send = (cx) => { // ★106: the approve / refuse buttons moved to approvalAsk (they press the number read from the screen, not Enter / Esc)
      const t = String(st?.value() ?? "").trim(); if (!t) return;
      try { st.set_value(""); } catch {}
      cx.spawn(async (cx) => { try { const r = await hc(["send", a.address, t]); if (r?.code) throw new Error(String(r.stderr || `hc send: ${r.code}`).slice(0, 160)); } catch (e) { this.opError = { id: a.id, text: String(e?.message ?? e), at: Date.now() }; } cx.notify(); });
    };
    return v_flex().id("composer").flex_none().gap(8).px(14).pt(6).pb(12)
      .when(waiting, (x) => x.child(div().id("composer-hint").min_w(0).truncate().text_color(APPROVE_HINT).text_size(13).child("却下のあと、理由はここに書いて送信（次の指示として届きます）"))) // 32nd 31-Y6: the same 13px pale line as approval-no-hint, right above the input (the window's input block is 29px taller then: chat.js COMPOSER_HINT). Says only what the code does: 却下 stops (answerApproval), the input sends text + Enter with hc send (an instruction)
      .child(h_flex().id("composer-box").w_full().gap(8).items_center().px(8).py(6).rounded(10).border(1).border_color(P.line).bg("#ffffff")
        .on_key_down((e, cx) => { if (e.key === "enter") { send(cx); cx.stop_propagation(); } })
        .child(div().flex_1().min_w(0).text_size(17).child(st ? Input.new(st) : div()))
        .child(h_flex().id("composer-send").flex_none().h(40).px(12).gap(6).items_center().rounded(8).bg(P.blue).cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => { cx.stop_propagation(); send(cx); }).child(icon("play", 14, "#ffffff")).child(div().text_size(14).font_weight(700).text_color("#ffffff").child("送信"))));
  }

  // Role "tree-body": the family tree under the tabs (the "チーム" tab). A row opens that person.
  treeBodyView() {
    const p = (this.bodyProps?.() ?? props()), list = this.items(), a = list.find((x) => x.id === p.id);
    if (!a) return div();
    const rows = this.familyRows(a, list), pick = (n) => setShared("hakoniwa.pick", { state: n.status, id: n.id, at: Date.now() });
    return v_flex().id("tree-body-root").size_full().bg(P.paper).p(10).gap(2).overflow_y_scrollbar()
      .children(rows.map(([n, depth]) => { const ks = stateOf(n), me = n.id === a.id;
        return h_flex().id(`tree-${n.id}`).gap(6).px(8).py(8).items_center().rounded(7).cursor_pointer().hover((e) => e.bg("#f3efe4")).when(me, (e) => e.bg("#e8f0fe"))
          .on_click(() => pick(n))
          .child(div().flex_none().w(depth * 14)).child(div().flex_none().w(10).text_size(10).text_color(P.muted).child(depth ? "└" : ""))
          .child(dot(ks.color, 10)).child(platformIcon(n, 15))
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_weight(me ? 700 : 400).text_color(P.ink).child(String(n.name || n.address || "")))
          .child(div().flex_none().text_size(13).font_weight(600).text_color(ks.color).child(`${ks.label} ${ago(n.since)}`)); }));
  }
}

// 34th 34-B7: the spinner line "Hatching… (1m 10s · …)" with `extra` seconds added to the time (workLabel reads the result). A line without that time is returned as it is.
function advanceWork(line, extra) {
  return String(line ?? "").replace(/\(\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s/, (_m, h, mi, s) => {
    const t = Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0) + extra;
    return `(${t >= 3600 ? `${Math.floor(t / 3600)}h ` : ""}${t >= 60 ? `${Math.floor((t % 3600) / 60)}m ` : ""}${t % 60}s`;
  });
}
// 18th F4: the fade at the bottom of the conversation: FADE_ALPHA.length strips from clear to paper
const FADE_H = 20, FADE_ALPHA = [0, 0.25, 0.5, 0.75, 0.9];
// small helpers for the chips (a colour dot for the model, a small icon)
import { icon } from "./icons.js";
const chipDot = (a) => div().flex_none().w(10).h(10).rounded(5).bg(a.color ?? P.muted);
const iconBtnless = (name) => icon(name, 15, P.muted);
