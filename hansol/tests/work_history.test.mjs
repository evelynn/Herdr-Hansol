// node --test hansol/tests/work_history.test.mjs   (AGENT STATUS / BOARD: the work done so far, without repeats; mosses-model.js)
import test from "node:test";
import assert from "node:assert/strict";
import { sameWork, pushWork, pastWork } from "../mods/hansol/mosses-model.js";

test("sameWork: equal, cut short with …, spaces", () => {
  assert.ok(sameWork("레포트 전수조사 개발 배포 진행 현황", "레포트 전수조사 개발…"));
  assert.ok(sameWork("a  b c d", "a b c d"));
  assert.ok(!sameWork("빌드 확인", "배포 확인")); assert.ok(!sameWork("", "")); assert.ok(!sameWork("ab", "abc"));
});

test("pushWork: a work coming back moves to the end, no copies", () => {
  const h = [];
  for (const [t, at] of [["A 작업 하나", 1], ["B 작업 둘", 2], ["A 작업 하나", 3], ["B 작업…", 4], ["C 작업 셋", 5]]) pushWork(h, t, at);
  assert.deepEqual(h.map((e) => [e.text, e.at]), [["A 작업 하나", 3], ["B 작업 둘", 4], ["C 작업 셋", 5]]);
});

test("pastWork: three different works before the current one, newest first (old repeating lists too)", () => {
  const h = ["mosses-board-git-tools", "레포트 전수조사 개발 배포 진행 현황", "mosses-board-git-tools", "3D 이동이 제대로안됨", "mosses-board-git-tools", "레포트 전수조사 개발…", "지금 하는 일"].map((text, at) => ({ at, text }));
  assert.deepEqual(pastWork(h, "지금 하는 일", 3).map((e) => e.text), ["레포트 전수조사 개발…", "mosses-board-git-tools", "3D 이동이 제대로안됨"]);
  assert.deepEqual(pastWork([], "x", 3), []);
});
