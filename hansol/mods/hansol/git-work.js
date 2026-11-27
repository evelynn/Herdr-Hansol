// hansol (2026-11-27): the Git window's other sides, next to "커밋 상세" (git-tree.js): 변경 (the working tree: stage, commit,
// push, switch branch), 원격 (GitHub PRs and CI runs through `gh`, GitLab MRs, issues and pipelines through py/hansol-gitlab.py)
// and 도구 (the folder in Explorer / VS Code, a terminal there, the project's npm scripts, the .env keys, the listening ports).
// The writes: stage / unstage / commit at a press; push only after the confirm window; a switch is refused while files are changed.
import { div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar, Input, InputState } from "gpui-base";
import { exec, notify, openOverlay, props, readTextFile, run, setShared, shared } from "herdr";
import { P } from "./common.js";
import { C, mono, git, errText, gitOpenWin } from "./git-tree.js";
import { NEON, NEON_FILL, cutRow, isMz } from "./mz-ui.js";
import { statusArgs, parseStatus, stageArgs, unstageArgs, commitArgs, workDiffArgs, pushArgs, branchesArgs, parseBranches, switchArgs, canSwitch,
  remotesArgs, parseRemotes, remoteUrlArgs, remoteInfo, diffRows, parseListening, envMissing, packageScripts, ago } from "./git-rules.js";

const PUSH_REQ = "hansol.gitPushReq", DIFF_ROW = 20;
const TABS = [["commit", "커밋 상세"], ["changes", "변경"], ["remote", "원격"], ["tools", "도구"]];
const secs = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t / 1000 : null; };
const winPath = (p) => String(p ?? "").replace(/\//g, "\\");
const CI = { success: C.add, passed: C.add, failure: C.del, failed: C.del, canceled: C.dim, cancelled: C.dim, skipped: C.dim, manual: C.tag, running: P.blue, in_progress: P.blue, pending: C.tag, queued: C.tag, created: C.tag };

// The push itself (run by the Git window that has the repository open; the confirm window only leaves the request).
async function runPush(req) {
  try { return await exec("git", req.args, { cwd: req.root, on: req.on ?? null, timeout: 120000 }); } catch (e) { return { code: 1, stderr: String(e?.message ?? e) }; }
}

// shortcut: the changed files' list draws the first 200 only (748 rows overran the frame and the view was "interrupted"); a virtual list if a long list must be browsed
const LIST_MAX = 200;
export class GitWorkPart {
  // From initGit (a live host call: the input is made here, never in a draw). The push requests are read every 400 ms (a shared read).
  gitWorkInit(cx) {
    const g = this.gw;
    g.pane = props()?.pane ?? "commit"; g.work = { state: "idle", items: [], sel: null, diff: null, branches: null, brOpen: false };
    try { this.gitMsgIn = InputState.new({ placeholder: "커밋 메시지 (스테이지한 파일만 커밋)" }); } catch { this.gitMsgIn = null; }
    if (g.pane !== "commit") cx.spawn(async (cx2) => this.gitPaneLoad(cx2));
    cx.spawn(async (cx2) => this.gitLoadStatus(cx2)); // the "변경 N" count on the tool row
    cx.timer.every(400, (cx2) => {
      const d = shared("hansol.gitDo"); if (d?.at && d.at !== g.doAt && Date.now() - d.at < 15000) { g.doAt = d.at; this.gitReview(String(d.cmd), cx2); }
      const r = shared(PUSH_REQ); if (!r || r.done || r.root !== g.root || (r.on ?? null) !== (g.on ?? null) || r.at === g.pushAt || g.net || g.writing) return; // (busy: taken on a later tick)
      if (Date.now() - r.at > 30000) { setShared(PUSH_REQ, { ...r, done: true }); return; } // a yes older than 30 s is dropped: the repository may have moved on since the dialog
      g.pushAt = r.at; setShared(PUSH_REQ, { ...r, done: true });
      g.msg = { text: "푸시하는 중…" }; g.net = "push"; cx2.notify();
      cx2.spawn(async (cx3) => {
        const res = await runPush(r);
        g.net = null; g.msg = res.code ? { err: true, text: `푸시 실패: ${errText(res)}` } : { text: `푸시 완료: ${r.label}` };
        try { notify({ title: res.code ? "푸시 실패" : "푸시 완료", body: res.code ? errText(res).slice(0, 160) : r.label, level: res.code ? "error" : "success" }); } catch {}
        await this.gitSync(cx3); g.sig = null; await this.gitLoadLog(cx3); cx3.notify();
      });
    });
  }
  // A side is opened: in a window that already has the right side, in place; else the window opens again at the wider size.
  gitPane(pane, cx) {
    const g = this.gw, split = !!props()?.hash || !!props()?.pane;
    if (!split) return gitOpenWin("git-graph", { ...this.gitBase(), pane });
    g.pane = pane; cx.notify(); cx.spawn(async (cx2) => this.gitPaneLoad(cx2));
  }
  async gitPaneLoad(cx) {
    const g = this.gw;
    if (g.pane === "changes") return this.gitLoadStatus(cx, true);
    if (g.pane === "remote" && !g.remote) return this.gitLoadRemote(cx);
    if (g.pane === "tools" && !g.tools) return this.gitLoadTools(cx);
  }

  // ---- 변경
  async gitLoadStatus(cx, branches = false) {
    const w = this.gw.work, g = this.gw;
    try {
      const r = await git(g.root, g.on, statusArgs());
      if (r.code) { w.state = "error"; w.error = errText(r); }
      else { w.items = parseStatus(r.stdout); w.state = "ready"; if (w.sel && !w.items.some((x) => x.path === w.sel)) { w.sel = null; w.diff = null; } }
      if (branches) { const b = await git(g.root, g.on, branchesArgs()); w.branches = b.code ? [] : parseBranches(b.stdout); }
    } catch (e) { w.state = "error"; w.error = String(e?.message ?? e); }
    cx.notify();
  }
  // One write at a time; the list and the log are read again after it.
  gitWrite(args, okText, cx, after = null) { cx.spawn(async (cx2) => this.gitWriteRun(args, okText, cx2, after)); } // (an event's or a timer's cx; a task's cx has no spawn: it awaits gitWriteRun)
  async gitWriteRun(args, okText, cx, after = null) {
    const g = this.gw; if (g.writing) { g.msg = { err: true, text: "다른 Git 작업이 실행 중임 (끝난 뒤 다시 누르기)" }; return cx.notify(); } g.writing = true; cx.notify();
    let r; try { r = await exec("git", args, { cwd: g.root, on: g.on ?? null, timeout: 300000 }); } catch (e) { r = { code: 1, stderr: String(e?.message ?? e) }; } // (a commit hook or signing can take long)
    g.writing = false; g.msg = r.code ? { err: true, text: errText(r) } : okText ? { text: okText } : g.msg;
    if (!r.code) after?.();
    await this.gitLoadStatus(cx, true); if (!r.code) { g.sig = null; await this.gitLoadLog(cx); await this.gitSync(cx); }
    cx.notify();
  }
  gitToggle(item, cx) { this.gitWrite(item.staged && !item.changed ? unstageArgs([item.path]) : stageArgs([item.path]), null, cx); }
  gitCommit(cx) { // (the list is read again first: what is staged now, not at the last draw)
    const g = this.gw, msg = String(this.gitMsgIn?.value() ?? "").trim();
    if (!msg) { g.msg = { err: true, text: "커밋 메시지를 입력해야 함" }; return cx.notify(); }
    cx.spawn(async (cx2) => {
      await this.gitLoadStatus(cx2); const staged = g.work.items.filter((x) => x.staged).length;
      if (!staged) { g.msg = { err: true, text: "스테이지한 파일이 없음 (파일 왼쪽 상자를 눌러 스테이지)" }; return cx2.notify(); }
      await this.gitWriteRun(commitArgs(msg), `커밋 완료 (파일 ${staged}개)`, cx2, () => { try { this.gitMsgIn?.set_value(""); } catch {} });
    });
  }
  gitSwitch(name, cx) { // (the status is read again first: a file changed a moment ago counts)
    const g = this.gw;
    cx.spawn(async (cx2) => {
      await this.gitLoadStatus(cx2);
      if (g.work.state !== "ready" || !canSwitch(g.work.items)) { g.msg = { err: true, text: "변경된 파일이 있어 브랜치를 바꾸지 않음 (커밋하거나 되돌린 뒤 다시 시도)" }; return cx2.notify(); }
      g.work.brOpen = false; await this.gitWriteRun(switchArgs(name), `브랜치 전환: ${name}`, cx2);
    });
  }
  // The review commands (room.js gitdo:...): the same calls the buttons make.
  gitReview(cmd, cx) {
    const g = this.gw, i = cmd.indexOf(":"), what = i < 0 ? cmd : cmd.slice(0, i), arg = i < 0 ? "" : cmd.slice(i + 1), item = () => g.work.items.find((x) => x.path === arg);
    if (what === "pane") this.gitPane(arg, cx);
    else if (what === "stage-all") this.gitWrite(["add", "-A"], null, cx);
    else if (what === "toggle" && item()) this.gitToggle(item(), cx);
    else if (what === "diff" && item()) this.gitWorkDiff(item(), cx);
    else if (what === "commit") { try { this.gitMsgIn?.set_value(arg); } catch {} this.gitCommit(cx); }
    else if (what === "push" || what === "push-yes") this.gitAskPush(cx, what === "push-yes");
    else if (what === "switch") this.gitSwitch(arg, cx);
    else if (what === "tool") this.gitTool(arg.split(":")[0], cx, arg.split(":")[1] ?? null);
  }
  // Push: the confirm window says where to (branch -> upstream, how many commits); its yes leaves the request this window runs.
  gitAskPush(cx, yes = false) {
    const g = this.gw;
    cx.spawn(async (cx2) => {
      await this.gitLoadStatus(cx2, true); await this.gitSync(cx2); // the branch and its upstream as they are now, not at the last draw
      const branch = (g.work.branches ?? []).find((b) => b.head)?.name;
      let remotes = []; try { remotes = parseRemotes((await git(g.root, g.on, remotesArgs())).stdout); } catch {}
      const args = pushArgs(g.upstream, remotes, branch);
      if (!args) { g.msg = { err: true, text: branch ? "푸시할 원격 저장소가 없음" : "브랜치가 아님 (detached HEAD)" }; return cx2.notify(); }
      if (g.upstream && !(g.sync?.ahead > 0)) { g.msg = { text: "올릴 커밋이 없음" }; return cx2.notify(); }
      const target = g.upstream ?? `${args[2]}/${branch} (새로 만듦, 추적 설정)`, n = g.sync?.ahead;
      const label = `${branch} → ${target}${n != null ? ` · 커밋 ${n}개` : ""}`;
      if (yes) return gitPushYes({ root: g.root, on: g.on, args, label }); // (review: as the confirm window's yes)
      openOverlay({ mod: "hansol", kind: "dialog", modal: true, width: 460, height: 230,
        props: { role: "confirm", action: "git-push", title: "푸시 확인", yes: "푸시", text: `${label}\n\n저장소: ${g.root}\n명령: git ${args.join(" ")}`, root: g.root, on: g.on, args, label } });
    });
  }
  gitWorkDiff(item, cx) {
    const g = this.gw, w = g.work; w.sel = item.path; w.diff = null; cx.notify();
    cx.spawn(async (cx2) => {
      let rows;
      try { const r = await git(g.root, g.on, workDiffArgs(item)); rows = diffRows(r.stdout) ?? [{ kind: "", text: r.code > 1 ? errText(r) : "텍스트 변경 없음 (바이너리이거나 모드만 바뀜)" }]; }
      catch (e) { rows = [{ kind: "", text: `diff를 읽지 못함: ${e?.message ?? e}` }]; }
      if (w.sel === item.path) { w.diff = { rows, width: Math.max(400, ...rows.map((r) => r.text.length * 7.4 + 110)) }; cx2.notify(); }
    });
  }

  // ---- 원격
  async gitLoadRemote(cx) {
    const g = this.gw, R = (g.remote = { state: "loading" }); cx.notify();
    try {
      const names = parseRemotes((await git(g.root, g.on, remotesArgs())).stdout).sort((a, b) => (a !== "origin") - (b !== "origin"));
      let info = null; for (const n of names) { const u = await git(g.root, g.on, remoteUrlArgs(n)); info = u.code ? null : remoteInfo(u.stdout); if (info) break; }
      R.info = info;
      if (!info) { R.state = "none"; return cx.notify(); }
      if (g.on) { R.state = "local-only"; return cx.notify(); }
      if (info.kind === "github") {
        const [pr, rn] = await Promise.all([
          exec("gh", ["pr", "list", "--limit", "20", "--json", "number,title,headRefName,author,url,isDraft,updatedAt"], { cwd: g.root, timeout: 30000 }),
          exec("gh", ["run", "list", "--limit", "10", "--json", "displayTitle,status,conclusion,headBranch,workflowName,url,createdAt"], { cwd: g.root, timeout: 30000 })]);
        if (pr.code && rn.code) { R.state = "error"; R.error = `gh: ${errText(pr)}`; return cx.notify(); }
        R.prs = pr.code ? [] : JSON.parse(pr.stdout || "[]"); R.runs = rn.code ? [] : JSON.parse(rn.stdout || "[]"); R.state = "ready";
      } else if (info.kind === "gitlab") {
        if (!this.feed?.config) await this.loadConfig();
        const c = this.feed?.config, script = String(c?.collector ?? "").replace(/[^\\/]+$/, "hansol-gitlab.py");
        if (!c?.python || !script) { R.state = "error"; R.error = "python 설정(config.json)이 없음"; return cx.notify(); }
        const r = await exec(c.python, [script, g.root], { timeout: 60000 }), d = JSON.parse(String(r.stdout || "{}"));
        if (!d.ok) { R.state = "error"; R.error = d.error ?? errText(r); return cx.notify(); }
        Object.assign(R, { state: "ready", mrs: d.mrs ?? [], issues: d.issues ?? [], pipelines: d.pipelines ?? [] });
      } else R.state = "other";
    } catch (e) { R.state = "error"; R.error = String(e?.message ?? e); }
    cx.notify();
  }

  // ---- 도구
  async gitLoadTools(cx) {
    const g = this.gw, T = (g.tools = { state: "loading" }); cx.notify();
    const read = async (name) => { try { return await readTextFile(`${g.root}/${name}`, { on: g.on }); } catch { return null; } };
    const [pkg, env, ex, sample] = await Promise.all([read("package.json"), read(".env"), read(".env.example"), read(".env.sample")]);
    T.scripts = pkg ? packageScripts(pkg) : [];
    const example = ex ?? sample;
    T.env = { has: env != null, example: example != null ? (ex != null ? ".env.example" : ".env.sample") : null, missing: example != null ? envMissing(example, env ?? "") : [] };
    T.state = "ready"; cx.notify();
    if (!g.on) await this.gitLoadPorts(cx);
  }
  async gitLoadPorts(cx) {
    const T = this.gw.tools; T.ports = null; cx.notify();
    try { const [ns, tl] = await Promise.all([exec("netstat", ["-ano", "-p", "tcp"], { timeout: 15000 }), exec("tasklist", ["/fo", "csv", "/nh"], { timeout: 15000 })]); T.ports = parseListening(ns.stdout, tl.stdout); }
    catch (e) { T.ports = []; T.portErr = String(e?.message ?? e); }
    cx.notify();
  }
  gitTool(kind, cx, arg = null) {
    const g = this.gw, root = g.root, say = (text, err = false) => { g.msg = { err, text }; cx.notify(); };
    const go = (cmd, args, text) => cx.spawn(async (c2) => { try { await exec(cmd, args, { timeout: 15000 }); g.msg = { text }; } catch (e) { g.msg = { err: true, text: `${text} 실패: ${e?.message ?? e}` }; } c2.notify(); });
    if (kind === "explorer") return go("explorer", [winPath(root)], "탐색기로 열었음"); // (explorer answers 1 even when it worked)
    if (kind === "code") return go("cmd", ["/c", "code", winPath(root)], "VS Code로 열었음");
    if (kind === "web" && g.remote?.info?.web) return cx.open_url(g.remote.info.web);
    if (kind === "terminal") { try { run("tab.new", { folder: root, name: root.split("/").pop() }); say("새 터미널 탭을 열었음"); } catch (e) { say(String(e?.message ?? e), true); } return; }
    if (kind === "script") { if (!/^[\w:.@/-]+$/.test(String(arg))) return say(`실행하지 않음: 스크립트 이름에 쓸 수 없는 글자가 있음 (${arg})`, true); // (the name comes from the repository's package.json)
      try { run("tab.new", { folder: root, name: `npm ${arg}`, argv: ["cmd", "/k", "npm", "run", arg] }); say(`새 탭에서 실행: npm run ${arg}`); } catch (e) { say(String(e?.message ?? e), true); } }
  }

  // ---- drawing
  gitTabs(count) {
    const g = this.gw;
    return h_flex().id("git-tabs").flex_none().h(36).px(8).gap(4).items_center().bg(C.head).border_b(1).border_color(C.line)
      .children(TABS.map(([key, label]) => { const on = g.pane === key, text = key === "changes" && count ? `${label} ${count}` : label;
        if (isMz()) return cutRow(h_flex().id(`git-tab-${key}`).flex_none().items_center().cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.gitPane(key, cx); }),
          26, 7, on ? NEON_FILL : "#00000000", on ? NEON : "#00000000", div().px(5).flex().items_center().text_size(12).font_weight(700).text_color(on ? NEON : C.dim).hover((s) => s.text_color("#ffffff")).child(text));
        return div().id(`git-tab-${key}`).flex_none().h(26).px(12).flex().items_center().rounded(6).text_size(12).font_weight(700).cursor_pointer()
          .bg(on ? P.blue : "#00000000").text_color(on ? "#ffffff" : C.dim).hover((s) => s.bg(on ? P.blue : C.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.gitPane(key, cx); }).child(text); }))
      .child(div().flex_1())
      .child(this.gitTextBtn("git-detail-close", "닫기", "그래프만 보기", () => { const b = { ...this.gitBase(), hash: null, file: null, pane: null }; gitOpenWin("git-graph", b); }));
  }
  // The right side: the tabs, then the chosen side (the commit side is git-tree.js's).
  gitRightPane() {
    const g = this.gw, n = g.work?.items?.length ?? 0, pane = v_flex().id("git-right").flex_1().min_w(0).h_full().child(this.gitTabs(n));
    if (g.pane === "changes") return pane.child(this.gitChangesPane());
    if (g.pane === "remote") return pane.child(this.gitRemotePane());
    if (g.pane === "tools") return pane.child(this.gitToolsPane());
    return pane.child(this.gitDetailPane(g.detail));
  }
  gitSection(id, title, right = null) {
    return h_flex().id(id).flex_none().h(30).px(12).gap(8).items_center().border_b(1).border_color(C.line).bg("#1a2536")
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(800).text_color(P.ink).child(title)).when(!!right, (e) => e.child(right));
  }
  gitLinkRow(id, left, title, sub, right, url, rightColor = C.dim) {
    return h_flex().id(id).flex_none().h(30).px(12).gap(10).items_center().cursor_pointer().hover((s) => s.bg(C.hover)).tooltip(url ? `${title}\n${url}` : title)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); if (url) cx.open_url(url); })
      .child(div().w(72).flex_none().whitespace_nowrap().truncate().font_family(mono()).text_size(12).text_color(P.blue).child(left))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(P.ink).child(title))
      .child(div().flex_none().max_w(160).truncate().text_size(11).text_color(C.dim).child(sub))
      .child(div().w(70).flex_none().text_right().truncate().text_size(11).font_weight(700).text_color(rightColor).child(right));
  }
  gitChangesPane() {
    const g = this.gw, w = g.work, items = w.items ?? [], staged = items.filter((x) => x.staged).length, br = (w.branches ?? []).find((b) => b.head);
    const box = (x) => { const full = x.staged && !x.changed, half = x.staged && x.changed;
      return div().flex_none().w(16).h(16).rounded(4).border(1).border_color(x.staged ? P.blue : C.dim).bg(full ? P.blue : half ? P.blue + "55" : "#00000000")
        .flex().items_center().justify_center().text_size(11).font_weight(800).text_color("#ffffff").child(full ? "✓" : half ? "–" : ""); };
    const scol = (x) => x.untracked ? C.add : (x.staged ? x.x : x.y) === "D" ? C.del : (x.staged ? x.x : x.y) === "A" ? C.add : P.blue;
    const head = h_flex().id("git-work-head").flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(C.line)
      .child(this.gitTextBtn("git-branch-pick", `브랜치: ${br?.name ?? "(없음)"} ▾`, "로컬 브랜치 목록 (누르면 전환)", (cx) => { w.brOpen = !w.brOpen; cx.notify(); }))
      .child(div().flex_1())
      .child(this.gitTextBtn("git-stage-all", "모두 스테이지", "git add -A", (cx) => this.gitWrite(["add", "-A"], null, cx)))
      .child(this.gitTextBtn("git-unstage-all", "모두 내리기", "git restore --staged :/", (cx) => this.gitWrite(["restore", "--staged", ":/"], null, cx)))
      .child(this.gitTextBtn("git-work-refresh", "다시 읽기", "작업 파일 상태 다시 읽기", (cx) => cx.spawn(async (cx2) => this.gitLoadStatus(cx2, true))));
    const brList = !w.brOpen ? null : v_flex().id("git-branches").flex_none().max_h(160).overflow_y_scrollbar().border_b(1).border_color(C.line).py(2)
      .children((w.branches ?? []).map((b, i) => h_flex().id(`git-br-${i}`).h(26).px(14).gap(8).items_center().cursor_pointer().hover((s) => s.bg(C.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); if (!b.head) this.gitSwitch(b.name, cx); })
        .child(div().w(14).flex_none().text_color(P.blue).child(b.head ? "●" : "")).child(div().flex_1().min_w(0).truncate().text_size(13).text_color(P.ink).child(b.name))
        .child(div().flex_none().text_size(11).text_color(C.dim).child(b.upstream ?? "원격 없음"))));
    const files = v_flex().id("git-work-files").flex_none().max_h(220).overflow_y_scrollbar().p(4).gap(1)
      .children(w.state !== "ready" ? [div().p(8).text_size(13).text_color(w.state === "error" ? C.del : P.muted).child(w.state === "error" ? w.error : "읽는 중…")]
        : !items.length ? [div().p(8).text_size(13).text_color(P.muted).child("변경된 파일 없음 (작업 트리 깨끗함)")]
        : [...items.slice(0, LIST_MAX).map((x, i) => { const parts = x.path.split("/"), nm = parts.pop(), on = w.sel === x.path;
          return h_flex().id(`gw-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().when(on, (e) => e.bg(C.sel)).hover((s) => s.bg(on ? C.sel : C.hover)).tooltip(x.from ? `${x.from} → ${x.path}` : x.path)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.gitWorkDiff(x, cx); })
            .child(div().id(`gw-box-${i}`).flex_none().cursor_pointer().tooltip(x.staged && !x.changed ? "스테이지 내리기" : "스테이지").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.gitToggle(x, cx); }).child(box(x)))
            .child(div().w(20).flex_none().font_family(mono()).text_size(12).font_weight(800).text_color(scol(x)).child(x.untracked ? "U" : `${x.x.trim()}${x.y.trim()}`))
            .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_size(13).text_color(P.ink).child(nm)).child(div().min_w(0).ml(6).truncate().text_size(11).text_color(C.dim).child(parts.join("/")))); }), ...(items.length > LIST_MAX ? [div().p(8).text_size(12).text_color(P.muted).child(`외 ${items.length - LIST_MAX}개는 목록에서 생략 (모두 스테이지·내리기는 전체에 적용)`)] : [])]);
    const ahead = g.sync?.ahead ?? 0, canPush = !!br && (ahead > 0 || !g.upstream);
    const commit = h_flex().id("git-commit-row").flex_none().px(12).py(8).gap(8).items_center().border_t(1).border_b(1).border_color(C.line)
      .child(div().flex_1().min_w(0).child(this.gitMsgIn ? Input.new(this.gitMsgIn) : div().text_color(C.del).child("입력 칸을 만들지 못함")))
      .child(this.gitTextBtn("git-commit", g.writing ? "실행 중…" : `커밋${staged ? ` (${staged})` : ""}`, "스테이지한 파일을 이 메시지로 커밋 (git commit -m)", (cx) => this.gitCommit(cx)))
      .child(this.gitTextBtn("git-push", g.net === "push" ? "푸시 중…" : !g.upstream ? "푸시 (새 원격 브랜치)" : `푸시 ↑${ahead}`, canPush ? "확인 창을 거쳐 푸시" : "올릴 커밋이 없음", (cx) => { if (canPush && !g.net) this.gitAskPush(cx); }, canPush));
    let diff = v_flex().id("git-work-diff").flex_1().min_h(0).min_w(0);
    if (!w.sel) diff = diff.child(this.gitEmpty(items.length ? "파일을 누르면 diff 표시 · 왼쪽 상자: 스테이지" : ""));
    else { const rows = w.diff?.rows;
      diff = diff.child(h_flex().flex_none().h(30).px(12).items_center().border_b(1).border_color(C.line).child(div().min_w(0).truncate().font_family(mono()).text_size(13).text_color(P.ink).child(w.sel)))
        .child(div().flex_1().min_h(0).relative().font_family(mono()).text_size(12)
          .child(!rows ? div().p(12).text_color(C.dim).child("diff 읽는 중…")
            : div().id("git-work-diff-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(w.diff.width).h_full()
              .child(v_virtual_list("git-work-rows", rows.length, DIFF_ROW, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r) => this.gitDiffRow(r))).size_full())))
          .when(!!rows, (e) => e.child(Scrollbar.vertical("git-work-rows").absolute().inset_0()))); }
    return v_flex().id("git-changes").flex_1().min_h(0).child(head).when(!!brList, (e) => e.child(brList)).child(files).child(commit).child(diff);
  }
  gitRemotePane() {
    const g = this.gw, R = g.remote ?? { state: "loading" }, info = R.info;
    const top = h_flex().id("git-remote-head").flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(C.line)
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(P.ink).child(info ? `${info.kind === "github" ? "GitHub" : info.kind === "gitlab" ? "GitLab" : "원격"} · ${info.host}/${info.path}` : "원격 저장소"))
      .when(!!info?.web, (e) => e.child(this.gitTextBtn("git-remote-web", "웹에서 열기", info.web, (cx) => cx.open_url(info.web))))
      .child(this.gitTextBtn("git-remote-refresh", R.state === "loading" ? "읽는 중…" : "다시 읽기", "원격 목록 다시 읽기", (cx) => cx.spawn(async (cx2) => this.gitLoadRemote(cx2))));
    const body = v_flex().id("git-remote-body").flex_1().min_h(0).overflow_y_scrollbar();
    const msg = { loading: info?.kind === "gitlab" ? "GitLab에서 읽는 중… (10초 이상 걸릴 수 있음)" : "읽는 중…", none: "원격 저장소가 없음", "local-only": "원격 머신의 저장소: PR·MR 보기는 이 PC 저장소에서만 됨", other: "GitHub·GitLab이 아닌 원격: 웹에서 열기만 가능", error: `읽지 못함: ${R.error ?? ""}` }[R.state];
    if (msg) return v_flex().id("git-remote").flex_1().min_h(0).child(top).child(this.gitEmpty(msg, R.state === "error"));
    const none = (t) => div().px(12).py(8).text_size(12).text_color(C.dim).child(t);
    if (info.kind === "github") {
      body.child(this.gitSection("git-pr-head", `열린 PR ${R.prs.length}개`))
        .children(R.prs.length ? R.prs.map((p, i) => this.gitLinkRow(`git-pr-${i}`, `#${p.number}`, `${p.isDraft ? "[초안] " : ""}${p.title}`, `${p.headRefName} · ${p.author?.login ?? ""}`, ago(secs(p.updatedAt)), p.url)) : [none("열린 PR 없음")])
        .child(this.gitSection("git-run-head", `CI 실행 (최근 ${R.runs.length}개)`))
        .children(R.runs.length ? R.runs.map((r, i) => { const st = r.status === "completed" ? r.conclusion || "completed" : r.status;
          return this.gitLinkRow(`git-run-${i}`, ago(secs(r.createdAt)), r.displayTitle, `${r.workflowName} · ${r.headBranch}`, st, r.url, CI[st] ?? C.dim); }) : [none("CI 실행 기록 없음")]);
    } else {
      body.child(this.gitSection("git-mr-head", `열린 MR ${R.mrs.length}개`))
        .children(R.mrs.length ? R.mrs.map((m, i) => this.gitLinkRow(`git-mr-${i}`, `!${m.iid}`, `${m.draft ? "[초안] " : ""}${m.title}`, `${m.source} → ${m.target} · ${m.author}`, ago(secs(m.updated)), m.url)) : [none("열린 MR 없음")])
        .child(this.gitSection("git-issue-head", `열린 이슈 ${R.issues.length}개`))
        .children(R.issues.length ? R.issues.map((m, i) => this.gitLinkRow(`git-is-${i}`, `#${m.iid}`, m.title, [m.author, ...(m.labels ?? [])].join(" · "), ago(secs(m.updated)), m.url)) : [none("열린 이슈 없음")])
        .child(this.gitSection("git-pipe-head", `파이프라인 (최근 ${R.pipelines.length}개)`))
        .children(R.pipelines.length ? R.pipelines.map((p, i) => this.gitLinkRow(`git-pl-${i}`, ago(secs(p.created)), `#${p.id}`, p.ref, p.status, p.url, CI[p.status] ?? C.dim)) : [none("파이프라인 없음")]);
    }
    return v_flex().id("git-remote").flex_1().min_h(0).child(top).child(body);
  }
  gitToolsPane() {
    const g = this.gw, T = g.tools ?? { state: "loading" }, local = !g.on;
    const btns = h_flex().id("git-tool-btns").flex_none().px(12).py(8).gap(8).flex_wrap().border_b(1).border_color(C.line)
      .when(local, (e) => e.child(this.gitTextBtn("git-t-explorer", "탐색기로 열기", winPath(g.root), (cx) => this.gitTool("explorer", cx)))
        .child(this.gitTextBtn("git-t-code", "VS Code로 열기", "code <폴더>", (cx) => this.gitTool("code", cx))))
      .when(local, (e) => e.child(this.gitTextBtn("git-t-term", "이 폴더에서 새 터미널", "새 탭 (Herdr)", (cx) => this.gitTool("terminal", cx))))
      .when(!!g.remote?.info?.web, (e) => e.child(this.gitTextBtn("git-t-web", "저장소 웹", g.remote.info.web, (cx) => this.gitTool("web", cx))));
    const body = v_flex().id("git-tools-body").flex_1().min_h(0).overflow_y_scrollbar();
    if (T.state !== "ready") return v_flex().id("git-tools").flex_1().min_h(0).child(btns).child(this.gitEmpty("읽는 중…"));
    const line = (id, text, color = P.muted) => div().id(id).px(12).py(5).text_size(12).text_color(color).child(text);
    body.child(this.gitSection("git-t-scripts", `프로젝트 명령 (package.json) ${T.scripts.length}개`))
      .children(T.scripts.length ? T.scripts.map((s, i) => h_flex().id(`git-sc-${i}`).h(28).px(12).gap(10).items_center().cursor_pointer().hover((e) => e.bg(C.hover)).tooltip(`새 탭에서 npm run ${s.name}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); if (local) this.gitTool("script", cx, s.name); })
        .child(div().w(120).flex_none().truncate().font_family(mono()).text_size(12).font_weight(700).text_color(P.blue).child(s.name))
        .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(12).text_color(C.dim).child(s.cmd))) : [line("git-sc-none", "package.json의 scripts 없음")]);
    const e = T.env;
    body.child(this.gitSection("git-t-env", ".env 점검 (키 이름만, 값은 읽어 보이지 않음)"))
      .child(line("git-env-1", e.example ? `${e.example} 기준 · .env ${e.has ? "있음" : "없음"}` : e.has ? ".env 있음 · 비교할 .env.example 없음" : ".env·.env.example 없음", e.example && !e.has ? C.tag : P.muted))
      .when(!!e.example, (el) => el.child(line("git-env-2", e.missing.length ? `.env에 빠진 키 ${e.missing.length}개: ${e.missing.join(", ")}` : "빠진 키 없음", e.missing.length ? C.tag : C.add)));
    if (local) body.child(this.gitSection("git-t-ports", `열린 포트 (LISTENING) ${T.ports ? T.ports.length + "개" : ""}`, this.gitTextBtn("git-t-ports-re", "다시 읽기", "netstat -ano", (cx) => cx.spawn(async (cx2) => this.gitLoadPorts(cx2)))))
      .children(!T.ports ? [line("git-pt-wait", "읽는 중…")] : T.ports.map((p, i) => h_flex().id(`git-pt-${i}`).h(24).px(12).gap(10).items_center()
        .child(div().w(60).flex_none().font_family(mono()).text_size(12).font_weight(700).text_color(P.ink).child(String(p.port)))
        .child(div().w(120).flex_none().truncate().font_family(mono()).text_size(11).text_color(C.dim).child(p.addr))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(P.muted).child(p.name || "?"))
        .child(div().w(70).flex_none().text_right().font_family(mono()).text_size(11).text_color(C.dim).child(`PID ${p.pid}`))));
    return v_flex().id("git-tools").flex_1().min_h(0).child(btns).child(body);
  }
}

// The confirm window's yes (room.js): the request the Git window with that repository runs (the confirm window closes at once).
export function gitPushYes(p) { setShared(PUSH_REQ, { at: Date.now(), root: p.root, on: p.on ?? null, args: p.args, label: p.label }); }
