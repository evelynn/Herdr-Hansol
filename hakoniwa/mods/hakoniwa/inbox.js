// hakoniwa ★106 ②: the inbox: a card for each person who waits for an answer (承認待ち) or has a report (報告あり).
// A card: who, what is asked, and "承認・却下" (the same buttons and the same screen-number press as the right column), "報告を見る", "その人を開く".
// The right window shows it when nobody is chosen (region.js calls part.inboxView(); this file does not touch region.js).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, hc, props, setShared, shared } from "herdr";
import { iconBtn } from "./ui.js";
import { P, dot, ago, STATE, platformIcon, stateOf, blockedText } from "./common.js";

import { approvalDetailLines } from "./approve-view.js";
import { inboxList, inboxFits, inboxHasMore, inboxWhat, inboxNeedsRead, inboxExtraH, reportName, reportModel, reportWhere, reportDupes, reportTag, shownRight } from "./approve.js"; // (pure, so the tests can load it without the App)

const open = (a, tab) => { if (tab) setShared("hakoniwa.tab", { id: a.id, tab, at: Date.now() }); setShared("hakoniwa.pick", { state: a.status, id: a.id, at: Date.now() }); };

const link = (id, label, fn, tone = {}) => div().id(id).flex_none().h(32).px(10).flex().items_center().rounded(8).border(1).border_color(tone.border ?? P.line).bg(tone.bg ?? "#ffffff")
  .text_size(14).font_weight(600).text_color(tone.color ?? P.ink).cursor_pointer().hover((s) => s.bg("#f3efe4")).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);

// 14th D6: a report (報告あり) is a short row, 54px with the gap. Only a waiting card keeps the buttons (the big card).
// 18th F5: two lines (name / one phrase) so the phrase has the width; the name is the person's own display name first. The room (or tab) is added after the name
// so that two "Claude Code" rows can be told apart. The lines have fixed heights (20 + 18) so the row stays within 54 with the gap (not measured).
// 19th G3: the name is as wide as it is (cap 140 when a room follows, 200 alone) so the rest goes to the room; `tag` (the address) is given only to rows whose name and room both repeat (reportDupes).
export function inboxRow(a, tag = "") {
  const st = stateOf(a), where = [reportWhere(a), reportModel(a)].filter(Boolean).join("・"); // 20th H6: the model (from the name's brackets) follows the room
  return h_flex().id(`inbox-${a.id}`).w_full().flex_none().gap(8).px(12).py(3).items_center().rounded(10).bg("#eaf6ef").border(1).border_color("#b9dfca")
    .child(dot(st.color, 10)).child(platformIcon(a, 15))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().h(20).gap(6).items_center().min_w(0)
        .child(div().flex_none().max_w(where ? 140 : 200).truncate().text_size(15).font_weight(700).text_color(P.ink).child(reportName(a)))
        .when(!!where, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(P.muted).child(where)))
        .when(!!tag, (e) => e.child(div().id(`inbox-tag-${a.id}`).flex_none().text_size(12).text_color("#b0aa9b").child(tag))))
      .child(div().h(18).truncate().text_size(14).text_color(P.muted).child(String(a.title || "報告があります"))))
    .child(link(`inbox-report-${a.id}`, "報告を見る", () => open(a, "chat")));
}

// 35b 29-W4: the small line under the "what" line, in short Japanese from the what line that was read ("Create file（ファイルを作成） · bye.txt" -> "ファイルを作成: bye.txt").
// A file action keeps only the file name (the path is cut); a command keeps its text. A what line in any other shape -> `raw` (the unchanged "approve Write: <path>").
export const inboxRawJa = (what, raw) => {
  const m = /^[^（）]+（([^（）]+)）(?: · (.+))?$/.exec(String(what ?? "").trim()), ja = m?.[1], rest = m?.[2];
  if (!ja) return String(raw ?? "");
  if (!rest) return ja;
  return `${ja}: ${/ファイル/.test(ja) ? (rest.split(/[\\/]/).filter(Boolean).pop() ?? rest) : rest}`;
};
// 35b 29-W7: the pale line under the heading, only while somebody waits for approval. NOTE_H is its height (subtracted from the cap the cards fit in).
export const INBOX_NOTE_TEXT = "承認待ちから先に答えてください", INBOX_NOTE_H = 18;

export function inboxCard(part, a, tag = "") {
  const st = stateOf(a), waiting = a.status === "blocked", shown = shownRight(a, shared("hakoniwa.sel")), what = waiting ? inboxWhat(part.approvalEntry?.(a)) : "";
  // 26th M1: the person in the right window answers there; a second pair of buttons here only made people choose, so the card has none (33b U3: the 「右の窓に表示中」 mark alone says where).
  const btns = waiting && !shown ? part.approveButtons(a, { h: 36, idp: "inbox" }) : null;
  if (!waiting) return inboxRow(a, tag);
  return v_flex().id(`inbox-${a.id}`).w_full().gap(6).px(12).py(10).rounded(10).bg(waiting ? "#fff1df" : "#eaf6ef").border(1).border_color(waiting ? "#f2c58a" : "#b9dfca")
    .child(h_flex().gap(8).items_center()
      .child(dot(st.color, 10)).child(platformIcon(a, 15))
      .child(div().flex_none().max_w(200).truncate().text_size(15).font_weight(700).text_color(P.ink).child(reportName(a))) // 20th H6: no model in brackets in the name
      .when(!!reportModel(a), (e) => e.child(div().flex_none().text_size(12).text_color(P.muted).child(reportModel(a))))
      .child(div().flex_1().min_w(0))
      .when(shown, (e) => e.child(div().id(`inbox-shown-${a.id}`).flex_none().px(6).rounded(6).bg("#e3edff").text_size(12).font_weight(600).text_color(P.blue).child("右の窓に表示中"))) // 19th G5
      .child(div().flex_none().text_size(13).font_weight(600).text_color(st.color).child(`${st.label} ${ago(a.since)}`)))
    // 32b T3: when the dialog's own first line was read, it comes first and dark ("Create file（ファイルを作成） · bye.txt"); the raw "approve Write: <path>" line follows, small and pale and cut
    // to one line. Without it (not read yet) the raw line stays first as before (nothing to put in front).
    // 36b 30-X2: the dark line is the short Japanese form ("ファイルを作成: bye.txt"; this card only, the floor card and the right window build theirs elsewhere). The small raw line
    // under it is shown only when the Japanese could not be read (then the what line stays as it was and the raw line follows).
    .when(waiting && !!what, (e) => e.child(div().id(`inbox-what-${a.id}`).truncate().text_size(14).font_weight(600).text_color(P.ink).child(inboxRawJa(what, what)))) // 24th Q4: what is asked, the dialog's own first line (only when it was read)
    .when(waiting && !!what && inboxRawJa(what, "") === "", (e) => e.child(div().id(`inbox-raw-${a.id}`).truncate().text_size(12).text_color("#b0aa9b").child(String(blockedText(a)))))
    .when(!(waiting && what), (e) => e.child(div().text_size(14).text_color(P.ink).child(waiting ? String(blockedText(a)) : String(a.title || a.name || "報告があります"))))
    .when(!!btns, (e) => e.child(btns))
    // 33b U3 (27-U3): the person shown in the right window has only the 「右の窓に表示中」 mark in the header: no buttons, no 「その人を開く」, no answer-here button (the mark already says where to answer)
    .when(!shown, (e) => e.child(h_flex().gap(8) // 20th H3: the person already in the right window has no 「その人を開く」
      .child(link(`inbox-open-${a.id}`, "その人を開く", () => open(a)))));
}

// 13th B5: the window is capped at the screen / right window's height, so when many cards wait the list scrolls and the last one is cut at the bottom.
// A fixed line under the scroll area says so (the scrollbar alone did not tell). 14th D6: inboxFits (approve.js) counts a waiting card as 120px and a report as 54px, the numbers room.js sizes the window with.

// 24th Q3: where the kind of cards changes (the pressed kind first, then the other), a pale heading names the kind that follows ("報告あり 2"); one kind only -> no heading.
export const inboxDividerText = (rows, i) => (i > 0 && rows[i]?.status !== rows[i - 1]?.status ? (rows[i].status === "blocked" ? "承認待ち" : "報告あり") : "");
const inboxDivider = (text) => div().id(`inbox-divider-${text}`).flex_none().h(16).px(2).flex().items_center().text_size(12).font_weight(600).text_color("#b0aa9b").child(text);

export function inboxView(part) {
  // 19th K5: the kind of the chip that was pressed (shared "hakoniwa.inboxKey" = { key: "blocked" | "done" }, written by room.js when it opens the window) comes first:
  // its cards are listed first and the heading names it; the other kind follows. Without the key, the kind of the first card is taken.
  const all = inboxList(part.items?.() ?? []), asked = shared("hakoniwa.inboxKey")?.key;
  const first = asked === "done" || asked === "blocked" ? asked : (all[0]?.status === "done" ? "done" : "blocked");
  const rows = [...all.filter((a) => a.status === first), ...all.filter((a) => a.status !== first)], dupes = reportDupes(rows.filter((a) => a.status !== "blocked"));
  // 25th L2: a kind with 0 cards ("承認待ち 0") is not in the heading (it only added noise).
  const nOf = (k) => rows.filter((a) => a.status === k).length, kinds = [first, first === "blocked" ? "done" : "blocked"].filter((k) => nOf(k) > 0);
  // 20th H2: the cap is the window's REAL height (asked by room.js -> shared "hakoniwa.inboxH"; before, the screen's height - 72, which is far above the window), and the
  // 「続きあり」 line also comes from the measured scroll area (view) and its content, so a card taller than the estimate still says so.
  const sel = shared("hakoniwa.sel"), cap = shared("hakoniwa.inboxH") || (shared("hakoniwa.win")?.h ? shared("hakoniwa.win").h - 72 : 0) || (part.termBox ?? shared("hakoniwa.termBox"))?.h;
  const note = rows.some((a) => a.status === "blocked"); // 35b 29-W7
  const fits = inboxFits(rows, cap > 0 ? cap - inboxExtraH(rows) - (note ? INBOX_NOTE_H : 0) : cap, sel), m = part.inboxMeasure ?? {}, more = inboxHasMore(rows, fits, m.view, m.content); // 30b R2: the window also holds the headings and the "what" lines
  // 30b R3: a waiting card's "what" line comes from the entry the screen read stored (detail.js). When this copy has none (the read never ran here, or was lost), read the screen
  // here the same way (approvalDetailLines of `hc read`), at most once per person per 4 s, from the size callback (never from render). Only the first line is shown, only when it was read.
  const fill = (cx) => {
    const now = Date.now(), last = (part.inboxReadAt ??= {});
    for (const a of inboxNeedsRead(rows, (x) => part.approvalEntry?.(x), last, now)) {
      last[a.id] = now;
      cx?.spawn?.(async (cx2) => {
        try {
          const r = await hc(["read", a.address]), detail = approvalDetailLines(r?.stdout ?? ""), e = part.approvalEntry?.(a);
          if (!part.apprs || inboxWhat({ detail }) === "") return;
          part.apprs.set(a.id, { key: `${a.id}|${a.since}`, plan: null, busy: false, result: null, ...(e ?? {}), detail });
          cx2?.notify?.();
        } catch {}
      });
    }
  };
  const measure = (key) => (size, cx) => { const v = Math.round(size?.height ?? 0); part.inboxMeasure ??= {}; if (v > 0 && part.inboxMeasure[key] !== v) { part.inboxMeasure[key] = v; cx?.notify?.(); } fill(cx); };
  return v_flex().id("inbox-root").size_full().bg(P.paper).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(h_flex().flex_none().px(14).pt(12).pb(6).gap(8).items_center()
      .child(div().text_size(17).font_weight(700).text_color(P.ink).child("対応が必要"))
      .child(div().text_size(14).font_weight(700).text_color(rows.length ? STATE.blocked.color : P.muted).child(String(rows.length)))
      .when(kinds.length > 0, (e) => e.child(h_flex().id("inbox-kinds").gap(6).items_center() // 5th X2: the total = the two header chips added up; 19th K5: the pressed kind first and darker
        .children(kinds.map((k, i) => div().text_size(12).font_weight(i === 0 ? 700 : 400).text_color(i === 0 ? STATE[k]?.color ?? P.ink : P.muted).child(`${k === "blocked" ? "承認待ち" : "報告あり"} ${nOf(k)}`)))))
      .child(div().flex_1())
      .child(iconBtn("inbox-close", "x", () => { setShared("hakoniwa.inboxOpen", { on: false, at: Date.now() }); const o = props()?.overlay; if (o != null) closeOverlay(o); }, { size: 36, isize: 20 })))
    .when(note, (e) => e.child(div().id("inbox-note").flex_none().h(INBOX_NOTE_H).px(14).flex().items_center().text_size(12).text_color(P.muted).child(INBOX_NOTE_TEXT))) // 35b 29-W7; 36b 30-X3: one step darker (was #b0aa9b)
    .child(div().id("inbox-scroll").flex_1().min_h(0).overflow_y_scrollbar().on_size_change(measure("view"))
      .child(v_flex().gap(8).px(14).pb(12).on_size_change(measure("content"))
        .children(rows.length ? rows.flatMap((a, i) => [...(inboxDividerText(rows, i) ? [inboxDivider(inboxDividerText(rows, i))] : []), inboxCard(part, a, dupes.has(a.id) ? reportTag(a) : "")]) : [div().py(16).text_size(14).text_color(P.muted).child("いま対応が必要な人はいません")])))
    .when(more, (e) => e.child(div().id("inbox-more").flex_none().px(14).py(6).border_t(1).border_color(P.line).bg(P.paper).text_size(14).font_weight(600).text_color(P.muted).child(`↓ 続きあり。下にスクロール（全 ${rows.length} 件）`)));
}
