// Cursor・Copilot のフックから呼ぶ。標準入力のイベントを OSC 7501 の状態へ変えて、端末へ直接書く。
// 使い方: node agent-hook.mjs <cursor|copilot> [イベント名]   （イベント名が無ければ標準入力の JSON から読む）
// HC_TERMINAL_ID が無ければ何もしない。標準出力はエージェントが受け取るので、必要最小限だけ返す。
import { emitViaAttach } from "./app-state-emit.mjs";

const agent = process.argv[2] ?? "agent";
const argEvent = process.argv[3] ?? "";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const norm = (s) => String(s ?? "").replace(/[_-]/g, "").toLowerCase();

const raw = await readStdin();
let payload = {};
try {
  const i = raw.indexOf("{");
  if (i >= 0) payload = JSON.parse(raw.slice(i));
} catch { /* 空でよい */ }

const event = norm(argEvent || payload.hook_event_name || payload.hookEventName);
const notifType = norm(payload.notification_type ?? payload.notificationType);

let state = null;
let opts = {};
switch (event) {
  case "sessionstart":
    state = "idle";
    break;
  case "beforesubmitprompt":
  case "userpromptsubmit":
  case "pretooluse":
  case "posttooluse":
  case "posttoolusefailure":
  case "precompact":
    state = "working";
    break;
  case "permissionrequest":
    state = "blocked";
    opts = { kind: "permission", msg: "承認待ち" };
    break;
  case "notification":
    if (notifType.includes("permission")) {
      state = "blocked";
      opts = { kind: "permission", msg: "承認待ち" };
    }
    break;
  case "stop":
  case "afteragentresponse":
    state = "done";
    break;
  default:
    break;
}

if (state) emitViaAttach(state, agent, opts);

// Cursor は種類ごとに期待する標準出力が違う。Copilot は何も返さない。
if (agent === "cursor") {
  if (event === "beforesubmitprompt") process.stdout.write('{"continue":true}');
  else process.stdout.write("{}");
}
process.exit(0);
