// node --test hansol/tests/git_rules.test.mjs   (the Git window's pure rules: hansol/mods/hansol/git-rules.js)
import test from "node:test";
import assert from "node:assert/strict";
import { parseStatus, workDiffArgs, pushArgs, parseBranches, canSwitch, remoteInfo, parseListening, envMissing, envKeys, packageScripts } from "../mods/hansol/git-rules.js";

test("parseStatus: staged, changed, untracked, renames", () => {
  const s = parseStatus("M  a.js\0 M b.js\0MM c.js\0?? new.txt\0R  to.js\0from.js\0 D gone.js\0");
  assert.deepEqual(s.map((x) => [x.path, x.staged, x.changed, x.untracked]), [["a.js", true, false, false], ["b.js", false, true, false], ["c.js", true, true, false], ["new.txt", false, true, true], ["to.js", true, false, false], ["gone.js", false, true, false]]);
  assert.equal(s[4].from, "from.js");
  assert.deepEqual(parseStatus(""), []);
});

test("workDiffArgs: the index side only for a staged-only file, no-index for a new file", () => {
  const [a, b, , d] = parseStatus("M  a.js\0 M b.js\0MM c.js\0?? n.txt\0");
  assert.ok(workDiffArgs(a).includes("--cached")); assert.ok(!workDiffArgs(b).includes("--cached"));
  assert.deepEqual(workDiffArgs(d).slice(-4), ["--no-index", "--", "/dev/null", "n.txt"]);
});

test("pushArgs / canSwitch / parseBranches", () => {
  assert.deepEqual(pushArgs("origin/main", ["origin"], "main"), ["push"]);
  assert.deepEqual(pushArgs(null, ["up", "origin"], "feat"), ["push", "-u", "origin", "feat"]);
  assert.deepEqual(pushArgs(null, ["up"], "feat"), ["push", "-u", "up", "feat"]);
  assert.equal(pushArgs(null, [], "feat"), null);
  assert.equal(canSwitch(parseStatus("?? x\0")), true); assert.equal(canSwitch(parseStatus(" M x\0")), false);
  assert.deepEqual(parseBranches("*\0main\0origin/main\n \0dev\0\n"), [{ name: "main", head: true, upstream: "origin/main" }, { name: "dev", head: false, upstream: null }]);
});

test("remoteInfo: github / gitlab, https and ssh", () => {
  assert.deepEqual(remoteInfo("https://github.com/evelynn/x.git"), { kind: "github", host: "github.com", path: "evelynn/x", web: "https://github.com/evelynn/x" });
  assert.equal(remoteInfo("git@github.com:a/b.git").kind, "github");
  const g = remoteInfo("https://user@gitlab.hansol.net/hansol-pns/mes/mes-fe.git");
  assert.equal(g.kind, "gitlab"); assert.equal(g.path, "hansol-pns/mes/mes-fe");
  assert.equal(remoteInfo("ssh://git@gitlab.hansol.net:2222/140420/a.git").path, "140420/a");
  assert.equal(remoteInfo("C:/repos/x"), null);
});

test("parseListening: one row per port, with the program's name", () => {
  const ns = "  Proto  Local Address  Foreign Address  State  PID\r\n  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   1100\r\n  TCP    127.0.0.1:5173  0.0.0.0:0  LISTENING  42\r\n  TCP    [::]:135  [::]:0  LISTENING  1100\r\n  TCP    10.0.0.2:5000  1.2.3.4:443  ESTABLISHED  7\r\n";
  const tl = '"svchost.exe","1100","Services","0","10,000 K"\r\n"node.exe","42","Console","1","90,000 K"\r\n';
  assert.deepEqual(parseListening(ns, tl), [{ port: 135, addr: "0.0.0.0", pid: 1100, name: "svchost.exe" }, { port: 5173, addr: "127.0.0.1", pid: 42, name: "node.exe" }]);
});

test("envMissing / packageScripts", () => {
  assert.deepEqual(envKeys("# c\nA=1\nexport B = 2\n  C=\nbad line\n"), ["A", "B", "C"]);
  assert.deepEqual(envMissing("A=\nB=\nC=\n", "A=x\nC=y\n"), ["B"]);
  assert.deepEqual(packageScripts('{"scripts":{"dev":"vite","test":"node --test"}}'), [{ name: "dev", cmd: "vite" }, { name: "test", cmd: "node --test" }]);
  assert.deepEqual(packageScripts("{broken"), []);
});
