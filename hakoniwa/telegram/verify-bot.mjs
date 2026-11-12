// 가짜 텔레그램 API 로 bot.mjs 시험: 공간별 묶음 현황, 단순 관리 화면, 화면 1개 유지(이전 삭제), 지난 메시지 무시, 오래된 화면 새로 고침, 빠른 지시, 더보기, 종료. 실패 시 exit 1.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HC = join(process.env.LOCALAPPDATA, "Programs", "herdr-core", "hc.exe");
const home = mkdtempSync(join(tmpdir(), "tgbot-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ token: "TEST", presets: ["echo \"preset-ok-$(6*7)\"", "계속"] }));
const sent = [], queue = [];
let uid = 1, mid = 100;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", async () => {
    const method = req.url.split("/").pop(), body = b ? JSON.parse(b) : {};
    const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 1, username: "test_bot" });
    if (method === "getUpdates") {
      if (body.offset === -1) return reply([]);
      const t0 = Date.now(); while (!queue.length && Date.now() - t0 < 800) await new Promise((r) => setTimeout(r, 50));
      return reply(queue.splice(0));
    }
    const rec = { method, at: Date.now(), ...body };
    if (method === "sendMessage") rec.message_id = ++mid;
    sent.push(rec);
    if (method === "sendMessage" || method === "editMessageText") return reply({ message_id: rec.message_id ?? body.message_id, chat: { id: body.chat_id } });
    return reply(true);
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const bot = spawn(process.execPath, [fileURLToPath(new URL("./bot.mjs", import.meta.url))], { env: { ...process.env, HERDR_TG_HOME: home, TG_API: `http://127.0.0.1:${srv.address().port}`, HERDR_TG_FRESH_MS: "10000" }, stdio: "inherit" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (text, chat = 777) => queue.push({ update_id: uid++, message: { message_id: uid, chat: { id: chat }, text } });
const cb = (m, data, chat = 777) => queue.push({ update_id: uid++, callback_query: { id: String(uid), data, message: { message_id: m, chat: { id: chat } } } });
async function waitFor(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = sent.find(pred); if (m) return m; await sleep(200); } return null; }
let fails = 0; const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fails++; };
const mark = () => sent.length;
const after = (n, pred) => (m) => sent.indexOf(m) >= n && pred(m);
const keys = (m) => JSON.stringify(m?.reply_markup ?? {});
let panel = null; // 지금 화면 메시지 id
const newPanel = async (n, pred = () => true, ms) => { const m = await waitFor(after(n, (x) => x.method === "sendMessage" && x.reply_markup?.inline_keyboard && pred(x)), ms); if (m) panel = m.message_id; return m; };
const edited = (n, pred = () => true, ms) => waitFor(after(n, (x) => x.method === "editMessageText" && x.message_id === panel && pred(x)), ms);
const toast = (n, re) => waitFor(after(n, (x) => x.method === "answerCallbackQuery" && re.test(x.text ?? "")));

let addr = null;
try {
  let st = null; for (let i = 0; i < 50 && !st?.code; i++) { await sleep(200); try { st = JSON.parse(readFileSync(join(home, "state.json"), "utf8")); } catch {} }
  addr = JSON.parse(execFileSync(HC, ["run", "--bg", "--no-parent", "--no-notify", "--outlive-parent", "--name", "tgtest", "--json", "--", "pwsh", "-NoLogo", "-NoProfile"], { encoding: "utf8" }).trim().split(/\r?\n/).pop()).address;
  await sleep(2000);
  let n = mark(); msg(`/pair ${st.code}`);
  const h = await newPanel(n, (m) => /<b>herdr<\/b>/.test(m.text));
  check("페어링 후 현황", !!h);
  const live = JSON.parse(execFileSync(HC, ["ls", "--json"], { encoding: "utf8" })).terminals;
  const grp = (t) => String(t.where ?? "").split(" / ")[0] || "기타";
  check("현황: 공간별 머리(글·버튼)", !!h && [...new Set(live.map(grp))].every((g) => h.text.includes(`<b>${g}</b>`) && keys(h).includes(`── ${g} ──`)));
  check(`현황: 시험 셸 ${addr} 한 줄 + 버튼`, !!h && h.text.includes(`⚫ ${addr} `) && keys(h).includes(`o:${addr}`));
  check("현황: 버튼은 새로고침·새 셸만 추가", !!h && keys(h).includes("↻ 새로고침") && keys(h).includes("＋ 새 셸") && !keys(h).includes("실시간"));

  n = mark(); cb(panel, `o:${addr}`);
  const tv = await edited(n, (m) => m.text.includes(`⚫ <b>${addr}</b> 셸`));
  check("관리 화면: 상태가 화면보다 먼저", !!tv && tv.text.indexOf(`<b>${addr}</b>`) < tv.text.indexOf("<pre>"));
  const rowsN = tv?.reply_markup?.inline_keyboard?.length ?? 99;
  check(`관리 화면: 기본 버튼 ${rowsN}줄(≤3) · Enter/Esc/중단/빠른 지시/더보기/새로고침/현황`, rowsN <= 3 && ["k:" + addr + ":enter", `k:${addr}:esc`, `i:${addr}`, `Q:${addr}`, `m:${addr}`, `r:${addr}`, '"h"'].every((s) => keys(tv).includes(s)));

  n = mark(); cb(panel, `m:${addr}`);
  check("더보기 → 방향키·Ctrl+C·종료", !!(await edited(n, (m) => [`k:${addr}:up`, `k:${addr}:ctrl+c`, `x:${addr}`].every((s) => keys(m).includes(s)))));
  n = mark(); cb(panel, `m:${addr}`);
  await edited(n, (m) => !keys(m).includes(`x:${addr}`));

  const oldPanel = panel;
  n = mark(); msg("echo \"remote-ok-$(7*6)\"");
  const np = await newPanel(n, (m) => /remote-ok-42/.test(m.text), 20000);
  check("글 입력 → 결과가 새 화면(맨 아래)", !!np);
  check("이전 화면 메시지 삭제", !!(await waitFor(after(n, (m) => m.method === "deleteMessage" && m.message_id === oldPanel))));

  n = mark(); cb(oldPanel, `k:${addr}:enter`);
  check("지난 메시지 버튼 → 실행 안 함 알림", !!(await toast(n, /지난 메시지라 실행하지 않음/)));
  check("지난 메시지 버튼 → 최신 화면 새로 보냄", !!(await newPanel(n)));

  n = mark(); cb(panel, `Q:${addr}`);
  check("빠른 지시 목록", !!(await edited(n, (m) => keys(m).includes(`P:${addr}:0`))));
  n = mark(); cb(panel, `P:${addr}:0`);
  check("빠른 지시 → 입력·결과", !!(await edited(n, (m) => /preset-ok-42/.test(m.text), 20000)));

  n = mark(); cb(panel, `A:${addr}`);
  check("승인 대기 아님 → 승인 실행 안 함", !!(await toast(n, /승인 대기가 아님/)));

  await sleep(10500);
  n = mark(); cb(panel, `k:${addr}:enter`);
  check("오래된 화면(10초+) 조작 → 새로 고침만", !!(await toast(n, /오래되어 새로 고침/)) && !!(await edited(n)));
  n = mark(); cb(panel, `k:${addr}:enter`);
  check("새로 고친 뒤에는 실행", !!(await toast(n, new RegExp(`${addr} ← enter`))));

  n = mark(); msg("현황", 555); cb(panel, "h", 555);
  await sleep(2500);
  check("다른 대화 무시", !sent.slice(n).some((m) => m.chat_id === 555 || m.method === "editMessageText"));

  n = mark(); cb(panel, `m:${addr}`); await edited(n, (m) => keys(m).includes(`x:${addr}`));
  n = mark(); cb(panel, `x:${addr}`);
  check("종료 확인", !!(await edited(n, (m) => /종료할까요/.test(m.text))));
  n = mark(); cb(panel, `X:${addr}`);
  check("종료 → 현황", !!(await toast(n, new RegExp(`${addr} 종료함`))) && !!(await edited(n, (m) => /<b>herdr<\/b>/.test(m.text))));
  await sleep(1000);
  check("시험 셸 사라짐", !JSON.parse(execFileSync(HC, ["ls", "--json"], { encoding: "utf8" })).terminals.some((t) => t.address === addr));
  check("모든 메시지 4096자 이하", !sent.some((m) => (m.text ?? "").length > 4096));
} finally {
  bot.kill();
  try { if (addr) execFileSync(HC, ["kill", addr], { stdio: "ignore" }); } catch {}
  try { if (addr) execFileSync(HC, ["rm", addr], { stdio: "ignore" }); } catch {}
  srv.close();
  console.log(`${fails ? "FAIL" : "ALL PASS"} (${fails} fail)`);
  process.exit(fails ? 1 : 0);
}
