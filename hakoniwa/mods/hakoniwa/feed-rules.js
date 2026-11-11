// hakoniwa ③ "recent moves" (★106 office-feed106): the small pure rules (no gpui, so node can run them: see test-feed.mjs).
// An entry: { at, id, name, from, to, msg }. A person seen for the first time makes no entry (a restart must not flood the list).
export const FEED_MAX = 100;
export const FEED_FILTERS = [
  { key: "all", label: "전체" },
  { key: "finished", label: "완료" },   // working -> idle
  { key: "blocked", label: "승인" },    // -> blocked
  { key: "done", label: "보고" },       // -> done (a report)
];

// msg is what the agent itself says it is doing; the terminal can leave control characters / broken bytes in it: keep printable text only.
export const cleanMsg = (s, max = 80) => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f�]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// seen: { id: status }. Returns { seen, added } without touching the inputs. Gone people are dropped from seen.
export function trackMoves(seen, items, now) {
  const next = {}, added = [];
  for (const a of items ?? []) {
    if (!a?.id) continue;
    next[a.id] = a.status;
    const was = seen?.[a.id];
    if (was !== undefined && was !== a.status)
      added.push({ at: now, id: a.id, name: String(a.name || a.address || a.id), from: was, to: a.status, msg: cleanMsg(a.blocked_msg) });
  }
  return { seen: next, added };
}

// newest first, capped
export const addMoves = (log, added) => [...added.slice().reverse(), ...(log ?? [])].slice(0, FEED_MAX);

export function filterMoves(log, key) {
  const list = Array.isArray(log) ? log : [];
  if (key === "blocked") return list.filter((e) => e.to === "blocked");
  if (key === "done") return list.filter((e) => e.to === "done");
  if (key === "finished") return list.filter((e) => e.from === "working" && e.to === "idle");
  return list;
}

// Reads the saved file: anything that is not a well-formed entry is dropped.
export function parseLog(text) {
  try {
    const o = JSON.parse(text ?? "");
    return (Array.isArray(o?.log) ? o.log : []).filter((e) => e && Number.isFinite(e.at) && typeof e.id === "string" && typeof e.to === "string").slice(0, FEED_MAX);
  } catch { return []; }
}

// OpenCode's count line (opencode-usage.py). No percent: it has no limit we can read.
export function parseOpenCode(text) {
  try {
    const o = JSON.parse(String(text ?? "").trim().split("\n").pop());
    if (!o?.ok) return null;
    return { h5: o.h5, h24: o.h24, last: o.last ?? null };
  } catch { return null; }
}
export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
