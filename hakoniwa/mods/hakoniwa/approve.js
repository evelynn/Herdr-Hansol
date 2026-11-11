// hakoniwa ★106 (office-approve106): answering a permission prompt from the screen. Pure functions (no App API), so the tests can feed screens and a fake `hc`.
// The choice is never hard-coded: the numbered lines of the terminal screen ("1. Yes" / "2. Yes, and don't ask again" / "3. No, ...") are read, and the
// number of the "yes" / "no" line is the key that is pressed. A screen that cannot be read gives no buttons ("端末で答えてください").

const LINE = /^\s*(?:[❯>›»▶▸→*]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
const YES = /^(yes|yep|(?:네|예)(?=$|[\s,.!?，。])|승인|허용|はい|承認|許可|allow|approve|proceed|accept|continue|ok\b)/i;
const NO = /^(no\b|아니요|아니오|거부|거절|취소|(?:승인|허용)\s*(?:하지|안\s*함)|いいえ|拒否|却下|deny|reject|cancel|decline|stop)/i;

export const classify = (label) => { const t = String(label ?? "").trim(); return NO.test(t) ? "no" : YES.test(t) ? "yes" : "other"; };

// The last run of numbered lines that starts at 1 and counts up by one (two or more lines). null when there is none.
export function parseOptions(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let best = null, run = [];
  const flush = () => { if (run.length >= 2) best = run; run = []; };
  for (const ln of lines) {
    const m = LINE.exec(ln);
    if (!m) {
      if (ln.trim() === "" ) continue; // a blank line inside the list is fine
      // 37th (office-fix42a, 35-C1): an option that wraps ("2. Yes, and don't ask again for: …" -> next line "      { New-Item …") continues the previous option.
      // Only a line indented deeper than that option's number, and not a rule line, is a continuation; "Esc to cancel" (shallower) and rules end the list.
      const last = run[run.length - 1];
      if (last && ln.search(/\S/) > last.col && !RULE.test(ln)) { last.cont = last.cont ? `${last.cont} ${ln.trim()}` : ln.trim(); continue; }
      flush(); continue;
    }
    const n = Number(m[1]);
    if (n === 1) { flush(); run = []; }
    if (run.length ? n === run[run.length - 1].n + 1 : n === 1) run.push({ n, label: m[2], kind: classify(m[2]), selected: /^\s*[❯>›»▶▸→]/.test(ln), col: ln.search(/\d/) });
    else flush();
  }
  flush();
  return best;
}

// Which number answers "yes" / "no": the first line of that kind (the plain "Yes" comes before "Yes, and don't ask again"). null when the screen has no such line.
export function pickKey(options, want) {
  if (!Array.isArray(options)) return null;
  const o = options.find((x) => x.kind === (want === "no" ? "no" : "yes"));
  return o ? o.n : null;
}

// What the two buttons may do for this screen: { yes: n|null, no: n|null, readable }.
export function approvalPlan(screen) {
  const options = parseOptions(screen);
  if (!options) return { readable: false, options: null, yes: null, no: null };
  return { readable: true, options, yes: pickKey(options, "yes"), no: pickKey(options, "no") };
}

// 18th F2 (office-fix18b): the screen copy of a waiting person ends with the permission dialog (rules, the ask, "1. Yes ..."), which the approval card below says again.
// stripApprovalDialog cuts it: from the rule line over the numbered options (the dialog's top; at most 30 lines up, else the line over the options) to the end of the screen.
// Only when the options can be read (the card then has buttons); an unreadable screen is returned as it is, so the person can still read the question. { text, cut }.
const RULE = /^\s*[─━╌┄┈╭┌╔]/;
export function stripApprovalDialog(screen) {
  const text = String(screen ?? ""), lines = text.split(/\r?\n/);
  const plan = approvalPlan(text);
  if (!plan.readable) return { text, cut: false };
  let first = -1; // the line of the "1." that starts the last run (the run parseOptions returned)
  for (let i = lines.length - 1; i >= 0; i--) { const m = LINE.exec(lines[i]); if (m && Number(m[1]) === 1) { first = i; break; } }
  if (first < 0) return { text, cut: false };
  let start = -1;
  for (let i = first - 1; i >= 0 && i >= first - 30; i--) { if (/^\s*[●⏺❯]/.test(lines[i])) break; if (RULE.test(lines[i])) start = i; } // the top-most rule within reach, never past a conversation line (●/⏺/❯)
  if (start < 0) { start = first; while (start > 0 && lines[start - 1].trim() !== "" && first - start < 3) start--; } // no rule: the ask line(s) right over the options
  while (start > 0 && lines[start - 1].trim() === "") start--; // the blank lines before it
  return { text: lines.slice(0, start).join("\n"), cut: true };
}

const statusOf = (r) => { try { const j = JSON.parse(String(r?.stdout ?? "").trim() || "{}"), s = j.status ?? j.terminal?.status; return { status: typeof s === "object" && s ? s.state ?? null : s ?? null, msg: s?.msg ?? s?.message ?? j.status_msg ?? j.msg ?? j.terminal?.msg ?? null }; } catch { return { status: null, msg: null }; } };

// Press the answer. Reads the screen again at the moment of the press (it may have changed), presses the number, waits, and checks that the state moved.
// io: { hc(args) -> {code, stdout, stderr}, sleep(ms) }. Returns { ok, reason, key }. reason: "unreadable" | "no-option" | "send-failed" | "unchanged" | "ok".
export async function answerApproval(io, address, want, waitMs = 1800) {
  const scr = await io.hc(["read", address]);
  const plan = approvalPlan(scr?.stdout ?? "");
  if (!plan.readable) return { ok: false, reason: "unreadable", key: null };
  const key = want === "no" ? plan.no : plan.yes;
  if (key == null) return { ok: false, reason: "no-option", key: null };
  const before = statusOf(await io.hc(["get", address, "--json"]));
  const r = await io.hc(["keys", address, String(key)]);
  if (r?.code) return { ok: false, reason: "send-failed", key, detail: String(r.stderr ?? "").slice(0, 120) };
  await io.sleep(waitMs);
  const after = statusOf(await io.hc(["get", address, "--json"]));
  if (!after.status) return { ok: false, reason: "unchanged", key };
  if (after.status === "blocked" && (before.status !== "blocked" || after.msg === before.msg)) return { ok: false, reason: "unchanged", key };
  return { ok: true, reason: "ok", key };
}

// 38th 36-D2 (office-fix43b): the window's pieces (head / conversation / card block) are separate copies and read the list on their own, so right after an approval the card block can still
// hold "blocked" while the head already says working. Each copy writes the newest state it saw per person (`seen`: id -> { status, since }); a "blocked" row is stale when `seen` has a later
// (or the same-since, not blocked) state for it. Pure. Returns the state to draw with: the row itself, or the row with the newer status.
export const SAME_SINCE_MS = 5000; // same since = the answer we wrote ourselves: it only holds for a few seconds (a 2nd ask that keeps the since must show its card)
export function liveState(a, seen, now = Date.now()) {
  if (!a || a.status !== "blocked") return a;
  const e = seen?.[a.id]; if (!e || e.status === "blocked" || !Number.isFinite(e.since) || !Number.isFinite(a.since) || e.since < a.since) return a;
  if (e.since === a.since && Number.isFinite(e.at) && now - e.at > SAME_SINCE_MS) return a;
  return { ...a, status: e.status, stale: true };
}
// The entry to write to `seen` when this copy saw `a` (null = nothing to write: an older state than the one already kept, or no usable `since`).
export function seenNext(a, prev, now = Date.now()) {
  if (!a?.id || !Number.isFinite(a.since)) return null;
  if (prev && (prev.since > a.since || (prev.since === a.since && !(a.status !== "blocked" && prev.status === "blocked")))) return null;
  return { status: a.status, since: a.since, at: now };
}

// 42nd 40-H1 (office-fix47a): after the person answers in the terminal the screen loses the dialog while hc still says "blocked" for 2-3 s, and a copy that reads it then (a window just rebuilt) gets an
// unreadable plan = the orange card without buttons ("端末で答えてください"). That wording is only for a dialog that was never readable. `readSeen` (shared "hakoniwa.apread": id -> { key, at }) says
// a copy once read this person's options in the same waiting episode (key = id|since); an unreadable screen read after that = answered, waiting for the state to catch up. Pure.
export const READ_SEEN_MS = 120000, ANSWERED_RECHECK_MS = 4000, UNREADABLE_RECHECK_MS = 1000;
export const planIsAsk = (plan) => !!plan?.readable && (plan.yes != null || plan.no != null);
export function readSeenNext(plan, key, now = Date.now()) { return planIsAsk(plan) && key ? { key, at: now } : null; } // the entry to write to `readSeen` (null = nothing to write)
export function answeredPlan(plan, readSeen, key, now = Date.now()) { return !planIsAsk(plan) && !!key && readSeen?.key === key && Number.isFinite(readSeen.at) && now - readSeen.at < READ_SEEN_MS; }
// Whether loadApproval must read the screen again for this entry: no entry / another episode / nothing readable yet (1 s) / answered (4 s: a 2nd ask that keeps the since must show its buttons).
export function needsApprovalRead(e, key, now = Date.now()) {
  if (!e || e.key !== key) return true;
  if (e.busy) return false;
  if (planIsAsk(e.plan)) return false;
  return now - (e.at ?? 0) >= (e.answered ? ANSWERED_RECHECK_MS : unreadableGap(e.tries));
}
// 42nd (parent's note): a dialog that stays unreadable (never answered) is not read every second for the whole wait: the gap doubles with each unreadable read (1, 2, 4, 8 s, at most 10 s). `tries` = unreadable reads so far.
// 44th 42-J2 (office-fix49a): the first reads of a new waiting episode are mostly "unreadable" only because the dialog is not drawn yet (it appears ~1-3 s after hc says blocked), so the doubling must not
// start at once (it made the reads land at +0.5, +1.5, +3.5 s: the buttons came ~3.4 s late). The first UNREADABLE_FAST_TRIES reads are one tick apart (~0.5-1 s, about 5 s in all); only an entry
// that is still unreadable after them backs off (1, 2, 4, 8 s, at most 10 s).
export const UNREADABLE_MAX_MS = 10000, UNREADABLE_FAST_MS = 500, UNREADABLE_FAST_TRIES = 8;
export const unreadableGap = (tries) => { const n = Math.max(0, Number(tries) || 0); return n <= UNREADABLE_FAST_TRIES ? UNREADABLE_FAST_MS : Math.min(UNREADABLE_MAX_MS, UNREADABLE_RECHECK_MS * 2 ** (n - UNREADABLE_FAST_TRIES - 1)); };
// 44th 42-J1: an entry whose last read was unreadable, in the fast phase and not answered, is still "loading" for the card (the line 「承認の内容を読み込み中…」 stays between the reads instead of
// flipping to 「端末で答えてください」 and back); `plan` null is loading too. Pure.
export const approvalLoading = (e) => !e?.plan || (!planIsAsk(e.plan) && !e.answered && !e.busy && (e.tries ?? 0) <= UNREADABLE_FAST_TRIES);
// 44th 42-J3: the card copy marked this waiting episode answered (shared "hakoniwa.apanswered": id -> { key, at }) a moment ago: the head says 「処理中…」 until hc's state changes. Pure.
export const ANSWERED_SHOW_MS = 20000;
export const answeredNow = (a, apanswered, now = Date.now()) => !!a?.id && a.status === "blocked" && apanswered?.[a.id]?.key === `${a.id}|${a.since}` && Number.isFinite(apanswered[a.id].at) && now - apanswered[a.id].at < ANSWERED_SHOW_MS;

// 43rd 41-I1 (office-fix48a): the card block (chat-approve) reads the screen again about every second while it shows buttons, so a dialog answered in the terminal is noticed at once (the state is
// still "blocked" for 2-3 s). `e` = the apprs entry. Due when the entry is of this episode, has readable options, is neither busy nor answered, and its last read is REREAD_MS old. Pure.
export const APPROVE_REREAD_MS = 500; // 45th 43-K3 (office-fix50a): was 1000 (a key answer was noticed 1.7 s late: 1.0-1.5 s of the wait for the next 0.5 s tick + the read); the watch ticks every 0.5 s
export const rereadDue = (e, key, now = Date.now()) => !!e && e.key === key && !e.busy && !e.answered && planIsAsk(e.plan) && now - (e.at ?? 0) >= APPROVE_REREAD_MS;

// 43rd 41-I4: does a screen copy already look like a conversation (an assistant / tool line "●" "⏺" "⎿", or a prompt line with text, or numbered options)? The start-up banner ("Welcome to Claude Code",
// the box, 「❯ Try "..."」) is not. Anything unsure counts as a conversation (the screen is drawn as it is).
export const screenIsConversation = (screen) => /^\s*[●⏺⎿]/m.test(String(screen ?? "")) || /^\s*[>❯›]\s+(?!Try\s)\S/m.test(String(screen ?? ""));
// What the conversation body draws for a screen copy: "loading" for a copy that began only moments ago (young) and whose screen is not a conversation yet; otherwise "screen". Pure.
export const screenBodyMode = (screen, msgCount, young) => (young && !(msgCount > 0) && !screenIsConversation(screen) ? "loading" : "screen");

// 43rd 41-I3: the input block opened for a window has its person's id / address / source in its props; the list may not be read yet, so the input is drawn from those (waiting = props.ap === 1). null = the props are not enough.
export const composerStandIn = (p) => p && p.id != null && p.id !== "" && p.address && p.source === "app" ? { id: p.id, name: p.name ?? "", address: p.address, source: "app", status: p.ap === 1 ? "blocked" : "idle", fromProps: true } : null;

// 38th 36-D3 (office-fix43b): hc's own ask line ("approve PowerShell: <command>") says the command the orange record already shows. True when that command is in the record text
// (whitespace ignored; a record that cut the command with a trailing "…" counts when what it shows is the start of the command). Only the paragraph is left out, never the buttons.
export function askInRecord(msg, recordText) {
  const m = /^\s*approve\s+[A-Za-z][\w-]*:\s*([\s\S]+?)\s*$/.exec(String(msg ?? "")); if (!m) return false;
  // 39th 37-E1 (office-fix44a): all whitespace is ignored (not only collapsed): the screen wraps a long word (a 110-char file name) at the terminal's width, and the record's lines then
  // joined with a space where the command has none, so the cut record never matched at the start. The "$ " split is done before the whitespace goes.
  const squash = (s) => String(s ?? "").replace(/\s+/g, ""), cmd = squash(m[1]), rec = squash(recordText);
  if (cmd.length < 2 || !rec) return false;
  if (rec.includes(cmd)) return true;
  return String(recordText ?? "").split(/(?:^|\s)\$\s+/).slice(1).some((p) => { const s = squash(p.replace(/\s*(?:…|\.\.\.)\s*$/, "")); return s.length >= 8 && cmd.startsWith(s); });
}

// 39th 37-E1 (office-fix44a): the paragraph under the card's heading (hc's own ask line) is at most `maxLines` lines, whatever the command's length, so the 承認・却下 buttons under it
// always fit in the card (the full text is the tooltip). Lines are estimated like chat.js approveLines (16 px per wide letter, 9 per narrow one) from the card's inner width. Pure -> { text, cut }.
export function clampAsk(text, width, maxLines = 2) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim(), inner = Math.max(120, (Number(width) || 400) - 26), budget = inner * maxLines * 0.9; // 0.9: wrapping at a word end wastes some of the last line
  let w = 0, out = "";
  for (const ch of [...t]) { w += ch.charCodeAt(0) > 255 ? 16 : 9; if (w > budget) return { text: out.replace(/\s+$/, "") + "…", cut: true }; out += ch; }
  return { text: t, cut: false };
}

// 39th 37-E4 (office-fix44a): the first line of the card ("Bash command（コマンドの実行）· Tip: auto mode handles these prompts for you — …") ends with Claude Code's advertisement; from " · Tip:" on it is dropped.
export const dropWhatTip = (s) => String(s ?? "").replace(/\s*[·・]\s*Tip:[\s\S]*$/i, "").replace(/\s+$/, "");

// Who is in the inbox, in the order they are shown: waiting (oldest first), then reporting (newest first).
export const inboxList = (list) => {
  const l = Array.isArray(list) ? list : [];
  return [...l.filter((a) => a.status === "blocked").sort((a, b) => (a.since ?? 0) - (b.since ?? 0)),
    ...l.filter((a) => a.status === "done").sort((a, b) => (b.since ?? 0) - (a.since ?? 0))];
};

// 14th D2/D6, 15th E1: the inbox window's height. A waiting card (buttons) is about 175px, a report is one 54px line (both measured in the 12th picture, office-ux12,
// y 328->382->436 for reports; the card with its gap); 100px for the title and padding (the title is 54 + 12 below the list, so the 34 over is the margin for a card whose text wraps a line more).
// room.js sizes the window with inboxHeight, inbox.js says "more below" with inboxFits: both use these numbers.
// 21st I3 (office-fix21b): the title is measured 56 + 8 below it (office-ux16: 1 waiting + 3 reports, content 355 = 56 + 137 + 162), so the base is 64, not 100 (it left 83px empty).
export const INBOX_BASE = 64, INBOX_WAIT_H = 175, INBOX_REPORT_H = 54;
// 20th H2/H3: a waiting card of the person the right window shows has no 「その人を開く」 row (32 + the 6 gap), so it is that much shorter; a wrapped
// text line or two more than the measured card is absorbed by INBOX_SLACK (room.js adds it to the window; the measured size in inbox.js still decides the 「続きあり」 line).
// 30b R4: that line was a button (32 + the 6 gap = 38), so the card was 42 less. 33b U3: the shown person's card now has no row at all (the header's 「右の窓に表示中」 mark only),
// so it is 42 + 38 = 80 less than the measured 175 (buttons 36 + gap 6 stay out too).
export const INBOX_SHOWN_CUT = 80, INBOX_SLACK = 24;
// 30b R2: what the window gets besides the cards. A pale kind heading is 16 + the 8 gap; a waiting card's "what" line (13px, one line, truncated) is about 18 + the 6 gap.
// The opening copy cannot know whether the screen was read yet, so every waiting card counts its line (the same number in the window's own copy: no reopen loop).
export const INBOX_DIVIDER_H = 24, INBOX_WHAT_H = 24;
export const inboxExtraH = (rows) => {
  const l = Array.isArray(rows) ? rows : [], w = l.filter((a) => a?.status === "blocked").length;
  return w * INBOX_WHAT_H + (w > 0 && l.length > w ? INBOX_DIVIDER_H : 0); // both kinds present -> exactly one change of kind -> one heading
};
const rowH = (a, shownId) => (a?.status === "blocked" ? INBOX_WAIT_H - (shownId != null && shownId !== "" && a.id === shownId ? INBOX_SHOWN_CUT : 0) : INBOX_REPORT_H);
export const inboxHeight = (rows, shownId) => { const l = Array.isArray(rows) ? rows : []; return INBOX_BASE + (l.length ? l.reduce((s, a) => s + rowH(a, shownId), 0) : INBOX_WAIT_H); };
export const inboxFits = (rows, h, shownId) => {
  const l = Array.isArray(rows) ? rows : [], cap = h > 0 ? h : 600; let used = INBOX_BASE, n = 0;
  for (const a of l) { used += rowH(a, shownId); if (used > cap) break; n++; }
  return Math.max(1, n);
};
// 20th H2: 「続きあり」 from the real sizes (the scroll area's own height and its content's height, both measured in inbox.js), not only from the estimate.
export const inboxHasMore = (rows, fits, viewH, contentH) => (Array.isArray(rows) ? rows.length : 0) > fits || (viewH > 0 && contentH > viewH + 2);

// 24th Q4: the first line of what a waiting person asks ("Create file · hello.txt"), from the entry detail.js loadApproval stored (detail = approvalDetailLines: [what, question]).
// Only a two-line detail has a "what" first; one line is the question alone or the "read the last operation" fallback, so nothing is shown then (nothing made up).
export const inboxWhat = (entry) => { const d = entry?.detail; return Array.isArray(d) && d.length === 2 ? String(d[0] ?? "").trim() : ""; };

// 30b R3: who still needs a read of the screen for the "what" line (inbox.js reads it itself when the shared copy of the entries has none). One read per person per `gap` ms.
export const inboxNeedsRead = (rows, entryOf, lastAt, now, gap = 4000) =>
  (Array.isArray(rows) ? rows : []).filter((a) => a?.status === "blocked" && a.address && !inboxWhat(entryOf(a)) && now - ((lastAt ?? {})[a.id] ?? 0) >= gap);

export const REASON_TEXT = {
  unreadable: "확인 화면을 읽을 수 없습니다. 터미널에서 응답해 주세요",
  "no-option": "선택할 수 있는 항목이 없습니다. 터미널에서 응답해 주세요",
  "send-failed": "키를 전송하지 못했습니다. 터미널에서 응답해 주세요",
  unchanged: "응답했지만 상태가 바뀌지 않았습니다. 터미널 화면을 확인해 주세요",
};
// 18th F5 (inbox.js): the two lines of a report row.
// 20th H6: a model in brackets at the end ("Claude Code（Opus 5.5）") is not part of the name: the name is "Claude Code", the model goes after the room (reportModel).
const MODEL_TAIL = /\s*[（(]([^（）()]*)[）)]\s*$/;
const rawName = (a) => String(a?.labels?.display || a?.name || a?.address || "").trim();
export const reportName = (a) => { const r = rawName(a), s = r.replace(MODEL_TAIL, "").trim(); return s || r; };
export const reportModel = (a) => { const m = rawName(a).match(MODEL_TAIL); return m && rawName(a).replace(MODEL_TAIL, "").trim() ? m[1].trim() : ""; };
// 19th G3: two rows with the same name AND the same room cannot be told apart, so only those get the terminal's address (faint, at the end of the line). Returns the set of ids.
export const reportDupes = (rows) => {
  const l = Array.isArray(rows) ? rows : [], seen = new Map(), out = new Set();
  for (const a of l) { const k = `${reportName(a)}\u0000${reportWhere(a)}`; if (seen.has(k)) { out.add(seen.get(k)); out.add(a.id); } else seen.set(k, a.id); }
  return out;
};
export const reportTag = (a) => String(a?.address ?? "").trim();
// 19th G5: the card of the person the right window shows says so (the buttons stay: either place answers the same).
export const shownRight = (a, selId) => !!a && selId != null && selId !== "" && a.id === selId;
export const reportWhere = (a) => { const w = String(a?.space || a?.tab || "").trim(); return w && w !== reportName(a) ? w : ""; } // always say where (a.name already is the display name when there is one: main.js displayName)
