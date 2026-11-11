// 22nd N2 (office-fix27b): "what is being approved", read from the waiting person's screen copy (the permission dialog: its header / first body line and its question).
// Nothing is guessed: only lines that the dialog itself shows are returned. A screen with no readable dialog gives { readable: false } and the card says where to look instead.
import { approvalPlan, stripApprovalDialog } from "./approve.js";

export const NO_DETAIL_TEXT = "자세한 내용은 대화의 마지막 작업을 확인해 주세요";
const BOX = /[│┃║╭╮╰╯┌┐└┘╔╗╚╝─━═╌┄┈]/g, OPT = /^\s*(?:[❯>›»▶▸→*]\s*)?\d{1,2}[.)]\s+\S/;
const FOOT = /^(esc\b|enter\b|tab\b|ctrl\b|shift\b|press\b|↑|↓)/i; // key hint lines under the options are not part of the ask
const clean = (s) => String(s ?? "").replace(BOX, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join("") + "…" : String(s); };

// { readable, question, what }  question: the dialog's own question line ("Do you want to create hello.txt?"); what: its first one or two lines ("Create file · hello.txt"), "" when it has none.
export function approvalSummary(screen) {
  const text = String(screen ?? ""), plan = approvalPlan(text);
  if (!plan.readable || (plan.yes == null && plan.no == null)) return { readable: false, question: "", what: "" };
  const lines = text.split(/\r?\n/), cut = stripApprovalDialog(text);
  const start = cut.cut && cut.text !== "" ? cut.text.split(/\r?\n/).length : 0; // the dialog begins where the conversation copy ends (same cut as the screen tab)
  let first = -1;
  for (let i = start; i < lines.length; i++) if (OPT.test(lines[i])) { first = i; break; }
  if (first < 0) return { readable: false, question: "", what: "" };
  const before = lines.slice(start, first).map(clean).filter(Boolean).filter((l) => !FOOT.test(l));
  if (!before.length) return { readable: true, question: "", what: "" };
  const question = before[before.length - 1], body = before.slice(0, -1);
  return { readable: true, question: clip(question, 70), what: clip(body.slice(0, 2).join(" · "), 70) };
}

// 26th S3 (office-fix31b): a Japanese gloss for the dialog's English heading and question, ONLY for forms known exactly. The original English stays (the gloss is added
// in full-width brackets); any other text is returned as it is (nothing made up).
const HEAD_JA = { "Create file": "파일 만들기", "Edit file": "파일 수정", "Read file": "파일 읽기", "Bash command": "명령 실행" };
export function glossWhat(what) {
  const t = String(what ?? ""), i = t.indexOf(" · "), head = i < 0 ? t : t.slice(0, i), ja = HEAD_JA[head];
  return ja ? `${head}（${ja}）${i < 0 ? "" : t.slice(i)}` : t;
}
export function glossQuestion(q) {
  const t = String(q ?? ""); let m;
  if (t === "Do you want to proceed?") return `${t}（진행하시겠습니까?）`;
  if ((m = /^Do you want to create (.+)\?$/.exec(t))) return `${t}（${m[1]}을(를) 만드시겠습니까?）`;
  if ((m = /^Do you want to make this edit to (.+)\?$/.exec(t))) return `${t}（${m[1]}을(를) 수정하시겠습니까?）`;
  return t;
}

// The lines the card shows over its description: at most two. Unreadable or empty -> the one fallback line.
export function approvalDetailLines(screen) {
  const s = approvalSummary(screen);
  const out = [glossWhat(s.what), glossQuestion(s.question)].filter(Boolean);
  return out.length ? out : [NO_DETAIL_TEXT];
}
