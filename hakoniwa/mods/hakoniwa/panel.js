// hakoniwa: ★72-3 the terminals' list at the office's left edge (as the TUI's panel): space -> tab -> terminal, shells too, and the
// terminals in no space (hc run --no-parent). Pressing a row opens that terminal in the right column's window (the App's real terminal),
// so a terminal can be typed in before any agent runs in it. Folded, it is a thin strip. Mixed into AgentHud.
import { div, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, closeOverlay, exec, hc, openOverlay, panes, props, readTextFile, run, shared, spaces, writeTextFile } from "herdr";
import { normFolder, moveToFreePlan, moveByLabelPlan, isWorker, teamMembers, teamPlan, teamSpaceState, teamFixPlan, AGENT_KINDS, FREE_NAME, FREE_SPACE, SHELL_KIND } from "./actions.js";
import { P, STATE, dot, platformIcon, answeredView } from "./common.js";
import { iconBtn, inlineRename, renameState, splitHandle } from "./ui.js";
import { cleanWidths, LEFT_W, ellipsize, nameEm, clipName, tidyCut, UI, PANEL_HINT } from "./ui-rules.js";
import { icon } from "./icons.js";

export const LEFT_PAD = 48, PANEL_W = 280, PANEL_STRIP_W = 36,PANEL_ROWS_MAX = 40;
export const PANEL_FLASH_MS = 8000; // ★104 U12 a message under the heading stays 8 s
export const NAME_MIN_PX = 128;     // ★104 U5 a row's name keeps room for 8 full-width letters (16px) even when it is chosen
// ★106 V6: a short model name for the row's tag ("claude-sonnet-5-5" / "Claude Sonnet 5.5" -> "Sonnet 5.5"); null when it does not fit (the tag is left out, never cut)
export const shortModel = (m) => {
  let s = String(m ?? "").trim().replace(/^claude[\s-]*/i, "");
  const d = s.match(/^([a-z]+)-(\d+)-(\d+)$/i); if (d) s = `${d[1]} ${d[2]}.${d[3]}`;
  if (!s) return null;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length <= 12 ? s : null;
};

// ★107 W1: which tags a row can show without pushing "⋯" / the pencil / the trash out of the list's right edge (they were cut at the real width ~350). The actions on the right come first:
// the model tag goes first, then "ワーカー N"; "まとめる" (it is an action too) stays and the name gives way to 64px for it. `o`: { ag (a person: has the pencil), acts (pencil + trash shown), ren, show }.
// Widths are the drawn ones (padding / handle / icons / gaps of termRow), counted on the safe side.
export function rowTags(W, r, o = {}) {
  const none = { merge: false, workers: false, model: false };
  if (o.ren) return none;
  const GAP = 5, nest = r.nest ?? 0, acts = !!o.acts, tui = !!r.tui;
  // ★10 left: "⋯" only on the chosen row (o.more; default true = the old drawing). A row without it gives that width (BTN + gap) to the name. `acts` (hover / after "⋯") shows the pencil / trash instead.
  const more = o.more ?? true;
  const right = tui ? [] : acts ? (o.ag ? [BTN, BTN] : [BTN]) : (more ? [BTN] : []);          // the pencil / trash, or the pale "⋯", or nothing
  const left = [...(nest > 0 ? [14 * (nest - 1), 14] : []), isDraggable(r) ? 24 : 20, 16, 20, ...(r.kids > 0 ? [UI.hit] : []), ...(r.star ? [18] : [])];
  const inner = W - 14 - 10, fixed = 14 + left.reduce((n, x) => n + x, 0) + right.reduce((n, x) => n + x, 0);
  const tags = [];
  if (r.merge) tags.push(["merge", 72]);
  if (r.folded && r.kids > 0) tags.push(["workers", 84]);
  const sm = shortModel(r.model);
  if (!o.show && !r.merge && sm) tags.push(["model", 12 + [...sm].length * 8.5]);
  const min = r.merge ? 64 : NAME_MIN_PX, items = left.length + right.length + 1;           // + the name
  const room = (list) => inner - fixed - GAP * (items + list.length - 1) - list.reduce((n, t) => n + t[1], 0);
  let keep = tags.slice();
  for (const k of ["model", "workers"]) if (room(keep) < min) keep = keep.filter((t) => t[0] !== k); // the model tag goes first, then "ワーカー N"; "まとめる" stays
  // ★13d (B7): the name comes first. A badge ("モデル" / "ワーカー N" / "まとめる") stays only where the WHOLE name still fits beside it; "まとめる" is an action, so a chosen / hovered row (o.show) keeps it (the name gives way to 64px there).
  const nameFull = nameEm(r.label) * UI.text.body;                                              // the whole name's drawn width (full-width letter = 1em, half-width = 0.5em)
  for (const k of ["model", "workers", "merge"]) { if (room(keep) >= nameFull) break; if (k === "merge" && o.show) break; keep = keep.filter((t) => t[0] !== k); }
  const names = new Set(keep.map((t) => t[0]));
  return { merge: names.has("merge"), workers: names.has("workers"), model: names.has("model"), namePx: Math.max(0, Math.round(room(keep))) }; // namePx: the name's drawn width (px) after the tags / actions
}

// 19th K3: a long folder path keeps its end (which folder it is), the head goes: "D:/work/x/sub/…/ux18-ws" -> "…/ux18-ws". Short paths are left alone.
export const FOLDER_EM = 17;
export const tailFolder = (p, em = FOLDER_EM) => {
  const s = String(p ?? "");
  if (!s || nameEm(s) <= em) return s;
  const last = s.split("/").filter(Boolean).pop() ?? s;
  if (nameEm(`…/${last}`) <= em) return `…/${last}`;
  let out = "";
  for (const ch of [...last].reverse()) { if (nameEm(`…${ch}${out}`) > em) break; out = ch + out; }
  return `…${out}`;
};

// 26th L4: tidyCut moved to ui-rules.js (clipName uses it too); re-exported so existing imports (detail.js, tests) keep working.
export { tidyCut };
// 25th L5: a model in brackets at the end of a list name ("Claude Code（Opus 5.5）") is not part of the name; it follows the name as a pale word when the room is wide enough.
const LABEL_MODEL = /\s*[（(]([^（）()]*)[）)]\s*$/;
export const splitModel = (label) => {
  const r = String(label ?? "").trim(), name = r.replace(LABEL_MODEL, "").trim(), m = r.match(LABEL_MODEL);
  return m && name && m[1].trim() ? { name, model: m[1].trim() } : { name: r, model: "" };
};
// What a list row draws: { text: the name (cut by the room, tidy), model: the pale model word or "" }. `tg.namePx` is the name's room (rowTags); 6% is kept as a safety margin.
export const listName = (r, tg) => {
  const { name, model } = splitModel(r?.label), px = (tg?.namePx ?? Infinity) * 0.94, nameW = nameEm(name) * UI.text.body;
  const modelW = model ? 6 + nameEm(model) * UI.text.small * 1.1 : 0;
  if (nameW + modelW <= px && model && !tg?.model) return { text: name, model };
  return { text: nameW <= px ? name : tidyCut(clipName(name, px / UI.text.body)), model: "" };
};
// 25th L4: a space heading cut by the room that is left (the pencil / "⋯" / "＋" and the count badge are counted), with the same tidy cut.
export const headText = (W, label, count, o = {}) => {
  const s = String(label ?? ""), n = 3 + (o.more ? 1 : 0) + (o.plus ? 1 : 0);
  const avail = (W - 24 - 10 - UI.hit - 20 - 5 * (n - 1) - 8 - Math.max(24, 14 + String(count ?? "").length * 10) - (o.more ? BTN : 0) - (o.plus ? BTN : 0)) * 0.94;
  return nameEm(s) * UI.text.body <= avail ? s : tidyCut(clipName(s, Math.max(2, avail / UI.text.body)));
};

// ★14a C1: true when the row's name is wider than the room rowTags left it (it is drawn with "…"); only then the tooltip carries the full name.
export const nameCut = (r, tg) => !!r?.label && nameEm(r.label) * UI.text.body > (tg?.namePx ?? Infinity);

// ★105 N6/N3: hc's `agent` is also the program name of a plain terminal ("powershell.exe", "node"); an agent is one that reports a status or is a known kind.
export const isAgentTerm = (h) => !!h && (!!h.status || /claude|codex|cursor|opencode|antigravity|gemini|agy/i.test(String(h.agent ?? "")));
// The tree from spaces() / panes() and hc's terminal list (pure: the tests hand in plain lists).
// Returns [{ kind: "space" | "tab" | "term", key, label, depth, address?, status?, star?, child? }], at most PANEL_ROWS_MAX terminal rows.
// Where a terminal belongs is hc's `where` ("<space> / <tab>"), as the collector decides the office's rooms (island_of): a terminal kept in a
// space without a pane (terminal.keep / park) still belongs there. A sub-agent (hc `parent`) is listed under its parent (folded by `folded`).
export function panelRows(spaceList = [], paneList = [], hcTerms = [], agentList = [], folded = new Set(), teamFailed = null) {
  const rows = [], byAddr = new Map(agentList.filter((a) => a?.address).map((a) => [a.address, a])), seen = new Set();
  // ★97 a leader split from its workers wears a mark (manual: a press; auto that failed: the same mark, no retry by itself).
  const splitLeader = (address) => {
    const a = byAddr.get(address); if (!a) return false;
    const st = teamSpaceState(a, agentList, spaceList);
    return st?.state === "manual" || (st?.state === "auto" && !!teamFailed?.has(address));
  };
  const live = hcTerms.filter((t) => t?.address && t.state === "live"), hcBy = new Map(live.map((t) => [t.address, t]));
  const inLoop = new Set(); // ★ a ring of parents (A's parent is B, B's is A, ...): nobody in it is a root by the rule below, so none was listed; the walk up is cut after as many steps as there are terminals
  for (const t of live) { let c = t, steps = 0; while (c && c.parent && hcBy.has(c.parent) && steps++ <= live.length) { c = hcBy.get(c.parent); if (c === t) { inLoop.add(t.address); break; } } }
  const isRoot = (t) => !t.parent || !hcBy.has(t.parent) || inLoop.has(t.address);   // ★88-6 a child whose parent is gone (ended, or not a live terminal) is listed on its own: it was left out of every list (hc run --bg --parent)
  const kidsOf = new Map(); for (const t of live) if (t.parent && hcBy.has(t.parent)) { if (!kidsOf.has(t.parent)) kidsOf.set(t.parent, []); kidsOf.get(t.parent).push(t); }
  let n = 0;
  const paneOf = new Map(paneList.filter((p) => p.terminal).map((p) => [p.terminal, p.pane]));
  // ★95-9/10: `nest` = how many leaders are above it (0 = a leader or a lone one; a worker is indented under its leader); `app` = the agent's kind
  // (the icon: Claude, Codex ...), null for a shell (a terminal with no agent in it: the `>_` icon).
  const term = (address, label, depth, status, nest = 0) => {
    if (seen.has(address) || n >= PANEL_ROWS_MAX) return;
    const a = byAddr.get(address), h = hcBy.get(address), kids = (kidsOf.get(address) ?? []).filter((k) => !seen.has(k.address)); seen.add(address); n++;
    const [wsp, wtb] = String(h?.where ?? "").split(" / ");
    rows.push({ kind: "term", key: `t-${address}`, label: a?.name || h?.name || label || h?.agent || address, depth, nest, address, status: a?.status ?? h?.status ?? status ?? null,
      star: kids.length > 0 && !(h?.parent ?? a?.parent_id), child: !!(h?.parent ?? a?.parent_id), kids: kids.length, folded: folded.has(address),
      app: a?.app ?? h?.agent ?? null, shell: !a && !isAgentTerm(h),
      space: a?.space || wsp || "", tab: a?.tab || wtb || "", pane: paneOf.get(address) ?? null, id: a?.id ?? `app:${address}`, model: a?.model_label ?? "", merge: splitLeader(address) });
    if (!folded.has(address)) for (const k of kids) term(k.address, k.name || k.agent, depth + 1, k.status, nest + 1);
  };
  const whereOf = (t) => String(t.where ?? "").split(" / ");
  for (const sp of spaceList) {
    const tabs = (sp.tabs ?? []).map((tb) => ({ tb, terms: [...paneList.filter((p) => p.tab === tb.id && p.terminal).map((p) => ({ address: p.terminal, label: p.program?.name || p.title, status: p.status })),
      ...live.filter((t) => isRoot(t) && whereOf(t)[0] === sp.name && whereOf(t)[1] === tb.name).map((t) => ({ address: t.address, label: t.name || t.agent, status: t.status }))] })).filter((x) => x.terms.length);
    // ★105 (判断4): a space with nobody in it is still listed (an empty heading, so "＋" can put someone in); the floor still draws only rooms with a person (office.js)
    rows.push({ kind: "space", key: `s-${sp.id}`, label: sp.name || sp.id, depth: 0, spaceId: sp.id, empty: !tabs.length });
    if (!tabs.length) continue;
    for (const { tb, terms } of tabs) {
      rows.push({ kind: "tab", key: `b-${tb.id}`, label: tb.name || String(tb.index ?? ""), depth: 1 });
      for (const x of terms) term(x.address, x.label, 2, x.status);
    }
  }
  const other = live.filter((t) => isRoot(t) && t.where && !seen.has(t.address)); // a `where` that names no space here (renamed, another client): under its own words
  for (const w of [...new Set(other.map((t) => t.where))]) { rows.push({ kind: "space", key: `w-${w}`, label: w, depth: 0 }); for (const t of other.filter((x) => x.where === w)) term(t.address, t.name || t.agent, 1, t.status); }
  const free = live.filter((t) => isRoot(t) && !t.where && !seen.has(t.address));
  if (free.length) {
    rows.push({ kind: "space", key: "s-free", label: "スペースなし（フリー）", depth: 0, free: true });
    for (const t of free) term(t.address, t.name || t.agent, 1, t.status);
  }
  // ★74-3: the herdr TUI's agents (source "tui"; the App cannot list them): under a grey "TUI" space line per TUI space, after the App's own rows.
  // Never moved / stopped / ended from here (the TUI's own operations are not ours); pressing one reads it, "指示を送る" sends to it (herdr agent prompt).
  const tuis = agentList.filter((a) => a?.source === "tui" && a.address);
  for (const sp of [...new Set(tuis.map((a) => a.space || ""))]) {
    rows.push({ kind: "space", key: `tui-${sp}`, label: `${sp || "（スペースなし）"}`, depth: 0, tui: true });
    for (const a of tuis.filter((x) => (x.space || "") === sp)) {
      if (n >= PANEL_ROWS_MAX) break; n++;
      rows.push({ kind: "term", key: `tui-${a.address}`, label: a.name || a.address, depth: 1, nest: 0, app: a.app ?? null, shell: false, address: a.address, status: a.status ?? null, star: false, child: false, kids: 0, folded: false,
        space: a.space || "", tab: a.tab || "", pane: null, id: a.id, tui: true });
    }
  }
  return rows;
}

// ★95-8 what can be dragged to another space: an App terminal that is a leader or alone (a worker lives in its leader's room; a TUI agent is not ours to move).
export const isDraggable = (r) => !!r && r.kind === "term" && !r.tui && !(r.nest > 0);
// ★95-8 the spaces a row may be dropped on (ids): every space but the one it is in (moveToSpacePlan decides; nothing is called here).
// ★103-1: the drag moves by labels (moveByLabelPlan: park, then hc label — the way ★97 confirmed on the real App), not the old space.select + terminal.keep.
export const dropTargets = (agent, spaceList = []) => new Set((spaceList ?? []).filter((s) => s?.id && moveByLabelPlan(agent, s.id, spaceList).ok).map((s) => s.id));
// ★103-1 the plan for dropping on a heading: the real space (by labels), or フリー (by labels when the space exists, else it is made first).
export const dragPlanFor = (agent, spaceId, free, spaceList = []) => {
  if (!free) return moveByLabelPlan(agent, spaceId, spaceList);
  const fs = spaceList.find((s) => s.name === FREE_NAME && s.id);
  return fs ? moveByLabelPlan(agent, fs.id, spaceList) : moveToFreePlan(agent, spaceList);
};
// ★103-1 "＋" on a space heading: the choices (kind, then model) and the form that starts it there as a parent (no window, no first instruction).
export const PLUS_KINDS = [...AGENT_KINDS, SHELL_KIND];
export const quickLaunchForm = (spaceKey, kind, model, opts, dir) => ({ space: spaceKey === "free" ? FREE_SPACE : spaceKey, newName: "", kind, name: "", folder: "", task: "", parentMode: "parent", parent: "", model: model || "", effort: "", options: opts ?? null, effortDir: dir });
export const plusModels = (opts, kind) => opts?.kinds?.[kind]?.models ?? [];
// ★105 (判断4) "スペースを作る": a name no space has yet ("新しいスペース", "新しいスペース 2" ...); renamed in place right after.
export const NEW_SPACE_NAME = "新しいスペース";
export const newSpaceName = (spaceList = []) => { const used = new Set((spaceList ?? []).map((s) => s?.name)); let n = 1; while (used.has(n === 1 ? NEW_SPACE_NAME : `${NEW_SPACE_NAME} ${n}`)) n++; return n === 1 ? NEW_SPACE_NAME : `${NEW_SPACE_NAME} ${n}`; };
export const ROW_H = UI.row, BTN = UI.iconBtn, ICO = 18, TXT = UI.text; // ★103-4 the shared sizes (ui-rules.js UI, office-head103): rows 40, buttons 32

// ★72-3 a row as the person the office's menus take (room.js moveButtons / askStop, chat.js askEnd / doAgentOps): an App terminal.
export const rowAgent = (r) => ({ id: r.id, address: r.address, source: "app", name: r.label, status: r.status ?? "idle", space: r.space ?? "", tab: r.tab ?? "", pane: r.pane ?? null, shell: !!r.shell });

// ★73-2 "全体を表示" with the list open: the floor in the width left of it (the list covered the entrance); the zoom only (the mod's own
// scaling): K, and so the people's pictures, stay as they are. Returns { z, px } for zoomPan. `base`: the scene's own fit (1 for a native scene).
export function panelFit(sc, W, H, fitZoom, listW) {
  const w = Math.max(80, W - listW);
  if (sc?.native) return { z: fitZoom(sc, w, H), px: listW / 2 };
  const base = Math.min(4, (W - 8) / (sc?.width || 1), (H - 8) / (sc?.height || 1)), want = Math.min(4, (w - 8) / (sc?.width || 1), (H - 8) / (sc?.height || 1));
  return { z: Math.min(1, want / base), px: listW / 2 };
}

// ★103-3 (2nd): the floor fits the width between the left list (lw) and the right window (rt): the right window is attached, so the floor gets narrower by it.
export function sideFit(sc, W, H, fitZoom, lw = 0, rt = 0) {
  if (!lw && !rt) return { z: fitZoom(sc, W, H), px: 0, py: 0 };
  const lx = lw ? lw + LEFT_PAD : 0; // ★103: with the left list open the floor (walls, door, shadow) stays inside its right edge + a gap; closed / right only: unchanged
  const f = panelFit(sc, W, H, fitZoom, lx + rt); return { z: f.z, px: (lx - rt) / 2, py: 0 };
}

export class PanelPart {
  // Open / close the list and fit the floor to the width that is left (★73-2).
  panelSet(open, cx) { this.panelIsOpen = open; if (!open) this.spMenu = null; if (open) this.panelPoll(cx); this.zoomFit?.(cx); }

  panelOpen() { return this.panelIsOpen === true; }
  panelWidth() { return this.panelOpen() ? (this.leftW ?? PANEL_W) : PANEL_STRIP_W; }

  // hc's list (the terminals with no pane are only there): read every 5 s while the panel is open, from a timer (never in a render).
  // ★95-14: the search input (a retained InputState) is made in a task too — InputState.new throws when it is called during a draw.
  panelPoll(cx) {
    if (!this.psearch) cx.spawn(async (cx) => { try { this.psearch ??= InputState.new({ placeholder: "検索…" }); cx.notify(); } catch {} });
    // ★105 N6/N3: every call reads at once (opening the panel always refreshes); the 5 s timer is made once. termPanel also re-reads when the list is older than 7 s (panelStale),
    // so a timer that stopped can no longer leave the left list with the pane terminals only (the workers with no pane never showed).
    if (!this.panelTimer) this.panelTimer = cx.timer.every(5000, (cx) => { if (this.panelOpen()) cx.spawn(async (cx) => this.panelRead(cx)); });
    cx.spawn(async (cx) => this.panelRead(cx));
  }
  panelRead(cx) {
    if (!this.panelOpen() || this.panelReading) return Promise.resolve();
    this.panelReading = true; this.panelReadAt = Date.now();
    return (async () => {
      try { const r = await hc(["ls", "--json"]); const j = JSON.parse(String(r?.stdout ?? "").trim() || "{}"); const list = Array.isArray(j) ? j : (j.terminals ?? []); const sig = JSON.stringify(list.map((t) => [t.address, t.name, t.state, t.status, t.parent])); if (sig !== this.panelSig) { this.panelSig = sig; this.panelHc = list; cx.notify(); } this.panelHcErr = false; } catch { if (!this.panelHc) { this.panelHcErr = true; cx.notify(); } }
      finally { this.panelReading = false; }
    })();
  }
  panelStale(now = Date.now()) { return now - (this.panelReadAt ?? 0) > 7000; }

  // ★74-3: the grey "TUI" mark (this agent lives in the herdr TUI, not in the App).
  tuiBadge() { return div().flex_none().px(6).rounded(4).bg("#e7e5df").text_size(TXT.small).font_weight(700).text_color("#5f5b50").child("TUI"); } // ★104 U8: 14px (was 9)

  // ★74-3: "指示を送る" for a TUI agent: a small dialog (role "tui-prompt"); nothing is sent before "送る".
  openTuiPrompt(a) {
    openOverlay({ mod: "hakoniwa", kind: "dialog", modal: true, width: 460, height: 260, props: { role: "tui-prompt", id: a.id, name: a.name ?? a.address, status: a.status ?? "" } });
  }
  initTuiPrompt(cx) {
    this.tpText = InputState.new({ placeholder: "エージェントへの指示" }); this.tpForm = { busy: false, error: null, done: false };
    cx.spawn(async (cx) => { await this.loadConfig(); cx.notify(); });
  }
  tuiPromptView() {
    const p = props() ?? {}, f = this.tpForm ?? {}, blocked = p.status === "blocked";
    const send = (_e, cx) => {
      const text = String(this.tpText?.value() ?? "").trim(), c = this.feed?.config;
      if (f.busy || !text || !c) { if (!c) { f.error = "config.json を読めません"; cx.notify(); } return; }
      f.busy = true; f.error = null; cx.notify();
      cx.spawn(async (cx) => {
        let r; try { const x = await exec(c.python, [c.collector, "--prompt", p.id, "--text", text]); r = x.code ? { ok: false, error: (x.stderr || "").trim().split(/\r?\n/).pop() } : JSON.parse(x.stdout); } catch (e) { r = { ok: false, error: String(e) }; }
        f.busy = false;
        if (r.ok) { closeOverlay(p.overlay); return; }
        f.error = r.error || "送れませんでした"; cx.notify();
      });
    };
    return v_flex().id("tuip-root").size_full().p(18).gap(12).bg(P.paper).overflow_hidden() // ★95-7: the middle scrolls; the buttons stay
      .child(h_flex().flex_none().gap(6).items_center().child(div().min_w(0).truncate().text_size(TXT.body).font_weight(700).text_color(P.ink).child(`${p.name ?? ""} に指示を送る`)).child(this.tuiBadge()))
      .child(div().id("tuip-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().gap(12)
        .child(div().text_size(11).text_color(P.muted).child("herdr TUI のエージェントへ送ります（herdr agent prompt）。承認待ちのときは送れません。"))
        .child(Input.new(this.tpText))
        .child(div().min_h(16).text_size(11).text_color("#d6455d").child(f.error ?? (blocked ? "今は承認待ちです。先に承認の画面で答えてください。" : "")))))
      .child(h_flex().flex_none().gap(10).justify_end()
        .child(div().id("tuip-cancel").flex_none().px(16).py(8).rounded(8).border(1).border_color(P.line).bg(P.white).text_size(13).font_weight(700).text_color(P.ink).cursor_pointer().on_click(() => closeOverlay(p.overlay)).child("やめる"))
        .child(div().id("tuip-go").flex_none().px(16).py(8).rounded(8).bg(P.blue).text_size(13).font_weight(700).text_color("#ffffff").cursor_pointer().on_click(send).child(f.busy ? "送っています…" : "送る")));
  }

  // ---- ★84 the left list: space -> agent (two levels), a drag handle on every row, hover icons, the legend folded at the bottom.
  // The saved widths (widths.json, hakoniwa-office/): read once, not while drawing; written when a drag ends.
  async loadWidths(cx) {
    if (this.widthsRead) return; this.widthsRead = true;
    let raw = null; try { raw = JSON.parse(String(await readTextFile(`${appHome()}/hakoniwa-office/widths.json`) ?? "")); } catch {}
    const w = cleanWidths(raw, this.left?.width ?? 1600); this.leftW = w.left; this.rightW = w.right; cx.notify();
  }
  saveWidths() { try { writeTextFile(`${appHome()}/hakoniwa-office/widths.json`, JSON.stringify({ left: this.leftW ?? LEFT_W.def, right: this.rightW ?? null })); } catch {} }
  // The drag of a border (left list / right window): from the floor's and the handle's mouse events (no drawing here, only the redraw call).
  resizeStart(side, x) { this.resize = { side, x0: x, w0: side === "left" ? (this.leftW ?? PANEL_W) : (this.rightW ?? this.termBox?.w ?? Math.round((this.left?.width ?? 1600) * 0.3)) }; }
  resizeMove(x, cx) {
    const r = this.resize; if (!r) return false;
    const vw = this.left?.width ?? 1600, d = r.side === "left" ? x - r.x0 : r.x0 - x, w = r.w0 + d;
    const c = cleanWidths({ left: r.side === "left" ? w : this.leftW, right: r.side === "right" ? w : this.rightW }, vw);
    if (r.side === "left") this.leftW = c.left; else if (this.regionShown) { this.rightW = c.right; this.regionResize(c.right); } else this.ghostW = c.right; // the right window is only opened again when the drag ends
    cx.notify(); return true;
  }
  resizeEnd(cx) {
    const r = this.resize; if (!r) return false; this.resize = null;
    if (r.side === "right" && this.ghostW) this.rightW = this.ghostW;
    this.ghostW = null; this.saveWidths(); cx.notify(); return true;
  }
  doSpaceRename(id, cx) {
    const name = String(this.spRename?.state?.value() ?? "").trim(); this.spRename = null;
    if (name) cx.spawn(async (cx) => { try { await run("space.rename", { id, name }); } catch {} cx.notify(); });
    cx.notify();
  }
  // ★104 U10/U12: a short message under the heading, gone after 8 s. With `undo` ({ address, prev }) it carries "元に戻す" (the move just made).
  panelFlash(text, cx, undo = null) {
    this.panelMsg = undo ? null : text; this.panelUndo = undo ? { ...undo, text } : null;
    const n = this.panelFlashSeq = (this.panelFlashSeq ?? 0) + 1;
    cx.notify();
    cx.timer?.after(PANEL_FLASH_MS, (cx2) => { if (this.panelFlashSeq === n) { this.panelMsg = null; this.panelUndo = null; cx2.notify(); } });
  }
  // ★104 U10 "元に戻す": the team goes back to the room it came from (by the same labels as the drag). The list is read again here.
  panelUndoRun(cx) {
    const u = this.panelUndo; this.panelUndo = null; if (!u) { cx.notify(); return; }
    let sl = []; try { sl = spaces(); } catch {}
    const all = this.items?.() ?? [], cur = all.find((x) => x.address === u.address), free = !u.prev || u.prev === FREE_NAME, back = free ? null : sl.find((s) => s.name === u.prev && s.id);
    if (!cur) { this.panelFlash("もう戻せません（端末が見つかりません）", cx); return; }
    if (!free && !back) { this.panelFlash("元の部屋が見つかりません", cx); return; }
    const to = (x) => dragPlanFor(x, back?.id ?? null, free, sl), plan = teamPlan(cur, teamMembers(cur, all), to);
    if (!plan.ok) { this.panelFlash(plan.error === "もうその部屋にいます" ? "移動の反映を待ってから、もう一度押してください" : (plan.error ?? "戻せませんでした"), cx); return; }
    this.panelMsg = null; this.doMove(cur, plan, cx); cx.notify();
  }
  panelDrop(spaceId, cx, free = false) {
    const d = this.pdrag; this.pdrag = null; if (!d?.agent) { cx.notify(); return; }
    let sl = []; try { sl = spaces(); } catch {}
    const all = this.items?.() ?? [], full = all.find((x) => x.address === d.agent.address) ?? d.agent; // ★85-4 a team moves together; a worker alone does not
    const to = (x) => dragPlanFor(x, spaceId, free, sl); // ★101-3 dropping on the free heading moves to フリー
    const plan = isWorker(full, all) ? { ok: false, error: "ワーカーはリーダーと同じ部屋にいます（リーダーごと移ります）" } : teamPlan(full, teamMembers(full, all), to);
    this.panelMsg = null; this.panelUndo = null;
    const prev = full.space ?? "", name = d.label ?? full.name ?? "";
    if (plan.ok) this.doMove(full, plan, cx, (cx2) => this.panelFlash(`${ellipsize(name, 14)} を移しました`, cx2, { address: full.address, prev })); // ★104 U10 "元に戻す"
    else if (plan.error !== "もうその部屋にいます") this.panelFlash(plan.error ?? "ここには移せません", cx); // ★103-1 a drop that cannot move says why (the same room: nothing)
    cx.notify();
  }

  // ★107 "＋" on a heading and the bottom "新しいエージェント" open the launch window (launch.js openLaunch), the room chosen. The old "＋" menu (kind -> model) is gone:
  // the window has the six providers, the model and the effort. "スペースを作る" opens the make-a-space window (room.js openNewRoom: name + folder).
  newAgentFor(spaceKey, cur = null) {
    this.panelMsg = null; this.spMenu = null;
    this.openLaunch(cur ?? null, spaceKey === "free" ? FREE_SPACE : (spaceKey ?? null));
  }
  newSpaceStart(cx) { this.panelMsg = null; this.spMenu = null; this.openNewRoom(); cx.notify(); }
  // ★106 the room the bottom button opens the window for: the chosen person's room, else the first heading with an id (or フリー).
  newAgentKey(shown = [], sp = [], list = []) {
    const cur = (list ?? []).find((x) => x.id === this.selId && x.source !== "tui"), by = cur ? (sp ?? []).find((s) => s.name === cur.space)?.id : null;
    const keys = (shown ?? []).filter((g) => g.head && !g.head.tui).map((g) => g.head.spaceId ?? (g.head.free ? "free" : null)).filter(Boolean);
    return (by && keys.includes(by)) ? by : (keys[0] ?? null);
  }
  newAgentOpen(shown, sp, list) {
    const key = this.newAgentKey(shown, sp, list), cur = (list ?? []).find((x) => x.id === this.selId && x.source !== "tui") ?? null;
    const same = !!cur && !!key && (sp ?? []).find((s) => s.name === cur.space)?.id === key; // the person's folder goes along only when this is their room
    this.newAgentFor(key, same ? cur : null);
  }
  // ★107 a heading's "⋯" menu: its folder (shown), the rename, and closing the space (asked first: room.js askCloseRoom). `g`: { head, terms }.
  spMenuView(g, sp = [], list = []) {
    const h = g?.head, id = h?.spaceId; if (!id || this.spMenu !== id) return null;
    const stop = (_e, cx) => cx.stop_propagation(), s = (sp ?? []).find((x) => x.id === id), folder = normFolder(s?.folder);
    const item = (key, label, fn, o = {}) => h_flex().id(`pn-spm-${id}-${key}`).min_h(ROW_H).px(10).gap(8).items_center().rounded(6).text_size(TXT.small).text_color(o.red ? "#d6455d" : o.sub ? P.muted : P.ink)
      .when(!o.sub, (e) => e.cursor_pointer().hover((s2) => s2.bg("#f3efe4")).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.spMenu = null; fn(cx); }))
      .when(!!o.ic, (e) => e.child(icon(o.ic, 16, o.red ? "#d6455d" : o.sub ? P.muted : P.blue))).child(div().min_w(0).truncate().child(label));
    const members = (g.terms ?? []).map((r) => (list ?? []).find((x) => x.address === r.address && x.source !== "tui") ?? rowAgent(r));
    return v_flex().id(`pn-spmenu-${id}`).ml(18).p(4).gap(1).rounded(10).bg("#ffffff").border(1).border_color(P.line).shadow_md()
      .child(item("folder", folder ? `フォルダ: ${tailFolder(folder)}` : "フォルダ: （ホーム）", () => {}, { sub: true, ic: "folder" })) // 19th K3: the end of a long path, not its head
      .child(item("rename", "名前を変える", (cx) => { this.spRename = { id, state: renameState(h.label) }; cx.notify(); }, { ic: "pencil" }))
      .child(item("close", members.length ? "このスペースを閉じる…" : "このスペースを閉じる（空です）", () => this.askCloseRoom({ id, name: h.label }, members), { red: true, ic: "trash" }));
  }

  // ★101-6 the legend's pictures are the floor's own marks (a sheet part, the same disc / dot / ring / bubble / red mug). ★105: the legend moved to the footer (main.js), which draws its marks with this.
  legendIcon(m) {
      const ic = m.icon ?? {}, box = div().flex_none().w(20).h(18).flex().items_center().justify_center();
      if (ic.part) {
        const q = this.lifeParts?.[ic.part]; // only a file the manifest already gave: never a path that is not there
        if (q?.file) { const s = Math.min(18 / q.w, 16 / q.h); return box.child(image(q.file).w(Math.max(1, q.w * s)).h(Math.max(1, q.h * s))); }
        return box;
      }
      if (ic.glyph === "mug") return box.child(div().w(9).h(11).rounded(2).bg("#d62828").border(1).border_color("#8f1414").child(div().mt(2).ml(2).w(2).h(5).rounded(1).bg("#ff8a8a")));
      if (ic.glyph === "dot") return box.child(div().w(10).h(10).rounded(5).bg(ic.color ?? STATE.working.color));
      if (ic.glyph === "disc") return box.child(this.markDisc?.(ic.text, ic.color, 8) ?? div().size(16).rounded(8).bg(ic.color).flex().items_center().justify_center().text_size(11).font_weight(900).text_color("#ffffff").child(ic.text));
      if (ic.glyph === "ring") return box.child(div().w(15).h(15).rounded(15).border(2.5).border_color(ic.color ?? "#e0a90f"));
      if (ic.glyph === "bubble") return box.child(div().w(18).h(13).rounded(7).bg("#ffffff").border(1).border_color("#c9c2b2").flex().items_center().justify_center().text_size(9).font_weight(800).text_color("#4b5563").child("…"));
      return box.child(div().text_size(11).font_weight(700).text_color(P.muted).child(ic.text ?? "•"));
    }

  termPanel(left, list, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    if (this.panelOpen() && this.panelStale()) { this.panelReadAt = Date.now(); cx.spawn(async (cx2) => this.panelRead(cx2)); } // ★105 N6/N3: a list older than 7 s is read again (not only from the timer)
    if (!this.panelOpen()) { // folded: a thin strip: the arrow, "一覧" down it (13th D4: the word of what it opens), and a small legend icon
      return v_flex().id("term-panel").absolute().left(0).top(8).w(PANEL_STRIP_W).h(Math.min(190, left.height - 70)).items_center().justify_center().gap(2)
        .rounded_r(8).bg("#fffdf8ee").border(1).border_color("#e6e2d8").cursor_pointer().hover((s) => s.bg("#f3efe4"))
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.panelSet(true, cx); })
        .child(div().text_size(16).font_weight(700).text_color(P.ink).child("▶")).children(["一", "覧"].map((c) => div().text_size(TXT.small).font_weight(700).text_color(P.ink).child(c)))
        .child(div().h(4));
    }
    this.loadWidths(cx);
    let sp = [], pn = []; try { sp = spaces(); pn = panes(); } catch {}
    // ★9b Z2: "hakoniwa.close" (a fresh request, seen once) also closes the heading's "⋯" menu: office.js closes the right window, this closes the menu
    { const cr = shared("hakoniwa.close"); if (cr?.at && cr.at !== this.spMenuCloseAt) { this.spMenuCloseAt = cr.at; if (Date.now() - cr.at < 15000) this.spMenu = null; } }
    // 5th X5: review "hakoniwa.space-menu:<space>" (room.js sets the shared request): opens that heading's "⋯" menu once per request (id or name; a name that is not found does nothing)
    { const rq = shared("hakoniwa.panel"); if (rq?.spaceMenu && rq.at && rq.at !== this.spMenuReqAt && Date.now() - rq.at < 15000) { this.spMenuReqAt = rq.at; const want = String(rq.spaceMenu), s0 = sp.find((x) => x.id === want) ?? sp.find((x) => x.name === want) ?? sp.find((x) => want && String(x.name ?? "").toLowerCase().includes(want.toLowerCase())); /* ★8th Y5: a part of the name ("AI") opens it too (the review used "space-menu:AI" and nothing opened) */ if (s0) { if (this.spMenu === s0.id) this.spMenu = null; /* ★9b Z2: sent again for the heading whose menu is open: it closes */ else { this.spMenu = s0.id; this.spFolded?.delete(s0.id); } } } }
    const all = panelRows(sp, pn, this.panelHc ?? [], (() => { try { return answeredView(list ?? [], shared("hakoniwa.apanswered")); } catch { return list ?? []; } })(), (this.panelFolded ??= new Set()), this._teamFailed), pick = this.termPick?.address;
    const q = String(this.psearch?.value?.() ?? "").trim().toLowerCase();
    // two levels: the tab rows are not shown (a tab's agents sit directly under the space); a search keeps the spaces that have a hit
    const groups = [];
    for (const r of all) {
      if (r.kind === "tab") continue;
      if (r.kind === "space") groups.push({ head: r, terms: [] });
      else { if (!groups.length) groups.push({ head: null, terms: [] }); groups[groups.length - 1].terms.push(r); }
    }
    const shown = groups.map((g) => ({ ...g, terms: q ? g.terms.filter((t) => String(t.label).toLowerCase().includes(q) || String(g.head?.label ?? "").toLowerCase().includes(q)) : g.terms })).filter((g) => !q || g.terms.length);
    const color = (s) => STATE[s]?.color ?? "#b8b2a6", W = this.leftW ?? PANEL_W, hover = this.panelHover;
    const hoverOn = (key) => (h, cx2) => { if (h) { if (this.panelHover !== key) { this.panelHover = key; cx2.notify(); } } else if (this.panelHover === key) { this.panelHover = null; cx2.notify(); } };
    // ★95-8 while a row is dragged: the spaces it may be dropped on are tinted, the one under the pointer is blue; elsewhere nothing happens and nothing is tinted
    const targets = this.pdrag ? dropTargets(this.pdrag.agent, sp) : null;
    const spaceRow = (g) => {
      // ★105 N3: the count is the people (not shells), as the floor's "N人" counts them
      const h = g.head, id = h.spaceId, sel = !!id && !!this.spRename && this.spRename.id === id, count = g.terms.filter((t) => !t.shell).length, free = !!h.free, okey = id ?? (free ? "free" : null);
      // ★101-3 the free heading ("スペースなし（フリー）") is a drop target too: a drop there moves the person / team to フリー
      const canFree = free && !!this.pdrag && moveToFreePlan(this.pdrag.agent, sp).ok;
      const can = free ? canFree : (!!id && !!targets?.has(id)), over = can && this.pdrag.over === okey, show = hover === h.key;
      const plusOk = (!!id || free) && !h.tui, menuOn = !!id && this.spMenu === id;
      return h_flex().id(`pn-${h.key}`).pl(6).pr(4).h(ROW_H).gap(5).items_center().rounded(6).when(over, (e) => e.bg("#dcebff").border(1).border_color(P.blue)).when(can && !over, (e) => e.bg("#f1f7ff").border(1).border_color("#bcd3f5")).when(!over && !can && !this.pdrag && show, (e) => e.bg("#f3efe4"))
        .on_hover(hoverOn(h.key)).on_mouse_move((_e, cx2) => { if (this.pdrag && this.pdrag.over !== okey) { this.pdrag.over = okey; cx2.notify(); } })
        .on_mouse_up("left", (_e, cx2) => { if (this.pdrag && (id || free)) { cx2.stop_propagation(); this.panelDrop(id, cx2, free); } })
        // ★105 (codex_3) ▾ (folds the space) · folder · name · count in a round badge · a blue square "＋"
        .child(okey ? iconBtn(`sp-fold-${okey}`, spFolded(okey) ? "right" : "down", (cx2) => { const f = (this.spFolded ??= new Set()); if (f.has(okey)) f.delete(okey); else f.add(okey); cx2.notify(); }, { size: UI.hit, isize: 14 }) : div().flex_none().w(UI.hit).h(BTN))
        .child(icon("folder", 20, "#e0a90f"))
        .child(sel ? inlineRename(`sprn-${id}`, this.spRename.state, (cx2) => this.doSpaceRename(id, cx2), (cx2) => { this.spRename = null; cx2.notify(); }, TXT.body)
          : h_flex().flex_1().min_w(0).gap(8).items_center().child(div().min_w(0).truncate().text_size(TXT.body).font_weight(700).text_color(P.ink).child(headText(W, h.label, count, { more: !sel && !!id && (show || menuOn || !!h.empty), plus: !sel && plusOk }))) // 25th L4: the end is tidy ("…" never after "_")
            .child(div().flex_none().min_w(24).h(22).px(7).flex().items_center().justify_center().rounded(11).bg("#e8eaee").text_size(TXT.small).font_weight(700).text_color(P.ink).child(String(count))))
        // ★107 "⋯" (the menu: folder / 名前を変える / 閉じる): on hover, while open, and always on an empty space (so it can be closed)
        .when(!sel && !!id && (show || menuOn || !!h.empty), (e) => e.child(iconBtn(`sp-more-${id}`, "more", (cx2) => { this.spMenu = menuOn ? null : id; cx2.notify(); }, { size: BTN, isize: ICO, color: P.ink, frame: true, active: menuOn, tip: "メニュー" })))
        // ★103-2 "＋" on every heading (always shown). ★107: it opens the launch window with THIS room chosen. ★105: a filled blue square like codex_3
        .when(!sel && plusOk, (e) => e.child(div().id(`sp-plus-${okey}`).flex_none().w(BTN).h(BTN).flex().items_center().justify_center().rounded(8).bg("#e1ecfd").cursor_pointer().hover((s) => s.bg("#cfe0fb"))
          .on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); this.newAgentFor(okey, null); cx2.notify(); }).child(icon("plus", 18, P.blue))));
    };
    const spFolded = (k) => !!k && !!this.spFolded?.has(k) && !q;
    const termRow = (r) => {
      const ag = (list ?? []).find((x) => x.address === r.address && x.source !== "tui"), on = ag ? this.selId === ag.id && this.open : pick === r.address, a = rowAgent(r);
      // ★104 U5/U6: the pencil / trash show on hover or after "⋯" (not just because the row is chosen: the name keeps its room); "⋯" is always there, pale
      const dragging = this.pdrag?.address === r.address, acts = hover === r.key || this.rowMore === r.key, show = acts || on, ren = !!this.renaming && this.renaming.id != null && this.renaming.id === r.id ? this.renaming : null;
      const click = ag ? (_e, cx2) => { cx2.stop_propagation(); this.rowMore = null; if (on) { this.closePanel(cx2); return; } this.termPick = null; this.select(ag, cx2); }
        : (_e, cx2) => { cx2.stop_propagation(); this.termPick = on ? null : { address: r.address, name: r.label }; if (!on) { this.open = false; } cx2.notify(); };
      const nest = r.nest ?? 0, grip = isDraggable(r), tg = rowTags(W, r, { ag: !!ag, acts, ren: !!ren, show, more: on });
      const fold = r.kids > 0 ? div().id(`pn-fold-${r.address}`).flex_none().w(UI.hit).h(BTN).flex().items_center().justify_center().rounded(4).cursor_pointer().hover((s) => s.bg("#e6e2d8"))
        .on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); const f = (this.panelFolded ??= new Set()); if (f.has(r.address)) f.delete(r.address); else f.add(r.address); cx2.notify(); })
        .child(icon(r.folded ? "right" : "down", 14, P.muted)) : null;
      const row = h_flex().id(`pn-${r.key}`).pl(10).pr(4).h(ROW_H).gap(5).items_center().rounded(6).cursor_pointer().when(on || dragging, (e) => e.bg("#e8f0fe")).when(dragging, (e) => e.shadow_md()).hover((s) => s.bg(on ? "#e8f0fe" : "#f3efe4"))
        .on_hover(hoverOn(r.key)).on_click(click)
        // ★95-9 a worker is indented under its leader with a joining line; ★95-8 only a row that can be moved has a handle (the others keep the width, no handle)
        .when(nest > 0, (e) => e.child(div().flex_none().w(14 * (nest - 1))).child(h_flex().flex_none().w(14).h(ROW_H).items_center().child(div().ml(6).w(1).h(ROW_H).bg("#cfc9bb")).child(div().w(7).h(1).bg("#cfc9bb"))))
        // ★103-1 the handle is 20px wide and the whole row height (an easy thing to grab); the drag also ends on the panel's own mouse-up (see below)
        .child(grip ? div().id(`pn-grip-${r.address}`).flex_none().w(24).h(ROW_H).flex().items_center().justify_center().cursor_pointer().on_mouse_down("left", (e, cx2) => { cx2.stop_propagation(); this.panelMsg = null; this.panelUndo = null; this.spMenu = null; this.pdrag = { address: r.address, agent: a, label: r.label, over: null, x: e?.position?.x ?? 0, y: e?.position?.y ?? 0 }; cx2.notify(); }).child(icon("grip", 15, "#b8b2a6"))
          : div().flex_none().w(20))
        .child(STATE[r.status] && this.stateMark ? this.stateMark(STATE[r.status], 16) : dot(color(r.status), 10)) // ★104 U4 the floor's own mark (a shape in it), not a colour dot alone
        // ★95-10 the kind: an agent has its logo (the robot when unknown), a shell has `>_`
        .child(div().flex_none().w(20).h(20).flex().items_center().justify_center().child(r.shell ? icon("terminal", 18, P.muted) : platformIcon({ app: r.app }, 18)))
        .when(!!fold, (e) => e.child(fold))
        .when(r.star, (e) => e.child(div().id(`pn-crown-${r.address}`).flex_none().w(18).h(18).flex().items_center().justify_center().child(icon("crown", 16, "#e0a90f")))) // ★106-4 a crown on the leader's row (a leader = has workers: the floor's gold ring)
        .child(ren ? inlineRename(`rn-${r.address}`, ren.state, (cx2) => this.doRename(a, cx2), (cx2) => { this.renaming = null; cx2.notify(); }, TXT.body)
          : (() => { const ln = listName(r, tg); // 25th L5: "Claude Code（Opus 5.5）" -> the name, then "Opus 5.5" as a pale word (dropped when the room is short); L4: a tidy cut
            return ln.model ? h_flex().id(`pn-name-${r.key}`).flex_1().min_w(0).gap(6).items_center().child(div().flex_none().text_size(TXT.body).text_color(P.ink).child(ln.text))
                .child(div().id(`pn-model-${r.key}`).flex_none().text_size(TXT.small).text_color(P.muted).child(ln.model)).child(div().flex_1().min_w(0))
              : div().id(`pn-name-${r.key}`).flex_1().min_w(0).truncate().text_size(TXT.body).text_color(P.ink)
                .when(nameCut(r, tg), (e) => e.tooltip(String(r.label))) // ★14a C1: a name cut by "…" shows in full as the pointer's tooltip (the same `.tooltip` as iconBtn's tip)
                .child(ln.text); })()) // ★107 W1: min_w 0 (rowTags leaves the name its room); the right-hand actions never get pushed out
        .when(!ren && tg.workers, (e) => e.child(div().flex_none().px(6).py(1).rounded(8).bg("#fbf1d6").text_size(TXT.small).text_color("#8a6a12").child(`ワーカー ${r.kids}`)))
        // ★97 the leader split from its workers: a "まとめる" button (★101-5: no red 別室 tag any more — the teams come together by themselves). ★104 U7: 32px high
        .when(!ren && tg.merge, (e) => e.child(div().id(`pn-merge-${r.address}`).flex_none().h(UI.hit).px(8).flex().items_center().rounded(8).bg("#fdf1d6").text_size(TXT.small).font_weight(700).text_color("#8a6a12")
          .cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); this.doMove(a, teamFixPlan(a, list ?? [], sp), cx2); }).child("まとめる")))
        // ★104 U5 the model tag only where there is room (not on a chosen / hovered row)
        // ★106 V4/V6: the tag is a short name that is never cut ("Sonnet 5.5"); a row with "まとめる" or a name too long for the tag has none
        .when(!ren && tg.model, (e) => e.child(div().flex_none().px(6).py(1).rounded(8).bg("#eceff3").text_size(TXT.small).text_color(P.muted).child(shortModel(r.model))))
        // ★101-4 the pencil (rename) and the trash (end this session, asked first). ★104 U6: they show on hover or after the always-there pale "⋯"
        .when(!ren && acts && !r.tui && !!ag, (e) => e.child(iconBtn(`pn-pen-${r.address}`, "pencil", (cx2) => { this.renaming = { id: r.id, state: renameState(r.label) }; this.rowMore = null; cx2.notify(); }, { size: BTN, isize: ICO })))
        .when(!ren && acts && !r.tui, (e) => e.child(iconBtn(`pn-trash-${r.address}`, "trash", (cx2) => { this.rowMore = null; this.askEnd(a, list ?? []); }, { size: BTN, isize: ICO, red: true })))
        .when(!ren && !acts && on && !r.tui, (e) => e.child(iconBtn(`pn-more-${r.address}`, "more", (cx2) => { this.rowMore = r.key; cx2.notify(); }, { size: BTN, isize: ICO, color: P.ink, frame: true, tip: "メニュー" }))); // 5th X7: darker + framed, so it reads as a button
      return row;
    };
    // 19th K8: a room with nobody in it (0 people) says what to do next, under its heading (pale, one line)
    const emptyHint = (g) => (g.head?.spaceId && !g.head.tui && !g.head.free && !g.terms.some((t) => !t.shell) && !(this.spRename?.id === g.head.spaceId))
      ? [div().id(`pn-hint-${g.head.spaceId}`).pl(UI.hit + 31).h(22).flex().items_center().text_size(TXT.small).text_color(P.muted).child("＋ でエージェントを入れます")] : [];
    const rowsEl = shown.flatMap((g) => [...(g.head ? [spaceRow(g)] : []), ...(g.head ? emptyHint(g) : []),...(g.head && this.spMenu ? [this.spMenuView(g, sp, list)].filter(Boolean) : []), ...(g.head && spFolded(g.head.spaceId ?? (g.head.free ? "free" : null)) ? [] : g.terms.map(termRow))]);
    return v_flex().id("term-panel").absolute().left(0).top(8).w(W).h(Math.max(160, left.height - 16)).p(6).gap(4).rounded_r(10).bg("#fffdf8f2").border(1).border_color("#e6e2d8")
      .on_mouse_down("left", (_e, cx2) => { cx2.stop_propagation(); if (this.spMenu) { this.spMenu = null; cx2.notify(); } }) // ★9b Z2: a press on the list's empty part closes the "⋯" menu (the menu's own items and the "⋯" buttons stop the press themselves)
      .on_mouse_down_out((_e, cx2) => { if (this.spMenu) { this.spMenu = null; cx2.notify(); } }) // ★9b Z2: a press outside the list (the floor, the right window) closes it too
      .on_scroll_wheel((_e, cx2) => cx2.stop_propagation())
      .on_mouse_move((e, cx2) => { if (this.resize) this.resizeMove(e.position.x, cx2); else if (this.pdrag && (Math.abs((e.position.x) - (this.pdrag.x ?? 0)) >= 2 || Math.abs((e.position.y) - (this.pdrag.y ?? 0)) >= 2)) { this.pdrag.x = e.position.x; this.pdrag.y = e.position.y; cx2.notify(); } })
      // ★103-1 the drop is decided HERE too, from the heading under the pointer (pdrag.over, set by the headings' mouse-move): a heading's own mouse-up
      // may not be the one that gets the release, and then nothing moved. (The heading's own mouse-up stops the event, so a drop never runs twice.)
      .on_mouse_up("left", (_e, cx2) => { if (this.resize) this.resizeEnd(cx2); else if (this.pdrag) { const o = this.pdrag.over; if (o) this.panelDrop(o === "free" ? null : o, cx2, o === "free"); else { this.pdrag = null; cx2.notify(); } } })
      .child(h_flex().h(36).gap(4).items_center()
        // ★103-4-1 the fold button: an arrow pointing to the edge it folds to (left), 32px
        // ★104 U13 the same look as the right head's fold button: a frameless icon button (the left one pointed with a framed text arrow)
        .child(iconBtn("term-panel-fold", "left", (cx2) => this.panelSet(false, cx2), { size: BTN, isize: ICO, tip: "一覧をたたむ" })) // ★107 W8 a tooltip: what "‹" does
        .child(div().flex_1().text_size(UI.text.strong).font_weight(700).text_color(P.ink).child("ワークスペース")))
      // ★103 polish: a short hint under the heading (small, pale). Not about parent/child moves.
      .child(div().id("pn-hint").flex_none().px(8).min_w(0).truncate().text_size(TXT.small).text_color("#5f5b50").child(PANEL_HINT)) // ★107 W8: one step darker than P.muted (was too pale to read); ★104 U8 14px
      // ★103-2 the "＋ エージェント" / "＋ ターミナル" buttons are gone from here: every space heading has its own "＋" (kind -> model)
      .when(!!this.psearch, (e) => e.child(h_flex().flex_none().h(34).px(8).gap(6).items_center().rounded(8).border(1).border_color(P.line).bg("#ffffff").child(icon("search", 16, P.muted)).child(div().flex_1().min_w(0).child(Input.new(this.psearch)))))
      .when(!!this.panelMsg, (e) => e.child(div().flex_none().px(8).py(4).rounded(6).bg("#fdecea").text_size(TXT.small).text_color("#d6455d").child(String(this.panelMsg))))
      // ★104 U10 "○○ を移しました — 元に戻す" (8 s)
      .when(!!this.panelUndo, (e) => e.child(h_flex().id("pn-undo").flex_none().h(UI.hit).px(8).gap(8).items_center().rounded(6).bg("#e8f0fe")
        .child(div().flex_1().min_w(0).truncate().text_size(TXT.small).text_color(P.ink).child(String(this.panelUndo.text)))
        .child(div().id("pn-undo-btn").flex_none().h(UI.hit).px(8).flex().items_center().rounded(6).text_size(TXT.small).font_weight(700).text_color(P.blue).cursor_pointer().hover((s) => s.bg("#d6e4fb"))
          .on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); this.panelUndoRun(cx2); }).child("元に戻す"))))
      .when(!!this.opError?.text && !this.panelMsg, (e) => e.child(div().flex_none().px(8).py(4).rounded(6).bg("#fdecea").text_size(TXT.small).text_color("#d6455d").child(ellipsize(String(this.opError.text), 80))))
      // ★104 U9 nothing is blank: "読み込み中…" until hc's list came (or "読み込めません"), "該当なし" for a search with no hit
      .child(div().id("term-panel-body").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().gap(1).children(rowsEl.length ? rowsEl
        : [div().id("pn-empty").px(8).py(8).text_size(TXT.small).text_color(P.muted).child(q ? "該当なし" : this.panelHc ? "表示する端末がありません" : this.panelHcErr ? "読み込めません" : "読み込み中…")])))
      // ★106 (★105 追加) "新しいエージェント" at the bottom: ★107 opens the launch window (the chosen person's room, else the first room)
      .child(div().id("pn-new-agent").flex_none().h(UI.hit + 4).mt(2).px(10).gap(8).flex().items_center().justify_center().rounded(8).bg("#e1ecfd").cursor_pointer().hover((s) => s.bg("#cfe0fb"))
        .on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); this.newAgentOpen(shown, sp, list); cx2.notify(); })
        .child(icon("plus", 18, P.blue)).child(div().text_size(TXT.body).font_weight(700).text_color(P.blue).child("新しいエージェント")))
      // ★107 (判断4) "スペースを作る": the make-a-space window (name + folder). The left list shows an empty space too; the floor draws only rooms with a person.
      .child(div().id("pn-new-space").flex_none().h(UI.hit).px(10).gap(8).flex().items_center().justify_center().rounded(8).border(1).border_color(P.line).bg("#ffffff").cursor_pointer().hover((s) => s.bg("#f3efe4"))
        .on_mouse_down("left", stop).on_click((_e, cx2) => { cx2.stop_propagation(); this.newSpaceStart(cx2); })
        .child(icon("room-add", 16, P.ink)).child(div().text_size(TXT.small).font_weight(700).text_color(P.ink).child("スペースを作る")))
      // ★95-8 the picked row follows the pointer (a small chip beside it, so it never sits under the pointer)
      .when(!!this.pdrag?.label, (e) => e.child(div().absolute().left((this.pdrag.x ?? 0) + 12).top((this.pdrag.y ?? 0) - 8 + 8).px(8).py(3).rounded(6).bg("#ffffff").border(1).border_color(P.blue).shadow_md().text_size(TXT.small).text_color(P.ink).child(ellipsize(String(this.pdrag.label), 16))))
      .child(splitHandle("left-split", (e, cx2) => { this.resizeStart("left", e.position.x); cx2.notify(); }, this.resize?.side === "left").right(-3))
      // ★105 (codex_3) the border can be seen to be grabbed: a small pill with three dots at its middle (same press as the handle behind it)
      .child(v_flex().id("left-split-grip").absolute().right(-6).top(Math.max(40, Math.round(left.height / 2) - 22)).w(12).h(44).items_center().justify_center().gap(4).rounded(6).bg("#fffdf8").border(1).border_color("#cfc9bb").cursor_col_resize()
        .on_mouse_down("left", (e, cx2) => { cx2.stop_propagation(); this.resizeStart("left", e.position.x); cx2.notify(); })
        .children([0, 1, 2].map((i) => div().w(3).h(3).rounded(2).bg(this.resize?.side === "left" ? P.blue : "#9a9588"))));
  }
}
