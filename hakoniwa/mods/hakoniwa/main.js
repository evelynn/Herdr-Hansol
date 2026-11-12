// hakoniwa: every coding agent on this PC (T3 Code, Herdr App, herdr TUI) in one view.
// Roles (props().role): "band" (HUD strip), "board" (kanban), "office" (pixel-art office),
// "chat" (conversation window, opened by a click), "pane" (pane header).
// Data: hakoniwa-collector.py writes state.json; this mod runs it every few seconds
// (pythonw, no console) and redraws when the file changes. Herdr App agents take their
// live status from agents(), so they update at once.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, closeOverlay, exec, home, nextCommand, openOverlay, panes, props, readTextFile, run,
  setAgentOrder, setShared, spaces, shared, theme, watchFolder, window as herdrWindow, writeTextFile } from "herdr"; // 13th: herdr's `window` is the title-bar function; the gpui `window` (viewport_size) is globalThis.window — never import it bare
import { usageParts, stateMatches, usageAge } from "./life.js";
import { isGenericTitle, applyLaunchKinds } from "./actions.js";
import { withDefaults, problemText } from "./config-defaults.js";
import { STATES, STATE, SHELL_STATE, LONG_IDLE_MS, ROOM, REFRESH_MS, P, dot, chip, badge, clock, ago, platform, platformIcon, blockedText, applyRoomTitles, applyColors, fmtMem, hasMem, cleanupIds, CHIP_X, chipLeft, activityLabel } from "./common.js";
import { ICON_DIR, icon } from "./icons.js";
import { UI, LOGO_W, LOGO_H, LOGO_HEAD, CARET, showCaret, chipPeople, chipAction, chipListHeight, CHIP_LIST, clipName, NAME_EM_FULL } from "./ui-rules.js";
import { OfficePart } from "./office.js";
import { terminalWindowHead, terminalWindowGrip, terminalResizeSurface } from "./terminal-window.js";
import { ChatPart } from "./chat.js";
import { RegionPart } from "./region.js";
import { DetailPart } from "./detail.js";
import { GridPart } from "./grid.js";
import { LaunchPart } from "./launch.js";
import { RemotePart } from "./remote.js";
import { RoomPart } from "./room.js";
import { MeetPart } from "./meet.js";
import { PanelPart } from "./panel.js";
import { FeedPart } from "./feed.js";
import { fmtTokens } from "./feed-rules.js";

const FADE_MS = 0; // no fade: a fade from 0 shows the empty beige ground for ~100 ms (reviews 5); the switch is immediate

class AgentHud extends View {
  async close() { try { this.popGone?.(); } catch {} } // 10th A4: a popup that goes by itself (Esc, a click outside) drops its id from shared "hakoniwa.pops" (feed.js)
  init(_p, cx) {
    this.feed = { state: null, text: null, config: null, busy: false, error: null };
    this.observed = {};
    this.size = { width: 1200, height: 600 };
    const role = props()?.role ?? "board";
    if (role === "office") setShared("hakoniwa.terminalWindows", {});
    if (role === "pane" || role === "usage" || role === "confirm" || role === "move" || role === "pick-head" || role === "state-list" || role === "feed") return;
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
    if (role === "terminal-window-head" || role === "terminal-window-grip" || role === "terminal-resize-surface") return;
    if (role === "chat" || role === "chat-body" || role === "chat-input" || role === "chat-approve") return this.initChat(cx);
    if (role === "agent-menu") return;
    if (role === "tui-prompt") return this.initTuiPrompt(cx); // ★74-3 (panel.js)
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    if (role === "band") { cx.spawn(async (cx2) => { try { if (await this.remotePoll()) cx2.notify(); } catch {} }); cx.timer.every(3000, (cx2) => cx2.spawn(async (cx3) => { try { if (await this.remotePoll()) cx3.notify(); } catch {} })); } // the "원격" button (remote.js)
    if (role !== "band") cx.timer.every(30000, (cx) => cx.notify());
    // "hakoniwa.chat-next" (keys.json or herdr-app do): the conversation of whoever needs you first.
    // "hakoniwa.demo": switch the made-up agents on / off (shared "hakoniwa.demo").
    if (role === "band") cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (await this.reviewCommand(command)) continue; // ★61-1 select / plate / stop / launch[:target] (room.js): review pictures without clicks
        if (command === "demo") { setShared("hakoniwa.demo", !this.demo()); continue; }
        if (command === "close") { this.popCloseAll(); setShared("hakoniwa.close", { at: Date.now() }); if (shared("hakoniwa.inboxOpen")?.on) setShared("hakoniwa.inboxOpen", { on: false, at: Date.now() }); this.closeInboxWin?.(); continue; } // closes the side panel (and the inbox window: 8th Y2) (for the review pictures)
        if (command === "popclose") { this.popCloseAll(); if (shared("hakoniwa.inboxOpen")?.on) setShared("hakoniwa.inboxOpen", { on: false, at: Date.now() }); this.closeInboxWin?.(); continue; } // 33b U4 (27-U4, review): closes only the inbox window and the popups (feed / usage / chip); the right window stays (hakoniwa.close closes it too)
        if (command === "convback") { setShared("hakoniwa.convback", { at: Date.now() }); continue; } // 21st I5 (review): the same as a press on 「↑ 前の発言を読む」 in the right window (detail.js watches the stamp)
        if (command === "hour") { const seq = [8, 12, 17, 22, null], cur = shared("hakoniwa.hour"), i = seq.indexOf(typeof cur === "number" ? cur : null); setShared("hakoniwa.hour", seq[(i + 1) % seq.length]); continue; } // review: morning, noon, evening, night, real time
        if (command === "launch") { this.openLaunch(this.items().find((a) => a.id === shared("hakoniwa.sel")) ?? null); continue; } // ★27-1 (review pictures): opens the input dialog; nothing is started by it
        if (command === "end") { const t = this.items().find((a) => a.id === shared("hakoniwa.sel") && a.source === "app"); if (t) this.askEnd(t, this.items()); continue; } // opens the confirm dialog only (nothing is ended until "はい")
        if (command === "remote") { await this.remoteToggle({ notify() {} }); continue; } // the "원격" button without a click (remote.js); no cx here, the 3 s poll redraws
        if (command === "bird") { setShared("hakoniwa.bird", Date.now()); continue; }
        if (command === "weather") { const seq = ["clear", "partly", "cloudy", "fog", "rain", "snow", "thunder", null], cur = shared("hakoniwa.weather"), i = seq.indexOf(typeof cur === "string" ? cur : null); setShared("hakoniwa.weather", seq[(i + 1) % seq.length]); continue; } // review: step through the 7 kinds, then the real weather
        if (String(command).split(":")[0] === "legend") { const a = String(command).split(":")[1], cur = shared("hakoniwa.legend")?.fold; setShared("hakoniwa.legend", { fold: a === "fold" ? true : a === "open" ? false : !cur, at: Date.now() }); continue; } // review: hakoniwa.legend:fold / :open (no arg: the other one) folds or opens the legend without a click
        if (command === "zoom") { const seq = [1.25, 4 / 3, 1.6, 2, "fit"], cur = shared("hakoniwa.zoom")?.z, i = seq.indexOf(cur ?? "fit"); setShared("hakoniwa.zoom", { z: seq[(i + 1) % seq.length], at: Date.now() }); continue; } // ★62-2 review: the zoom steps 1.25, 1.33, 1.6, 2, then 全体を表示 (for the pictures of the seams; no wheel)
        if (command === "grid") { setShared("hakoniwa.grid", shared("hakoniwa.grid") !== true); continue; } // show the tile map
        if (command === "view") { setShared("hakoniwa.view.at", Date.now()); setShared("hakoniwa.view", shared("hakoniwa.view") === "board" ? "office" : "board"); continue; }
        const list = this.items();
        const target = this.queue(list)[0] ?? list.find((a) => a.status === "working") ?? list[0];
        if (command === "chat-next" && target) {
          // In the office layout the conversation is the Office's side panel: ask it by "pick" (with the person).
          if (props()?.switch && shared("hakoniwa.view") !== "board") setShared("hakoniwa.pick", { state: target.status, id: target.id, at: Date.now() });
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
    try { given = JSON.parse((await readTextFile(`${appHome()}/mods/hakoniwa/config.json`)) ?? ""); } catch { given = null; }
    try {
      const probe = async (py, script) => { const r = await exec(py, [script, "--where"], { timeout: 20000 }); return r.code ? null : r.stdout; };
      const { config, problem } = await withDefaults(given, { appHomeDir: appHome(), homeDir: home(), probe });
      this.feed.error = problemText(problem, config.python);
      if (problem === "python") return; // nothing can run: the band says why
      this.feed.config = config; applyRoomTitles(config); applyColors(config); applyLaunchKinds(config);
    } catch (e) { this.feed.error = `설정을 읽을 수 없습니다: ${e}`; }
  }

  // Made-up agents (collector --demo -> state-demo.json): shared flag, else config.json "demo".
  demo() { return (shared("hakoniwa.demo") ?? this.feed.config?.demo) === true; }

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
        setShared("hakoniwa.activities", Object.fromEntries(entries.map((a) => [a.address, { label: activityLabel(a), model: a.model_label || "" }])));
      }
      return true;
    } catch { return false; }
  }

  refresh(cx) {
    const c = this.feed.config, s = this.feed.state;
    if (!c || this.feed.busy) return;
    if (s && Date.now() - s.updated_at < REFRESH_MS - 1500) return; // another copy just ran it
    this.feed.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(c.python, this.demo() ? [c.collector, "--demo", ...(Array.isArray(c.demo_args) ? c.demo_args.map(String) : [])] : [c.collector]);
        this.feed.error = r.code ? `데이터 수집 실패: ${(r.stderr || "").trim().split("\n").pop()}` : null;
      } catch (e) { this.feed.error = `데이터 수집을 시작할 수 없습니다: ${e}`; }
      this.feed.busy = false;
      if (await this.load() || this.feed.error) cx.notify();
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
    openOverlay({ mod: "hakoniwa", kind: "window", key: "hakoniwa-chat", width: 640, height: 660,
      props: { role: "chat", id: a.id, name: a.name, source: a.source, address: a.address, app: a.app,
               model: a.model_label, color: a.color } });
  }

  render(cx) {
    const role = props()?.role ?? "board";
    if (role === "terminal-window-head") return terminalWindowHead();
    if (role === "terminal-window-grip") return terminalWindowGrip();
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
    if (role === "room-new") return this.roomNewView();
    if (role === "usage") return this.usageView();
    if (role === "state-list") return this.stateListView(); // ★103-2 (2nd)
    if (role === "feed") return this.feedView(cx); // ★106 recent moves (feed.js)
    this.syncMode(cx);
    const list = this.items();
    if (role === "band") return this.band(list);
    if (role === "footer") return this.footer(list, cx); // ★105 (the status line under the office)
    // One layout, two views: "hakoniwa.view" (set from the band) picks office or board.
    const view = role === "office" && shared("hakoniwa.view") !== "board" ? "office" : "board";
    const t0 = Date.now(), switched = this.lastView !== undefined && this.lastView !== view;
    this.lastView = view;
    const inner = view === "office" ? this.office(list, cx) : this.board(list, cx);
    if (switched) {
      this.noteSwitch(view, t0, cx);
    }
    return inner;
  }

  // How long a switch takes: pressed -> this view starts to draw (queue) -> built (render) -> on screen (next frame).
  noteSwitch(view, t0, cx) {
    const pressed = shared("hakoniwa.view.at") ?? t0, built = Date.now();
    cx.timer.after(0, async () => {
      const row = { view, at: built, queue_ms: t0 - pressed, render_ms: built - t0, frame_ms: Date.now() - pressed, fade: !!FADE_MS };
      const path = `${appHome()}/hakoniwa-office/switch-timing.json`;
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
    const picked = shared("hakoniwa.pick")?.state;
    // self-review-0505 #1: a narrow window (the App split in two) clipped the counts first. The band measures itself:
    // narrow (< 1500) drops the words beside the counts and the buttons' words; tight (< 1250; r81: the counts + the cleanup chip need ~350 px, which the 210 px usage bar and the wide switch left only above ~1220) also slims the usage bar and the view switch.
    const bw = this.bandW ?? 1920, narrow = bw < 1500, tight = bw < 1250;
    // Pressing a count writes "hakoniwa.pick": Office selects that state's first person, Board lights the column.
    // ★103-2 (2nd): 1 person -> straight to them; 2+ -> a list under the chip (name, room, time in that state); pick one -> that person. Click outside / Esc closes (popup).
    const pill = (st) => {
      const n = count(st.key), cur = shared("hakoniwa.pick");
      const pos = picked === st.key && n > 1 ? chipPeople(members(st.key), st.key).findIndex((a) => a.id === cur?.id) + 1 : 0;
      const zero = n === 0; // ★104 U11: a count of 0 does nothing -> faint, no hand cursor, no hover
      const sel = picked === st.key && n > 0; // ★105 head: every chip has a frame (1.5px line); the chosen one a blue frame
      return h_flex().id(`pill-${st.key}`).flex_none().gap(7).px(11).h(UI.pill).items_center().rounded(10).border(sel ? 2 : 1.5).border_color(sel ? P.blue : P.line).bg("#1b2637")
        .when(sel, (el) => el.bg(st.wash)).when(zero, (el) => el.opacity(0.45)).when(!zero, (el) => el.cursor_pointer().hover((s) => s.bg(st.wash))) // #2: a count of 0 is never shown as chosen
        .on_mouse_down("left", (e) => { this.chipBox = e?.bounds ?? null; })
        .on_size_change((size) => { const w = Math.round(size?.width ?? 0), prev = shared("hakoniwa.chipw") ?? {}; if (w > 0 && prev[st.key] !== w) setShared("hakoniwa.chipw", { ...prev, [st.key]: w }); }) // 15th E3: each chip's real width (room.js adds them up for a command)
        .on_click((e) => this.pressChip(st, members(st.key), e))
        .child(st.key === "blocked" && n > 0 ? this.stateMark(st, 26).loop("opacity", { from: 0.55, to: 1, period: 700 }) : this.stateMark(st, 26)) // ★92 waiting approvals pulse in the band (a native loop, no redraw)
        .when(!narrow, (el) => el.child(div().text_size(UI.text.chip).font_weight(700).text_color(P.ink).child(st.label)))
        .child(st.key === "blocked" && n > 0 ? div().text_size(UI.text.count).font_weight(800).text_color(st.color).child(String(n)).loop("opacity", { from: 0.55, to: 1, period: 700 }) : div().text_size(UI.text.count).font_weight(800).text_color(st.color).child(String(n)))
        .when(pos > 0, (el) => el.child(div().text_size(UI.text.small).text_color("#a8a396").child(`${pos}/${n}`))) // ★104 V8: the "3/5" place is a faint figure (it is not the count)
        .when(showCaret(n), (el) => el.child(div().text_size(UI.text.small).text_color(P.muted).child(CARET))); // ★103 polish: 2+ people -> a press opens the list
    };
    const claude = list.some((a) => platform(a).name === "Claude Code");
    const root = h_flex().id("hud-band").size_full().px(16).gap(12).items_center().bg("#1b2637").rounded(14)
      .on_size_change((size, cx) => { const was = this.bandW ?? 1920, now = size?.width ?? was; this.bandW = now; if ((was < 1500) !== (now < 1500) || (was < 1250) !== (now < 1250)) cx.notify(); }) // redraw only when the step changes
      .border(1).border_color(P.line).text_color(P.ink)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().id("hansol-logo").relative().flex_none().w(tight ? 95 : 124).h(tight ? 20 : 26)
          .child(svg(`${ICON_DIR}/hansol.svg`).size_full())
          .child(div().absolute().left(0).top(0).w(tight ? 5.87 : 7.66).h(tight ? 6.94 : 9.02).bg("#0066b3"))
          .child(div().absolute().left(0).top(tight ? 12.35 : 16.06).w(tight ? 5.87 : 7.66).h(tight ? 7.19 : 9.34).bg("#00953b")))
        .when(this.demo(), (el) => el.child(badge("데모", STATE.blocked.color))))
      .child(div().w(1).h(26).bg(P.line).flex_none())
      .child(h_flex().flex_1().min_w(0).gap(2).items_center().children([...STATES, SHELL_STATE].map((st) => pill(st)))
        .when(this.cleanupN() > 0, (el) => el.child(this.cleanupPill(narrow))))
      // ★103-2-1: no "add agent / terminal" on the band (which room?): starting is the left list's per-space ＋ only.
      .when(!!props()?.switch, (el) => el.child(this.viewSwitch(t, tight)))
      .when(claude, (el) => el.child(this.usage(t, tight)))
      .child(this.usageButton(t))
      .child(div().id("hakoniwa-chat-option").flex_none().px(10).h(32).flex().items_center().rounded(8)
        .border(1).border_color(P.line).text_size(UI.text.small).text_color(P.ink).cursor_pointer()
        .hover((s) => s.bg("#253449")).tooltip("대화 탭 사용 여부")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared("hakoniwa.chatEnabled", { on: shared("hakoniwa.chatEnabled")?.on !== true }); cx.notify(); })
        .child(shared("hakoniwa.chatEnabled")?.on === true ? "대화 켬" : "대화 끔"))
      .child(this.remoteButton())
      .child(div().id("hakoniwa-settings").flex_none().px(10).h(32).flex().items_center().rounded(8)
        .border(1).border_color(P.line).text_size(UI.text.small).text_color(P.ink).cursor_pointer()
        .hover((s) => s.bg("#253449")).tooltip("Herdr 설정")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("app.settings")).child("설정"));
    if (props()?.buttons && herdrWindow().buttons) root.child(this.windowButtons(t));
    return div().size_full().px(10).py(6).bg("#101827").child(root);
  }

  // ★103-2 (2nd) a header count was pressed: 0 -> nothing; 1 -> that person; 2+ -> the list popup at the pointer.
  pressChip(st, list) {
    const xs = chipPeople(list, st.key), act = chipAction(xs.length);
    if (act === "none") return;
    if (st.key === "blocked" || st.key === "done") { this.inboxKey = st.key; return this.openInboxWin(); } // 14th D2: opens under the pressed chip (chipBox, read in room.js); ★106 ②: 承認待ち・報告あり open the inbox (cards with the answer buttons); 8th Y2: one window, its id kept (room.js)
    const go = (a) => setShared("hakoniwa.pick", { state: st.key, id: a.id, at: Date.now() });
    if (act === "direct") return go(xs[0]);
    // 9th Z3: the rows are 40px (UI.row) but hold two lines (17 + 15px text), so the name and the room overlapped: CHIP_LIST.row (ui-rules.js) is tall enough for both and is the one number the draw and the popup height share.
    // The popup opens right under the pressed chip (its bounds from the mouse down); a command knows no pointer, so the chip's x is taken from the 1920px header (measured).
    const win = shared("hakoniwa.win"), maxX = (win?.w ?? 1920) - CHIP_LIST.w - 8, b = this.chipBox;
    this.chipBox = null; // used once: a later command must not reuse an old press
    const x = b ? b.x : chipLeft(st.key, shared("hakoniwa.chipw")), y = b ? b.y + b.height + 6 : 64; // 15th E3: a command uses the measured chip widths
    // 10th A4: the same chip pressed / sent again closes its list; another chip replaces it (one list at a time, never a second one)
    if (shared("hakoniwa.pops")?.chip?.key === st.key) { this.popClose("chip"); return; }
    const groups = st.key === "working" ? new Set(xs.map((a) => a.space || ROOM[a.source]?.title || "기타")).size : 0;
    this.popOpen("chip", st.key, { mod: "hakoniwa", kind: "popup", width: CHIP_LIST.w, height: Math.min((win?.h ?? 900) - 80, chipListHeight(xs.length) + groups * 25),
      at: { x: Math.max(8, Math.round(Math.min(x, maxX))), y: Math.round(y) },
      props: { role: "state-list", state: st.key, people: xs.map((a) => ({ id: a.id, status: a.status, name: a.name || a.address || "", room: a.space || ROOM[a.source]?.title || "", since: a.since })) } });
  }

  // Popup body (role "state-list"): one row per person (state mark, name, room, how long in this state); a row picks that person and closes.
  stateListView() {
    const p = props(), st = STATE[p.state], people = Array.isArray(p.people) ? p.people : [];
    const grouped = p.state === "working" || p.detail;
    const groups = new Map();
    for (const a of people) { const key = a.room || "기타"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(a); }
    const rows = grouped ? [...groups].flatMap(([name, members]) => [{ heading: name }, ...members]) : people;
    return v_flex().id("state-list").size_full().p(CHIP_LIST.pad).gap(0).bg("#1b2637").overflow_y_scrollbar()
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .children(rows.map((a) => a.heading ? div().flex_none().h(25).px(8).flex().items_center().text_size(UI.text.small).font_weight(700).text_color(P.muted).child(a.heading) : h_flex().id(`sl-${a.id}`).w_full().flex_none().h(CHIP_LIST.row).px(8).gap(8).items_center().rounded(8).cursor_pointer()
        .hover((s) => s.bg(st?.wash ?? "#2b3b50"))
        .on_click(() => { if (p.detail) this.openChat(a); else setShared("hakoniwa.pick", { state: p.state, id: a.id, at: Date.now() }); closeOverlay(p.overlay); })
        .child(st ? this.stateMark(st, 22) : dot(STATE[a.status]?.color ?? P.muted, 10))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(UI.text.body).font_weight(700).text_color(P.ink).child(clipName(a.name, NAME_EM_FULL)))
          .when(!!a.room && !grouped, (el) => el.child(div().truncate().text_size(UI.text.small).text_color(P.muted).child(a.room))))
        .child(div().flex_none().text_size(UI.text.small).font_weight(700).text_color(st?.color ?? P.muted).child(a.since ? ago(a.since) : ""))));
  }

  // Cleanup candidates: how many, how much memory; pressing lights them up (floor / board). No close button: a person decides.
  cleanupN() { return cleanupIds(this.feed.state).length; }

  cleanupPill(narrow = false) {
    const c = this.feed.state?.cleanup, on = shared("hakoniwa.cleanup") === true;
    const total = c?.total_bytes && !narrow ? `(측정 합계 ${fmtMem(c.total_bytes)})` : ""; // narrow band: the count only
    // 24th Q8: checked in the code: candidates = people idle for 60 min or more (hakoniwa-collector.py cleanup_list, long_idle), biggest memory first; "測れた分" = the sum of the memory that could be measured.
    // Pressing only toggles shared "hakoniwa.cleanup" (their cards get a red frame and come first); nothing is closed or deleted here.
    const tip = "60분 이상 대기한 에이전트 수입니다. 선택하면 해당 카드가 먼저 표시되며 다시 누르면 원래대로 돌아갑니다. 에이전트를 종료하지 않습니다.";
    return h_flex().id("cleanup-pill").tooltip(tip).flex_none().ml(8).px(12).h(UI.pill - 2).gap(6).items_center().rounded(10)
      .bg(on ? "#EFE9DA" : "#F3F0E8").cursor_pointer() // 4th W4: no border, a pale ground, ordinary text (the orange "waiting" chip stays the loudest); only a slightly deeper ground while lit
      .hover((s) => s.bg(on ? "#E6DFCC" : "#EAE5D8")).on_click(() => setShared("hakoniwa.cleanup", !on))
      .child(div().flex_none().relative().w(15).h(13) // a small treasure chest: domed lid, band, lock
        .child(div().absolute().left(0).top(0).w(15).h(6).rounded_t(7).bg("#b0702e").border(1).border_color("#5c3410"))
        .child(div().absolute().left(0).top(6).w(15).h(7).bg("#8a4f1d").border(1).border_color("#5c3410"))
        .child(div().absolute().left(0).top(5).w(15).h(2).bg("#f2c94c")).child(div().absolute().left(6).top(5).w(3).h(4).rounded(1).bg("#fff3b0").border(1).border_color("#a07a14")))
      .child(div().text_size(UI.text.small).font_weight(400).text_color(P.ink).child(`정리 후보 ${this.cleanupN()}${total}`));
  }

  // Office / Board in one layout: sets shared "hakoniwa.view" ("office" is the default).
  viewSwitch(t, tight = false) {
    const view = shared("hakoniwa.view") === "board" ? "board" : "office";
    // ★105-3 (3rd): line pictures (icons/office.svg・board.svg) instead of the ▦ ☰ glyphs
    const seg = (key, label) => div().id(`view-${key}`).flex_none().px(14).h(UI.seg).flex().items_center().gap(6).rounded(8)
      .text_size(UI.text.body).cursor_pointer().when(view === key, (el) => el.bg("#1e6fe0").font_weight(700).text_color("#ffffff"))
      .when(view !== key, (el) => el.text_color(P.muted).hover((s) => s.bg("#253449")))
      .on_click(() => { setShared("hakoniwa.view.at", Date.now()); setShared("hakoniwa.view", key); })
      .child(icon(key === "office" ? "office" : "board", 18, view === key ? "#ffffff" : P.muted))
      .when(!tight, (el) => el.child(label));
    return h_flex().flex_none().gap(2).p(2).rounded(10).border(1).border_color(P.line).bg("#1b2637")
      .child(seg("office", "오피스")).child(seg("board", "보드"));
  }

  usage(t, tight = false) {
    const u = stateMatches(this.feed.state, this.demo()) ? this.feed.state?.usage : null; // never the other screen's numbers (demo / real)
    const stale = (w) => w?.resets_at != null && Number(w.resets_at) < Date.now(); // past its reset time: not true any more
    const pct = stale(u?.session) ? null : u?.session?.percent;
    const age = pct == null ? null : usageAge(u, Date.now());   // ★88-6 old figure: grey and "N min ago"
    const color = pct == null || age ? t.muted : pct < 60 ? STATE.done.color : pct < 85 ? STATE.blocked.color : "#D64545";
    const err = this.feed.error || Object.values(this.feed.state?.errors ?? {})[0];
    return v_flex().flex_none().w(tight ? 130 : 210).gap(3)
      .child(h_flex().items_center().gap(8) // ★105 head: "使用量 41%" (label, then the % in the state colour), the bar under it
        .child(div().text_size(UI.text.small).font_weight(700).text_color(P.ink).child("사용량"))
        .when(this.demo(), (el) => el.child(badge("데모", STATE.blocked.color)))
        .child(div().text_size(UI.text.body).font_weight(800).text_color(color).child(pct == null ? "—" : `${pct}%`)))
      .child(div().w_full().h(8).rounded(4).bg("#e9e5da")
        .child(div().h_full().w(Math.max(0, Math.min(100, pct ?? 0)) * (tight ? 1.3 : 2.1)).rounded(4).bg(color)))
      .child(div().truncate().text_size(UI.text.small - 1).text_color(err ? "#ff8b9b" : "#aebed2") // #4: the reset time was 10 px light grey
        .child(err ? String(err) : (age ? `${age} 값 (오래됨)` : u?.session?.resets_at && !stale(u.session) ? `초기화 ${clock(u.session.resets_at)}` : "")));
  }

  // ★105 footer (one line, 40px): left = people / spaces / last refresh, right = the legend (the four states; moved here from the left list's bottom box).
  footer(list, cx) {
    this.feedNote(list, cx); // ★106 ③ remembers state changes
    try { // 5th X3: the review command opens 最近の動き above the button without a pointer. 9th Z4: that command runs in the band's copy, so the size is also shared
      const vp = globalThis.window?.viewport_size?.();
      if (vp?.height) this.fd.vp = vp;
      if (vp?.height > 200) { const w = shared("hakoniwa.win"), nw = Math.round(vp.width), nh = Math.round(vp.height); if (w?.w !== nw || w?.h !== nh) setShared("hakoniwa.win", { w: nw, h: nh }); }
    } catch {}
    const n = list.length, sp = new Set(list.map((a) => a.space).filter(Boolean)), spN = Math.max(sp.size, spaces().length);
    const at = this.feed.state?.updated_at, fresh = at ? ago(at) : "—";
    const fact = (ic, num, unit) => h_flex().flex_none().gap(6).items_center().child(icon(ic, 18, "#aebed2"))
      .child(div().text_size(UI.text.strong).font_weight(700).text_color("#e7edf6").child(String(num))).child(div().text_size(UI.text.small).text_color("#e7edf6").child(unit));
    return h_flex().id("hud-footer").size_full().px(18).gap(22).items_center().bg("#151e2e").border_t(1).border_color("#344256").text_color("#e7edf6")
      .child(fact("chat", n, "에이전트")).child(fact("folder", spN, "공간"))
      .child(h_flex().flex_none().gap(6).items_center().child(icon("refresh", 16, P.muted)).child(div().text_size(UI.text.small).text_color(P.muted).child(`최근 갱신 ${fresh}`)))
      .child(this.feedButton())
      .child(div().id("open-agent-details").flex_none().px(10).h(30).flex().items_center().rounded(8).border(1).border_color(P.line).cursor_pointer().hover((s) => s.bg("#2b3b50"))
        .on_click(() => { const people = list.map((a) => ({ id: a.id, status: a.status, name: a.name || a.address || "", room: a.space || ROOM[a.source]?.title || "기타", since: a.since, source: a.source, address: a.address, app: a.app, model_label: a.model_label, color: a.color })); const win = shared("hakoniwa.win"); const groups = new Set(people.map((a) => a.room)).size; const height = Math.min((win?.h ?? 900) - 80, chipListHeight(people.length) + groups * 25); openOverlay({ mod: "hakoniwa", kind: "popup", width: CHIP_LIST.w, height, at: { x: 380, y: Math.max(8, (win?.h ?? 900) - height - 44) }, props: { role: "state-list", detail: true, people } }); })
        .child(div().text_size(UI.text.small).font_weight(700).text_color(P.ink).child("에이전트 상세")))
      .child(div().flex_1())
      .child(div().flex_none().text_size(UI.text.small).font_weight(700).text_color(P.muted).child("범례:"))
      .child(h_flex().id("fl-crown").flex_none().gap(6).items_center().child(icon("crown", 16, "#e0a90f")).child(div().text_size(UI.text.small).text_color("#e7edf6").child("왕관 = 리더")))
      .children([...STATES, SHELL_STATE].map((st) => h_flex().id(`fl-${st.key}`).flex_none().gap(6).items_center().child(this.stateMark(st, 16)).child(div().text_size(UI.text.small).text_color("#e7edf6").child(st.key === "blocked" ? "승인 대기 (확인 필요)" : st.label))));
  }

  // W: the click and the review command (room.js `usage`) open the same popup.
  openUsage() {
    const s = this.feed.state, ok = stateMatches(s, this.demo());
    this.openUsagePopup(ok ? (s?.usage ?? null) : null, ok ? (s?.codex_usage ?? null) : null, this.demo());
  }

  // Chart icon beside the Current session bar: a popup with every agent whose usage can be read.
  usageButton(t) {
    const s = this.feed.state;
    const btn = h_flex().id("usage-more").flex_none().w(UI.iconBtn).h(UI.iconBtn).gap(2).items_end().justify_center().py(8).rounded(8)
      .border(1).border_color(P.line).bg("#1b2637").cursor_pointer().hover((el) => el.bg("#253449"))
      .on_mouse_down("left", (e) => { const b = e?.bounds, p = e?.position; this.ub = b ? { x: b.x + b.width - 340, y: b.y + b.height + 6 } : p ? { x: p.x - 300, y: p.y + 24 } : null; }) // 5th X4: the popup opens under the button
      .on_click(() => this.openUsage()) // ★106-5 (feed.js): reads OpenCode's record, then opens
      .children([8, 14, 10].map((h) => div().w(4).h(h).rounded(1).bg(P.muted)));
    return div().flex_none().relative().child(btn); // ★84: no hover bubble (the click popup says it; the bubble used to hang outside the band)
  }

  // Popup body (role "usage"): numbers come in through props, taken when the icon was pressed.
  usageView() {
    const t = theme(), p = props();
    const old = (w) => w?.resets_at != null && Number(w.resets_at) < Date.now(); // past its reset time: shown as a dash
    const color = (pct) => pct == null ? t.muted : pct < 60 ? "#39a380" : pct < 85 ? "#d79032" : "#d6455d";
    const window_ = (label, pct0, resets0) => { const pct = resets0 != null && Number(resets0) < Date.now() ? null : pct0, resets = pct == null ? null : resets0; return v_flex().gap(3)
      .child(h_flex().items_center().justify_between().text_size(UI.text.small)
        .child(div().text_color(t.foreground).child(label))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(UI.text.small).text_color(t.muted).child(resets ? `초기화 ${clock(resets)}` : ""))
          .child(div().font_weight(700).text_color(color(pct)).child(pct == null ? "—" : `${pct}%`))))
      .child(div().w_full().h(5).rounded(3).bg(t.border)
        .child(div().h_full().w(Math.max(0, Math.min(100, pct ?? 0)) * 2.8).rounded(3).bg(color(pct)))); };
    const group = (title, icon, rows) => v_flex().gap(7)
      .child(h_flex().gap(6).items_center().child(platformIcon({ app: icon }, 14))
        .child(div().text_size(UI.text.small).font_weight(700).text_color(t.foreground).child(title)))
      .children(rows);
    const win = (w) => w.minutes === 300 ? "5시간" : w.minutes === 10080 ? "주간" : `${w.minutes ?? "?"}분`;
    const groups = [], u = usageParts(p.claude, p.codex, Date.now(), p.demo);
    if (u.claude)
      groups.push(group("Claude Code", "claude-code", [window_("현재 세션", u.claude.session.percent, u.claude.session.resets_at),
        ...u.claude.weekly.map((w) => window_(`주간 ${w.label}`, w.percent, w.resets_at)),
        ...(u.claude.extra ? [div().text_size(UI.text.small).text_color(t.muted).child(u.claude.extra)] : [])]));
    if (u.codex)
      groups.push(group("Codex", "codex", [...u.codex.rows.map((w) => window_(win(w), w.percent, w.resets_at)),
        ...(u.codex.age ? [div().text_size(UI.text.small).text_color(t.muted).child(u.codex.age)] : [])]));
    // ★106-5 every service has its own group; what cannot be read says "未取得" (no made-up number)
    const none = (title, ic, why) => group(title, ic, [div().text_size(UI.text.small).text_color(t.muted).child(`가져오지 못함（${why}）`)]);
    if (!u.claude) groups.push(none("Claude Code", "claude-code", "현재 사용량이 없습니다"));
    if (!u.codex) groups.push(none("Codex", "codex", "기록이 없습니다"));
    const oc = p.opencode;
    groups.push(oc ? group("OpenCode", "opencode", [
      div().text_size(UI.text.small).text_color(t.foreground).child(`최근 5시간 ${fmtTokens(oc.h5.tokens)} 토큰 · ${oc.h5.answers}회`),
      div().text_size(UI.text.small).text_color(t.foreground).child(`최근 24시간 ${fmtTokens(oc.h24.tokens)} 토큰 · ${oc.h24.answers}회`),
      div().text_size(UI.text.small).text_color(t.muted).child("한도 미확인 (OpenCode는 한도 값을 제공하지 않으며 캐시는 제외)")])
      : none("OpenCode", "opencode", p.demo ? "데모 중" : "기록을 읽을 수 없습니다"));
    return v_flex().size_full().p(14).gap(14).bg(t.chrome).text_color(t.foreground)
      .children(groups)
      .when(!!p.demo, (el) => el.child(div().text_size(UI.text.small).font_weight(700).text_color(STATE.blocked.color).child("데모 값입니다 (실제 값 아님)")));
  }

  windowButtons(t) {
    const b = (id, name, cmd) => div().id(id).w(40).h(UI.hit).flex().items_center().justify_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run(cmd)).child(icon(name, 18, P.ink)); // ★105-3 (3rd): line pictures (icons/minimize・maximize・x.svg)
    return h_flex().flex_none().gap(2).child(b("w-min", "minimize", "window.minimize"))
      .child(b("w-max", "maximize", "window.maximize")).child(b("w-close", "x", "window.close"));
  }

  // ------------------------------------------------------------- Board

  board(list, cx) {
    setAgentOrder(STATES.flatMap((st) => list.filter((a) => a.source === "app" && a.status === st.key).map((a) => a.address)));
    this.loadRemembered?.(cx); // the last floor plan holds the people's pictures (faces)
    this.ensureScene?.(list, cx); // a person who is not in it yet gets drawn, so every card has a face
    const root = div().id("hud-board").relative().size_full().overflow_hidden().bg(P.paper)
      .on_size_change((size, cx) => { this.boardSize = size; cx.notify(); });
    const cols = h_flex().absolute().left(0).top(0).size_full().px(18).pt(14).pb(40).gap(14).children(STATES.map((st) => {
      const lit = shared("hakoniwa.cleanup") === true, ids = cleanupIds(this.feed.state), rank = (a) => ids.includes(a.id) ? ids.indexOf(a.id) : 1e6;
      const cards = list.filter((a) => a.status === st.key).sort((a, b) => lit && (ids.includes(a.id) || ids.includes(b.id)) ? rank(a) - rank(b) : st.key === "blocked" ? a.since - b.since : ((!!a.long_idle - !!b.long_idle) || (b.since - a.since)));
      const picked = shared("hakoniwa.pick")?.state === st.key;
      return v_flex().flex_1().min_w(0).h_full().gap(8).p(8).rounded(14).bg(st.wash)
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
    const hot = shared("hakoniwa.cleanup") === true && cleanupIds(this.feed.state).includes(a.id);
    return v_flex().id(`card-${a.id}`).w_full().flex_none().p(10).gap(8).rounded(12).bg(hot ? "#FFF4F2" : "#ffffff").border(hot ? 2 : 1).border_color(hot ? "#D64545" : P.line)
      .cursor_pointer().hover((s) => s.border_color(st.color)).on_click(() => this.openChat(a))
      .when(!!a.long_idle, (el) => el.opacity(0.7))
      .child(h_flex().gap(10).items_start()
        .child(this.face(a, 52))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(6).items_center().child(platformIcon(a, 16))
            .child(div().flex_1().min_w(0).truncate().text_size(14).font_weight(700).text_color(P.ink).child(platform(a).name))
            .child(h_flex().flex_none().gap(4).items_center().px(6).py(2).rounded(7).bg("#253449").text_size(10).text_color(P.ink)
              .child(chip(a.color ?? P.muted, 7)).child(div().child(a.model_label ?? "모델 미확인"))))
          .child(div().text_size(12).font_weight(600).text_color(P.ink).child(line))
          .child(div().text_size(10).text_color(P.muted).child(where))
          .when(!!par || kidsN > 0, (el) => el.child(h_flex().gap(4).items_center().flex_none().px(6).py(2).rounded(7).bg(STATE.working.wash)
            .text_size(10).text_color(P.blue).child(div().truncate().child(par ? `리더: ${par.name || par.address}` : `작업자 ${kidsN}명`))))))
      .child(h_flex().gap(8).items_center()
        .child(this.stateMark(st, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(700).text_color(st.color).child(`${hasMem(a) ? `메모리 ${fmtMem(a.mem_bytes)} · ` : ""}${st.label}${a.unknown ? "?" : ""} ${ago(a.since)}`))
        .when(!!act, (el) => el.child(div().flex_none().px(10).py(4).rounded(8).bg("#1e6fe0").text_size(11).font_weight(700).text_color("#ffffff").child(act))));
  }

  // ------------------------------------------------------------- pane header

  paneHeader() {
    const p = panes().find((x) => x.pane === props().pane);
    const st = STATE[p?.status];
    const icon = p?.program?.icon ? (p.program.tint ? svg(p.program.icon).text_color(P.ink) : image(p.program.icon)).size(14).flex_none()
      : div().size(14).rounded(4).bg("#7465db");
    return h_flex().size_full().px(12).items_center().gap(7).bg("#1b2637").border_b(1).border_color(P.line)
      .child(icon).child(div().text_size(11).text_color(P.ink).child(p?.program?.name ?? "Terminal"))
      .child(div().flex_1()).when(!!st, (el) => el.child(div().text_size(10).text_color(st.color).child(st.label)))
      .child(dot(st?.color ?? P.muted, 6));
  }
}

// Office and chat live in their own files; their methods join the class here.
for (const part of [OfficePart, ChatPart, DetailPart, GridPart, LaunchPart, RoomPart, MeetPart, PanelPart, RegionPart, FeedPart, RemotePart])
  for (const k of Object.getOwnPropertyNames(part.prototype))
    if (k !== "constructor") AgentHud.prototype[k] = part.prototype[k];

export default AgentHud;
