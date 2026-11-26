// approve.js answerOnce / answerLocked: one answer per question across the surfaces (2026-11-26).
//   node --test hansol/tests/answer_once.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerOnce, answerLocked, ANSWER_HOLD_MS, ANSWER_BUSY_MAX_MS } from "../mods/hansol/approve.js";

const SCREEN = "Do you want to run this?\n 1. Yes\n 2. No\n";
function rig({ after = "working", keysCode = 0, screen = SCREEN, hang = false } = {}) {
  let all = {}, keys = 0, gets = 0;
  const store = { get: () => all, set: (v) => { all = v; } };
  const io = {
    sleep: (ms) => (ms >= 10000 ? (hang ? Promise.resolve() : new Promise(() => {})) : new Promise((r) => setTimeout(r, 5))), // (the give-up timer fires only in the "hang" case)
    hc: async (args) => {
      if (args[0] === "read") return { code: 0, stdout: screen };
      if (args[0] === "keys") { keys++; if (hang) await new Promise(() => {}); return { code: keysCode, stdout: "", stderr: keysCode ? "boom" : "" }; }
      gets++; return { code: 0, stdout: JSON.stringify({ status: { state: gets % 2 === 1 ? "blocked" : after, msg: "m" } }) }; // (before the key: blocked; after it: `after`)
    },
  };
  return { store, io, sent: () => keys, all: () => all };
}

test("answerLocked: busy and hold windows", () => {
  const now = 1_000_000;
  assert.equal(answerLocked(undefined, now), false);
  assert.equal(answerLocked({ at: now - 1000, busy: true }, now), true);
  assert.equal(answerLocked({ at: now - ANSWER_BUSY_MAX_MS - 1, busy: true }, now), false);
  assert.equal(answerLocked({ at: now - ANSWER_HOLD_MS + 10 }, now), true);
  assert.equal(answerLocked({ at: now - ANSWER_HOLD_MS - 10 }, now), false);
  assert.equal(answerLocked(now - 100, now), true); // an old record (a bare time)
});

test("two presses at once (two surfaces): one key", async () => {
  const r = rig();
  const [a, b] = await Promise.all([answerOnce(r.io, r.store, "t1", "yes"), answerOnce(r.io, r.store, "t1", "yes")]);
  assert.equal(r.sent(), 1);
  assert.deepEqual([a.ok, b.reason], [true, "locked"]);
  assert.equal(answerLocked(r.all().t1), true); // held after the answer
});

test("a press right after an answer is refused; another address is not", async () => {
  const r = rig();
  await answerOnce(r.io, r.store, "t1", "yes");
  assert.equal((await answerOnce(r.io, r.store, "t1", "no")).reason, "locked");
  assert.equal((await answerOnce(r.io, r.store, "t2", "yes")).ok, true);
  assert.equal(r.sent(), 2);
});

test("a key that was not sent frees the lock at once", async () => {
  for (const o of [{ keysCode: 1 }, { screen: "no numbered lines here" }]) {
    const r = rig(o);
    const res = await answerOnce(r.io, r.store, "t1", "yes");
    assert.equal(res.ok, false);
    assert.equal(answerLocked(r.all().t1), false);
  }
});

test("sent but the state did not move: the lock stays (no second key on a question nobody read)", async () => {
  const r = rig({ after: "blocked" });
  const res = await answerOnce(r.io, r.store, "t1", "yes");
  assert.deepEqual([res.ok, res.reason, r.sent()], [false, "unchanged", 1]);
  assert.equal(answerLocked(r.all().t1), true);
  assert.equal((await answerOnce(r.io, r.store, "t1", "yes")).reason, "locked");
  assert.equal(r.sent(), 1);
});

test("an hc call that never returns: given up, the lock is the short hold (not for ever)", async () => {
  const r = rig({ hang: true });
  const res = await answerOnce(r.io, r.store, "t1", "yes");
  assert.equal(res.reason, "timeout");
  assert.equal(r.all().t1.busy, undefined);
});

test("a choice by its number: sent only while the screen still shows it with the same words", async () => {
  const scr = "Do you want to run this?\n 1. Yes\n 2. Yes, and don't ask again\n 3. No\n";
  const r = rig({ screen: scr });
  assert.equal((await answerOnce(r.io, r.store, "t1", { n: 2, label: "Yes, and don't ask again" })).key, 2);
  const r2 = rig({ screen: scr });
  const res = await answerOnce(r2.io, r2.store, "t1", { n: 2, label: "No" }); // the screen changed under the button
  assert.deepEqual([res.ok, res.reason, r2.sent()], [false, "no-option", 0]);
});
