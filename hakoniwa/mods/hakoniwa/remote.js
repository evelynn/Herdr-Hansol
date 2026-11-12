// 2026-11-12 (user): "원격" on the band starts / stops the Telegram remote bot (D:/VBOX/herdr-telegram/bot.mjs: every terminal's list, screen, keys,
// sends, kill and new shell from a phone). The bot writes state.json every 5 s ({ pid, at, paired, code, error, stopped }); this reads it every 3 s.
// Off = taskkill of its pid (and its hc events child) and state.stopped. Nothing starts until the button is pressed.
import { h_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile } from "herdr";
import { P } from "./common.js";
import { UI } from "./ui-rules.js";

export const REMOTE_DIR = "D:/VBOX/herdr-telegram";
const STATE_FILE = `${REMOTE_DIR}/state.json`, LIVE_MS = 20000;

export function remoteView(s, now = Date.now()) {
  if (!s || s.stopped) return "off";
  if (s.error) return "error";
  if (now - (s.at ?? 0) > LIVE_MS) return "off";
  return s.paired ? "on" : "pair";
}

export class RemotePart {
  // Reads the bot's state. Returns true when what the button shows changed.
  async remotePoll() {
    let text = null, s = null;
    try { text = await readTextFile(STATE_FILE); s = text ? JSON.parse(text) : null; } catch {}
    const prev = this.remote ?? {}, view = remoteView(s);
    const shown = prev.view === "starting" && view !== "on" && view !== "pair" && view !== "error" && Date.now() - prev.since < 15000 ? "starting" : view;
    this.remote = { ...prev, view: shown, s, text };
    return shown !== prev.view || (s?.code ?? null) !== (prev.s?.code ?? null) || (s?.error ?? null) !== (prev.s?.error ?? null);
  }

  async remoteToggle(cx) {
    const r = this.remote ?? {};
    if (r.view === "starting") return;
    if (r.view === "on" || r.view === "pair") {
      if (r.s?.pid) { try { await exec("taskkill", ["/PID", String(r.s.pid), "/T", "/F"]); } catch {} }
      try { const now = await readTextFile(STATE_FILE); await writeTextFile(STATE_FILE, JSON.stringify({ ...(now ? JSON.parse(now) : {}), stopped: true }), now); } catch {}
      this.remote = { ...r, view: "off" };
    } else {
      this.remote = { ...r, view: "starting", since: Date.now() };
      cx.notify();
      try { await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath node -ArgumentList '"${REMOTE_DIR}/bot.mjs"' -WorkingDirectory '${REMOTE_DIR}' -WindowStyle Hidden`]); }
      catch (e) { this.remote = { ...this.remote, view: "error", s: { error: `시작 실패: ${String(e).slice(0, 150)}` } }; }
    }
    cx.notify();
  }

  remoteButton() {
    const r = this.remote ?? { view: "off" }, v = r.view;
    const label = v === "on" ? "원격 켬" : v === "pair" ? `페어링 ${r.s?.code ?? ""}` : v === "starting" ? "원격 시작 중" : v === "error" ? "원격 오류" : "원격 끔";
    const tip = v === "on" ? "텔레그램 원격 제어 켜짐 · 누르면 끔"
      : v === "pair" ? `휴대폰 텔레그램에서 봇에게 /pair ${r.s?.code ?? ""} 전송 · 누르면 끔`
      : v === "error" ? `${r.s?.error ?? "오류"} · 누르면 다시 시작`
      : v === "starting" ? "텔레그램 봇 시작 중" : "누르면 텔레그램 원격 제어 시작";
    const color = v === "on" ? "#3fb27f" : v === "pair" ? "#e0a93b" : v === "error" ? "#e06c6c" : P.line;
    return h_flex().id("hakoniwa-remote").flex_none().px(10).h(32).items_center().rounded(8)
      .border(1).border_color(color).text_size(UI.text.small).text_color(v === "off" ? P.ink : color).cursor_pointer()
      .hover((s) => s.bg("#253449")).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx2) => { await this.remoteToggle(cx2); }); })
      .child(label);
  }
}
