// hansol: every coding agent on this PC (T3 Code, Herdr App, herdr TUI) in one view.
// Roles (props().role): "band" (HUD strip), "board" (kanban), "office" (pixel-art office),
// "chat" (conversation window, opened by a click), "pane" (pane header).
// Data: hansol-collector.py writes state.json; this mod runs it every few seconds
// (pythonw, no console) and redraws when the file changes. Herdr App agents take their
// live status from agents(), so they update at once.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, closeOverlay, exec, home, nextCommand, openOverlay, panes, props, readTextFile, run,
  setAgentOrder, setShared, spaces, shared, theme, watchFolder, window as herdrWindow, writeTextFile } from "herdr"; // 13th: herdr's `window` is the title-bar function; the gpui `window` (viewport_size) is globalThis.window — never import it bare
import { isGenericTitle, applyLaunchKinds } from "./actions.js";
import { withDefaults, problemText } from "./config-defaults.js";
import { RAD, STATES, STATE, SHELL_STATE, answeredView, LONG_IDLE_MS, ROOM, REFRESH_MS, P, dot, chip, badge, ago, platform, platformIcon, blockedText, applyRoomTitles, applyColors, fmtMem, hasMem, CHIP_X, chipLeft, activityLabel, activityText } from "./common.js";
import { ICON_DIR, icon } from "./icons.js";
import { UI, LOGO_W, LOGO_H, LOGO_HEAD, CARET, showCaret, chipPeople, chipAction, chipListHeight, CHIP_LIST, clipName, NAME_EM_FULL } from "./ui-rules.js";
import { OfficePart, GUILD, MEADOW, MOSSES } from "./office.js";
import { MossesPart } from "./mosses.js";
import { terminalWindowHead, terminalWindowGrip, terminalWindowEdge, terminalResizeSurface } from "./terminal-window.js";
import { ChatPart } from "./chat.js";
import { RegionPart } from "./region.js";
import { DetailPart } from "./detail.js";
import { GridPart } from "./grid.js";
import { LaunchPart } from "./launch.js";
import { RoomPart } from "./room.js";
import { MeetPart } from "./meet.js";
import { PanelPart } from "./panel.js";
import { FeedPart } from "./feed.js";
import { GitPart } from "./git-tree.js";
import { GitWorkPart } from "./git-work.js";
import { RankPart } from "./rank.js";

const SETTINGS_MENU = { w: 300, h: 288, row: 46 }; // 2026-11-19 the "설정" menu (heading 25 + 5 rows + a line + padding; 2026-11-26 + 모세스)
const FADE_MS = 0; // no fade: a fade from 0 shows the empty beige ground for ~100 ms (reviews 5); the switch is immediate

class AgentHud extends View {
  async close() { try { this.popGone?.(); } catch {} } // 10th A4: a popup that goes by itself (Esc, a click outside) drops its id from shared "hansol.pops" (feed.js)
  init(_p, cx) {
    this.feed = { state: null, text: null, config: null, busy: false, error: null };
    this.observed = {};
    this.size = { width: 1200, height: 600 };
    const role = props()?.role ?? "board";
    if (role === "office") { setShared("hansol.terminalWindows", {}); setShared("hansol.mzView", { key: null, at: Date.now() }); setShared("hansol.mzAnswered", {}); } // (MOSSES: the cluster view, no answer lock left over)
    if (role === "pane" || role === "confirm" || role === "move" || role === "pick-head" || role === "state-list") return;
    if (role === "inbox") { // ★106 ② (detail.js). 13th B4: the inbox window read no collector state, so items() lacked parent_id and a child handed back to its parent still counted as 報告あり (chip 3 vs inbox 4): read the feed like the head does
      this.watchApprovals(cx);
      cx.spawn(async (cx2) => { try { await this.loadConfig(); if (await this.load()) cx2.notify(); } catch {} });
      cx.timer.every(1500, (cx2) => { if (this.feed.config) cx2.spawn(async (cx3) => { try { if (await this.load()) cx3.notify(); this.inboxResize?.(); } catch {} }); }); // 28th P2: a count that grew after the window opened → open again at the right height (room.js)
      return;
    }
    if (role === "rhead") this.watchApprovals(cx); // ★106 ② the region's head can show the inbox (its cards need the screens read)
    if (role === "rchat") return this.initRegionChat(cx); // ★103-3 (region.js; rhead / rtree take the default path below)
    if (role === "launch") return this.initLaunch(cx);
    if (role === "room-new") return this.initRoomNew(cx);
    if (role === "terminal-window-head" || role === "terminal-window-grip" || role === "terminal-window-edge" || role === "terminal-resize-surface") return;
    if (role === "chat" || role === "chat-body" || role === "chat-input" || role === "chat-approve") return this.initChat(cx);
    if (role === "agent-menu") return;
    if (role === "tui-prompt") return this.initTuiPrompt(cx); // ★74-3 (panel.js)
    if (role === "git-graph") return this.initGit(cx); // 2026-11-21 the Git window (git-tree.js)
    if (role === "git-resize") return;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    if (role !== "band") cx.timer.every(30000, (cx) => cx.notify());
    if (role === "office") this.mzStartTimer(cx); // 2026-11-26 the MOSSES layout's clock (mosses.js): from init, so it runs whether or not a draw happens
    // "hansol.chat-next" (keys.json or herdr-app do): the conversation of whoever needs you first.
    // "hansol.demo": switch the made-up agents on / off (shared "hansol.demo").
    if (role === "band") cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (await this.reviewCommand(command)) continue; // ★61-1 select / plate / stop / launch[:target] (room.js): review pictures without clicks
        if (command === "demo") { setShared("hansol.demo", !this.demo()); continue; }
        if (command === "close") { this.popCloseAll(); setShared("hansol.close", { at: Date.now() }); if (shared("hansol.inboxOpen")?.on) setShared("hansol.inboxOpen", { on: false, at: Date.now() }); this.closeInboxWin?.(); continue; } // closes the side panel (and the inbox window: 8th Y2) (for the review pictures)
        if (command === "popclose") { this.popCloseAll(); if (shared("hansol.inboxOpen")?.on) setShared("hansol.inboxOpen", { on: false, at: Date.now() }); this.closeInboxWin?.(); continue; } // 33b U4 (27-U4, review): closes only the inbox window and the popups (feed / usage / chip); the right window stays (hansol.close closes it too)
        if (command === "convback") { setShared("hansol.convback", { at: Date.now() }); continue; } // 21st I5 (review): the same as a press on 「↑ 前の発言を読む」 in the right window (detail.js watches the stamp)
        if (command === "hour") { const seq = [8, 12, 17, 22, null], cur = shared("hansol.hour"), i = seq.indexOf(typeof cur === "number" ? cur : null); setShared("hansol.hour", seq[(i + 1) % seq.length]); continue; } // review: morning, noon, evening, night, real time
        if (command === "atlas") { this.openLaunch(this.items().find((a) => a.id === shared("hansol.sel")) ?? null, null, "atlas"); continue; } // Atlas Code (atlas-tui project): `herdr-app do hansol.atlas`
        if (command === "launch") { this.openLaunch(this.items().find((a) => a.id === shared("hansol.sel")) ?? null); continue; } // ★27-1 (review pictures): opens the input dialog; nothing is started by it
        if (command === "end") { const t = this.items().find((a) => a.id === shared("hansol.sel") && a.source === "app"); if (t) this.askEnd(t, this.items()); continue; } // opens the confirm dialog only (nothing is ended until "はい")
        if (command === "bird") { setShared("hansol.bird", Date.now()); continue; }
        if (command === "weather") { const seq = ["clear", "partly", "cloudy", "fog", "rain", "snow", "thunder", null], cur = shared("hansol.weather"), i = seq.indexOf(typeof cur === "string" ? cur : null); setShared("hansol.weather", seq[(i + 1) % seq.length]); continue; } // review: step through the 7 kinds, then the real weather
        if (String(command).split(":")[0] === "legend") { const a = String(command).split(":")[1], cur = shared("hansol.legend")?.fold; setShared("hansol.legend", { fold: a === "fold" ? true : a === "open" ? false : !cur, at: Date.now() }); continue; } // review: hansol.legend:fold / :open (no arg: the other one) folds or opens the legend without a click
        if (command === "zoom") { const seq = [1.25, 4 / 3, 1.6, 2, "fit"], cur = shared("hansol.zoom")?.z, i = seq.indexOf(cur ?? "fit"); setShared("hansol.zoom", { z: seq[(i + 1) % seq.length], at: Date.now() }); continue; } // ★62-2 review: the zoom steps 1.25, 1.33, 1.6, 2, then 全体を表示 (for the pictures of the seams; no wheel)
        if (command === "grid") { setShared("hansol.grid", shared("hansol.grid") !== true); continue; } // show the tile map
        if (command === "view") { setShared("hansol.view.at", Date.now()); setShared("hansol.view", shared("hansol.view") === "board" ? "office" : "board"); continue; }
        const list = this.items();
        const target = this.queue(list)[0] ?? list.find((a) => a.status === "working") ?? list[0];
        if (command === "chat-next" && target) {
          // In the office layout the conversation is the Office's side panel: ask it by "pick" (with the person).
          if (props()?.switch && shared("hansol.view") !== "board") setShared("hansol.pick", { state: target.status, id: target.id, at: Date.now() });
          else this.openChat(target);
        }
      }
    });
    cx.spawn(async (cx) => {
      await this.loadConfig();
      await this.load();
      cx.notify();
      this.refresh(cx);
      if (!this.feed.config) return;
      for (;;) {
        await watchFolder(this.feed.config.state_dir);
        if (await this.load()) cx.notify();
      }
    });
  }

  // The name an App agent has in Herdr's own Agents list (mods/agents): the row names its space; its detail is the tab
  // someone named, else the agent's own title; an automatic tab number says nothing. Two rows of one space read "space · detail".
  // ★96-3 the name a person gave (hc label display=...): first, on every screen (the left list, the right column, the floor's tags, the toasts).
  displayName(a, n) { const t = this.dispNow?.get(a?.address) ?? a?.labels?.display ?? n?.labels?.display; const s = typeof t === "string" ? t.trim() : ""; return s || null; }
  appName(n, all) {
    const clean = (t) => (t ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const detail = (x) => {
      const tab = spaces().flatMap((sp) => sp.tabs).find((tb) => tb.id === x.tab);
      if (!tab) return x.title || x.program?.name || "";
      const mine = panes().filter((p) => p.tab === tab.id && p.terminal);
      const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
      const prog = lead?.program?.name, liveT = clean(lead?.title);
      const telling = liveT && liveT !== prog && !/^[~/]|^[A-Za-z]:[\\/]/.test(liveT) && !liveT.includes("@") && liveT.toLowerCase() !== lead?.program?.key && !isGenericTitle(liveT, prog);
      return tab.name === prog && telling ? liveT : tab.name;
    };
    const d = detail(n), word = /^\d+$/.test(d) ? "" : d;
    // ★85-3: the agent's name is its own (a name someone gave, else the terminal's title = the work summary), never the room's name;
    // before any title: "Claude Code（Opus 5.5）"-like (the kind and the model)
    if (word) return word;
    const m = this.feed.state?.agents?.find((x) => x.address === n.address)?.model_label;
    return `${n.program?.name || n.address}${m ? `（${m}）` : ""}`;
  }

  // ★108: config.json is optional (a copy from the layout collection has none): what it leaves out is filled by config-defaults.js
  // (the scripts in the mod's py/ folder, python from PATH, the state file where the collector says it writes).
  async loadConfig() {
    let given = null;
    try { given = JSON.parse((await readTextFile(`${appHome()}/mods/hansol/config.json`)) ?? ""); } catch { given = null; }
    try {
      const probe = async (py, script) => { const r = await exec(py, [script, "--where"], { timeout: 20000 }); return r.code ? null : r.stdout; };
      const { config, problem } = await withDefaults(given, { appHomeDir: appHome(), homeDir: home(), probe });
      this.feed.error = problemText(problem, config.python);
      if (problem === "python") return; // nothing can run: the band says why
      this.feed.config = config; applyRoomTitles(config); applyColors(config); applyLaunchKinds(config);
    } catch (e) { this.feed.error = `설정을 읽을 수 없습니다: ${e}`; }
  }

  // Made-up agents (collector --demo -> state-demo.json): shared flag, else config.json "demo".
  demo() { return (shared("hansol.demo") ?? this.feed.config?.demo) === true; }

  // The data file follows the demo flag; on a switch, drop the old data and fetch the other file.
  syncMode(cx) {
    const demo = this.demo();
    if (this.feed.mode === demo) return;
    const first = this.feed.mode === undefined;
    this.feed.mode = demo;
    if (first && !demo) return;
    this.feed.text = null; this.feed.state = null;
    cx.spawn(async (cx) => { await this.load(); cx.notify(); this.refresh(cx); });
  }

  async load() {
    const c = this.feed.config;
    if (!c) return false;
    const text = await readTextFile(this.demo() ? `${c.state_dir}/state-demo.json` : c.state);
    if (!text || text === this.feed.text) return false;
    try {
      this.feed.state = JSON.parse(text); this.feed.text = text;
      if (props()?.role === "office") {
        const entries = (this.feed.state.agents ?? []).filter((a) => a.source === "app" && a.address);
        setShared("hansol.activities", Object.fromEntries(entries.map((a) => [a.address, { label: activityLabel(a), full: activityText(a), model: a.model_label || "" }])));
        try { this.rankWatch(); } catch {} // ★rank: the spaces' levels and the level-ups (rank.js)
      }
      return true;
    } catch { return false; }
  }

  refresh(cx) {
    const c = this.feed.config;
    if (!c || this.feed.busy) return;
    this.feed.busy = true;
    cx.spawn(async (cx) => {
      try {
        // Every copy reads what was written; only the band runs the collector. Before, each of the five copies started python (measured: 3 starts per run, ~0.5 s each,
        // two of them only to find the lock taken). Another copy runs it only when the file is left old (no band showing).
        const read = await this.load().catch(() => false), s = this.feed.state, age = s ? Date.now() - s.updated_at : Infinity, lead = props()?.role === "band";
        if (read) cx.notify();
        if (age < REFRESH_MS - 1500 || (!lead && age < 3 * REFRESH_MS)) return;
        try {
          const r = await exec(c.python, this.demo() ? [c.collector, "--demo", ...(Array.isArray(c.demo_args) ? c.demo_args.map(String) : [])] : [c.collector]);
          this.feed.error = r.code ? `데이터 수집 실패: ${(r.stderr || "").trim().split("\n").pop()}` : null;
        } catch (e) { this.feed.error = `데이터 수집을 시작할 수 없습니다: ${e}`; }
        if (await this.load().catch(() => false) || this.feed.error) cx.notify();
      } finally { this.feed.busy = false; }
    });
  }

  // The collector's view, with Herdr App agents' live status laid over it.
  items() {
    const list = (this.feed.state?.agents ?? []).map((a) => ({ ...a }));
    const live = this.demo() ? [] : agents();
    for (const n of live) { // demo: made-up agents only, no live overlay
      let a = list.find((x) => x.source === "app" && x.address === n.address);
      if (!a) {
        const named = n.tab_name && !/^\d+$/.test(n.tab_name);
        a = { id: `app:${n.address}`, source: "app", address: n.address, app: n.app,
              name: (named ? n.tab_name : n.title) || n.address, title: n.title, since: null, color: "#9aa3af" };
        list.push(a);
      }
      Object.assign(a, { status: n.status, title: n.title || a.title, space: n.space_name, tab: n.tab_name, program: n.program, live: true, pane: n.pane || null, // (★68-2: a pane to park before a move)
        name: this.displayName(a, n) ?? this.appName(n, live) }); // the same name as the Agents list shows; ★96-3 labels.display first
      const dn = this.dispNow?.get(a.address); if (dn && a.labels?.display === dn) this.dispNow.delete(a.address); // the collector has caught up
    }
    // Four states only: anything else (TUI "unknown") is idle, flagged with "?".
    // A child that reported (done) to a living parent is handed back: idle, not waiting at the counter.
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) {
      a.unknown = !STATE[a.status];
      if (a.unknown) a.status = "idle";
      a.handed_back = !!a.parent_id && ids.has(a.parent_id) && (a.status === "done" || (a.handed_back && a.status === "idle" && !a.live));
      if (a.handed_back) a.status = "idle";
    }
    const now = Date.now();
    const collected = new Map((this.feed.state?.agents ?? []).map((a) => [a.id, a]));
    for (const a of list) {
      const c = collected.get(a.id);
      if (!(c && c.status === a.status && c.since)) {
        const o = this.observed[a.id];
        if (!o || o.status !== a.status) this.observed[a.id] = { status: a.status, at: now };
        a.since = this.observed[a.id].at;
      }
      a.long_idle = a.status === "idle" && now - a.since >= LONG_IDLE_MS;
    }
    return list;
  }

  // Needs a person: blocked (oldest first), then done (newest first; not dropped by age).
  queue(list) {
    return [...list.filter((a) => a.status === "blocked").sort((a, b) => a.since - b.since),
      ...list.filter((a) => a.status === "done").sort((a, b) => b.since - a.since)];
  }

  openChat(a) {
    openOverlay({ mod: "hansol", kind: "window", key: "hansol-chat", width: 640, height: 660,
      props: { role: "chat", id: a.id, name: a.name, source: a.source, address: a.address, app: a.app,
               model: a.model_label, color: a.color } });
  }

  render(cx) {
    const role = props()?.role ?? "board";
    if (role === "terminal-window-head") return terminalWindowHead();
    if (role === "terminal-window-grip") return terminalWindowGrip();
    if (role === "terminal-window-edge") return terminalWindowEdge();
    if (role === "terminal-resize-surface") return terminalResizeSurface(this);
    if (role === "pane") return this.paneHeader();
    if (role === "chat") return this.chatView();
    if (role === "detail") return this.detailView();
    if (role === "pick-head") return this.pickHeadView(); // ★81 (chat.js)
    if (role === "rhead") return this.regionHeadView(); // ★103-3 (region.js)
    if (role === "inbox") return this.inboxView(); // ★106 ②
    if (role === "rchat") return this.chatBodyView();
    if (role === "rtree") return this.treeBodyView();
    if (role === "chat-body") return this.chatBodyView(); // ★84 (detail.js)
    if (role === "chat-approve") return this.approveBlockView(); // 13th D1: the approval card above the input (detail.js)
    if (role === "chat-input") return this.composerView(); // X1: the input under the conversation window (detail.js)
    if (role === "tree-body") return this.treeBodyView();
    if (role === "agent-menu") return this.agentMenuView();
    if (role === "confirm") return this.confirmView();
    if (role === "launch") return this.launchView();
    if (role === "tui-prompt") return this.tuiPromptView(); // ★74-3 (panel.js)
    if (role === "git-graph") return this.gitGraphView(); // 2026-11-21 (git-tree.js)
    if (role === "git-resize") return this.gitResizeView(); // the corner drag of a Git window
    if (role === "room-new") return this.roomNewView();
    if (role === "state-list") return this.stateListView(); // ★103-2 (2nd)
    if (role === "settings-menu") return this.settingsMenuView(); // 2026-11-19 layout choice
    this.syncMode(cx);
    const list = (() => { const raw = this.items(); try { return answeredView(raw, shared("hansol.apanswered")); } catch { return raw; } })(); // the band, the footer, the board and the floor count the same states (the floor applied this alone)
    if (role === "band") return this.band(list);
    if (role === "footer") return this.footer(list, cx); // ★105 (the status line under the office)
    // One layout, two views: "hansol.view" (set from the band) picks office or board.
    const view = role === "office" && shared("hansol.view") !== "board" ? "office" : "board";
    const t0 = Date.now(), switched = this.lastView !== undefined && this.lastView !== view;
    this.lastView = view;
    const inner = view === "office" ? this.office(list, cx) : this.isMosses() ? this.mzBoardView(list, cx) : this.board(list, cx); // 2026-11-27 MOSSES has its own board (mosses.js)
    { const ms = Date.now() - t0, r = (this.drawMs ??= { n: 0, sum: 0, max: 0 }); r.n++; r.sum += ms; r.max = Math.max(r.max, ms); r.last = ms; } // how long a floor/board draw takes (hansol.mosses:stat)
    if (switched) {
      this.noteSwitch(view, t0, cx);
    }
    return inner;
  }

  // How long a switch takes: pressed -> this view starts to draw (queue) -> built (render) -> on screen (next frame).
  noteSwitch(view, t0, cx) {
    const pressed = shared("hansol.view.at") ?? t0, built = Date.now();
    cx.timer.after(0, async () => {
      const row = { view, at: built, queue_ms: t0 - pressed, render_ms: built - t0, frame_ms: Date.now() - pressed, fade: !!FADE_MS };
      const path = `${appHome()}/hansol-office/switch-timing.json`;
      try {
        let prev = await readTextFile(path), obj = {};
        try { obj = JSON.parse(prev ?? "{}"); } catch {}
        (obj.switches ??= []).push(row); obj.switches = obj.switches.slice(-12);
        await writeTextFile(path, JSON.stringify(obj), prev);
      } catch {}
    });
  }

  // ------------------------------------------------------------- HUD band

  band(list) {
    const t = theme();
    const members = (k) => chipPeople(list, k);
    const count = (k) => members(k).length;
    const picked = shared("hansol.pick")?.state;
    // self-review-0505 #1: a narrow window (the App split in two) clipped the counts first. The band measures itself:
    // narrow (< 1500) drops the words beside the counts and the buttons' words; tight (< 1250; r81: the counts + the cleanup chip need ~350 px, which the 210 px usage bar and the wide switch left only above ~1220) also slims the usage bar and the view switch.
    const bw = this.bandW ?? 1920, narrow = bw < 1500, tight = bw < 1250;
    // Pressing a count writes "hansol.pick": Office selects that state's first person, Board lights the column.
    // ★103-2 (2nd): 1 person -> straight to them; 2+ -> a list under the chip (name, room, time in that state); pick one -> that person. Click outside / Esc closes (popup).
    if (this.isMosses()) return this.mzBand(list, { members, narrow, tight, states: [...STATES, SHELL_STATE], caret: (n) => (showCaret(n) ? CARET : ""), // 2026-11-26 the MOSSES band (mosses.js)
      sw: props()?.switch ? this.viewSwitch(t, tight) : null, win: props()?.buttons && herdrWindow().buttons ? this.windowButtons(t) : null });
    const pill = (st) => {
      const n = count(st.key), cur = shared("hansol.pick");
      const pos = picked === st.key && n > 1 ? chipPeople(members(st.key), st.key).findIndex((a) => a.id === cur?.id) + 1 : 0;
      const zero = n === 0; // ★104 U11: a count of 0 does nothing -> faint, no hand cursor, no hover
      const sel = picked === st.key && n > 0; // ★105 head: every chip has a frame (1.5px line); the chosen one a blue frame
      return h_flex().id(`pill-${st.key}`).flex_none().gap(7).px(11).h(UI.pill).items_center().rounded(RAD(10)).border(sel ? 2 : 1.5).border_color(sel ? P.blue : P.line).bg(P.paper)
        .when(sel, (el) => el.bg(st.wash)).when(zero, (el) => el.opacity(0.45)).when(!zero, (el) => el.cursor_pointer().hover((s) => s.bg(st.wash))) // #2: a count of 0 is never shown as chosen
        .on_mouse_down("left", (e) => { this.chipBox = e?.bounds ?? null; })
        .on_size_change((size) => { const w = Math.round(size?.width ?? 0), prev = shared("hansol.chipw") ?? {}; if (w > 0 && prev[st.key] !== w) setShared("hansol.chipw", { ...prev, [st.key]: w }); }) // 15th E3: each chip's real width (room.js adds them up for a command)
        .on_click((e) => this.pressChip(st, members(st.key), e))
        .child(st.key === "blocked" && n > 0 ? this.stateMark(st, 26).loop("opacity", { from: 0.55, to: 1, period: 700 }) : this.stateMark(st, 26)) // ★92 waiting approvals pulse in the band (a native loop, no redraw)
        .when(!narrow, (el) => el.child(div().text_size(UI.text.chip).font_weight(700).text_color(P.ink).child(st.label)))
        .child(st.key === "blocked" && n > 0 ? div().text_size(UI.text.count).font_weight(800).text_color(st.color).child(String(n)).loop("opacity", { from: 0.55, to: 1, period: 700 }) : div().text_size(UI.text.count).font_weight(800).text_color(st.color).child(String(n)))
        .when(pos > 0, (el) => el.child(div().text_size(UI.text.small).text_color("#a8a396").child(`${pos}/${n}`))) // ★104 V8: the "3/5" place is a faint figure (it is not the count)
        .when(showCaret(n), (el) => el.child(div().text_size(UI.text.small).text_color(P.muted).child(CARET))); // ★103 polish: 2+ people -> a press opens the list
    };
    const root = h_flex().id("hud-band").size_full().px(16).gap(12).items_center().bg(P.paper).rounded(RAD(14))
      .on_size_change((size, cx) => { const was = this.bandW ?? 1920, now = size?.width ?? was; this.bandW = now; if ((was < 1500) !== (now < 1500) || (was < 1250) !== (now < 1250)) cx.notify(); }) // redraw only when the step changes
      .border(1).border_color(P.line).text_color(P.ink)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().id("hansol-logo").relative().flex_none().w(tight ? 95 : 124).h(tight ? 20 : 26)
          .child(svg(`${ICON_DIR}/hansol.svg`).size_full())
          .child(div().absolute().left(0).top(0).w(tight ? 5.87 : 7.66).h(tight ? 6.94 : 9.02).bg("#0066b3"))
          .child(div().absolute().left(0).top(tight ? 12.35 : 16.06).w(tight ? 5.87 : 7.66).h(tight ? 7.19 : 9.34).bg("#00953b")))
        .when(this.demo(), (el) => el.child(badge("데모", STATE.blocked.color))))
      .child(div().w(1).h(26).bg(P.line).flex_none())
      .child(h_flex().flex_1().min_w(0).gap(2).items_center().children([...STATES, SHELL_STATE].map((st) => pill(st))))
      // ★103-2-1: no "add agent / terminal" on the band (which room?): starting is the left list's per-space ＋ only.
      .when(!!props()?.switch, (el) => el.child(this.viewSwitch(t, tight)))
      .child(div().id("hansol-chat-option").flex_none().px(10).h(32).flex().items_center().rounded(RAD(8))
        .border(1).border_color(P.line).text_size(UI.text.small).text_color(P.ink).cursor_pointer()
        .hover((s) => s.bg(P.hover)).tooltip("대화 탭 사용 여부")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared("hansol.chatEnabled", { on: shared("hansol.chatEnabled")?.on !== true }); cx.notify(); })
        .child(shared("hansol.chatEnabled")?.on === true ? "대화 켬" : "대화 끔"))
      .child(div().id("hansol-settings").flex_none().px(10).h(32).flex().items_center().rounded(RAD(8))
        .border(1).border_color(P.line).text_size(UI.text.small).text_color(P.ink).cursor_pointer()
        .hover((s) => s.bg(P.hover)).tooltip("레이아웃 선택 · Herdr 앱 설정")
        .on_mouse_down("left", (e, cx) => { this.setBox = e?.bounds ?? null; cx.stop_propagation(); })
        .on_click(() => this.openSettingsMenu()).child("설정"));
    if (props()?.buttons && herdrWindow().buttons) root.child(this.windowButtons(t));
    return div().size_full().px(10).py(6).bg("#101827").child(root);
  }

  // ★103-2 (2nd) a header count was pressed: 0 -> nothing; 1 -> that person; 2+ -> the list popup at the pointer.
  pressChip(st, list) {
    const xs = chipPeople(list, st.key), act = chipAction(xs.length);
    if (act === "none") return;
    if (st.key === "blocked" || st.key === "done") { this.inboxKey = st.key; return this.openInboxWin(); } // 14th D2: opens under the pressed chip (chipBox, read in room.js); ★106 ②: 承認待ち・報告あり open the inbox (cards with the answer buttons); 8th Y2: one window, its id kept (room.js)
    const go = (a) => setShared("hansol.pick", { state: st.key, id: a.id, at: Date.now() });
    if (act === "direct") return go(xs[0]);
    // 9th Z3: the rows are 40px (UI.row) but hold two lines (17 + 15px text), so the name and the room overlapped: CHIP_LIST.row (ui-rules.js) is tall enough for both and is the one number the draw and the popup height share.
    // The popup opens right under the pressed chip (its bounds from the mouse down); a command knows no pointer, so the chip's x is taken from the 1920px header (measured).
    const win = shared("hansol.win"), maxX = (win?.w ?? 1920) - CHIP_LIST.w - 8, b = this.chipBox;
    this.chipBox = null; // used once: a later command must not reuse an old press
    const x = b ? b.x : chipLeft(st.key, shared("hansol.chipw")), y = b ? b.y + b.height + 6 : 64; // 15th E3: a command uses the measured chip widths
    // 10th A4: the same chip pressed / sent again closes its list; another chip replaces it (one list at a time, never a second one)
    if (shared("hansol.pops")?.chip?.key === st.key) { this.popClose("chip"); return; }
    const groups = st.key === "working" ? new Set(xs.map((a) => a.space || ROOM[a.source]?.title || "기타")).size : 0;
    this.popOpen("chip", st.key, { mod: "hansol", kind: "popup", width: CHIP_LIST.w, height: Math.min((win?.h ?? 900) - 80, chipListHeight(xs.length) + groups * 25),
      at: { x: Math.max(8, Math.round(Math.min(x, maxX))), y: Math.round(y) },
      props: { role: "state-list", state: st.key, people: xs.map((a) => ({ id: a.id, status: a.status, name: a.name || a.address || "", room: a.space || ROOM[a.source]?.title || "", since: a.since })) } });
  }

  // 2026-11-19 the header's "설정": a small menu under the button (layout: office / guild hall, and the App's own settings). Pressed again = closes.
  openSettingsMenu() {
    if (shared("hansol.pops")?.settings) { this.popClose("settings"); return; }
    const win = shared("hansol.win"), b = this.setBox, w = SETTINGS_MENU.w;
    this.setBox = null;
    const x = b ? b.x + b.width - w : (win?.w ?? 1920) - w - 8, y = b ? b.y + b.height + 6 : 64;
    this.popOpen("settings", "settings", { mod: "hansol", kind: "popup", width: w, height: SETTINGS_MENU.h, at: { x: Math.max(8, Math.round(x)), y: Math.round(y) }, props: { role: "settings-menu" } });
  }

  // Popup body (role "settings-menu").
  settingsMenuView() {
    const p = props(), cur = this.layoutName();
    const row = (id, label, sub, on, press) => h_flex().id(id).w_full().flex_none().h(SETTINGS_MENU.row).px(10).gap(10).items_center().rounded(RAD(8)).cursor_pointer()
      .hover((s) => s.bg(P.raised)).on_click(() => { press(); closeOverlay(p.overlay); })
      .child(div().flex_none().w(16).child(on ? icon("check", 16, P.blue) : div()))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(UI.text.body).font_weight(on ? 700 : 400).text_color(P.ink).child(label))
        .when(!!sub, (el) => el.child(div().truncate().text_size(UI.text.small).text_color(P.muted).child(sub))));
    return v_flex().id("settings-menu").size_full().p(8).gap(2).bg(P.paper)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(div().flex_none().h(25).px(10).flex().items_center().text_size(UI.text.small).font_weight(700).text_color(P.muted).child("레이아웃"))
      .child(row("layout-guild", "모험가 길드 회관 (기본)", null, cur === GUILD, () => this.setLayout(GUILD)))
      .child(row("layout-meadow", "꽃마을 광장", null, cur === MEADOW, () => this.setLayout(MEADOW)))
      .child(row("layout-office", "오피스", null, cur === "office", () => this.setLayout("office")))
      .child(row("layout-mosses", "모세스", "궤도 관제 콘솔 · 시스템 = 작업 공간", cur === MOSSES, () => this.setLayout(MOSSES)))
      .child(div().flex_none().h(1).my(4).bg(P.line))
      .child(row("app-settings", "Herdr 앱 설정 열기", null, false, () => run("app.settings")));
  }

  // Popup body (role "state-list"): one row per person (state mark, name, room, how long in this state); a row picks that person and closes.
  stateListView() {
    const p = props(), st = STATE[p.state], people = Array.isArray(p.people) ? p.people : [];
    const grouped = p.state === "working";
    const groups = new Map();
    for (const a of people) { const key = a.room || "기타"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(a); }
    const rows = grouped ? [...groups].flatMap(([name, members]) => [{ heading: name }, ...members]) : people;
    return v_flex().id("state-list").size_full().p(CHIP_LIST.pad).gap(0).bg(P.paper).overflow_y_scrollbar()
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .children(rows.map((a) => a.heading ? div().flex_none().h(25).px(8).flex().items_center().text_size(UI.text.small).font_weight(700).text_color(P.muted).child(a.heading) : h_flex().id(`sl-${a.id}`).w_full().flex_none().h(CHIP_LIST.row).px(8).gap(8).items_center().rounded(RAD(8)).cursor_pointer()
        .hover((s) => s.bg(st?.wash ?? P.raised))
        .on_click(() => { setShared("hansol.pick", { state: p.state, id: a.id, at: Date.now() }); closeOverlay(p.overlay); })
        .child(st ? this.stateMark(st, 22) : dot(STATE[a.status]?.color ?? P.muted, 10))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(UI.text.body).font_weight(700).text_color(P.ink).child(clipName(a.name, NAME_EM_FULL)))
          .when(!!a.room && !grouped, (el) => el.child(div().truncate().text_size(UI.text.small).text_color(P.muted).child(a.room))))
        .child(div().flex_none().text_size(UI.text.small).font_weight(700).text_color(st?.color ?? P.muted).child(a.since ? ago(a.since) : ""))));
  }

  // Office / Board in one layout: sets shared "hansol.view" ("office" is the default).
  viewSwitch(t, tight = false) {
    const view = shared("hansol.view") === "board" ? "board" : "office";
    // ★105-3 (3rd): line pictures (icons/office.svg・board.svg) instead of the ▦ ☰ glyphs
    const seg = (key, label) => div().id(`view-${key}`).flex_none().px(14).h(UI.seg).flex().items_center().gap(6).rounded(RAD(8))
      .text_size(UI.text.body).cursor_pointer().when(view === key, (el) => el.bg(P.solid).font_weight(700).text_color("#ffffff"))
      .when(view !== key, (el) => el.text_color(P.muted).hover((s) => s.bg(P.hover)))
      .on_click(() => { setShared("hansol.view.at", Date.now()); setShared("hansol.view", key); })
      .child(icon(key === "office" ? "office" : "board", 18, view === key ? "#ffffff" : P.muted))
      .when(!tight, (el) => el.child(label));
    return h_flex().flex_none().gap(2).p(2).rounded(RAD(10)).border(1).border_color(P.line).bg(P.paper)
      .child(seg("office", "오피스")).child(seg("board", "보드"));
  }

  // ★105 footer (one line, 40px): left = people / spaces / last refresh, right = the legend (the four states; moved here from the left list's bottom box).
  footer(list, cx) {
    try { // the window's size for the popups placed from another copy (feed.js winSize)
      const vp = globalThis.window?.viewport_size?.();
      if (vp?.height > 200) { const w = shared("hansol.win"), nw = Math.round(vp.width), nh = Math.round(vp.height); if (w?.w !== nw || w?.h !== nh) setShared("hansol.win", { w: nw, h: nh }); }
    } catch {}
    const n = list.length, sp = new Set(list.map((a) => a.space).filter(Boolean)), spN = Math.max(sp.size, spaces().length);
    const at = this.feed.state?.updated_at, fresh = at ? ago(at) : "—";
    if (this.isMosses()) return this.mzFooter(n, spN, fresh); // 2026-11-26 the MOSSES status line (mosses.js)
    const fact = (ic, num, unit) => h_flex().flex_none().gap(6).items_center().child(icon(ic, 18, "#aebed2"))
      .child(div().text_size(UI.text.strong).font_weight(700).text_color(P.ink).child(String(num))).child(div().text_size(UI.text.small).text_color(P.ink).child(unit));
    return h_flex().id("hud-footer").size_full().px(18).gap(22).items_center().bg("#151e2e").border_t(1).border_color("#344256").text_color(P.ink)
      .child(fact("chat", n, "에이전트")).child(fact("folder", spN, "공간"))
      .child(h_flex().flex_none().gap(6).items_center().child(icon("refresh", 16, P.muted)).child(div().text_size(UI.text.small).text_color(P.muted).child(`최근 갱신 ${fresh}`)))
      .child(div().flex_1())
      .child(div().flex_none().text_size(UI.text.small).font_weight(700).text_color(P.muted).child("범례:"))
      .children([...STATES, SHELL_STATE].map((st) => h_flex().id(`fl-${st.key}`).flex_none().gap(6).items_center().child(this.stateMark(st, 16)).child(div().text_size(UI.text.small).text_color(P.ink).child(st.key === "blocked" ? "승인 대기 (확인 필요)" : st.label))));
  }

  windowButtons(t) {
    const b = (id, name, cmd) => div().id(id).w(40).h(UI.hit).flex().items_center().justify_center().rounded(RAD(5))
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run(cmd)).child(icon(name, 18, P.ink)); // ★105-3 (3rd): line pictures (icons/minimize・maximize・x.svg)
    return h_flex().flex_none().gap(2).child(b("w-min", "minimize", "window.minimize"))
      .child(b("w-max", "maximize", "window.maximize")).child(b("w-close", "x", "window.close"));
  }

  // ------------------------------------------------------------- Board

  board(list, cx) {
    const COLS = [...STATES, SHELL_STATE]; // the band's five states, counted the same way (chipPeople): a shell-waiting agent is not also in 作業中
    setAgentOrder(COLS.flatMap((st) => chipPeople(list, st.key).filter((a) => a.source === "app").map((a) => a.address)));
    this.loadRemembered?.(cx); // the last floor plan holds the people's pictures (faces)
    this.ensureScene?.(list, cx); // a person who is not in it yet gets drawn, so every card has a face
    const root = div().id("hud-board").relative().size_full().overflow_hidden().bg(P.paper)
      .on_size_change((size, cx) => { this.boardSize = size; cx.notify(); });
    const cols = h_flex().absolute().left(0).top(0).size_full().px(18).pt(14).pb(40).gap(14).children(COLS.map((st) => {
      const cards = chipPeople(list, st.key).sort((a, b) => st.key === "blocked" ? a.since - b.since : ((!!a.long_idle - !!b.long_idle) || (b.since - a.since)));
      const picked = shared("hansol.pick")?.state === st.key;
      return v_flex().flex_1().min_w(0).h_full().gap(8).p(8).rounded(RAD(14)).bg(st.wash)
        .when(picked, (el) => el.border(2).border_color(st.color))
        .child(h_flex().h(34).flex_none().items_center().gap(8).px(4)
          .child(this.stateMark(st, 24)).child(div().text_size(18).font_weight(800).text_color(P.ink).child(st.label))
          .child(div().min_w(22).h(22).px(6).rounded(11).bg(st.color).flex().items_center().justify_center()
            .text_size(12).font_weight(800).text_color("#ffffff").child(String(cards.length))))
        .child(v_flex().id(`col-${st.key}`).flex_1().min_h(0).overflow_y_scrollbar().gap(8)
          .children(cards.map((a) => this.card(a, st, list))));
    }));
    root.child(cols);
    return root.child(h_flex().absolute().left(0).bottom(0).w_full().h(30).px(18).gap(12).items_center().bg("#1F2A37e6")
      .text_size(11).text_color("#ffffff").child(dot(STATE.done.color, 8)).child(div().child(this.demo() ? "데모 화면" : "로컬 연결됨"))
      .child(div().text_color(STATE.idle.color).child("｜")).child(div().child(`세션 ${list.length}개`)));
  }

  card(a, st, list = []) {
    const parX = a.parent_id ? list.find((x) => x.id === a.parent_id) : null;
    const par = parX && (parX.name || parX.address) ? parX : null;
    const kidsN = list.filter((x) => x.parent_id === a.id).length;
    const tail = a.cwd ? String(a.cwd).split(/[\\/]/).filter(Boolean).pop() : null;
    const where = [ROOM[a.source]?.title ?? a.source, [a.space, a.tab].filter(Boolean).join(" / ") || tail].filter(Boolean).join(" · ");
    const act = a.status === "blocked" ? "확인" : a.status === "done" ? "보고 보기" : null;
    const line = a.status === "blocked" ? blockedText(a) : (a.name || a.title || a.address);
    return v_flex().id(`card-${a.id}`).w_full().flex_none().p(10).gap(8).rounded(RAD(12)).bg("#ffffff").border(1).border_color(P.line)
      .cursor_pointer().hover((s) => s.border_color(st.color)).on_click((_e, cx) => { if (a.source === "app" && a.address && !this.demo()) this.select(a, cx); else this.openChat(a); }) // the same as a click on the person in the office (office.js select: the real terminal window)
      .when(!!a.long_idle, (el) => el.opacity(0.7))
      .child(h_flex().gap(10).items_start()
        .child(this.face(a, 52))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(6).items_center().child(platformIcon(a, 16))
            .child(div().flex_1().min_w(0).truncate().text_size(14).font_weight(700).text_color(P.ink).child(platform(a).name))
            .child(h_flex().flex_none().gap(4).items_center().px(6).py(2).rounded(RAD(7)).bg(P.hover).text_size(10).text_color(P.ink)
              .child(chip(a.color ?? P.muted, 7)).child(div().child(a.model_label ?? "모델 미확인"))))
          .child(div().text_size(12).font_weight(600).text_color(P.ink).child(line))
          .child(div().text_size(10).text_color(P.muted).child(where))
          .when(!!par || kidsN > 0, (el) => el.child(h_flex().gap(4).items_center().flex_none().px(6).py(2).rounded(RAD(7)).bg(STATE.working.wash)
            .text_size(10).text_color(P.blue).child(div().truncate().child(par ? `리더: ${par.name || par.address}` : `작업자 ${kidsN}명`))))))
      .child(h_flex().gap(8).items_center()
        .child(this.stateMark(st, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(700).text_color(st.color).child(`${hasMem(a) ? `메모리 ${fmtMem(a.mem_bytes)} · ` : ""}${st.label}${a.unknown ? "?" : ""} ${ago(a.since)}`))
        .when(!!act, (el) => el.child(div().flex_none().px(10).py(4).rounded(RAD(8)).bg(P.solid).text_size(11).font_weight(700).text_color("#ffffff").child(act))));
  }

  // ------------------------------------------------------------- pane header

  paneHeader() {
    const p = panes().find((x) => x.pane === props().pane);
    const st = STATE[p?.status];
    const icon = p?.program?.icon ? (p.program.tint ? svg(p.program.icon).text_color(P.ink) : image(p.program.icon)).size(14).flex_none()
      : div().size(14).rounded(4).bg("#7465db");
    return h_flex().size_full().px(12).items_center().gap(7).bg(P.paper).border_b(1).border_color(P.line)
      .child(icon).child(div().text_size(11).text_color(P.ink).child(p?.program?.name ?? "Terminal"))
      .child(div().flex_1()).when(!!st, (el) => el.child(div().text_size(10).text_color(st.color).child(st.label)))
      .child(dot(st?.color ?? P.muted, 6));
  }
}

// Office and chat live in their own files; their methods join the class here.
for (const part of [OfficePart, MossesPart, ChatPart, DetailPart, GridPart, LaunchPart, RoomPart, MeetPart, PanelPart, RegionPart, FeedPart, GitPart, GitWorkPart, RankPart])
  for (const k of Object.getOwnPropertyNames(part.prototype))
    if (k !== "constructor") AgentHud.prototype[k] = part.prototype[k];

export default AgentHud;
