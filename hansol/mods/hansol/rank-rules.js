// hansol: an agent session's rank from its token use (pure, node runs it in the tests).
// XP = output tokens / TOKENS_PER_XP; the levels follow the D&D 5th edition experience table (Lv1 0 XP ... Lv20 355,000 XP)
// and its four tiers of play (Lv1-4, 5-10, 11-16, 17-20).
export const TOKENS_PER_XP = 50;
export const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
export const TIERS = [
  { key: "novice", upTo: 4, name: "견습", color: "#8d7b68", ink: "#ffffff" },
  { key: "veteran", upTo: 10, name: "숙련", color: "#3b7fc4", ink: "#ffffff" },
  { key: "hero", upTo: 16, name: "영웅", color: "#8e44ad", ink: "#ffffff" },
  { key: "legend", upTo: 20, name: "전설", color: "#d4a017", ink: "#2a1d05" },
];
export const tierOf = (level) => TIERS.find((t) => level <= t.upTo) ?? TIERS[TIERS.length - 1];

// { level, tier, xp, need: XP still missing to the next level (0 at Lv20), frac: how far into this level (1 at Lv20) }
export function rankOf(tokens) {
  const xp = Math.max(0, Math.floor((Number(tokens) || 0) / TOKENS_PER_XP));
  let level = 1;
  while (level < XP_TABLE.length && xp >= XP_TABLE[level]) level++;
  const lo = XP_TABLE[level - 1], hi = XP_TABLE[level];
  return { level, tier: tierOf(level), xp, need: hi === undefined ? 0 : hi - xp, frac: hi === undefined ? 1 : (xp - lo) / (hi - lo) };
}

// Level-ups since the last look: seen is a Map key -> level (updated here). A key seen for the first time records its level and
// is no level-up (a new window, or a reload, does not celebrate old work). Answers [{ key, from, to }].
export function levelUps(seen, levels) {
  const ups = [];
  for (const [key, level] of Object.entries(levels)) {
    const was = seen.get(key);
    if (was !== undefined && level > was) ups.push({ key, from: was, to: level });
    seen.set(key, level);
  }
  return ups;
}
export const fmt = (n) => Number(n || 0).toLocaleString("en-US");
