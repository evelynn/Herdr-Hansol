// node --test hansol/tests/mosses_model.test.mjs   (the MOSSES layout's pure part: hansol/mods/hansol/mosses-model.js)
import test from "node:test";
import assert from "node:assert/strict";
import { STAGE, starGroups, stageFit, starPlaces, SLOTS, orbitR, planetPlace, typed, matCurve, popCurve, warpCurve, mailList, stateCounts, newsSince, cut, say, mossState, planetFor, PLANETS, orderSystems, moveOrder, warpLines, planetsFor, ringsAr, warpVeil } from "../mods/hansol/mosses-model.js";

test("planetsFor: every work space its own look (up to PLANETS), the same in any order", () => {
  const keys = ["app:Hansol-KB", "app:Herdr-Hansol", "app:MX-MES", "app:Bridge-X-V2"]; // these four hash onto two looks
  const a = planetsFor(keys), b = planetsFor([...keys].reverse());
  assert.equal(new Set(a.values()).size, 4);
  assert.deepEqual([...a].sort(), [...b].sort());
  const many = planetsFor(Array.from({ length: 30 }, (_, i) => `k${i}`));
  assert.equal(new Set([...many.values()].slice(0, PLANETS)).size, PLANETS);
  for (const p of many.values()) assert.ok(p >= 0 && p < PLANETS);
});

test("ringsAr: growing outwards, the planet's room kept, taller tilt = smaller orbits only when the room up and down binds", () => {
  const a = ringsAr(300, 120, 50, 3, 0.42), b = ringsAr(300, 120, 50, 3, 0.9);
  assert.equal(a.length, 3); assert.ok(a[0] < a[1] && a[1] < a[2]); assert.equal(a[0], 87.5);
  assert.ok(b[2] < a[2] && b[2] * 0.9 <= 120 + 1e-9);
  assert.deepEqual(ringsAr(300, 120, 50, 0, 0.42), []);
  assert.equal(ringsAr(300, 900, 50, 1, 0.42)[0], 87.5 + (300 - 87.5) * 0.85);
});

test("warpVeil: clear at the ends, fully covered at the switch", () => {
  assert.equal(warpVeil(0), 0); assert.equal(warpVeil(0.5), 1); assert.equal(warpVeil(1), 0);
  for (let p = 0; p <= 1; p += 0.02) { const v = warpVeil(p); assert.ok(v >= 0 && v <= 1); }
});

test("orderSystems / moveOrder: the person's order first, new systems after in their own order", () => {
  const S = ["a", "b", "c", "d"].map((key) => ({ key }));
  assert.deepEqual(orderSystems(S, null).map((s) => s.key), ["a", "b", "c", "d"]);
  assert.deepEqual(orderSystems(S, ["c", "gone", "a"]).map((s) => s.key), ["c", "a", "b", "d"]);
  assert.deepEqual(moveOrder(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveOrder(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveOrder(["a", "b"], 1, 9), ["a", "b"]);
  assert.deepEqual(moveOrder([], 0, 1), []);
});

test("warpLines: streaks grow outward with p, fall back inward, and stay finite", () => {
  const len = (L) => L.reduce((n, [[x0, y0], [x1, y1]]) => n + Math.hypot(x1 - x0, y1 - y0), 0);
  const a = warpLines(0.1, 80, 500, 300, 800), b = warpLines(0.6, 80, 500, 300, 800);
  assert.ok(a.length > 60 && len(b) > len(a) * 3);
  assert.deepEqual(warpLines(0.6, 80, 500, 300, 800, true), warpLines(0.4, 80, 500, 300, 800));
  for (const p of [0, 0.5, 1, 1.4]) for (const seg of warpLines(p, 80, 0, 0, 800)) for (const v of seg.flat()) assert.ok(Number.isFinite(v));
});

test("starGroups: one star per island, tabs in first-met order, agents by id", () => {
  const g = starGroups([
    { id: "b", island: "i2", island_title: "Beta", tab: "t1" }, { id: "a", island: "i1", island_title: "Alpha", tab: "x" },
    { id: "c", island: "i1", island_title: "Alpha", tab: "y" }, { id: "d", island: "i1", island_title: "Alpha", tab: "x" }, { id: "e", source: "tui" },
  ]);
  assert.deepEqual(g.map((s) => s.title), ["Alpha", "Beta", "tui"]);
  assert.deepEqual(g[0].tabs, [{ name: "x", ids: ["a", "d"] }, { name: "y", ids: ["c"] }]);
  assert.equal(g[2].key, "src:tui");
  assert.deepEqual(starGroups([]), []);
});

test("stageFit: the whole stage fits and is centred", () => {
  for (const [W, H, x0] of [[1280, 800, 0], [1920, 1000, 0], [900, 900, 36], [600, 300, 0]]) {
    const { s, ox, oy } = stageFit(W, H, x0);
    assert.ok(STAGE.w * s <= W + 1 && STAGE.h * s <= H + 1, `${W}x${H}`);
    assert.ok(ox >= x0 - 1 && oy >= -1, `${W}x${H}`);
    assert.ok(Math.abs(ox - x0 - (W - STAGE.w * s) / 2) <= 1);
  }
  assert.equal(stageFit(4000, 3000).s, 1.6);
});

test("starPlaces: distinct places inside the stage for up to 30 stars", () => {
  for (const n of [0, 1, 5, 16, 30]) {
    const p = starPlaces(n);
    assert.equal(p.length, n);
    assert.equal(new Set(p.map((q) => `${q.x},${q.y}`)).size, n);
    for (const q of p) assert.ok(q.x > 40 && q.x < 1240 && q.y > 40 && q.y < 700, JSON.stringify(q));
  }
  assert.deepEqual(starPlaces(2), SLOTS.slice(0, 2).map(([x, y]) => ({ x, y })));
});

test("orbits: one tab 230 x 70, outermost within 560 x 250, growing outwards", () => {
  assert.deepEqual(orbitR(0, 1), [230, 70]);
  for (const n of [2, 3, 6, 12]) {
    let last = 0;
    for (let i = 0; i < n; i++) { const [rx, ry] = orbitR(i, n); assert.ok(rx > last && rx <= 560 && ry <= 250); last = rx; }
  }
});

test("planetPlace: on its ellipse, moves with time, front = lower half", () => {
  const p = planetPlace(1, 2, 0, 3, 10), [rx, ry] = orbitR(1, 2);
  assert.ok(Math.abs(((p.x - 640) / rx) ** 2 + ((p.y - 330) / ry) ** 2 - 1) < 0.01);
  assert.notDeepEqual(planetPlace(0, 1, 0, 1, 0), planetPlace(0, 1, 0, 1, 5));
  assert.equal(p.front, p.y >= 330);
});

test("typed: two characters per 26 ms, by character", () => {
  assert.deepEqual(typed("가나다라", 0), { text: "", done: false });
  assert.deepEqual(typed("가나다라", 26), { text: "가나", done: false });
  assert.deepEqual(typed("가나다라", 999), { text: "가나다라", done: true });
  assert.equal(typed("😀😀", 13).text, "😀");
  assert.deepEqual(typed("", 0), { text: "", done: true });
});

test("curves: start closed, end open, stay in 0..1", () => {
  assert.deepEqual(matCurve(0), { w: 0, h: 0, o: 0 });
  assert.deepEqual(matCurve(1.2), { w: 1, h: 1, o: 1 });
  assert.deepEqual(popCurve(-1), { w: 0, h: 0 });
  assert.deepEqual(popCurve(1), { w: 1, h: 1 });
  for (let p = -0.5; p <= 1.5; p += 0.05) {
    for (const v of [...Object.values(matCurve(p)), ...Object.values(popCurve(p)), ...Object.values(warpCurve(p)).filter((x, i) => i !== 2)]) assert.ok(v >= 0 && v <= 1, `${p}: ${v}`);
  }
  assert.equal(warpCurve(0).out, 1); assert.equal(warpCurve(1).into, 1); assert.equal(warpCurve(1).flash, 0);
});

test("mailList, stateCounts, mossState", () => {
  const L = [{ id: "a", status: "blocked", since: 5 }, { id: "b", status: "working" }, { id: "c", status: "blocked", since: 2 }, { id: "d", status: "weird" }, { id: "e", status: "idle" }];
  assert.deepEqual(mailList(L).map((a) => a.id), ["c", "a"]);
  assert.deepEqual(stateCounts(L, (a) => (a.id === "e" ? "shell" : "")), { working: 1, blocked: 2, done: 0, idle: 1, shell: 1 });
  assert.equal(mossState("done", ""), "done"); assert.equal(mossState("working", "shell"), "shell"); assert.equal(mossState(undefined, ""), "idle");
});

test("newsSince: nothing the first time, then new asks and new reports", () => {
  const a = newsSince(null, [{ id: "a", status: "blocked" }]);
  assert.deepEqual(a.news, []);
  const b = newsSince(a.next, [{ id: "a", status: "blocked" }, { id: "b", status: "blocked" }, { id: "c", status: "done" }]);
  assert.deepEqual(b.news, [{ kind: "ask", id: "b" }]); // c is new and already done: not news
  const c = newsSince(b.next, [{ id: "a", status: "working" }, { id: "b", status: "blocked" }, { id: "c", status: "done" }]);
  assert.deepEqual(c.news, []);
  const d = newsSince(c.next, [{ id: "a", status: "done" }]);
  assert.deepEqual(d.news, [{ kind: "done", id: "a" }]);
});

test("cut, say, planetFor", () => {
  assert.equal(cut("abcdef", 4), "abc…"); assert.equal(cut("abc", 4), "abc"); assert.equal(cut(null, 3), "");
  assert.equal(say("warpDone", { s: "MX" }), "MX 항성계에 도착했습니다. 워프가 종료되었습니다.");
  for (const id of ["a", "b", "x/1/2"]) { const k = planetFor(id); assert.ok(k >= 0 && k < PLANETS); assert.equal(planetFor(id), k); }
});
