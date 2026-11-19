// OSC 7501 を herdr-core の端末へ直接書く（フックの標準出力はエージェントが受け取るため、端末のデバイスへ書く）。
// 使い方: node app-state-emit.mjs <state> <app> [--kind permission] [--msg 文言]
// HC_TERMINAL_ID が無い（herdr-core の端末の外）なら何もしない。
// 注意: Windows の CONOUT$ は、先頭の \\.\ を付けたパスで開く（付けないと書けても届かない。2026-11-02 試験）。
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN_CONSOLE = "\\\\.\\CONOUT$";

export function oscBody(state, app, { kind, msg } = {}) {
  let body = `state=${state}:app=${app}`;
  if (kind) body += `:kind=${kind}`;
  body += `:msg=${Buffer.from(msg ?? "", "utf8").toString("base64")}`;
  return `\x1b]7501;${body}\x07`;
}

export function emit(state, app, opts = {}) {
  if (!process.env.HC_TERMINAL_ID) return false;
  const seq = oscBody(state, app, opts);
  const target = process.platform === "win32" ? WIN_CONSOLE : "/dev/tty";
  try {
    const fd = fs.openSync(target, process.platform === "win32" ? "r+" : "w");
    try { fs.writeSync(fd, seq); } finally { fs.closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

// フックのプロセスは端末とは別のコンソールを持つため、CONOUT$ に書いても届かない（2026-11-02 Cursor で確認）。
// 端末の本体プロセスの console へ AttachConsole して書く PowerShell を、待たずに起動する（Add-Type で約1.5秒かかるため）。
export function emitViaAttach(state, app, opts = {}) {
  const tid = process.env.HC_TERMINAL_ID;
  if (!tid || process.platform !== "win32") return false;
  const hc = process.env.HC_BIN || "hc";
  const r = spawnSync(hc, ["get", tid, "--json"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  let pid;
  try { pid = JSON.parse(r.stdout).pid; } catch { return false; }
  if (!pid) return false;
  const body = oscBody(state, app, opts).slice("\x1b]7501;".length, -1);
  const script = fileURLToPath(new URL("./console-write.ps1", import.meta.url));
  // 待たずに終了すると子が反映前に消えることがあったので、同期で待つ（約1.5秒）。
  const p = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-TargetPid", String(pid), "-Body", body],
    { stdio: "ignore", windowsHide: true, timeout: 8000 },
  );
  return p.status === 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [state, app, ...rest] = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (state && app) process.exit(emit(state, app, opt) ? 0 : 1);
}
