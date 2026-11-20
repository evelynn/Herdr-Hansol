// hansol: an agent session's level from its output tokens (rank-rules.js), on its name tag and hover card.
// A level that goes up blinks for a few seconds, with "LEVEL UP!" over the tag and a toast.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { notify } from "herdr";
import { rankOf, tierOf, levelUps, fmt } from "./rank-rules.js";

const FX_MS = 8000;
const GOLD = "#ffe27a";
export const agentRankKey = (a) => (a?.session_id && a.xp_tokens != null ? `s:${a.session_id}` : null);
// The width a name tag gives the level chip (with the gap), 0 when the agent has no level.
export const rankChipW = (a) => (agentRankKey(a) ? (rankOf(a.xp_tokens).level >= 10 ? 40 : 34) : 0);

export class RankPart {
  // On every new state (the office copy): the level-ups. While the first count of the history is going on (xp.pending)
  // nothing is celebrated, and a level seen for the first time is only remembered.
  rankWatch() {
    const s = this.feed?.state;
    if (!s?.xp || s.xp.pending) return;
    this.rankSeen ??= new Map(); this.rankFx ??= new Map();
    const levels = {}, names = {};
    for (const a of s.agents ?? []) { const k = agentRankKey(a); if (k) { levels[k] = rankOf(a.xp_tokens).level; names[k] = a.labels?.display || a.name || a.address; } }
    const now = Date.now();
    for (const u of levelUps(this.rankSeen, levels)) {
      this.rankFx.set(u.key, now + FX_MS);
      try { notify({ title: "레벨 업", body: `${names[u.key]}: Lv.${u.from} → Lv.${u.to} (${tierOf(u.to).name})`, level: "success", timeout: 6000 }); } catch {}
    }
  }
  rankFxOn(key) { return !!key && (this.rankFx?.get(key) ?? 0) > Date.now(); }

  // "Lv.7" in the tier's colour; the tooltip has the tier, the XP and what is left to the next level (and `note`, e.g. the AI model).
  rankChip(tokens, key, size = 10, note = "") {
    if (tokens == null || !key) return null;
    const r = rankOf(tokens), fx = this.rankFxOn(key);
    const el = div().id(`rank-${key}`).flex_none().h(size + 5).px(4).flex().items_center().rounded(4).bg(r.tier.color).border(1).border_color(fx ? GOLD : r.tier.color)
      .text_size(size).font_weight(800).text_color(r.tier.ink).child(`Lv.${r.level}`)
      .tooltip(`${r.tier.name} · ${fmt(r.xp)} XP${r.need ? ` · 다음 레벨까지 ${fmt(r.need)} XP` : " · 최고 레벨"} (출력 토큰 ${fmt(tokens)})${note ? ` · ${note}` : ""}`);
    return fx ? el.loop("opacity", { from: 0.35, to: 1, period: 450 }) : el;
  }
  // "LEVEL UP!" rising over a tag while the level-up lasts; w = the tag's width.
  rankBurst(key, w) {
    if (!this.rankFxOn(key)) return null;
    return div().absolute().left(0).w(w).top(-18).h(14).flex().justify_center().loop("top", { from: -14, to: -26, period: 1200 })
      .child(div().text_size(11).font_weight(900).text_color(GOLD).child("LEVEL UP!"));
  }
  // The hover card's line: chip, tier, a bar to the next level and the XP left.
  rankLine(a, w) {
    const key = agentRankKey(a);
    if (!key) return null;
    const r = rankOf(a.xp_tokens);
    return h_flex().gap(6).items_center().child(this.rankChip(a.xp_tokens, key, 10))
      .child(div().flex_none().text_size(10).font_weight(700).text_color(r.tier.color).child(r.tier.name))
      .child(div().flex_1().h(4).rounded(2).bg("#ece8dd").child(div().h_full().w(Math.max(3, (w - 110) * r.frac)).rounded(2).bg(r.tier.color)))
      .child(div().flex_none().text_size(10).text_color("#6b7280").child(r.need ? `${fmt(r.need)} XP 남음` : "최고"));
  }
}
