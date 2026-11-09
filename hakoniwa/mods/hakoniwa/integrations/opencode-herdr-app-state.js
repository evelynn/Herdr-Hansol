// herdr-core（Herdr App）へ OpenCode の状態を OSC 7501 で知らせるプラグイン。
// 置き場所: ~/.config/opencode/plugins/herdr-app-state.js（install-app-state-hooks.py が入れる）
// herdr TUI 用の herdr-agent-state.js とは別物で、HC_TERMINAL_ID がある端末（herdr-core）の中でだけ動く。
import fs from "node:fs";

const APP = "opencode";
const CONSOLE = process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty";
const childSessions = new Map();
let last = "";
let turnWorked = false;

function send(state, { kind, msg } = {}) {
  const key = `${state}|${kind ?? ""}`;
  if (key === last) return;
  last = key;
  let body = `state=${state}:app=${APP}`;
  if (kind) body += `:kind=${kind}`;
  body += `:msg=${Buffer.from(msg ?? "", "utf8").toString("base64")}`;
  try {
    const fd = fs.openSync(CONSOLE, process.platform === "win32" ? "r+" : "w");
    try { fs.writeSync(fd, `\x1b]7501;${body}\x07`); } finally { fs.closeSync(fd); }
  } catch {
    last = ""; // 書けなかったら次回やり直す
  }
}

// セッションの題（OpenCode が最初の指示のあとに付ける自動の要約）が決まった・変わったら、端末のタイトル（OSC 2）として出す。
// 題だけを出す（指示や返答の本文は出さない）。「New session - 日時」の仮の題は出さない。
let lastTitle = "";
function sendTitle(title) {
  const t = String(title ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80);
  if (!t || t === lastTitle || /^(new|child) session\b/i.test(t)) return;
  lastTitle = t;
  try {
    const fd = fs.openSync(CONSOLE, process.platform === "win32" ? "r+" : "w");
    try { fs.writeSync(fd, `\x1b]2;${t}\x07`); } finally { fs.closeSync(fd); }
  } catch {
    lastTitle = "";
  }
}

const sessionOf = (p) => (typeof p?.sessionID === "string" ? p.sessionID : undefined);

export const HerdrAppStatePlugin = async () => {
  if (!process.env.HC_TERMINAL_ID) return {};
  // 起動直後は何も報告しないと status が null のまま（hc send の started が null になる）。読み込み時に idle を出す。
  setTimeout(() => send("idle"), 1500);
  return {
    "chat.message": async ({ sessionID }) => {
      if (sessionID && childSessions.has(sessionID)) return;
      turnWorked = true;
      send("working");
    },
    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties ?? {};
      const sid = sessionOf(props);
      if (props.info?.id && props.info.parentID) childSessions.set(props.info.id, props.info.parentID);
      if (sid && childSessions.has(sid)) {
        // 子セッションの承認待ちだけ親の端末へ反映する
        if (type === "permission.asked" || type === "question.asked") send("blocked", { kind: "permission", msg: "承認待ち（子）" });
        if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") send("working");
        return;
      }
      if (type === "session.updated" && props.info?.id && !props.info.parentID && !childSessions.has(props.info.id)) sendTitle(props.info.title);
      switch (type) {
        case "session.status": {
          const k = typeof props.status === "string" ? props.status : props.status?.type;
          if (["busy", "active", "running", "retry", "pending", "streaming", "working"].includes(String(k).toLowerCase())) {
            turnWorked = true;
            send("working");
          }
          break;
        }
        case "tool.execute.before":
        case "tool.execute.after":
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
        case "session.compacted":
          turnWorked = true;
          send("working");
          break;
        case "permission.asked":
          send("blocked", { kind: "permission", msg: "承認待ち" });
          break;
        case "question.asked":
          send("blocked", { msg: "質問待ち" });
          break;
        case "session.error":
          send("blocked", { msg: "エラー" });
          break;
        case "session.idle":
          send(turnWorked ? "done" : "idle");
          turnWorked = false;
          break;
        default:
          break;
      }
    },
  };
};

export default HerdrAppStatePlugin;
