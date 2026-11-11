// 22nd N7 (office-fix27b): in a screen copy of the conversation, the tool records ("● Searched for 1 pattern", "● Write(hello.txt)" and the "⎿ ..." lines under them) are told apart
// from what the person said, so detail.js can draw them in a pale thin frame. Only lines that look like a record are taken: a marker (● / ⏺) followed by Name(...) or one of the
// record verbs; its continuation is the "⎿" lines and the indented lines right under it. Every other line stays text. Pure.
import { approvalPlan, stripApprovalDialog } from "./approve.js";
const MARK = /^\s*[●⏺]\s+/;
const CALL = /^\s*[●⏺]\s+[A-Za-z][\w.-]*\(.*\)?\s*$/; // Write(hello.txt) / Bash(git status) / mcp-tool(...)
const VERB = /^\s*[●⏺]\s+(Searched|Searching|Read|Reading|Listed|Listing|Wrote|Writing|Updated|Updating|Edited|Editing|Created|Fetched|Fetching|Ran|Running|Explored|Exploring|Called)\b/;
const CONT = /^\s*⎿|^\s{3,}\S/; // the result line and the lines indented under the record

// 23rd P1 (office-fix28a): a record line with no "●" ("  Searched for 1 pattern", "  Read 3 files"): indented 2+ AND a record verb AND a count/"for" right after it, so a person's
// line (no indent, or "❯ ...") and prose that merely starts with a verb are not taken.
const BARE = /^\s{2,}(Searched|Read|Listed|Wrote|Updated|Edited|Created|Fetched|Ran|Explored|Called)\s+(?:for\s+)?\d/;
// 23rd P4: the line that ends a turn ("✻ Brewed for 5s · done 4:23", "Cooked for 1m 2s").
const END = /^\s*(?:[✻✳✶✢✽·*]\s*)?[A-Z][a-zé]+ed\s+for\s+(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/;
// 23rd P5: the heading life.js puts above a message from the parent: "（親 t19h office-ux22 から）" -> shown "（親から）", the address and name in the tooltip.
const FROM = /^\s*(?:[❯>]\s*)?（(?:親\s+(.+?)\s+から|상위\s+(.+?)로부터)）\s*$/;

// 25th R5: "t19h office-ux22" -> "office-ux22" (the words after the address); with only an address ("t19h") that address is returned.
export const fromName = (title) => { const t = String(title ?? "").trim(), m = /^\S+\s+(.+)$/.exec(t); return m ? m[1].trim() : t; };

// 25th R1 (office-fix30a): a screen copy of the conversation (the waiting person's) is drawn in a plain scroll that starts at the top, so after a 2nd turn the newest lines fell
// below the window and the 1st turn stayed in view. fitScreenLines keeps the newest lines that fit `height` (px; null / 0 = not known: nothing is cut). Sizes are on the safe side
// (a line 30 px, 10 px per narrow letter, 17 per wide one, 24 px of padding, 60 px of block gaps and frames): showing a few lines fewer is fine, the newest are never cut.
// back = how many more screens the "前の表示を読む" row went back. -> { text, hidden } (hidden = lines left out at the top).
export const SCREEN = { line: 30, narrow: 10, wide: 17, padX: 24, reserve: 60, older: 40 };
export function fitScreenLines(text, width, height, back = 0) {
  const t = String(text ?? ""), h = Number(height) || 0;
  if (!(h > 0)) return { text: t, hidden: 0 };
  // 36th office-fix41a (34-B1): a working terminal copy has ~100 unused blank rows between the request and the spinner; a run of blank lines counts as one line (non-blank lines and order are kept)
  const lines = t.split(/\r?\n/).filter((ln, i, a) => i === 0 || ln.trim() !== "" || a[i - 1].trim() !== ""), inner = Math.max(120, (Number(width) || 0) - SCREEN.padX);
  const cost = (ln) => Math.max(1, Math.ceil([...ln].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? SCREEN.wide : SCREEN.narrow), 0) / inner)) * SCREEN.line;
  const budget = Math.max(SCREEN.line * 4, h - SCREEN.reserve) * (1 + Math.max(0, back | 0));
  let used = 0, from = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { const c = cost(lines[i]); if (from < lines.length && used + c > budget) break; used += c; from = i; }
  if (from === 0) return { text: lines.join("\n"), hidden: 0 };
  while (from < lines.length - 1 && lines[from].trim() === "") from++; // do not start on a blank line
  return { text: lines.slice(from).join("\n"), hidden: from };
}

// 26th S2 (office-fix31a): the record the person is waiting on. While approval is asked (the dialog is cut off the copy), the LAST tool record is the one asked about
// (Write(bye.txt) ...); an earlier one (a refused Write, a Search) is history. It is marked `pending: true` only when nothing but blank text follows it (a turn end / a heading / words after
// it mean the record is not the open question). Returns the same blocks (new objects only for the marked one).
export function markPending(blocks) {
  const l = Array.isArray(blocks) ? blocks : [];
  let i = l.length - 1;
  while (i >= 0 && l[i].kind === "text" && String(l[i].text ?? "").trim() === "") i--;
  if (i < 0 || l[i].kind !== "tool") return l;
  return l.map((b, k) => (k === i ? { ...b, pending: true } : b));
}

// 27th T2 (office-fix32a): the 3rd line of the approval card ("approve Write: D:\work\…\bye.txt", hc's own message) said the same as the heading over it ("Create file（ファイルを作成） · bye.txt")
// and its long path took a line. `what` = that heading (inboxWhat of the card's entry; "" when the screen was not read). When the heading already names the file the line is left out ("");
// otherwise every path in it is cut to its file name (nothing is made up: only the directory part is dropped). Pure.
export function askLine(msg, what) {
  const t = String(msg ?? "").replace(/[\r\n]+/g, " ").trim(); if (!t) return "";
  const short = t.replace(/(?:[A-Za-z]:)?[^\s"'`]*[\\/]([^\\/\s"'`]+)/g, "$1"), w = String(what ?? "");
  const name = /([^\\/\s"'`]+\.[A-Za-z0-9]{1,8})$/.exec(short)?.[1] ?? "";
  if (w && (name ? w.includes(name) : w.includes(short))) return "";
  return short;
}

// 28th 27-U1・27-U2 (office-fix33a): after an approval the screen copy ends with the terminal's own input box (a rule, "❯ ...", a rule) and two footer lines
// ("Transcript saving is off ...", "manual mode on · ? for shortcuts"), so the last reply was hidden under them. stripTerminalFrame cuts them from the END of the text:
// first the KNOWN footer lines (only these two forms; an unknown line is kept), then the box if what is left ends with rule / "❯" line(s) / rule. A box that is not at the very end
// (an unknown line stays below it) is kept as it is. Nothing in the middle is touched. Pure. -> { text, cut } (cut = lines removed).
const T_RULE = /^\s*[─━╌┄┈]{3,}\s*$/;
const T_INPUT = /^\s*[❯>]/;
// 29th 28-V1 (office-fix34a): on the real screen each footer line starts with a symbol and a space ("⚠ Transcript saving is off — …", "⏸ manual mode on · ? for shortcuts"; while working
// "⏸ manual mode on · esc to interrupt"), so the symbol(s) + space are allowed before the known wording (only these symbols; the wording is still the known form).
// 28-V3: the right-aligned status line just above the box ("◉ xhigh · /effort") is cut too, but only when the box itself was cut (T_EFFORT = the known form only).
const T_SYM = "(?:[⚠⏸⏵⏯◉\\uFE0F]+\\s+)?";
const T_FOOT = new RegExp(`^\\s*${T_SYM}(?:Transcript saving is off\\b|(?:⏵⏵\\s*)?(?:manual|auto|plan|accept edits|bypass permissions)(?: mode)? on\\b|\\?\\s*for shortcuts\\b)`, "i");
const T_EFFORT = /^\s*(?:[◉●○◐◑◒◓️]+\s*)?(?:low|medium|med|high|xhigh|max)\s*[·•]\s*\/effort\b[^\n]*$/i;
export function stripTerminalFrame(screen) {
  const text = String(screen ?? ""), lines = text.split(/\r?\n/);
  let end = lines.length;
  const trim = () => { while (end > 0 && lines[end - 1].trim() === "") end--; };
  trim();
  while (end > 0 && T_FOOT.test(lines[end - 1])) { end--; trim(); }
  if (end > 0 && T_RULE.test(lines[end - 1])) {
    let i = end - 2;
    while (i >= 0 && !T_RULE.test(lines[i]) && !/^\s*[●⏺]/.test(lines[i]) && end - i <= 8) i--; // the input line(s) between the two rules (a long input wraps)
    if (i >= 0 && T_RULE.test(lines[i]) && i < end - 2 && T_INPUT.test(lines[i + 1])) { end = i; trim(); if (end > 0 && T_EFFORT.test(lines[end - 1])) { end--; trim(); } }
  }
  if (end === lines.length) return { text, cut: 0 };
  return { text: lines.slice(0, end).join("\n"), cut: lines.length - end };
}

// 30th 29-W1 (office-fix35a): while the state is still "working" (a few seconds after the dialog came up) the screen copy already ends with the permission dialog. openApprovalCut cuts it
// whatever the state is, but only when the text REALLY ends with a dialog: readable options with a "yes" line, an ask line ("...?") or "Esc to cancel" in the cut part, and nothing but the
// option lines / their wrapped lines / key hints / blank lines after the last option. A reply with a numbered list ("1. Yes ...") in the middle of the conversation is not touched.
// -> { text, cut, waiting } (waiting = the dialog was cut: the card is not shown yet if the state is not "blocked").
const ESC_HINT = /^\s*esc to cancel\b/i;
export function openApprovalCut(screen) {
  const text = String(screen ?? ""), none = { text, cut: false };
  const plan = approvalPlan(text);
  if (!plan.readable || plan.yes == null) return none;
  const r = stripApprovalDialog(text);
  if (!r.cut) return none;
  const lines = text.split(/\r?\n/), kept = r.text === "" ? 0 : r.text.split(/\r?\n/).length, tail = lines.slice(kept);
  if (!tail.some((l) => ESC_HINT.test(l) || /\?\s*$/.test(l))) return none;
  let last = tail.length - 1;
  while (last >= 0 && tail[last].trim() === "") last--;
  if (last < 0) return none;
  const lastLine = tail[last];
  const okEnd = ESC_HINT.test(lastLine) || /^\s*(?:[❯>›»▶▸→*]\s*)?\d{1,2}[.)]\s+\S/.test(lastLine) || /^\s{3,}\S/.test(lastLine);
  if (!okEnd) return none;
  return { text: r.text, cut: true };
}

// 30th 29-W5: the turn-end line in a known form ("✻ Churned for 3s · done 6:35", "Cooked for 1m 2s") -> "完了（3秒）". Only that form; an unknown line is returned as it is.
const END_FULL = /^\s*(?:[✻✳✶✢✽·*]\s*)?[A-Z][a-zé]+ed\s+for\s+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s(?:\s*[·•]\s*done\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$/;
const durText = (h, mi, s) => `${h ? `${h}시간 ` : ""}${mi ? `${mi}분 ` : ""}${s || (!h && !mi) ? `${s}초` : ""}`.trim();
// 34th 33-A7: `rejected` (the record just before the line is 「却下しました: …」) -> 「却下で終了（3秒）」 instead of 「完了（3秒）」. Only for the known form.
export function endLabel(line, rejected = false) {
  const t = String(line ?? ""), m = END_FULL.exec(t);
  if (!m) return t;
  return `${rejected ? "거부로 종료" : "완료"} (${durText(Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0))})`;
}

// 34th 33-A1 (office-fix39a): while the person works the screen copy ends with Claude Code's spinner line ("✻ Frolicking… (3s · ↓ 339 tokens · thought for 1s)", seen on a real screen) and a Tip line
// under it ("  ⎿  Tip: Name your conversations with /rename …"). Only the known spinner form (a word + "…" + "(" + a duration first) is a "work" line -> 「作業中…（3秒）」; the Tip line (⎿ + "Tip:", or
// indented 2+ with "Tip:") is dropped. An unknown line stays as text.
const WORK = /^\s*(?:[✻✳✶✢✽·*]\s*)?[A-Z][a-zé]+(?:…|\.\.\.)\s*\(\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\b[^)]*\)?\s*$/;
const TIP = /^\s*⎿\s+Tip:\s|^\s{2,}Tip:\s/;
export const isWorkLine = (line) => WORK.test(String(line ?? ""));
export const isTipLine = (line) => TIP.test(String(line ?? ""));
// The Tip lines are taken out before the fit counts rows (a wrapped English Tip would use up room that the earlier turns need).
export const dropTipLines = (text) => String(text ?? "").split(/\r?\n/).filter((l) => !TIP.test(l)).join("\n");
export function workLabel(line) {
  const t = String(line ?? ""), m = WORK.exec(t);
  if (!m) return t;
  return `작업 중… (${durText(Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0))})`;
}

// 34th 33-A7: the small mark in front of a record: ✓ for 「ファイルを作成」「ファイルを編集」, ✕ for 「却下しました」; null for every other record.
export function toolMark(text) {
  const l = toolLabel(text);
  return /^(?:파일 (?:생성|수정)|ファイルを(?:作成|編集))/.test(l) ? "ok" : /^(?:거부됨|却下しました)/.test(l) ? "no" : null;
}
// 34th 33-A7: the block before the turn-end line (skipping blank text) is a rejected record.
export function endRejected(blocks, i) {
  for (let j = i - 1; j >= 0; j--) {
    const b = blocks[j];
    if (b.kind === "text" && String(b.text ?? "").trim() === "") continue;
    return b.kind === "tool" && toolMark(b.text) === "no";
  }
  return false;
}

// 31st 30-X5 (office-fix36a): the search / read record in the forms seen on a real screen ("● Searched for 1 pattern (ctrl+o to expand)", "  Read 3 files") -> a short Japanese line
// ("検索（1件）" / "ファイルを読む（3件）" / "一覧を取得（2件）"). Only a block that is that ONE line in a known form; an unknown form (several records on a line, a ⎿ line under it) is returned as it is.
// 32nd 31-Y4 (office-fix37a): the compound form on one line ("● Searched for 1 pattern, read 2 files (ctrl+o to expand)") -> "検索（1件）・ファイルを読む（2件）". Every part must be a known form
// (the later parts start in lower case on a real screen); one unknown part leaves the whole line as it is.
const REC_HEAD = /^\s*(?:[●⏺]\s+)?/, REC_HINT = /\s*\(ctrl\+o to expand\)\s*$/;
// 37th office-fix42b (35-C3): "Ran 1 shell command" / "ran 2 shell commands" (PowerShell・Bash) is a known part too -> 「シェルを実行（N件）」.
const REC_PART = /^(?:(searched) for|(read|listed|ran))\s+(\d+)\s+(patterns?|files?|paths?|directories|directory|shell commands?)$/i;
function partLabel(p) {
  const m = REC_PART.exec(p.trim()); if (!m) return null;
  const n = Number(m[3]), noun = m[4], verb = (m[1] ?? m[2]).toLowerCase();
  if (verb === "ran" && /^shell command/i.test(noun)) return `셸 실행 (${n}건)`;
  if (verb === "searched" && /^pattern/i.test(noun)) return `검색 (${n}건)`;
  if (verb === "read" && /^file/i.test(noun)) return `파일 읽기 (${n}건)`;
  if (verb === "listed" && /^(path|director)/i.test(noun)) return `목록 조회 (${n}건)`;
  return null;
}
// 32nd 31-Y3・31-Y5: a Write record ("● Write(no.txt)" + "⎿  User rejected write to no.txt" / "⎿  Wrote 1 line to bye.txt" + the file's own indented lines) is one line:
// 「却下しました: no.txt」/「ファイルを作成: bye.txt」 (the file name only; the content is not shown, the original is the tooltip). Anything else in the block (an unknown ⎿ line, a non-indented line) leaves it as it is.
const WRITE_CALL = /^\s*[●⏺]\s+Write\(.*\)\s*$/;
const WRITE_RES = /^\s*⎿\s+(?:(Wrote)\s+\d+\s+lines?\s+to|(User rejected write to))\s+(.+?)\s*$/;
function writeLabel(t) {
  const lines = t.split(/\r?\n/);
  if (lines.length < 2 || !WRITE_CALL.test(lines[0])) return null;
  const m = WRITE_RES.exec(lines[1]); if (!m) return null;
  if (!lines.slice(2).every((l) => l.trim() === "" || /^\s{3,}\S/.test(l))) return null;
  const name = m[3].replace(/^["'`]|["'`]$/g, "").split(/[\\/]/).filter(Boolean).pop();
  if (!name) return null;
  return m[1] ? `파일 생성: ${name}` : `거부됨: ${name}`;
}
// 33rd 32-Z2 (office-fix38b): an Edit record as claude 2.1.319 prints it ("● Update(edit.txt)" + "⎿  Added 1 line, removed 1 line" + the diff lines "      1 -hello world" / "      1 +hello there")
// is one line: 「ファイルを編集: edit.txt（1行追加・1行削除）」 (the diff is not shown, the original is the tooltip). Only one of the two counts: 「（2行追加）」/「（1行削除）」. The tool name is `Update(…)`
// (only that form was seen); an unknown ⎿ line, a non-indented line or a count form that is not known leaves the block as it is.
const EDIT_CALL = /^\s*[●⏺]\s+Update\((.*)\)\s*$/;
const EDIT_RES = /^\s*⎿\s+(?:Added\s+(\d+)\s+lines?(?:\s*,\s*removed\s+(\d+)\s+lines?)?|Removed\s+(\d+)\s+lines?)\s*$/i;
function editLabel(t) {
  const lines = t.split(/\r?\n/);
  if (lines.length < 2) return null;
  const c = EDIT_CALL.exec(lines[0]); if (!c) return null;
  const m = EDIT_RES.exec(lines[1]); if (!m) return null;
  if (!lines.slice(2).every((l) => l.trim() === "" || /^\s{3,}\S/.test(l))) return null;
  const name = c[1].trim().replace(/^["'`]|["'`]$/g, "").split(/[\\/]/).filter(Boolean).pop();
  if (!name) return null;
  const parts = [m[1] != null ? `${m[1]}줄 추가` : null, m[2] != null || m[3] != null ? `${m[2] ?? m[3]}줄 삭제` : null].filter(Boolean);
  return `파일 수정: ${name} (${parts.join(" · ")})`;
}
// 37th office-fix42b (35-C3): a PowerShell / Bash record as seen in office-ux35's trial terminal ("  Creating empty bye.txt in scratch directory if absent" — the leading "●" blinks, so a screen
// copy may lack it — and "  ⎿  $ $p = '…'; if (…) { … }" under it, the rest of the command on indented lines) is one line: 「シェルを実行: <description>」 (the command is not shown, the original is
// the tooltip). SHELL_RES is the ⎿ line that starts with "$ "; an unknown ⎿ line, a non-indented line under it or an empty description leaves the block as it is.
const SHELL_RES = /^\s*⎿\s+\$\s+\S/;
const SHELL_HEAD = /^\s*(?:[●⏺]\s+)?(?![⎿❯>])(\S.*?)\s*$/;
const SHELL_DUR = /^(.*?)\s+[·•]\s+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s$/;
function shellLabel(t) {
  const lines = t.split(/\r?\n/);
  if (lines.length < 2 || !SHELL_RES.test(lines[1]) || CALL.test(lines[0]) || /^\s*[●⏺]\s+[A-Za-z][\w.-]*\(/.test(lines[0])) return null;
  const m = SHELL_HEAD.exec(lines[0]); if (!m || /^[●⏺]/.test(m[1]) || !(MARK.test(lines[0]) || /^\s+\S/.test(lines[0]))) return null;
  if (!lines.slice(2).every((l) => l.trim() === "" || /^\s{3,}\S/.test(l))) return null;
  // 39th office-fix44b (37-E6): a trailing 「 · 21s」/「 · 1m 5s」/「 · 1h 2m 3s」 (a known duration form only) -> 「（21秒）」. The description (Claude's English) is kept as it is; with nothing before the duration the line is left as it is.
  const d = SHELL_DUR.exec(m[1]);
  if (d && d[1].trim() !== "") return `셸 실행: ${d[1].trim()} (${durText(Number(d[2] ?? 0), Number(d[3] ?? 0), Number(d[4] ?? 0))})`;
  return `셸 실행: ${m[1]}`;
}
// the head line of such a record (used by splitToolBlocks with the line after it)
const isShellHead = (ln, next) => SHELL_RES.test(String(next ?? "")) && shellLabel(`${ln}\n${next}`) != null;
// 38th office-fix43a (36-D1): a PowerShell / Bash record that was refused ("  Read 1 file, ran 1 shell command" + "  ⎿  Interrupted · What should Claude do instead?", seen in ux36's masked-reject.png)
// is one line: 「却下しました: <the first line in Japanese>」, so toolMark gives ✕ and endRejected 「却下で終了」 like a refused Write. The first line must be a known one-line form
// (toolLabel changes it); an unknown first line, an unknown ⎿ line or a non-indented line under it leaves the block as it is.
const INTERRUPT = /^\s*⎿\s+Interrupted\s*[·•]\s*What should Claude do instead\?\s*$/;
function rejectLabel(t) {
  const lines = t.split(/\r?\n/);
  if (lines.length < 2 || !INTERRUPT.test(lines[1])) return null;
  if (!lines.slice(2).every((l) => l.trim() === "" || /^\s{3,}\S/.test(l))) return null;
  const head = toolLabel(lines[0]);
  if (!(head !== lines[0] && !/[\r\n]/.test(head) && /^[^●⏺]/.test(head))) return null;
  // 40th office-fix45a (38-F1): "Interrupted" marks only the LAST command as refused, so 「シェルを実行（2件）」 becomes 「シェルを実行（2件。最後の1件は却下）」; with 1 command it stays as it is.
  return `거부됨: ${head.replace(/셸 실행 \((\d+)건\)/, (all, n) => (Number(n) >= 2 ? `셸 실행 (${n}건, 마지막 1건 거부)` : all))}`;
}
export function toolLabel(text) {
  const t = String(text ?? "");
  if (/[\r\n]/.test(t.trim())) return writeLabel(t) ?? editLabel(t) ?? shellLabel(t) ?? rejectLabel(t) ?? t;
  const body = t.replace(REC_HEAD, "").replace(REC_HINT, "");
  if (!/^[A-Z]/.test(body)) return t;
  const labels = body.split(/,\s*/).map(partLabel);
  return labels.length > 0 && labels.every((x) => x != null) ? labels.join("・") : t;
}

export const isToolHead =(line) => CALL.test(String(line ?? "")) || VERB.test(String(line ?? "")) || BARE.test(String(line ?? ""));
export const isTurnEnd = (line) => END.test(String(line ?? ""));
export function screenExcerpt(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!/^[●⏺•]/.test(line) || isToolHead(line) || isWorkLine(line)) continue;
    const text = line.replace(/^[●⏺•]\s*/, "").trim();
    if (/^[A-Za-z][\w.-]*\(/.test(text)) continue;
    if (text.length < 4) continue;
    return text.length > 160 ? text.slice(0, 159) + "…" : text;
  }
  return "";
}

// [{ kind: "tool" | "text" | "end" | "from", text, label?, title? }] in the original order; the lines of a block are joined with "\n". Blank lines inside a text run are kept; a blank line ends a record.
// "end" / "from" are single lines (text = the original line; "from" also has label "（親から）" and title = the address and name).
export function splitToolBlocks(screen) {
  const lines = String(screen ?? "").split(/\r?\n/), out = [];
  const push = (kind, ln) => { const l = out[out.length - 1]; if (l && l.kind === kind) l.text += "\n" + ln; else out.push({ kind, text: ln }); };
  let inTool = false, seenFrom = false;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li], fm = FROM.exec(ln);
    if (fm) { const parent = fm[1] ?? fm[2]; out.push({ kind: "from", text: ln, label: "(상위 에이전트)", title: parent, name: fromName(parent), again: seenFrom }); seenFrom = true; inTool = false; continue; }
    if (isTurnEnd(ln)) { out.push({ kind: "end", text: ln }); inTool = false; continue; }
    if (isWorkLine(ln)) { out.push({ kind: "work", text: ln }); inTool = false; continue; } // 34th 33-A1: the spinner line
    if (isTipLine(ln)) { inTool = false; continue; } // 34th 33-A1: the Tip line is not shown
    if (isToolHead(ln) || isShellHead(ln, lines[li + 1])) { out.push({ kind: "tool", text: ln }); inTool = true; continue; } // 37th 35-C3: the shell record's head (description) is a record when "⎿  $ …" follows
    if (inTool && ln.trim() !== "" && !MARK.test(ln) && !/^\s*[❯>]/.test(ln) && CONT.test(ln)) { push("tool", ln); continue; }
    inTool = false; push("text", ln.replace(/^(\s*)[●⏺]\s+/, "$1")); // 40th 38-F4: the terminal's own "● " in front of the reply is dropped (the paragraph break tells it apart); tool records keep theirs
  }
  return out;
}
