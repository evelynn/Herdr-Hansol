// hansol: the popups' bookkeeping (one at a time, ids in shared "hansol.pops") and the window's size. Methods join AgentHud (main.js).
// 2026-11-27 the recent-moves list (最近の動き / ACTIVITY, feed.json) was removed (user): it is no longer recorded or shown.
import { appHome, closeOverlay, openOverlay, readTextFile, setShared, shared, writeTextFile } from "herdr";
// 13th B6: `window` is the ambient gpui Window. Importing `window` from "herdr" (a function: titlebar info) hid it, so viewport_size() threw and winSize() / publishWin() never worked.
const vpSize = () => { try { const v = globalThis.window?.viewport_size?.(); return v && v.width > 0 ? v : null; } catch { return null; } };

export const POP_KINDS = ["chip", "inbox", "settings"];

export class FeedPart {
  winSize() {
    let vp = vpSize();
    if (!(vp?.height > 200)) { const w = shared("hansol.win"); if (w?.h > 200) vp = { width: w.w, height: w.h }; }
    return vp?.height > 200 ? vp : null;
  }
  publishWin() {
    try {
      const vp = vpSize();
      if (!(vp?.height > 200)) return;
      const w = shared("hansol.win"), nw = Math.round(vp.width), nh = Math.round(vp.height);
      if (w?.w !== nw || w?.h !== nh) setShared("hansol.win", { w: nw, h: nh });
    } catch {}
  }
  // 10th: values for "why is it there" go to a file (console is not visible). Only when the text changed; never throws.
  // 13th B6: `savedAt` is the time of the save; a position that was asked for is named by the caller (`placedAt`), so the two no longer overwrite each other.
  diagWrite(name, obj) {
    const text = JSON.stringify(obj), key = `diag:${name}`;
    this.diagLast ??= {};
    if (this.diagLast[key] === text) return;
    this.diagLast[key] = text;
    const path = `${appHome()}/hansol-office/${name}.json`;
    readTextFile(path).catch(() => null).then((prev) => writeTextFile(path, JSON.stringify({ ...obj, savedAt: new Date().toISOString() }, null, 1), prev)).catch(() => {});
  }
  // 10th A4: the popups (最近の動き・使用量・状態チップの一覧) keep their overlay ids in shared "hansol.pops" ({ feed|usage|chip: { id, key } }) because the click opens them in the
  // footer/band copy and `hansol.close` arrives in the band's copy. Sent again = closes; never a second one; `hansol.close` closes all; a popup that goes by itself (Esc, a click outside) clears its entry (close()).
  // 18th F3: one popup at a time. The inbox window is one of them (kind "inbox": its id is kept here too, so every copy can close it); opening any of the four closes the other three.
  popClose(kind) {
    let any = false;
    if (kind === "inbox" && shared("hansol.inboxOpen")?.on) { setShared("hansol.inboxOpen", { on: false, at: Date.now() }); any = true; } // the right region's copy of the inbox
    const all = { ...(shared("hansol.pops") ?? {}) }, cur = all[kind];
    if (kind === "inbox") this.inboxWinId = null;
    if (!cur) return any;
    delete all[kind]; setShared("hansol.pops", all);
    try { closeOverlay(cur.id); } catch {}
    return true;
  }
  popCloseAll() { let any = false; for (const k of POP_KINDS) any = this.popClose(k) || any; return any; }
  popCloseOthers(kind) { for (const k of POP_KINDS) if (k !== kind) this.popClose(k); }
  popOpen(kind, key, spec) {
    this.popCloseOthers(kind);
    this.popClose(kind);
    const id = openOverlay(spec);
    setShared("hansol.pops", { ...(shared("hansol.pops") ?? {}), [kind]: { id, key } });
    return id;
  }
  popGone() { // the View's close(): this copy is a popup that has gone
    const p = props(), kind = p?.role === "feed" ? "feed" : p?.role === "state-list" ? "chip" : p?.role === "inbox" ? "inbox" : p?.role === "settings-menu" ? "settings" : null;
    if (!kind || p.overlay == null) return;
    const all = { ...(shared("hansol.pops") ?? {}) };
    if (all[kind]?.id === p.overlay) { delete all[kind]; setShared("hansol.pops", all); }
  }
  // 9th Z8/Z4: the left edge of the right window (where the popups must not reach). termBox lives in the office copy only; "hansol.termBox" is its shared copy
  // (written by the office copy, if it does), else the default width of the right window (about 42% of the window, 0.58 from the left: measured 1110 of 1920).
  rightLeft() {
    const b = this.termBox ?? shared("hansol.termBox");
    if (b?.x > 0) return Math.round(b.x) - Math.max(0, Math.round(b.frame ?? 0)); // 12th C3: a window's box holds the x asked for + `frame` (RIGHT_WIN_FRAME); the region's / measured box has frame 0
    const vp = this.winSize();
    return vp?.width > 600 ? Math.round(vp.width * 0.58) : null;
  }
}
