// hakoniwa: herdr operations from inside the office (★27-1). Pure logic: the App's command caller `run` is handed in,
// so the tests can swap it for a fake and check which commands (and arguments) would be called. Nothing here starts or ends
// an agent by itself: the UI calls launchAgent / endAgent only after the person decided.

// Kinds and how they start. ★108: each CLI as it starts by itself (no permission widened); config.json office.launch.kinds.<kind>.argv
// replaces the start words of a kind (e.g. ["codex", "-s", "workspace-write"]), set by applyLaunchKinds when the config is read.
export const BASE_ARGV = { claude: ["claude"], codex: ["codex"], opencode: ["opencode"], cursor: ["cursor-agent"], agy: ["agy"] };
export const AGENT_KINDS = [
  { key: "claude", label: "Claude Code", argv: [...BASE_ARGV.claude] },
  { key: "codex", label: "Codex", argv: [...BASE_ARGV.codex] },
  { key: "opencode", label: "OpenCode", argv: [...BASE_ARGV.opencode] },
  { key: "cursor", label: "Cursor", argv: [...BASE_ARGV.cursor] },
  { key: "agy", label: "Antigravity", argv: [...BASE_ARGV.agy] },
];
// ★108 office.launch.claude_settings: { persist, effort } (both true when left out). persist: every Claude started here gets a --settings file
// that sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 (below); effort: a chosen effort is also put in that file's env (CLAUDE_CODE_EFFORT_LEVEL).
export const LAUNCH = { persist: true, effortEnv: true };
export function applyLaunchKinds(config) {
  const l = config?.office && typeof config.office === "object" ? config.office.launch : null, kinds = l?.kinds ?? {};
  for (const k of AGENT_KINDS) {
    const a = kinds?.[k.key]?.argv, good = Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === "string" && x.length > 0);
    k.argv = good ? [...a] : [...BASE_ARGV[k.key]];
  }
  const s = l?.claude_settings ?? {};
  LAUNCH.persist = s.persist !== false; LAUNCH.effortEnv = s.effort !== false;
}

// ★79 what can be chosen when starting comes from each CLI's own list (hakoniwa_models.py -> hakoniwa-office/models.json; nothing is typed in here).
// `opts` = normalizeOptions(models.json): { kinds: { <kind>: { models: [{ id, label, efforts? }], efforts: [..] | null } }, at, errors }. "" (default) is always possible.
export const normalizeOptions = (raw) => {
  const kinds = {}, ok = (x) => typeof x === "string" && /^[\w.:/\-]{1,80}$/.test(x), eff = (l) => (Array.isArray(l) ? l.filter(ok) : []);
  for (const [k, v] of Object.entries(raw?.kinds ?? {})) {
    if (!AGENT_KINDS.some((x) => x.key === k) || !Array.isArray(v?.models)) continue;
    kinds[k] = { models: v.models.filter((m) => ok(m?.id)).map((m) => ({ id: m.id, label: String(m.label ?? m.id).slice(0, 60), ...(eff(m.efforts).length ? { efforts: eff(m.efforts) } : {}) })), efforts: eff(v.efforts).length ? eff(v.efforts) : null };
  }
  return { kinds, at: Number(raw?.at) || 0, errors: raw?.errors ?? {} };
};
// The efforts that can be chosen for a kind (and model): null = none.
export const effortsFor = (opts, kind, model) => { const o = opts?.kinds?.[kind]; if (!o) return null; const m = o.models.find((x) => x.id === model); return m?.efforts ?? o.efforts ?? null; };
// Only what really exists for this kind; anything else becomes "" (default).
export function cleanChoice(opts, kind, model, effort) {
  const o = opts?.kinds?.[kind], m = o?.models.some((x) => x.id === model) ? model : "", ef = o ? effortsFor(opts, kind, m || null) : null;
  return { model: m, effort: ef?.includes(effort) ? effort : "" };
}
// A CLAUDE_CODE_EFFORT_LEVEL in a person's own settings.json env beats `claude --effort`: a --settings file whose env sets the chosen effort
// makes the choice win (office.launch.claude_settings.effort: false leaves it to --effort alone). `dir` is where such files are kept (the mod writes them; the plan only names them).
export const effortSettingsFile = (dir, effort) => `${String(dir ?? "").replace(/[\\/]+$/, "")}/effort-${effort}.json`;
// ★95-11: a child inherits CLAUDE_CODE_CHILD_SESSION from a parent Claude and then saves no transcript (the model and the "会話" cannot be read). The App's commands
// take no env, so every Claude started here gets a --settings file whose env sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 (the effort file carries it too).
export const PERSIST_ENV = { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" };
export const persistSettingsFile = (dir) => `${String(dir ?? "").replace(/[\\/]+$/, "")}/persist.json`;
export const persistSettingsText = () => JSON.stringify({ env: PERSIST_ENV });
export const effortSettingsText = (effort) => JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: effort, ...PERSIST_ENV } });
// The start words of a kind with the chosen model / effort added after the permission words. Returns { argv, writes: [{ path, text }] }.
export function kindArgv(kind, model, effort, dir = "", opts = null) {
  const k = AGENT_KINDS.find((x) => x.key === kind); if (!k) return { argv: [], writes: [] };
  const c = cleanChoice(opts, kind, model, effort), argv = [...k.argv], writes = [];
  if (kind === "claude") {
    if (c.model) argv.push("--model", c.model);
    if (c.effort) argv.push("--effort", c.effort);
    if (c.effort && LAUNCH.effortEnv) { const path = effortSettingsFile(dir, c.effort); argv.push("--settings", path); writes.push({ path, text: LAUNCH.persist ? effortSettingsText(c.effort) : JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: c.effort } }) }); }
    else if (dir && LAUNCH.persist) { const path = persistSettingsFile(dir); argv.push("--settings", path); writes.push({ path, text: persistSettingsText() }); }
  }
  else if (kind === "codex") { if (c.model) argv.push("-m", c.model); if (c.effort) argv.push("-c", `model_reasoning_effort="${c.effort}"`); }
  else { if (c.model) argv.push(kind === "opencode" ? "-m" : "--model", c.model); if (c.effort && kind === "agy") argv.push("--effort", c.effort); }
  return { argv, writes };
}
// What was chosen last, to be the next default: { kind, model, effort, parentMode }. Anything unknown is dropped.
export function cleanDefaults(opts, raw) {
  const kind = AGENT_KINDS.some((x) => x.key === raw?.kind) ? raw.kind : "claude";
  return { kind, ...cleanChoice(opts, kind, raw?.model, raw?.effort), parentMode: raw?.parentMode === "child" ? "child" : "parent" };
}

export const NEW_SPACE = "__new__";
// ★68-2 "スペースなし（フリー）": a terminal with no pane, tab or space (herdr-core's own `hc run --bg --no-parent`; the App's tab.new /
// terminal.open always make a tab in a space). A shell reports no state, so the office shows nobody; when a program in it (claude ...)
// reports a state, the collector lists it (no `where` label: the "free:フリーデスク" island) and the person walks in at the entrance.
export const FREE_SPACE = "__free__";
// ★95 request-free-space: "スペースなし（フリー）" is now a real space named FREE_NAME (a tab in it; made when missing, closed by ★85-1 when empty), so the
// standard layout's Agents list shows it. The collector draws that space as the free desk island (island_of). Only a child (--parent) still goes by hc run.
export const FREE_NAME = "フリー";
// ★68-2 "＋ ターミナル": a shell only (no agent). In a space: tab.new without argv; free: hc run with no program (the machine's own shell).
export const SHELL_KIND = { key: "shell", label: "터미널 (shell)", argv: [] };
// How each kind takes its first instruction on the command line when started by hc (no App to type it in). agy: none known, so it is
// typed in with `hc send` after the start (it waits until the program pauses).
const TASK_ARGS = { claude: (t) => [t], codex: (t) => [t], cursor: (t) => [t], opencode: (t) => ["--prompt", t] };
export const HC_NAME = /^[a-z0-9_-]{1,32}$/;

// The form's default space: the chosen person's space (one space per project), else the first one there is, else a new one.
export function defaultSpace(spaceList, selected) {
  const mine = selected?.space && spaceList.find((s) => s.name === selected.space);
  return mine?.id ?? spaceList[0]?.id ?? NEW_SPACE;
}

// form: { space (an id, or NEW_SPACE), newName, kind, folder, task }. Returns { ok, error, calls: [{ cmd, args }] }; nothing is called here.
export function launchPlan(form, spaceList = []) {
  const kind = form?.kind === "shell" ? SHELL_KIND : AGENT_KINDS.find((k) => k.key === form?.kind);
  if (!kind) return { ok: false, error: "종류를 선택해 주세요", calls: [] };
  const folder = String(form.folder ?? "").trim(), task = String(form.task ?? "").trim();
  const label = String(form.name ?? "").trim(); // ★61-1: the agent's name = its tab's name (the office and the Agents list read it from the tab)
  const ka = kind.argv.length ? kindArgv(kind.key, form.model, form.effort, form.effortDir, form.options) : { argv: [], writes: [] }; // ★79 model / effort after the permission words
  const child = form.parentMode === "child" && kind.argv.length > 0; // ★79 a child: hc run --parent <terminal> (the App's tab.new cannot name a parent); the space is not used
  if (child && !String(form.parent ?? "").trim()) return { ok: false, error: "작업자를 시작하려면 리더 에이전트를 선택해 주세요", calls: [] };
  if (child) { // ★68-2: herdr-core's hc (the App's hc()): a child hangs under its leader (the standard Agents list shows it there)
    // ★96-3 what a person reads is the `display` label (any language); hc's --name (a-z 0-9 - _ . only) is for addressing, so it is added only when the name fits
    const head = child ? ["run", "--bg", "--parent", String(form.parent).trim(), "--no-notify", ...(label ? ["--label", `display=${label}`] : []), ...(label && HC_NAME.test(label) ? ["--name", label] : []), ...(folder ? ["--cwd", folder] : [])]
      : ["run", "--bg", "--no-parent", "--no-notify", "--outlive-parent", ...(label ? ["--name", label] : []), ...(folder ? ["--cwd", folder] : [])];
    if (!kind.argv.length) return { ok: true, calls: [{ hc: head }] }; // a shell
    const ta = task && TASK_ARGS[kind.key];
    return { ok: true, writes: ka.writes, calls: [{ hc: [...head, "--", ...ka.argv, ...(ta ? ta(task) : [])], ...(task && !ta ? { sendTask: task } : {}) }] };
  }
  // ★85 e2e: the App hands `task` to the program as a positional argument; opencode reads that as a folder and fails to start, so opencode takes it as --prompt in argv.
  const taskInArgv = task && kind.key === "opencode";
  const common = { ...(folder ? { folder } : {}), ...(kind.argv.length ? { argv: [...ka.argv, ...(taskInArgv ? TASK_ARGS.opencode(task) : [])] } : {}), ...(task && kind.argv.length && !taskInArgv ? { task } : {}) }; // argv is an array (a string does not start); a shell has none
  if (form.space === FREE_SPACE) { // ★95: the real space "フリー": a tab in it when it is there, else the space is made (with this agent in it)
    const fs = spaceList.find((s) => s.name === FREE_NAME);
    return { ok: true, writes: ka.writes, calls: [fs ? { cmd: "tab.new", args: { space: fs.id, ...(label ? { name: label } : {}), ...common } } : { cmd: "space.new", args: { name: FREE_NAME, ...(label ? { tab: label } : {}), ...common } }] };
  }
  if (form.space === NEW_SPACE || !form.space) {
    const name = String(form.newName ?? "").trim(); // ★85-2: empty = the App names it after where its first terminal is; the office renames it after the first agent's title
    return { ok: true, writes: ka.writes, calls: [{ cmd: "space.new", args: { ...(name ? { name } : {}), ...(label ? { tab: label } : {}), ...common } }] }; // space.new takes the agent (argv) and its first message (task) itself: one call, no id to wait for
  }
  const sp = spaceList.find((s) => s.id === form.space);
  if (!sp) return { ok: false, error: "선택한 공간을 찾을 수 없습니다", calls: [] };
  return { ok: true, writes: ka.writes, calls: [{ cmd: "tab.new", args: { space: sp.id, ...(label ? { name: label } : {}), ...common } }] };
}

// Runs the plan with the given caller. `run` may be sync or async; a failure is returned, never thrown.
// `hc` (the App's hc(args) -> { code, stdout, stderr }) runs the free ones; a failure (an exit code) is returned with its words.
export async function launchAgent(run, form, spaceList, hc = null, write = null) {
  const plan = launchPlan(form, spaceList);
  if (!plan.ok) return plan;
  try {
    for (const w of plan.writes ?? []) { if (!write) return { ok: false, error: "설정 파일을 쓸 수 없습니다", calls: plan.calls }; await write(w.path, w.text); } // ★79 the --settings file that makes `--effort` work
    for (const c of plan.calls) {
      if (!c.hc) { await run(c.cmd, c.args); continue; }
      if (!hc) return { ok: false, error: "hc를 사용할 수 없습니다", calls: plan.calls };
      const r = await hc(c.hc);
      if (r?.code) return { ok: false, error: String(r.stderr || r.stdout || `hc run: ${r.code}`).slice(0, 200), calls: plan.calls };
      if (c.sendTask) { let addr = null; try { addr = JSON.parse(String(r?.stdout ?? "").trim().split(/\r?\n/).pop()).address; } catch {} if (addr) await hc(["send", addr, c.sendTask]); }
    }
  } catch (e) { return { ok: false, error: String(e), calls: plan.calls }; }
  return plan;
}

// ---- ending an agent: always asked first. `answer` is the person's button: only `true` calls anything.
export const isWatcher = (a) => a?.source === "t3" || /t3/i.test(String(a?.app ?? ""));

// The text of the question; a watcher (T3's) and a working agent get a stronger warning. `list` gives the number of children.
// ★101-2: no "ワーカー" for the one being ended. A terminal with no agent (a shell, node ...) is just a session; an agent is
// "このセッション（名前）"; only a leader with workers adds "ワーカー N 人も一緒に終わります".
export function endQuestion(a, list = []) {
  const kids = list.filter((x) => x.parent_id === a.id).length, who = a.name || a.address || a.id;
  const lines = [a.shell ? "이 세션을 종료하시겠습니까?" : `이 세션 (${who})을 종료하시겠습니까?`];
  if (kids) lines.push(`작업자 ${kids}명도 함께 종료됩니다.`);
  if (isWatcher(a)) lines.push("⚠ T3 Code 감시 에이전트입니다. 종료하면 다른 에이전트를 감시할 수 없습니다.");
  if (a.status === "working") lines.push("⚠ 작업 중입니다. 종료하면 진행 중인 작업이 중단됩니다.");
  if (a.status === "blocked") lines.push("승인 대기 중인 작업은 실행되지 않습니다.");
  lines.push("이 작업은 되돌릴 수 없습니다.");
  return { text: lines.join("\n"), strong: isWatcher(a) || a.status === "working", kids };
}

// Only an App terminal can be ended from here. No → nothing is called.
export async function endAgent(run, a, answer) {
  if (answer !== true) return { ok: true, called: false, calls: [] };
  if (!a?.address || a.source !== "app") return { ok: false, called: false, error: "Herdr 터미널이 아니므로 종료할 수 없습니다", calls: [] };
  const calls = [{ cmd: "terminal.kill", args: { terminal: a.address } }];
  try { for (const c of calls) await run(c.cmd, c.args); } catch (e) { return { ok: false, called: true, error: String(e), calls }; }
  return { ok: true, called: true, calls };
}

// ---- ★30-7 the operations the detail column offers: only commands Herdr App really has.
// `live` is false for the demo (nothing real is called). `tabId` is the App's tab id, when it could be found.
export function agentOps(a, tabId = null, live = true) {
  if (!live || a?.source !== "app" || !a?.address) return [];
  const ops = []; // ★84 "端末へ移る" (agent.focus) and "上に固定" (terminal.pin) are gone: they do nothing visible in the office layout
  if (tabId) ops.push({ key: "rename", label: "이름 변경", cmd: "tab.rename", args: { id: tabId } }); // no name: the App asks the person
  return ops;
}

// The App tab id for an agent: the collected space/tab names matched against spaces().
export function tabIdFor(a, spaceList = []) {
  if (!a?.space || !a?.tab) return null;
  const sp = spaceList.find((s) => s.name === a.space);
  const tb = sp?.tabs?.find((t) => t.id === a.tab || t.name === a.tab);
  return tb?.id ?? null;
}

// Runs the operations with the App's caller. A failure is returned, never thrown.
export async function runAgentOps(run, ops) {
  const calls = (ops ?? []).map((c) => ({ cmd: c.cmd, args: c.args }));
  try { for (const c of calls) await run(c.cmd, c.args); } catch (e) { return { ok: false, error: String(e), calls }; }
  return { ok: true, calls };
}

// ---- ★61-1 stopping an agent (its work, not its terminal): Herdr App has no command for it, so it is herdr-core's `hc interrupt <t>`
// (it presses the stop key and reports). Asked first like ending; `exec` is the mod's program caller (swapped for a fake in the tests).
export function stopQuestion(a) {
  const who = a.name || a.address || a.id;
  const lines = [`「${who}」의 작업을 중단하시겠습니까? 중단 키를 전송하며 터미널은 유지됩니다.`];
  if (isWatcher(a)) lines.push("⚠ T3 Code 감시 에이전트입니다.");
  if (a.status !== "working") lines.push("현재 작업 중이 아닙니다.");
  return { text: lines.join("\n"), strong: isWatcher(a) };
}
export async function stopAgent(exec, a, answer, hc = "hc") {
  if (answer !== true) return { ok: true, called: false, calls: [] };
  if (!a?.address || a.source !== "app") return { ok: false, called: false, error: "Herdr 터미널이 아니므로 중단할 수 없습니다", calls: [] };
  const calls = [{ cmd: hc, args: ["interrupt", a.address] }];
  try { const r = await exec(hc, calls[0].args); if (r && r.code) return { ok: false, called: true, error: String(r.stderr || r.stdout || `hc interrupt: ${r.code}`).slice(0, 200), calls }; }
  catch (e) { return { ok: false, called: true, error: String(e), calls }; }
  return { ok: true, called: true, calls };
}

// ---- ★61-1 rooms (= Herdr App spaces). A plate's island is found in spaces() by its people's space name (App people only).
export function spaceForIsland(members = [], spaceList = [], isl = null) {
  const names = [...new Set(members.filter((a) => a?.source === "app" && a.space).map((a) => a.space))];
  for (const n of names) { const sp = spaceList.find((s) => s.name === n); if (sp) return sp; }
  if (isl?.source === "app" && isl.title) return spaceList.find((s) => s.name === isl.title) ?? null; // an empty room (nobody in it): by its title
  return null;
}

// ★85-1 a room is born with its people and goes with them: the floor draws only spaces that have an agent (no empty rooms).
// When the last agent of a space is gone and no terminal is left in it, the office closes the space (space.close, confirmed: nothing is left to end).
// A space with a shell still in it stays (the left list shows it). Only a space that had an agent while the office watched is ever closed,
// and only after RELEASE_MS of being empty (an agent that is starting or being moved is not "gone").
export const RELEASE_MS = 6000;
export function roomsToRelease(seen, spaceList = [], list = [], paneList = [], now = Date.now()) {
  const out = [], ids = new Set();
  for (const s of spaceList) {
    if (!s?.id || !s?.name) continue; ids.add(s.id);
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    const hasAgent = list.some((a) => a?.source === "app" && (a.space === s.name || a.island_title === s.name));
    const hasTerm = paneList.some((p) => p?.terminal && tabs.has(p.tab));
    const e = seen.get(s.id) ?? { had: false, emptyAt: null };
    if (hasAgent) { e.had = true; e.emptyAt = null; }
    else if (e.had && !hasTerm) { e.emptyAt ??= now; if (now - e.emptyAt >= RELEASE_MS) out.push(s.id); }
    else e.emptyAt = null;
    seen.set(s.id, e);
  }
  for (const k of [...seen.keys()]) if (!ids.has(k)) seen.delete(k);
  return out;
}

// ★85-2 a room made from the launch dialog has no name typed: once its first agent has a title (the work summary), the room takes it.
// `auto`: Map spaceId -> { at }. Returns [{ id, name }] to rename (and drops them from `auto`; old ones are dropped after 15 minutes).
// ★85 e2e: some programs (OpenCode) never set a title that tells the work; theirs stays the program's own name. That says nothing: not a name, not a room name.
export const isGenericTitle = (t, prog = "") => { const x = String(t ?? "").trim().toLowerCase().replace(/[\s_-]+/g, ""); return !x || /^\d+$/.test(x) || ["opencode", "claudecode", "claude", "codex", "cursor", "cursoragent", "agy", "antigravity", "shell", "bash", "zsh", "powershell", "pwsh"].includes(x) || x === String(prog ?? "").toLowerCase().replace(/[\s_-]+/g, ""); };
// ★85 (2) a room made by a COMMAND (herdr-app do space.new, hc run ...), not from the launch dialog, also takes the first agent's title as its name: but only a room that
// APPEARS while we watch (never the rooms that were there when the office started) and only while its name is still the App's default (empty, a number,
// "Space 3", "新しい部屋"...). A room the person named is never touched. `known`: Set of space ids seen so far (the first call only fills it); `auto`: as in roomRenames.
export const isDefaultRoomName = (n) => { const x = String(n ?? "").trim(); return !x || /^\d+$/.test(x) || /^(space|workspace|ws|スペース|新しい部屋|新規スペース|새 공간|new[ _-]?(space|room))[ _-]*\d*$/i.test(x) || isGenericTitle(x); };
export function watchNewRooms(known, spaceList = [], auto, now = Date.now()) {
  const first = known.size === 0;
  for (const s of spaceList) {
    if (!s?.id) continue;
    if (!known.has(s.id)) { known.add(s.id); if (!first && !auto.has(s.id) && isDefaultRoomName(s.name)) auto.set(s.id, { at: now, byCommand: true }); }
  }
  for (const k of [...known]) if (!spaceList.some((s) => s?.id === k)) known.delete(k);
  return auto;
}
export function roomRenames(auto, spaceList = [], list = [], now = Date.now()) {
  const out = [];
  for (const [id, e] of [...auto]) {
    const s = spaceList.find((x) => x.id === id);
    if (!s || now - e.at > 900000) { auto.delete(id); continue; }
    const a = list.find((x) => x?.source === "app" && x.space === s.name && !isGenericTitle(x.title, x.program));
    const t = a ? String(a.title).trim().slice(0, 40) : "";
    if (e.byCommand && !isDefaultRoomName(s.name)) { auto.delete(id); continue; } // the person (or the program) already named it
    if (t && t !== s.name) { out.push({ id, name: t }); auto.delete(id); }
  }
  return out;
}

// The room's operations (only commands the App has). No name to space.rename: the App asks the person itself.
export function roomOps(space, live = true) {
  if (!live || !space?.id) return [];
  return [
    { key: "show", label: "공간 보기", cmd: "space.select", args: { id: space.id } },
    { key: "rename", label: "이름 변경", cmd: "space.rename", args: { id: space.id } },
  ];
}

export function closeRoomQuestion(space, members = []) {
  const n = members.length, working = members.filter((a) => a?.status === "working").length;
  const lines = [`공간 「${space?.name || space?.id}」을 닫으시겠습니까?${n ? ` 내부 터미널 ${n}개도 종료됩니다.` : ""}`];
  if (members.some(isWatcher)) lines.push("⚠ T3 Code 감시 에이전트가 있습니다.");
  if (working) lines.push(`⚠ ${working}명이 작업 중입니다. 진행 중인 작업이 중단됩니다.`);
  lines.push("이 작업은 되돌릴 수 없습니다.");
  return { text: lines.join("\n"), strong: working > 0 || members.some(isWatcher) };
}

// Only "はい" (true) closes; the dialog already asked, so the App is told confirmed.
export async function closeRoom(run, space, answer) {
  if (answer !== true) return { ok: true, called: false, calls: [] };
  if (!space?.id) return { ok: false, called: false, error: "공간을 찾을 수 없습니다", calls: [] };
  const calls = [{ cmd: "space.close", args: { id: space.id, confirmed: true } }];
  try { await run(calls[0].cmd, calls[0].args); } catch (e) { return { ok: false, called: true, error: String(e), calls }; }
  return { ok: true, called: true, calls };
}

// A new room with a plain terminal (a shell): space.new with its name (and folder). An agent goes in with the launch dialog.
// ★107 `spaceList` (optional): a name a space already has is refused (the office names rooms by their name).
export function newRoomPlan(form, spaceList = null) {
  const name = String(form?.name ?? "").trim(), folder = String(form?.folder ?? "").trim();
  if (!name) return { ok: false, error: "공간 이름을 입력해 주세요", calls: [] };
  if (Array.isArray(spaceList) && spaceList.some((s) => String(s?.name ?? "").trim() === name)) return { ok: false, error: "같은 이름의 공간이 있습니다. 다른 이름을 입력해 주세요", calls: [] };
  return { ok: true, calls: [{ cmd: "space.new", args: { name, ...(folder ? { folder } : {}) } }] };
}
// ★107 the folders offered when a space is made: the spaces' own folders first, then view.json's `recent` ({ name, folder }); one slash style, no repeats, `max` of them.
export const normFolder = (f) => { const s = String(f ?? "").trim(); if (!s) return ""; const unc = /^[\\/]{2}[^\\/]/.test(s); let t = s.replace(/[\\/]+/g, "/").replace(/(.)\/$/, "$1"); if (/^[A-Za-z]:$/.test(t)) t += "/"; return unc ? `/${t}` : t; }; // a drive root keeps its slash ("C:" alone is that drive's current folder)
// 18th F6: a test's one-off folder (under a Temp folder, or named office-e2e…) is not a place to start a room from.
export const isTempFolder = (f) => { const t = normFolder(f).toLowerCase(); return /(^|\/)temp(\/|$)/.test(t) || /(^|\/)office-e2e[^/]*$/.test(t); };
export function recentFolders(view, spaceList = [], max = 8) {
  const seen = new Set(), out = [];
  for (const raw of [...(spaceList ?? []).map((s) => s?.folder), ...(Array.isArray(view?.recent) ? view.recent.map((r) => r?.folder) : [])]) {
    const f = normFolder(raw), k = f.toLowerCase();
    if (!f || seen.has(k) || isTempFolder(f)) continue; seen.add(k); out.push(f); if (out.length >= max) break;
  }
  return out;
}
// 18th F6: the make-a-space window is as tall as its content (no empty band under the chips). Chip widths are estimated (12px text: 7 per ascii, 13 per wide char, +22 for the padding/border, max 200);
// the row heights are the parts' sizes (chip 29, input 40, label 19, heading 18). Estimated, not measured.
export function newRoomHeight(recent = []) {
  const W = 480 - 36, GAP = 6, CH = 29, list = Array.isArray(recent) ? recent : [];
  const cw = (t) => Math.min(200, 22 + [...String(t)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 13 : 7), 0));
  let rows = 1, used = 0; // the 選ぶ… chip has the first row to itself
  for (const d of list) { const w = cw(folderLabel(d) || d); if (used && used + GAP + w > W) { rows++; used = w; } else used += (used ? GAP : 0) + w; }
  const chips = list.length ? CH + 5 + 18 + 5 + (rows * CH + (rows - 1) * GAP) : CH; // 選ぶ… / heading / recent chips
  const folder = 19 + 5 + 40 + 5 + chips, name = 19 + 5 + 40;
  // 19th G2: measured (14th picture) — with one recent chip the window was 388 and 49px was empty between the chip and the buttons: 40 of it was the always-reserved error row (12 + 16 + 12).
  // The error text now sits left of the buttons (room.js), so the rows are: padding 36, title 24, gap 12, name, gap 12, folder, gap 12, buttons 40, slack 6.
  return Math.max(280, Math.min(520, 36 + 24 + 12 + name + 12 + folder + 12 + 40 + 6));
}
// ★107 the last part of a folder, for a small chip ("C:/work/my-app" -> "my-app"; a drive root stays whole).
export const folderLabel = (f) => { const p = normFolder(f).split("/").filter(Boolean); return p.length > 1 ? p[p.length - 1] : (p[0] ?? ""); };
export async function newRoom(run, form, spaceList = null) {
  const plan = newRoomPlan(form, spaceList);
  if (!plan.ok) return plan;
  try { const r = await run(plan.calls[0].cmd, plan.calls[0].args); return { ...plan, result: r ?? null }; } catch (e) { return { ok: false, error: String(e), calls: plan.calls }; }
}

// ---- ★61-1 commands for review pictures without clicks (herdr-app do hakoniwa.<command>[:<target>]). A command arrives as one string;
// the target is after ":" or, when absent, in the aim file (hakoniwa-aim.json: { "<command>": "<target>" }).
export function parseCommand(command, aim = null) {
  const s = String(command ?? ""), i = s.indexOf(":");
  const name = i < 0 ? s : s.slice(0, i), arg = i < 0 ? null : s.slice(i + 1).trim() || null;
  const fromAim = aim && typeof aim === "object" && typeof aim[name] === "string" ? aim[name].trim() || null : null;
  return { name, arg: arg ?? fromAim };
}

// Who "select" means: a terminal address (t7), an id, or a name (exact, then a part of it); none: the first App agent, else the first one.
export function findAgent(list = [], who = null) {
  if (!who) return list.find((a) => a.source === "app") ?? list[0] ?? null;
  const w = String(who);
  return list.find((a) => a.address === w || a.id === w) ?? list.find((a) => a.name === w)
    ?? list.find((a) => String(a.name ?? "").includes(w)) ?? null;
}

// The island "plate" opens: by key, title (exact, then a part of it); none: the next one after `current` (in the floor's order), wrapping round.
export function plateKeyFor(islands = [], room = null, current = null) {
  const plated = islands.filter((q) => q?.plate?.at);
  if (!plated.length) return null;
  if (room) {
    const r = String(room), hit = plated.find((q) => q.key === r || q.title === r) ?? plated.find((q) => String(q.title ?? "").includes(r));
    return hit?.key ?? null;
  }
  const i = plated.findIndex((q) => q.key === current);
  return plated[(i + 1) % plated.length].key;
}

// ---- ★68-2 moving an App agent between spaces, and out of them ("フリー": a terminal with no pane and no space labels).
// Herdr App has no "move" command: a terminal leaves its pane with terminal.park and gets a new one with terminal.keep (a new tab in the
// space on screen), so the target space is shown for that one call and the space that was on screen is shown again after.
// park leaves the old `where` label behind; `hc label <t> where=` takes it off (the collector reads where for the room).
// Steps are { cmd, args } (App commands) or { hc: [...] } (herdr-core). Nothing is called here.
const inSpace = (a, spaceList) => !!(a?.space && spaceList.some((s) => s.name === a.space));

export function moveToSpacePlan(a, target, spaceList = []) {
  if (a?.source !== "app" || !a.address) return { ok: false, error: "Herdr 터미널만 이동할 수 있습니다", calls: [] };
  const sp = spaceList.find((s) => s.id === target || s.name === target);
  if (!sp) return { ok: false, error: "이동할 공간을 찾을 수 없습니다", calls: [] };
  if (a.space === sp.name) return { ok: false, error: "이미 해당 공간에 있습니다", calls: [] };
  const shown = spaceList.find((s) => s.active)?.id ?? null, calls = [];
  if (a.pane) calls.push({ cmd: "terminal.park", args: { terminal: a.address } }); // a sub-agent has no pane of its own: keep only
  calls.push({ cmd: "space.select", args: { id: sp.id } }, { cmd: "terminal.keep", args: { terminal: a.address, place: "tab" } });
  if (shown && shown !== sp.id) calls.push({ cmd: "space.select", args: { id: shown }, soft: true }); // soft: the shown space may be the one just emptied (★85-1 closes it), then there is nothing to show again
  return { ok: true, calls };
}

// ★85-4 a team (the leader and its workers) moves as one; a worker lives in its leader's room and is never moved alone
// (the App / hc cannot cut the tie: hc's parent is set once, at start).
export const isWorker = (a, list = []) => !!a?.parent_id && list.some((x) => x?.id === a.parent_id);
export function teamMembers(a, list = []) {
  const out = [], seen = new Set([a?.id]);
  for (let i = 0, q = [a]; q.length && i < 64; i++) { const n = q.shift(); for (const k of list) if (k?.parent_id === n.id && !seen.has(k.id) && k.source === "app" && k.address) { seen.add(k.id); out.push(k); q.push(k); } }
  return out;
}
export function teamPlan(a, members, mk) {
  const lead = mk(a); if (!lead?.ok) return lead;
  const calls = [...lead.calls];
  for (const m of members ?? []) { const p = mk(m); if (p?.ok) calls.push(...p.calls); }
  return { ok: true, calls };
}

// ★97 a worker of the ★97 room rules is an AGENT terminal (one of the kinds that report a state: claude, codex, opencode, cursor, agy ...).
// A helper an agent started for its work (t105 `node` edge-keepalive, a bare shell) is not part of the team and is neither counted nor moved.
export const isAgentApp = (app) => /^(claude|codex|opencode|cursor|agy|antigravity|gemini)\b/i.test(String(app ?? "").trim());
export const agentMembers = (a, list = []) => teamMembers(a, list).filter((m) => isAgentApp(m?.app));

// ★95 "フリーへ" = to the real space "フリー" (moveToSpacePlan); when it is missing, make it first (`saveId`: runMovePlan keeps the new space's id for "$free").
export function moveToFreePlan(a, spaceList = []) {
  if (a?.source !== "app" || !a.address) return { ok: false, error: "Herdr 터미널만 이동할 수 있습니다", calls: [] };
  const fs = spaceList.find((s) => s.name === FREE_NAME);
  if (fs) return moveToSpacePlan(a, fs.id, spaceList);
  const shown = spaceList.find((s) => s.active)?.id ?? null, calls = [];
  if (a.pane) calls.push({ cmd: "terminal.park", args: { terminal: a.address } });
  calls.push({ cmd: "space.new", args: { name: FREE_NAME }, saveId: "free" }, { cmd: "space.select", args: { id: "$free" } }, { cmd: "terminal.keep", args: { terminal: a.address, place: "tab" } });
  if (shown) calls.push({ cmd: "space.select", args: { id: shown }, soft: true });
  return { ok: true, calls };
}

// ---- ★97 a team lives in one room. What the App really has (tested 2026-11-06 with own trial terminals, no space.select):
// - a child without a pane moves with `hc label <t> herdr.space=<space id> herdr.tab=<tab id>` alone (no park; the App then shows it in that
//   tab with a pane of its own);
// - a terminal with a pane does not move by labels alone (the labels change, `where` stays where it is): park first, then the labels.
// The shown space never changes; a source space whose last pane is parked closes by itself (★85-1's rule, not ours). Do not clear the old
// `where` label: the App writes the new one when it places the terminal. The target tab is the space's first tab (spaces() has the ids).
export function moveByLabelPlan(a, target, spaceList = []) {
  if (a?.source !== "app" || !a.address) return { ok: false, error: "Herdr 터미널만 이동할 수 있습니다", calls: [] };
  const sp = spaceList.find((s) => s.id === target || s.name === target);
  if (!sp?.id) return { ok: false, error: "이동할 공간을 찾을 수 없습니다", calls: [] };
  if (a.space === sp.name) return { ok: false, error: "이미 해당 공간에 있습니다", calls: [] };
  const tabs = (sp.tabs ?? []).filter((t) => t?.id), tab = (tabs.find((t) => !t.settled) ?? tabs[0])?.id ?? null;
  if (!tab) return { ok: false, error: "이동할 공간에 탭이 없습니다", calls: [] };
  const calls = [];
  if (a.pane) calls.push({ cmd: "terminal.park", args: { terminal: a.address } });
  calls.push({ hc: ["label", a.address, `herdr.space=${sp.id}`, `herdr.tab=${tab}`] });
  return { ok: true, calls };
}

// ★97 what the team's spaces are: "free" is the real space フリー (★95) or no space at all (both are the same place here).
//  - "auto": the leader is free and its workers are all in one real space -> the leader can move there without a press;
//  - "manual": the leader and the workers are in different spaces (the auto rule does not apply) -> a mark and a press;
//  - null: they are together, or there is nobody to move.
const isFreeName = (s) => { const x = String(s ?? ""); return !x || x === FREE_NAME; };
export function teamSpaceState(a, list = [], spaceList = []) {
  if (a?.source !== "app" || !a.address || isWorker(a, list)) return null;
  const ms = agentMembers(a, list); // ★97 agent terminals only (a helper such as `node` is not a worker)
  if (!ms.length) return null;
  const lead = isFreeName(a.space) ? FREE_NAME : String(a.space ?? ""), names = [...new Set(ms.map((m) => (isFreeName(m.space) ? FREE_NAME : String(m.space ?? ""))))];
  if (names.length === 1 && names[0] === lead) return null; // all in the leader's room
  if (lead === FREE_NAME && names.length === 1) {
    const sp = spaceList.find((s) => s.name === names[0] && s.id);
    if (sp) return { state: "auto", target: sp };
  }
  return { state: "manual" };
}

// ★97 the press: with "auto" the leader goes to the workers' room; with "manual" the workers go to the leader's room.
// Pane-less terminals go in first (labels only = add), the ones with a pane after (a park = take out), so a source room is not left empty
// before the rest are in. No space.select: the person's shown space never changes. Nothing is called here.
export function teamFixPlan(a, list = [], spaceList = []) {
  const st = teamSpaceState(a, list, spaceList);
  if (!st) return { ok: false, error: "팀이 이미 한곳에 있습니다", calls: [] };
  if (st.state === "auto") return moveByLabelPlan(a, st.target.id, spaceList);
  const lead = isFreeName(a?.space) ? FREE_NAME : String(a?.space ?? ""), sp = spaceList.find((s) => s.name === lead && s.id);
  if (!sp) return { ok: false, error: "리더의 공간을 찾을 수 없습니다", calls: [] };
  const ms = agentMembers(a, list).filter((m) => (isFreeName(m.space) ? FREE_NAME : String(m.space ?? "")) !== lead)
    .sort((x, y) => (x.pane ? 1 : 0) - (y.pane ? 1 : 0));
  const calls = [];
  for (const m of ms) { const p = moveByLabelPlan(m, sp.id, spaceList); if (p.ok) calls.push(...p.calls); }
  return calls.length ? { ok: true, calls } : { ok: false, error: "이동할 수 있는 작업자가 없습니다", calls: [] };
}

// ★103-5 the free space for everybody who is in no space. Why ★95 did not hold: it only changed the launch dialog and the drag, so a terminal
// started outside the office (claude typed in a shell, `hc run` by hand) and the children `hc run --parent` made under it have no `where` and
// no `herdr.space`, and nothing ever moved them (★97's auto rule needs workers in a real space; isFreeName treats "no space" as "フリー", so
// they were counted as already there). And the real space フリー did not exist until somebody launched into it.
// freeSweepPlan: { state: "none" } nothing to do; { state: "make", plan } the space is missing (space.new, the shown space is selected back:
// a new space takes the screen); { state: "move", plan, targets } labels only (these terminals have no pane: no park, no space.select).
// `skip`: addresses another rule is handling (★97 auto). Nothing is called here.
// ★103-5b a child goes where its parent is, not to フリー: a terminal with a parent whose `where` is a real space goes to the parent's space
// (also when it already sits in フリー: the fix for children an earlier sweep put there); only a terminal whose parent has no space (or is
// unknown) goes to フリー. A terminal born less than SWEEP_GRACE_MS ago is left alone (`hc run --parent` writes its where a moment later).
// `opts.born`: Map address -> first-seen ms (missing = old); `opts.now`. Only terminals with no space or in フリー are ever moved.
export const SWEEP_GRACE_MS = 20000;
export const sweepKey = (a) => (String(a?.space ?? "").trim() ? `${a.address}@back` : String(a?.address));
// ★103-5c a terminal that finished between the list and the hc call: hc label answers kind "not_found" / `no terminal "t12p"`.
// It is not a fault (nothing to move any more), so the caller does not write it to error.txt.
export const goneError = (e) => /not_found|no terminal|no such terminal/i.test(String(e?.error ?? e?.message ?? e ?? ""));
export function sweepDest(a, list = []) {
  const par = a?.parent_id ? (list ?? []).find((x) => x?.id === a.parent_id) : null, ps = String(par?.space ?? "").trim();
  const mine = String(a?.space ?? "").trim();
  if (ps && ps !== FREE_NAME) return ps === mine ? null : ps; // the parent's real space
  return mine ? null : FREE_NAME; // no parent room: free (already free = nothing)
}
export function freeSweepPlan(list = [], spaceList = [], skip = new Set(), opts = {}) {
  const now = opts.now ?? Date.now(), born = opts.born ?? new Map();
  const cands = (list ?? []).filter((a) => a?.source === "app" && a.address && a.live === true && !skip.has(a.address) // ★103-5c only terminals in hc's live list (a finished one stays in state.json, but hc label would answer not_found)
    && (!String(a.space ?? "").trim() ? !a.pane : String(a.space).trim() === FREE_NAME)
    && !(born.has(a.address) && now - born.get(a.address) < SWEEP_GRACE_MS));
  const ents = cands.map((a) => ({ a, dest: sweepDest(a, list) })).filter((e) => e.dest);
  if (!ents.length) return { state: "none", ok: false, calls: [], targets: [] };
  const fs = spaceList.find((s) => s.name === FREE_NAME && s.id);
  if (!fs && ents.some((e) => e.dest === FREE_NAME)) {
    const shown = spaceList.find((s) => s.active)?.id ?? null, targets = ents.filter((e) => e.dest === FREE_NAME).map((e) => e.a);
    return { state: "make", ok: true, targets, calls: [{ cmd: "space.new", args: { name: FREE_NAME } }, ...(shown ? [{ cmd: "space.select", args: { id: shown }, soft: true }] : [])] };
  }
  const calls = [], targets = [];
  for (const e of ents.sort((x, y) => (x.a.pane ? 1 : 0) - (y.a.pane ? 1 : 0))) {
    const sp = spaceList.find((s) => s.name === e.dest && s.id); if (!sp) continue;
    const p = moveByLabelPlan(e.a, sp.id, spaceList); if (p.ok) { calls.push(...p.calls); targets.push(e.a); }
  }
  return calls.length ? { state: "move", ok: true, targets, calls } : { state: "none", ok: false, calls: [], targets: [] };
}

// Runs a plan: App commands with `run`, herdr-core ones with `hc` (both swapped for fakes in the tests). A failure is returned, never thrown.
export async function runMovePlan(run, hc, plan) {
  if (!plan?.ok) return plan ?? { ok: false, error: "이동 계획이 없습니다", calls: [] };
  try {
    const saved = {}; // ★95 ids made by an earlier step ("$free" in a later step's args)
    for (const c of plan.calls) {
      if (c.args && Object.values(c.args).includes("$free")) c.args = Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, v === "$free" ? saved.free : v]));
      if (c.saveId && saved[c.saveId]) continue; // a team: the first member made it, the others go in
      if (c.saveId) { const r = await run(c.cmd, c.args); saved[c.saveId] = r?.space ?? r?.id ?? null; if (!saved[c.saveId]) return { ok: false, error: "자유 공간을 만들지 못했습니다", calls: plan.calls }; continue; }
      if (c.hc) { const r = await hc(c.hc); if (r && r.code) return { ok: false, error: String(r.stderr || `hc ${c.hc[0]}: ${r.code}`).slice(0, 200), calls: plan.calls }; }
      else if (c.soft) { try { await run(c.cmd, c.args); } catch {} }
      else await run(c.cmd, c.args);
    }
  } catch (e) { return { ok: false, error: String(e), calls: plan.calls }; }
  return { ok: true, calls: plan.calls };
}
