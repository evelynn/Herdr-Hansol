// hansol: the Git window. A guild flag opens its space's repository as a graph window (lanes drawn with lines and curves:
// branches, merges, labels) on the left; the commit pressed there is shown on the right (message, author, changed files, a file's diff).
// Read only: nothing here changes a repository. Drawing after herdr-git-graph (MIT, see git-rules.js). Mixed into AgentHud.
import { div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { closeOverlay, exec, openOverlay, panes, props, settings, setShared, shared, spaces } from "herdr";
import { P } from "./common.js";
import { icon } from "./icons.js";
import { iconBtn } from "./ui.js";
import { spaceForIsland } from "./actions.js";
import { LOG_N, fetchArgs, netReason, parseRemotes, remotesArgs, pullArgs, upstreamArgs, syncArgs, parseSync, ago, currentBranch, diffArgs, diffRows, fileArgs, folderKey, joinFiles, laneColor, layoutLanes, logArgs, parseLog, parseShow, rootArgs, showArgs, spaceFolder, stamp } from "./git-rules.js";

const ROW = 26, LANE = 14, PAD = 8, DIFF_ROW = 20, REFRESH_MS = 15000;
const C = { bg: "#151e2e", head: "#1b2637", line: "#2c3a4f", hover: "#22324a", sel: "#243d5d", dim: "#7f8ea3", add: "#7bd88f", del: "#ff8a8a", tag: "#f4ce76", remote: "#7bd88f" };
// One window, two sizes: the graph alone (narrow and tall), and the graph with the pressed commit on its right (the list keeps its
// width, the commit gets the rest). The App cannot resize a window, so a change of size opens the same window again in its place;
// the history it had is kept in shared LOG_KEEP and drawn at once. A size dragged or docked is kept per size (shared SAVE; one
// height for both) and used the next time.
const WIN_KEY = "hansol-git-graph", SIZES = { graph: { w: 640, h: 820 }, detail: { w: 1500, h: 820 } }, WIN_MIN = { w: 480, h: 360 }, DETAIL_MIN = 480;
const SAVE = "hansol.gitWinV3", LOG_KEEP = "hansol.gitLog";
const modeOf = (base) => (base?.hash ? "detail" : "graph");
function gitWinSize(base, size = null) {
  const vp = globalThis.window?.viewport_size?.(), all = shared(SAVE) ?? {}, mode = modeOf(base), d = SIZES[mode];
  const maxW = vp?.width > 0 ? vp.width - 16 : 1900, maxH = vp?.height > 0 ? vp.height - 16 : 1100;
  return { w: Math.round(Math.max(WIN_MIN.w, Math.min(maxW, size?.width ?? all[mode]?.w ?? d.w))), h: Math.round(Math.max(WIN_MIN.h, Math.min(maxH, size?.height ?? all.h ?? d.h))) };
}
function gitOpenWin(role, base, size = null, at = null) {
  if (role !== "git-graph") return;
  const { w, h } = gitWinSize(base, size), all = shared(SAVE) ?? {};
  openOverlay({ mod: "hansol", kind: "window", key: WIN_KEY, width: w, height: h, ...(at ? { at } : {}), props: { ...base, role, width: w, height: h } });
  if (size) setShared(SAVE, { ...all, [modeOf(base)]: { w }, h });
}
// The list's width: the graph-alone width, as long as the commit keeps DETAIL_MIN.
const listWidth = (winW) => Math.max(340, Math.min(winW - DETAIL_MIN, (shared(SAVE) ?? {}).graph?.w ?? SIZES.graph.w));
const mono = () => { try { return settings()?.font_family || "JetBrains Mono"; } catch { return "JetBrains Mono"; } };
const git = (root, on, args) => exec("git", args, { cwd: root, on: on ?? null, timeout: 20000 });
const errText = (r) => String(r?.stderr || r?.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:")).slice(-3).join("\n") || `git 종료 코드 ${r?.code}`;

export class GitPart {
  // ---- opening (the office's flag)
  async gitRootOf(folder, on) {
    const k = folderKey(on, folder), cache = (this.gitRoots ??= new Map()), hit = cache.get(k);
    if (hit && (hit.root || Date.now() - hit.at < 60000)) return hit.root;
    let root = ""; try { const r = await git(folder, on, rootArgs()); if (!r.code) root = String(r.stdout ?? "").trim(); } catch {}
    cache.set(k, { root, at: Date.now() }); return root;
  }
  // A flag opens its space's Git graph window. The free desks, a space with no folder or a folder that is not a repository keep the old menu.
  flagClick(isl, members, cx) {
    const menu = (cx2) => { this.plateOpen = this.plateOpen === isl.key ? null : isl.key; cx2.notify(); };
    if (String(isl?.key ?? "").startsWith("free:")) return menu(cx);
    let sl = [], pl = []; try { sl = spaces(); pl = panes(); } catch {}
    const sp = spaceForIsland(members, sl, isl), folder = spaceFolder(sp, pl);
    if (!sp || !folder) return menu(cx);
    this.plateOpen = null; cx.notify();
    cx.spawn(async (cx2) => { const root = await this.gitRootOf(folder, sp.machine); if (root) this.openGitGraph({ root, on: sp.machine ?? null, space: sp.name }); else menu(cx2); });
  }
  // `hansol.git:<space>[@<hash>[@<path>]]` (review pictures without clicks): the graph, with that commit (and that file's diff) on the right.
  async gitCommand(arg) {
    const [name, hash, file] = String(arg ?? "").split("@");
    let sl = [], pl = []; try { sl = spaces(); pl = panes(); } catch {}
    const sp = sl.find((s) => s.name === name) ?? sl.find((s) => name && String(s.name ?? "").includes(name)), path = !sp && /^([A-Za-z]:)?[\/]/.test(name) ? name : null; // a space, or a folder on this machine
    if (!sp && !path) return;
    const root = await this.gitRootOf(sp ? spaceFolder(sp, pl) : path, sp?.machine ?? null); if (!root) return;
    const at = { root, on: sp?.machine ?? null, space: sp?.name ?? "" };
    this.openGitGraph({ ...at, hash: hash || null, file: file || null });
  }
  openGitGraph({ root, on, space, hash = null, file = null }) { gitOpenWin("git-graph", { root, on, space, hash, file }); }

  // ---- size and docking (as the terminal popups: the ◢ corner drags the size, ◧ ◨ ▣ dock to a half / the whole screen)
  // The full-screen surface a corner drag runs on (role "git-resize"); the window opens again at the new size when the button is let go.
  gitResizeView() {
    const p = props() ?? {}, pos = this.gitResizePoint ?? { x: p.startX, y: p.startY };
    const size = (pt) => ({ width: Math.max(WIN_MIN.w, Number(p.width) + pt.x - Number(p.startX)), height: Math.max(WIN_MIN.h, Number(p.height) + pt.y - Number(p.startY)) });
    const cur = size(pos);
    return div().id("git-resize-surface").relative().size_full().bg("#00000020").cursor_nwse_resize()
      .on_mouse_move((e, cx) => { this.gitResizePoint = e.position; cx.notify(); })
      .on_mouse_up("left", (e, cx) => { cx.stop_propagation(); const n = size(e.position); this.gitResizePoint = null; closeOverlay(p.overlay); gitOpenWin(p.target, p.base, n); })
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.gitResizePoint = null; closeOverlay(p.overlay); })
      .child(div().absolute().left(Math.max(0, pos.x + 10)).top(Math.max(0, pos.y + 10)).px(8).py(4).rounded(6).bg(C.head).text_color(P.ink).text_size(12)
        .child(`${Math.round(cur.width)} × ${Math.round(cur.height)}`));
  }
  // What this window opens again with (the commit on the right and the file whose diff is shown stay; `again`: no second automatic fetch).
  gitBase() { const p = props() ?? {}, d = this.gw?.detail; return { root: p.root, on: p.on ?? null, space: p.space ?? "", hash: d?.hash ?? p.hash ?? null, file: d?.file ?? null, again: true }; }
  // The commit on the right opens (hash) or closes (null): the window opens again at the other size. A wider window that would
  // run past the screen's right edge moves left (its place is known from the last press in it, gwAt).
  gitShowDetail(hash) {
    const base = { ...this.gitBase(), hash: hash ?? null, file: null }, vp = globalThis.window?.viewport_size?.(), pos = this.gwAt;
    let at = null;
    if (hash && pos && vp?.width > 0) { const { w } = gitWinSize(base); if (pos.x + w > vp.width - 8) at = { x: Math.max(8, vp.width - 8 - w), y: Math.max(0, pos.y) }; }
    gitOpenWin("git-graph", base, null, at);
  }
  gitDock(where) {
    const vp = globalThis.window?.viewport_size?.(), p = props() ?? {}; if (!(vp?.width > 0 && vp?.height > 0)) return;
    const top = 72, h = Math.max(WIN_MIN.h, vp.height - top - 48), half = Math.floor((vp.width - 24) / 2);
    const box = where === "left" ? { x: 8, w: half } : where === "right" ? { x: vp.width - half - 8, w: half } : { x: 8, w: vp.width - 16 };
    gitOpenWin(p.role, this.gitBase(), { width: box.w, height: h }, { x: box.x, y: top });
  }
  gitWinButtons() {
    const b = (id, label, tip, fn) => div().id(id).flex_none().w(34).h(32).flex().items_center().justify_center().rounded(6).text_size(16).text_color(P.ink).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg("#314259")).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); fn(); }).child(label);
    return [b("git-dock-left", "◧", "왼쪽 절반에 붙이기", () => this.gitDock("left")), b("git-dock-right", "◨", "오른쪽 절반에 붙이기", () => this.gitDock("right")),
      b("git-dock-full", "▣", "화면 전체로 넓히기", () => this.gitDock("full"))];
  }
  gitGrip() {
    const p = props() ?? {};
    return div().id("git-grip").flex_none().w(36).h_full().flex().items_center().justify_center().cursor_nwse_resize().text_size(13).text_color(P.muted).tooltip("끌어서 창 크기 조절")
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        const vp = globalThis.window?.viewport_size?.(); if (!(vp?.width > 0 && vp?.height > 0)) return;
        openOverlay({ mod: "hansol", kind: "window", frame: "none", key: "hansol-git-resize", width: vp.width, height: vp.height, at: { x: 0, y: 0 },
          props: { role: "git-resize", target: p.role, base: this.gitBase(), width: p.width, height: p.height, startX: e.position.x, startY: e.position.y } });
      }).child("◢");
  }

  // ---- the windows' state (each window is its own copy of the mod)
  initGit(cx) {
    const p = props() ?? {};
    const g = this.gw = { root: p.root, on: p.on ?? null, space: p.space ?? "", state: "loading", error: null, commits: [], lanes: null, selected: null, detail: null, scroll: VirtualListScrollHandle.new() };
    const kept = shared(LOG_KEEP), want = () => (p.hash ? g.commits.find((c) => c.hash.startsWith(p.hash)) ?? null : null);
    if (kept?.root === p.root && kept.out) { this.gitTakeLog(kept.out); const c = want(); if (c) { g.selected = c.hash; this.gitCenter(c.hash); } } // drawn at once when the window only changed its size
    cx.spawn(async (cx2) => { // the history, the commit asked for on the right, then (only when the window is new) the remotes' new commits
      await this.gitLoadLog(cx2);
      const c = want();
      if (c) { if (g.selected !== c.hash) this.gitCenter(c.hash); await this.gitSelect(c.hash, cx2, p.file ?? undefined); }
      await this.gitSync(cx2);
      if (!p.again) await this.gitNetRun("fetch", cx2, true);
    });
    cx.timer.every(REFRESH_MS, (cx2) => cx2.spawn(async (cx3) => { await this.gitLoadLog(cx3); await this.gitSync(cx3); }));
  }
  gitCenter(hash) { const i = this.gw.index?.get(hash); if (i !== undefined) try { this.gw.scroll.scroll_to_item(i, "center"); } catch {} }
  gitTakeLog(out) {
    const g = this.gw, commits = parseLog(out);
    Object.assign(g, { commits, lanes: layoutLanes(commits), state: commits.length ? "ready" : "empty", error: null, sig: out.length + ":" + out.slice(0, 400) });
    g.index = new Map(commits.map((c, i) => [c.hash, i]));
  }
  // A commit on the right: its details, then the asked file's diff (else the first file's). Awaited where the cx is a task's.
  async gitSelect(hash, cx, file) {
    const g = this.gw, d = { hash, state: "loading", error: null, commit: null, files: null, file: null, diff: null };
    g.selected = hash; g.detail = d; cx.notify();
    await this.gitLoadCommit(d, cx);
    if (g.detail !== d || !d.files?.length) return;
    const f = (file && d.files.find((x) => x.path === file)) || d.files[0];
    await this.gitLoadDiff(d, f, cx);
  }
  async gitLoadLog(cx) {
    const g = this.gw; if (g.loading) return; g.loading = true;
    try {
      const r = await git(g.root, g.on, logArgs(LOG_N));
      if (r.code) { g.state = "error"; g.error = errText(r); cx.notify(); return; }
      const sig = r.stdout.length + ":" + r.stdout.slice(0, 400);
      if (sig === g.sig && g.state === "ready") return;
      this.gitTakeLog(r.stdout); setShared(LOG_KEEP, { root: g.root, out: r.stdout });
      cx.notify();
    } catch (e) { g.state = "error"; g.error = String(e?.message ?? e); cx.notify(); }
    finally { g.loading = false; }
  }
  // The checked-out branch against its upstream: { ahead, behind } (null: no upstream).
  async gitSync(cx) {
    const g = this.gw;
    try { const [u, s] = await Promise.all([git(g.root, g.on, upstreamArgs()), git(g.root, g.on, syncArgs())]); g.upstream = u.code ? null : String(u.stdout ?? "").trim(); g.sync = u.code || s.code ? null : parseSync(s.stdout); }
    catch { g.upstream = null; g.sync = null; }
    cx.notify();
  }
  // "가져오기" (fetch every remote) / "당겨오기" (pull --ff-only); `quiet`: the fetch the window starts by itself (a failure is one pale line).
  // fetch: every remote on its own, at the same time (the log is read again as each one comes back); pull: the upstream only.
  async gitNetRun(kind, cx, quiet = false) {
    const g = this.gw; if (g.net) return; g.net = kind; g.msg = null; cx.notify();
    const run = async (args) => { try { return await exec("git", args, { cwd: g.root, on: g.on, timeout: 120000 }); } catch (e) { return { code: 1, stderr: String(e?.message ?? e) }; } };
    if (kind === "pull") {
      const r = await run(pullArgs());
      g.msg = r.code ? { err: true, text: `당겨오기 실패: ${errText(r)}` } : { text: "당겨오기 완료" };
    } else {
      let remotes = []; try { remotes = parseRemotes((await git(g.root, g.on, remotesArgs())).stdout); } catch {}
      g.netTotal = remotes.length; g.netDone = 0; cx.notify();
      const res = await Promise.all(remotes.map(async (name) => {
        const r = await run(fetchArgs(quiet, name)); g.netDone++;
        if (!r.code) { g.sig = null; await this.gitLoadLog(cx); }
        cx.notify(); return { name, r };
      }));
      const bad = res.filter((x) => x.r.code), good = res.filter((x) => !x.r.code).map((x) => x.name);
      if (!remotes.length) g.msg = quiet ? null : { text: "원격 저장소가 없음" };
      else if (bad.length) g.msg = { err: true, text: `가져오기 실패: ${bad.map((x) => `${x.name} (${netReason(x.r.stderr) ?? errText(x.r).split("\n").pop()})`).join(", ")}${good.length ? ` · 가져옴: ${good.join(", ")}` : ""}` };
      else g.msg = quiet ? null : { text: `가져오기 완료: ${good.join(", ")}` };
    }
    g.net = null; g.sig = null; await this.gitLoadLog(cx); await this.gitSync(cx); cx.notify();
  }
  // d = the right side's commit (gw.detail); a newer press replaces it, and what an older one reads late is dropped.
  async gitLoadCommit(d, cx) {
    const g = this.gw;
    try {
      const s = await git(g.root, g.on, showArgs(d.hash));
      if (s.code) { d.state = "error"; d.error = errText(s); cx.notify(); return; }
      d.commit = parseShow(s.stdout); d.state = "ready"; cx.notify();
      const a = fileArgs(d.commit), [st, ns] = await Promise.all([git(g.root, g.on, a.status), git(g.root, g.on, a.numstat)]);
      d.files = joinFiles(st.stdout, ns.stdout);
    } catch (e) { d.state = "error"; d.error = String(e?.message ?? e); }
    cx.notify();
  }
  // A press on a file (an event's cx can spawn); gitLoadDiff is awaited directly where the cx is already a task's (it has no spawn).
  gitOpenDiff(d, file, cx) { cx.spawn(async (cx2) => this.gitLoadDiff(d, file, cx2)); }
  async gitLoadDiff(d, file, cx) {
    const g = this.gw; d.file = file.path; d.diff = null; cx.notify();
    let rows;
    try { const r = await git(g.root, g.on, diffArgs(d.commit, file.path)); rows = r.code ? [{ kind: "", text: errText(r) }] : diffRows(r.stdout) ?? [{ kind: "", text: file.binary ? "바이너리 파일 변경" : "텍스트 변경 없음" }]; }
    catch (e) { rows = [{ kind: "", text: `diff를 읽지 못함: ${e?.message ?? e}` }]; }
    if (d.file === file.path) { d.diff = { rows, width: Math.max(400, ...rows.map((r) => r.text.length * 7.4 + 110)) }; cx.notify(); }
  }

  // ---- drawing: shared parts
  gitWinHead(title, sub, extra = []) {
    return h_flex().id("git-head").flex_none().h(48).px(14).gap(10).items_center().bg(C.head).border_b(1).border_color(C.line)
      .child(icon("tree", 20, P.blue))
      .child(div().flex_none().text_size(16).font_weight(800).text_color(P.ink).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(P.muted).child(sub))
      .children(extra)
      .children(this.gitWinButtons())
      .child(iconBtn("git-close", "x", () => closeOverlay(props()?.overlay), { size: 32, isize: 16, tip: "닫기" }));
  }
  gitTextBtn(id, label, tip, fn, warn = false) {
    return div().id(id).flex_none().h(30).px(10).flex().items_center().rounded(6).border(1).border_color(warn ? C.tag : C.line).bg(warn ? "#493a24" : "#202c3e")
      .text_size(12).font_weight(700).text_color(warn ? C.tag : P.ink).cursor_pointer().tooltip(tip).hover((s) => s.bg("#314259"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);
  }
  gitRefChip(ref, color, id) {
    const cur = ref.kind === "branch" && ref.head, edge = ref.kind === "tag" ? C.tag : ref.kind === "remote" ? C.remote : ref.kind === "detached" ? C.del : color;
    return h_flex().id(id).flex_none().max_w(130).h(18).px(6).gap(3).items_center().rounded(5).border(1).border_color(edge).when(cur, (e) => e.bg(color))
      .when(cur, (e) => e.child(icon("check", 11, C.bg)))
      .child(div().min_w(0).truncate().font_family(mono()).text_size(11).font_weight(cur ? 800 : 600).text_color(cur ? C.bg : edge).child(ref.kind === "tag" ? `◆ ${ref.name}` : ref.name));
  }
  gitEmpty(text, red = false) { return div().id("git-empty").flex_1().flex().items_center().justify_center().p(30).text_size(14).text_color(red ? C.del : P.muted).child(text); }

  // ---- the graph window
  gitGraphCell(row, commit, width) {
    const x = (lane) => PAD + lane * LANE + LANE / 2, y = (v) => v * ROW, paths = new Map();
    for (const [a, ya, b, yb, c] of row.segments) { // one stroked path per colour
      const color = laneColor(c);
      let p = paths.get(color) ?? PathBuilder.stroke(2);
      p = p.move_to(x(a), y(ya));
      if (a === b) p = p.line_to(x(b), y(yb));
      else { const mid = (y(ya) + y(yb)) / 2; p = p.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid); } // forks and merges bend
      paths.set(color, p);
    }
    const color = laneColor(row.lane), merge = commit.parents.length > 1, r = commit.head ? 6 : 5;
    const dot = div().absolute().left(x(row.lane) - r).top(ROW / 2 - r).size(r * 2).rounded(r);
    return div().relative().flex_none().w(width).h(ROW).overflow_hidden()
      .children([...paths].map(([c, p]) => globalThis.window.paint_path(p.build(), c).absolute().top(0).left(0).size_full()))
      // HEAD: a filled dot in a white ring; a merge: a hollow ring; others: a filled dot
      .child(commit.head ? dot.bg(color).border(2).border_color("#ffffff") : merge ? dot.bg(C.bg).border(2).border_color(color) : dot.bg(color));
  }
  gitRow(i, width) {
    const g = this.gw, c = g.commits[i], row = g.lanes.rows[i], color = laneColor(row.lane), merge = c.parents.length > 1, font = mono();
    return h_flex().id(`gc-${c.hash}`).w_full().h(ROW).flex_none().pr(12).gap(8).items_center().overflow_hidden().cursor_pointer()
      .when(c.head, (e) => e.bg(color + "1a")).when(g.selected === c.hash, (e) => e.bg(C.sel)).hover((s) => s.bg(C.hover))
      .child(this.gitGraphCell(row, c, width))
      .child(h_flex().flex_1().min_w(0).h_full().gap(6).items_center().overflow_hidden()
        .children(c.refs.slice(0, 4).map((r, k) => this.gitRefChip(r, color, `gc-${c.hash}-r${k}`)))
        .when(merge, (e) => e.child(div().flex_none().px(5).rounded(4).bg("#2b3b50").text_size(11).font_weight(700).text_color(P.muted).child("병합")))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(merge ? P.muted : P.ink).when(c.head, (e) => e.font_weight(700)).child(c.subject)))
      .child(div().w(72).flex_none().truncate().text_size(12).text_color(P.muted).child(c.author)) // (the hash and the full dates are on the right)
      .child(div().w(64).flex_none().text_right().truncate().text_size(12).text_color(C.dim).child(ago(c.time)));
  }
  gitGraphView() {
    const g = this.gw ?? {}, name = String(g.root ?? "").split("/").filter(Boolean).pop() ?? "", branch = currentBranch(g.commits ?? []);
    const info = [ // the tool row: what the repository is at (left), what can be done (right)
      ...(branch ? [h_flex().id("git-branch").flex_none().max_w(260).h(24).px(8).gap(4).items_center().rounded(6).bg("#1e4f8a").child(icon("check", 12, "#ffffff")).child(div().min_w(0).truncate().text_size(12).font_weight(700).text_color("#ffffff").child(branch))] : []),
      div().flex_none().text_size(12).text_color(C.dim).child(g.state === "ready" ? `커밋 ${g.commits.length}개${g.commits.length >= LOG_N ? " (최근)" : ""}` : ""),
      ...(g.sync ? [div().id("git-sync").flex_none().text_size(12).font_weight(700).text_color(g.sync.behind ? C.tag : C.dim).tooltip(`${g.upstream} 기준: 앞섬 ${g.sync.ahead}개 · 뒤처짐 ${g.sync.behind}개`).child(`↑${g.sync.ahead} ↓${g.sync.behind}`)] : []),
    ], actions = [
      this.gitTextBtn("git-fetch", g.net === "fetch" ? `가져오는 중… ${g.netDone ?? 0}/${g.netTotal ?? 0}` : "가져오기", "원격마다 새 커밋 가져오기 (git fetch <원격>, 작업 파일은 그대로)", (cx) => cx.spawn(async (cx2) => this.gitNetRun("fetch", cx2))),
      ...(g.upstream ? [this.gitTextBtn("git-pull", g.net === "pull" ? "당겨오는 중…" : Date.now() - (g.pullAsk ?? 0) < 5000 ? "다시 눌러 실행" : "당겨오기",
        `${g.upstream}의 새 커밋을 현재 브랜치에 반영 (git pull --ff-only: 병합 커밋을 만들지 않고, 충돌이 나면 실행하지 않음)`, (cx) => {
          if (g.net) return;
          if (Date.now() - (g.pullAsk ?? 0) >= 5000) { g.pullAsk = Date.now(); cx.notify(); cx.timer?.after?.(5000, (c2) => c2.notify()); return; } // the first press asks, the second (within 5 s) pulls
          g.pullAsk = 0; cx.spawn(async (cx2) => this.gitNetRun("pull", cx2)); }, Date.now() - (g.pullAsk ?? 0) < 5000)] : []),
      iconBtn("git-refresh", "refresh", (cx) => { g.sig = null; cx.spawn(async (cx2) => { await this.gitLoadLog(cx2); await this.gitSync(cx2); }); }, { size: 32, isize: 16, tip: "다시 읽기" }),
    ];
    const split = !!props()?.hash; // the window's size says it: the graph alone, or the graph with a commit on the right
    // the window's place on screen, from any press in it (a wider window moves left if it would run past the screen)
    const root = v_flex().id("git-graph-root").size_full().bg(C.bg).on_mouse_down("left", (e) => { if (e.local_position) this.gwAt = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y }; })
      .child(this.gitWinHead(name, `${g.space ? `공간 ${g.space} · ` : ""}${g.root ?? ""}`))
      .child(h_flex().id("git-tools").flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(C.line).children(info).child(div().flex_1()).children(actions));
    if (g.state === "loading") return root.child(this.gitEmpty("기록을 읽는 중…"));
    if (g.state === "error") return root.child(this.gitEmpty(`기록을 읽지 못함\n${g.error ?? ""}`, true));
    if (g.state === "empty") return root.child(this.gitEmpty("아직 커밋이 없음"));
    const width = Math.min(200, Math.max(56, PAD * 2 + g.lanes.width * LANE)), n = g.commits.length;
    const leftW = split ? listWidth(Number(props()?.width) || SIZES.detail.w) : null; // with a commit: the list keeps the graph-alone width
    const heads = h_flex().flex_none().h(26).pr(12).gap(8).items_center().border_b(1).border_color(C.line).text_size(12).text_color(C.dim)
      .child(div().w(width).flex_none().pl(PAD).child("그래프")).child(div().flex_1().child("설명"))
      .child(div().w(72).flex_none().child("작성자")).child(div().w(64).flex_none().text_right().child("날짜"));
    const list = div().flex_1().min_h(0).relative()
      .child(v_virtual_list("git-rows", n, ROW, (i) => g.commits[i]?.hash ?? String(i), (range) => Array.from({ length: range.end - range.start }, (_x, k) => this.gitRow(range.start + k, width)))
        .on_item_click((key, cx) => { // a commit opens the right side; the same one again closes it; another one takes its place
          const c = g.commits[g.index?.get(key)]; if (!c) return;
          if (!split) return this.gitShowDetail(c.hash);
          if ((g.detail?.hash ?? props()?.hash) === c.hash) return this.gitShowDetail(null);
          cx.spawn(async (cx2) => this.gitSelect(c.hash, cx2)); })
        .track_scroll(g.scroll).size_full())
      .child(Scrollbar.vertical("git-rows").absolute().inset_0());
    const left = v_flex().id("git-list-side").h_full().when(split, (e) => e.w(leftW).flex_none().border_r(1).border_color(C.line)).when(!split, (e) => e.flex_1().min_w(0)).child(heads).child(list);
    const foot = h_flex().flex_none().h(28).px(14).gap(14).items_center().border_t(1).border_color(C.line).text_size(12).text_color(C.dim)
      .child(g.msg ? div().id("git-msg").flex_1().min_w(0).truncate().text_color(g.msg.err ? C.del : C.add).tooltip(g.msg.text).child(g.msg.text) : div().flex_1().min_w(0).truncate().child(g.net === "fetch" ? "원격 이력 가져오는 중…" : split ? "같은 커밋을 다시 누르면 상세가 닫힘" : "커밋을 누르면 오른쪽에 상세(변경 파일·diff) 표시"))
      .when(!!g.lanes.trunk, (e) => e.child(h_flex().flex_none().gap(5).items_center().child(div().w(3).h(12).rounded(1).bg(laneColor(0))).child(div().child(`맨 왼쪽 줄: ${g.lanes.trunk}`))))
      .child(h_flex().flex_none().gap(5).items_center().child(div().size(10).rounded(5).bg(P.blue).border(2).border_color("#ffffff")).child(div().child("HEAD")))
      .child(h_flex().flex_none().gap(5).items_center().child(div().size(10).rounded(5).bg(C.bg).border(2).border_color(P.blue)).child(div().child("병합")))
      .child(this.gitGrip());
    return root.child(h_flex().id("git-split").flex_1().min_h(0).child(left).when(split, (e) => e.child(this.gitDetailPane(g.detail)))).child(foot);
  }

  // ---- the right side: the commit pressed in the list (meta on top, its files, then the chosen file's diff)
  gitDetailPane(d) {
    const pane = v_flex().id("git-detail").flex_1().min_w(0).h_full()
      .child(h_flex().flex_none().h(36).px(12).gap(8).items_center().bg(C.head).border_b(1).border_color(C.line)
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(700).text_color(C.dim).child(d?.commit ? `커밋 상세 · ${d.hash.slice(0, 10)}` : "커밋 상세"))
        .child(this.gitTextBtn("git-detail-close", "상세 닫기", "그래프만 보기 (같은 커밋을 다시 눌러도 닫힘)", () => this.gitShowDetail(null))));
    if (!d) return pane.child(this.gitEmpty("커밋을 누르면 상세가 여기에 보임"));
    if (d.state === "error") return pane.child(this.gitEmpty(`커밋을 읽지 못함\n${d.error ?? ""}`, true));
    const c = d.commit, font = mono();
    if (!c) return pane.child(this.gitEmpty("불러오는 중…"));
    const meta = (k, v, color = P.muted, f = null) => h_flex().id(`gm-${k}`).gap(10).items_start().child(div().w(52).flex_none().text_size(12).text_color(C.dim).child(k))
      .child(div().flex_1().min_w(0).text_size(13).text_color(color).when(!!f, (e) => e.font_family(f)).child(v));
    const merge = c.parents.length > 1;
    const top = v_flex().id("git-commit-meta").flex_none().max_h(220).overflow_y_scrollbar().px(14).py(10).gap(5).border_b(1).border_color(C.line)
      .child(div().text_size(15).font_weight(800).text_color(P.ink).child(c.subject))
      .when(!!c.body, (e) => e.child(v_flex().pb(4).children(c.body.split("\n").map((l, i) => div().id(`gb-${i}`).text_size(13).text_color(P.muted).child(l || " ")))))
      .when(c.refs.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(c.refs.map((r, i) => this.gitRefChip(r, P.blue, `gcr-${i}`)))))
      .child(meta("커밋", c.hash, P.blue, font))
      .child(meta("부모", c.parents.map((p) => p.slice(0, 8)).join(", ") + (merge ? "  (병합 커밋: 첫 번째 부모와 비교)" : "") || "없음 (첫 커밋)", P.muted, font))
      .child(meta("작성자", `${c.author} <${c.email}>`))
      .child(meta("날짜", `${stamp(c.time)} · ${ago(c.time)}`))
      .when(!!c.committer && c.committer !== c.author, (e) => e.child(meta("커미터", c.committer)));
    const files = d.files, add = (files ?? []).reduce((n, f) => n + f.add, 0), del = (files ?? []).reduce((n, f) => n + f.del, 0);
    const scol = (s) => s === "A" ? C.add : s === "D" ? C.del : s === "R" ? C.tag : P.blue;
    const listH = Math.min(190, 10 + 29 * Math.max(1, files?.length ?? 1)); // the files above the diff: up to about six rows, then a scroll
    const fileList = v_flex().id("git-files").flex_none().border_b(1).border_color(C.line)
      .child(h_flex().flex_none().h(32).px(12).gap(8).items_center().border_b(1).border_color(C.line).text_size(13)
        .child(div().font_weight(700).text_color(P.ink).child(files ? `변경 파일 ${files.length}개` : "변경 파일"))
        .when(add > 0, (e) => e.child(div().text_color(C.add).child(`+${add}`))).when(del > 0, (e) => e.child(div().text_color(C.del).child(`−${del}`))))
      .child(div().id("git-files-scroll").h(listH).overflow_y_scrollbar().p(4).child(v_flex().gap(1).children(!files ? [div().p(8).text_size(13).text_color(P.muted).child("불러오는 중…")]
        : !files.length ? [div().p(8).text_size(13).text_color(P.muted).child("변경 파일 없음")]
        : files.map((f, i) => { const parts = f.path.split("/"), nm = parts.pop(), on = d.file === f.path;
          return h_flex().id(`gf-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().when(on, (e) => e.bg(C.sel)).hover((s) => s.bg(on ? C.sel : C.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.gitOpenDiff(d, f, cx); }).tooltip(f.path)
            .child(div().w(14).flex_none().font_family(font).text_size(12).font_weight(800).text_color(scol(f.status)).child(f.status))
            .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_size(13).text_color(P.ink).child(nm)).child(div().min_w(0).ml(6).truncate().text_size(11).text_color(C.dim).child(parts.join("/"))))
            .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(C.add).child(`+${f.add}`)))
            .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(C.del).child(`−${f.del}`))); }))));
    let diff = v_flex().id("git-diff").flex_1().min_h(0).min_w(0);
    if (!d.file) diff = diff.child(this.gitEmpty(files && !files.length ? "" : "위에서 파일을 누르면 diff 표시"));
    else {
      const rows = d.diff?.rows;
      diff = diff.child(h_flex().flex_none().h(30).px(12).items_center().border_b(1).border_color(C.line).child(div().min_w(0).truncate().font_family(font).text_size(13).text_color(P.ink).child(d.file)))
        .child(div().flex_1().min_h(0).relative().font_family(font).text_size(12)
          .child(!rows ? div().p(12).text_color(C.dim).child("diff 읽는 중…")
            : div().id("git-diff-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(d.diff.width).h_full()
              .child(v_virtual_list("git-diff-rows", rows.length, DIFF_ROW, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r) => this.gitDiffRow(r))).size_full())))
          .when(!!rows, (e) => e.child(Scrollbar.vertical("git-diff-rows").absolute().inset_0())));
    }
    return pane.child(top).child(fileList).child(diff);
  }
  gitDiffRow({ kind, old, next, text }) {
    if (kind === "@") return div().w_full().h(DIFF_ROW).flex_none().px(12).flex().items_center().truncate().bg("#1e2a3d").text_color(C.dim).child(text);
    const num = (v) => div().w(40).flex_none().text_right().text_color("#5d6b80").child(v === undefined ? "" : String(v));
    return h_flex().w_full().h(DIFF_ROW).flex_none().gap(8).items_center().when(kind === "+", (e) => e.bg("#7bd88f1f")).when(kind === "-", (e) => e.bg("#ff8a8a1f"))
      .child(num(old)).child(num(next))
      .child(div().w(12).flex_none().text_color(kind === "+" ? C.add : kind === "-" ? C.del : C.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(kind === "+" ? "#c8f5d2" : kind === "-" ? "#ffd0d0" : P.ink).child(text));
  }
}
