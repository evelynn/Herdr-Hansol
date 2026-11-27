// node --test hansol/tests/cluster_layout.test.mjs   (MOSSES OVERVIEW: the work spaces placed in 3D, mosses-model.js)
import test from "node:test";
import assert from "node:assert/strict";
import { clusterHome, clusterView, clusterPoint, clusterRooms, clusterDrop } from "../mods/hansol/mosses-model.js";

const SZ = [598, 230], sizes = (n) => Array.from({ length: n }, () => SZ); // a system's box at full size (mosses.js clusterSize, 2 plates)
const homes = (n) => Array.from({ length: n }, (_, i) => clusterHome(i, n, `space-${i}`));
const core = (r, k = 0.94) => ({ x: r.x + (r.w * (1 - k)) / 2, y: r.y + (r.h * (1 - k)) / 2, w: r.w * k, h: r.h * k }); // rooms may meet at their empty edges
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

test("clusterPoint undoes clusterView", () => {
  for (const P of [[0.3, -0.5, 0.2], [-0.9, 0.1, -0.4]]) for (const yaw of [0, 1.1, -2.5]) for (const T of [0.12, 0.42, 0.9]) {
    const q = clusterView(P, yaw, T); clusterPoint(q.h, q.v, q.z, yaw, T).forEach((x, k) => assert.ok(Math.abs(x - P[k]) < 1e-9));
  }
});

test("rooms: full size up to 4 spaces, on the screen and apart (1..6 spaces, any turn), not in rows", () => {
  const W = 1440, H = 940; // the RADAR scene on a 1920 x 1152 window
  for (let n = 1; n <= 6; n++) for (const yaw of [0, 0.7, 1.6, 3.1, -2]) for (const T of [0.12, 0.42, 0.9]) {
    const R = clusterRooms(homes(n), yaw, T, W, H, sizes(n));
    for (const r of R) { assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5, `n=${n} off screen`); assert.ok(r.f > 0.5 && r.f <= 1); }
    if (n <= 4) assert.ok(R.every((r) => r.f === 1), `n=${n} yaw=${yaw} T=${T}: shrunk to ${Math.min(...R.map((r) => r.f)).toFixed(2)}`);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(overlap(core(R[i]), core(R[j])) === 0, `n=${n} yaw=${yaw} T=${T}: rooms ${i},${j} overlap`);
  }
  const R = clusterRooms(homes(4), 0, 0.42, W, H, sizes(4)), ys = new Set(R.map((r) => Math.round(r.y / 20))), xs = new Set(R.map((r) => Math.round(r.x / 20)));
  assert.ok(ys.size >= 3 && xs.size >= 3, "4 spaces are not a 2 x 2 table");
});

test("turning moves the stars; the spread does not zoom", () => {
  const Ps = homes(3), a = clusterRooms(Ps, 0, 0.42, 1400, 900, sizes(3)), b = clusterRooms(Ps, 1.2, 0.42, 1400, 900, sizes(3));
  assert.ok(a.some((r, i) => Math.abs(r.x - b[i].x) > 40), "a turn moves the rooms");
});

test("clusterDrop: a star lands where it is let go", () => {
  const W = 1400, H = 900, Ps = homes(3), yaw = 0.5, T = 0.42;
  const R = clusterRooms(Ps, yaw, T, W, H, sizes(3)), r = R[1], to = [r.x + r.w / 2 - 60, r.y + r.h / 2 + 30];
  const P = clusterDrop(Ps, 1, ...to, yaw, T, W, H, sizes(3)), R2 = clusterRooms(Ps.map((q, i) => (i === 1 ? P : q)), yaw, T, W, H, sizes(3));
  assert.ok(Math.hypot(R2[1].x + R2[1].w / 2 - to[0], R2[1].y + R2[1].h / 2 - to[1]) < 40, "near the drop point");
  const far = clusterDrop(Ps, 1, 99999, -99999, yaw, T, W, H, sizes(3)); assert.ok(far.every(Number.isFinite));
});
