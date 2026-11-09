// hakoniwa: 「新しいエージェント」の窓 (★107 案1。★27-1 の立てる窓の置き換え). Role "launch": project (dropdown) -> 6 provider tiles -> model / effort (dropdowns, 既定 first)
// -> 前回の設定 (remembered per provider) -> 詳細設定 (folder, name, leader/worker; folded) -> 最初の指示 (folded) -> キャンセル / 起動 (Enter).
// "立てる" calls the App's commands through launchAgent (actions.js): tab.new, or space.new for a new space. Nothing is started before that button.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, closeOverlay, exec, hc, openOverlay, props, readTextFile, run, setShared, shared, spaces, writeTextFile } from "herdr";
import { P } from "./common.js";
import { icon } from "./icons.js";
import { AGENT_KINDS, FREE_NAME, FREE_SPACE, NEW_SPACE, cleanChoice, cleanDefaults, defaultSpace, effortsFor, launchAgent, normalizeOptions } from "./actions.js";

// ★107 the six tiles: the five agent kinds and a plain shell
const KINDS6 = [...AGENT_KINDS, { key: "shell", label: "シェル" }];
const MODELS_MAX_AGE_MS = 24 * 3600 * 1000; // ★79 the CLIs' lists are read again once a day (or by 更新)

// ★10th A6: the window's height follows what is shown (the host cannot resize an open window and opening it again jumps it up and down, drops the typed text and the new-space name: so the height is decided once, when it opens; the middle scrolls if a fold makes it taller).
// ★15b: measured on the real window (y 248〜902, 1920×1152): padding 18 + title 28 + gap 12 | gaps 12 + error line 16 + 16-high summary + 39-high buttons + padding 18 = 183 fixed.
// 17th E2 (office-fix17b): the 15b numbers were short by ~11 px (the last row 最初の指示 was cut at 627/628). Measured again on the real window, row by row (1920×1152, models + efforts shown, no 前回 row = 455 body;
// with the room フリー = 478 body; the border lines of every row read from the picture): a 12px label is 19 px high (not 17), the モデル label row 22 (the 一覧を更新 chip is 22 high), an 11px note 18 (not 16).
// 部屋 19 + 5 + 34 = 58; プロバイダ 19 + 5 + tiles 116 = 140; モデル 22 + 5 + 34 = 61; 推論 19 + 5 + 34 = 58; fold rows 34; the フリー / 新しい部屋 note 5 + 18 = 23; gaps 14.
// Not measured (no click command opens the folds / makes a 前回 row): 前回 = 18 (an 11px line, as the measured note); the opened 詳細設定 / 最初の指示 rows use the 19px label.
// 18th F1 (office-fix18a, third time): measured y on the 638 window (1920×1152; window 258〜894, title 276〜304, scroll top 316, body 316〜771 = 455, summary 807〜825, buttons 838〜876):
// the scroll slot ended at y 767 (451 high) so the body (455) was cut 4 px short, and the error row (16) + its gap (12) sat empty under it (779〜795 = the "50 px gap").
// Real fixed part = 638 − 451 = 187 (not 183: the 11px summary is 18 high, not 16; plus the window frame ~2). Without the error row it is 187 − 28 = 159 (padding 36 + title 28 + summary 18 + buttons 39 + 3 gaps 36 + frame 2).
const FIXED_H = 159;
export function launchHeight(o) {
  const items = [];
  items.push(o.child ? 14 : 58 + (o.free ? 23 : 0) + (o.newSpace && !o.term ? 23 : 0)); // 部屋 (label + dropdown, and its note)
  if (!o.term) items.push(140); // プロバイダ: label + two rows of tiles
  if (o.models) items.push(61); // モデル (label row has the 一覧を更新 chip)
  if (o.efforts) items.push(58); // 推論の強さ
  if (o.last) items.push(18); // 前回の設定を使用しています
  items.push(34); // 詳細設定 (fold row)
  if (o.adv) items.push(20 + 56 + 56 + (!o.term && !o.shell ? 52 + (o.child ? 32 : 0) : 0)); // フォルダ・表示名・リーダーかワーカーか
  if (!o.term && !o.shell) items.push(34); // 最初の指示 (fold row)
  if (o.task && !o.term && !o.shell) items.push(36); // its input
  const body = items.reduce((a, b) => a + b, 0) + 14 * (items.length - 1);
  return Math.max(300, Math.min(900, FIXED_H + body));
}

export class LaunchPart {
  // The button on the band: opens the dialog. `selected` (the chosen person) gives the default space and folder.
  // `spaceId` (a room's "＋" on its plate): that space is chosen when the dialog opens.
  // `mode` "terminal" (★68-2 "＋ ターミナル"): a shell only, no kind and no first instruction.
  openLaunch(selected, spaceId = null, mode = "agent") {
    let list = [], shown = null; try { const sl = spaces(); list = sl.map((s) => ({ id: s.id, name: s.name })); shown = sl.find((s) => s.active)?.id ?? null; } catch {}
    // 19th K4: with nobody chosen and no room given, the room on show is the default (unknown -> the old first room)
    const mineId = selected?.space ? list.find((s) => s.name === selected.space)?.id : null;
    const space = spaceId === FREE_SPACE ? FREE_SPACE : spaceId && list.some((s) => s.id === spaceId) ? spaceId : mineId ?? (shown && list.some((s) => s.id === shown) ? shown : defaultSpace(list, selected)); // ★107 the left list's フリー heading passes FREE_SPACE
    const rows = shared("hakoniwa.launch.rows") ?? { models: true, efforts: true, last: true }; // what the last window showed (the lists load after it opens)
    const h = launchHeight({ term: mode === "terminal", free: space === FREE_SPACE || list.some((s) => s.id === space && s.name === FREE_NAME), newSpace: space === NEW_SPACE, shell: false, ...rows, adv: false, task: false, child: false });
    openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 520, height: h, // ★10th A6: sized to the folded content (the old fixed 650 left ~190 px empty when the lists were missing); the middle scrolls if it is taller
      props: { role: "launch", mode, h, spaces: list, space, folder: selected?.cwd ?? "",
        parents: this.items().filter((a) => a.source === "app" && a.address).map((a) => ({ address: a.address, name: a.name || a.address })), parent: selected?.source === "app" ? selected.address ?? "" : "" } }); // ★79 the candidates for a parent
  }

  // ★10th A6: what the window shows now (shared by the view and the height).
  launchDerived(p, f) {
    const list = p.spaces ?? [], term = p.mode === "terminal", shell = f.kind === "shell", free = f.space === FREE_SPACE || list.some((s) => s.id === f.space && s.name === FREE_NAME);
    const child = !term && !shell && f.parentMode === "child", models = f.options?.kinds?.[f.kind]?.models ?? [], efforts = effortsFor(f.options, f.kind, f.model || null) ?? [];
    const mem = f.mem?.[f.kind], usedLast = !term && !shell && !!mem && (mem.model ?? "") === f.model && (mem.effort ?? "") === f.effort;
    return { list, term, shell, free, child, models, efforts, parents: p.parents ?? [], mem, usedLast };
  }

  // Remembers which rows the window showed (the next window's height is decided from it when it opens). Never opens the window again.
  rememberRows() {
    const p = props() ?? {}, f = this.form; if (!f) return;
    const d = this.launchDerived(p, f);
    // 17th E2: `last` is whether a last choice is remembered (the next window opens on it, so 前回 shows), not whether the model / effort chosen right now still equals it:
    // a window closed after a change remembered last:false and the next one opened with the row (+32 px) in a window sized without it (the bottom row was cut).
    if (!d.term) { try { setShared("hakoniwa.launch.rows", { models: d.models.length > 0, efforts: d.efforts.length > 0, last: !!d.mem }); } catch {} }
  }

  // ★61-1: always on the band (main.js band()).
  launchButton(compact = false) { // compact (a narrow band): the ＋ alone
    return h_flex().id("launch-btn").flex_none().px(10).h(30).gap(5).items_center().rounded(10).border(1).border_color(P.blue)
      .bg(P.white).cursor_pointer().hover((s) => s.bg("#e8f0fe"))
      .on_click(() => { const sel = this.items().find((a) => a.id === shared("hakoniwa.sel")); this.openLaunch(sel ?? null); })
      .child(icon("agent-add", 16, P.blue))
      .when(!compact, (el) => el.child(div().text_size(12).font_weight(700).text_color(P.blue).child("エージェント")));
  }

  // ★68-2: "＋ ターミナル" beside "＋ エージェント" (a shell, in a space or free, as the TUI can).
  terminalButton(compact = false) {
    return h_flex().id("terminal-btn").flex_none().px(10).h(30).gap(5).items_center().rounded(10).border(1).border_color(P.line)
      .bg(P.white).cursor_pointer().hover((s) => s.bg("#f0ede4"))
      .on_click(() => { const sel = this.items().find((a) => a.id === shared("hakoniwa.sel")); this.openLaunch(sel ?? null, null, "terminal"); })
      .child(icon("terminal-add", 16, P.ink))
      .when(!compact, (el) => el.child(div().text_size(12).font_weight(700).text_color(P.ink).child("ターミナル")));
  }

  // ★100-4: the room plate's "＋" is gone (starting an agent is the band's "＋ エージェント"; the room is chosen in that dialog).

  initLaunch(cx) {
    const p = props() ?? {};
    // open: which dropdown is unfolded (project / model / effort); adv / taskOpen: the folded parts; mem: what was chosen last, per provider
    this.form = { space: p.space ?? NEW_SPACE, kind: p.mode === "terminal" ? "shell" : "claude", error: null, busy: false, parentMode: "parent", parent: p.parent ?? "", model: "", effort: "", options: null, refreshing: false,
      open: null, adv: false, taskOpen: false, mem: {} };
    if (p.mode !== "terminal") cx.spawn(async (cx) => { await this.loadLaunchOptions(cx); });
    this.fNew = InputState.new({ placeholder: "新しいスペースの名前（プロジェクト名）" });
    this.fFolder = InputState.new({ placeholder: "フォルダ（空ならその部屋のフォルダ）", value: p.folder ?? "" });
    this.fTask = InputState.new({ placeholder: "最初の指示（なくてもよい）" });
    this.fName = InputState.new({ placeholder: "表示名（タブの名前。空なら番号）" });
  }

  // ★79 models.json (from hakoniwa_models.py: each CLI's own list) and the last choice (launch.json). A list older than a day, or none, is read again
  // here (mod exec, never in a render); one that cannot be read keeps the previous list, or only "既定" (default).
  // ★107: launch.json also keeps `byKind` ({ <kind>: { model, effort } }): each provider comes back with its own last model / effort.
  async loadLaunchOptions(cx) {
    const f = this.form, dir = `${appHome()}/hakoniwa-office`, rd = async (n) => { try { return JSON.parse(String(await readTextFile(`${dir}/${n}`) ?? "")); } catch { return null; } };
    // ★15b (C4): the stored list is shown at once, even when it is older than a day; the daily read runs after that (it can take long or never end, and the model / effort rows
    // stayed missing: the window was opened tall for them and had ~200 px empty). The user's choice made meanwhile is kept when the new list arrives.
    let raw = await rd("models.json");
    const stale = !raw || Date.now() - (Number(raw.at) || 0) > MODELS_MAX_AGE_MS;
    f.options = normalizeOptions(raw);
    const last = await rd("launch.json"), d = cleanDefaults(f.options, last);
    f.mem = { ...(last?.byKind && typeof last.byKind === "object" ? last.byKind : {}) };
    if (!f.mem[d.kind] && (d.model || d.effort)) f.mem[d.kind] = { model: d.model, effort: d.effort }; // a launch.json from before ★107 has only the last one
    Object.assign(f, { kind: d.kind, parentMode: d.parentMode }, cleanChoice(f.options, d.kind, f.mem[d.kind]?.model ?? d.model, f.mem[d.kind]?.effort ?? d.effort));
    cx.notify(); this.rememberRows();
    if (stale) {
      await this.refreshModels(cx, true); const fresh = await rd("models.json");
      if (fresh && fresh !== raw) { f.options = normalizeOptions(fresh); Object.assign(f, cleanChoice(f.options, f.kind, f.model, f.effort)); cx.notify(); this.rememberRows(); }
    }
  }
  async refreshModels(cx, quiet = false) {
    const f = this.form; if (f.refreshing) return;
    f.refreshing = true; if (!quiet) cx.notify();
    try {
      if (!this.feed?.config) await this.loadConfig();
      const c = this.feed?.config; if (!c?.python || !c?.collector) throw new Error("config.json を読めません");
      await exec(c.python, [c.collector.replace(/[^\\/]*$/, "hakoniwa_models.py")]);
    } catch (e) { if (!quiet) f.error = `一覧を取れませんでした（前回の一覧を使います）`; } // (a failed daily read is silent: the previous list stays)
    f.refreshing = false;
    if (!quiet) { try { const raw = JSON.parse(String(await readTextFile(`${appHome()}/hakoniwa-office/models.json`) ?? "")); f.options = normalizeOptions(raw); Object.assign(f, cleanChoice(f.options, f.kind, f.model, f.effort)); } catch {} cx.notify(); this.rememberRows(); }
  }

  launchView() {
    const p = props() ?? {}, f = this.form ?? {}, list = p.spaces ?? [];
    const label = (t) => div().text_size(12).font_weight(700).text_color(P.muted).child(t);
    const { term, free, shell, child, models, efforts, parents, mem, usedLast } = this.launchDerived(p, f); // ★68-2 / ★95
    const tog = (name) => (_e, cx) => { f.open = f.open === name ? null : name; cx.notify(); };
    const pick = (k) => { f.kind = k; f.open = null; const r = f.mem?.[k]; Object.assign(f, cleanChoice(f.options, k, r?.model ?? "", r?.effort ?? "")); }; // a kind change: that kind's own last choice, only what it still has
    const chip = (id, text, on, fn) => div().id(id).flex_none().px(10).py(5).rounded(8).border(1).border_color(on ? P.blue : P.line).bg(on ? "#e8f0fe" : P.white)
      .text_size(12).font_weight(on ? 700 : 400).text_color(on ? P.blue : P.ink).cursor_pointer().hover((s) => s.bg("#f3efe4")).on_click((_e, cx) => { fn(); cx.notify(); this.rememberRows(); }).child(text);
    // a dropdown: the trigger shows the chosen value; the list unfolds under it (in the flow, so it scrolls with the middle). `items`: [{ id, text, on, fn }]
    const dropdown = (key, current, items) => v_flex().gap(4)
      .child(h_flex().id(`dd-${key}`).h(34).px(10).items_center().justify_between().rounded(8).border(1).border_color(f.open === key ? P.blue : P.line).bg(P.white).cursor_pointer()
        .hover((s) => s.bg("#f8f5ee")).on_click(tog(key)).child(div().text_size(12).text_color(P.ink).child(current)).child(div().text_size(11).text_color(P.muted).child(f.open === key ? "▴" : "▾")))
      .when(f.open === key, (el) => el.child(v_flex().id(`ddl-${key}`).max_h(190).overflow_y_scrollbar().rounded(8).border(1).border_color(P.line).bg(P.white).p(3).gap(1)
        .children(items.map((it) => div().id(it.id).px(8).py(5).rounded(6).bg(it.on ? "#e8f0fe" : P.white).text_size(12).font_weight(it.on ? 700 : 400).text_color(it.on ? P.blue : P.ink)
          .cursor_pointer().hover((s) => s.bg("#f3efe4")).on_click((_e, cx) => { it.fn(); f.open = null; cx.notify(); this.rememberRows(); }).child(it.text)))));
    // 5th X6: a folded row is a framed bar with a fixed height (flex_none: in the scrolling column it was squeezed to 0 high and only cut-off letters were left); ▸ / ▾ show it can be opened
    const fold = (id, text, on, fn) => h_flex().id(id).flex_none().h(34).px(10).gap(8).items_center().rounded(8).border(1).border_color(P.line).bg(on ? "#f3efe4" : P.white).cursor_pointer().hover((s) => s.bg("#f3efe4")).on_click((_e, cx) => { fn(); cx.notify(); this.rememberRows(); })
      .child(div().flex_none().w(14).text_size(13).font_weight(700).text_color(P.ink).child(on ? "▾" : "▸")).child(div().text_size(13).font_weight(700).text_color(P.ink).child(text));
    const spaceName = child ? "リーダーと同じ部屋" : f.space === NEW_SPACE ? "新しいプロジェクト" : free ? "フリー" : list.find((s) => s.id === f.space)?.name || f.space;
    const projectItems = [...list.filter((s) => s.name !== FREE_NAME).map((s) => ({ id: `sp-${s.id}`, text: s.name || s.id, on: f.space === s.id, fn: () => { f.space = s.id; } })),
      { id: "sp-free", text: "スペースなし（フリー）", on: free, fn: () => { f.space = FREE_SPACE; } },
      // ★107 the make-a-space window (name + folder) replaces "make one at launch": this window closes, that one opens (the folder typed here goes along)
      { id: "sp-new", text: "＋ 新しいプロジェクト…", on: false, fn: () => { const d = String(this.fFolder?.value?.() ?? "").trim(); closeOverlay(p.overlay); this.openNewRoom(d); } }];
    const modelItems = [{ id: "model-default", text: "既定", on: !f.model, fn: () => { Object.assign(f, cleanChoice(f.options, f.kind, "", f.effort)); } },
      ...models.map((m, i) => ({ id: `model-${i}`, text: m.label, on: f.model === m.id, fn: () => { f.model = m.id; Object.assign(f, cleanChoice(f.options, f.kind, m.id, f.effort)); } }))];
    const effortItems = [{ id: "effort-default", text: "既定", on: !f.effort, fn: () => { f.effort = ""; } }, ...efforts.map((e2) => ({ id: `effort-${e2}`, text: e2, on: f.effort === e2, fn: () => { f.effort = e2; } }))];
    const kindName = KINDS6.find((k) => k.key === f.kind)?.label ?? f.kind;
    const summary = term ? `${spaceName} にターミナルを追加` : `${spaceName} に追加・${kindName}${shell ? "" : ` / ${models.find((m) => m.id === f.model)?.label ?? "既定"}${efforts.length ? ` / ${f.effort || "既定"}` : ""}`}`;
    const close = (cx) => { closeOverlay(p.overlay); };
    const submit = (_e, cx) => {
      if (f.busy) return;
      const form = { space: f.space, newName: "", kind: f.kind, name: this.fName.value(), folder: this.fFolder.value(), task: this.fTask.value(),
        parentMode: term || shell ? "parent" : f.parentMode, parent: f.parent, model: f.model, effort: f.effort, options: f.options, effortDir: `${appHome()}/hakoniwa-office` }; // ★79
      f.busy = true; cx.notify();
      if (f.space === NEW_SPACE && !term) setShared("hakoniwa.newroom", { before: list.map((s) => s.id), at: Date.now() }); // ★85-2: the office names this room after its first agent's title
      cx.spawn(async (cx) => {
        const r = await launchAgent(run, form, list, hc, writeTextFile);
        f.busy = false;
        if (r.ok) { // the last choice is the next default (★107: per provider; a shell is not remembered as the last provider)
          if (!term && !shell) { try { await writeTextFile(`${appHome()}/hakoniwa-office/launch.json`, JSON.stringify({ kind: f.kind, model: f.model, effort: f.effort, parentMode: f.parentMode, byKind: { ...(f.mem ?? {}), [f.kind]: { model: f.model, effort: f.effort } } })); } catch {} }
          closeOverlay(p.overlay); return;
        }
        f.error = r.error; cx.notify();
      });
    };
    // ★95-7: the title and the buttons stay in the window; only the middle scrolls (16 models never push "起動" out of sight)
    return v_flex().id("launch-root").size_full().p(18).gap(12).bg(P.paper).overflow_hidden()
      .on_key_down((e, cx) => { if (e.key === "escape") { if (f.open) f.open = null; else close(cx); cx.notify(); cx.stop_propagation(); } else if (e.key === "enter" && !f.open) { submit(e, cx); cx.stop_propagation(); } })
      .child(div().flex_none().text_size(17).font_weight(700).text_color(P.ink).child(term ? "新しいターミナル" : "新しいエージェント"))
      .child(div().id("launch-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().id("launch-body").flex_none().gap(14)
        .child(child ? div().text_size(11).text_color(P.muted).child("部屋はリーダーと同じになります") : v_flex().gap(5).child(label("プロジェクト（部屋）")).child(dropdown("project", spaceName, projectItems))
          .when(free, (el) => el.child(div().text_size(11).text_color(P.muted).child(term ? "スペース「フリー」のタブに立てます" : "スペース「フリー」（なければ作ります）に立てて、フリーデスクに座ります")))
          .when(f.space === NEW_SPACE && !term, (el) => el.child(div().text_size(11).text_color(P.muted).child("起動すると新しい部屋ができます（名前は最初のエージェントの題から）"))))
        .when(!term, (el) => el.child(v_flex().gap(5).child(label("プロバイダ"))
          .child(h_flex().gap(8).flex_wrap().children(KINDS6.map((k) => v_flex().id(`kind-${k.key}`).w(150).h(54).flex_none().gap(4).items_center().justify_center().rounded(10).border(f.kind === k.key ? 2 : 1)
            .border_color(f.kind === k.key ? P.blue : P.line).bg(f.kind === k.key ? "#e8f0fe" : P.white).text_size(13).font_weight(f.kind === k.key ? 700 : 500).text_color(f.kind === k.key ? P.blue : P.ink)
            .cursor_pointer().hover((s) => s.bg(f.kind === k.key ? "#e8f0fe" : "#f3efe4")).on_click((_e, cx) => { pick(k.key); cx.notify(); this.rememberRows(); })
            .child(icon(k.key === "shell" ? "terminal" : `p-${k.key}`, 22, f.kind === k.key ? P.blue : P.muted))
            .child(div().text_size(13).font_weight(f.kind === k.key ? 700 : 500).text_color(f.kind === k.key ? P.blue : P.ink).child(k.label)))))))
        .when(!term && !shell && models.length > 0, (el) => el.child(v_flex().gap(5).child(h_flex().gap(8).items_center().child(label("モデル"))
          .child(div().id("models-refresh").flex_none().px(8).py(2).rounded(6).border(1).border_color(P.line).bg(P.white).text_size(10).text_color(P.muted).cursor_pointer().hover((s) => s.bg("#f3efe4"))
            .on_click((_e, cx) => cx.spawn(async (cx) => this.refreshModels(cx))).child(f.refreshing ? "更新中…" : "一覧を更新")))
          .child(dropdown("model", models.find((m) => m.id === f.model)?.label ?? "既定", modelItems))))
        .when(!term && !shell && efforts.length > 0, (el) => el.child(v_flex().gap(5).child(label("推論の強さ")).child(dropdown("effort", f.effort || "既定", effortItems))))
        .when(usedLast, (el) => el.child(div().id("launch-last").text_size(11).text_color(P.muted).child("前回の設定を使用しています")))
        .child(fold("adv-toggle", "詳細設定", f.adv, () => { f.adv = !f.adv; }))
        .when(f.adv, (el) => el.child(v_flex().id("launch-adv").gap(10).pl(14)
          .child(v_flex().gap(5).child(label("フォルダ")).child(Input.new(this.fFolder)))
          .child(v_flex().gap(5).child(label("表示名")).child(Input.new(this.fName)))
          .when(!term && !shell, (e2) => e2.child(v_flex().gap(5).child(label("リーダーかワーカーか"))
            .child(h_flex().gap(6).flex_wrap().children([chip("pm-parent", "リーダー（単独で立てる）", !child, () => { f.parentMode = "parent"; }),
              chip("pm-child", "ワーカー（選んだリーダーの下）", child, () => { f.parentMode = "child"; })]))
            .when(child, (e3) => e3.child(h_flex().gap(6).flex_wrap().children(parents.length ? parents.map((q) => chip(`par-${q.address}`, q.name, f.parent === q.address, () => { f.parent = q.address; })) : [div().text_size(11).text_color(P.muted).child("リーダーにできるエージェントがいません")])))))))
        .when(!term && !shell, (el) => el.child(fold("task-toggle", "最初の指示（任意）", f.taskOpen, () => { f.taskOpen = !f.taskOpen; }))
          .when(f.taskOpen, (e2) => e2.child(Input.new(this.fTask))))))
      // 18th F1 (office-fix18a): the error shares the summary's one line (an always-there 16-high error row + 12 gap was a 28 px empty band under the last row)
      .child(div().id("launch-summary").flex_none().text_size(11).text_color(f.error ? "#d6455d" : P.muted).child(f.error ?? summary))
      .child(h_flex().flex_none().gap(10).justify_end()
        .child(div().id("launch-cancel").flex_none().px(16).py(8).rounded(8).border(1).border_color(P.line).bg(P.white).text_size(13).font_weight(700).text_color(P.ink)
          .cursor_pointer().on_click(() => close()).child("キャンセル"))
        .child(div().id("launch-go").flex_none().px(16).py(8).rounded(8).bg(P.blue).text_size(13).font_weight(700).text_color("#ffffff")
          .cursor_pointer().on_click(submit).child(f.busy ? "起動しています…" : "エージェントを起動")));
  }
}
