// hakoniwa Office (role "office"): one floor image behind, a picture per person in front,
// the conversation on the right. Mixed into AgentHud.
//
// How the motion works (no per-frame redraw, brief 2-2):
//  - each person is ONE absolutely placed element (bubble above, sprite below) with
//    .transition("left"/"top"); changing the target `left/top` makes GPUI slide it natively;
//  - while it slides the sprite is the "walk" picture; cx.timer.after(duration) swaps in the
//    arrival pose (sit / stand / hold / doze);
//  - typing sway, cursor blink and scrolling code are .loop() (native).
import { div, svg, image } from "gpui-kit";
import { readFile } from "fs/promises";
import { h_flex, v_flex } from "gpui-base";
import { splitHandle } from "./ui.js";
import { icon } from "./icons.js";
import { nearbyTag } from "./tag-placement.js";
import { openTerminalWindow } from "./terminal-window.js";
import { panelFit, sideFit as sideFitBase } from "./panel.js";
import { appHome, exec, focused, hc, readTextFile, run, setShared, shared, spaces, panes, writeTextFile } from "herdr";
import { freeSweepPlan, sweepKey, goneError, moveByLabelPlan, plateKeyFor, roomsToRelease, roomRenames, runMovePlan, teamSpaceState, watchNewRooms } from "./actions.js";
import { clipName, NAME_EM, NAME_EM_FULL } from "./ui-rules.js";
import { commanderInfo, tripShowsPapers, clearTransient, isSeatSpot, errandAllowed, tierFor, hash, moonPhase, wantsBreak, breakAllowed, breakSeconds, deskStage, seatedDepth, starsShown, moonShown, doorTimeline, doorStateOf, stuckAction, stuckCheck, liveKinds, replyWaiting, flockBirds, wingFrame, BIRD_SCALE, LEGEND_MARKS, LEGEND_PC_RULES, LEGEND_STRIP, fillPlates, l86WaitPose } from "./life.js";
import { boardDots, boardElements, fixedBoard, WEATHER_KINDS } from "./board.js";
import { STATE, P, dot, chip, platform, platformIcon, stateOf, answeredView, blockedText, snapBox, fitZoom as fitZoomBase, bleedBox, planWaitText, RIGHT_EDGE, activityLabel } from "./common.js";

export const TALK_DOTS = [0, 1, 2], TALK_DOT_MS = 330; // ★70-3 the talk bubble's three dots: dot n is lit in frame n (1 -> 2 -> 3, then again)
export const talkDotFrames = (n) => TALK_DOTS.map((i) => (i === n ? "●" : "∙"));
const WALK_FRAME_MS = 125;
// ★92 where the middle of the two feet (the base of a chair) is in each picture, as a share of the picture's width (measured on the real pictures; the ring is centred there)
const FEET_CX = { stand: 0.538, hold: 0.538, front_wait: 0.533, front_give: 0.505, front_raise: 0.599, wave_f: 0.59, wave_b: 0.429, hold_b: 0.491, type_pc: 0.453, type_pc2: 0.453, read_pc: 0.467, raise: 0.415, sofa: 0.481, doze: 0.392 };
const WARM_RENDERS = 4; // ★89 how many draws a walking picture is put in the tree as a 1 px warm-up
const FLOOR_LEGEND = false; // ★89 the floor legend (under lgShell) is not drawn since ★84: do not build it each frame
const MACHINE_TAKE_S = 1.5; // ★71-3: seconds in front of a copier / coffee / water / vending machine: only to take the paper or the cup // one walking frame (the redraw timer runs at the same step)
const jit = (id, salt, lo, hi) => lo + ((hash(id + salt) % 1000) / 1000) * (hi - lo); // stable per id
const TEAM = ["#f0a6a0", "#9cc4ec", "#ecd08a", "#8fd3c1", "#c6aee8", "#eeb3cc"]; // light, one per team (not the state colours)
const WALK_UNITS_PER_S = 46; // floor units (SVG px) per second, scaled per person
// ★56-2 (office-perf) the approval card's places to try, made once: the bottom centre dy px above the tail's end (0..60), sideways by dx, tail <= 60 px.
// byLen: nearest first (a stable sort keeps the old order among equal lengths, so the first free one is the place the old full search chose).
const CARD_OFFS = (() => { const a = []; for (let dy = 0; dy <= 60; dy += 6) for (let dx = -140; dx <= 140; dx += 10) { const len = Math.hypot(dx, dy); if (len <= 60) a.push([dx, dy, len]); } return { scan: a, byLen: a.map((q, i) => [q, i]).sort((m, n) => m[0][2] - n[0][2] || m[1] - n[1]).map((q) => q[0]) }; })();
const cardOffsets = (byLen) => (byLen ? CARD_OFFS.byLen : CARD_OFFS.scan);

// ★56-2 (office-perf2) the furniture to draw, in the scene's order: a band (python's picture of the things of one depth that touch) stands where
// its first thing stood. A band is used only when it has the same depth as its things and they are all here (else they stay one by one).
export function objectDrawList(objList, bands) {
  const byId = new Map(objList.map((e) => [String(e[0].id), e])), bandOf = new Map(), out = [];
  for (const [n, b] of (bands ?? []).entries()) {
    const members = (b?.ids ?? []).map((id) => byId.get(String(id)));
    if (!b?.file || !b.rect || !members.length || members.some((e) => !e || e[3] !== b.depth)) continue;
    const d = { band: b, eid: `band-${n}-${String(b.file).replace(/^.*[\\/]/, "").replace(/\.png$/, "")}`, members, done: false };
    for (const e of members) bandOf.set(e, d);
  }
  for (const e of objList) { const d = bandOf.get(e); if (!d) out.push({ one: e }); else if (!d.done) { d.done = true; out.push(d); } }
  for (const d of out) delete d.done;
  return out;
}

// ★90 (B): what the floor plan depends on. A status change (idle <-> busy) does not move a desk (L86: everyone keeps their own seat), but it
// used to change `agentsJson` and re-plan the whole floor, which read every person's pictures again. Only who is here and where they belong.
export function planKey(list, l86 = true) {
  // With the old two-column floor (HERDR_L86=0) the idle count sizes the desks, so a status change must re-plan there. L86 (the default) keeps
  // everyone's own seat and needs no status in the key.
  return JSON.stringify(list.map((a) => ({ id: a.id, source: a.source, color: a.color ?? "#9aa3af", parent_id: a.parent_id ?? null, app: a.app ?? null, island: a.island ?? null, island_title: a.island_title ?? null, name: a.source === "tui" ? (a.name ?? null) : null, ...(l86 === false ? { status: a.status === "idle" ? "idle" : "busy" } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)));
}

// ★88-6 (office-walk89): who may start a floor plan now. One plan at a time in the whole App (shared "hakoniwa.planflight" = { owner, at, demo }):
// a part that finds a fresh flight of somebody else waits (the next draw asks again). A flight older than PLAN_FLIGHT_MS is a part that died.
export const PLAN_FLIGHT_MS = 35000;
export const planFlightBlocks = (fl, me, demo, now = Date.now()) => !!fl && fl.owner !== me && !!fl.demo === !!demo && now - Number(fl.at ?? 0) < PLAN_FLIGHT_MS;
// The parts of this mod that are alive (shared "hakoniwa.parts" = { id: { at, born } }): more than one office part means a hot reload left an old one running.
export const PART_ALIVE_MS = 60000;
export const livePartsOf = (reg, now = Date.now()) => Object.entries(reg ?? {}).filter(([, v]) => v && now - Number(v.at ?? 0) < PART_ALIVE_MS).map(([id, v]) => ({ id, born: Number(v.born ?? 0) })).sort((a, b) => a.born - b.born);
// The newest part stays; an older one that has not drawn for a while retires (its timers are cancelled; no plan, no live-check).
export const shouldRetire = (parts, me, lastRenderAt, now = Date.now()) => parts.length > 1 && parts.some((q) => q.id === me) && parts[parts.length - 1].id !== me && now - Number(lastRenderAt ?? 0) > 10000;

// ★102-7 a person the current plan has no seat for (a newcomer until the next plan, or a plan that stalled): they wait standing outside the way, never with a raised hand / papers / sofa.
export const hasNoSeat = (sc, id) => !sc?.desks?.[id]?.seat;
export const seatlessWaiting = (sc, id, at) => String(at).startsWith("wait:") || (String(at) === "desk" && hasNoSeat(sc, id));
export const SEATLESS_RETRY_MS = 8000, SEATLESS_MAX_TRIES = 4, SEATLESS_NOTE_MS = 10000;
// Plan again while somebody has no seat although the cast is unchanged (pace: one try per SEATLESS_RETRY_MS, at most SEATLESS_MAX_TRIES for one cast; a cast change resets the count).
export const seatlessRetry = (list, sc, tries, lastAt, now = Date.now()) => list.length > 0 && list.some((a) => hasNoSeat(sc, a.id)) && tries < SEATLESS_MAX_TRIES && now - (lastAt ?? 0) >= SEATLESS_RETRY_MS;

export const RESTART_AT_MB = 1200; // ★90 (H): the App's private bytes where a restart is suggested (it crashed near 1.5GB)
export const appNeedsRestart = (mb) => Number(mb) >= RESTART_AT_MB;

// ★95: the builder script's version for the plan key (a hash written by the installer)
export const builderVersion = (txt) => String(txt ?? "").trim();

const ZOOM_GAP = 36; // 4th W6 (see zoomControls)
const FLOOR_RIGHT_GAP = 32; // 9th Z5 (see fitMargin): px kept between the floor's right corner / plates and the attached right window
// 10th A1: with the left list AND the right window open the free width is ~611px and the shared fitZoom's 0.4 floor stopped the floor at 624px (13px into the window). Same rule for all four cases: no 0.4 floor (0.2), and FLOOR_SIDE_PAD (16px each side) kept clear of the list / window edges.
const FLOOR_SIDE_PAD = 32;
// 12th C5: with the left list closed and only the right window open, the floor's left outer edge sat at x 42 (6px from the 端末 tab, x 0-36). Keep CLOSED_LEFT_PAD (24) clear of the left edge in that case: outer left = pad + ~42 = 66 (>= 56, 20px from the tab). Both closed / list open: unchanged (sideFitBase).
const CLOSED_LEFT_PAD = 24;
const sideFit = (sc, W, H, fz, lw = 0, rt = 0) => {
  if (!lw && rt > 0) { const f = panelFit(sc, W, H, fz, CLOSED_LEFT_PAD + rt); return { z: f.z, px: (CLOSED_LEFT_PAD - rt) / 2, py: 0 }; }
  return sideFitBase(sc, W, H, fz, lw, rt);
};
const fitZoom = (sc, W, H) => (!sc?.native || !(sc.width > 0) || !(sc.height > 0)) ? fitZoomBase(sc, W, H) : Math.max(0.2, Math.min(1, (W - 16 - FLOOR_SIDE_PAD) / sc.width, (H - 40) / sc.height));
export class OfficePart {
  // ---------------------------------------------------------------- scene (floor + positions)
  ensureScene(list, cx) {
    const c = this.feed.config, lf = this.left;
    this.t ??= { init: Date.now() };
    if (!lf) return; // wait for the real size: one office.py call, not two
    if (this.feed.state) this.t.state ??= Date.now();
    const view = `${Math.round(lf.width)}x${Math.round(Math.max(1, lf.height))}`;
    // Only who is here (id / source / parent) matters; ★90 (B): a status change never re-plans the floor.
    const agentsJson = planKey(list, this.scene?.l86 !== false); // ★90 (B): status matters only on the old floor (HERDR_L86=0)
    const demo = this.demo ? this.demo() : false; // made-up agents: their desks are kept apart from real ones
    // A floor drawn at the exact size (native) is redrawn when the size changes; otherwise only the shape matters.
    const shape = this.scene?.native ? `${Math.round(lf.width / 24)}x${Math.round(lf.height / 24)}` : (lf.width / Math.max(1, lf.height)).toFixed(1);
    let spaceList = []; try { spaceList = demo ? [] : spaces(); } catch {}
    const empties = []; // ★85-1 no empty rooms: a room lives with its people (roomLife closes a space whose last agent is gone)
    // ★95 the builder's version (a hash the installer writes to builder-version.txt) is part of the plan key: an install that changed only the builder plans the floor once again; the same version never re-plans on a state change
    if (Date.now() - (this.verCheckAt ?? 0) > 15000) { this.verCheckAt = Date.now(); cx.spawn(async (cx2) => { try { const v = builderVersion(await readTextFile(`${appHome()}/hakoniwa-office/builder-version.txt`)); if (v !== this.builderVer) { const first = this.builderVer == null; this.builderVer = v; if (!first) cx2.notify(); } } catch {} }); }
    const sig = `${demo ? "demo|" : ""}${shape}|${this.builderVer ?? ""}|${agentsJson}`;
    if (!(this.officeScript(c) && this.feed.state)) return;
    // The plan must hold everyone in the list. If it does not (another cast came in), plan again even when the signature
    // looks the same, at most every 5 s.
    const covered = list.every((a) => this.hasPersonFiles(this.scene?.people?.[a.id]));
    if (sig !== this.sceneSig) { this.tries = 0; this.seatTries = 0; }
    if (this.planBusyUntil && Date.now() < this.planBusyUntil) return; // one plan at a time: two runs share the picture files and break each other (a big cast takes ~100 s)
    const seatRetry = sig === this.sceneSig && seatlessRetry(list, this.scene, this.seatTries ?? 0, this.t.seatPlanAt); // ★102-7 somebody has no seat: plan again soon (an exception to "a status change never re-plans"), but paced
    if (sig === this.sceneSig && !seatRetry && (covered || Date.now() - (this.t.call2 ?? 0) < 1500 || this.tries >= 6)) return;
    if (seatRetry) { this.seatTries = (this.seatTries ?? 0) + 1; this.t.seatPlanAt = Date.now(); }
    else if (sig === this.sceneSig) this.tries++; // a few more plans for one cast, 1.5 s apart
    this.partId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; this.partBorn ??= Date.now();
    if (this.retired) return; // ★88-6 an older part left by a hot reload does not plan
    if (planFlightBlocks(shared("hakoniwa.planflight"), this.partId, demo)) return; // ★88-6 another part of the App is planning now: not two at once (asked again at the next draw)
    this.t.call2 = Date.now();
    cx.timer.after(0, () => setShared("hakoniwa.planflight", { owner: this.partId, at: Date.now(), demo: !!demo })); // (setShared re-renders everybody: never inside a draw)
    // A call that never returns must not block later ones: every call has a number and only the newest result is used.
    const n = (this.sceneSeq = (this.sceneSeq ?? 0) + 1);
    this.planBusyUntil = Date.now() + 240000;
    this.sceneSig = sig; // also on failure, so a broken scene is not retried on every redraw
    this.t.call ??= Date.now();
    const t0 = Date.now();
    cx.spawn(async (cx) => {
      let scene = null, error = null, raw = null;
      try {
        const script = this.officeScript(c), cfg0 = this.officeSettings(c), cfg = empties.length ? { ...(cfg0 ?? {}), empty_rooms: empties } : cfg0;
        const base = [script, "--agents", agentsJson, "--box", view, ...(demo ? ["--demo"] : [])];
        let r = await exec(c.python, cfg ? [...base, "--config", JSON.stringify(cfg)] : base);
        if (cfg && r.code && /unrecognized arguments/.test(r.stderr || "")) r = await exec(c.python, base); // older office.py
        if (r.code) error = (r.stderr || "").trim().split("\n").pop() || `exit ${r.code}`;
        else { raw = this.lastJson(r.stdout); scene = this.norm(JSON.parse(raw)); }
      } catch (e) { error = String(e); }
      if (scene) await this.preparePeople(scene);
      this.planBusyUntil = 0;
      try { if (shared("hakoniwa.planflight")?.owner === this.partId) setShared("hakoniwa.planflight", null); } catch {} // ★88-6 the flight is over
      this.planLog(demo, n, scene, error, Date.now() - t0, list.length);
      if (demo !== !!(this.demo?.())) { this.sceneSig = null; cx.notify(); return; } // the cast was switched meanwhile: this floor belongs to the other one
      if (n !== this.sceneSeq) { cx.notify(); return; } // a newer request replaced this one
      if (scene) { const wk = (scene.grid?.walk ?? []).join(""); if (this.walkSig != null && wk !== this.walkSig) this.layoutChangedAt = Date.now(); this.walkSig = wk; /* ★88-1: rooms added / removed: whoever stood where a wall is now is set down at the nearest way (not counted as a rescue) */ this.scene = scene; globalThis.__hudScene = { scene, demo: !!this.demo?.() }; /* ★95-13 a part made again by an install's reload takes this at once (no blank) */ this.sceneError = null; this.sceneFails = 0; this.waitSince = null; this.t.done ??= Date.now(); this.remember(raw); }
      else {
        this.sceneError = error; this.sceneFails = (this.sceneFails ?? 0) + 1; // ★61: the first failures are shown as "being prepared" (planWaitText)
        cx.timer.after(10000, (cx) => { if (n === this.sceneSeq) { this.sceneSig = null; cx.notify(); } }); // try again
      }
      cx.notify();
    });
  }

  // The last plan calls (for finding out why a floor looks old): kind, ms, people asked / drawn, error, and what was done with the result.
  planLog(demo, n, scene, error, ms, asked) {
    const e = { at: new Date().toISOString().slice(11, 19), demo: !!demo, part: this.partId ?? null, n, seq: this.sceneSeq, ms, asked, drawn: scene ? Object.keys(scene.people ?? {}).length : null, plates: scene ? (scene.islands ?? []).filter((q) => q.plate).length : null, error: error ? String(error).slice(0, 200) : null, replaced: n !== this.sceneSeq, switched: demo !== !!(this.demo?.()) };
    (this.planLogs ??= []).push(e); this.planLogs = this.planLogs.slice(-12);
    (async () => { const path = `${appHome()}/hakoniwa-office/plan-log.json`; let prev = null; try { prev = await readTextFile(path); } catch {} try { await writeTextFile(path, JSON.stringify(this.planLogs, null, 1), prev); } catch {} })();
  }

  // office.py may print warnings before the JSON: read from the last line that starts with "{".
  lastJson(out) {
    const text = String(out ?? "").trim();
    if (text.startsWith("{")) { try { JSON.parse(text); return text; } catch {} }
    const i = text.lastIndexOf("\n{");
    return i >= 0 ? text.slice(i + 1) : text;
  }

  // The last floor is kept on disk: the next start draws it at once, and the new one replaces it when it arrives.
  async remember(raw) {
    const dir = `${appHome()}/hakoniwa-office`;
    const put = async (name, text) => { // read first (null when absent), then write; either failing must not stop the other
      const path = `${dir}/${name}`;
      let prev = null;
      try { prev = await readTextFile(path); } catch {}
      try { await writeTextFile(path, text, prev); } catch (e) { this.t.err = String(e); }
    };
    await put(this.demo?.() ? "last-scene-demo.json" : "last-scene.json", raw);
    if (this.t?.done && !this.t.saved) { // the time each step of the first draw took (for tuning)
      this.t.saved = true;
      await put("timing.json", JSON.stringify(this.t));
    }
  }

  loadRemembered(cx) {
    if (this.rememberedTried) return;
    this.rememberedTried = true;
    const cast = !!this.demo?.();
    { const g = globalThis.__hudScene; if (!this.scene && g?.scene && g.demo === cast) { this.scene = g.scene; this.sceneSig = null; this.t ??= { init: Date.now() }; this.t.cached = Date.now(); } } // ★95-13: the last floor stays drawn while the new part plans (no wait for the file) // ★61: read on a cast switch too; dropped if the cast changed while it was being read
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/hakoniwa-office/${cast ? "last-scene-demo.json" : "last-scene.json"}`);
        if (text && !this.scene && cast === !!this.demo?.()) { const scene = this.norm(JSON.parse(text)); await this.preparePeople(scene); if (this.scene || cast !== !!this.demo?.()) return; this.scene = scene; this.sceneSig = null; this.t ??= { init: Date.now() }; this.t.cached = Date.now(); cx.notify(); }
      } catch {}
    });
  }

  // Demo only: where each walker goes and when (floor coordinates), for the review pictures (hakoniwa-office/trace.json).
  trace(id, from, to, ms, key) {
    this.traceData ??= {};
    this.traceData[id] = { from, to, ms, key, t: Date.now(), view: this.viewBox };
    const path = `${appHome()}/hakoniwa-office/trace.json`, text = JSON.stringify(this.traceData);
    readTextFile(path).then((prev) => writeTextFile(path, text, prev)).catch(() => {});
  }

  // ★85-1/2 (every 3 s, from the draw, no state change): close a space whose last agent is gone, name a new room after its first agent.
  roomLife(list, cx) {
    const now = Date.now(); if (this.demo?.() || now - (this._roomLifeAt ?? 0) < 3000) return; this._roomLifeAt = now;
    if (this.feed?.config?.office?.auto_rooms === false) return; // ★108 office.auto_rooms false: no space is closed, renamed or joined by the office itself
    let sl = [], pl = []; try { sl = spaces(); pl = panes(); } catch { return; }
    this._roomSeen ??= new Map(); this._roomAuto ??= new Map();
    const nr = shared("hakoniwa.newroom");
    if (nr?.at && nr.at !== this._newRoomAt) { this._newRoomAt = nr.at; this._newRoomBefore = { at: nr.at, ids: new Set(nr.before ?? []) }; }
    const w = this._newRoomBefore;
    if (w) { for (const s of sl) if (!w.ids.has(s.id) && !this._roomAuto.has(s.id) && now - w.at < 60000) this._roomAuto.set(s.id, { at: w.at }); if (now - w.at >= 60000) this._newRoomBefore = null; }
    this._roomKnown ??= new Set(); watchNewRooms(this._roomKnown, sl, this._roomAuto, now); // ★85 (2) rooms made by a command too
    for (const id of roomsToRelease(this._roomSeen, sl, list, pl, now)) cx.spawn(async () => { try { await run("space.close", { id, confirmed: true }); } catch {} });
    for (const r of roomRenames(this._roomAuto, sl, list, now)) cx.spawn(async () => { try { await run("space.rename", r); } catch {} });
    try { this.teamLife(list, sl, cx); } catch (e) { this.dbgErr(e, "teamLife"); }
    try { this.freeLife(list, sl, cx); } catch (e) { this.dbgErr(e, "freeLife"); }
  }

  // ★103-5 everybody in no space goes into the real space フリー (labels only, the shown space never changes; only making フリー the first
  // time selects the shown space back). Each terminal once (a failure is logged, not retried); a missing space is made once per 30 s.
  // Terminals ★97's auto rule is moving this tick are left to it.
  freeLife(list, sl, cx) {
    this._freeTried ??= new Map();
    const skip = new Set(this._teamTried?.keys() ?? []);
    for (const a of list ?? []) if (a?.address && teamSpaceState(a, list, sl)?.state === "auto") skip.add(a.address);
    const now = Date.now();
    this._freeBorn ??= new Map(); // address -> first seen (terminals already there at the first tick count as old); a new one waits SWEEP_GRACE_MS
    const first = this._freeBorn.size === 0 && !this._freeBornInit; this._freeBornInit = true;
    for (const a of list ?? []) if (a?.address && !this._freeBorn.has(a.address)) this._freeBorn.set(a.address, first ? 0 : now);
    const fresh = (list ?? []).filter((a) => a?.address && !this._freeTried.has(sweepKey(a)));
    const sw = freeSweepPlan(fresh, sl, skip, { now, born: this._freeBorn });
    if (sw.state === "none") { const ids = new Set((list ?? []).map((x) => x?.address)); for (const k of [...this._freeTried.keys()]) if (!ids.has(k.replace(/@back$/, ""))) this._freeTried.delete(k); for (const k of [...this._freeBorn.keys()]) if (!ids.has(k)) this._freeBorn.delete(k); return; }
    if (sw.state === "make") { if (now - (this._freeMadeAt ?? 0) < 30000) return; this._freeMadeAt = now; }
    else for (const a of sw.targets) this._freeTried.set(sweepKey(a), now);
    cx.spawn(async (cx) => { try { const r = await runMovePlan(run, hc, sw); if (!r.ok && !goneError(r.error)) this.dbgErr(r.error ?? "free sweep failed", "freeLife"); } catch (e) { this.dbgErr(e, "freeLife"); } cx.notify(); }); // ★103-5c a terminal gone before the label (not_found) is skipped, not left in error.txt
  }

  // ★97 a leader that is free while its workers are all in one space moves into that space by itself (labels; the shown space never changes).
  // Once per team; a failed one only wears the mark in the left list (no retry by itself). At most one team per tick (never park two at once).
  teamLife(list, sl, cx) {
    this._teamTried ??= new Map(); this._teamFailed ??= new Set();
    let fired = false;
    for (const a of list ?? []) {
      const st = teamSpaceState(a, list, sl);
      if (st?.state !== "auto") { if (a?.address) this._teamFailed.delete(a.address); continue; }
      if (this._teamTried.has(a.address)) continue;
      if (!fired) {
        fired = true; this._teamTried.set(a.address, Date.now());
        const plan = moveByLabelPlan(a, st.target.id, sl);
        if (!plan.ok) { this._teamFailed.add(a.address); continue; }
        cx.spawn(async (cx) => { try { const r = await runMovePlan(run, hc, plan); if (!r.ok) this._teamFailed.add(a.address); else this._teamFailed.delete(a.address); } catch { this._teamFailed.add(a.address); } cx.notify(); });
      }
    }
    const ids = new Set((list ?? []).filter((x) => x?.source === "app").map((x) => x.address));
    for (const k of [...this._teamTried.keys()]) if (!ids.has(k)) this._teamTried.delete(k);
    for (const k of [...this._teamFailed]) if (!ids.has(k)) this._teamFailed.delete(k);
  }

  dbgErr(e, where) { // TEMP-DBG
    const p = `${appHome()}/hakoniwa-office/error.txt`;
    readTextFile(p).then((prev) => writeTextFile(p, `${String(prev ?? "").slice(-3000)}
${new Date().toISOString()} ${where}${where === "board" ? ` [last step: ${this._bp ?? "?"}]` : ""}: ${e?.stack ?? (e === null ? "null thrown" : typeof e === "object" ? JSON.stringify(e) : String(e))}`.slice(-3500), prev)).catch(() => {});
  }

  // The frame of a walk by the person's own clock (not one shared counter): the walk starts on frame 0, one frame per WALK_FRAME_MS.
  walkFrameIndex(p, n) { p.walkT0 ??= Date.now(); return (Math.floor((Date.now() - p.walkT0) / WALK_FRAME_MS) + n - 1) % n; } // starts on the last picture (#8: a foot on the ground), then #1 ... : the order [8,1,2,...,7]

  walkFrames() { return this.feed.config?.office?.walk_frames !== false; }

  // ★31-1: on the move = the sprite's position transition is running (a walk leg, a door segment, or any direct move).
  // The picture must be a walk frame while this is true, whichever path moved the person.
  moving(p) { return !!(p.walking || (p.moveUntil && Date.now() < p.moveUntil + (p.moveGrace ?? 0))); } // ★89 moveGrace: after a state change in the middle of a walk the walking picture bridges the tick before the new walk starts (a one-frame standing picture between two walking ones) // ★64 (office-live): leaving alone is not walking (waving at the entrance showed the walk picture on the spot)

  // The position transition lasts exactly the leg's time (0 = a jump: a new floor, a rescue, an appearance).
  transMs(p) { if (p.restartFor && p.restartFor === p.pos && Date.now() < (p.moveUntil ?? 0)) return p.restartDur; return this.camMoving && !(Date.now() < (p.moveUntil ?? 0)) ? 0 : Math.max(0, p.dur ?? 0); } // ★35: when only the camera moved, a standing person's picture jumps with it (no slide from the last walk's duration)

  // config.json: "office" is the script path (older) or the settings object (task2-2d), with the path then under another key.
  officeScript(c) { return typeof c?.office === "string" ? c.office : (c?.office_script ?? c?.office_py ?? null); }
  officeSettings(c) { return c?.office && typeof c.office === "object" ? c.office : (c?.office_settings ?? null); }

  // ---------------------------------------------------------------- people (who is where)
  // Where a state sends someone: "desk", "approval:i", "counter:i", "lounge:i" (i = place in the queue).
  placeKeys(list) {
    const keys = new Map(), sc = this.scene;
    if (sc?.l86) { for (const a of list) keys.set(a.id, "desk"); return keys; } // ★86: nobody walks to a window or a lounge: everyone stays at the own desk (poseFiles stands them up in place)
    const by = (st, cmp) => list.filter((a) => a.status === st).sort(cmp);
    const since = (a, b) => (a.since - b.since) || (a.id < b.id ? -1 : 1); // oldest first
    const id = (a, b) => (a.id < b.id ? -1 : 1);
    // Places are handed out in order; one is skipped when the person's picture (the chair comes with it) would cover
    // someone placed before. The gap comes from the picture's size, so a new floor plan needs no change here.
    const spread = (kind, people) => {
      const [W, H] = this.poseBox(kind), cands = this.candidates(kind), used = [];
      const clear = (p, u) => Math.abs(cands[u][0] - p[0]) >= W + 6 || Math.abs(cands[u][1] - p[1]) >= H * 0.72 + 6;
      const gridded = this.gridOn(sc);
      const order = cands.map((_, i) => i).sort((i, j) => (this.standsAtIndex(kind, i) ? 1 : 0) - (this.standsAtIndex(kind, j) ? 1 : 0) || i - j); // seats first, then standing points
      people.forEach((a, n) => {
        const queue = gridded && (kind === "approval" || kind === "counter") && (sc.spots?.[kind] ?? [])[0]?.facing; // a window queue: one straight line, in order
        let pick = queue ? (n < cands.length ? n : undefined)
          : order.find((i) => !used.includes(i) && ((kind === "lounge" && isSeatSpot((sc.spots?.lounge ?? [])[i])) || used.every((u) => u >= cands.length || clear(cands[i], u)))); // also on a grid: pictures must not overlap (a lounge seat is never skipped for that: a waiting person sits)
        if (pick === undefined) pick = -1;
        if (pick < 0) pick = cands.length + used.filter((u) => u >= cands.length).length; // nowhere left: a free tile nearby, standing (see gridTarget / where())
        used.push(pick);
        keys.set(a.id, `${kind}:${pick}`);
      });
    };
    const rw = (a) => replyWaiting(this.reps?.get(a.id), a, !!sc?.desks?.[a.id]?.seat); // ★29-1: handed the report over, back at the seat: not in the counter queue
    const blockedQ = by("blocked", since), doneAll = by("done", since), doneQ = doneAll.filter((a) => !rw(a));
    this.queueHead = { approval: blockedQ[0]?.id, counter: doneQ[0]?.id }; // the one at the window
    spread("approval", blockedQ);
    spread("counter", doneQ);
    const byId = new Map(list.map((a) => [a.id, a]));
    const beside = (a) => false && a.status === "idle" && a.handed_back && a.parent_id && byId.get(a.parent_id)?.status === "working" && sc?.desks?.[a.parent_id]?.seat;
    spread("lounge", by("idle", id).filter((a) => !beside(a)));
    for (const a of list) if (beside(a)) keys.set(a.id, `beside@${a.parent_id}`); // next to the parent's desk
    for (const a of list) if (a.status === "working" || (a.status === "done" && rw(a))) keys.set(a.id, "desk");
    return keys;
  }

  // Is the rectangle (scene px) inside the little world (the floor and the outer walls above its two back edges)? Cached per scene.
  inBox(sc, x, y, w, h) {
    if (!sc.grid) return true;
    if (this.boxFor !== sc.scene_id) {
      // ★56-2 (office-perf) the same rows as before, built with plain loops (no arrays or closures per tile): the first render of a new plan was 15 ms here in the App's engine
      this.boxFor = sc.scene_id; const g = sc.grid, step = 8, WALL = 190, hw = g.tw / 2, ht = g.th / 2, o0 = g.origin[0], o1 = g.origin[1];
      const R0 = Math.floor((o1 - ht - WALL) / step) - 2, lo = [], hi = []; // rows by index (r - R0): no Map lookups while building
      const put = (yy, x0, x1) => { const i = Math.floor(yy / step) - R0; if (lo[i] === undefined) { lo[i] = x0; hi[i] = x1; } else { if (x0 < lo[i]) lo[i] = x0; if (x1 > hi[i]) hi[i] = x1; } };
      for (let gy = 0; gy < g.rows; gy++) { const line = g.floor[gy]; if (!line) continue; for (let gx = 0; gx < g.cols; gx++) {
        if (line[gx] !== "1") continue; const qx = o0 + (gx - gy) * hw, qy = o1 + (gx + gy) * ht, x0 = qx - hw, x1 = qx + hw;
        put(qy - ht, x0, x1); put(qy, x0, x1); put(qy + ht, x0, x1); // the three points of the tile
        if (gx === 0 || gy === 0) for (let u = step; u <= WALL; u += step) put(qy - ht - u, x0, x1); // the wall above a back edge
      } }
      const rows = new Map(); for (let i = 0; i < lo.length; i++) if (lo[i] !== undefined) rows.set(i + R0, [lo[i], hi[i]]);
      this.boxRows = rows;
    }
    const rows = this.boxRows, a = rows.get(Math.floor(y / 8)), b = rows.get(Math.floor((y + h) / 8)); // the four corners (no arrays per call: the approval card tries ~600 places a draw)
    return !!a && !!b && x >= a[0] && x <= a[1] && x + w >= a[0] && x + w <= a[1] && x >= b[0] && x <= b[1] && x + w >= b[0] && x + w <= b[1];
  }

  // Free address: a new person takes the first seat of their island that nobody owns (the same rule office.py uses, so a
  // plan that arrives later agrees). The seat is written into sc.desks[id] so the walking code needs no change.
  claimSeats(list) {
    const sc = this.scene;
    if (!sc?.seats) return;
    this.claims ??= new Map();
    sc.desks ??= {};
    const ids = new Set(list.map((a) => a.id));
    for (const id of [...this.claims.keys()]) if (!ids.has(id) && !this.people?.has(id)) this.claims.delete(id);
    const taken = new Set();
    for (const [sid, s_] of Object.entries(sc.seats)) if (s_.owner) taken.add(sid);
    for (const d of Object.values(sc.desks)) if (d.seat_id && !d.claimed) taken.add(d.seat_id);
    for (const a of [...list].sort((m, n) => ((m.since ?? 0) - (n.since ?? 0)) || (m.id < n.id ? -1 : 1))) {
      const own = sc.desks[a.id];
      if (own && !own.claimed) { this.claims.delete(a.id); continue; } // the plan has given them a seat
      let sid = this.claims.get(a.id);
      if (sid && (!sc.seats[sid] || (sc.seats[sid].owner && sc.seats[sid].owner !== a.id))) sid = null;
      if (sid && [...this.claims].some(([o, x]) => o !== a.id && x === sid && ids.has(o) && taken.has(sid))) sid = null;
      if (!sid) {
        const isl = (sc.islands ?? []).find((i) => i.key === (a.island ?? `${a.source}:`));
        sid = (isl?.seats ?? []).find((x) => sc.seats[x] && !taken.has(x) && ![...this.claims.values()].includes(x));
      }
      if (!sid && (a.status === "working" || a.status === "blocked")) { // ★33: nobody sits in the plan's own island seats -> any seat nobody holds (an old plan that has no seat for them must not keep them from the PC)
        const own = a.island ?? `${a.source}:`; // ★38-4 only the person's own space: its islands are <key> and <key>~N (a person whose room is not in the scene waits in the lobby until a plan has it)
        const mine = (sc.islands ?? []).filter((i) => i.key === own || String(i.key).startsWith(`${own}~`));
        sid = mine.flatMap((i) => i.seats ?? []).find((x) => sc.seats[x] && !taken.has(x) && ![...this.claims.values()].includes(x));
      }
      if (!sid) { this.claims.delete(a.id); continue; }
      this.claims.set(a.id, sid); taken.add(sid);
      const seat = sc.seats[sid];
      sc.desks[a.id] = { seat_id: sid, seat_tile: seat.tile, seat: seat.xy, seat_depth: seat.depth, claimed: true };
    }
  }

  // One floor with small rooms. Used when present (older output lacks them): desks[id].screen_on,
  // spots.entrance, spots.rooms {room key: [x, y]}, door {spot, rect, closed, open}, foreground [{file, rect}].
  norm(sc) {
    const door = sc.door?.spot ? sc.door : { ...(sc.door ?? {}), spot: sc.spots?.door };
    return fillPlates({ ...sc, door, ...(sc.board ? { board: fixedBoard(sc.board) } : {}) }); // ★94 the sign's grid is always the same (see board.js fixedBoard) // #10: every room gets the same white plate (a plate-less room: one in the aisle at its door)
  }

  // A place that is a standing point, not a seat: spots with seat === null (only when the plan has any real seat), or beyond the list.
  standsAtIndex(kind, n) {
    const arr = this.scene?.spots?.[kind];
    if (!Array.isArray(arr)) return false;
    if (n >= arr.length) return true;
    const hasSeat = arr.some((s) => s && !Array.isArray(s) && s.seat);
    return hasSeat && !(arr[n] && arr[n].seat);
  }
  standsAt(at) {
    const m = /^(lounge):(\d+)$/.exec(String(at ?? ""));
    return !!m && this.standsAtIndex(m[1], Number(m[2]));
  }

  // Width and height of the picture used at a kind of place (a sofa / armchair / raised hand ...).
  poseBox(kind) {
    const ps = this.scene?.pose_size ?? {}, names = { approval: ["raise", "stand"], counter: ["hold", "stand"], lounge: ["doze", "sofa"] }[kind] ?? ["stand"];
    let w = 0, h = 0;
    for (const n of names) if (ps[n]) { w = Math.max(w, ps[n].w); h = Math.max(h, ps[n].h); }
    return [w || 60, h || 90];
  }

  // The places of a kind, then more around them (beside each, left and right) for when the floor has too few.
  candidates(kind) {
    const gridded = this.gridOn(this.scene), spots = (this.scene?.spots?.[kind] ?? []).map((s) => (Array.isArray(s) ? s : s.xy)), [W] = this.poseBox(kind), step = W + 8;
    if (gridded) return spots; // grid scene: one place per tile, the overflow is found by the tile search (gridTarget)
    const extra = spots.flatMap((p) => [[p[0] + step, p[1] + step * 0.45], [p[0] - step, p[1] - step * 0.45],
      [p[0] + step, p[1] - step * 0.45], [p[0] - step, p[1] + step * 0.45]]);
    return [...spots, ...extra];
  }

  // Where a place key leads: {x, y, tile?}. A grid scene gives a tile (free, walkable); the older one just a point.
  spot(sc, id, key, p) {
    if (this.gridOn(sc)) {
      const t = this.gridTarget(sc, id, key, p);
      return { x: t.xy[0], y: t.xy[1], xy: t.xy, tile: t.tile, facing: t.facing ?? null };
    }
    return this.where(sc, id, key);
  }

  // Floor position {x, y} (feet, SVG units) of a place key for one person.
  where(sc, id, key) {
    if (key.startsWith("beside@")) { // standing beside the parent's desk
      const seat = sc.desks?.[key.slice(7)]?.seat ?? sc.door?.spot ?? [sc.width / 2, sc.height / 2];
      return { x: seat[0] + 52 + jit(id, "x", -3, 3), y: seat[1] + 10 + jit(id, "y", -2, 2) };
    }
    const [kind, i] = key.split(":");
    let pt;
    if (kind === "door" || kind === "wait") pt = sc.door?.spot;
    else if (kind === "desk") pt = sc.desks?.[id]?.seat;
    else {
      const arr = this.candidates(kind), n = Number(i);
      if (arr.length) { // more people than places: stand on the floor beside the last candidate
        const over = Math.max(0, n - arr.length + 1), base = arr[Math.min(n, arr.length - 1)];
        pt = over ? [base[0] + 66 * over, base[1] + 24 * over] : base;
      }
    }
    pt = pt ?? sc.door?.spot ?? [sc.width / 2, sc.height / 2];
    // a little different seat/spot for each person
    return { x: pt[0] + jit(id, "x", -1.6, 1.6), y: pt[1] + jit(id, "y", -0.8, 0.8) };
  }

  sync(list, cx) {
    const sc = this.scene;
    if (!sc) return;
    this.people ??= new Map();
    this.claimSeats(list);
    this.updateReps(list);
    const keys = this.placeKeys(list), now = Date.now(), byId = new Map(list.map((a) => [a.id, a]));
    this.keysNow = keys;
    const first = !this.primed && this.feed.state;
    const rewalk = new Set();
    if (this.snapFile !== sc.file || this.snapScene !== sc.scene_id) { // a new floor plan also invalidates in-flight paths and destination facing
      this.snapFile = sc.file;
      this.snapScene = sc.scene_id;
      for (const [id, p] of this.people) {
        if (p.leaving || p.doorEntering) continue;
        if (p.meet && this.meets?.get(p.meet)?.after) continue; // ★89 a conversation goes on through a new plan: meetRewalk (below) moves its point and sends the two on
        if (p.walking || p.pathEnd) {
          ++p.tok; this.resetForChange(p, id); // old callbacks must not write old floor coordinates later
          if (this.gridOn(sc) && p.pos) p.curTile = this.xyTile(sc, p.pos);
          p.tile = null; rewalk.add(id);
          continue;
        }
        const w = this.spot(sc, id, p.at, p);
        p.pos = [w.x, w.y]; p.dur = 0; p.moveUntil = 0; p.facing = (p.meet && this.meets?.get(p.meet)?.face?.[p.meetSide]) || (w.facing ?? null); p.chg = "scene"; // (★74-1 a talking pair keeps facing each other)
        if (w.tile) { p.curTile = w.tile; p.tile = p.at === "door" ? null : w.tile; }
      } // a new floor: still people jump, walkers replan below
      try { this.meetRewalk?.(sc, cx); } catch {} // ★89 after the others: their new places are known
    }
    let waitN = 0;
    const dedupeLounge = () => { const seen = new Set(), arr = sc.spots?.lounge ?? []; for (const a of [...list].sort((m, n) => (m.id < n.id ? -1 : 1))) { const k0 = keys.get(a.id); if (!/^lounge:\d+$/.test(String(k0))) continue; let n = Number(k0.slice(7)); if (seen.has(n)) { let m = 0; while (seen.has(m) && m < Math.max(arr.length, 64)) m++; n = m; keys.set(a.id, `lounge:${n}`); } seen.add(n); } };
    for (const a of list) { const n = sc.seatless_place?.[a.id]; if (n != null && (sc.seatless ?? []).includes(a.id) && String(keys.get(a.id)).startsWith("lounge:")) keys.set(a.id, `lounge:${n}`); } // refine lounge places only: a stale seatless plan must never cancel work, approval or a report
    dedupeLounge();
    for (const a of list) {
      let p = this.people.get(a.id);
      if (p && p.lastStatus != null && p.lastStatus !== a.status && !p.doorEntering && !p.leaving && !(p.meet && a.status !== "blocked")) this.resetForChange(p, a.id); // ★29-3: a new state starts clean (★66: a message makes its receiver work: the talk goes on, only an approval ends it; after it they go to the new state's place)
      // No desk for them in this floor plan yet (a new agent): not drawn until the next plan has it (a person without a desk or pictures is never drawn borrowed).
      if (keys.get(a.id) === "desk" && !sc.desks?.[a.id]?.seat) keys.set(a.id, `wait:${waitN++}`); // no seat yet: stands in a free place around the entrance (never on top of another)
      if (!p && !this.hasPersonFiles(sc.people?.[a.id]) && this.hasPersonFiles(Object.values(sc.people ?? {})[0])) { // (also on the first draw: after the demo, a newcomer was placed at a desk in borrowed clothes) // ★64 (office-live): a newcomer whose own pictures are not in the plan yet waits outside
        this.holdIn ??= new Map(); const t0 = this.holdIn.get(a.id) ?? Date.now(); this.holdIn.set(a.id, t0); // (the plan with them comes ~50 s later): no walk in borrowed clothes that change on the way
        if (Date.now() - t0 < 90000) { if (!this.holdTimer) this.holdTimer = cx.timer.after(5000, (cx) => { this.holdTimer = null; cx.notify(); }); continue; } // (after 90 s: in with a stand-in, as before)
      }
      if (!p) { // opens the door, enters, then walks to its place
        this.holdIn?.delete(a.id);
        p = { at: "door", stand: "door", room: a.source, walking: false, tok: 0, fade: false, leaving: false, missingSince: null };
        this.people.set(a.id, p);
        if (first) { const w = this.spot(sc, a.id, keys.get(a.id), p); Object.assign(p, { at: keys.get(a.id), stand: keys.get(a.id), pos: [w.x, w.y], curTile: w.tile, tile: w.tile, facing: w.facing ?? null, seated: keys.get(a.id) === "desk" }); } // first draw: already in place, facing the destination
        else if (this.doorGeometry(sc)) this.enterDoor(p, a.id, keys, cx); // ★28-2: appears outside, the door opens, through the door, the door closes
        else {
          const w = this.spot(sc, a.id, "door", p);
          Object.assign(p, { pos: [w.x, w.y], curTile: w.tile, tile: null, doorOpen: true, doorAt: Date.now() });
          p.prop = "bag"; this.go(p, a.id, keys.get(a.id), cx, 450, () => { p.prop = null; return null; }); // walks in with a bag
        }
      } else if (rewalk.has(a.id)) {
        this.goTo(p, a.id, keys.get(a.id), cx);
      } else if (p.leaving) { // came back before it left the building
        Object.assign(p, { leaving: false, fade: false, missingSince: null });
        this.go(p, a.id, keys.get(a.id), cx, 0);
      } else if (keys.get(a.id) === "desk" && p.at === "desk" && !p.walking && sc.desks?.[a.id]?.seat_id && p.seatId && p.seatId !== sc.desks[a.id].seat_id && !p.meet) { // (★74-1 not while talking)
        this.go(p, a.id, "desk", cx, 0); // the plan moved their seat: walk over
      } else if (p.busy && Date.now() < p.busy) { // on an errand (printing / a short break): the sequence brings them on
      } else if (sc.l86 && a.status === "idle" && keys.get(a.id) === "desk" && p.at === "desk" && !p.walking && !p.leaving && !p.meet
        && (p.idleKey !== a.since ? ((p.idleKey = a.since), (p.idleT = Date.now()), false) : Date.now() - p.idleT > 20000 && Date.now() - (p.lastBreak ?? 0) > 120000) && this.errand(a, p, "desk", cx)) {
        p.lastBreak = Date.now(); // ★86: a waiting person at the own desk, idle 20 s+, 3 in 10: to the drinks and back with the cup (at most 2 at once; not again for 2 min)
      } else if (p.at !== keys.get(a.id) && p.pendKey !== keys.get(a.id)) {
        const at = String(p.at), left = at.startsWith("approval") ? "approval" : at.startsWith("counter") ? "counter" : null;
        if (left && !p.walking && !String(keys.get(a.id)).startsWith(left)) this.bowThenGo(p, a.id, keys.get(a.id), cx); // approved / report read: bow, then go
        else if (this.errand(a, p, keys.get(a.id), cx)) { /* printing / a short break started */ }
        else this.goTo(p, a.id, keys.get(a.id), cx);
      }
      p.missingSince = null;
      p.room = a.source;
      p.last = a;
      p.lastStatus = a.status;
      if (Array.isArray(a.recent_approvals)) { // the collector's approval events (a short blocked that never showed): each new one is a trip to the approval desk
        p.evSeen ??= Date.now(); const fresh = a.recent_approvals.filter((e) => (e.at ?? 0) * (e.at < 1e12 ? 1000 : 1) > p.evSeen);
        if (fresh.length) { p.evSeen = Math.max(...fresh.map((e) => (e.at ?? 0) * (e.at < 1e12 ? 1000 : 1))); this.approvalEvent(a.id, fresh.length, cx, list); }
      }
    }
    if (this.demo?.() && !this.demoEvTimer) this.demoEvTimer = cx.timer.every(35000, (cx) => { // the demo: now and then an automatic approval happens to somebody who is working
      if (!this.demo?.()) return;
      const cand = [...this.people].filter(([, q]) => q.last?.status === "working" && q.at === "desk" && !q.walking && !(q.busy && Date.now() < q.busy) && !q.trip).map(([id]) => id).sort();
      if (!cand.length) return; const id = cand[Math.floor(Math.random() * cand.length)];
      this.approvalEvent(id, Math.random() < 0.3 ? 3 : 1, cx, [...this.people.values()].map((q) => q.last).filter(Boolean)); cx.notify();
    });
    if (this.feed.state) this.primed = true;
    try { this.meetFromState?.(list, cx); } catch {} // ★66 messages between agents: the two meet and talk (meet.js)
    let waitMore = false;
    for (const [id, p] of this.people) {
      if (byId.has(id) || p.leaving) continue;
      p.missingSince ??= now; // keep them a while: a flicker in the list is not leaving
      // office-sim / ★: if this seat (or its tile) is already given to somebody still in the list, leave at once — the 12 s grace must not leave two people on one chair
      const mine = sc.desks?.[id];
      const seatTaken = !!(mine?.seat_id || mine?.seat_tile) && [...byId.keys()].some((oid) => {
        if (oid === id) return false;
        const od = sc.desks?.[oid]; if (!od) return false;
        if (mine.seat_id && od.seat_id && mine.seat_id === od.seat_id) return true;
        return !!(mine.seat_tile && od.seat_tile && mine.seat_tile[0] === od.seat_tile[0] && mine.seat_tile[1] === od.seat_tile[1]);
      });
      if (!seatTaken && now - p.missingSince < 12000) { waitMore = true; continue; }
      const geom = this.doorGeometry(sc);
      p.leaving = true; if (!geom) { p.doorOpen = true; p.doorAt = Date.now(); }
      const toDoor = geom
        ? (cx) => this.go(p, id, "doorin", cx, 0, (tcx) => { this.exitDoor(p, id, geom, tcx ?? cx); return null; }) // ★28-2: walk to the door, it opens, through it, vanish outside, it closes
        : (cx) => this.go(p, id, "door", cx, 0, () => { // at the door: fade, then forget
          p.fade = true;
          return () => { this.people.delete(id); };
        });
      const waveBusy = [...this.people].some(([oid, q]) => oid !== id && q.leaving && (q.at === "wave" || q.pendKey === "wave")); // ★64 (office-live): one waves at a time; the next goes straight out (two on the one wave tile overlapped)
      if (sc.spots?.wave && !waveBusy) { p.prop = "wave"; this.go(p, id, "wave", cx, 0, (tcx) => { const tk = p.tok; p.facing = sc.spots.wave.facing ?? null; (tcx ?? cx).timer.after(1800, (cx) => { if (p.tok !== tk) return; p.prop = null; p.facing = null; toDoor(cx); }); return null; }); } // wave at the entrance, then out
      else toDoor(cx);
    }
    if (waitMore && !this.leaveTimer) {
      this.leaveTimer = cx.timer.after(13000, (cx) => { this.leaveTimer = null; cx.notify(); });
    }
  }

  // Errands. A report coming in: seat -> the nearest printer / copier (2 s, takes the paper) -> the counter queue.
  // A person who goes idle but keeps the seat: about 3 in 10 take a short break (5-8 s at the coffee / water / vending point) and come back
  // (never more than a quarter of everybody at once). Returns true when an errand started.
  // ★77-1 a free armchair (a lounge place with a seat) for somebody on a break: not one the idle people are sent to (keysNow), nor one another break person holds. Nearest to `from` (a stand point).
  loungeBreakSeat(sc, from, id) {
    const arr = sc?.spots?.lounge ?? [], used = new Set([...(this.keysNow?.values() ?? [])].map(String));
    for (const [pid, q] of this.people ?? []) if (pid !== id && /^lounge:\d+$/.test(String(q.at))) used.add(String(q.at));
    let best = null;
    arr.forEach((q, n) => { if (!q || Array.isArray(q) || !q.seat || !q.xy || used.has(`lounge:${n}`) || this.loungeTaken?.has(n)) return; const d = Math.hypot(q.xy[0] - from.xy[0], q.xy[1] - from.xy[1]); if (!best || d < best.d) best = { n, d }; });
    return best;
  }

  errand(a, p, key, cx) {
    const sc = this.scene, pts = sc?.stand_points ?? [], id = a.id, seat = sc?.desks?.[id]?.seat;
    if (!pts.length || !seat || p.walking || String(p.at) !== "desk" || !errandAllowed(a, key, !!sc.l86)) return false; // somebody working never leaves the desk for an errand
    const near = (parts) => { let best = -1, bd = 1e9; pts.forEach((q, i) => { if (!parts.test(String(q.part ?? q.for)) || !q.xy) return; const d = Math.hypot(q.xy[0] - seat[0], q.xy[1] - seat[1]); if (d < bd) { bd = d; best = i; } }); return best; };
    const back = (i, secs, prop, then) => { // go to the stand point, stay, go on
      p.busy = Date.now() + 60000; p.prop = prop; this.go(p, id, `stand:${i}`, cx, 0, (tcx) => {
        const tk = p.tok; p.facing = pts[i].facing ?? null; p.prop = prop === "coffee" ? "coffee" : null;
        (tcx ?? cx).timer.after(secs * 1000, (cx) => { if (p.tok !== tk) return; p.busy = 0; p.prop = null; p.facing = null; then(cx); cx.notify(); });
        return null;
      });
    };
    if (String(key).startsWith("counter:")) { const i = near(/mfp|printer/i); if (i < 0) return false; back(i, MACHINE_TAKE_S, null, (cx) => this.goTo(p, id, key, cx)); return true; } // ★71-3: take the paper (1.5 s), straight on to the counter
    if (wantsBreak(a, sc.desks?.[id]?.seat_id, key, !!sc.l86)) {
      const resting = [...this.people].filter(([, q]) => q.busy && Date.now() < q.busy && q.onBreak).length;
      if (!breakAllowed(resting, this.people.size, !!sc.l86)) return false;
      // ★88-1 (l86): the own room's water server / coffee machine (the nearest to the desk: they stand on each room's side partition); the vending machine only sometimes
      const vend = !!sc.l86 && hash(`${id}:${Math.floor(Date.now() / 90000)}`) % 5 === 0;
      const i = sc.l86 ? (vend ? (near(/vending/i) >= 0 ? near(/vending/i) : near(/coffee|water/i)) : near(/coffee|water/i)) : near(/coffee|water|vending/i); if (i < 0) return false;
      // The break: a few seconds at the machine to take a drink, then (when the corner has seats: stand points with `seat`) sit down with the cup. No free seat: no break.
      const seatIdx = pts.map((q, n) => ((q.seat || q.seat_on) && q.xy && /break|cafe|stool|chair/i.test(String(q.for ?? q.part ?? "")) ? n : -1)).filter((n) => n >= 0);
      const taken = (this.breakTaken ??= new Set()), free = seatIdx.filter((n) => !taken.has(n));
      // ★77-1 the break room (the lounge, next to the drinks): after the drink a free armchair there is a seat too, the nearer one wins
      const lq = this.loungeBreakSeat(sc, pts[i], id), loungeOk = lq != null;
      if (seatIdx.length && !free.length && !loungeOk) return false;
      const j = free.length ? free.reduce((b, n) => (Math.hypot(pts[n].xy[0] - pts[i].xy[0], pts[n].xy[1] - pts[i].xy[1]) < Math.hypot(pts[b].xy[0] - pts[i].xy[0], pts[b].xy[1] - pts[i].xy[1]) ? n : b)) : -1;
      let useLounge = loungeOk && (j < 0 || lq.d < Math.hypot(pts[j].xy[0] - pts[i].xy[0], pts[j].xy[1] - pts[i].xy[1]));
      if (useLounge) { (this.loungeTaken ??= new Set()).add(lq.n); p.loungeSeat = lq.n; } else if (j >= 0) { taken.add(j); p.breakJ = j; }
      const jj = useLounge ? -1 : j;
      const home = (cx) => { if (j >= 0) taken.delete(j); if (p.loungeSeat != null) { this.loungeTaken?.delete(p.loungeSeat); p.loungeSeat = null; } p.loungeBreak = false; p.breakJ = -1; p.onBreak = false; p.sitBreak = null; p.prop = null; this.go(p, id, "desk", cx, 0); };
      p.onBreak = true;
      back(i, MACHINE_TAKE_S, "coffee", (cx) => { // ★71-3: at the machine only to take the cup (1.5 s): nobody stands drinking in front of it
        if (useLounge) { // ★77-1 the cup in hand to a free armchair of the break room, sit there, then back to the desk
          const n = p.loungeSeat; p.busy = Date.now() + 40000; p.prop = null; p.loungeBreak = true;
          this.go(p, id, `lounge:${n}`, cx, 0, (tcx) => {
            const tk = p.tok; // after go(): it bumps p.tok (as back() does)
            (tcx ?? cx).timer.after((5 + (hash(id) % 4)) * 1000, (cx) => { if (p.tok !== tk) { this.loungeTaken?.delete(n); return; } p.busy = 0; home(cx); cx.notify(); });
            return null;
          });
          return;
        }
        if (j < 0) { // no break seat (★55): back to the own desk with the cup and sit there for the break ("コーヒーを持つ" = a short rest)
          p.busy = Date.now() + 40000; p.prop = "coffee";
          this.go(p, id, "desk", cx, 0, (tcx) => {
            const tk = p.tok; p.prop = null; p.cupSit = true; // ★87-2 back at the own desk: sits with the cup in hand for the break (person() lays a small cup on the hand)
            (tcx ?? cx).timer.after(breakSeconds(id) * 1000, (cx) => { if (p.tok !== tk) return; p.busy = 0; p.onBreak = false; p.cupSit = false; p.sitBreak = null; cx.notify(); });
            return null;
          });
          return;
        }
        p.busy = Date.now() + 40000; p.prop = null;
        this.go(p, id, `stand:${j}`, cx, 0, () => { // arrived at the seat: sit, facing as the point says
          const tk = p.tok; p.facing = pts[j].facing ?? "dl"; p.sitBreak = this.breakKind(sc, pts[j]);
          cx.timer.after((5 + (hash(id) % 4)) * 1000, (cx) => { if (p.tok !== tk) { taken.delete(j); return; } p.busy = 0; p.facing = null; home(cx); cx.notify(); });
          return null;
        });
      }); return true;
    }
    return false;
  }

  // ★29-1 the report trips. reps: id -> { since, phase }. A `done` that starts while the person is drawn is a trip (phase "go": to the counter, hand the paper over,
  // back to the seat, phase "wait"); one that is already there at the first draw / arrives with the person starts as "wait" (they just sit at the seat).
  updateReps(list) {
    const reps = (this.reps ??= new Map()), ids = new Set(list.map((a) => a.id));
    for (const id of [...reps.keys()]) if (!ids.has(id)) reps.delete(id);
    for (const a of list) {
      if (a.status !== "done") { reps.delete(a.id); continue; }
      const r = reps.get(a.id); if (r && r.since === a.since) continue;
      const p = this.people?.get(a.id);
      reps.set(a.id, { since: a.since, phase: p && !p.leaving && this.primed ? "go" : "wait" });
    }
  }

  goTo(p, id, key, cx) { // a place key; the counter (only `done` people are sent there) is a short trip
    if (String(key).startsWith("counter:")) return this.goCounter(p, id, key, cx);
    this.go(p, id, key, cx, 0);
  }

  goCounter(p, id, key, cx) {
    this.go(p, id, key, cx, 0, () => { // at the counter: the paper goes over for 3-4 s, then back to the seat (no seat in the plan: stays, as before)
      const rep = this.reps?.get(id), since = rep?.since;
      if (rep?.phase !== "go" || !this.scene?.desks?.[id]?.seat) return null;
      const tk = p.tok; p.busy = Date.now() + 6000;
      cx.timer.after(3000 + (hash(id) % 1000), (cx) => {
        const r = this.reps?.get(id);
        if (p.tok !== tk || !r || r.since !== since || r.phase !== "go") return;
        r.phase = "wait"; p.busy = 0; this.go(p, id, "desk", cx, 0); cx.notify();
      });
      return null;
    });
  }

  // ★29-3 the state changed: every temporary thing of the old state goes (poses, errand, trip, a walk that was queued behind the old one)
  // so the next go() is never skipped and nobody keeps a cup / a raised hand into the new state.
  resetForChange(p, id) {
    if (p.breakJ >= 0) this.breakTaken?.delete(p.breakJ);
    if (p.loungeSeat != null) { this.loungeTaken?.delete(p.loungeSeat); p.loungeSeat = null; } p.loungeBreak = false; // ★77-1
    if (p.meet) this.meetEnd?.(p.meet, null, id); // ★66 a state change ends the meeting at once (the other one is sent back by the next sync)
    Object.assign(p, { busy: 0, trip: null, evN: 0, okAt: 0, prop: null, onBreak: false, cupSit: false, breakJ: -1, sitBreak: null, reading: false, bowing: false, facing: null, standUntil: 0, pend: null, pendKey: null, walking: false, moveUntil: (p.moveUntil && p.moveUntil > Date.now() ? p.moveUntil : 0), moveGrace: (p.moveUntil && p.moveUntil > Date.now() ? 60 : 0), pathEnd: 0, idleSince: null, stuckTries: 0 });
    this.trips?.delete(id);
  }

  // Approved: a short bow (down and up once), then back to the desk.
  // A seat at the café corner: "cafe" (a chair at the round table) or "stool" (at the high counter). A names the kind (`kind`), else the nearer of the table / counter (scene.cafe tiles).
  breakKind(sc, q) {
    const k0 = String(q.kind ?? ""); if (/stool|counter/i.test(k0)) return "stool"; if (/cafe|chair|table/i.test(k0)) return "cafe";
    try { const c = sc.cafe, d = (t) => { const v = this.tileXY(sc, t); return Math.hypot(v[0] - q.xy[0], v[1] - q.xy[1]); }; if (c?.table && c?.counter) return d(c.counter) < d(c.table) ? "stool" : "cafe"; } catch {}
    return "cafe";
  }

  // An automatic approval (too short to show as "waiting"): the person walks to the approval desk, shows the paper 3-4 s, a green check, and goes back.
  // Events that come while the trip is on are merged into it ("x3" over the head). Only a few trips at once.
  approvalEvent(id, n, cx, list) {
    const p = this.people.get(id); this.okCount = (this.okCount ?? 0) + n;
    if (!p) return;
    if (p.trip) { p.evN = (p.evN ?? 1) + n; return; }
    const sc = this.scene; this.trips ??= new Set();
    if (!sc || p.at !== "desk" || p.walking || p.leaving || (p.busy && Date.now() < p.busy) || this.trips.size >= 3 || !(sc.spots?.approval?.length || sc.windows?.approval)) return;
    const slot = (list ?? []).filter((x) => x.status === "blocked").length + this.trips.size;
    p.evN = n; p.trip = "go"; p.busy = Date.now() + 25000; this.trips.add(id);
    this.go(p, id, `approval:${slot}`, cx, 0, () => { // at the desk: paper out
      const tk = p.tok; p.trip = "ask"; p.facing = null;
      cx.timer.after(3000 + (hash(id) % 1000), (cx) => { if (p.tok !== tk) { this.trips.delete(id); p.trip = null; p.busy = 0; p.evN = 0; p.okAt = 0; return; }
        p.trip = "ok"; p.okAt = Date.now(); cx.notify();
        cx.timer.after(1000 + (p.evN > 1 ? 600 : 0), (cx) => { this.trips.delete(id); if (p.tok !== tk) { p.trip = null; p.busy = 0; p.evN = 0; p.okAt = 0; return; } p.trip = null; p.busy = 0; p.evN = 0; p.okAt = 0; this.go(p, id, "desk", cx, 0); cx.notify(); }); });
      return null;
    });
  }

  // ---- ★28-2 the door. The timeline (life.js doorTimeline) is played with timers: the door's picture follows each person's own phase (p.doorPhase),
  // the walk follows the moves. A person walks through the doorway only while the door is open.
  playDoor(p, id, kind, geom, cx, { onMoved, onEnd } = {}) {
    const segs = doorTimeline(kind, { outside: kind === "enter" ? geom.outside : geom.vanish, cells: geom.cells, inside: geom.inside });
    const tok = ++p.tok, dtok = (p.doorTok = (p.doorTok ?? 0) + 1), lastMove = segs.map((q) => !!q.move).lastIndexOf(true);
    let t = 0; const at = [];
    for (const q of segs) { at.push(t); t += q.ms; }
    const total = t + 120;
    p.busy = Date.now() + total + 400; // nobody re-routes them in the middle of the doorway (sync leaves a busy person alone)
    segs.forEach((q, i) => {
      cx.timer.after(at[i], (cx) => { // the door
        if (p.doorTok !== dtok) return;
        p.doorPhase = q.phase === "closed" || i === segs.length - 1 ? null : q.phase;
        cx.notify();
      });
      cx.timer.after(at[i], (cx) => { // the person
        if (p.tok !== tok) { this.doorAbort(p, id, kind, dtok, cx); return; } // ★56-1 somebody else took the person over in the doorway: nothing of the door walk may stay behind
        if (q.ev === "appear") Object.assign(p, { pos: q.at, curTile: null, tile: null, walking: false, dur: 0, moveUntil: 0, fade: false });
        if (q.move) {
          const dx = q.move[0] - p.pos[0], dy = q.move[1] - p.pos[1];
          if (Math.abs(dx) + Math.abs(dy) >= 6) { p.dx = dx; p.dy = dy; }
          p.depth = Math.max(this.depthOfXY(this.scene, p.pos), this.depthOfXY(this.scene, q.move)) + 0.01;
          p.pos = q.move; p.dur = q.ms; p.walking = true; p.moveUntil = Date.now() + q.ms; p.facing = null; p.chg = `door-${kind}`;
        }
        cx.notify();
        if (q.move) cx.timer.after(q.ms + 40, (cx) => {
          if (p.tok !== tok) { this.doorAbort(p, id, kind, dtok, cx); return; }
          if (i !== lastMove) return;
          p.walking = false; p.moveUntil = 0; p.depth = null; p.chg = `door-${kind}-end`;
          if (q.ev === "vanish") { p.fade = true; p.vanishedAt = Date.now(); }
          else { p.curTile = geom.insideTile; p.stand = "doorin"; }
          cx.notify();
          onMoved?.(cx);
        });
      });
    });
    cx.timer.after(total, (cx) => { if (p.tok === tok) p.busy = 0; if (p.doorTok === dtok) p.doorPhase = null; onEnd?.(cx); cx.notify(); });
    p.doorStart = Date.now(); p.doorMax = total + 800;
    cx.timer.after(total + 800, (cx) => { if (p.doorTok === dtok && p.doorEntering) this.doorAbort(p, id, kind, dtok, cx, true); }); // the safety net: the door walk ended and the person is still marked as in the doorway
  }

  // ★56-1 the door walk was cut short (the person was taken over / the scene changed): clear everything the door walk set and send the person on to where their state asks
  // (a person leaving just goes). `force`: also when a move of their own is still on (the net at the end of the door walk).
  doorAbort(p, id, kind, dtok, cx, force = false) {
    if (p.doorAborted === dtok) return;
    if (!force && Date.now() < (p.moveUntil ?? 0)) return; // another walk of theirs is going: leave it alone (the net at the end looks again)
    p.doorAborted = dtok; p.chg = "door-abort"; p.doorEntering = false; p.walking = false; p.moveUntil = 0; p.busy = 0; p.depth = null; p.dur = 0; p.prop = kind === "enter" ? null : p.prop;
    if (p.doorTok === dtok) p.doorPhase = null;
    if (kind === "exit" || p.leaving) { cx.timer.after(300, (cx) => { this.people?.delete(id); cx.notify(); }); return; }
    const key = this.keysNow?.get(id); if (key) this.go(p, id, key, cx, 0);
    cx.notify();
  }

  enterDoor(p, id, keys, cx) {
    const geom = this.doorGeometry(this.scene);
    Object.assign(p, { pos: geom.outside, curTile: null, tile: null, prop: "bag", doorEntering: true });
    this.playDoor(p, id, "enter", geom, cx, { onMoved: (cx) => {
      p.doorEntering = false; p.busy = 0;
      this.go(p, id, this.keysNow?.get(id) ?? keys.get(id), cx, 0, () => { p.prop = null; return null; }); // in: on to the desk (the door closes behind)
    } });
  }

  exitDoor(p, id, geom, cx) {
    p.prop = null;
    this.playDoor(p, id, "exit", geom, cx, { onMoved: (cx) => { cx.timer.after(700, () => { this.people.delete(id); cx.notify(); }); } });
  }

  // The door's picture state: from the new phases, else the older "somebody is at the door" rule.
  doorState() {
    const people = [...(this.people ?? []).values()], phases = people.map((p) => p.doorPhase).filter(Boolean);
    if (phases.length) return doorStateOf(phases);
    const opening = people.filter((p) => p.doorOpen && Date.now() - (p.doorAt ?? 0) < 6000);
    return !opening.length ? "closed" : opening.some((p) => p.walking) ? "open" : "half";
  }

  // ---- ★28-1 a person who does not get on for 3 s: the route is drawn again; still stuck: the nearest walkable tile, then the walk again. Called from the redraw timer.
  // ★29-2: every second, everybody who is not walking (and not on an errand) is checked against the place their state asks for (this.keysNow): a state change that
  // was missed (1.5 s), a stop short of the goal (3 s), a stand far from the place's point (1.5 s). A walk that is 3 s overdue is drawn again too. Each case is counted by
  // its reason and written as one line (hakoniwa-office/stuck-log.jsonl, the newest 200 lines).
  watchStuck(cx) {
    const now = Date.now(), sc = this.scene;
    for (const [id, p] of this.people ?? []) {
      if (p.doorEntering && p.doorStart && now - p.doorStart > (p.doorMax ?? 8000) + 2000 && !p.leaving) { this.doorAbort(p, id, "enter", p.doorTok, cx, true); continue; } // ★56-1 in the doorway for longer than the door walk takes
      if (p.leaving && !p.fade) { // ★64 (office-live, App 07:11/07:17): somebody who was ended stood at the wave spot for minutes. Still for 5 s while leaving (not in the doorway): sent out
        const still = !this.moving(p) && !(p.busy && now < p.busy) && !p.doorPhase && !p.standUntil; p.leaveStill = still ? (p.leaveStill ?? now) : null;
        if (still && now - p.leaveStill >= 5000) {
          p.leaveStill = null; p.leaveNets = (p.leaveNets ?? 0) + 1; this.logStuck(cx, id, p, `leave-stuck:${p.at}:${p.prop ?? "-"}:tok${p.tok}`, p.leaveNets > 2 ? "gone" : "out", null);
          const geom = this.doorGeometry(sc); p.prop = null; p.facing = null;
          if (p.leaveNets > 2 || !geom) this.people.delete(id); else this.go(p, id, "doorin", cx, 0, (tcx) => { this.exitDoor(p, id, geom, tcx ?? cx); return null; });
          cx.notify?.(); continue;
        }
      }
      if (p.leaving || p.doorEntering || p.fade || p.meet || (p.busy && now < p.busy)) { p.idleSince = null; continue; } // (★74-1 p.meet: a talking pair is never "stuck"; the meeting's own 25 s limit calls it off)
      const want = this.keysNow?.get(id) ?? null;
      const c = stuckCheck(p, want, !p.walking && !!want && p.at === want && p.stand === p.at && this.farFromSpot(sc, id, p), now);
      if (!c) { p.idleSince = null; if (!p.walking) p.stuckTries = 0; continue; }
      p.idleSince ??= now;
      if (now - p.idleSince < c.ms) continue;
      const act = stuckAction({ walking: true, pathEnd: 1, at: p.at, stand: p.stand }, now, p.stuckTries ?? 0); // ("replan" the first time, "rescue" after)
      p.stuckTries = (p.stuckTries ?? 0) + 1; p.chg = `stuck:${c.reason}`; p.idleSince = now; p.walking = false; p.moveUntil = 0; p.pend = null; p.pendKey = null; p.pathEnd = 0;
      this.stuckLog = [...(this.stuckLog ?? []).slice(-20), { id, at: now, act, reason: c.reason }];
      this.logStuck(cx, id, p, c.reason, act, want);
      this.goTo(p, id, c.reason === "state-missed" ? want : p.at, cx);
    }
  }

  // A desk must satisfy atSeat (< 12 px); other fixed places keep their 60 px spacing tolerance.
  farFromSpot(sc, id, p) {
    try {
      if (!sc || !this.gridOn(sc) || !p.pos || !/^(desk|approval:|counter:|lounge:)/.test(String(p.at))) return false;
      const t = this.gridTarget(sc, id, String(p.at), p);
      const distance = t?.xy ? Math.hypot(t.xy[0] - p.pos[0], t.xy[1] - p.pos[1]) : 0;
      return p.at === "desk" ? distance >= 12 : distance > 60; // match atSeat(): no 12..60 px gap where a worker stands forever
    } catch { return false; }
  }

  // ★64 (office-live): every 2 s (a timer, never a render) everybody is looked at once: only the shadow / walking on the spot / stopped away from the place / sliding.
  // A kind is written when it starts (one line: time, person, kind, place, state) to hakoniwa-office/live-check.jsonl (the newest 400 lines); every minute one "tick"
  // line with the totals, so a quiet log can be told from a dead check. Light: a pose lookup and a few numbers per person (20 people well under 1 ms).
  liveFacts(id, p, sc, now) {
    const a = this.lastList?.find?.((x) => x.id === id) ?? p.last;
    if (!a || !p.pos) return null;
    const own = this.hasPersonFiles(sc?.people?.[id]), files = this.personFilesFor(id, sc), { key, frames } = this.poseFiles(files, a, p);
    this.liveLeg ??= new Map(); let lg = this.liveLeg.get(id); const moving = this.moving(p); // the running leg as the native transition plays it (start = moveUntil - dur)
    if (moving && (p.moveUntil ?? 0) > now && (!lg || lg.target !== p.pos)) { lg = { target: p.pos, from: p.legFrom ?? (lg ? this.legNow(lg, now) : p.pos), at: p.moveUntil - Math.max(1, p.dur ?? 0), dur: Math.max(1, p.dur ?? 0) }; this.liveLeg.set(id, lg); } // (★89 from: the leg's real start, else the old model)
    const live = lg && lg.target === p.pos && now < lg.at + lg.dur - 60, pos = live ? this.legNow(lg, now) : p.pos;
    const inLeg = !moving && live; // the picture still slides to the leg's end, but the person is no longer marked as walking (a still pose that slides)
    const want = this.keysNow?.get(id) ?? null, exempt = !!(p.leaving || p.doorEntering || p.fade || p.bowing || (p.busy && now < p.busy) || (p.standUntil && now < p.standUntil) || p.trip);
    const okAt = !want || p.at === want && p.stand === p.at || (a.status === "done" && this.reps?.get(id)?.phase === "wait" && p.stand === "desk") || (a.status === "working" && this.atSeat(a, p)); // (the same allowances as office-sim's end check)
    const away = !okAt || (!!want && p.at === want && this.farFromSpot(sc, id, p));
    return { a, s: { moving, still: moving && !live && !(p.moveUntil && now < p.moveUntil + 300), own, frames: frames.length, key, pos, inLeg, away, exempt }, want };
  }

  // ★95: cancel every timer this part made (all `*Timer` handles) and forget them. A live part makes them again at its next render (each is created `if (!this.xTimer)`);
  // a part an install's reload left behind never renders again, so its timers stay ended. Host calls from such a part throw `null`.
  stopTimers() { for (const k of Object.keys(this)) { if (!/Timer$/.test(k)) continue; try { this[k]?.cancel?.(); } catch {} this[k] = null; } }

  // ★88-6 every part of the mod beats here (a timer, also in an old part a hot reload left): the live-check shows how many are alive and the old ones retire.
  partBeat(cx, now = Date.now()) {
    this.partId ??= `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`; this.partBorn ??= now;
    this.liveCounts ??= { shadow: 0, stomp: 0, stopped: 0, slide: 0, unrendered: 0 };
    const reg = shared("hakoniwa.parts") ?? {}, mine = reg[this.partId], parts = livePartsOf(reg, now);
    if (!mine || now - Number(mine.at ?? 0) > 20000) { // (one write in 20 s: setShared re-renders everybody)
      const next = {}; for (const [id, v] of Object.entries(reg)) if (v && now - Number(v.at ?? 0) < PART_ALIVE_MS * 3) next[id] = v;
      next[this.partId] = { at: now, born: this.partBorn };
      cx.timer.after(0, () => setShared("hakoniwa.parts", next));
    }
    const ids = new Set(parts.map((q) => q.id)); this.partsSeen ??= new Map();
    for (const q of parts) this.partsSeen.set(q.id, { born: q.born, last: now });
    for (const [id, v] of [...this.partsSeen]) if (!ids.has(id)) { // ★88-6 a part that beat before and no longer does: its timers ended with it (the heartbeat is one of them)
      this.partsSeen.delete(id); (this.liveNotes ??= []).push(JSON.stringify({ t: new Date(now).toISOString(), kind: "part-gone", id, born: v.born, silent_s: Math.round((now - v.last) / 1000), me: this.partId }));
    }
    this.liveCounts.parts = parts.length; this.liveCounts.partsMax = Math.max(this.liveCounts.partsMax ?? 0, parts.length);
    if (shouldRetire(parts, this.partId, this.lastRenderAt ?? 0, now) && !this.retired) {
      this.retired = true; this.stopTimers(); // ★95 every timer of an old part ends (the board's tick among them), not only two
      (this.liveNotes ??= []).push(JSON.stringify({ t: new Date(now).toISOString(), kind: "part-retired", id: this.partId, alive: parts.map((q) => q.id) }));
    }
    return parts.length;
  }

  // ★89 how far along its path a person was at time t (px): the legs' own schedule (each leg is a linear native transition of `dur` ms from `at`). The pace of a walk is the change of this
  // over a window: a walk that turns corners or goes round a partition is measured by its way, not by the straight distance (the chord of a U-shaped walk is short).
  pathDone(p, t) { let n = p.legBase ?? 0; for (const l of p.legLog ?? []) { if (l.at > t) break; n += l.len * Math.max(0, Math.min(1, (t - l.at) / Math.max(1, l.dur))); } return n; }

  liveCheck(cx, write = true) {
    const now = Date.now(); if (this.retired) return [];
    const nParts = this.partBeat(cx, now); if (nParts > 1 && now - (this.dupNoteAt ?? 0) > 60000) { this.dupNoteAt = now; (this.liveNotes ??= []).push(JSON.stringify({ t: new Date(now).toISOString(), kind: "dup-parts", n: nParts, me: this.partId, ages_s: Object.fromEntries(Object.entries(shared("hakoniwa.parts") ?? {}).map(([id, v]) => [id, Math.round((now - Number(v?.at ?? 0)) / 1000)])) })); } // ★88-6 more than one office part alive
    const sc = this.scene; if (!sc) return [];
    this.liveMemo ??= new Map(); this.liveCounts ??= { shadow: 0, stomp: 0, stopped: 0, slide: 0, unrendered: 0 }; this.liveLooks = (this.liveLooks ?? 0) + 1;
    const lines = [];
    for (const [id, p] of this.people ?? []) {
      const f = this.liveFacts(id, p, sc, now); if (!f) continue;
      { // ★89 the pace of a conversation walk (both ways: to the meeting and back to the seat): px per second over about 2 s against the walking speed the same person has when entering / leaving
        this.pace ??= new Map(); this.liveCounts.meetPace ??= 0; this.liveCounts.meetPaceOff ??= 0;
        const rec = this.pace.get(id);
        if (!p.walking || !f.s.pos || !(p.meet || p.meetBack)) this.pace.delete(id);
        else if (!rec || rec.tok !== p.tok) this.pace.set(id, { t: now, pos: f.s.pos, tok: p.tok, turns: p.turns ?? 0, done: this.pathDone(p, now) }); // (a new walk (re-route / new place): measured from its own start)
        else if (now - rec.t >= 1800) {
          // ★89 only a window that was walking from end to end: the chord of a walk that turned a corner or arrived inside the window is shorter than the path (the first count flagged 7 of 27 as slow for that reason)
          const done = this.pathDone(p, now), sp = (done - (rec.done ?? done)) / (now - rec.t) * 1000, nom = 95 * jit(id, "v", 0.75, 1.3), endsSoon = (p.pathEnd ?? 0) - now < 400; // ★89 speed along the path
          const win = now - rec.t, chord = Math.hypot(f.s.pos[0] - rec.pos[0], f.s.pos[1] - rec.pos[1]), want = nom * win / 1000, turns = (p.turns ?? 0) - (rec.turns ?? 0), sinceGo = now - (p.goAt ?? now), toEnd = (p.pathEnd ?? 0) - now;
          this.pace.set(id, { t: now, pos: f.s.pos, tok: p.tok, turns: p.turns ?? 0, done });
          if (!endsSoon) this.liveCounts.meetPace++;
          if (!endsSoon && (sp < nom * 0.7 || sp > nom * 1.3)) { // ★89 how far off, over how long, and where in the walk (start = the first 0.9 s, end = the last 1.5 s, corner = it turned inside the window): px short of the walking speed and the same in ms
            this.liveCounts.meetPaceOff++;
            lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: "meetpace", speed: Math.round(sp), nominal: Math.round(nom), at: p.at, back: !!p.meetBack, window_ms: Math.round(win), chord_px: Math.round(chord), path_px: Math.round(sp * win / 1000), want_px: Math.round(want), short_px: Math.round(want - sp * win / 1000), short_ms: Math.round((want - sp * win / 1000) / nom * 1000), since_go_ms: Math.round(sinceGo - win), to_end_ms: Math.round(toEnd), leg: `${(p.legIdx ?? 0) + 1}/${p.nLegs ?? 1}`, turns, where: sinceGo - win < 900 ? "start" : toEnd < 1500 ? "end" : turns > 0 ? "corner" : "middle" }));
          }
        }
      }
      { // ★102-7 how long somebody has had no seat in the plan: one line at 10 s (who, how long, the plan's state), one when it ends
        this.seatlessAt ??= new Map(); this.liveCounts.seatless ??= 0;
        const no = hasNoSeat(sc, id) && !p.leaving, rec = this.seatlessAt.get(id);
        if (no && !rec) this.seatlessAt.set(id, { t: now, noted: false });
        else if (no && !rec.noted && now - rec.t >= SEATLESS_NOTE_MS) {
          rec.noted = true; this.liveCounts.seatless++;
          lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: "seatless", secs: Math.round((now - rec.t) / 1000), at: p.at, status: f.a.status ?? null, pos: f.s.pos?.map((v) => Math.round(v)), key: f.s.key, plan: { busy_s: this.planBusyUntil && this.planBusyUntil > now ? Math.round((this.planBusyUntil - now) / 1000) : 0, tries: this.tries ?? 0, seat_tries: this.seatTries ?? 0, scene_id: sc.scene_id ?? null, people_in_plan: Object.keys(sc.desks ?? {}).length, people_now: this.people?.size ?? 0 } }));
        } else if (!no && rec) { this.seatlessAt.delete(id); if (rec.noted) lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: "seatless-end", secs: Math.round((now - rec.t) / 1000), at: p.at })); else this.seatlessAt.delete(id); }
      }
      const r = liveKinds(f.s, this.liveMemo.get(id), now); this.liveMemo.set(id, r.memo);
      for (const kind of r.gone ?? []) lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: `${kind}-end`, at: p.at, status: f.a.status ?? null, own: f.s.own }));
      for (const kind of r.fresh) { this.liveCounts[kind]++; if (p.meet && (kind === "stopped" || kind === "slide")) { const mk = kind === "stopped" ? "meetStopped" : "meetSlide"; this.liveCounts[mk] = (this.liveCounts[mk] ?? 0) + 1; } /* ★89 counted again while somebody is in a conversation walk */ lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind, at: p.at, stand: p.stand, want: f.want, status: f.a.status ?? null, pos: f.s.pos?.map((v) => Math.round(v)), tile: p.curTile ?? null, key: f.s.key, own: f.s.own, frames: f.s.frames, walking: !!p.walking, dur: p.dur ?? 0, left: Math.round((p.moveUntil ?? 0) - now), leg: Math.round((this.liveLeg?.get(id)?.at ?? now) + (this.liveLeg?.get(id)?.dur ?? 0) - now), door: !!p.doorEntering, leaving: !!p.leaving, prop: p.prop ?? null, tok: p.tok, pend: p.pendKey ?? null, busy: p.busy ? Math.round(p.busy - now) : 0, phase: p.doorPhase ?? null, demo: !!this.demo?.() })); }
    }
    { // ★87-1: a rescue = no way to the place over the walkable tiles: the person was set down at the nearest reachable tile (it looks like walking through a partition)
      this.liveCounts.rescued ??= 0;
      for (const [id, p] of this.people ?? []) if ((p.rescues ?? 0) > (p.rescSeen ?? 0)) { this.liveCounts.rescued += p.rescues - (p.rescSeen ?? 0); p.rescSeen = p.rescues; lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: "rescued", at: p.at, tile: p.curTile ?? null })); }
    }
    if (this.liveNotes?.length) lines.push(...this.liveNotes.splice(0)); // ★66 the meetings (meet.js)
    { // ★71-1 the inside moved on but the screen was not drawn again for 1 s+ ("moves only when clicked"): one line per episode, and a redraw now
      let redraw = false; this.liveCounts.unrendered ??= 0;
      for (const [id, p] of this.people ?? []) {
        const d = this.drawn?.get(id); if (!d || d.seq !== this.drawSeq) { p.unrAt = null; continue; } // (not in the last draw: hidden on purpose)
        const mv = this.moving(p), diff = d.pos !== p.pos || d.at !== p.at || d.mv !== mv;
        if (!diff) { p.unrAt = null; p.unrOpen = false; continue; }
        if (p.unrAt && d.t > p.unrAt) { p.unrAt = null; p.unrOpen = false; } // ★89 a draw happened after the difference was first seen: that difference is closed (the state that differs NOW is a newer change: it was flagged as 'unrendered' 1.6 s after a draw that had in fact followed it)
        p.unrAt ??= now;
        if (now - Math.max(p.unrAt, d.t) < 1000) continue;
        redraw = true;
        if (!p.unrOpen) { p.unrOpen = true; this.liveCounts.unrendered++; lines.push(JSON.stringify({ t: new Date(now).toISOString(), id, kind: "unrendered", chg: p.chg ?? null, at: p.at, stand: p.stand ?? null, drawnAt: d.at, moved: d.pos !== p.pos, walk: [d.mv, mv], since: now - d.t, last_render_ago: now - (this.lastRenderAt ?? 0), part_age_s: Math.round((now - (this.partBorn ?? now)) / 1000), cut_now: !!globalThis.__hudPhase, go_ago: p.goAt ? now - p.goAt : null, moveLeft: p.moveUntil ? p.moveUntil - now : 0, pend: p.pendKey ?? null, status: (this.lastList?.find?.((x) => x.id === id) ?? p.last)?.status ?? null, demo: !!this.demo?.() })); }
      }
      for (const id of [...(this.drawn?.keys() ?? [])]) if (!this.people?.has(id)) this.drawn.delete(id);
      if (redraw) cx.notify?.();
    }
    for (const id of [...this.liveMemo.keys()]) if (!this.people?.has(id)) { this.liveMemo.delete(id); this.liveLeg?.delete(id); }
    if (!this.liveTickAt || now - this.liveTickAt >= 60000) { // ★90 (H): the App's private bytes (the collector reads it, no process is started)
      this.liveTickAt = now;
      const appMB = Math.round((this.feed?.state?.app_mem_bytes ?? 0) / 1048576) || null; this.appMB = appMB;
      const warn = appNeedsRestart(appMB); // only the turn of the hint asks for a draw (liveCheck runs every 2 s and must not draw by itself)
      if (warn && !this.appMemWarn) { this.appMemWarn = true; cx.notify?.(); } else if (!warn) this.appMemWarn = false;
      lines.push(JSON.stringify({ t: new Date(now).toISOString(), kind: "tick", looks: this.liveLooks, people: this.people?.size ?? 0, counts: this.liveCounts, appMB, demo: !!this.demo?.() }));
    }
    if (lines.length && write) {
      const path = `${appHome()}/hakoniwa-office/live-check.jsonl`;
      cx.spawn?.(async () => { try { let old = ""; try { old = await readTextFile(path); } catch {} if (!this.liveLines) this.liveLines = String(old ?? "").split("\n").filter(Boolean).slice(-400); // (after a reload the earlier lines are kept)
        this.liveLines = [...this.liveLines, ...lines].slice(-400); await writeTextFile(path, `${this.liveLines.join("\n")}\n`, old); } catch {} });
    }
    return lines;
  }

  logStuck(cx, id, p, reason, act, want) {
    this.stuckCounts = { ...(this.stuckCounts ?? {}), [reason]: (this.stuckCounts?.[reason] ?? 0) + 1 };
    const line = JSON.stringify({ t: new Date().toISOString(), id, reason, act, status: p.last?.status ?? null, at: p.at, stand: p.stand, want, tile: p.curTile ?? null, counts: this.stuckCounts });
    this.stuckLines = [...(this.stuckLines ?? []).slice(-199), line];
    const path = `${appHome()}/hakoniwa-office/stuck-log.jsonl`, text = `${this.stuckLines.join("\n")}\n`;
    cx.spawn?.(async () => { try { await writeTextFile(path, text, await readTextFile(path)); } catch {} });
  }

  bowThenGo(p, id, key, cx) {
    const tok = ++p.tok;
    p.at = key; p.dur = 240; p.bowing = true; p.chg = "bow"; // (a transition on top does the dip)
    cx.timer.after(0, (cx) => {
      if (p.tok !== tok) { p.bowing = false; return; }
      cx.notify();
      cx.timer.after(260, (cx) => {
        if (p.tok !== tok) { p.bowing = false; return; }
        p.bowing = false; cx.notify();
        cx.timer.after(280, () => { if (p.tok === tok) this.go(p, id, key, cx, 0); });
      });
    });
  }

  // Walk to `key` by way of the doorways: out of the room it sits in (its room's entrance), through the
  // entrance, into the destination room. Each leg is one native transition; cx.timer.after chains them.
  // `after` runs on arrival (may return a second step run 700 ms later).
  go(p, id, key, cx, delay, after) {
    const sc = this.scene;
    if (String(p.at) === "desk" && key !== "desk" && !p.walking && !p.standUntil) { p.standUntil = Date.now() + 340; delay = Math.max(delay || 0, 340); cx.timer.after(360, (cx) => { p.standUntil = 0; cx.notify(); }); cx.timer.after(0, (cx) => cx.notify()); } // stand up first, then walk (no jump from the chair to the aisle)
    if (this.gridOn(sc) && p.walking && p.pathEnd && Date.now() < p.pathEnd) { // still on the way: arrive first, then go on (no jump)
      p.pend = { key, after, delay }; p.pendKey = key;
      return;
    }
    if (clearTransient(p, key)) this.trips?.delete(id);
    const tok = ++p.tok;
    p.pend = null; p.pendKey = null; p.diag = null; // (a walk queued behind an older one is dropped with it: never fired late)
    p.at = key; // decided now (not after the delay), so a redraw does not restart the walk
    const to = this.spot(sc, id, key, p);
    if (this.gridOn(sc) && !(to.tile && to.xy)) p.diag = "no-spot"; // ★29-2: the place has no tile / point in this plan
    p.seated = key === "desk";
    if (key === "desk") p.seatId = sc.desks?.[id]?.seat_id ?? null;
    if (this.gridOn(sc) && to.tile && to.xy) { // the way over free tiles (A*), never through furniture or other people
      p.tile = key === "door" || key === "doorin" ? null : to.tile; // the place is ours from now on
      const speed = 95 * jit(id, "v", 0.75, 1.3);
      const from = p.curTile ?? (p.pos ? this.xyTile(sc, p.pos) : to.tile); // (a person with no position yet starts at the goal: never a crash)
      let path = null, reached = true;
      const seatWalls = new Set();                                // every chair, an armchair (taken or free) and an empty seat: not walked across (the goal itself may be one)
      for (const [did, d] of Object.entries(sc.desks ?? {})) if (did !== id && d.seat_tile) seatWalls.add(this.tkey(d.seat_tile));
      for (const s_ of sc.spots?.lounge ?? []) if (s_ && !Array.isArray(s_) && s_.seat && s_.tile) seatWalls.add(this.tkey(s_.tile));
      for (const s_ of Object.values(sc.seats ?? {})) if (s_.tile) seatWalls.add(this.tkey(s_.tile));
      const walls = new Set([...this.takenTiles(id), ...seatWalls]); // people standing and the seats
      let start = from;
      try {
        // ★28-1: the way with every wall, then without the people, then with none; cut off from the goal: the nearest tile that connects (the person is moved there, then walks)
        const r = this.routeTo(sc, from, to.tile, walls, seatWalls);
        path = r.path; reached = r.reached;
        if (r.rescued) { start = r.rescued; p.pos = this.tileXY(sc, start); p.curTile = start; p.dur = 0; p.moveUntil = 0; if (!(this.layoutChangedAt && Date.now() - this.layoutChangedAt < 30000) && !(this.partBorn && Date.now() - this.partBorn < 60000)) p.rescues = (p.rescues ?? 0) + 1; /* ★95: the first placement of a part just born (an install's reload / a restart) is not a rescue either */ } // a rescue is a jump, not a slide
        if (r.tier > 0) { p.reroutes = (p.reroutes ?? 0) + 1; p.diag = r.rescued || !r.reached ? "no-route" : "blocked"; } // ★29-2: the reason, if this walk turns out stuck
      } catch { path = null; }
      if (!path) { reached = false; path = [start]; p.diag = "no-route"; }
      const legs = this.legsFromPath(sc, path, speed);
      if (reached) {
        if (!legs.length || Math.hypot(to.xy[0] - this.tileXY(sc, to.tile)[0], to.xy[1] - this.tileXY(sc, to.tile)[1]) > 1)
          legs.push({ tile: to.tile, xy: to.xy, depth: this.depthOfXY(sc, to.xy), ms: Math.round(Math.max(60, Math.hypot(to.xy[0] - (legs.length ? legs[legs.length - 1].xy[0] : p.pos[0]), to.xy[1] - (legs.length ? legs[legs.length - 1].xy[1] : p.pos[1])) / speed * 1000)) }); // the seat is not the tile's centre (★89: at the walking speed, not a fixed 300 ms)
        else legs[legs.length - 1].xy = to.xy;
      }
      if (!legs.length) legs.push({ tile: from, xy: p.pos, depth: this.depthOfXY(sc, p.pos), ms: 50 });
      p.pathEnd = Date.now() + (delay || 0) + legs.reduce((n, l) => n + l.ms + 40, 0) + 40;
      const run = (i, cx) => {
        if (p.tok !== tok) return;
        const L = legs[i];
        if (shared("hakoniwa.demo")) this.trace(id, p.pos, L.xy, L.ms, key);
        const dx = L.xy[0] - p.pos[0], dy = L.xy[1] - p.pos[1];
        if (Math.abs(dx) + Math.abs(dy) >= 6) { if (Math.sign(dx) !== Math.sign(p.dx ?? 0) || Math.sign(dy) !== Math.sign(p.dy ?? 0)) p.turns = (p.turns ?? 0) + 1; p.dx = dx; p.dy = dy; } // a tiny last step keeps the direction it had (★89 p.turns: corners, for live-check's pace line)
        if (i === 0) { p.goAt = Date.now(); p.legMs = legs.reduce((n, l) => n + l.ms, 0); } p.legIdx = i; p.nLegs = legs.length;
        p.depth = Math.max(L.depth, this.depthOfXY(sc, p.pos), this.depthOfXY(sc, L.xy)) + 0.01; // the front end of the leg: not hidden behind a desk on the way
        (p.legLog ??= []).push({ at: Date.now(), dur: L.ms, len: Math.hypot(dx, dy) }); if (p.legLog.length > 12) p.legBase = (p.legBase ?? 0) + p.legLog.shift().len; // (a dropped leg is finished: its length stays in the base) // ★89 the walk's own schedule (live-check's pace: the path walked, not the straight distance)
        p.legFrom = p.pos ? [p.pos[0], p.pos[1]] : null; // ★89 where this leg really starts (the live-check's position model was built from the PREVIOUS sample: two legs between two looks put it a whole leg off)
        p.moveGrace = 0; p.pos = L.xy; p.dur = L.ms; p.walking = true; p.moveUntil = Date.now() + L.ms; p.curTile = L.tile; p.facing = null; p.chg = `go:${key}`;
        cx.notify();
        cx.timer.after(i + 1 < legs.length ? L.ms + 20 : L.ms + 40, (cx) => { // ★89: the next leg follows after 20 ms (was 40: every joint was a small stop)
          if (p.tok !== tok) return;
          if (i + 1 < legs.length) return run(i + 1, cx);
          p.walking = false; p.moveUntil = 0; p.stand = key; p.depth = null; p.pathEnd = 0; p.chg = `arrive:${key}`;
          if (key === "desk" && p.prop === "coffee" && !p.onBreak) p.prop = null; // ★89 a break cut short for a talk keeps the coffee in hand: back at the seat it is put down (the red mug of the seated picture takes over); it stayed in hand for minutes (sim-probe, 60 min)
          if (!String(key).startsWith("counter")) p.starDone = false;
          p.facing = to.facing ?? null; // at a window: turn to face it
          if (key !== "door") p.doorOpen = false;
          const next = after?.(cx); // (the timer's own cx: one kept from a render may no longer run timers in the App, ★64)
          cx.notify();
          if (next) cx.timer.after(700, () => { next(); cx.notify(); });
          if (p.pend) { const q = p.pend; p.pend = null; p.pendKey = null; this.go(p, id, q.key, cx, q.delay ?? 0, q.after); } // the place that came up on the way
        });
      };
      cx.timer.after(delay || 0, (cx) => run(0, cx));
      return;
    }
    const speed = WALK_UNITS_PER_S * jit(id, "v", 0.75, 1.3);
    const way = [], room = sc.spots?.rooms?.[p.room], gate = sc.spots?.entrance;
    const kindOf = (k) => k.split(":")[0];
    if (kindOf(p.stand ?? "door") === "desk" && room) way.push(room);   // leaving its room
    if ((kindOf(p.stand ?? "door") === "door" || kindOf(key) === "door") && gate) way.push(gate); // door side
    if (kindOf(key) === "desk" && room) way.push(room);               // entering its room
    if (kindOf(p.stand ?? "door") === "desk" && kindOf(key) === "desk") way.splice(0, way.length, ...(room ? [room] : []));
    const pts = [...way, [to.x, to.y]];
    const legs = [];
    let prev = p.pos;
    for (const pt of pts) {
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) < 0.5) continue;
      legs.push({ pos: pt, ms: Math.round(Math.max(350, Math.min(6000, (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) / speed) * 1000))) });
      prev = pt;
    }
    if (!legs.length) legs.push({ pos: [to.x, to.y], ms: 350 });
    const run = (i, cx) => {
      if (p.tok !== tok) return;
      p.dx = legs[i].pos[0] - p.pos[0]; p.dy = legs[i].pos[1] - p.pos[1]; p.pos = legs[i].pos; p.dur = legs[i].ms; p.walking = true; p.chg = `go2:${key}`; p.moveUntil = Date.now() + legs[i].ms;
      cx.notify();
      cx.timer.after(legs[i].ms + 60, (cx) => {
        if (p.tok !== tok) return;
        if (i + 1 < legs.length) return run(i + 1, cx);
        p.walking = false; p.moveUntil = 0; p.stand = key; p.chg = `arrive2:${key}`;
        if (key !== "door") p.doorOpen = false; // through the door: it closes
        const next = after?.(cx); // (the timer's own cx: one kept from a render may no longer run timers in the App, ★64)
        cx.notify();
        if (next) cx.timer.after(700, () => { next(); cx.notify(); });
      });
    };
    cx.timer.after(delay || 0, (cx) => run(0, cx)); // never notify inside render
  }

  // ---------------------------------------------------------------- render
  office(list, cx) { // TEMP-DBG
    try { list = answeredView(list, shared("hakoniwa.apanswered")); } catch {} // 46th 44-L2: just answered (apanswered): the floor's tags / counts say 作業中 while hc still says blocked
    this.lastRenderAt = Date.now(); // ★88-6 (partBeat: an old part that no longer draws)
    const t0 = Date.now(), cut = globalThis.__hudPhase; // ★54 the App's script engine stops a render that runs too long (no exception to catch): the phase left behind tells where
    if (cut) {
      this.slowLog(cx, { kind: "cut", phase: cut.name, since_ms: t0 - cut.t, tags: cut.tags });
      // ★56-2 (office-perf) a stopped render showed nothing new (the App keeps the last picture): ask for one more soon, so a move never waits for a click. At most 3 in a row a second.
      const rt = this._cutRetry ??= { n: 0, at: 0 }; if (t0 - rt.at > 1000) rt.n = 0;
      if (rt.n < 3) { rt.n++; rt.at = t0; cx.timer.after(50, (c) => c.notify()); }
    }
    this._ph = []; this._cur = null; this._poseMemo = new Map(); this.ph("sync");
    try { return this.officeInner(list, cx); } catch (e) { this.dbgErr(e, "render"); throw e; } finally { this._poseMemo = null; this._unswap?.(); this._unswap = null; this.phEnd(cx, t0, list.length); }
  }

  // ★54 render phases: ph(name) closes the one before and notes the name where a stopped render leaves it (globalThis.__hudPhase); the file is written from a timer, never in render.
  ph(name) { const now = Date.now(); if (this._cur) this._ph.push([this._cur.name, now - this._cur.t]); this._cur = { name, t: now }; globalThis.__hudPhase = { name, t: now, tags: this.people?.size ?? 0 }; }
  phEnd(cx, t0, n) {
    const now = Date.now(); if (this._cur) this._ph.push([this._cur.name, now - this._cur.t]); this._cur = null; globalThis.__hudPhase = null;
    if (now - t0 > 50) this.slowLog(cx, { kind: "slow", ms: now - t0, people: n, phases: this._ph.filter((q) => q[1] > 2).map((q) => `${q[0]}:${q[1]}`).join(" ") });
  }
  slowLog(cx, rec) {
    this._slowQ ??= []; this._slowQ.push(JSON.stringify({ at: new Date().toISOString(), ...rec }));
    if (this._slowT) return;
    this._slowT = cx.timer.after(0, () => { this._slowT = null; const lines = this._slowQ.splice(0).join(String.fromCharCode(10)) + String.fromCharCode(10), f = `${appHome()}/hakoniwa-office/render-slow.jsonl`;
      readTextFile(f).then((prev) => { const keep = prev && prev.length > 150000 ? prev.slice(-80000) : (prev ?? ""); return writeTextFile(f, keep + lines, prev); }).catch(() => {}); });
  }

  officeInner(list, cx) {
    const demo = !!(shared("hakoniwa.demo") || this.feed.config?.demo);
    if (this.lastDemo !== undefined && demo !== this.lastDemo) { // another cast: place everyone again, no exits
      this.people = new Map(); this.primed = false; this.selId = null; this.panel = null; this.sceneSig = null; this.leaveTimer = null;
      this.scene = null; this.rememberedTried = false; this.sceneError = null; this.sceneFails = 0; this.waitSince = Date.now(); // the other cast has its own floor (never drawn on the other's): its last one is read from its own file (last-scene-demo.json / last-scene.json) at once, the new plan replaces it
    }
    this.lastDemo = demo;
    this.ph("load");
    this.loadRemembered(cx);
    this.loadFaces(cx);
    this.ensureScene(list, cx);
    this.drawSeq = (this.drawSeq ?? 0) + 1; // ★71-1 one number per draw: the people drawn in it are compared by the live check
    try { this.roomLife(list, cx); } catch (e) { this.dbgErr(e, "roomLife"); }
    try { this.sync(list, cx); this.checkLayout(this.scene, cx); } catch (e) { this.dbgErr(e, "sync"); } // a failure in the walk logic must not take the furniture and people down with it
    const pick = shared("hakoniwa.pick"); // from the HUD band's state counts: jump to that state's first person
    if (this.pickAt === undefined) this.pickAt = pick?.at ?? null;
    if (pick?.at && pick.at !== this.pickAt && Date.now() - pick.at < 20000) { // ★100-3 a press is fresh: an old pick must not select somebody again after an install's reload (a tag that never goes)
      this.pickAt = pick.at;
      const first = (pick.id && list.find((a) => a.id === pick.id)) || list.filter((a) => a.status === pick.state)
        .sort((a, b) => (pick.state === "done" ? b.since - a.since : a.since - b.since))[0];
      if (first) {
        this.selId = first.id;
        if (first.source === "app" && first.address && !(shared("hakoniwa.demo") || this.feed.config?.demo)) {
          openTerminalWindow(first.address, first.name || first.title || first.address);
          this.open = false; this.termPick = null;
        } else this.open = false;
        cx.timer.after(0, () => setShared("hakoniwa.sel", first.id));
      }
    }
    const closeReq = shared("hakoniwa.close");
    if (closeReq?.at && closeReq.at !== this.closeAt) { this.closeAt = closeReq.at; if (this.open) this.open = false; this.selId = null; this.termPick = null; } // ★81 closes a picked terminal too // ★100-3 and the choice (no tag left behind)
    { const lr = shared("hakoniwa.legend"); if (lr?.at && lr.at !== this.legendReqAt && Date.now() - lr.at < 15000) { this.legendReqAt = lr.at; this.legendCollapsed = !!lr.fold; this.legendUserOpen = lr.fold ? false : "review"; this.legendReviewAt = Date.now(); } } // review: "hakoniwa.legend" (main.js) folds / opens the legend (not saved to legend.json)
    { const zr = shared("hakoniwa.zoom"); if (zr?.at && zr.at !== this.zoomReqAt) { this.zoomReqAt = zr.at; this.zoomPan = { z: zr.z === "fit" ? fitZoom(this.scene, this.left?.width ?? 800, this.left?.height ?? 560) : Math.max(0.4, Math.min(4, Number(zr.z) || 1)), px: 0, py: 0 }; } } // ★62-2 review: "hakoniwa.zoom" (main.js) sets the zoom without a wheel
    this.autoFit();
    { const pr = shared("hakoniwa.panel"); if (pr?.at && pr.at !== this.panelReqAt && Date.now() - pr.at < 15000) { this.panelReqAt = pr.at; const was = !!this.panelIsOpen; this.panelIsOpen = pr.open == null ? !this.panelIsOpen : pr.open; if (was !== this.panelIsOpen && this.scene) { const W = this.left?.width ?? 800, H = this.left?.height ?? 560; this.zoomPan = sideFit(this.scene, W, H, fitZoom, this.panelIsOpen ? this.panelWidth() : 0, this.fitMargin()); } /* ★73-2, 10th fix12a: closing goes through sideFit + fitMargin too (the right window's width was not taken off) */ if (pr.row) { const ag = list.find((x) => x.source !== "tui" && (x.address === String(pr.row) || x.name === String(pr.row))); if (ag) { this.termPick = null; this.focusToPerson(ag.address, list) || (this.selId = ag.id, this.open = true); cx.timer.after(0, () => setShared("hakoniwa.sel", ag.id)); } else { this.termPick = { address: String(pr.row), name: String(pr.row) }; this.open = false; } } /* ★81 an agent row goes the same way as a press (select) */ if (pr.menu) this.panelMenuAt = String(pr.menu); if (this.panelIsOpen) cx.timer.after(0, () => this.panelPoll?.(cx)); } } // ★95-14 not from a draw: InputState.new (the search box) throws there; start the read timer in a task // ★72-3 review: "hakoniwa.panel[:open|close]" / "hakoniwa.panel-row:<t>" (room.js), no click
    const plateReq = shared("hakoniwa.plate"); // ★61-1 "hakoniwa.plate[:room]" (room.js): open a plate's menu without a click (no room: the next plate)
    if (plateReq?.at && plateReq.at !== this.plateAt && this.scene) { this.plateAt = plateReq.at; if (Date.now() - plateReq.at < 15000) this.plateOpen = plateKeyFor(this.scene?.islands ?? [], plateReq.room, this.plateOpen); }
    { const tr = shared("hakoniwa.tab"); if (tr?.at && tr.at !== this.tabAt) { this.tabAt = tr.at; if (tr.id === this.selId) this.detailTab = tr.tab; } } // ★84 a tab pressed in the window (its own instance): the window is opened again with it (syncTerm)
    { const rc = shared("hakoniwa.rcollapse"); if (rc?.at && rc.at !== this.rcAt) { this.rcAt = rc.at; this.rightCollapsed = !!rc.on; } } // ★103-4 the right window folded to / opened from the edge strip (pressed in the window's own instance; syncTerm opens it again)
    const sel = this.selected(list);
    if (this.open && !sel) this.open = false;
    const left = this.left ?? { width: 800, height: 560 };
    this.ph("term");
    const termOn = this.syncTerm(sel, list, left, cx); // an App agent: its real terminal in a window; the side panel stays shut
    this.autoFit(); // ★110 (office-fix7, gap 7): the window's width (termBox) is only known here; the fit above ran with 0 on the draw that opened it and nothing drew again, so the floor stayed 805px wide in a 745px gap. Fit again now (it does nothing when the margin did not change).
    if (this.open && !termOn) this.syncPanel(sel, list, cx);
    const shell = div().id("office-root").relative().size_full().overflow_hidden().bg("#101827")
      .on_size_change((size, cx) => { this.left = size; cx.notify(); })
      .on_mouse_down("left", (e) => { if (!this.overColumn(e.local_position, e.position)) this.dragStart(e.position.x, e.position.y); }) // (★74-2 a press over the right column / terminal never starts a drag) ★30-6 drag the floor (only on the empty floor: a pressable thing stops the press; and only after a small move)
      .on_mouse_move((e, cx) => { if (this.resize) { this.resizeMove(e.position.x, cx); return; } if (this.dragFrom && this.overColumn(e.local_position, e.position)) { this.dragFrom = null; return; } this.dragMove(e.position.x, e.position.y, cx); }) // (★74-2 the pointer went over the terminal: the drag ends, the floor never follows it)
      .on_mouse_up("left", (_e, cx) => { if (this.resize) { this.resizeEnd(cx); return; } if (this.pdrag) { this.pdrag = null; cx.notify(); } this.dragEnd(); })
      .on_scroll_wheel((e, cx) => this.wheelZoom(e.delta?.y ?? 0, e.local_position, cx, e.position))
      .on_hover((h, _cx) => { if (!h) this.dragFrom = null; }) // the pointer left the floor: a drag never goes on
      .on_click((_e, cx) => { this.dragFrom = null; if (this.dragMoved || this.justDragged()) return; if (this.open || this.termPick) this.closePanel(cx); }); // the empty floor closes the panel (★95-12: never after a drag: dragMoved stays until the next press)
    const sc = this.scene;
    if (!sc) {
      shell.child(div().absolute().left(20).top(16).text_size(12).text_color(P.muted)
        .child(planWaitText(this.sceneError, this.sceneFails ?? 0, this.waitSince ??= Date.now())));
      return shell;
    }
    this.ph("camera");
    const panelW = this.open ? Math.min(Math.round(left.width * 0.4), Math.max(280, Math.round(left.width / 3))) : 0; // as wide as the side panel
    this.panelLeft = panelW && !termOn ? left.width - panelW : null;
    const zm = this.zoomPan ?? { z: 1, px: 0, py: 0 }, k = (sc.native ? 1 : Math.min(4, (left.width - 8) / sc.width, (left.height - 8) / sc.height)) * (zm.z ?? 1); // the scale never changes when the panel opens (it overlays)
    const ox = Math.round((left.width - sc.width * k) / 2 + (zm.px ?? 0)), oy = (zm.py ?? 0) + (sc.native ? Math.round((left.height - sc.height * k) / 2) : Math.max(2, Math.round((left.height - sc.height * k) / 2)));
    // The panel only covers the right side: when the chosen person would be hidden by it, the whole office slides left (one transition of the world's `left`), and back when it closes.
    let shift = 0;
    if (panelW && sel && !this.regionShown) { /* ★103 with the right region the detail is not an overlay: nothing to slide away from */ const sp = this.people?.get(sel)?.pos; if (sp) { const px = ox + sp[0] * k, edge = left.width - panelW - 70; if (px > edge) shift = -Math.min(px - edge, Math.max(0, sc.width * k + ox - (left.width - panelW))); } }
    const root = div().id("world").absolute().left(shift).top(0).w(left.width).h(left.height).transition("left", { duration: 260, easing: "ease-out" });
    this.viewBox = { ox, oy, k };
    { const sig = `${k.toFixed(4)}|${ox}|${oy}`; this.camMoving = this.camSig !== undefined && this.camSig !== sig; this.camSig = sig; }
    // ★41 the camera moves, a walker stays on the floor: a walk is a native transition to a screen point, so when the camera changes mid-walk the person is drawn at where it is on
    // the floor now (no slide), and the next draw sends it on to the end of its leg with only the time that is left. Positions on the floor are never touched (restored below).
    const swapped = []; this.legs ??= new Map();
    { const t0 = Date.now(); for (const [id, p] of this.people ?? []) {
        if (!p.pos) continue;
        let rec = this.legs.get(id);
        if (!rec || rec.target !== p.pos) { const from = rec ? this.legNow(rec, t0) : p.pos; rec = { target: p.pos, from, at: t0, dur: Math.max(1, p.dur ?? 0) }; if (Date.now() < (p.moveUntil ?? 0)) rec.at = Math.max(rec.at - 0, (p.moveUntil ?? t0) - rec.dur); this.legs.set(id, rec); }
        if (this.camMoving && t0 < (p.moveUntil ?? 0) && p.dur > 0) { swapped.push([p, p.pos, p.dur]); p.restartFor = rec.target; p.restartDur = Math.max(0, p.moveUntil - t0); p.pos = this.legNow(rec, t0); p.dur = 0; }
      } }
    if (swapped.length) cx.timer.after(70, (c) => c.notify());
    const unswap = () => { for (const [p, pos, dur] of swapped) { p.pos = pos; p.dur = dur; } swapped.length = 0; }; this._unswap = unswap;
    const byId = new Map(list.map((a) => [a.id, a]));
    let seatPidM = null; const seatPid = () => { if (!seatPidM) { seatPidM = new Map(); for (const [q] of this.people ?? []) { const s0 = sc.desks?.[q]?.seat_id; if (s0 != null && !seatPidM.has(s0)) seatPidM.set(s0, q); } } return seatPidM; }; // ★56-2 (office-perf) seat -> its person, once a draw (was a search of everybody per seat)
    const G = this.gridOn(sc), layers = []; // grid scene: background, then everything sorted by depth (back to front)
    if (this.curFile !== sc.file) {
      const same = sc.scene_id && this.curFloor?.scene_id === sc.scene_id; // the same plan under a new file name: nothing to bridge
      this.prevFloor = same ? null : this.curFloor; this.curFile = sc.file; this.curFloor = sc;
      if (this.prevFloor) { this.prevUntil = Date.now() + 2500; cx.timer.after(2600, (cx) => { this.prevFloor = null; cx.notify(); }); }
    }
    const tiled = !!sc.background_tiles?.length; // the floor comes as small tiles named by their content: the App keeps every image it loads, so no whole-floor picture (and none of the previous plan's) is loaded
    const pf = tiled ? null : this.prevFloor; // the previous building stays underneath only for the first seconds, until the new image has loaded
    if (pf && pf.file !== sc.file && Date.now() < (this.prevUntil ?? 0)) root.child(image(pf.file).absolute().left((left.width - pf.width * k) / 2).top(oy).w(pf.width * k).h(pf.height * k));
    this.ph("background");
    const period = this.periodNow(), wx = this.weatherNow();
    if (tiled) {
      for (const t of sc.background_tiles) { const { clip, img } = bleedBox(ox, oy, k, t, 1), el = image(t.file).absolute().left(img[0]).top(img[1]).w(img[2]).h(img[3]); root.child(clip ? div().absolute().left(clip[0]).top(clip[1]).w(clip[2]).h(clip[3]).overflow_hidden().child(el) : el); } // ★62-2 whole pixels, 1 px over the next tile (a seam on a half pixel let the dark under-colour through as a grey line)
      const bands = sc.outside_bands; // scenery strips (one per side, today's period), then the bird, then the wall frames with clear glass
      if (bands) for (const [side, per] of Object.entries(bands)) { const b0 = per?.[period]; if (b0?.file) root.child(image(b0.file).id(`band-${side}`).absolute().left(ox + b0.rect[0] * k).top(oy + b0.rect[1] * k).w(b0.rect[2] * k).h(b0.rect[3] * k)); }
      if (bands && sc.weather_overlays && wx.kind !== "clear") { // the weather over the scenery (cut to the glass by office.py): layers, and 3 frames for rain / snow
        for (const [side, byKind] of Object.entries(sc.weather_overlays)) for (const [n, e] of (byKind?.[wx.kind] ?? []).entries()) {
          if (e.frame != null && e.frame !== (this.wxTick ?? 0) % 3) continue;
          root.child(image(e.file).id(`wx-${side}-${n}`).absolute().left(ox + e.rect[0] * k).top(oy + e.rect[1] * k).w(e.rect[2] * k).h(e.rect[3] * k));
        }
      }
      if (bands && sc.night_sky && moonShown(period, wx.kind)) { // one moon (its phase from the date) and twinkling stars, in the upper part of the glass only
        const ns = sc.night_sky, ph = ns.moon_phase != null ? { step: ns.moon_phase, age: ns.moon_age } : this.moonPhase(), hrN = this.hourNow() + new Date().getMinutes() / 60, t = Math.max(0, Math.min(1, (((hrN - 19) + 24) % 24) / 10)); // 19:00 .. 05:00
        for (const [n, r] of (starsShown(period, wx.kind) ? (ns.star_rects ?? []) : []).entries()) {
          const [rx, ry, rw, rh] = r, pics = this.starPics(n, rw, rh, (ns.star_rects ?? []).length, cx); // 3 pictures per glass (one per twinkle speed), not ~35 dots
          for (const [gi, pic] of pics.entries()) root.child(svg(pic.file).id(`stars-${n}-${gi}`).absolute().left(ox + rx * k).top(oy + ry * k).w(rw * k).h(rh * k).text_color("#fff7d6").loop("opacity", pic.lp));
        }
        const mp = [...(ns.moon_path ?? [])].sort((m, n) => Math.hypot(n.to[0] - n.from[0], n.to[1] - n.from[1]) - Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]))[0]; // one moon in all: on the wall with the longest path
        if (mp) {
          const clip = mp.clip, x = mp.from[0] + (mp.to[0] - mp.from[0]) * t, y = mp.from[1] + (mp.to[1] - mp.from[1]) * t, ms0 = (this.life?.moon_size ?? 22) * k;
          const mf = (this.life?.moon_phases ?? this.life?.moon ?? [])[ph.step], mfile = typeof mf === "string" ? mf : mf?.file;
          const disc = mfile ? image(mfile).absolute() : div().absolute().rounded(999).bg("#f4efd0");
          const moon = disc.id("moon").left((clip ? x - clip[0] : x) * k - ms0 / 2).top((clip ? y - clip[1] : y) * k - ms0 / 2).w(ms0).h(ms0).transition("left", { duration: 3000, easing: "linear" }).transition("top", { duration: 3000, easing: "linear" });
          root.child(clip ? div().id("moon-clip").absolute().left(ox + clip[0] * k).top(oy + clip[1] * k).w(clip[2] * k).h(clip[3] * k).overflow_hidden().child(moon) : moon.left(ox + x * k - ms0 / 2).top(oy + y * k - ms0 / 2));
        }
      }
      if (bands && !["rain", "snow", "thunder"].includes(wx.kind)) { const bird = this.birdNow(sc, ox, oy, k); for (const e of [].concat(bird ?? [])) root.child(e); }
      if (bands && sc.wall_pieces) for (const [n, wp] of sc.wall_pieces.entries()) { const f = wp.file ?? this.life?.wall_frames?.[String(wp.part ?? wp.side).endsWith("right") ? "right" : "left"]?.file; if (f) root.child(image(f).id(`wall-${n}`).absolute().left(ox + wp.rect[0] * k).top(oy + wp.rect[1] * k).w(wp.rect[2] * k).h(wp.rect[3] * k)); }
      if (sc.board?.file && sc.board.rect) root.child(image(sc.board.file).id("board-face").absolute().left(ox + sc.board.rect[0] * k).top(oy + sc.board.rect[1] * k).w(sc.board.rect[2] * k).h(sc.board.rect[3] * k)); // the wall's own picture (frame, dark face), drawn after the wall pieces; the lit dots go over it
      if (sc.board) { // the wall board
        // ★54 the board's ~1000 LED dots are one picture (an svg written from a timer when the dots change): a render that builds a thousand elements runs past the App's time limit
        this.lastList = list; if (!this.boardTimer) { this.boardTimer = cx.timer.every(1000, (c) => this.boardBeat(c)); cx.timer.after(0, (c) => this.boardBeat(c)); }
        const bsv = this.boardPic;
        if (bsv?.tiles) { for (const t of bsv.tiles) root.child(svg(t.file).absolute().left(ox + t.x * k).top(oy + t.y * k).w(t.w * k).h(t.h * k).text_color(t.color)); for (const e of boardElements(sc.board, bsv.blink, ox, oy, k)) root.child(e); }
      }
      for (const [n, w] of (bands ? [] : (sc.outside ?? [])).entries()) { // the view out of the window: one of 4 times of day x 2 sides, the same pictures for every window
        const side = w.part ? (String(w.part).endsWith("right") ? "right" : "left") : (w.side === "x" ? "right" : "left"), fm = this.life?.outside_masked?.[period]?.[side], pr = w.piece_rect;
        if (fm && pr) { root.child(image(fm).id(`out-${n}`).absolute().left(ox + pr[0] * k).top(oy + pr[1] * k).w(pr[2] * k).h(pr[3] * k)); continue; } // cut to the glass; laid on the window part's own place
        const f = this.life?.outside?.[period]?.[side];
        if (f && w.rect) root.child(image(f).id(`out-${n}`).absolute().left(ox + (w.rect[0] + w.rect[2] * 0.2) * k).top(oy + (w.rect[1] + w.rect[3] * 0.3) * k).w(w.rect[2] * 0.6 * k).h(w.rect[3] * 0.45 * k));
      }
      for (const [n, r] of (sc.rugs ?? []).entries()) root.child(image(r.file).id(`rug-${r.kind}-${r.key}-${n}`).absolute().left(ox + r.rect[0] * k).top(oy + r.rect[1] * k).w(r.rect[2] * k).h(r.rect[3] * k)); // rugs: above the floor, under the objects
    } else root.child(image(G && sc.background ? sc.background : sc.file).absolute().left(ox).top(oy).w(sc.width * k).h(sc.height * k));
    // New pictures load lazily: for the first seconds of a floor plan the baked floor (furniture included) lies under the
    // separate objects, so a plan never shows as an empty floor. It is then taken away (the objects cover the same places).
    if (!tiled && G && sc.background && sc.file && sc.file !== sc.background) {
      const sid = sc.scene_id ?? sc.file;
      if (this.bakedFor !== sid) { this.bakedFor = sid; this.bakedUntil = Date.now() + 3500; cx.timer.after(3600, (cx) => cx.notify()); }
      if (Date.now() < this.bakedUntil) root.child(image(sc.file).absolute().left(ox).top(oy).w(sc.width * k).h(sc.height * k));
    }
    if (G) {
      const at = (r) => [ox + r[0] * k, oy + r[1] * k, r[2] * k, r[3] * k];
      const pic = (file, r, id) => { const [x, y, w, h] = at(r); return image(file).id(id).absolute().left(x).top(y).w(w).h(h); };
      const seatedId = (id) => { const a = byId.get(id), p = this.people?.get(id); return a?.status === "working" && p && !p.walking && String(p.at) === "desk"; };
      const hiddenChairs = new Set(Object.entries(sc.seats ? {} : (sc.desks ?? {})).filter(([id, d]) => d.chair && seatedId(id)).map(([, d]) => d.chair)); // the seated picture brings the chair
      const sitting = new Set(); // armchair:<x>-<y> objects: the sitting picture brings its own armchair
      for (const [pid, p] of this.people ?? []) if (String(p.at).startsWith("lounge:") && !p.walking && p.curTile) for (const kind of ["armchair", "sofa", "chair"]) sitting.add(`${kind}:${p.curTile[0]}-${p.curTile[1]}`); // ★26-2: the sitting picture has its own chair: an old placed chair is never drawn twice (the new plan places none)
      for (const o of sc.objects) if (/server|rack/i.test(String(o.kind ?? "") + String(o.id)) && o.rect) { // a server rack: two tiny lights blink (a div, no picture; opacity loop)
        const [rx, ry, rw, rh] = o.rect, dep = (o.depth ?? 0) + 0.02;
        (Array.isArray(o.leds) && o.leds.length ? o.leds.map((q, i) => [["#3ddc84", "#ffb020"][i % 2], (q[0] - rx) / (rw || 1), (q[1] - ry) / (rh || 1), 900 + 200 * (i % 3)]) // the light dots are scene pixels (B's points moved into the scene by A)
          : [["#3ddc84", 0.3, 0.32, 900], ["#ffb020", 0.46, 0.4, 1300], ["#3ddc84", 0.3, 0.5, 1100]]).forEach(([col, fx, fy, per], i) =>
          layers.push({ depth: dep, order: 2, el: div().id(`led-${o.id}-${i}`).absolute().left(ox + (rx + rw * fx) * k).top(oy + (ry + rh * fy) * k).w(Math.max(2, 3 * k)).h(Math.max(2, 3 * k)).rounded(2).bg(col).loop("opacity", { from: 0.25, to: 1, period: per }) }));
      }
      const packed = (sc.island_doors ?? []).filter((d) => d.pack);
      const doorKeys = packed.map((d) => `doorway:${d.between[0]}|${d.between[1]}`);
      for (const d of packed) { // a double door between two islands: it opens while somebody is in or next to its opening
        const oc = d.open_cells ?? [d.cell], near = [...(this.people ?? [])].map(([, p]) => p.curTile).filter(Boolean);
        const inside = near.some((t) => oc.some((c) => c[0] === t[0] && c[1] === t[1])), beside = near.some((t) => oc.some((c) => Math.abs(c[0] - t[0]) <= 1 && Math.abs(c[1] - t[1]) <= 1));
        const state = inside ? "open" : beside ? "half" : "closed", lf = d.pack.leaf?.[state] ?? d.pack.leaf?.closed, fm = d.pack.frame;
        const dmin = Math.min(...oc.map((c) => c[0] + c[1])), dmax = Math.max(...oc.map((c) => c[0] + c[1])), nm = `${d.between[0]}|${d.between[1]}`;
        for (const part of [fm, lf]) if (part?.back && part?.front) {
          layers.push({ depth: dmin - 0.5, order: 0, el: pic(part.back.file, part.back.rect, `dback-${nm}-${part === fm ? "f" : "l"}`) });
          layers.push({ depth: dmax + 1.5, order: 0, el: pic(part.front.file, part.front.rect, `dfront-${nm}-${part === fm ? "f" : "l"}`) });
        }
      }
      this.ph("objects");
      if (this._objFor !== sc.objects || this._objDoors !== sc.island_doors) { this._objFor = sc.objects; this._objDoors = sc.island_doors; this._objList = sc.objects.filter((o) => !doorKeys.some((k0) => String(o.id).startsWith(k0))).map((o) => [o, String(o.id).split(":").slice(0, 2).join(":"), `obj-${o.id}`, o.depth ?? 0]); this._drawList = objectDrawList(this._objList, sc.object_bands); } // ★56-2 (office-perf) the furniture that never changes is sorted out once per plan
      const chk = hiddenChairs.size > 0 || sitting.size > 0;
      const one = ([o, sk, eid, dep]) => { if (!chk || (!hiddenChairs.has(o.id) && !sitting.has(sk))) { const r = o.rect; layers.push({ depth: dep, order: 0, el: image(o.file).id(eid).absolute().left(ox + r[0] * k).top(oy + r[1] * k).w(r[2] * k).h(r[3] * k) }); } };
      for (const d of this._drawList) { // ★56-2 (office-perf2) a band: the furniture of one depth baked into one picture (python); one of its things hidden -> its things one by one
        if (!d.band) { one(d.one); continue; }
        if (chk && d.members.some(([o, sk]) => hiddenChairs.has(o.id) || sitting.has(sk))) { d.members.forEach(one); continue; }
        const q = snapBox(ox, oy, k, d.band.rect, 0); layers.push({ depth: d.band.depth, order: 0, el: image(d.band.file).id(d.eid).absolute().left(q[0]).top(q[1]).w(q[2]).h(q[3]) }); // ★62-2 whole pixels: bands that touch (one desk row cut into pieces) meet on the same pixel at every zoom
      }
      const queued = (kind) => [...(this.people ?? [])].some(([id, p]) => String(p.at).startsWith(`${kind}:`) && byId.has(id));
      for (const [kind, w] of Object.entries(sc.l86 ? {} : (sc.windows ?? {}))) { // ★86: no approval desk / counter
        const stf = w.staff, stp = stf ? this.staffPicture(kind, sc, stf) : null; // ★26-4 the clerk behind the desk: the desk without its chair, the clerk (chair and all) behind the desk's picture
        const img = stp ? (queued(kind) ? (stf.full ?? stf.empty) : (stf.empty ?? stf.full)) : (queued(kind) ? (w.full ?? w.empty) : (w.empty ?? w.full));
        if (stp) layers.push({ depth: (w.depth ?? 0) - 0.01, order: 0, el: image(stp.file).id(`clerk-${kind}`).absolute().left(ox + stf.xy[0] * k - stp.w * k / 2).top(oy + stf.xy[1] * k - stp.h * k).w(stp.w * k).h(stp.h * k) });
        if (img && w.rect) layers.push({ depth: w.depth ?? 0, order: 0, el: pic(img, w.rect, `window-${kind}`) });
        if (kind === "approval" && w.alert?.file && queued("approval"))
          layers.push({ depth: (w.depth ?? 0) + 0.02, order: 1, el: pic(w.alert.file, w.alert.rect, "window-alert").loop("opacity", { from: 0.3, to: 1, period: 800 }) });
      }
      const dr = sc.door;
      if (dr?.rect) {
        const ds = this.doorState(), img = ds === "closed" ? dr.closed : ds === "open" ? dr.open : (dr.half ?? dr.open);
        const st0 = img === dr.open ? "open" : img === dr.half ? "half" : "closed", bk = dr.back?.[st0], fr = dr.front?.[st0];
        if (bk && fr) { // the two halves of the picture (cut at the opening): the people walk between them
          const oc = dr.open_cells ?? [dr.tile], dmin = Math.min(...oc.map((c) => c[0] + c[1])), dmax = Math.max(...oc.map((c) => c[0] + c[1]));
          layers.push({ depth: dmin - 0.5, order: 0, el: pic(bk, dr.rect, "door-back") });
          layers.push({ depth: dmax + 1.5, order: 0, el: pic(fr, dr.rect, "door-front") });
        } else if (img) layers.push({ depth: dr.depth ?? 0, order: 0, el: pic(img, dr.rect, "door") });
      }
      if (sc.seats && this.deskProps && this.lifeParts) { // desk things by the owner's state (a stage = one fixed picture: nothing is made at run time)
        const par = this.lifeParts, rr = (sc.seats ? Object.values(sc.seats).find((q) => q.laptop?.rects?.on)?.laptop.rects.on[2] : 0) / (par.laptop_on?.w || 160) || 0.26, now0 = Date.now();
        const owner = new Map(); for (const [pid, p] of this.people ?? []) { const d = sc.desks?.[pid]; if (d?.seat_id && !p.leaving) owner.set(d.seat_id, [pid, p]); }
        for (const [sid, s_] of Object.entries(sc.seats)) {
          const o = owner.get(sid), pr = s_.props; if (!o || !pr) continue;
          const a = byId.get(o[0]); if (!a) continue;
          if (a.status === "idle") { // ★95 a waiting person has the RED mug standing on the desk (not in the hand): the mark of waiting; no papers / other drinks (★50-7b)
            const mp = o[1], at0 = pr.drink?.at;
            if (at0 && !mp.walking && String(mp.at) === "desk" && !mp.meet && mp.pos && Math.hypot(mp.pos[0] - s_.xy[0], mp.pos[1] - s_.xy[1]) < 8) {
              const mh0 = s_.laptop?.screen?.rect?.[3] ?? (s_.laptop?.rects?.on?.[3] ?? s_.laptop?.rect?.[3] ?? 0) * 0.62, mch = Math.max(6, (mh0 > 0 ? mh0 * 0.34 : 9) * k), mcw = mch * 0.9;
              layers.push({ depth: pr.drink?.depth ?? 6, order: 1, el: div().id(`mug-${o[0]}`).absolute().left(ox + at0[0] * k - mcw / 2).top(oy + at0[1] * k - mch).w(mcw).h(mch).rounded(Math.max(1.5, mcw * 0.18)).bg("#d62828").border(1).border_color("#8f1414")
                .child(div().absolute().left(mcw * 0.14).top(mch * 0.12).w(Math.max(1, mcw * 0.18)).h(mch * 0.5).rounded(2).bg("#ff8a8a"))
                .child(div().id(`mug-h-${o[0]}`).absolute().left(mcw - 1).top(mch * 0.22).w(Math.max(2, mcw * 0.32)).h(mch * 0.5).rounded(mch).border(Math.max(1.2, mcw * 0.14)).border_color("#d62828")) });
            }
            continue;
          }
          const gb = a.mem_bytes != null ? a.mem_bytes / 1073741824 : null, wk = a.working_since ? (now0 - a.working_since) / 60000 : 0;
          const monH = s_.laptop?.screen?.rect?.[3] ?? (s_.laptop?.rects?.on?.[3] ?? s_.laptop?.rect?.[3] ?? 0) * 0.62; // ★ a drink on the desk (can / mug / cup) is at most half the monitor's height
          const put = (name, at, depth, key0) => { const q = par[name]; if (q?.file && at) { const f = key0 === "d" && monH > 0 ? Math.min(1, (monH * 0.5) / (q.h * rr)) : 1, fx = (q.foot?.[0] ?? q.w / 2) * rr * f, fy = (q.foot?.[1] ?? q.h) * rr * f; layers.push({ depth, order: 1, el: image(q.file).id(`dp-${sid}-${key0}`).absolute().left(ox + (at[0] - fx) * k).top(oy + (at[1] - fy) * k).w(q.w * rr * f * k).h(q.h * rr * f * k) }); } };
          const dks = this.deskProps.drinks.filter((n) => n !== "desk_mug"); // ★ the red mug is the mark of waiting (idle) only: a working desk never shows it
          const ds = deskStage(gb, wk, dks.length), stage = ds.papers; // memory in 0.5 GB steps: more mess
          if (stage > 0) put(this.deskProps.papers[stage - 1], pr.papers?.at, pr.papers?.depth ?? 6, "p");
          const drinks = dks, di = ds.drink; // the longer the work, the more cans
          if (di >= 0) put(drinks[di], pr.drink?.at, pr.drink?.depth ?? 6, "d");
        }
        this.markRatio = rr;
      }
      if (sc.seats) {
        const owners = new Map();
        for (const [pid, p] of this.people ?? []) { const d = sc.desks?.[pid]; if (d?.seat_id) owners.set(d.seat_id, [pid, p]); }
        for (const [sid, s_] of Object.entries(sc.seats)) { // the PC on a seat follows its owner's state (no new picture: the three PNGs are fixed)
          const o = owners.get(sid), L = s_.laptop;
          if (!o || !L) continue;
          const [pid, p] = o, a = byId.get(pid);
          if (!a || p.leaving) continue;
          const here = String(p.at) === "desk" && !p.walking && p.pos && Math.hypot(p.pos[0] - s_.xy[0], p.pos[1] - s_.xy[1]) < 8, ld = L.depth ?? s_.depth ?? 0;
          if (a.status === "working") {
            if (!here) continue;
            if (L.on) layers.push({ depth: ld, order: 0, el: pic(L.on, L.rects?.on ?? L.rect, `laptop-${sid}`) });
            if (L.screen?.rect) layers.push({ depth: ld + 0.01, order: 1, el: this.faceStrip(`${sid}`, L.screen.rect, L.screen.faces?.[hash(sid) % Math.max(1, L.screen.faces?.length ?? 1)], ox, oy, k, L.screen.loop_h) });
          } else if (a.status === "done" && here && replyWaiting(this.reps?.get(pid), a, true)) { // ★29-1 back from the counter, waiting for a reply: the PC stays open (its screen still)
            if (L.on) layers.push({ depth: ld, order: 0, el: pic(L.on, L.rects?.on ?? L.rect, `laptop-${sid}`) });
          } else if (a.status === "blocked" || a.status === "done") { // away at a window: the PC stays open, its screen stopped and dark
            if (L.off) layers.push({ depth: ld, order: 0, el: pic(L.off, L.rects?.off ?? L.rect, `laptop-${sid}`) });
            const ec = this.life?.empty_chair?.file, ps = sc.pose_size?.type_pc ?? sc.pose_size?.stand; // the chair stays, empty (same canvas and foot as the typing picture); ★ not drawn while its owner stands at the seat (a standing person on top of the chair looked like standing in it); otherwise never in front of the owner
            const nearOwner = !!p.pos && Math.hypot(p.pos[0] - s_.xy[0], p.pos[1] - s_.xy[1]) < 60; // (the owner far away at a window: the chair keeps its own depth, it must not sink behind the desks with the owner's)
            if (ec && ps && !here) layers.push({ depth: nearOwner ? Math.min(s_.depth ?? ld, ((p.depth ?? this.depthOfXY(sc, p.pos ?? s_.xy)) ?? Infinity) - 0.01, (seatedDepth(s_, sc.desks?.[pid], sc.objects, pid) ?? Infinity) - 0.01) : (s_.depth ?? ld), order: -1, el: image(ec).id(`echair-${sid}`).absolute().left(ox + s_.xy[0] * k - ps.w * k / 2).top(oy + s_.xy[1] * k - ps.h * k).w(ps.w * k).h(ps.h * k) });
          } // ★30-8 idle: the PC is put away (nothing on the desk, no empty chair); the person waits in the lounge
        }
      }
      for (const [id, d] of Object.entries(sc.seats ? {} : (sc.desks ?? {}))) { // the screen's code scrolls (a GIF) while the person works at the desk
        if (!d.screen?.file || !seatedId(id)) continue;
        const dds = sc.objects.filter((o) => String(o.id).startsWith(`desk:${id}`)).map((o) => o.depth ?? 0); // a desk is cut into slices: the screen goes over the last one
        const dd = dds.length ? Math.max(...dds) : this.depthOfXY(sc, d.seat);
        const faces = this.faces ?? [], r = d.screen.rect;
        if (faces.length) // the code scrolls up inside each monitor face (a native loop: no re-render)
          faces.forEach((f, n) => layers.push({ depth: dd + 0.01, order: 1, el: this.codeStrip(`${id}-${n}`, [r[0] + f[0] * r[2], r[1] + f[1] * r[3], f[2] * r[2], f[3] * r[3]], ox, oy, k) }));
        else layers.push({ depth: dd + 0.01, order: 1, el: pic(d.screen.file, r, `screen-${id}`) });
      }
    } else {
    // The windows (approval desk / counter, seen from inside): papers while someone queues; the lamp blinks only for approvals.
    const wd = sc.l86 ? null : sc.windows; // ★86
    if (wd) {
      const queued = (kind) => [...(this.people ?? [])].some(([id, p]) => String(p.at).startsWith(`${kind}:`) && byId.has(id));
      for (const [kind, w] of Object.entries(wd)) {
        const img = queued(kind) ? (w.full ?? w.empty) : (w.empty ?? w.full);
        if (img && w.rect) root.child(image(img).id(`window-${kind}`).absolute().left(ox + w.rect[0] * k).top(oy + w.rect[1] * k).w(w.rect[2] * k).h(w.rect[3] * k));
        if (kind === "approval" && w.alert?.file && queued("approval"))
          root.child(image(w.alert.file).id("window-alert").absolute().left(ox + w.alert.rect[0] * k).top(oy + w.alert.rect[1] * k)
            .w(w.alert.rect[2] * k).h(w.alert.rect[3] * k).loop("opacity", { from: 0.3, to: 1, period: 800 }));
      }
    }
    // The door: open only while someone is coming in or going out.
    const dr = sc.door;
    if (dr?.rect) {
      // half open before the person moves, fully open while they pass, closed again after
      const ds = this.doorState(), img = ds === "closed" ? dr.closed : ds === "open" ? dr.open : (dr.half ?? dr.open);
      if (img) root.child(image(img).absolute().left(ox + dr.rect[0] * k).top(oy + dr.rect[1] * k).w(dr.rect[2] * k).h(dr.rect[3] * k));
    }
    // The desk's own chair: the floor draws none (a seated person brings it); it is laid over the desk while nobody sits there.
    for (const [id, d] of Object.entries(sc.seats ? {} : (sc.desks ?? {}))) {
      const a = byId.get(id), p = this.people?.get(id);
      const seated = a?.status === "working" && p && !p.walking && !p.riding && String(p.at) === "desk";
      if (d.chair?.file && !seated) root.child(image(d.chair.file).id(`chair-${id}`).absolute().left(ox + d.chair.rect[0] * k).top(oy + d.chair.rect[1] * k).w(d.chair.rect[2] * k).h(d.chair.rect[3] * k));
    }
    for (const [id, d] of Object.entries(sc.desks ?? {})) {
      const a = byId.get(id), p = this.people?.get(id);
      if (a?.status === "blocked" && d.alert) // warning light on the desk of someone waiting for approval
        for (const [n, f] of [].concat(d.alert).entries()) root.child(image(f.file).id(`alert-${id}-${n}`).absolute().left(ox + f.rect[0] * k).top(oy + f.rect[1] * k).w(f.rect[2] * k).h(f.rect[3] * k)
          .loop("opacity", { from: 0.35, to: 1, period: 800 }));
      if (a?.status === "working" && p && !p.walking) {
        if (d.screen_on?.length) this.screenOn(id, d.screen_on, ox, oy, k).forEach((e) => root.child(e));
        else (d.screens ?? (d.screen ? [d.screen] : [])).forEach((r, n) => root.child(this.screen(`${id}-${n}`, r, ox, oy, k)));
      }
    }
    }
    // Team colours: a leader and the people under them share one mark.
    const tkey = (a) => a.source === "tui" ? ((a.name ?? "").includes("-") ? "tui:" + a.name.split("-")[0] : null)
      : (a.parent_id && byId.has(a.parent_id) ? a.parent_id : leaders.has(a.id) ? a.id : null);
    const leaders = new Set(list.map((a) => a.parent_id).filter(Boolean));
    const sizes = new Map();
    for (const a of list) { const k = tkey(a); if (k) sizes.set(k, (sizes.get(k) ?? 0) + 1); }
    const team = (a) => { const t = tkey(a); return t && sizes.get(t) > 1 ? TEAM[hash(t) % TEAM.length] : null; };
    // front rows last (drawn on top)
    const shown = [...(this.people ?? [])].map(([id, p]) => ({ id, p, a: byId.get(id) ?? p.last, pos: p.pos }))
      .filter((x) => x.a && x.pos).sort((m, n) => m.pos[1] - n.pos[1]); // new arrivals use a stand-in until the next plan contains their own pack
    const put = (x, order, el) => { // ★45 seated: the head and body in front of the same seat's things; on the move: the walk's own depth
      const sid = sc.desks?.[x.id]?.seat_id, seated = String(x.p.at) === "desk" && !x.p.walking && sc.desks?.[x.id]?.seat_depth != null;
      const depth = x.p.depth ?? (seated ? seatedDepth(sc.seats?.[sid], sc.desks?.[x.id], sc.objects, x.id) : this.depthOfXY(sc, x.pos));
      return G ? layers.push({ depth, order, el }) : root.child(el);
    };
    const famIds = new Set(); { const sa0 = byId.get(sel); if (sa0) for (const x of list) if (x.id === sa0.parent_id || x.parent_id === sa0.id) famIds.add(x.id); } // the chosen one's parent and children: a pale same-colour rim
    // ★92 the one circle under a person (the chosen one's purple ring and a leader's gold ring are the same size and the same centre): a true circle on the screen, about as wide as the
    // shoulders (the two feet are 0.34 of the picture's width), centred on the middle of the feet / the base of the chair (a seated person: under the seat, not on the floor in front of it)
    const ringAt = (x) => {
      const pz = this.poseFiles(this.personFilesFor(x.id, sc), x.a, x.p), psz = sc.pose_size?.[pz.key] ?? sc.pose_size?.stand ?? sc.sprite ?? { w: 12, h: 20 }, name = String(pz.pic ?? pz.key);
      const d = Math.max(18, ((sc.pose_size?.stand?.w ?? sc.sprite?.w ?? 12) * k) * 0.42);
      return { d, cx: ox + x.pos[0] * k + ((FEET_CX[name] ?? 0.5) - 0.5) * psz.w * k, cy: oy + x.pos[1] * k - (/pc|sofa|doze|raise/.test(name) ? 0.07 : 0.025) * psz.h * k };
    };
    for (const x of shown) if (x.id === sel) { // a soft ring on the floor under the chosen person
      const g = ringAt(x), rw = g.d, rh = g.d, dur = this.transMs(x.p);
      put(x, 1, div().id("sel-ring").absolute().left(g.cx - rw / 2).top(g.cy - rh / 2).w(rw).h(rh).rounded(rw)
        .border(2.5).border_color("#7465dbdd").bg("#7465db22")
        .transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" }));
    }
    for (const x of shown) if (x.id !== sel && commanderInfo(x.a, list).commander) { // ★72-2 a parent: a thin gold ring at the feet (not red: that is waiting / an error)
      const g = ringAt(x), rw = g.d, rh = g.d, dur = this.transMs(x.p);
      put(x, 1, div().id(`lead-ring-${x.id}`).absolute().left(g.cx - rw / 2).top(g.cy - rh / 2).w(rw).h(rh).rounded(rw).border(2.5).border_color("#e0a90fdd")
        .transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" }));
    }
    const sh_ = sc.sprite?.shadow;
    if (sh_?.file) for (const x of shown) { // the picture's own shadow is gone: a dark soft ellipse at the feet
      const dur = this.transMs(x.p), w = (sh_.w ?? 45) * k, h = (sh_.h ?? 15) * k;
      put(x, 1.5, div().id(`shadow-${x.id}`).absolute().left(ox + x.pos[0] * k - (sh_.foot?.[0] ?? w / 2 / k) * k).top(oy + x.pos[1] * k - (sh_.foot?.[1] ?? h / 2 / k) * k).w(w).h(h)
        .transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" })
        .child(image(sh_.file).size_full()));
    }
    for (const x of shown) put(x, 2, this.person(x, sc, ox, oy, k));
    this._warmN ??= new Map(); const warmSeen = new Set();
    for (const x of shown) if (this.moving(x.p)) { // the walking pictures of a walker are decoded before they are needed (1 px, invisible): no blank frame
      const files = this.personFilesFor(x.id, sc);
      for (const [set, wf] of [["six", files.walk_frames], ["eight", files.walk8_frames]]) {
        if (wf) for (const [d_, fr] of Object.entries(wf)) this.poseFrames(fr).forEach((f, n) => { // ★89 a picture is asked to be decoded in the first WARM_RENDERS draws only (14-30 extra images per walker every draw were a big part of the 50 ms budget; the host keeps the decoded picture)
          const c = this._warmN.get(f) ?? 0, again = warmSeen.has(f); if (again ? c > WARM_RENDERS : c >= WARM_RENDERS) return; if (!again) { warmSeen.add(f); this._warmN.set(f, c + 1); } // (counted once per draw, however many people share the picture)
          root.child(image(f).id(`warm-${x.id}-${set}-${d_}-${n}`).absolute().left(0).top(0).w(1).h(1).opacity(0.01));
        });
      }
    }
    const standW = (sc.pose_size?.stand?.w ?? 40) * k, standH = (sc.pose_size?.stand?.h ?? 90) * k;
    if (this._plantFor !== sc.objects) { this._plantFor = sc.objects; this._plants = (sc.objects ?? []).filter((o) => o.kind === "plant"); } // ★56-2 (office-perf) once per plan
    const plantRects = this._plants.map((o) => ({ x: ox + o.rect[0] * k, y: oy + o.rect[1] * k, w: o.rect[2] * k, h: o.rect[3] * k }));
    const labels = this.labelRects(sc, byId, ox, oy, k, plantRects.concat(shown.map((x) => ({ x: ox + x.pos[0] * k - standW / 2, y: oy + x.pos[1] * k - standH - 30, w: standW, h: standH + 34 })))); // (the 30 px above a head: the tag)
    if (G) { // back to front; at the same depth the things first, then the people
      layers.sort((m, n) => (m.depth - n.depth) || (m.order - n.order));
      for (const l of layers) root.child(l.el);
      if (shared("hakoniwa.grid") === true && sc.debug_overlay) root.child(image(sc.debug_overlay).absolute().left(ox).top(oy).w(sc.width * k).h(sc.height * k).opacity(0.7));
    }
    if (G) { // time of day: a translucent colour over everything (a rectangle, not a picture); night lamps over the islands that have someone working
      const tone = period === "evening" ? "#ff8a3d14" : null; // evening: a warm tint only; night: none (see shade_tiles at 0.1)
      if (Date.now() < (this.flashUntil ?? 0)) root.child(div().id("flash").absolute().left(0).top(0).size_full().bg("#ffffff66")); // a flash of lightning
      const night = period === "night";
      const glow = this.lifeParts?.glow_ceiling?.file, lampG = this.lifeParts?.glow_lamp?.file;
      const dark = { morning: 0, day: 0, evening: 0.04, night: 0.1 }[period] ?? 0; // the room stays almost as bright as by day (the lights are on); only the view out of the window goes dark
      if (sc.shade_tiles?.length) { // the shadow comes as small pictures (one set, made by office.py); only their opacity changes with the hour
        if (dark > 0) for (const [n, t] of sc.shade_tiles.entries()) { const { clip, img } = bleedBox(ox, oy, k, t, 0), el = image(t.file).absolute().left(img[0]).top(img[1]).w(img[2]).h(img[3]); root.child(clip ? div().id(`shade-${n}`).absolute().left(clip[0]).top(clip[1]).w(clip[2]).h(clip[3]).overflow_hidden().child(el.opacity(dark)) : el.id(`shade-${n}`).opacity(dark)); } // ★62-2 whole pixels, edge to edge (a see-through shade must not overlap itself)
      } else if (tone && sc.grid) { // (older plans) the veil covers only the floor and its walls (a hexagon cut into thin strips); the beige ground outside stays as it is
        const g = sc.grid, step = 14, H = 62;
        if (this.veilFor !== sc.scene_id || this.veilK !== k) { // x-extent of the floor (and the walls above its back edges) per horizontal strip, from the floor map
          this.veilFor = sc.scene_id; this.veilK = k;
          const rows = new Map(), put = (y, x0, x1) => { const r = Math.floor(y / step), e = rows.get(r); if (!e) rows.set(r, [x0, x1]); else { e[0] = Math.min(e[0], x0); e[1] = Math.max(e[1], x1); } };
          for (let gy = 0; gy < g.rows; gy++) for (let gx = 0; gx < g.cols; gx++) {
            if (g.floor?.[gy]?.[gx] !== "1") continue;
            const q = this.tileXY(sc, [gx, gy]), hw = g.tw / 2;
            put(q[1] - g.th / 2, q[0] - hw, q[0] + hw); put(q[1] + g.th / 2, q[0] - hw, q[0] + hw); put(q[1], q[0] - hw, q[0] + hw);
            if (gx === 0 || gy === 0) for (let u = step; u <= H; u += step) put(q[1] - u, q[0] - hw, q[0] + hw); // the wall above a back edge
          }
          this.veilRows = [...rows.entries()];
        }
        for (const [r, [x0, x1]] of this.veilRows ?? []) root.child(div().id(`veil-${r}`).absolute().left(ox + x0 * k).top(oy + r * step * k).w((x1 - x0) * k).h(step * k + 1).bg(tone));
      } else if (tone) root.child(div().id("tod-veil").absolute().left(0).top(0).size_full().bg(tone));
      if (night) { // lit over the dark: ceiling lights above islands where somebody works, a desk lamp glow at each working seat
        for (const [n, l] of (sc.lights ?? []).entries()) {
          const isl = (sc.islands ?? []).find((q) => q.key === l.island);
          const kind = l.kind ?? (isl ? null : l.island);
          if (!isl && /lamp|floor/i.test(String(kind ?? ""))) { // a floor lamp: lit all night, whoever is there
            if (glow) root.child(image(glow).id(`glow-${n}`).absolute().left(ox + (l.at[0] - l.size[0] / 2) * k).top(oy + (l.at[1] - l.size[1] / 2) * k).w(l.size[0] * k).h(l.size[1] * k).opacity(0.55));
            continue;
          }
          if (!isl && kind && [...(this.people ?? [])].some(([, p]) => String(p.at).startsWith(`${kind}:`))) { // approval desk / counter / lounge: lit while somebody is there
            if (glow) root.child(image(glow).id(`glow-${n}`).absolute().left(ox + (l.at[0] - l.size[0] / 2) * k).top(oy + (l.at[1] - l.size[1] / 2) * k).w(l.size[0] * k).h(l.size[1] * k).opacity(0.55));
            continue;
          }
          const working = isl && (isl.seats ?? []).some((sid) => { const pid = seatPid().get(sid); return pid && byId.get(pid)?.status === "working"; });
          if (working && glow) root.child(image(glow).id(`glow-${n}`).absolute().left(ox + (l.at[0] - l.size[0] / 2) * k).top(oy + (l.at[1] - l.size[1] / 2) * k).w(l.size[0] * k).h(l.size[1] * k).opacity(0.55));
        }
        if (lampG) for (const [sid, s_] of Object.entries(sc.seats ?? {})) {
          const pid = seatPid().get(sid);
          if (!pid || byId.get(pid)?.status !== "working" || !s_.laptop) continue;
          const r = s_.laptop.rects?.on ?? s_.laptop.rect, W = 120 * k, Hh = 92 * k;
          root.child(image(lampG).id(`lamp-${sid}`).absolute().left(ox + (r[0] + r[2] / 2) * k - W / 2).top(oy + (r[1] + r[3] / 2) * k - Hh / 2).w(W).h(Hh));
        }
      }
      for (const l of labels) root.child(l.el); // floor names are drawn over the shadow so they stay readable
      // ★75-1 no nap badge over the head
      const bird = sc.outside_bands ? null : this.birdNow(sc, ox, oy, k);
      for (const e of [].concat(bird ?? [])) root.child(e);
    }
    for (const [n, f] of (G ? [] : (sc.foreground ?? [])).entries()) // low glass walls in front of the people
      root.child(image(f.file).absolute().left(ox + f.rect[0] * k).top(oy + f.rect[1] * k).w(f.rect[2] * k).h(f.rect[3] * k));
    // Tags: an anchor element sits on the person's head and moves with the person (the same transition); the tag and its
    // line are children of it. Moving tags keep a fixed head-relative offset; only stationary tags may move up to avoid
    // another tag, a floor name or another person's picture (with a thin line down to the person).
    this.ph("labels");
    const placed = labels.map((l) => l.r), anchors = [], rects = new Map();
    const bodyOf = (x) => {
      const f = this.personFilesFor(x.id, sc), kk = this.poseFiles(f, x.a, x.p).key;
      const ps = sc.pose_size?.[kk] ?? sc.pose_size?.stand ?? sc.sprite ?? { w: 40, h: 90 };
      return { x: ox + x.pos[0] * k - ps.w * k / 2, y: oy + x.pos[1] * k - ps.h * k, w: ps.w * k, h: ps.h * k, h0: ps.h * k };
    };
    const bodies = new Map(shown.map((x) => [x.id, bodyOf(x)]));
    // 13th D8 (office-fix16c): the space above another person's head where the state disc (blocked "!" hops up) is drawn; a tag never sits on it (the disc / head covered the tag's words)
    const heads = new Map();
    for (const x of shown) {
      if (x.p.leaving) continue;
      const dd = Math.max(9, 10 * k), R = x.a.status === "blocked" ? dd * 1.35 : x.a.status === "done" ? dd * 0.95 : x.a.status === "working" ? dd / 2 : 0;
      if (!R) continue;
      const hop = x.a.status === "blocked" ? Math.max(11, dd * 1.4) : x.a.status === "done" ? dd * 0.4 : 0, hxx = ox + x.pos[0] * k, hyy = oy + x.pos[1] * k - bodies.get(x.id).h0 * this.headFrac(x.id, x.a, x.p, sc);
      heads.set(x.id, { x: hxx - R - 2, y: hyy - 2 * R - 4 - hop - 2, w: 2 * R + 4, h: 2 * R + 6 + hop });
    }
    const hit_ = (r, own) => placed.find((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)
      ?? (() => { for (const [bid, q] of bodies) if (bid !== own && r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h) return q; return undefined; })() // ★56-2 (office-perf) no arrays per try
      ?? (() => { for (const [bid, q] of heads) if (bid !== own && r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h) return q; return undefined; })();
    const blockedN = shown.filter((x) => x.a.status === "blocked" && !x.p.leaving).length, crowd = !!sc.tags_short || blockedN > 2; // many waiting (or a small floor): small marks, the big bubble opens on pointing
    const isBig = () => false; // no big bubbles any more: approvals are one card at the approval desk (below)
    const nAll = list.length, tier = tierFor(nAll) /* the number of agents, not of people still being drawn */; // up to 15: a small tag each; 16-30: only the waiting / reporting / chosen get a tag, the rest a colour dot; 31+: plates carry the numbers, a few tags, the lounge only a name
    let denseTags = 0;
    const noGo = []; // ★50-2 the words no tag sits on: the board, and the two white signs of the windows
    if (sc.board?.rect) noGo.push({ x: ox + sc.board.rect[0] * k, y: oy + sc.board.rect[1] * k, w: sc.board.rect[2] * k, h: sc.board.rect[3] * k });
    for (const [kd, lb] of [["approval", "승인 데스크"], ["counter", "제출 창구"]]) { const w1 = sc.windows?.[kd], sa1 = w1?.sign_at; if (!sa1) continue; const z1 = w1.sign_size ?? [Math.max(72, 14 + lb.length * 12), 22], sw1 = z1[0] * (w1.sign_file ? k : 1), sh1 = z1[1] * (w1.sign_file ? k : 1); noGo.push({ x: ox + sa1[0] * k - sw1 / 2 - 2, y: oy + sa1[1] * k - sh1 / 2 - 2, w: sw1 + 4, h: sh1 + 4 }); }
    const onNoGo = (q) => noGo.some((b) => q.x < b.x + b.w && b.x < q.x + q.w && q.y < b.y + b.h && b.y < q.y + q.h);
    const smallA = [], bigA = [], bigRects = [], talkA = [], talkRects = []; // ★76 talkA: the "…" bubbles, the front layer
    const waiters = shown.filter((x) => String(x.p.at).startsWith("wait:") && !x.p.walking && !x.p.leaving), crowdWait = waiters.length > 3 ? new Set(waiters.map((x) => x.id)) : new Set();
    this.ph("tags");
    for (const { id, p, a, pos } of [...shown].filter((x) => !crowdWait.has(x.id)).reverse().sort((x, y) => (isBig(y) ? 1 : 0) - (isBig(x) ? 1 : 0))) { // a large bubble first: its place is kept, the small tags give way
      const st = stateOf(a), body = bodies.get(id), sh = body.h0;
      { const thx = ox + pos[0] * k, thy = oy + pos[1] * k - sh * this.headFrac(id, a, p, sc), td = Math.max(9, 10 * k), tk = this.meetBubble?.(id, p);
        let tdx = 0; // ★101-7 the bubble stays right over the speaker's head (nothing else moves it); only two bubbles that would overlap step a little apart
        if (tk) { const ov = (r, q) => Math.max(0, Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x)) * Math.max(0, Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y));
          const w0 = tk.mine ? 40 : 28, base = this.talkBox(tk, thx, thy, td, a.status, 0);
          if (talkRects.some((q) => ov(base, q) > 0)) {
            let best = Infinity;
            for (const c of [-(w0 / 2 + 6), w0 / 2 + 6, -(w0 + 10), w0 + 10]) { const n = talkRects.reduce((s, q) => s + ov(this.talkBox(tk, thx, thy, td, a.status, c), q), 0); if (n < best) { best = n; tdx = c; if (n === 0) break; } }
          }
          talkRects.push(this.talkBox(tk, thx, thy, td, a.status, tdx)); }
        const tb = this.talkBubble(id, p, thx, thy, td, a.status, tdx); if (tb) talkA.push({ k: id, el: tb }); } // ★76
      const big = isBig({ a, p, id }); // only waiting-for-approval gets the large bubble (and not in a crowd)
      const detail = sel === a.id || this.hoverId === a.id, short = !detail;
      const needsTag = !p.leaving;
      if (!needsTag || (!detail && tier === "dense" && (a.status === "blocked" || a.status === "done") && ++denseTags > 6)) { // a colour dot over the head (no tag)
        const hx0 = ox + pos[0] * k, hy0 = oy + pos[1] * k - sh * this.headFrac(id, a, p, sc), d0 = Math.max(9, 10 * k), dur0 = this.transMs(p); // ★51-3 right over the head, whatever the pose
        rects.set(id, { x: hx0 - 8, y: hy0 - 16, w: 16, h: 16 });
        { const mk0 = this.headMark(a, list, st, d0); if (mk0) smallA.push({ k: id, el: div().id(`tag-${id}`).absolute().left(hx0).top(hy0).w(0).h(0).transition("left", { duration: dur0, easing: "linear" }).transition("top", { duration: dur0, easing: "linear" }).child(mk0) }); }
        continue;
      } // a small tag (a colour dot + a short name) for everybody; the full one only for the chosen / pointed-at person
      let sname = (st.key === "working" || st.key === "shell") ? activityLabel(a) : st.label;
      const text = (str) => [...str].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 13.7 : 7.7), 0); // generous: a tag is never narrower than its words
      const askLines = big ? Math.ceil([...String(blockedText(a)).split("\n")[0]].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1.7 : 1), 0) / 19) : 0;
      let w = big ? 214 : Math.round(36 + text(sname));
      const h = big ? 46 + 14 * Math.max(1, askLines) : 27;
      const hx = ox + pos[0] * k, hy = oy + pos[1] * k - sh;
      const hh = detail && !big ? h + 4 : h; // ★88-6 the box that is really drawn (a hovered / chosen tag is 4 px taller than the one the places were checked with: two of them overlapped)
      let r = { x: hx - w / 2, y: hy - h - 3, w, h: hh }; // (the top stays where it was: the tests and the eye know it; only the box that the overlap checks use is the real one)
      let near = nearbyTag(r, left.width - panelW, left.height, (q) => !!hit_(q, id) || onNoGo(q));
      if (!near && !big) {
        sname = ({ blocked: "승인", working: "작업", done: "보고", idle: "대기", shell: "셸 대기" })[st.key] ?? st.label;
        w = Math.round(36 + text(sname));
        near = nearbyTag({ ...r, x: hx - w / 2, w }, left.width - panelW, left.height, (q) => !!hit_(q, id) || onNoGo(q));
      }
      if (!near) {
        const d = Math.max(9, 10 * k), dur = this.transMs(p), headY = oy + pos[1] * k - sh * this.headFrac(id, a, p, sc);
        rects.set(id, { x: hx - 8, y: headY - 16, w: 16, h: 16 });
        const mark = this.stateMark(st, 16).absolute().left(-8).top(-20);
        smallA.push({ k: id, el: div().id(`tag-${id}`).absolute().left(hx).top(headY).w(0).h(0).transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" }).child(mark) });
        continue;
      }
      r = near;
      if (!detail && a.status !== "blocked" && a.status !== "done" && a.status !== "working" && noGo.length) { // keep the current activity visible while working
        if (onNoGo(r)) {
          const d1 = Math.max(9, 10 * k), dur1 = this.transMs(p), hyD = oy + pos[1] * k - sh * this.headFrac(id, a, p, sc); rects.set(id, { x: hx - 8, y: hyD - 16, w: 16, h: 16 });
          { const mk1 = this.headMark(a, list, st, d1); if (mk1) smallA.push({ k: id, el: div().id(`tag-${id}`).absolute().left(hx).top(hyD).w(0).h(0).transition("left", { duration: dur1, easing: "linear" }).transition("top", { duration: dur1, easing: "linear" }).child(mk1) }); }
          continue;
        }
      }
      placed.push(r);
      if (big) bigRects.push(r);
      const dur = this.transMs(p), op = p.fade ? 0 : 1; // a long wait is told by colour and mark, not by fading
      const line = hy - (r.y + hh) > 4 ? div().absolute().left(-0.5).top(r.y + hh - hy).w(1).h(hy - (r.y + hh)).bg(st.color + "55") : null;
      rects.set(id, r);
      const tag = this.bubble(a, st, w, detail ? h + 4 : h, !big, sel === a.id, team(a), sname, famIds.has(a.id), commanderInfo(a, list).commander).absolute().left(r.x - hx).top(r.y - hy)
        .cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).on_click((_e, cx) => { if (!this.justDragged()) this.select(a, cx); }).on_hover((h2, cx) => this.hoverOver(a.id, h2, cx));
      (big ? bigA : smallA).push({ k: id, el: div().id(`tag-${id}`).absolute().left(hx).top(hy).w(0).h(0)
        .transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" })
        .transition("opacity", { duration: 600, easing: "ease-in" }).opacity(op)
        .when(!!line, (e) => e.child(line)).child(tag) });
    }
    const byKey = (m, n) => (m.k < n.k ? -1 : 1);
    if (crowdWait.size) { const dr0 = sc.door?.rect, f = waiters[0], la = sc.door?.label_at, hx = la ? ox + la[0] * k : dr0 ? ox + (dr0[0] + dr0[2] / 2) * k : ox + f.pos[0] * k, hy = la ? oy + la[1] * k - 10 : dr0 ? oy + dr0[1] * k - 26 : oy + f.pos[1] * k - 100 * k; /* label_at: the floor in front of the door, under the waiting crowd */ smallA.push({ k: "~wait", el: div().id("tag-wait").absolute().left(hx - 50).top(hy).px(8).py(3).rounded(10).bg("#1b2637f2").border(1.5).border_color("#8a94a6").whitespace_nowrap().text_size(11).font_weight(700).text_color("#e7edf6").child(`입구 ${crowdWait.size}명`) }); }
    root.children([...smallA.sort(byKey).map((x) => x.el), ...bigA.sort(byKey).map((x) => x.el), ...talkA.sort(byKey).map((x) => x.el)]); // large bubbles are drawn over the small tags
    let cardRect = null; // where the approval card ended up (the sign gives way to it)
    { // ONE card for the approvals: the first request, a blue approve button, "N more" for the rest. Clicking the name opens the detail on the right.
      const waiting = list.filter((x) => x.status === "blocked").sort((m, n) => (m.since ?? 0) - (n.since ?? 0));
      const win = sc.windows?.approval, at = win?.card_at ?? (win?.rect ? [win.rect[0] + win.rect[2] / 2, win.rect[1] - 6] : null);
      if (waiting.length && at) {
        const a0 = waiting[0], go0 = a0.source === "app" ? (_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: a0.address }); } : (_e, cx) => this.select(a0, cx);
        // The card goes right above the approval desk: its tail (from the card's bottom centre to the desk's top edge) is at most 60 px. It may lie over the island floor, partitions and the outer wall,
        // but never over people, desks, the queue, tags or plates, and never outside the little world. If the full card does not fit, the small one (120 x 40) is used.
        const T = win.card_tail ? [ox + win.card_tail[0] * k, oy + win.card_tail[1] * k] : (win.rect ? [ox + (win.rect[0] + win.rect[2] / 2) * k, oy + win.rect[1] * k] : [ox + at[0] * k, oy + at[1] * k + 2]);
        const obst = [...placed, ...(sc.islands ?? []).filter((q) => q.plate?.at).map((q) => ({ x: ox + q.plate.at[0] * k - (q.plate.size?.[0] ?? 150) / 2, y: oy + q.plate.at[1] * k - (q.plate.size?.[1] ?? 18) / 2, w: q.plate.size?.[0] ?? 150, h: q.plate.size?.[1] ?? 18 })), ...[...bodies.values()].map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h }))];
        if (win.rect) obst.push({ x: ox + win.rect[0] * k, y: oy + win.rect[1] * k, w: win.rect[2] * k, h: win.rect[3] * k }); // the approval desk itself
        if (sc.board?.rect) obst.push({ x: ox + sc.board.rect[0] * k, y: oy + sc.board.rect[1] * k, w: sc.board.rect[2] * k, h: sc.board.rect[3] * k }); // ★26-3: the desks now stand in front of the board: no tag or card covers its letters
        for (const [kd, lb] of [["approval", "승인 데스크"], ["counter", "제출 창구"]]) { const w1 = sc.windows?.[kd], sa1 = w1?.sign_at; if (!sa1) continue; const z1 = w1.sign_size ?? [Math.max(72, 14 + lb.length * 12), 22], f1 = w1.sign_file ? k : 1; obst.push({ x: ox + sa1[0] * k - z1[0] * f1 / 2 - 2, y: oy + sa1[1] * k - z1[1] * f1 / 2 - 2, w: z1[0] * f1 + 4, h: z1[1] * f1 + 4 }); } // the white signs are obstacles for the card
        if (crowdWait.size) { const dr0 = sc.door?.rect, f = waiters[0], la = sc.door?.label_at; if (la) obst.push({ x: ox + la[0] * k - 54, y: oy + la[1] * k - 14, w: 108, h: 28 }); else obst.push(dr0 ? { x: ox + (dr0[0] + dr0[2] / 2) * k - 54, y: oy + dr0[1] * k - 30, w: 108, h: 30 } : { x: ox + f.pos[0] * k - 50, y: oy + f.pos[1] * k - 100 * k, w: 100, h: 24 }); }
        let nearO = obst; const hits = (r) => nearO.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h); // (nearO: set below to the obstacles that can touch any place tried)
        const inWorld = (r) => r.x >= 4 && r.x + r.w <= left.width - panelW - 4 && r.y >= 4 && r.y + r.h <= left.height - 4 && this.inBox(sc, (r.x - ox) / k, (r.y - oy) / k, r.w / k, r.h / k);
        let med = false, small = false, cw = 128, chh = 58, cl = null, ct = 0; // always try the full card (heading + request line + button) first; the small one only when the full one does not fit (card_small from the scene is a hint, not a decision)
        const cs = Array.isArray(win?.card_size) && win.card_size[0] > 90 ? win.card_size : [128, 58], cands = [[Math.round(cs[0]), Math.round(cs[1])], [128, 32]]; // about 6/10 of the first size: the large card (heading + request line + button) first, then the one-row small card
        { const W = Math.max(128, ...cands.map((c) => c[0])), H = Math.max(32, ...cands.map((c) => c[1])), x0 = T[0] - 60 - W / 2, x1 = T[0] + 60 + W / 2, y0 = T[1] - 60 - H, y1 = T[1]; // ★56-2 (office-perf) every place tried lies in this box (tail <= 60 px): an obstacle outside it touches none of them
          nearO = obst.filter((q) => q.x < x1 && x0 < q.x + q.w && q.y < y1 && y0 < q.y + q.h); }
        const cardKey = `${sc.scene_id}|${T}|${JSON.stringify(cands)}|${left.width},${left.height},${panelW}|${ox},${oy},${k}|${nearO.map((q) => `${q.x},${q.y},${q.w},${q.h}`).join(";")}`; // ★56-2 (office-perf) the same obstacles and the same world: the same place as last draw
        const hitC = this._cardMemo?.key === cardKey ? this._cardMemo.v : null;
        if (hitC) ({ small, cw, chh, cl, ct } = hitC); else {
        for (const [w0, h0] of cands) {
          const sm = h0 < 40; let best = null;
          for (const [dx, dy, len] of cardOffsets(true)) { // the bottom centre is dy px above the tail's end (0..60), sideways by dx; nearest first, so the first free place is the best (★56-2 office-perf: no 600 tries a draw)
            const r = { x: T[0] + dx - w0 / 2, y: T[1] - dy - h0, w: w0, h: h0 };
            if (inWorld(r) && !hits(r)) { best = { r, len }; break; }
          }
          if (best) { small = sm; cw = w0; chh = h0; med = false; cl = best.r.x; ct = best.r.y + 14; break; }
        }
        if (cl == null) { // nothing is free: the small card where it covers the least (people and signs count most), still inside the little world, tail <= 60 px
          small = true; cw = 128; chh = 32; let bestA = null;
          for (const [dx, dy, len] of cardOffsets(false)) {
            const r = { x: T[0] + dx - cw / 2, y: T[1] - dy - chh, w: cw, h: chh }; if (!inWorld(r)) continue;
            const area = nearO.reduce((n, q) => n + Math.max(0, Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x)) * Math.max(0, Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y)), 0);
            if (!bestA || area < bestA.area || (area === bestA.area && len < bestA.len)) bestA = { r, area, len };
          }
          if (bestA) { cl = bestA.r.x; ct = bestA.r.y + 14; } else { cl = Math.max(4, Math.min(left.width - panelW - cw - 4, T[0] - cw / 2)); ct = Math.max(4, T[1] - chh - 4) + 14; }
        }
        this._cardMemo = { key: cardKey, v: { small, cw, chh, cl, ct } }; }
        cardRect = { x: cl, y: ct - 14, w: cw, h: chh };
        if (small) root.child(h_flex().id("approval-card").absolute().left(cl).top(ct - 14).w(cw).h(chh).px(6).gap(5).items_center().rounded(8).bg("#1b2637").border(1.5).border_color(STATE.blocked.color)
          .child(this.stateMark(STATE.blocked, 14)).child(div().flex_1().min_w(0).truncate().text_size(11).font_weight(800).text_color(P.ink).child(`승인 대기${waiting.length}`))
          .child(div().id("approval-ok").flex_none().px(8).py(2).rounded(7).bg("#1e6fe0").text_size(11).font_weight(700).text_color("#ffffff").cursor_pointer().on_click(go0).child("승인")));
        else root.child(v_flex().id("approval-card").absolute().left(cl).top(ct - 14).w(cw).items_center().child(v_flex().w(cw).h(chh).px(6).py(4).gap(2).rounded(8).bg("#1b2637").border(1.5).border_color(STATE.blocked.color)
          .child(h_flex().gap(6).items_center().child(this.stateMark(STATE.blocked, 14))
            .child(div().id("approval-name").flex_1().min_w(0).truncate().text_size(11).font_weight(800).text_color(P.ink).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.select(a0, cx); }).child(`승인 대기 ${waiting.length}건`)))
          .child(h_flex().gap(6).items_center().child(div().flex_none().text_size(12).text_color(P.muted).child("▤"))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(P.ink).child((() => { const t0 = String(blockedText(a0)).split("\n")[0] || this.shortName(a0); return med && [...t0].length > 14 ? [...t0].slice(0, 13).join("") + "…" : t0; })())))
          .child(h_flex().gap(8).items_center()
            .child(div().id("approval-ok").flex_none().px(12).py(2).rounded(7).bg("#1e6fe0").text_size(11).font_weight(700).text_color("#ffffff").cursor_pointer().on_click(go0).child("승인"))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(P.muted).child(this.shortName(a0)))))
          );  // (the tail is drawn below: a thin line and ▼ down to the desk top)
        { const bx0 = cl + cw / 2, by0 = ct - 14 + chh; if (T[1] - by0 > 2) root.child(div().id("approval-tail-line").absolute().left(bx0 - 0.75).top(by0).w(1.5).h(T[1] - by0 - 8).bg(STATE.blocked.color)); root.child(div().id("approval-tail").absolute().left(bx0 - 6).top(Math.max(by0, T[1] - 14)).text_size(11).text_color(STATE.blocked.color).child("▼")); } // the tail: at most 60 px, pointing at the desk
      }
    }
    this.ph("signs");
    for (const [kind, label] of [["approval", "승인 데스크"], ["counter", "제출 창구"]]) { // the white standing signs (T3's picture when A gives sign_file + sign_size, else a white rounded plate), with the words on top (11 px and up)
      const w0 = sc.windows?.[kind], sa = w0?.sign_at; if (!sa) continue;
      const sz = w0.sign_size ?? [Math.max(72, 14 + label.length * 12), 22], sw = sz[0] * (w0.sign_file ? k : 1), sh = sz[1] * (w0.sign_file ? k : 1);
      let sx = ox + sa[0] * k - sw / 2, sy = oy + sa[1] * k - sh / 2; // the sign gives way to the card: sideways, or down, to the nearest place that is clear of it and of the people
      const clashL = [cardRect, ...bodies.values()]; const clash = (x, y) => clashL.some((q) => q && x < q.x + q.w && q.x < x + sw && y < q.y + q.h && q.y < y + sh); // (the list once, not per try)
      if (kind === "approval" && cardRect && clash(sx, sy)) {
        const cand = [[cardRect.x + cardRect.w + 4, sy], [cardRect.x - sw - 4, sy], [sx, cardRect.y + cardRect.h + 2], [sx, sy + 22], [sx + sw + 4, sy + 22], [sx - sw - 4, sy + 22], [sx, sy + 40]];
        const hit = cand.find(([x, y]) => !clash(x, y) && x >= 4 && x + sw <= left.width - panelW - 4 && y >= 4 && y + sh <= left.height - 4);
        if (hit) [sx, sy] = hit;
      }
      const el = div().id(`${kind}-sign`).absolute().left(sx).top(sy).w(sw).h(sh).flex().items_center().justify_center().whitespace_nowrap().text_size(11).font_weight(800).text_color(P.ink)
        .when(!w0.sign_file, (e) => e.rounded(6).bg("#1b2637").border(1).border_color("#3b4b60")).when(!!w0.sign_file, (e) => e.child(image(w0.sign_file).absolute().left(0).top(0).w(sw).h(sh)));
      root.child(el.child(div().relative().child(label)));
    }
    // island plates: a mark + the island's name + "3人・承認1" on the island's front edge (A's islands[].plate)
    for (const isl of sc.islands ?? []) if (isl.plate?.at) {
      const mine = (isl.seats ?? []).map((sid) => seatPid().get(sid)).filter(Boolean), wt = mine.filter((pid) => byId.get(pid)?.status === "blocked").length;
            if (this.plateOpen === isl.key) root.child(v_flex().id(`plist-${isl.key}`).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).absolute().left(ox + isl.plate.at[0] * k - 90).top(oy + isl.plate.at[1] * k + 16).w(180).p(6).gap(2).rounded(8).bg(P.paper).border(1).border_color("#3b4b60")
        .when(true, (el) => { const rm = this.roomMenu?.(isl, mine.map((pid) => byId.get(pid)).filter(Boolean)); return rm ? el.child(rm) : el; }) // ★61-1 the room's operations (room.js)
        .children(mine.slice(0, 12).map((pid) => { const q = byId.get(pid); return q ? h_flex().id(`pl-${pid}`).gap(5).items_center().px(4).py(2).rounded(5).cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).hover((e) => e.bg("#2b3b50")).on_click((_e, cx) => { this.plateOpen = null; this.select(q, cx); }).child(dot(stateOf(q).color, 7)).child(div().flex_1().min_w(0).truncate().text_size(10).text_color(P.ink).child(this.shortName(q))) : div(); })));
      const srcCol = isl.source === "t3" ? "#7c4dff" : isl.source === "tui" ? "#27ae60" : "#2f80ed"; // the island's name: small grey words on the floor at the island's front edge (no board); a small orange mark only when somebody waits for approval
      const txt = `${isl.plate.arrow ? `${isl.plate.arrow} ` : ""}${clipName(isl.title, 12)}  ${mine.length ? `${mine.length}명` : "비어 있음"}`, pw = Math.min(210, 24 + [...txt].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 13 : 7.8), 0) + (wt > 0 ? 36 : 0)); // 2nd-105 N4: cut at 12 em (was 14) and a wider box so the end is "…", never a bare "_" // 12 px words (★100-4: no ＋ any more)
      root.child(h_flex().id(`plate-${isl.key}`).cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).on_click((_e, cx) => { cx.stop_propagation(); this.plateOpen = this.plateOpen === isl.key ? null : isl.key; cx.notify(); })
        .absolute().left(ox + isl.plate.at[0] * k - pw / 2).top(oy + isl.plate.at[1] * k - 10).w(pw).h(20).gap(5).items_center().justify_center().rounded(6).bg("#1b2637e8").border(1).border_color("#d9d2c3").whitespace_nowrap()
        .child(dot(srcCol, 6)) // self-review-0505 #3: 11 px light grey on a see-through grey read poorly on the floor: 12 px dark words on a near-white card
        .child(div().min_w(0).truncate().text_size(12).font_weight(700).text_color("#cad5e4").child(txt))
        .when(wt > 0, (e) => e.child(h_flex().flex_none().gap(3).px(5).items_center().rounded(8).bg("#fde7cf").child(dot(STATE.blocked.color, 6)).child(div().text_size(11).font_weight(700).text_color(STATE.blocked.color).child(`${wt}`)))));
    }
    const hov = this.hoverId && byId.get(this.hoverId), hr = hov && rects.get(this.hoverId);
    if (hov && hr && !(this.open && this.selId === hov.id)) root.child(this.hoverCard(hov, hr, left));
    // Walking is six pictures stepped at 8 fps by a timer, only while somebody walks (and config office.walk_frames is not false).
    // Everything else moves natively (loops / transitions) and needs no re-render.
    if (sc.seats && !this.readTimer) this.readTimer = cx.timer.every(1500, (cx) => { // every 10-20 s a typist leans back to read for a few seconds (per person)
      let ch = false; const now = Date.now();
      for (const [id, p] of this.people ?? []) {
        if (String(p.at) !== "desk" || p.walking) { if (p.reading) { p.reading = false; ch = true; } continue; }
        p.readNext ??= now + 10000 + (hash(id) % 10000);
        if (now < p.readNext) continue;
        p.reading = !p.reading; p.readNext = now + (p.reading ? 3000 : 10000 + (hash(id + now) % 10000)); ch = true;
      }
      if (ch) cx.notify();
    });
    if (sc.seats && !this.codeTimer) this.codeTimer = cx.timer.every(2500, (cx) => { // one cycle: reset to the top (1 ms), then run up for 2.4 s; two redraws per 2.5 s
      if (!(Date.now() - (this._faceSeen ?? 0) < 5000)) return; // ★56-2 (office-perf) only while a screen picture is drawn (no faces in the plan: the code lines loop natively, no redraw)
      this.codeRun = false; cx.notify();
      cx.timer.after(80, (cx) => { this.codeRun = true; cx.notify(); });
    });
    if (G && !this.wxTimer) this.wxTimer = cx.timer.every(300, (cx) => { // only while the weather has frames to step (rain / snow), and for the lightning flash
      const k0 = this.weatherNow().kind, now = Date.now();
      if (k0 === "thunder") { this.flashAt ??= now + 60000 + Math.random() * 120000; if (now >= this.flashAt) { this.flashUntil = now + 200; this.flashAt = now + 90000 + Math.random() * 180000; cx.notify(); cx.timer.after(260, (cx) => cx.notify()); } }
      if (k0 === "rain" || k0 === "snow" || k0 === "thunder") { this.wxTick = ((this.wxTick ?? 0) + 1) % 3; if (!this.needTick) cx.notify(); } // (the walk's redraw shows the next frame too)
      else if (this.wxTick) { this.wxTick = 0; cx.notify(); }
    });
    if (G && !this.hourTimer) this.hourTimer = cx.timer.every(1500, (cx) => { const h = this.hourNow(); if (h !== this.lastHour) { this.lastHour = h; cx.notify(); } }); // the hour was set (review) or the clock moved on
    // ★56-2 (office-perf) a render never runs while a timer does: a phase left behind here means the App stopped the last render (its picture never showed). Draw again
    // now, without waiting for another reason to redraw (a click opening the detail was what "woke" a stopped person before). The next render logs the cut and clears it.
    if (!this.cutTimer) this.cutTimer = cx.timer.every(250, (cx) => { if (globalThis.__hudPhase) cx.notify(); });
    if (G && !this.stuckTimer) this.stuckTimer = cx.timer.every(1000, (cx) => { try { this.watchStuck(cx); } catch (e) { this.dbgErr?.(e, "stuck"); } }); // ★28-1: nobody stays stuck for more than 3 s
    if (G && !this.liveTimer) this.liveTimer = cx.timer.every(2000, (cx) => { try { this.liveCheck(cx); this.liveNull = 0; } catch (e) { try { this.dbgErr?.(e, "live"); } catch {} if (e == null && (this.liveNull = (this.liveNull ?? 0) + 1) >= 3) { this.liveNull = 0; this.stopTimers(); } } }); // ★95: three `null`s in a row (a part whose host went away in a reload) end every timer of this part; a live part makes them at its next render. ★64: the App counts its own oddities (live-check.jsonl)
    if (G && !this.birdTimer) this.birdTimer = cx.timer.every(5000, (cx) => {
      const now = Date.now();
      const f = shared("hakoniwa.bird"); if (f && f !== this.birdSeen) { this.birdSeen = f; this.birdAt = 0; } // review: fly one now
      this.birdAt ??= now + 20000 + Math.random() * 100000;
      if (this.bird || now < this.birdAt || ["rain", "snow", "thunder"].includes(this.weatherNow().kind)) return;
      const n = 3 + Math.floor(Math.random() * 4); // a flock of 3-6
      this.bird = { dir: Math.random() < 0.5, go: false, pick: Math.floor(Math.random() * 8), n, goSet: {} };
      this.bird.flock = flockBirds(this.scene?.bird_paths, this.bird.pick, n);
      cx.notify();
      cx.timer.after(150, (cx) => { if (this.bird) { this.bird.go = true; if (!this.bird.flock.length) this.bird.goSet[0] = true; cx.notify(); } });
      for (const fb of this.bird.flock) cx.timer.after(150 + fb.lag, (cx) => { if (this.bird) { this.bird.goSet[fb.i] = true; cx.notify(); } }); // one after the other, a little apart
      const span = 9400 + Math.max(0, ...this.bird.flock.map((q) => q.lag));
      const wing = cx.timer.every(180, (cx) => { if (!this.bird) return; this.birdTick = (this.birdTick ?? 0) + 1; if (!this.needTick) cx.notify(); }); // (while somebody walks, the walk's 125 ms redraw shows the wings too: no second redraw) cx.timer.after(span, () => { try { wing.cancel?.(); } catch {} }); // frames change only while they cross
      cx.timer.after(span, (cx) => { this.bird = null; this.birdAt = Date.now() + 120000 + Math.random() * 180000; cx.notify(); });    });
    this.needTick = this.walkFrames() && [...(this.people ?? []).values()].some((p) => this.moving(p));
    if (this.needTick && !this.tickTimer) this.tickTimer = cx.timer.every(125, (cx) => { if (this.needTick) { this.wtick = ((this.wtick ?? 0) + 1) % 24; cx.notify(); } });
    if (!G) for (const l of labels) root.child(l.el); // (a grid scene drew them with the floor)
    shell.child(root);
    if (this.t?.cached && !this.t.done) shell.child(div().id("plan-wait").absolute().right(10).top(8).px(6).py(2).rounded(6).bg("#1b2637e8").text_size(10).text_color(P.muted).child("갱신 중…")); // ★95-13: a small mark in the corner while the last floor is shown and the new plan is made
    this.ph("legend");
    if (this.legendCollapsed === undefined) { this.legendCollapsed = false; cx.spawn(async (cx) => { try { const t = await readTextFile(`${appHome()}/hakoniwa-office/legend.json`); const j = t ? JSON.parse(t) : null; if (j && j.collapsed === true) { this.legendCollapsed = true; cx.notify(); } else if (j && j.hidden === true) { try { await writeTextFile(`${appHome()}/hakoniwa-office/legend.json`, JSON.stringify({ collapsed: false }), null); } catch {} } } catch {} }); } // ★50-7a: only collapsed:true folds; an old hidden:true (the × of old) is migrated once to open (★38's always-on is the default)
    const lgX = 10 + (this.termPanel && !this.demo?.() && this.panelOpen?.() ? this.panelWidth() : 0); // ★72-3: right of the list only while it is open (the folded strip is at the top: r46)
    // ★72-3 (r46): the open legend covering the approval desk / the counter (their signs, with the desk under them) is drawn folded, unless the person
    // opened it here; legend.json (the person's own fold, ★43) is not touched, and it can always be opened (★38: never gone).
    const lgCover = () => { try { const { W: w0, H: h0 } = this.legendLayout(left), y0 = left.height - 10 - h0; return ["approval", "counter"].some((kd) => { const a0 = sc.windows?.[kd]?.sign_at; if (!a0) return false; const sx = ox + a0[0] * k, sy = oy + a0[1] * k; return sx + 90 > lgX && sx - 90 < lgX + w0 && sy + 110 > y0 && sy - 10 < y0 + h0; }); } catch { return false; } };
    const lgOpened = this.legendUserOpen === true || (this.legendUserOpen === "review" && Date.now() - (this.legendReviewAt ?? 0) < 60000); // a review "legend:open" counts for a minute only (r44: it had stuck)
    const lgShell = { child() { return this; } }; // ★84 the legend now lives under the left list (panel.js): the floor one is no longer drawn (its code and rules stay)
    if (!(this.floorLegend ?? FLOOR_LEGEND)) { /* ★89 the floor legend is not drawn (lgShell is a dummy): building ~20 rows each frame cost 5-15 ms of the 50 ms budget, a walk was cut by it */ } else if (this.legendCollapsed || (!lgOpened && lgCover())) { // ★43 collapsed: the small "범례" button stays at the lower-left and opens it again
      // self-review-0505 #7: four pictures with their words (11 px, as the board's words: ★47-1) and "凡例 ▸"; pressing anywhere opens the whole legend
      const pic = (part) => { const q = this.lifeParts?.[part], box = div().flex_none().w(24).h(20).flex().items_center().justify_center(); if (!q?.file) return box; const s = Math.min(22 / q.w, 18 / q.h); return box.child(image(q.file).w(Math.max(1, q.w * s)).h(Math.max(1, q.h * s))); };
      lgShell.child(h_flex().id("legend").absolute().left(lgX).top(left.height - 54).h(44).px(8).gap(8).items_center().rounded(8).cursor_pointer().bg("#1b2637ee").border(1).border_color("#3b4b60").text_size(11).text_color(P.ink)
        .hover((s) => s.bg("#1b2637")).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .children(LEGEND_STRIP.map((m) => v_flex().id(`legend-strip-${m.key}`).flex_none().gap(1).items_center().child(pic(m.part)).child(div().text_size(11).text_color(P.ink).child(m.label))))
        .child(div().flex_none().w(1).h(30).bg("#3b4b60"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.legendCollapsed = false; this.legendUserOpen = true; cx.notify(); cx.spawn(async () => { try { await writeTextFile(`${appHome()}/hakoniwa-office/legend.json`, JSON.stringify({ collapsed: false }), null); } catch {} }); })
        .child(div().flex_none().text_size(11).font_weight(700).text_color(P.muted).child("범례 ▸")));
    } else { // ★38 the legend is always on: a small board fixed at the window's lower-left, with the picture of what is drawn
      const { W, H, bodyH, rowH, twoCol, pcOpen } = this.legendLayout(left);
      const icon = (spec, h) => {
        const box = div().flex_none().w(twoCol ? 20 : 24).h(h).flex().items_center().justify_center();
        if (spec?.part) {
          const q = this.lifeParts?.[spec.part]; // only a file the manifest already gave: never a path that is not there
          if (q?.file) { const s = Math.min((twoCol ? 18 : 22) / q.w, (h - 2) / q.h); return box.child(image(q.file).w(Math.max(1, q.w * s)).h(Math.max(1, q.h * s))); }
          return box;
        }
        if (spec?.text) return box.child(div().w(twoCol ? 16 : 20).h(Math.max(12, h - 2)).flex().items_center().justify_center().rounded(3).when(!!spec.bg, (e) => e.bg(spec.bg)).text_size(spec.text.length > 1 ? 9 : 11).font_weight(700).text_color(spec.color ?? P.ink).child(spec.text));
        return box;
      };
      const row = (m) => h_flex().h(rowH).flex_none().gap(4).items_center().child(icon(m.icon, rowH))
        .child(div().flex_none().w(twoCol ? 56 : 86).truncate().text_color(P.ink).child(m.label))
        .child(div().flex_1().min_w(0).truncate().text_color(P.muted).child(m.meaning));
      const block = (title, items, pc = false) => {
        const heading = div().h(20).flex_none().text_size(11).font_weight(700).text_color(P.ink).child(title);
        if (pc) heading.id("legend-pc-toggle").cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.legendPcOpen = !pcOpen; cx.notify(); });
        return v_flex().id(pc ? "legend-pc-block" : "legend-marks-block").flex_none().w(twoCol ? (W - 26) / 2 : W - 16).min_w(0).gap(0).child(heading).children(items.map(row));
      };
      const marks = block("소품과 표시", LEGEND_MARKS), pc = block(`책상 PC ${pcOpen ? "▾" : "▸"}`, pcOpen ? LEGEND_PC_RULES : [], true);
      const contents = twoCol ? h_flex().gap(10).items_start().child(marks).child(pc) : v_flex().gap(4).child(marks).child(pc);
      lgShell.child(v_flex().id("legend").absolute().left(lgX).top(left.height - 10 - H).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).w(W).h(H).p(7).gap(0).overflow_hidden().rounded(8).bg("#1b2637f2").border(1).border_color("#3b4b60").text_size(11)
        .child(h_flex().h(19).flex_none().gap(4).items_center().child(div().flex_1().text_size(12).font_weight(700).text_color(P.ink).child("범례")).child(div().id("legend-collapse").cursor_pointer().text_size(11).text_color(P.muted).on_click((_e, cx) => { this.legendCollapsed = true; cx.notify(); cx.spawn(async () => { try { await writeTextFile(`${appHome()}/hakoniwa-office/legend.json`, JSON.stringify({ collapsed: true }), null); } catch {} }); }).child("접기")))
        .child(div().h(2).flex_none())
        .child(div().id("legend-body").h(bodyH).flex_none().min_h(0).overflow_y_scrollbar().on_scroll_wheel((_e, cx) => cx.stop_propagation()).child(contents)));
    }
    this.ph("controls");
    shell.child(this.zoomControls(left));
    { const mn = this.memNotice(left); if (mn) shell.child(mn); } // ★90 (H)
    if (this.termBox && !this.rightCollapsed && !this.demo?.()) { // ★84 the right window's left border (★103-4 none while it is folded): a handle flush with it; while dragging a thin line shows where it will be (the window opens again on release)
      const bx = this.termBox, gx = this.ghostW ? Math.round((this.left?.width ?? bx.x + bx.w + RIGHT_EDGE) - RIGHT_EDGE - this.ghostW) : null;
      shell.child(splitHandle("right-split", (e, cx2) => { this.resizeStart("right", e.position.x); cx2.notify(); }, this.resize?.side === "right").left(bx.x - 3).top(bx.y).h(bx.h));
      if (gx != null) shell.child(div().absolute().left(gx).top(bx.y).w(2).h(bx.h).bg("#2F80ED"));
    }
    if (this.regionShown && !this.rightCollapsed && !this.demo?.()) shell.child(splitHandle("right-split", (e, cx2) => { this.resizeStart("right", e.position.x); cx2.notify(); }, this.resize?.side === "right").left(left.width - 3).top(0).h(left.height)); // ★103-3 (office-region103) the region's border: the same translucent handle as the left one
    if (this.termPanel && !this.demo?.()) shell.child(this.termPanel(left, list, cx)); // ★72-3 the terminals' list at the left edge (real data only)
    if (this.open && !termOn && sel) shell.child(this.chatPanel(sel, list, { width: left.width, height: left.height, open: true, close: (cx) => this.closePanel(cx), select: (p, cx) => this.select(p, cx) }));
    else this.panelShown = false;
    const out = shell;
    unswap(); return out;
  }

  // ★52-3 actual legend geometry: padding + border + title + gap, then bounded content.
  legendLayout(left) {
    const maxH = Math.max(1, Math.floor(left.height * 0.4)), rowH = 20, chromeH = Math.min(37, maxH);
    const marksH = 20 + LEGEND_MARKS.length * rowH, pcH = 20 + LEGEND_PC_RULES.length * rowH;
    const twoCol = left.width >= 520 && chromeH + marksH + 4 + pcH > maxH;
    const pcOpen = this.legendPcOpen ?? (chromeH + (twoCol ? Math.max(marksH, pcH) : marksH + 4 + pcH) <= maxH);
    const contentH = twoCol ? Math.max(marksH, pcOpen ? pcH : 20) : marksH + 4 + (pcOpen ? pcH : 20);
    const H = Math.min(maxH, chromeH + contentH), W = Math.max(1, Math.min(twoCol ? 560 : 320, left.width - 20));
    return { W, H, bodyH: H - chromeH, chromeH, rowH, twoCol, pcOpen };
  }

  // ★41 where a walker is on the floor now: from its leg's start to the end, linear in time (the walk's transitions are linear)
  legNow(rec, t) { const f = Math.max(0, Math.min(1, (t - rec.at) / rec.dur)); return [rec.from[0] + (rec.target[0] - rec.from[0]) * f, rec.from[1] + (rec.target[1] - rec.from[1]) * f]; }

  // ★54 the board as a picture: the dots (the same boardDots, with what stands in front of the face left out) are written as one svg whenever they change.
  // ★95: the board's timer body. An old part (retired, or one whose host calls throw `null` after an install's reload) stops at once; three `null`s in a row end the timer
  // (a live part makes it again at the next render). Nothing here throws out of the timer.
  boardBeat(c) {
    if (this.retired) { try { this.boardTimer?.cancel?.(); } catch {} this.boardTimer = null; return; }
    try { this.boardTick(c); this.boardNull = 0; }
    catch (e) {
      try { this.dbgErr(e, "board"); } catch {}
      if (e == null && (this.boardNull = (this.boardNull ?? 0) + 1) >= 3) { try { this.boardTimer?.cancel?.(); } catch {} this.boardTimer = null; this.boardNull = 0; }
    }
  }
  boardTick(cx) {
    if (this.retired) return;
    const sc = this.scene, list = this.lastList; if (!sc?.board || !list || !this.viewBox) return;
    this._bp = "start"; // (★94 diagnosis: the step a thrown null stopped at is written with the error)
    const k = this.viewBox.k, b = sc.board, byId = new Map(list.map((a) => [a.id, a])), wx = this.weatherNow();
    const dn = list.filter((a) => a.status === "done").length, wk = list.filter((a) => a.status === "working").length, wt = list.filter((a) => a.status === "blocked").length;
    const nowB = new Date();
    const fp = b.face?.length ? b.face : b.rect ? [[b.rect[0], b.rect[1]], [b.rect[0] + b.rect[2], b.rect[1] + b.rect[3]]] : [], avoid = [];
    if (fp.length) { const bx0 = Math.min(...fp.map((q) => q[0])), bx1 = Math.max(...fp.map((q) => q[0])), by0 = Math.min(...fp.map((q) => q[1])), by1 = Math.max(...fp.map((q) => q[1])), near = (x, y, w, h) => x < bx1 + 24 && x + w > bx0 - 24 && y < by1 + 24 && y + h > by0 - 24;
      for (const o of sc.objects ?? []) { const r = o.rect; if (r && (o.depth ?? 0) >= (b.depth ?? 0) && near(r[0], r[1], r[2], r[3])) avoid.push([r[0] - 2, r[1] - 2, r[2] + 4, r[3] + 4]); }
      for (const [pid, p] of this.people ?? []) { const a = byId.get(pid) ?? p.last; if (!p.pos || !a) continue; try { const { key } = this.poseFiles(this.personFilesFor(pid, sc), a, p), ps = sc.pose_size?.[key] ?? sc.pose_size?.stand ?? sc.sprite ?? { w: 12, h: 20 }, x = p.pos[0] - ps.w / 2, y = p.pos[1] - ps.h; if (near(x, y, ps.w, ps.h)) avoid.push([x - 2, y - 2, ps.w + 4, ps.h + 4]); } catch {} } }
    { const inSig = `${b.rect}|${nowB.getFullYear()}-${nowB.getMonth()}-${nowB.getDate()} ${nowB.getHours()}:${nowB.getMinutes()}|${JSON.stringify(wx)}|${dn},${wk},${wt},${this.okCount ?? 0}|${avoid.join(";")}`; // ★56-2 (office-perf) nothing the board shows has changed: no new dots this second
      if (inSig === this._boardIn && this.boardPic !== undefined) return; this._boardIn = inSig; }
    this._bp = "boardDots";
    const dots = boardDots(b, { now: nowB, weather: wx, done: dn, work: wk, wait: wt, ok: this.okCount ?? 0, avoid });
    // ★54/★55 the dots are written as small pictures, one per glyph (★88-6: it was one per 6x8 cell of the LED grid, whose picture changed whenever a glyph moved against the grid:
    // a new minute or number shifts the spread of the row, a walker moves the row up or down: ~600 new files an hour, each held by the App for ever).
    // A glyph's picture depends only on which of its dots are lit (the colour is the text colour) and is drawn from its own top left, so the same few hundred pictures are reused for ever. Named by their content.
    const rs = Math.max(0.3, 0.246 * Math.min(Math.hypot(b.dx[0], b.dx[1]), Math.hypot(b.dy[0], b.dy[1]))), still = dots.filter((p) => !p.blink), blink = dots.filter((p) => p.blink), pos = (c, r) => [c * b.dx[0] + r * b.dy[0], c * b.dx[1] + r * b.dy[1]], kHash = hash(`${b.dx}|${b.dy}`).toString(36);
    this._bp = "cells"; const cells = new Map();
    for (const p of still) { const key = p.g ?? `t${Math.floor(p.c / 6)},${Math.floor(p.r / 8)},${p.color}`; let e = cells.get(key); if (!e) cells.set(key, e = { color: p.color, dots: [] }); e.dots.push(p); } // (a dot without a mark: the old 6x8 cell)
    if (!cells.size) { if (this.boardPic) { this.boardPic = null; cx.notify(); } return; }
    this._bp = "tiles"; this.tileDone ??= new Set(); const tiles = [], writes = [];
    for (const e of cells.values()) {
      const c0 = Math.min(...e.dots.map((q) => q.c)), r0 = Math.min(...e.dots.map((q) => q.r)), rel = e.dots.map((q) => [q.c - c0, q.r - r0]).sort((m, n) => m[1] - n[1] || m[0] - n[0]);
      let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; for (const [c, r] of rel) { const [x, y] = pos(c, r); mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y); }
      const vb = [mnx - rs, mny - rs, mxx - mnx + 2 * rs, mxy - mny + 2 * rs], head = `<svg xmlns="http://www.w3.org/2000/svg" width="${vb[2].toFixed(2)}" height="${vb[3].toFixed(2)}" viewBox="${vb.map((v) => v.toFixed(2)).join(" ")}" fill="currentColor">`;
      const body = rel.map(([c, r]) => { const [x, y] = pos(c, r); return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rs}"/>`; }).join(""), pat = rel.map((q) => q[0] + q[1] * 64).join("."), name = `hakoniwa-office/bt-${kHash}-${hash(pat).toString(36)}-${rel.length}.svg`; // ★86: the picture depends on the dot spacing (dx, dy: the scale K), so the name carries it (a tile made at another K was reused with the wrong spacing: the rows of a big sign ran into each other)
      this._bp = `write ${name}`; if (!this.tileDone.has(name)) { this.tileDone.add(name); writes.push(writeTextFile(`${appHome()}/${name}`, head + body + "</svg>", null).catch(() => null)); } // (a picture that is already there from an earlier run makes the write refuse: the name is its content, so it is the same picture)
      const [ox0, oy0] = pos(c0, r0); tiles.push({ file: name, color: e.color, x: b.origin[0] + ox0 + vb[0], y: b.origin[1] + oy0 + vb[1], w: vb[2], h: vb[3] });
    }
    this._bp = "sig"; const sig = tiles.map((t) => `${t.file}${t.color}${t.x.toFixed(1)},${t.y.toFixed(1)}`).join("|");
    if (this.boardPic?.sig === sig) { this.boardPic.blink = blink; return; }
    const apply = () => { this.boardPic = { tiles, sig, blink }; cx.notify(); };
    if (writes.length) Promise.all(writes).then(apply).catch((e) => { for (const t of tiles) this.tileDone.delete(t.file); this._boardIn = null; this.dbgErr(e, "board-write"); }); else apply();
  }

  // office-perf3: the stars of one glass are 3 svg pictures (named by their content, written once, never more than a few dozen over all glass sizes); a picture shows when its file is written
  starPics(n, rw, rh, cnt, cx) {
    this._starPics ??= new Map(); const sk = `${n}|${rw}|${rh}|${cnt}`; let r = this._starPics.get(sk);
    if (!r) {
      const groups = [[], [], []], periods = [1100, 1700, 2300];
      for (let i = 0; i < 30 / Math.max(1, cnt) + 4; i++) { const hx = hash(`s${n}-${i}`); groups[hx % 3].push([((hx >>> 3) % 1000) / 1000 * rw, ((hx >>> 13) % 1000) / 1000 * rh]); }
      const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${rw}" height="${rh}" viewBox="0 0 ${rw} ${rh}" fill="currentColor">`;
      r = groups.map((g, gi) => { const body = g.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1"/>`).join(""), file = `hakoniwa-office/stars-${hash(head + body).toString(36)}-${g.length}.svg`; return { file, head, body, lp: { from: 0.15, to: 1, period: periods[gi] }, ready: false, started: false }; });
      this._starPics.set(sk, r);
    }
    const out = [];
    for (const pic of r) {
      if (!pic.started) { pic.started = true; writeTextFile(`${appHome()}/${pic.file}`, pic.head + pic.body + "</svg>", null).catch(() => null).then(() => { pic.ready = true; cx.timer?.after ? cx.timer.after(0, () => cx.notify()) : null; }); }
      if (pic.ready) out.push(pic);
    }
    return out;
  }

  // ★30-6 zoom and drag: zoomPan = { z, px, py } (z 1 = the whole floor in the window; px/py move it). The wheel zooms around the pointer.
  justDragged() { return Date.now() - (this.dragAt ?? 0) < 250; }
  zoomBy(f, at, cx) {
    this.userMoved = true; // ★86
    const zm = this.zoomPan ?? { z: 1, px: 0, py: 0 }, vb = this.viewBox, sc = this.scene, W = this.left?.width ?? 800, H = this.left?.height ?? 560;
    if (!vb || !sc) return;
    const z2 = Math.max(0.4, Math.min(4, (zm.z ?? 1) * f)), g = z2 / (zm.z ?? 1), a = at ?? { x: W / 2, y: H / 2 };
    const k2 = vb.k * g, ox2 = a.x - (a.x - vb.ox) * g, oy2 = a.y - (a.y - vb.oy) * g; // the floor point under the pointer stays under it
    const baseOx = (W - sc.width * k2) / 2, baseOy = sc.native ? (H - sc.height * k2) / 2 : Math.max(2, (H - sc.height * k2) / 2);
    this.zoomPan = { z: z2, px: ox2 - baseOx, py: oy2 - baseOy };
    cx.notify();
  }
  dragStart(x, y) { this.dragMoved = false; this.dragFrom = { x, y, px: this.zoomPan?.px ?? 0, py: this.zoomPan?.py ?? 0, on: false }; }
  dragMove(x, y, cx) { const d = this.dragFrom; if (!d) return; const dx = x - d.x, dy = y - d.y; if (!d.on && Math.hypot(dx, dy) < 4) return; d.on = true; this.dragMoved = true; this.userMoved = true; this.zoomPan = { ...(this.zoomPan ?? { z: 1 }), px: d.px + dx, py: d.py + dy }; cx.notify(); }
  dragEnd() { if (this.dragFrom?.on) this.dragAt = Date.now(); this.dragFrom = null; }
  // ★37-1 the wheel over the right column (the detail window / the side panel) only scrolls that column: never a zoom of the office
  // ★109 (office-verify6, remaining gap 7): in region mode rightTaken() is 0 (the floor ends where the region starts) but the floor's right corner still met the window: fit with a small margin only while the right region shows (全体を表示 stays first; only the floor moves left a little)
  autoFit() { const s2 = this.scene; // ★86: a new floor size (rooms came or went, a new K) fits the whole floor to the window again; a changed window only when the person has not moved the view
    if (!(s2?.native && s2.width > 0 && s2.height > 0)) return;
    const rt0 = this.fitMargin(), lw = this.panelOpen?.() && this.termPanel && !this.demo?.() ? this.panelWidth() : 0, sk = `${s2.width}x${s2.height}`, wk = `${Math.round(this.left?.width ?? 0)}x${Math.round(this.left?.height ?? 0)}|${rt0}`, newScene = this.fitScene !== sk, newWin = this.fitWin !== wk, newRt = this.fitRt !== rt0; // 2nd-105 N1: the right window opening / closing refits even after the person moved the view (zoomFit already took its width; the auto fit did not)
    // 11th B3: the list's width (leftW) is read from widths.json by loadWidths() while the list first draws, so the first fit ran with the default 280 and the floor stayed 74px too far left (left gap 5px with a 354px list). A changed list width refits, like the right window's.
    const newLw = this.fitLw !== lw; this.fitLw = lw;
    if (!(newScene || newRt || newLw || (newWin && !this.userMoved))) return;
    this.fitScene = sk; this.fitWin = wk; this.fitRt = rt0; this.userMoved = false;
    const W = this.left?.width ?? 800, H = this.left?.height ?? 560;
    this.zoomPan = sideFit(s2, W, H, fitZoom, lw, rt0); // ★103-3 (2nd) the right window takes its width off the floor
  }
  // ★9th Z5: the fit already took the window's width off the floor, but with a 0 gap (measured 11/7: window's left edge x=1110, floor's right corner x=1108, plate "AI オフィス開発" ends x=1105), so the corner touched / was clipped. FLOOR_RIGHT_GAP keeps the floor clear of the window's left edge.
  fitMargin() { const rt = this.rightTaken(); return rt > 0 ? rt + FLOOR_RIGHT_GAP : (this.regionShown && !this.rightCollapsed && !this.demo?.() ? 64 : 0); }
  rightTaken() { const b = this.termBox; return b && !this.demo?.() ? Math.round(b.w) : 0; } // ★103-3 (2nd) the width the attached right window takes
  overColumn(at, pos) { const b = this.termBox; if (b && pos && pos.x >= b.x - 2 && pos.y >= b.y - 2) return true; return !!(this.panelLeft != null && at && at.x >= this.panelLeft); }
  wheelZoom(dy, at, cx, pos) { if (this.overColumn(at, pos)) return; if (dy) this.zoomBy(Math.pow(1.0015, dy), at, cx); } // scrolling up (the device's positive distance) zooms in
  // ★62-3 「全体を表示」: the whole floor inside the window. A native scene is drawn at k = z (1 = the pictures' own size), which can be taller than the window
  // (r36: the front edge and the 控室 sign went under the window's bottom), so the button zooms out just enough; never above 1 (the pictures are not blown up).
  zoomFit(cx) { const sc = this.scene, W = this.left?.width ?? 800, H = this.left?.height ?? 560, lw = this.panelOpen?.() && this.termPanel && !this.demo?.() ? this.panelWidth() : 0; this.zoomPan = sideFit(sc, W, H, fitZoom, lw, this.fitMargin()); cx.notify(); } // ★73-2: with the left list open, the width left of it
  zoomControls(left) {
    const btn = (id, label, fn, w = 26) => div().id(id).flex_none().w(w).h(24).flex().items_center().justify_center().rounded(6).cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).text_size(13).font_weight(700).text_color(P.ink).child(label).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); });
    // self-review #6: at the upper right, just under the band (at the lower right the App's own notices, e.g. "Restart", covered them); left of the side panel while it is open
    // 4th W6: the "＋" was still under the window by one button's width (r4 picture), so the buttons keep a margin (ZOOM_GAP) clear of the attached window's left edge
    const panelW = (this.panelLeft != null ? Math.max(0, left.width - this.panelLeft) : 0) + this.rightTaken() + (this.rightTaken() > 0 ? ZOOM_GAP : 0); // ★104 V3: the attached right window covers the floor's right edge too
    return h_flex().id("zoom-controls").absolute().right(10 + panelW).top(8).h(24).gap(2).items_center().rounded(8).bg("#1b2637ee").border(1).border_color("#3b4b60")
      .child(btn("zoom-out", "－", (cx) => this.zoomBy(1 / 1.25, null, cx))).child(btn("zoom-fit", "전체 보기", (cx) => this.zoomFit(cx), 84)).child(btn("zoom-in", "＋", (cx) => this.zoomBy(1.25, null, cx)));
  }
  // ★90 (H): small, under the zoom buttons: the App is holding a lot of pictures and a restart is the sure way to give it back.
  memNotice(left) {
    if (!this.appMemWarn) return null;
    const panelW = (this.panelLeft != null ? Math.max(0, left.width - this.panelLeft) : 0) + this.rightTaken() + (this.rightTaken() > 0 ? ZOOM_GAP : 0);
    return div().id("mem-restart").absolute().right(10 + panelW).top(36).h(20).px(8).flex().items_center().rounded(6).bg("#fff4e5ee").border(1).border_color("#e8c79a").text_size(11).text_color("#8a5a1f")
      .child(`메모리 ${this.appMB ?? "?"}MB — 앱 재시작 권장`);
  }

  // Floor names (left-aligned at their label point) and team names; returned with their rectangles so bubbles can keep clear.
  labelRects(sc, byId, ox, oy, k, avoid = []) {
    const out = [];
    const add = (id, text, x, y, color, center, dodge) => {
      if (!text) return;
      const w = Math.min(220, 18 + String(text).length * 10), h = 16;
      const lx = ox + x * k - (center ? w / 2 : 0);
      let ly = oy + y * k;
      if (dodge) for (let n = 0; n < 12; n++) { // an island's name steps down, clear of people standing there (and so of their tags)
        const r = { x: lx, y: ly, w, h }, hit = [...out.map((o) => o.r), ...avoid].find((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
        if (!hit) break;
        ly = hit.y + hit.h + 2;
      }
      out.push({ r: { x: lx, y: ly, w, h }, el: h_flex().id(`label-${id}`).absolute().left(lx).top(ly).h(h).px(6).gap(4).items_center().rounded(4)
        .bg("#2b3140cc").text_size(10).font_weight(700).text_color("#ffffff")
        .when(!!color, (e) => e.child(chip(color, 6))).child(div().child(text)) });
    };
    const plated = (sc.islands ?? []).some((q) => q.plate?.at);
    for (const isl of sc.islands ?? []) if (!isl.plate?.at) { // the island's name: in the aisle in front of its doorway: the same display name as the Agents list
      // ★65-2: two rooms that face each other across one aisle (no plate: ★31-3) had their names at the same spot on the partitions.
      // Each name slides 1.5 tiles along the aisle away from the other (toward its own room's side) and carries an arrow to its room.
      const at = isl.opening ?? isl.label ?? [0, 0], rc = isl.rect ? [isl.rect[0] + isl.rect[2] / 2, isl.rect[1] + isl.rect[3] / 2] : at;
      const dx = rc[0] - at[0], dy = rc[1] - at[1], g = sc.grid, sl = isl.opening && g?.tw ? (dx < 0 ? -1 : 1) * 1.5 : 0;
      const arrow = !isl.opening ? "" : dy < 0 ? (dx < 0 ? "↖ " : "↗ ") : (dx < 0 ? "↙ " : "↘ ");
      add(`isl-${isl.key}`, `${arrow}${isl.title}`, at[0] - sl * (g?.tw ?? 0) / 2, at[1] + (isl.opening ? 8 : 0) + sl * (g?.th ?? 0) / 2, null, true, true);
    }
    for (const z of sc.zones ?? []) {
      if (sc.l86 && (z.key === "approval" || z.key === "counter" || z.key === "lounge")) continue; // ★86: those places are gone (an older plan may still list them)
      if (plated && String(z.key ?? "").startsWith("team:")) continue; // the plate says it
      if ((z.key === "approval" || z.key === "counter") && sc.windows?.[z.key]?.sign_at) continue; // the white standing sign says it (no second, black label)
      const m = /^team:(.+)$/.exec(z.key ?? "");
      const lead = m && byId.get(m[1]);
      const meaning = { approval: "승인 대기", counter: "보고 있음", lounge: "대기 중" }[z.key];
      const teamText = m && lead ? `${lead.name}${z.children ? ` · 작업자 ${z.children}명` : ""}` : ""; // the parent's display name (as in the Agents list); no parent in the list: no label
      if (z.key === "lounge" && z.label_group && z.label) { add(`z-${z.key}`, `${z.title}（${meaning}）`, z.label[0], z.label[1], null, true, true); continue; } // ★65-1 (office-polish): right in front of the armchair groups (office.py's place), not at the rug's front edge
      if (z.key === "lounge" && z.tiles?.length) { const q = z.tiles.map((t) => this.tileXY(sc, t)), cx_ = (Math.min(...q.map((v) => v[0])) + Math.max(...q.map((v) => v[0]))) / 2, by = Math.max(...q.map((v) => v[1])) + (sc.grid?.th ?? 20); add(`z-${z.key}`, `${z.title}（${meaning}）`, cx_, by, null, true, true); continue; } // in front of the rug (clear floor), not under the armchairs
      add(`z-${z.key}`, m ? teamText : (meaning && z.title && !String(z.title).includes("（") ? `${z.title}（${meaning}）` : z.title), z.label?.[0] ?? 0, z.label?.[1] ?? 0, m ? TEAM[hash(m[1]) % TEAM.length] : null, true);
    }
    return out;
  }

  screenOn(id, shots, ox, oy, k) {
    const f = shots[0]; // the lit screen stays as it is
    return f ? [image(f.file).id(`son-${id}-0`).absolute().left(ox + f.rect[0] * k).top(oy + f.rect[1] * k).w(f.rect[2] * k).h(f.rect[3] * k)] : [];
  }

  // The desk's screen while working: code lines scroll, a cursor blinks.
  // A rectangle (inside a monitor face) with lines of code that slide up for ever: .loop("top"), linear, no re-render.
  codeStrip(id, rect, ox, oy, k) {
    const [x, y, w, h] = rect, W = w * k, H = h * k, lh = Math.max(2, H / 6);
    const n = 14, ck = `${id}|${W}`; this._codeRows ??= new Map(); // ★56-2 (office-perf) the 14 lines' widths and colours are worked out once per screen and size (hashing them on every draw was ~0.35 ms a screen)
    let spec = this._codeRows.get(ck); if (!spec) { if (this._codeRows.size > 400) this._codeRows.clear(); spec = Array.from({ length: n }, (_, i) => [Math.max(2, W * jit(id, `l${i}`, 0.3, 0.92)), Math.round(W * 0.05 * (hash(id + i) % 3)), ["#7ee0b0", "#8fb4ff", "#e6e9f2", "#f0b86e"][hash(id + "c" + i) % 4]]); this._codeRows.set(ck, spec); }
    const row = (i) => div().h(lh * 0.7).flex_none().w(spec[i][0]).ml(spec[i][1]).rounded(1).bg(spec[i][2]);
    return div().id(`code-${id}`).absolute().left(ox + x * k).top(oy + y * k).w(W).h(H).overflow_hidden().bg("#1b2234")
      .child(v_flex().absolute().left(0).top(0).w(W).gap(lh * 0.3)
        .loop("top", { from: 0, to: -lh * n * 0.5, period: 2600 + (hash(id) % 1400), easing: "linear" })
        .children(Array.from({ length: n }, (_, i) => row(i))));
  }

  // The weather the collector wrote (or the one set for the review); older than 3 h or missing = clear.
  weatherNow() {
    const forced = this.demoNow() ? shared("hakoniwa.weather") : null; // ★50 a forced weather / hour counts only in the demo (a leftover from a shoot never touches the real data)
    if (typeof forced === "string" && WEATHER_KINDS.includes(forced)) return { kind: forced, temp: 18, label: this.officeSettings(this.feed.config)?.weather?.label ?? this.feed.state?.weather?.label ?? "", is_day: 1 }; // the place is the configured one (office.weather.label), never a made-up city
    const w = this.feed.state?.weather;
    if (!w || !w.kind || Date.now() - (w.at ?? 0) > 3 * 3600 * 1000) return { kind: "clear", is_day: null };
    return w;
  }

  // morning / day / evening / night: by sunrise and sunset when known (the real time of day), else by the hour.
  periodNow() {
    const hr = this.hourNow(), w = this.weatherNow(), mins = (v) => { if (typeof v === "number" && v > 1e9) { const d = new Date(v < 1e12 ? v * 1000 : v); return d.getHours() * 60 + d.getMinutes(); } const m = /T(\d\d):(\d\d)/.exec(String(v ?? "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const sr = mins(w.sunrise), ss = mins(w.sunset);
    if (sr != null && ss != null && typeof this.forcedHour() !== "number") {
      const t = new Date().getHours() * 60 + new Date().getMinutes();
      return t >= sr - 30 && t < sr + 150 ? "morning" : t >= sr + 150 && t < ss - 120 ? "day" : t >= ss - 120 && t < ss + 40 ? "evening" : "night";
    }
    return hr >= 5 && hr < 9 ? "morning" : hr >= 9 && hr < 16 ? "day" : hr >= 16 && hr < 19 ? "evening" : "night";
  }

  // The moon's phase from the date: 0 new, 1 waxing crescent, 2 first quarter, 3 waxing gibbous, 4 full, 5 waning gibbous, 6 last quarter, 7 waning crescent.
  moonPhase(ms = Date.now()) { // (the rule lives in life.js)
    return moonPhase(ms);
  }

  demoNow() { return !!(shared("hakoniwa.demo") || this.feed?.config?.demo); }
  forcedHour() { const h = shared("hakoniwa.hour"); return this.demoNow() && typeof h === "number" ? h : 22; }
  hourNow() { const h = this.forcedHour(); return typeof h === "number" ? h : new Date().getHours(); }

  // A bird's shadow crosses the back wall now and then (every 2-5 minutes): one small dark shape moved by a transition.
  birdNow(sc, ox, oy, k) {
    const b = this.bird;
    if (!b) return null;
    const paths = sc.bird_paths;
    if (Array.isArray(paths) && paths.length) { // A's paths: a flock of 3-6, a little apart, along one outer wall inside its row of glass; clipped to that row, so it never leaves the little world
      const bf = this.life?.bird, hr = this.hourNow(), day = hr >= 9 && hr < 16, left = !!b.dir;
      const set = (day ? (left ? bf?.dark_flip : bf?.dark) ?? bf?.dark : (left ? bf?.light_flip : bf?.light) ?? bf?.light);
      const clips = new Map(); // one clip per row of glass
      for (const fb of b.flock ?? flockBirds(paths, b.pick ?? 0, b.n ?? 4)) {
        const bp = fb.path, c = bp.clip ?? bp.glass, [x0, y0] = b.dir ? bp.to : bp.from, [x1, y1] = b.dir ? bp.from : bp.to, go = !!b.goSet?.[fb.i], pt = go ? [x1, y1] : [x0, y0];
        const at = [pt[0] + fb.off[0], pt[1] + fb.off[1]];
        const w = (bp.bird?.[0] ?? bf?.w ?? 40) * k * BIRD_SCALE, h = (bp.bird?.[1] ?? bf?.h ?? 36) * k * BIRD_SCALE; // ★47-2: a fifth of the picture's size
        const fr = set?.length ? set[wingFrame(this.birdTick ?? 0, fb.phase, set.length)] : null; // each bird flaps at its own moment
        const img = fr ? image(typeof fr === "string" ? fr : fr.file).absolute() : div().absolute().rounded(9).bg("#1f2a3acc");
        const el = img.id(`bird-${fb.i}`).left((at[0] - (c ? c[0] : 0)) * k - w / 2).top((at[1] - (c ? c[1] : 0)) * k - h / 2).w(w).h(h)
          .transition("left", { duration: 9000, easing: "linear" }).transition("top", { duration: 9000, easing: "linear" });
        const key = c ? c.join(",") : "none";
        if (!clips.has(key)) clips.set(key, { c, els: [] });
        clips.get(key).els.push(c ? el : el.left(ox + at[0] * k - w / 2).top(oy + at[1] * k - h / 2));
      }
      return [...clips.entries()].map(([key, g], n) => (g.c ? div().id(`bird-clip-${n}`).absolute().left(ox + g.c[0] * k).top(oy + g.c[1] * k).w(g.c[2] * k).h(g.c[3] * k).overflow_hidden().children(g.els) : g.els)).flat();
    }
    if (!sc.grid) return null;
    const t = (gx) => this.tileXY(sc, [gx, -0.4]), cols = sc.grid.cols, a = t(cols * (b.dir ? 0.85 : 0.25)), z = t(cols * (b.dir ? 0.25 : 0.85)), p = b.go ? z : a;
    const bf = this.life?.bird, hr = this.hourNow(), day = hr >= 9 && hr < 16, left = !!b.dir, set = day ? (left ? bf?.dark_flip : bf?.dark) ?? bf?.dark : (left ? bf?.light_flip : bf?.light) ?? bf?.light; // dark shadow by day, light otherwise; mirrored frames when it flies left
    if (set?.length) { const f = set[(this.birdTick ?? 0) % set.length], bw = (bf.w ?? 40) * k * BIRD_SCALE, bh = (bf.h ?? 36) * k * BIRD_SCALE; return image(typeof f === "string" ? f : f.file).id("bird").absolute().left(ox + p[0] * k - bw / 2).top(oy + (p[1] - 60) * k).w(bw).h(bh).transition("left", { duration: 9000, easing: "linear" }).transition("top", { duration: 9000, easing: "linear" }); }
    return div().id("bird").absolute().left(ox + p[0] * k - 9 * BIRD_SCALE).top(oy + (p[1] - 46) * k).w(18 * BIRD_SCALE).h(7 * BIRD_SCALE).rounded(9).bg("#1f2a3acc")
      .transition("left", { duration: 9000, easing: "linear" }).transition("top", { duration: 9000, easing: "linear" });
  }

  // A tall picture of code lines inside the laptop's screen rectangle; it slides up for ever (native loop, no re-render).
  faceStrip(id, rect, file, ox, oy, k, loopH) {
    const [x, y, w, h] = rect, W = w * k, H = h * k, LH = (loopH ?? h) * k;
    if (!file) return this.codeStrip(`s-${id}`, rect, ox, oy, k);
    this._faceSeen = Date.now(); // (the code timer runs its two redraws only while a screen picture is drawn)
    return div().id(`face-${id}`).absolute().left(ox + x * k).top(oy + y * k).w(W).h(H).overflow_hidden()
      .child(image(file).id(`faceimg-${id}`).absolute().left(0).top(this.codeRun ? -LH : 0).w(W).h(H * 3)
        .transition("top", { duration: this.codeRun ? 2400 : 1, easing: "linear" })); // runs up one picture-height, then jumps back (no there-and-back); the picture repeats so the seam is invisible
  }

  loadFaces(cx) { // the two monitor faces (fractions of the screen picture) from sprites' manifest
    if (this.facesTried) return;
    this.facesTried = true;
    cx.spawn(async (cx) => {
      try {
        const m = JSON.parse((await readTextFile(`${appHome()}/hakoniwa-office/sheet/manifest.json`)) ?? "{}");
        if (m.screen_faces?.length) { this.faces = m.screen_faces; cx.notify(); }
        if (m.life) { this.life = m.life; this.lifeParts = m.parts ?? {}; this.deskProps = m.props?.desk ?? null; cx.notify(); }
      } catch {}
    });
  }

  screen(id, rect, ox, oy, k) {
    const [x, y, w, h] = rect, lh = Math.max(2, h * k / 5);
    const lines = Array.from({ length: 10 }, (_, i) => div().h(lh).flex_none().w(Math.max(2, w * k * jit(id, `l${i}`, 0.25, 0.9)))
      .ml(Math.round(w * k * 0.06 * (hash(id + i) % 3))).rounded(1).bg(["#7ee0b0", "#8fb4ff", "#e6e9f2"][hash(id + "c" + i) % 3]).opacity(0.85));
    const cursor = div().absolute().left(Math.max(2, w * k * 0.5)).top(Math.max(1, h * k * 0.7)).w(Math.max(2, w * k * 0.07)).h(lh)
      .bg("#1b2637");
    return div().id(`screen-${id}`).absolute().left(ox + x * k).top(oy + y * k).w(w * k).h(h * k).overflow_hidden()
      .bg("#1f2638").rounded(1)
      .child(v_flex().absolute().left(Math.max(1, w * k * 0.06)).top(0).w(w * k).gap(lh * 0.5)
        .loop("top", { from: 0, to: -lh * 5, period: 3200 + (hash(id) % 1800), easing: "linear" }).children(lines))
      .child(cursor);
  }

  // Is this person standing on the seat they own (within a few pixels)?
  atSeat(a, p) {
    const d = this.scene?.desks?.[a.id];
    return !!(d?.seat && p.pos && String(p.at) === "desk" && !p.walking && Math.hypot(p.pos[0] - d.seat[0], p.pos[1] - d.seat[1]) < 12);
  }

  // Never hand a missing path to image(): the host caches failed image loads too.
  // Validate once per incoming scene, outside render; cap concurrent reads and do not cache failures across scenes.
  async preparePeople(sc, read = readFile) {
    // ★64 (office-live): somebody still in the office (walking out after the end, at the counter) who is no longer in the new plan keeps their own pictures from the
    // last scene (checked below like the rest), instead of borrowing somebody else's for the walk out.
    const prevP = this.scene?.people; sc.people ??= {}; for (const id of this.people?.keys?.() ?? []) if (!this.hasPersonFiles(sc.people[id]) && this.hasPersonFiles(prevP?.[id])) sc.people[id] = prevP[id];
    const paths = new Set();
    const collect = (v) => { if (typeof v === "string" && v.trim()) paths.add(v); else if (v && typeof v === "object") Object.values(v).forEach(collect); };
    collect(sc.people);
    // ★90 (A): the names carry the pixels' hash, so a picture that was read once is the same picture for ever. Re-reading every path on every
    // plan (826 files / 19.8MB with 7 people) was what grew the App while no new picture was made. Only absent paths are checked again.
    const valid = this.validPeople ??= new Set(), list = [...paths].filter((path) => !valid.has(path));
    for (let i = 0; i < list.length; i += 16) await Promise.all(list.slice(i, i + 16).map(async (path) => {
      try { const bytes = await read(/^(?:[A-Za-z]:[\\/]|\/)/.test(path) ? path : `${appHome()}/${path}`); if (bytes?.length) valid.add(path); } catch {}
    }));
    const clean = (v) => typeof v === "string" ? (valid.has(v) ? v : null)
      : Array.isArray(v) ? v.map(clean).filter(x => x != null)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;
    sc.people = clean(sc.people ?? {});
  }

  poseFrames(value) { return (Array.isArray(value) ? value : [value]).filter(f => typeof f === "string" && f.trim().length > 0); }

  hasPersonFiles(files) {
    return !!files && (Object.values(files).some(v => this.poseFrames(v).length > 0) ||
      [files.walk_frames, files.walk8_frames, files.walk_gif].some(set => Object.values(set ?? {}).some(v => this.poseFrames(v).length > 0)));
  }

  standinFiles(id, sc = this.scene) {
    const packs = Object.entries(sc?.people ?? {}).filter(([other, f]) => other !== id && this.hasPersonFiles(f))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return packs.length ? packs[hash(id) % packs.length][1] : {};
  }

  personFilesFor(id, sc = this.scene) {
    const own = sc?.people?.[id];
    return this.hasPersonFiles(own) ? own : this.standinFiles(id, sc);
  }

  walkPose(files, id, p) {
    const sx = Math.sign(p.dx ?? 0), sy = Math.sign(p.dy ?? 0);
    const dir = sy > 0 ? (sx > 0 ? "dr" : "dl") : sy < 0 ? (sx > 0 ? "ur" : "ul") : (sx > 0 ? "dr" : "dl");
    p.dir = dir;
    for (const f of [files, this.standinFiles(id)]) {
      const sets = this.officeSettings(this.feed.config)?.walk8 !== false ? [f.walk8_frames, f.walk_frames] : [f.walk_frames];
      for (const set of sets) for (const d of [...new Set([dir, "dl"])]) {
        const frames = this.poseFrames(set?.[d]);
        if (frames.length) return { key: "walk_gif", frames: [frames[this.walkFrames() ? this.walkFrameIndex(p, frames.length) : 0]] };
      }
      for (const value of [f.walk_gif?.[dir], f.walk_gif?.dl]) { const frames = this.poseFrames(value); if (frames.length) return { key: "walk_gif", frames: [frames[0]] }; }
      for (const key of [dir.startsWith("u") ? "walk_ur" : "walk_dl", "walk", "walk_dl", "stand", "front_wait"]) {
        const frames = this.poseFrames(f[key]); if (frames.length) return { key, frames: [frames[0]] };
      }
    }
    return { key: "stand", frames: [] }; // person() draws a visible placeholder if no pack exists at all
  }

  // Pose picture(s) for one person. A pose is a file or [frame1, frame2]; older and newer key names both work.
  // ★89 within one draw the same person is asked for their pose 5+ times (person, bodyOf, headFrac x3, avoid rects): one answer per (person, state object, files) per draw
  poseFiles(files, a, p) {
    // ★89 go() sets p.at to the goal at once, the walk starts one tick later: for that look the person still stands where they are, so the picture is the one of the place they are at, not of the goal
    // (a person in the middle of a talk was drawn dozing / seated for one frame between the talk and the walk back; found by sim-probe at 16 ms steps)
    const q = (!p.walking && p.stand && p.stand !== p.at && !this.moving(p)) ? Object.assign(Object.create(p), { at: p.stand }) : p;
    const m = this._poseMemo; if (!m) return this.poseFilesRaw(files, a, q);
    const hit = m.get(p); if (hit && hit.a === a && hit.files === files) return hit.v;
    const v = this.poseFilesRaw(files, a, q); m.set(p, { a, files, v }); return v;
  }
  poseFilesRaw(files, a, p) {
    if (tripShowsPapers(p.trip, p.at)) a = { ...a, status: "blocked" }; // an automatic approval: the same "papers out" picture as a waiting one
    const atDesk = String(p.at) === "desk" && (p.stand === "desk" || p.stand == null); // ★89 at the desk AND arrived: go() sets p.at to the goal at once, one look before the walk starts (a person still in the aisle was drawn seated for one frame)
    const has = (k) => files[k] && (!Array.isArray(files[k]) || files[k].length);
    const pick = (...keys) => keys.find(has);
    const wait86 = l86WaitPose(!!this.scene?.l86); // ★101-8 the new floor: the sofa / nap picture is never used (see below)
    const moving = this.moving(p); // ★31-1: on the move (a transition is running) always wins: walk frames, never a still pose that slides
    if (!moving) p.walkT0 = null;
    if (moving) return this.walkPose(files, a.id, p); // available walking pictures first; a visible stand-in beats a blank frame
    if (seatlessWaiting(this.scene, a.id, p.at) && !(p.busy && Date.now() < p.busy)) { const k = pick("stand", "sit"); const v = k ? files[k] : null; return { key: k ?? "stand", frames: v ? (Array.isArray(v) ? [v[0]] : [v]) : [] }; } // ★102-7 no seat in the plan: only the plain standing picture (no raised hand, papers, sofa or nap), whatever the state
    if (p.standUntil && Date.now() < p.standUntil && !moving) return { key: "stand", frames: has("stand") ? [Array.isArray(files.stand) ? files.stand[0] : files.stand] : [] };
    if (p.sitBreak && files.cafe && !p.walking && !p.leaving) { // sitting at the corner with the coffee: front / back by the facing, mirrored for the other two directions
      const dir = String(p.facing ?? "dl"), back = dir.startsWith("u"), nm = `${p.sitBreak}_${back ? "b" : "f"}`, flip = back ? dir.endsWith("l") : dir.endsWith("r"), f = flip ? files.cafe.flip?.[nm] : files.cafe[nm];
      if (f) return { key: "stand", frames: [f] };
    }
    if (p.prop && files.prop) { // a prop in hand: _f faces down-left, _b up-right; the mirrored copies for the other two directions
      const sx = Math.sign(p.dx ?? 0), sy = Math.sign(p.dy ?? 0), dir = (p.walking && !p.bowing) ? (sy > 0 ? (sx > 0 ? "dr" : "dl") : sy < 0 ? (sx > 0 ? "ur" : "ul") : (sx > 0 ? "dr" : "dl")) : (p.facing ?? "dl");
      const back = String(dir).startsWith("u"), nm = `${p.prop}_${back ? "b" : "f"}`, flip = back ? String(dir).endsWith("l") : String(dir).endsWith("r"), f = flip ? files.prop.flip?.[nm] : files.prop[nm];
      if (f) return { key: "stand", frames: [f] };
    }
    if (this.scene?.l86 && atDesk && !p.walking && !p.leaving && !p.bowing && (a.status === "blocked" || a.status === "done")) { // ★86/★89: at the own desk: blocked = stands with the hand up, a report = stands holding the papers (before the seated reply-waiting picture below, which used to win for "done")
      const fr92 = a.status === "blocked" ? (files.prop?.wave_f ?? files.front_raise) : files.front_give; // ★92 turned toward the viewer (front, down-left): an EMPTY raised hand, palm shown (approval: wave_f; front_raise holds a paper and would be mistaken for a report) / the papers held out (report): they are noticed from the south
      if (fr92) return { key: "stand", pic: a.status === "blocked" ? (files.prop?.wave_f ? "wave_f" : "front_raise") : "front_give", frames: [Array.isArray(fr92) ? fr92[0] : fr92] };
      const sp88 = a.status === "blocked" ? files.prop?.wave_b : files.prop?.hold_b; // ★88-2 standing up at the desk (back to us, up-right)
      if (sp88) return { key: "stand", pic: a.status === "blocked" ? "wave_b" : "hold_b", frames: [sp88] };
      const k86 = a.status === "blocked" ? pick("raise", "hand_up", "stand") : pick("hold", "stand");
      if (k86) { const v86 = files[k86]; return { key: k86, frames: v86 ? (Array.isArray(v86) ? v86 : [v86]) : [] }; }
    }
    if (a.status === "idle" && atDesk && files.read_pc && this.scene?.seats) return { key: "read_pc", frames: [files.read_pc] }; // back at the desk after a break: leaning back in the chair
    if (a.status === "done" && atDesk && !p.walking && !p.leaving && !p.bowing && this.scene?.seats && (files.read_pc || files.type_pc) && replyWaiting(this.reps?.get(a.id), a, !!this.scene?.desks?.[a.id]?.seat)) {
      const k = files.read_pc ? "read_pc" : "type_pc"; return { key: k, frames: [files[k]] }; // ★29-1 waiting for a reply at the seat
    }
    let key;
    const head = (kind) => this.queueHead?.[kind] === a.id || String(p.at).endsWith(":0") && String(p.at).startsWith(kind);
    if (p.bowing && !moving && has("bow")) key = "bow"; // a bow before leaving the window
    else if (moving) { // left/down vs right/up
      const dl = (p.dy ?? 0) - (p.dx ?? 0) >= 0;
      key = dl ? pick("walk_dl", "walk_l", "walk", "stand") : pick("walk_ur", "walk", "walk_dl", "stand");
    } else if (/^(stand|wave|meet):/.test(String(p.at)) || p.at === "wave") key = pick("stand", "sit"); // (★66 meet: standing, talking) // at a copier / coffee point / the wave spot: standing
    else if ((p.at === "door" || String(p.at).startsWith("wait:")) && a.status !== "idle") key = pick("stand", "sit"); // waiting at the entrance for its desk to appear in the plan
    else if (a.status === "idle" && String(p.at).startsWith("beside@")) key = pick("stand", "sit");
    else if (a.status === "working" && this.scene?.desks && !this.atSeat(a, p)) key = pick("stand", "sit"); // a sitting picture only on the person's own seat, never anywhere else (the entrance, an island's edge ...)
    else if (a.status === "working") key = this.scene?.seats && has("type_pc") ? (p.reading && has("read_pc") ? "read_pc" : "type_pc") : pick("type", "sit", "stand"); // free address: the chair comes with the picture
    else if (a.status === "blocked" && has("front_wait")) key = has("front_raise") && (head("approval") || this.queueHead?.approval === undefined) ? "front_raise" : "front_wait";
    else if (a.status === "done" && has("front_wait")) key = head("counter") && has("front_give") ? "front_give" : "front_wait";
    else if (a.status === "blocked") key = this.scene?.spots?.facing === "front" ? pick("stand", "raise") : pick("raise", "hand_up", "stand");
    else if (a.status === "done") key = this.scene?.spots?.facing === "front" && !String(p.at).endsWith(":0") ? pick("stand", "hold") : pick("hold", "stand");
    else if (a.status === "idle" && this.standsAt(p.at)) key = pick("stand", "sit"); // no seat left: waits standing
    else if (wait86) key = wait86; // ★101-8 the new floor: never the sofa / nap pictures (waiting is the own desk's read_pc above, leaving is a walk from the seat to the door): anywhere else the person stands
    else if (p.loungeBreak) key = pick("sofa", "sit", "stand", "doze"); // ★77-1 a break in the break room: sitting with the cup, not dozing
    else if (a.long_idle) key = pick("doze", "sofa", "sit", "stand"); // a long wait: dozing in the armchair
    else key = pick("doze", "sofa", "sit", "stand"); // waiting: dozing in the armchair (★72-4)
    // Typing is one animated GIF (the two frames, played natively by image()): the picture itself does not move.
    let v = key ? files[key] : null;
    if (key === "stand" && !moving && (p.facing === "ul" || p.facing === "ur")) {
      const back = p.facing === "ul" ? files.prop?.flip?.stand_b : files.prop?.stand_b;
      const frames = this.poseFrames(back); if (frames.length) return { key: "stand", frames };
    }
    if (p.facing === "dr" && key && files.flip?.[key] && !moving) v = files.flip[key]; // the queue faces the window: the picture is mirrored (gpui cannot) // "type" is the list of its two pictures; person() picks one by the tick
    return { key: key ?? "stand", frames: v ? (Array.isArray(v) ? v : [v]) : [] };
  }

  person({ id, p, a, pos }, sc, ox, oy, k) {
    (this.drawn ??= new Map()).set(id, { pos: this.legs?.get(id)?.target ?? p.pos, at: p.at, mv: this.moving(p), t: Date.now(), seq: this.drawSeq }); // ★71-1 what this draw shows (only remembered here; compared in the live check's timer)
    const files = this.personFilesFor(id, sc);
    const { key, frames } = this.poseFiles(files, a, p);
    const ps = sc.pose_size?.[key] ?? sc.pose_size?.stand ?? sc.sprite ?? { w: 12, h: 20 };
    const sw = ps.w * k, sh = ps.h * k;
    const dur = this.transMs(p);
    const walking = this.moving(p);
    const period = 380 + (hash(id) % 260);
    // One picture always (no opacity change). Typing sways 1-2 px; walking bobs a little; the sofa doze breathes.
    const typing = !walking && a.status === "working";
    const mk0 = (nm) => this.lifeParts?.[nm];
    const sprite = div().relative().flex_none().w(sw).h(sh);
    if (!frames.length) sprite.child(div().size_full().rounded(3).bg(a.color ?? P.muted));
    frames.slice(0, 1).forEach((f) => { // typing: the first picture only (the code on the screen is what moves)
      const el = image(f).absolute().left(0).top(0).w(sw).h(sh);
      if (walking) el.loop("top", { from: 0, to: -Math.max(1, Math.min(2, 1.5 * k)), period: 280 + (hash(id) % 140) });
      // ★72-5 (office-live): no breathing for the armchair pictures (the chair is in the picture: it floated up and down over its shadow)
      sprite.child(el);
    });
    // ★92 everybody who is idle (waiting for an instruction) sits at the own desk with a RED mug in the resting hand (the read_pc picture has the hand on the knee at about 72% / 57% of the canvas; mirrored when the picture is)
    if (false && key === "read_pc" && !walking && !p.leaving && a.status === "idle" && String(p.at) === "desk" && !p.meet) { // ★95: the mug stands on the desk now (drawn with the desk things), not in the hand
      const ch = Math.max(8, sh * 0.11), cw = ch * 0.9, mir = p.facing === "dr", hx = mir ? 0.34 : 0.66, top = sh * 0.64 - ch;
      sprite.child(div().id(`mug-${id}`).absolute().left(sw * hx - cw / 2).top(top).w(cw).h(ch).rounded(Math.max(1.5, cw * 0.18)).bg("#d62828").border(1).border_color("#8f1414")
        .child(div().absolute().left(cw * 0.14).top(ch * 0.12).w(Math.max(1, cw * 0.18)).h(ch * 0.5).rounded(2).bg("#ff8a8a")))
        .child(div().id(`mug-h-${id}`).absolute().left(sw * hx + cw / 2 - 1).top(top + ch * 0.22).w(Math.max(2, cw * 0.32)).h(ch * 0.5).rounded(ch).border(Math.max(1.2, cw * 0.14)).border_color("#d62828"));
    }
    // Waiting for a long time: z-z-z over the head (text frames, not opacity).
    const mk = (nm) => this.lifeParts?.[nm], rr2 = this.markRatio ?? 0.26;
    const markName = null; // ★75-1 no coffee / paper mark over the head (the cup / paper in hand is part of the body picture); // ★38: no sprout / sweat / steam
    if (markName && mk(markName)?.file) { const q = mk(markName), mh = Math.min(sh * 0.4, q.h * rr2 * k * 1.6), mw = mh * q.w / q.h; // on the head, drifting a little (a loop on top, no new picture)
      sprite.child(image(q.file).id(`mk-${id}`).absolute().left((sw - mw) / 2).top(-mh - 4).w(mw).h(mh).loop("opacity", { from: 0.55, to: 1, period: 1400 })); }
    // ★75-1 no green ✓ over the head
    // ★76 the talk "…" is drawn in the front layer of the tag loop (talkBubble), above the state mark
    // ★75-1 no ×N over the head
    // ★75-1 nothing over the head but the talk
    return div().id(`person-${id}`).absolute().left(ox + pos[0] * k - sw / 2).top(oy + pos[1] * k - sh + (p.bowing && !(sc.people?.[id] ?? {}).bow ? Math.max(5, 7 * k) : 0)).w(sw).h(sh)
      .transition("left", { duration: dur, easing: "linear" }).transition("top", { duration: dur, easing: "linear" })
      .transition("opacity", { duration: 600, easing: "ease-in" }).opacity(p.fade ? 0 : 1) // the picture is never faded (only the tag is, for a long wait)
      .cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); }).on_click((_e, cx) => { if (!this.justDragged()) this.select(a, cx); })
      .on_hover((h, cx) => this.hoverOver(a.id, h, cx))
      .child(div().absolute().left(-6).top(-6).w(sw + 12).h(sh + 12)) // the click / hover area: the picture's frame + 6 px
      .child(sprite);
  }

  // State mark: a coloured disc with a glyph (! gear check pause), the same four everywhere.
  stateMark(st, size) {
    const g = { blocked: "!", working: "⚙", done: "✓", idle: "Ⅱ", shell: "⌛" }[st.key] ?? "·";
    if (st.key === "working") return div().flex_none().size(size).rounded(size).bg(st.color).flex().items_center().justify_center().child(icon("play", Math.round(size * 0.6), "#ffffff"));
    return div().flex_none().size(size).rounded(size).bg(st.color).flex().items_center().justify_center()
      .text_size(Math.round(size * 0.62)).font_weight(800).text_color("#ffffff").child(g);
  }

  // Usually a small tag (state mark + product name). Waiting for approval: a large bubble with a red count and a button.
  bubble(a, st, w, h, small, selected, team, shortText, fam = false, cmd = false) {
    const replying = a.status === "done" && String(this.people?.get(a.id)?.at) === "desk" && replyWaiting(this.reps?.get(a.id), a, !!this.scene?.desks?.[a.id]?.seat); // ★29-1 back at the seat after the report
    const away = a.status === "blocked" ? "자리 비움（승인）" : replying ? "답변 대기" : a.status === "done" ? "자리 비움（보고）" : null;
    const name = platform(a).name, border = selected ? 2 : 1.5;
    if (small) { // one line: state mark, session name, product icon; a small tail points at the person
      return v_flex().w(w).h(h).items_center()
        .child(h_flex().w_full().h(20).px(4).gap(4).items_center().rounded(10).bg(P.paper + "f2").border(fam && !selected ? 3 : border).border_color(fam && !selected ? st.color + "88" : st.color)
          .when(!!team, (e) => e.child(div().flex_none().w(4).h(14).rounded(2).bg(team)))
          .child(this.stateMark(st, 14))
          .when(cmd, (e) => e.child(div().flex_none().text_size(11).font_weight(700).text_color("#d4a017").child("★"))) // ★39 the commander (a parent with children)
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_size(11).font_weight(600).text_color(P.ink).child(shortText ?? this.shortName(a)))
          .when(!shortText && !!away, (e) => e.child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? "#A24E00" : st.color).child(away))) // 22nd 21-N6: 자리 비움（승인） in a dark orange (#F28C28 on the pale tag was hard to read); the size stays
          .when(!shortText && !away && !!this.elapsedText(a), (e) => e.child(div().flex_none().text_size(11).text_color(st.color).child(this.elapsedText(a))))
          .when(!shortText, (e) => e.child(platformIcon(a, 12))))
        .child(div().h(7).text_size(8).text_color(st.color).child("▼"));
    }
    const go = a.source === "app" ? (_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: a.address }); } : (_e, cx) => this.select(a, cx);
    const ask = String(blockedText(a)).split("\n")[0];
    return h_flex().w(w).h(h).px(8).gap(8).items_center().rounded(12).bg(P.paper).border(2).border_color(st.color)
      .when(!!team, (e) => e.child(div().flex_none().w(4).h(h - 14).rounded(2).bg(team)))
      .child(this.stateMark(st, 26).loop("opacity", { from: 0.55, to: 1, period: 900 })) // the only blinking thing
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(5).items_center().child(platformIcon(a, 12))
          .when(cmd, (e) => e.child(div().flex_none().text_size(12).font_weight(700).text_color("#d4a017").child("★")))
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(700).text_color(P.ink).child(this.shortName(a)))
          .child(div().flex_none().text_size(10).font_weight(600).text_color(st.color).child(this.elapsedText(a))))
        .child(h_flex().gap(6).items_end()
          .child(div().flex_1().min_w(0).text_size(10).font_weight(600).text_color(st.color)
            .child(ask))
          .child(div().id(`approve-${a.id}`).flex_none().px(8).py(2).rounded(8).bg(st.color).text_size(10).font_weight(700).text_color("#ffffff")
            .cursor_pointer().on_click(go).child("승인"))));
  }

  // The session name, cut short for a tag.
  // ★26-4 the picture of the clerk of a window: one of the scene's people (a stable one per window), the `staff_sit` pose, turned when the scene says so.
  staffPicture(kind, sc, stf) {
    const ids = Object.keys(sc.people ?? {}).filter((i) => sc.people[i]?.staff_sit).sort();
    if (!ids.length || !stf?.xy) return null;
    const p = sc.people[ids[(kind === "approval" ? 0 : 1) % ids.length]], file = stf.flip ? (p.flip?.staff_sit ?? p.staff_sit) : p.staff_sit, ps = sc.pose_size?.staff_sit ?? sc.pose_size?.stand;
    return file && ps ? { file, w: ps.w, h: ps.h } : null;
  }

  // ★101-6 one disc, drawn the same in the legend as over a head: a colour ball with a white glyph and a white rim.
  markDisc(txt, col, R) {
    return div().w(2 * R).h(2 * R).rounded(2 * R).bg(col).border(2).border_color("#ffffff").flex().items_center().justify_center().text_size(Math.round(2.0 * R)).font_weight(900).text_color("#ffffff").child(txt);
  }

  // ★51-3 how far down the picture the head top is (1 = the top of the picture): a person sitting at a desk or in a chair has the PC / chair / papers above the head in the picture.
  // ★72-2 (office-live) the mark over a head without a tag: a colour dot; a parent (somebody with children here) a larger gold ★ instead
  // ★76 the state mark over the head: blue dot (working), orange ! (waiting for approval), green ✓ (report). No ★ (a parent: the gold ring at the feet). Idle: none.
  headMark(a, list, st, d) {
    // ★92 an approval must be noticed: a big dark-orange disc with a white "!" that hops and pulses (native loops: no redraw); a report's "✓" is smaller and hops a little less
    const disc = (txt, col, R, hop, period) => { const top0 = -2 * R - 4; return this.markDisc(txt, col, R).absolute().left(-R).top(top0)
      .loop("top", { from: top0, to: top0 - hop, period }).loop("opacity", { from: txt === "!" ? 0.6 : 0.85, to: 1, period: Math.round(period * 1.5) }); }; // ★92 the hop and the pulse have different periods (in step, the disc was high only when bright: the hop looked like 2 px)
    if (a.status === "blocked") return disc("!", "#d9480f", d * 1.35, Math.max(11, d * 1.4), 520); // the App showed the old hop (0.9 d, 8 px at d = 9) as about 2 px between most frames: now 11 px or 1.4 d
    if (a.status === "done") return disc("✓", "#1f9d55", d * 0.95, d * 0.4, 900);
    if (a.status === "working") return div().absolute().left(-d / 2).top(-d - 4).w(d).h(d).rounded(d).bg(st.color).border(2).border_color("#ffffff");
    return null;
  }

  // ★101-7 the bubble's box for a head at (hx, hy): right over the head, whatever the state (a mark may go under it); dx only when two bubbles would overlap.
  talkBox(talk, hx, hy, d, status = "working", dx = 0) {
    const bw = talk.mine ? 40 : 28, bh = talk.mine ? 22 : 16;
    return { x: hx - bw / 2 + dx, y: hy - bh - 6, w: bw, h: bh };
  }
  talkBubble(id, p, hx, hy, d, status = "working", dx = 0) {
    const talk = this.meetBubble?.(id, p); if (!talk) return null;
    const bw = talk.mine ? 40 : 28, bh = talk.mine ? 22 : 16, dw = talk.mine ? 9 : 6, ts = talk.mine ? 13 : 9, bx = this.talkBox(talk, hx, hy, d, status, dx);
    const bubble = div().id(`talk-${id}`).absolute().left(bx.x).top(bx.y).w(bw).h(bh).flex().items_center().justify_center().gap(1).rounded(11).bg("#1b2637").border(1.5).border_color("#c9c2b2").opacity(talk.mine ? 1 : 0.5); // ★70-3 three dots lit 1 -> 2 -> 3 in turn
    for (const n of TALK_DOTS) bubble.child(div().id(`talk-${id}-${n}`).w(dw).h(bh - 4).flex().items_center().justify_center().text_size(ts).font_weight(800).text_color("#cad5e4").frames(talkDotFrames(n), TALK_DOT_MS));
    // ★101-7 a small tail under the middle pointing at the speaker's head (-dx: the tail stays on the head when the bubble stepped aside)
    bubble.child(div().absolute().left(bw / 2 - 5 - dx).top(bh - 6).w(10).h(7).flex().items_center().justify_center().text_size(9).font_weight(900).text_color("#c9c2b2").child("▾"));
    return bubble;
  }

  headFrac(id, a, p, sc) { try { const key = this.poseFiles(this.personFilesFor(id, sc), a, p).key; return /sofa|doze/.test(String(key)) ? 0.84 : /pc|sit/.test(String(key)) ? 0.66 : 0.95; } catch { return 1; } } // ★72-4 the armchair pictures: over the head top (the Zzz sat on the forehead)

  // The agent's name for a tag (10-12 characters); no name: the terminal's title.
  workTitle(a, full = false) {
    const nm = String(a.name || a.address || ""), t = String(a.title ?? "").trim(), use = nm && nm !== a.address ? nm : (t || nm); // ★50-2 the agent's name first (office-c8); the terminal's title only when it has no name
    return clipName(use, full ? NAME_EM_FULL : NAME_EM); // ★88-6 the tag: about 12 full-width letters + "…" (the same rule everywhere: ui-rules.clipName); full = hover / chosen
  }

  shortName(a) {
    return clipName(String(a.name || a.title || a.address || ""), NAME_EM_FULL); // ★88-6 (was 22 letters with the end kept): the same cut as everywhere; the shown boxes truncate by width as well
  }

  // Minutes in this state, short ("12分", "2時間"); a child that reported back shows 대기 중・보고 완료 (13th D3: the top chip says 대기 중 for the same person).
  elapsedText(a) {
    if (a.handed_back && a.status === "idle") return "대기 중・보고 완료";
    const m = Math.floor((Date.now() - (a.since ?? Date.now())) / 60000);
    if (m < 1) return "";
    return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간`;
  }

  // Pointing at someone (or its tag): product, the latest line, how long, the model, and the way into the conversation.
  hoverOver(id, inside, cx) {
    if (inside) { this.hoverId = id; this.hoverGone = (this.hoverGone ?? 0) + 1; cx.notify(); return; }
    const n = (this.hoverGone = (this.hoverGone ?? 0) + 1);
    cx.timer.after(350, (cx) => { if (this.hoverGone === n && !this.cardIn) { this.hoverId = null; cx.notify(); } });
  }

  hoverCard(a, r, left) {
    const st = stateOf(a), W = 224, H = 132, mins = Math.max(0, Math.floor((Date.now() - (a.since ?? Date.now())) / 60000));
    const say = a.status === "blocked" ? blockedText(a) : (a.name || a.title || a.address);
    const x = Math.max(6, Math.min(left.width - W - 6, r.x + r.w / 2 - W / 2));
    const y = r.y - H - 6 >= 4 ? r.y - H - 6 : r.y + r.h + 6;
    const frac = Math.min(1, mins / 60); // no progress data: the bar is the time in this state (full at an hour)
    return v_flex().id("hover-card").absolute().left(x).top(y).w(W).h(H).p(10).gap(6).rounded(12).bg(P.paper).border(1).border_color("#3b4b60")
      .on_hover((h, cx) => { this.cardIn = h; if (!h) this.hoverOver(a.id, false, cx); })
      .child(h_flex().gap(6).items_center().child(this.stateMark(st, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(700).text_color(P.ink).child(platform(a).name))
        .child(div().flex_none().text_size(10).text_color(P.muted).child(a.model_label ?? "")))
      .child(div().truncate().text_size(11).text_color(P.ink).child(say))
      .child(v_flex().gap(3)
        .child(div().w_full().h(5).rounded(3).bg("#ece8dd").child(div().h_full().w(Math.max(4, (W - 20) * frac)).rounded(3).bg(st.color)))
        .child(div().text_size(10).text_color(P.muted).child(`${st.label}${a.unknown ? "?" : ""} ${mins}분`)))
      .child(div().id("hover-open").w_full().h(26).flex().items_center().justify_center().rounded(8).bg("#1e6fe0").cursor_pointer()
        .on_click((_e, cx) => { this.cardIn = false; this.hoverId = null; this.select(a, cx); })
        .child(div().text_size(11).font_weight(700).text_color("#ffffff").child("대화 열기")));
  }

  // ---------------------------------------------------------------- selection and side panel
  // The person that was clicked / picked, else nobody.
  selected(list) {
    return this.selId && list.some((a) => a.id === this.selId) ? this.selId : null; // nobody is chosen until a click or pick
  }

  select(a, cx) {
    cx.stop_propagation(); // not also a click on the empty floor
    if (a.source === "app" && a.address && !(shared("hakoniwa.demo") || this.feed.config?.demo)) {
      openTerminalWindow(a.address, a.name || a.title || a.address);
      this.selId = a.id; this.panel = null; this.open = false; this.termPick = null;
      setShared("hakoniwa.sel", a.id); cx.notify(); return;
    }
    this.selId = a.id; this.panel = null; this.open = false;
    setShared("hakoniwa.sel", a.id); // the band's "+ エージェントを立てる" starts in the chosen person's space
    if (this.termKey && this.termKey.split("|")[0] !== a.id) this.termKey = null; // another person: the terminal window is opened again (the same key replaces the open one)
    this.focusH ??= cx.focus_handle();
    cx.timer.after(80, () => this.focusH?.focus()); // so Esc reaches the panel
    cx.notify();
  }

  // ★82 the focused terminal became `ft`: an App person's -> that person is chosen and open (true); the person already open, a picked shell, or anyone else -> nothing (false).
  focusToPerson(ft, list) {
    if (this.termPick?.address === ft) return false;
    const a = (list ?? []).find((x) => x.source === "app" && x.address === ft);
    if (!a || (this.open && this.selId === a.id)) return false;
    this.selId = a.id; this.panel = null; this.open = true; this.termPick = null;
    if (this.termKey && this.termKey.split("|")[0] !== a.id) this.termKey = null;
    return true;
  }

  closePanel(cx) { this.open = false; this.termPick = null; this.selId = null; setShared("hakoniwa.sel", null); cx.notify(); } // ★81 Esc / the empty floor also end a terminal picked from the left list // ★100-3 closing the panel ends the choice too (a chosen leader's tag stayed for ever)
}
