// herdr 원격 제어 텔레그램 봇.
// 휴대폰 텔레그램에서 herdr 터미널 상태를 프로젝트(공간)별로 묶어 먼저 보고, 눌러서 승인·키·빠른 지시·중단·종료를 버튼으로 한다.
// 최신 정보만 처리: 화면 메시지는 늘 1개(새로 보내면 이전 것을 지움), 지난 메시지의 버튼은 실행하지 않음,
// 60초 넘은 화면의 조작 버튼은 먼저 새로 고침, 승인·거절은 지금도 승인 대기일 때만 실행. 알림도 터미널마다 최신 1개만 남김.
// hakoniwa 상단 바 "원격" 버튼이 켜고 끈다.
// 설정: config.json { "token": "<BotFather 토큰>", "chatId": <페어링 후 자동 기록>, "presets"?: ["빠른 지시", ...] } — 외부 공유·커밋 금지.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { createInterface } from "node:readline";

const DIR = process.env.HERDR_TG_HOME ?? dirname(fileURLToPath(import.meta.url));
const CONFIG = join(DIR, "config.json"), STATE = join(DIR, "state.json"), LOG = join(DIR, "bot.log");
const API = process.env.TG_API ?? "https://api.telegram.org";
const LAD = process.env.LOCALAPPDATA ?? "";
const pick = (p, name) => (existsSync(p) ? p : name);
const HC = pick(join(LAD, "Programs", "herdr-core", "hc.exe"), "hc");
const APP = pick(join(LAD, "Programs", "herdr-app", "herdr-app.exe"), "herdr-app");
const SCREEN_LINES = 20, SCREEN_CHARS = 2500, BEAT_MS = 5000;
const FRESH_MS = Number(process.env.HERDR_TG_FRESH_MS ?? 60000); // 이보다 오래된 화면의 조작 버튼은 실행하지 않고 새로 고침
const DEFAULT_PRESETS = ["계속 진행해 줘", "진행 상황을 짧게 보고해 줘", "지금 작업을 멈추고 대기해 줘", "변경 사항을 커밋해 줘", "/compact"];
const ST = { // 보여 주는 순서: 승인 대기 → 작업 중 → 완료 → 대기 → 셸
  blocked: { icon: "🟠", label: "승인 대기", order: 0 },
  working: { icon: "🔵", label: "작업 중", order: 1 },
  done: { icon: "🟢", label: "완료", order: 2 },
  idle: { icon: "⚪", label: "대기", order: 3 },
  shell: { icon: "⚫", label: "셸", order: 4 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const log = (msg) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {} };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const writeJson = (p, o) => { writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 2)); renameSync(`${p}.tmp`, p); };
const clock = () => new Date().toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit" });
const mins = (ms) => { if (!ms) return ""; const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`; };

let state = {};
function writeState(patch) { state = { ...state, ...patch, pid: process.pid, at: Date.now() }; try { writeJson(STATE, state); } catch (e) { log(`state write: ${e}`); } }

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20, encoding: "utf8" },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr || (err && !stdout ? String(err.message) : "") })));
}
const out = (r) => (r.stderr || r.stdout || "").trim().slice(0, 500);

async function tg(method, body) {
  const res = await fetch(`${API}/bot${cfg.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(70000) });
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!j.ok) throw new Error(`${method}: ${j.error_code ?? ""} ${j.description ?? ""}`.trim());
  return j.result;
}
const say = (text, extra = {}) => tg("sendMessage", { chat_id: cfg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const drop = (mid) => (mid ? tg("deleteMessage", { chat_id: cfg.chatId, message_id: mid }).catch(() => tg("editMessageReplyMarkup", { chat_id: cfg.chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }).catch(() => {})) : null);

// ---- herdr 조회 ----
async function terminals() {
  const r = await run(HC, ["ls", "--json"]);
  let list = []; try { list = JSON.parse(r.stdout).terminals ?? []; } catch { throw new Error(`hc ls 실패: ${out(r)}`); }
  await Promise.all(list.map(async (t) => {
    t.state = typeof t.status === "string" ? t.status : null;
    try {
      const g = JSON.parse((await run(HC, ["get", t.address, "--json"])).stdout);
      t.state = g.status?.state ?? t.state; t.msg = g.status?.msg ?? ""; t.app = g.status?.app ?? t.agent;
      t.title = g.labels?.display || g.labels?.["kanso.shown"] || g.title || ""; t.since = g.status_ms ?? null;
    } catch {}
    t.group = String(t.where ?? "").split(" / ")[0] || "기타";
  }));
  return list;
}
const stKey = (t) => (t.state && ST[t.state] ? t.state : t.state ? "idle" : "shell");
const st = (t) => ST[stKey(t)];
const name = (t) => cut(t.title || (stKey(t) === "shell" ? `셸 ${t.agent ?? ""}` : t.app || t.agent || ""), 30);
// 공간별로 묶고, 공간은 가장 급한 터미널 순, 공간 안은 상태 순
function groups(list) {
  const m = new Map();
  for (const t of list) { if (!m.has(t.group)) m.set(t.group, []); m.get(t.group).push(t); }
  for (const xs of m.values()) xs.sort((a, b) => st(a).order - st(b).order);
  return [...m.entries()].sort((a, b) => st(a[1][0]).order - st(b[1][0]).order || a[0].localeCompare(b[0]));
}

async function screen(addr, extra = 0) {
  const r = await run(HC, ["read", addr, "--lines", String(extra)]);
  if (r.code) throw new Error(`화면 읽기 실패: ${out(r)}`);
  const lines = r.stdout.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-(SCREEN_LINES + extra)).join("\n").replace(/\n{3,}/g, "\n\n");
}
const pre = (text, max) => { const e = esc(text); return `<pre>${e.length > max ? e.slice(-max).replace(/^[^\n]*\n/, "") : e || "(빈 화면)"}</pre>`; }; // 텔레그램 4096자 — 아래쪽(최신)만

// ---- 화면 ----
let cfg = {}, sel = null, pairTries = 0;
let panel = { mid: null, target: null, at: 0 }; // 지금 유효한 화면 메시지 1개
const notes = new Map(); // 터미널 -> 그 터미널의 최신 알림 message_id
const views = new Map(); // 터미널별 { more: 더보기 펼침, extra: 추가 줄, force: 다음 입력 강제 }
const vs = (a) => { if (!views.has(a)) views.set(a, { more: false, extra: 0, force: false }); return views.get(a); };
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const MAIN_KEYS = { reply_markup: { keyboard: [[{ text: "현황" }, { text: "새 셸" }]], resize_keyboard: true, is_persistent: true } };
const presets = () => (Array.isArray(cfg.presets) && cfg.presets.length ? cfg.presets : DEFAULT_PRESETS);

// 현황: 요약 1줄 + 공간별 묶음. 버튼도 공간 머리 + 터미널(상태 아이콘·주소·이름).
async function homeView() {
  const all = await terminals(), g = groups(all);
  const count = (k) => all.filter((t) => stKey(t) === k).length;
  const sum = Object.keys(ST).filter((k) => count(k)).map((k) => `${ST[k].icon}${count(k)}`).join("  ") || "터미널 없음";
  const lines = g.map(([grp, xs]) => `<b>${esc(grp)}</b>\n${xs.map((t) => `${st(t).icon} ${esc(t.address)} ${esc(name(t))}${stKey(t) !== "shell" ? ` · ${st(t).label}${t.since ? ` ${mins(t.since)}` : ""}` : ""}${t.msg && stKey(t) !== "done" ? `\n      ${esc(cut(t.msg, 60))}` : ""}`).join("\n")}`);
  const rows = [];
  for (const [grp, xs] of g) { rows.push([btn(`── ${grp} ──`, "h")]); for (const t of xs) rows.push([btn(`${st(t).icon} ${t.address}  ${name(t)}`, `o:${t.address}`)]); }
  rows.push([btn("↻ 새로고침", "h"), btn("＋ 새 셸", "n")]);
  return { text: `<b>herdr</b> ${clock()}   ${sum}\n\n${lines.join("\n\n") || "없음"}`, rows };
}

// 터미널: 상태 2~3줄 → 최근 화면 → 버튼(기본은 승인/거절 또는 Enter·Esc·중단, 빠른 지시, 더보기, 새로고침, 현황)
async function termView(addr) {
  const t = (await terminals()).find((x) => x.address === addr);
  if (!t) return { text: `<b>${esc(addr)}</b> 없음 (종료됨)`, rows: [[btn("◀ 현황", "h")]] };
  const v = vs(addr), s = st(t), a = addr, k = (label, key) => btn(label, `k:${a}:${key}`);
  const head = `${s.icon} <b>${esc(addr)}</b> ${s.label}${t.since && stKey(t) !== "shell" ? ` ${mins(t.since)}` : ""} · ${esc(t.group)}\n${esc(name(t))}${t.msg ? `\n↳ ${esc(cut(t.msg, 120))}` : ""}`;
  const body = await screen(addr, v.extra);
  const rows = [];
  if (stKey(t) === "blocked") rows.push([btn("✅ 승인", `A:${a}`), btn("❌ 거절", `D:${a}`)], [k("1", "1"), k("2", "2"), k("3", "3")]);
  else rows.push([k("Enter", "enter"), k("Esc", "esc"), btn("■ 중단", `i:${a}`)]);
  rows.push([btn("💬 빠른 지시", `Q:${a}`), btn(v.more ? "더보기 ▴" : "더보기 ▾", `m:${a}`)]);
  if (v.more) {
    rows.push([k("↑", "up"), k("↓", "down"), k("Tab", "tab"), k("y", "y"), k("n", "n")]);
    rows.push([k("Shift+Tab", "shift+tab"), k("Ctrl+C", "ctrl+c"), k("Space", "space"), k("⌫", "backspace")]);
    rows.push([btn(v.extra ? "화면 줄이기" : "화면 +100줄", `e:${a}`), btn(v.force ? "강제 입력 켬" : "강제 입력", `F:${a}`), btn("종료", `x:${a}`)]);
  }
  rows.push([btn("↻ 새로고침", `r:${a}`), btn("◀ 현황", "h")]);
  const hint = v.force ? "다음 글은 승인 대기 중에도 강제 입력" : "글을 쓰면 이 터미널에 입력";
  return { text: `${head}\n${pre(body, v.extra ? 3200 : SCREEN_CHARS)}<i>${clock()} · ${hint}</i>`, rows };
}

function presetView(addr) {
  const rows = presets().map((p, i) => [btn(cut(p, 40), `P:${addr}:${i}`)]);
  rows.push([btn("◀ 돌아가기", `r:${addr}`)]);
  return { text: `<b>${esc(addr)}</b> 에 보낼 지시\n누르면 바로 입력·Enter (직접 쓰려면 채팅창에 입력)`, rows };
}

const render = (target) => (target === "h" ? homeView() : target.startsWith("Q:") ? presetView(target.slice(2)) : termView(target));
// 지금 화면 메시지를 바꿈(실패하면 새로 보냄)
async function show(target) {
  const m = await render(target);
  if (panel.mid) {
    try { await tg("editMessageText", { chat_id: cfg.chatId, message_id: panel.mid, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, ...kb(m.rows) }); panel = { ...panel, target, at: Date.now() }; return; }
    catch (e) { if (/not modified/.test(String(e))) { panel = { ...panel, target, at: Date.now() }; return; } log(`edit: ${e.message}`); }
  }
  return fresh(target, m);
}
// 새 화면 메시지를 맨 아래에 보내고 이전 화면 메시지는 지움
async function fresh(target, m = null) {
  m ??= await render(target);
  const old = panel.mid, r = await say(m.text, kb(m.rows));
  panel = { mid: r.message_id, target, at: Date.now() };
  await drop(old);
}

// ---- 동작 ----
async function newShell() {
  const r = await run(APP, ["do", "tab.new"]);
  if (r.code) { await say(`새 셸 실패: ${esc(out(r))}`); return null; }
  let addr = null; try { addr = JSON.parse(r.stdout).terminal ?? null; } catch {}
  await sleep(1500);
  return addr;
}
async function killTerm(addr) {
  let r = await run(APP, ["do", "terminal.kill", "--terminal", addr]);
  if (r.code) r = await run(HC, ["kill", addr]);
  return r.code ? `${addr} 종료 실패: ${out(r)}` : `${addr} 종료함`;
}
let lastFailed = null;
async function sendText(addr, text, force = false) {
  const r = await run(HC, ["send", ...(force ? ["--force"] : []), addr, text], 60000);
  if (r.code) { lastFailed = { addr, text }; return `입력 실패: ${out(r)}`; }
  return null;
}
async function stateOf(addr) { return (await terminals()).find((t) => t.address === addr) ?? null; }

const HELP = [
  "<b>herdr 원격 제어</b>",
  "현황 · 프로젝트별로 묶은 터미널 상태(🟠승인 대기 🔵작업 중 🟢완료 ⚪대기 ⚫셸)",
  "터미널 버튼 · 상태와 최근 화면, 승인·거절·키·빠른 지시",
  "글 입력 · 지금 열린 터미널에 입력하고 Enter",
  "화면은 늘 최신 1개만 남고, 지난 메시지의 버튼은 실행되지 않음",
].join("\n");

// ---- 업데이트 처리 ----
function newPairCode() { pairTries = 0; writeState({ paired: false, code: String(randomInt(100000, 1000000)) }); }

async function handleMessage(m) {
  const chat = m.chat?.id, text = String(m.text ?? "").trim();
  if (!cfg.chatId) {
    const code = text.replace(/^\/pair(@\w+)?\s*/, "");
    if (code && code === state.code) {
      cfg.chatId = chat; writeJson(CONFIG, cfg); writeState({ paired: true, code: null }); log(`paired chat ${chat}`);
      await say(`연결됨. 이 대화에서만 명령을 받음.\n\n${HELP}`, MAIN_KEYS); return fresh("h");
    }
    if (++pairTries >= 5) newPairCode();
    return tg("sendMessage", { chat_id: chat, text: "herdr 화면 상단의 페어링 번호를 /pair 번호 로 보내 주세요." });
  }
  if (chat !== cfg.chatId) { log(`ignored chat ${chat}`); return; }
  const [cmd0, ...rest] = text.split(/\s+/), cmd = cmd0.replace(/@\w+$/, "").toLowerCase();
  if (cmd === "/start" || cmd === "/help" || text === "도움말") { await say(HELP, MAIN_KEYS); return fresh("h"); }
  if (cmd === "/status" || cmd === "/list" || text === "현황" || text === "목록") return fresh("h");
  if (cmd === "/new" || text === "새 셸") { const a = await newShell(); if (a) sel = a; return fresh(a ?? "h"); }
  if (cmd === "/read" && rest[0]) { sel = rest[0]; return fresh(sel); }
  if (text.startsWith("/")) { await say(`모르는 명령: ${esc(cmd0)}\n\n${HELP}`); return; }
  // 글: 지금 화면이 터미널이면 그 터미널, 아니면 마지막으로 연 터미널
  const target = panel.target && panel.target !== "h" ? panel.target.replace(/^Q:/, "") : sel;
  if (!target) { await say("먼저 현황에서 터미널을 고르세요."); return fresh("h"); }
  const force = vs(target).force; vs(target).force = false;
  const err = await sendText(target, text, force);
  if (err) return say(`<b>${esc(target)}</b> ${esc(err)}`, kb([[btn("강제로 보내기", `G:${target}`)]])).then((r) => { notes.set(`fail:${target}`, r.message_id); });
  sel = target; await sleep(3000); return fresh(target);
}

const ACTIONS = new Set(["k", "A", "D", "i", "P", "X", "F"]); // 오래된 화면에서는 실행하지 않는 조작
async function handleCallback(q) {
  if (!cfg.chatId || q.message?.chat?.id !== cfg.chatId) return tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  const mid = q.message.message_id, data = String(q.data ?? ""), [op, a, k] = data.split(":");
  const noteKey = [...notes.entries()].find(([, v]) => v === mid)?.[0] ?? null; // 지금 유효한 알림 메시지인가
  let toast = "";
  const answer = () => tg("answerCallbackQuery", { callback_query_id: q.id, ...(toast ? { text: cut(toast, 190), show_alert: false } : {}) }).catch(() => {});
  try {
    // 1) 지난 메시지: 실행하지 않고 버튼을 없앤 뒤 최신 화면을 보냄
    if (mid !== panel.mid && !noteKey) { toast = "지난 메시지라 실행하지 않음 · 최신 화면을 보냄"; await drop(mid); await fresh(panel.target ?? "h"); return; }
    // 2) 알림 메시지: 그 알림을 지우고, 승인·거절은 지금도 승인 대기일 때만
    if (noteKey) {
      notes.delete(noteKey); await drop(mid);
      if (op === "G") { if (lastFailed?.addr === a) { const err = await sendText(a, lastFailed.text, true); toast = err ?? `${a} 에 강제 입력함`; lastFailed = null; await sleep(err ? 0 : 3000); } sel = a; return await fresh(a); }
      if (op === "A" || op === "D") { const t = await stateOf(a); if (stKey(t ?? {}) !== "blocked") { toast = "이미 승인 대기가 아님 · 실행 안 함"; } else { const r = await run(HC, ["keys", a, op === "A" ? "enter" : "esc"]); toast = r.code ? `실패: ${out(r)}` : op === "A" ? `${a} 승인함` : `${a} 거절함`; await sleep(1200); } }
      sel = a; return await fresh(a);
    }
    // 3) 지금 화면: 오래된 화면의 조작 버튼은 새로 고침만
    if (ACTIONS.has(op) && Date.now() - panel.at > FRESH_MS) { toast = "화면이 오래되어 새로 고침함 · 확인 후 다시 눌러 주세요"; return await show(panel.target ?? "h"); }
    if (op === "h") return await show("h");
    if (op === "o" || op === "r") { sel = a; return await show(a); }
    if (op === "n") { const na = await newShell(); toast = na ? `새 셸 ${na}` : ""; if (na) sel = na; return await show(na ?? "h"); }
    if (op === "m") { vs(a).more = !vs(a).more; return await show(a); }
    if (op === "e") { vs(a).extra = vs(a).extra ? 0 : 100; return await show(a); }
    if (op === "Q") return await show(`Q:${a}`);
    if (op === "x") { const r = await tg("editMessageText", { chat_id: cfg.chatId, message_id: mid, text: `<b>${esc(a)}</b> 를 종료할까요? 되돌릴 수 없음.`, parse_mode: "HTML", ...kb([[btn("종료 확인", `X:${a}`), btn("취소", `r:${a}`)]]) }).catch(() => null); panel.at = Date.now(); return r; }
    if (op === "F") { vs(a).force = !vs(a).force; toast = vs(a).force ? "다음 글은 강제 입력" : "강제 입력 끔"; return await show(a); }
    if (op === "k") { const r = await run(HC, ["keys", a, k]); toast = r.code ? `실패: ${out(r)}` : `${a} ← ${k}`; await sleep(1000); return await show(a); }
    if (op === "A" || op === "D") { const t = await stateOf(a); if (stKey(t ?? {}) !== "blocked") { toast = "이미 승인 대기가 아님 · 실행 안 함"; return await show(a); } const r = await run(HC, ["keys", a, op === "A" ? "enter" : "esc"]); toast = r.code ? `실패: ${out(r)}` : op === "A" ? `${a} 승인함` : `${a} 거절함`; await sleep(1200); return await show(a); }
    if (op === "i") { const r = await run(HC, ["interrupt", a], 30000); toast = cut(out(r) || "중단 키 보냄", 180); return await show(a); }
    if (op === "P") { const p = presets()[Number(k)]; const err = p == null ? "없는 지시" : await sendText(a, p); toast = err ?? `보냄: ${cut(p, 30)}`; if (!err) await sleep(3000); return await show(a); }
    if (op === "X") { toast = await killTerm(a); if (sel === a) sel = null; await sleep(1000); return await show("h"); }
  } finally { await answer(); }
}

// ---- 알림: 상태 변화. 터미널마다 최신 알림 1개만 남김 ----
function watchEvents() {
  const prev = new Map();
  const child = spawn(HC, ["events", "--json"], { windowsHide: true });
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.terminals) { for (const t of o.terminals) prev.set(t.address, t.status?.state ?? null); return; }
    const p = o.params;
    if (o.method !== "event" || p?.type !== "status" || !p.terminal) return;
    const now = p.data?.status?.state ?? null, was = prev.get(p.terminal), a = p.terminal;
    prev.set(a, now);
    if (!cfg.chatId || now === was) return;
    try {
      const old = notes.get(a); if (old) { notes.delete(a); await drop(old); } // 상태가 바뀌면 지난 알림은 지움
      const msg = p.data?.status?.msg ? `\n↳ ${esc(cut(p.data.status.msg, 150))}` : "";
      let r = null;
      if (now === "blocked") r = await say(`${ST.blocked.icon} <b>${esc(a)} 승인 대기</b>${msg}`, kb([[btn("✅ 승인", `A:${a}`), btn("❌ 거절", `D:${a}`), btn("열기", `o:${a}`)]]));
      else if (now === "done" && was === "working") r = await say(`${ST.done.icon} <b>${esc(a)} 완료</b>${msg}`, kb([[btn("열기", `o:${a}`)]]));
      if (r) notes.set(a, r.message_id);
    } catch (e) { log(`notify: ${e}`); }
  });
  child.on("exit", (code) => { log(`hc events exited ${code}`); setTimeout(watchEvents, 5000); });
}

// ---- 시작 ----
async function main() {
  const old = readJson(STATE);
  if (old?.pid && old.pid !== process.pid && !old.stopped && Date.now() - (old.at ?? 0) < 20000) {
    try { process.kill(old.pid, 0); log(`already running (pid ${old.pid})`); return; } catch {}
  }
  cfg = readJson(CONFIG) ?? {};
  state = {};
  if (!cfg.token) { writeState({ error: `config.json 에 token 없음 (${CONFIG})` }); log("no token"); return; }
  writeState({ error: null, stopped: false, paired: !!cfg.chatId, code: null });
  setInterval(() => writeState({}), BEAT_MS);
  try { await tg("getMe", {}); } catch (e) { writeState({ error: `토큰 확인 실패: ${String(e.message).slice(0, 150)}` }); log(`getMe: ${e.message}`); process.exit(1); }
  tg("setMyCommands", { commands: [{ command: "status", description: "현황" }, { command: "new", description: "새 셸" }, { command: "help", description: "도움말" }] }).catch((e) => log(`commands: ${e.message}`));
  if (!cfg.chatId) newPairCode();
  let offset = 0;
  try { const last = await tg("getUpdates", { offset: -1, timeout: 0 }); if (last.length) offset = last[last.length - 1].update_id + 1; } catch {} // 꺼져 있던 동안 쌓인 것은 실행하지 않음
  log(`started pid ${process.pid}`);
  if (cfg.chatId) say("herdr 원격 켜짐 · 이전 메시지의 버튼은 더 이상 실행되지 않음", MAIN_KEYS).then(() => fresh("h")).catch((e) => log(`hello: ${e.message}`));
  watchEvents();
  for (;;) {
    try {
      const ups = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      for (const u of ups) {
        offset = u.update_id + 1;
        try { if (u.message) await handleMessage(u.message); else if (u.callback_query) await handleCallback(u.callback_query); }
        catch (e) { log(`handle: ${e.stack ?? e}`); if (cfg.chatId) say(`오류: ${esc(String(e.message ?? e).slice(0, 300))}`).catch(() => {}); }
      }
    } catch (e) { log(`poll: ${e.message}`); await sleep(5000); }
  }
}
main().catch((e) => { log(`fatal: ${e.stack ?? e}`); writeState({ error: `중단됨: ${String(e.message ?? e).slice(0, 150)}` }); process.exit(1); });
