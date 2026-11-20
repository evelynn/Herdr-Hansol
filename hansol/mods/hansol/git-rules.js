// hansol: the Git windows' pure rules (no herdr / gpui imports, so node runs them in the tests).
// layoutLanes, the log format, fileArgs / joinFiles / diffArgs / diffRows follow herdr-git-graph
// (https://github.com/rabeeh-ta/herdr-git-graph, MIT License, Copyright (c) 2026 Rabeeh T A).

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const LOG_N = 300;
export const LANES = ["#71b2ff", "#7bd88f", "#c792ea", "#f4ce76", "#5fd7d7", "#ff8a8a", "#ffb86c", "#a5b4fc", "#f472b6", "#94e2d5"];
export const laneColor = (lane) => LANES[lane % LANES.length];

// The network (only these): fetch updates the remote-tracking branches (other people's work) and never touches the working tree;
// pull is fast-forward only (no merge commit, no conflict: git refuses instead). A fetch the window starts by itself shows no login window.
// Each remote is fetched on its own (at the same time): one that cannot be reached (a company server off the network) no longer
// fails the others, as `fetch --all` did.
export const remotesArgs = () => [...READ, "remote"];
export const parseRemotes = (t) => String(t ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
export const fetchArgs = (quiet = false, remote = null) => [...(quiet ? ["-c", "credential.interactive=never"] : []), "fetch", ...(remote ? [remote] : ["--all"]), "--prune", "--quiet"];
// Why a fetch failed, in a few words (else null: the caller shows git's own last lines).
export function netReason(stderr) {
  const t = String(stderr ?? "");
  if (/timed out|Could not resolve host|Connection refused|Network is unreachable|unable to access|Failed to connect|No route to host/i.test(t)) return "연결 안 됨";
  if (/Permission denied|Authentication failed|could not read Username|terminal prompts disabled|Host key verification failed/i.test(t)) return "인증 필요";
  if (/does not appear to be a git repository|repository .* not found/i.test(t)) return "저장소 없음";
  return null;
}
export const pullArgs = () => ["pull", "--ff-only", "--quiet"];
export const upstreamArgs = () => [...READ, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
export const syncArgs = () => [...READ, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"];
export const parseSync = (t) => { const m = String(t ?? "").trim().match(/^(\d+)\s+(\d+)$/); return m ? { ahead: +m[1], behind: +m[2] } : null; };
export const rootArgs = () => [...READ, "rev-parse", "--show-toplevel"];
// Local branches, tags, remote branches and HEAD (not --all: other tools' private refs show as orphans).
// --ignore-missing: a repository with no commit yet is an empty log, not an error.
const FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s";
export const logArgs = (n = LOG_N) => [...READ, "log", "-z", "--branches", "--tags", "--remotes", "--ignore-missing", "HEAD", "--date-order", "--decorate=full", `-n${n}`, `--format=${FORMAT}`];

// "%D" with --decorate=full. kind: "branch" (head: checked out), "detached", "remote", "tag"; origin/HEAD is left out.
export function parseRefs(text) {
  const refs = [];
  for (let name of text ? String(text).split(", ") : []) {
    const head = name.startsWith("HEAD -> ");
    if (head) name = name.slice(8);
    if (name === "HEAD") refs.push({ kind: "detached", name: "HEAD" });
    else if (name.startsWith("refs/heads/")) refs.push({ kind: "branch", name: name.slice(11), head });
    else if (name.startsWith("tag: refs/tags/")) refs.push({ kind: "tag", name: name.slice(15) });
    else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD")) refs.push({ kind: "remote", name: name.slice(13) });
  }
  return refs;
}

// `git log -z` with seven NUL-separated fields per commit.
export function parseLog(text) {
  if (!text) return [];
  const f = String(text).split("\0");
  if (f[f.length - 1] === "") f.pop();
  const out = [];
  for (let i = 0; i + 7 <= f.length; i += 7) {
    const [hash, parents, author, email, time, refs, subject] = f.slice(i, i + 7);
    const h = hash.replace(/^\n/, ""), r = parseRefs(refs);
    if (!/^[0-9a-f]{40,64}$/.test(h)) continue;
    out.push({ hash: h, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), refs: r, subject, head: r.some((x) => x.head || x.kind === "detached") });
  }
  return out;
}
export const currentBranch = (commits = []) => {
  for (const c of commits) { const r = c.refs.find((x) => (x.kind === "branch" && x.head) || x.kind === "detached"); if (r) return r.kind === "detached" ? `HEAD ${c.hash.slice(0, 7)}` : r.name; }
  return "";
};

// The main line: "main" (else "master") as a local or a remote branch; null when neither is there.
const shortName = (r) => (r.kind === "remote" ? r.name.slice(r.name.indexOf("/") + 1) : r.name);
export function trunkOf(commits = []) {
  const names = new Set(commits.flatMap((c) => c.refs.filter((r) => r.kind === "branch" || r.kind === "remote").map(shortName)));
  return ["main", "master"].find((n) => names.has(n)) ?? null;
}
// Which branch each commit belongs to (Map hash -> branch name): from each branch tip down its first parents until a commit that
// already belongs to one. The main line first (local, then its remotes: origin/main counts as main), then the checked-out branch,
// the other local branches and the remote ones; a remote branch counts as its local namesake (origin/feature/x = feature/x).
// So a branch that starts at main's last commit is still its own line, though git sees one straight history.
export function branchOwners(commits = [], trunk = trunkOf(commits)) {
  const byHash = new Map(commits.map((c) => [c.hash, c])), own = new Map(), tips = [];
  const rank = (r) => (shortName(r) === trunk ? (r.kind === "branch" ? 0 : 1) : r.head ? 2 : r.kind === "branch" ? 3 : 4);
  for (const c of commits) for (const r of c.refs) if (r.kind === "branch" || r.kind === "remote") tips.push({ hash: c.hash, name: shortName(r), rank: rank(r) });
  tips.sort((a, b) => a.rank - b.rank); // (stable: newest first within a rank)
  for (const t of tips) for (let h = t.hash; h && byHash.has(h) && !own.has(h); h = byHash.get(h).parents[0]) own.set(h, t.name);
  return own;
}

// Commits newest first, every child before its parents (--date-order). A lane is a column waiting for one commit and keeps
// its column until that commit arrives, so lines bend only where branches fork or merge. The main line keeps the leftmost lane
// (lane 0, no other branch uses it); a commit takes the waiting lane of its own branch first.
// Each row: the commit's lane and its segments [fromLane, fromY, toLane, toY, colorLane], y 0 = the row's top, 0.5 = the dot, 1 = its bottom.
export function layoutLanes(commits, trunk = trunkOf(commits)) {
  const own = branchOwners(commits, trunk), lanes = [], owners = [];
  const isTrunk = (h) => trunk !== null && own.get(h) === trunk, reserve = commits.some((c) => isTrunk(c.hash));
  const free = () => { let i = reserve ? 1 : 0; while (lanes[i] != null) i++; return i; };
  let width = 1;
  const rows = commits.map((commit) => {
    const before = lanes.slice(), segments = [], mine = own.get(commit.hash);
    const waiting = [];
    for (let j = 0; j < before.length; j++) if (before[j] === commit.hash) waiting.push(j);
    let lane;
    if (isTrunk(commit.hash) && reserve && (before[0] == null || before[0] === commit.hash)) lane = 0;
    else lane = waiting.find((j) => owners[j] === mine) ?? waiting.find((j) => j !== 0 || !reserve) ?? free(); // a branch tip: nothing above it
    for (let j = 0; j < before.length; j++) {
      const hash = before[j];
      if (hash == null) continue;
      if (hash === commit.hash) { segments.push([j, 0, lane, 0.5, j]); if (j !== lane) lanes[j] = null; } // lines that end here
      else segments.push([j, 0, j, 1, j]);
    }
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null; owners[lane] = mine;
    if (first) segments.push([lane, 0.5, lane, 1, lane]);
    for (const parent of rest) { // a merge: a line to each other parent's lane
      let k = lanes.indexOf(parent);
      if (k < 0) { k = isTrunk(parent) && reserve && lanes[0] == null ? 0 : free(); lanes[k] = parent; owners[k] = own.get(parent); }
      segments.push([lane, 0.5, k, 1, k]);
    }
    width = Math.max(width, before.length, lanes.length, lane + 1);
    while (lanes.length && lanes[lanes.length - 1] == null) { lanes.pop(); owners.length = lanes.length; }
    return { lane, segments, branch: mine ?? null };
  });
  return { rows, width, trunk: reserve ? trunk : null };
}

// The files a commit changed against its first parent (a merge: what it brought into the first parent's line).
export function fileArgs(commit) {
  const range = commit.parents.length ? [commit.parents[0], commit.hash] : null;
  const base = range ? ["diff", "--no-renames", "--no-ext-diff", ...range] : ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", commit.hash];
  return { status: [...READ, ...base, "--name-status"], numstat: [...READ, ...base, "--numstat"] };
}
export const showArgs = (hash) => [...READ, "show", "-s", "--decorate=full", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%B", hash];
// One commit from showArgs' output: { hash, parents, author, email, time, committer, committed, refs, subject, body }.
export function parseShow(text) {
  const [hash = "", parents = "", author = "", email = "", time = "", committer = "", committed = "", refs = "", ...msg] = String(text ?? "").split("\x1f");
  const message = msg.join("\x1f").replace(/\s+$/, ""), [subject = "", ...rest] = message.split("\n");
  return { hash: hash.trim(), parents: parents ? parents.split(" ").filter(Boolean) : [], author, email, time: Number(time), committer, committed: Number(committed), refs: parseRefs(refs), subject, body: rest.join("\n").trim() };
}
export function joinFiles(statusText, numstatText) {
  const stats = new Map();
  for (const line of String(numstatText ?? "").split("\n").filter(Boolean)) {
    const [a, d, ...path] = line.split("\t");
    stats.set(path.join("\t"), { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
  }
  return String(statusText ?? "").split("\n").filter(Boolean).map((line) => {
    const [s, ...path] = line.split("\t"), p = path.join("\t");
    return { path: p, status: s[0], ...(stats.get(p) ?? { add: 0, del: 0, binary: false }) };
  });
}
export function diffArgs(commit, path) {
  const opts = ["--no-color", "--no-ext-diff", "--no-textconv"];
  if (!commit.parents.length) return [...READ, "show", ...opts, "--format=", commit.hash, "--", path];
  return [...READ, "diff", ...opts, commit.parents[0], commit.hash, "--", path];
}
// Numbers each diff line once (old / new line numbers), at most 3000 lines.
export function diffRows(text) {
  const all = String(text ?? "").replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return null;
  let old = 0, next = 0;
  return all.slice(first, first + 3000).map((raw) => {
    const line = raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, next: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, old: old++, next: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

// Dates in Korean: "방금", "5분 전", "3시간 전", "2일 전", then "11월 3일" / "2025년 11월".
export function ago(seconds, now = Date.now()) {
  const s = now / 1000 - seconds;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}일 전`;
  const d = new Date(seconds * 1000);
  return d.getFullYear() === new Date(now).getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
const pad2 = (n) => String(n).padStart(2, "0");
export const stamp = (seconds) => { const d = new Date(seconds * 1000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// Where a space works now: its first terminal's live folder, else the folder it was made with (as the App's worktree mod decides).
export function spaceFolder(space, paneList = []) {
  if (!space) return "";
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return String(paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || "").trim();
}
export const folderKey = (machine, folder) => `${machine ?? ""}|${String(folder ?? "").trim().replace(/[\\/]+/g, "/").replace(/(.)\/$/, "$1").toLowerCase()}`;
