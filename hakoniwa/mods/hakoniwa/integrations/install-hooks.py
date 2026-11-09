#!/usr/bin/env python
"""OpenCode・Cursor・Copilot に、Herdr App（herdr-core）へ状態を送る仕組みを入れる。

置くもの（ソースはこのスクリプトと同じフォルダ）:
  OpenCode : ~/.config/opencode/plugins/herdr-app-state.js（新規ファイル。herdr のものは触らない）
  Cursor   : ~/.cursor/hooks.json に自分のエントリを足す（変更前に hooks.json.bak-20261102 を作る）
  Copilot  : ~/.copilot/hooks/herdr-app-state.json（新規ファイル。既存の設定は触らない）

使い方:
  python ~/.config/herdr-app/mods/hakoniwa/integrations/install-hooks.py            # 入れる（何度でも可）
  python ~/.config/herdr-app/mods/hakoniwa/integrations/install-hooks.py --uninstall # 自分が入れたものだけ外す
  python ~/.config/herdr-app/mods/hakoniwa/integrations/install-hooks.py --dry-run   # 変更せず内容だけ表示
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

BACKUP_SUFFIX = ".bak-20261102"
MARK = "agent-hook.mjs"  # 自分のエントリの目印

HERE = Path(__file__).resolve().parent
# ★108: next to this script (the layout collection's copy: mods/<name>/integrations/), else the source tree's integrations folder
SRC = HERE if (HERE / "agent-hook.mjs").is_file() else HERE.parents[1] / ".claude" / "herdr-app" / "integrations"
HOOK = (SRC / "agent-hook.mjs").as_posix()
HOME = Path.home()

OPENCODE_DST = HOME / ".config" / "opencode" / "plugins" / "herdr-app-state.js"
CURSOR_JSON = HOME / ".cursor" / "hooks.json"
COPILOT_DST = HOME / ".copilot" / "hooks" / "herdr-app-state.json"

CURSOR_EVENTS = ["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop"]
COPILOT_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "Stop"]


def backup(path: Path, dry: bool) -> None:
    bak = path.with_name(path.name + BACKUP_SUFFIX)
    if path.exists() and not bak.exists():
        print(f"  バックアップ: {bak}")
        if not dry:
            shutil.copy2(path, bak)


def cursor_entry(event: str) -> dict:
    return {"command": f'node "{HOOK}" cursor {event}', "timeout": 10}


def install_opencode(dry: bool) -> None:
    print("OpenCode:")
    src = SRC / "opencode-herdr-app-state.js"
    if OPENCODE_DST.exists() and OPENCODE_DST.read_bytes() != src.read_bytes():
        backup(OPENCODE_DST, dry)
    print(f"  置く: {OPENCODE_DST}")
    if not dry:
        OPENCODE_DST.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, OPENCODE_DST)


def install_cursor(dry: bool) -> None:
    print("Cursor:")
    data = json.loads(CURSOR_JSON.read_text(encoding="utf-8")) if CURSOR_JSON.exists() else {"version": 1, "hooks": {}}
    hooks = data.setdefault("hooks", {})
    changed = False
    for ev in CURSOR_EVENTS:
        entries = hooks.setdefault(ev, [])
        if any(MARK in e.get("command", "") for e in entries):
            continue
        entries.append(cursor_entry(ev))
        changed = True
    if not changed:
        print("  すでに入っている")
        return
    backup(CURSOR_JSON, dry)
    print(f"  足す: {CURSOR_JSON}（{', '.join(CURSOR_EVENTS)}）")
    if not dry:
        CURSOR_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def install_copilot(dry: bool) -> None:
    print("Copilot:")
    hooks = {
        ev: [{"type": "command", "powershell": f'node "{HOOK}" copilot {ev}', "timeoutSec": 5}]
        for ev in COPILOT_EVENTS
    }
    print(f"  置く: {COPILOT_DST}")
    if not dry:
        COPILOT_DST.parent.mkdir(parents=True, exist_ok=True)
        COPILOT_DST.write_text(json.dumps({"version": 1, "hooks": hooks}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def uninstall(dry: bool) -> None:
    for p in (OPENCODE_DST, COPILOT_DST):
        if p.exists():
            print(f"外す: {p}")
            if not dry:
                p.unlink()
    if CURSOR_JSON.exists():
        data = json.loads(CURSOR_JSON.read_text(encoding="utf-8"))
        changed = False
        for ev, entries in data.get("hooks", {}).items():
            keep = [e for e in entries if MARK not in e.get("command", "")]
            if len(keep) != len(entries):
                data["hooks"][ev] = keep
                changed = True
        if changed:
            print(f"外す: {CURSOR_JSON} の自分のエントリ")
            if not dry:
                CURSOR_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", choices=["opencode", "cursor", "copilot"], action="append")
    a = ap.parse_args()
    if a.uninstall:
        uninstall(a.dry_run)
        return 0
    todo = a.only or ["opencode", "cursor", "copilot"]
    if "opencode" in todo:
        install_opencode(a.dry_run)
    if "cursor" in todo:
        install_cursor(a.dry_run)
    if "copilot" in todo:
        install_copilot(a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
