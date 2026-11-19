// Only classify text visible on the terminal; do not infer a conversation or outcome.
export function screenLineKind(line) {
  if (/^\s*[›❯]\s*\S/.test(line) && !/^\s*[›❯]\s*Ask Codex to do anything\s*$/i.test(line)) return "request";
  if (/^\s*[•●⏺]\s*(?:Ran|Running|Read|Reading|Searched|Searching|Edited|Editing|Updated|Updating|Created|Explored|Exploring|Worked|Working)\b/i.test(line)) return "action";
  return "text";
}
