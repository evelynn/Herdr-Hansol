// hakoniwa ★103-3 (office-region103): the right column as a real layout region (agent-office.json "right"), behind a switch (right-region.json {"on": true}).
// Off (default) or any failure: the old window (chat.js syncTerm) runs. Mixed into AgentHud.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { appHome, focused, props, readTextFile, run, setShared, shared, writeTextFile } from "herdr";
import { P } from "./common.js";
import { tabFor } from "./detail.js";
import { headHeight, regionFocusFix, regionOn, regionPlan, REGION } from "./ui-rules.js";

const FILE = () => `${appHome()}/hakoniwa-office/right-region.json`;

export class RegionPart {
  // The switch, re-read every 5 s (async; never while drawing).
  regionEnabled(cx) {
    const now = Date.now();
    if (!this.regionReading && now - (this.regionReadAt ?? 0) > 5000) {
      this.regionReading = true; this.regionReadAt = now;
      cx.spawn(async (cx) => {
        let on = false; try { on = regionOn(await readTextFile(FILE())); } catch {}
        if (on !== !!this.regionFlag) { this.regionFlag = on; cx.notify(); }
        this.regionReading = false;
      });
    }
    return !!this.regionFlag && !this.regionBroken;
  }

  // Called first by syncTerm. Returns true when the region shows (or hides) the right column; false -> the old window.
  syncRegion(want, pick, left, list, cx) {
    if (!this.regionEnabled(cx)) { if (this.regionShown) this.regionStop(cx); return false; }
    const target = want ? { kind: "agent", id: want.id, address: want.address, name: want.name } : pick ? { kind: "pick", address: pick.address, name: pick.name ?? pick.address }
      : shared("hakoniwa.inboxOpen")?.on ? { kind: "inbox", name: "받은 편지함" } : null; // ★106 ②: nobody chosen + the inbox asked for (chips 承認待ち / 報告あり)
    if (want && this.detailTabFor !== want.id) { this.detailTabFor = want.id; this.detailTab = "terminal"; }
    const tab = want ? tabFor(this.detailTab, true, this.familyRows(want, list).length - 1) : "terminal";
    const plan = regionPlan({ target, tab, collapsed: !!this.rightCollapsed, viewW: left.width, rightW: this.rightW, topH: headHeight(this.rightW ?? Math.round(left.width * 0.3)) });
    if (this.resize && this.regionShown) return true; // a drag of the border: resized live (regionResize), the plan runs once when it ends
    this.termBox = null; // the floor already ends where the region starts (rightTaken() is 0)
    if (plan.key === this.regionKey) { // same plan: the body must still be the head's terminal (something else, e.g. a toast, may have moved the focus)
      const ft = (() => { try { return focused()?.terminal ?? null; } catch { return null; } })(), now = Date.now();
      const fx = target?.address && !this.rightCollapsed && plan.sel.tab === "terminal" ? regionFocusFix(ft, target.address, list) : { act: "none" };
      if (fx.act === "select") { // the focus moved to a person of the list: the head follows (never pull the body back)
        if (this.focusToPerson?.(ft, list)) cx.timer.after(0, (cx2) => { setShared("hakoniwa.sel", this.selId); cx2.notify(); });
      } else if (fx.act === "refocus" && now - (this.regionFixAt ?? 0) > 1500) { // moved to a terminal that is not in the list: back to the head's terminal
        this.regionFixAt = now; cx.spawn(async () => { try { await run("agent.focus", { terminal: target.address }); } catch {} });
      }
      return true;
    }
    this.regionKey = plan.key; this.regionShown = !!target;
    cx.spawn(async (cx) => {
      try {
        if (plan.sel) setShared("hakoniwa.rsel", { ...plan.sel, at: Date.now() });
        for (const [cmd, args] of plan.ops) await run(cmd, args);
      } catch (e) { this.regionFail(e, cx); }
      cx.notify();
    });
    return true;
  }

  regionStop(cx) { this.regionShown = false; this.regionKey = null; cx.spawn(async () => { try { await run("layout.hide", { id: REGION.id }); } catch {} }); }
  // Anything refused by the App: back to the old window at once, and the switch is written off.
  regionFail(e, cx) {
    this.regionBroken = true; this.termFail = String(e?.message ?? e); this.regionKey = null; this.regionShown = false;
    cx.spawn(async () => { try { await run("layout.hide", { id: REGION.id }); } catch {} try { await writeTextFile(FILE(), JSON.stringify({ on: false, failed: this.termFail })); } catch {} });
  }
  // The right border's drag in region mode: the region is resized live (no ghost line).
  regionResize(w) { try { run("layout.resize", { id: REGION.id, px: w }); } catch {} }

  // The props of a body block: a block of the layout has fixed props, so the person comes from the selection (rsel).
  bodyProps() { const p = props() ?? {}; if (p.role !== "rchat" && p.role !== "rtree") return p; const s = this.regionSel(); return { ...p, id: s?.id ?? null, name: s?.name ?? "", address: s?.address ?? null }; }
  // Role "rchat": the conversation reloads when the chosen person or their state changes.
  initRegionChat(cx) {
    this.initChat(cx);
    cx.timer.every(1500, (cx) => {
      const s = this.regionSel(), a = s?.id ? this.items().find((x) => x.id === s.id) : null, k = a ? `${a.id}|${a.status}|${a.since}` : null;
      if (k && k !== this.rchatKey) { this.rchatKey = k; this.loadChat(cx); }
    });
  }

  // The selection the region's blocks read (set by syncRegion).
  regionSel() { const s = shared("hakoniwa.rsel"); return s && typeof s === "object" ? s : null; }

  // Role "rhead": the head (and tabs) of the region, or the folded strip, or the thin head of a picked shell.
  regionHeadView() {
    const s = this.regionSel(), list = this.items(), a = s?.kind === "agent" ? list.find((x) => x.id === s.id) : null;
    const slide = { select: (n) => setShared("hakoniwa.pick", { state: n.status, id: n.id, at: Date.now() }), close: () => setShared("hakoniwa.close", { at: Date.now() }),
      collapse: (on) => setShared("hakoniwa.rcollapse", { on: !!on, at: Date.now() }) };
    if (!s) return v_flex().size_full().bg(P.paper).child(div().p(16).text_size(14).text_color(P.muted).child("불러오는 중…")); // ★104 U9: right after a person is chosen, until rsel is set
    if (s.collapsed) return this.collapsedStrip(a, { face: a ? this.faceFile(a) : null }, slide);
    if (s.kind === "pick") return this.pickHeadView({ name: s.name });
    if (s.kind === "inbox") return this.inboxView(); // ★106 ②
    if (!a) return v_flex().size_full().bg(P.paper).child(div().p(16).text_size(14).text_color(P.muted).child(this.items().length ? "에이전트를 찾을 수 없습니다" : "불러오는 중…"));
    const tab = tabFor(s.tab, true, this.familyRows(a, list).length - 1);
    return v_flex().id("rhead-root").size_full().overflow_hidden().bg(P.paper).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(this.detailHead(a, list, slide, { width: s.w, tab, hasTerminal: true, face: this.faceFile(a), onTab: (k) => setShared("hakoniwa.tab", { id: a.id, tab: k, at: Date.now() }) }));
  }
}
