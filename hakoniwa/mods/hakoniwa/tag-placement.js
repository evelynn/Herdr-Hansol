// Keep a work label near its owner; hide it when no nearby collision-free slot exists.
export function nearbyTag(rect, width, height, blocked) {
  for (const dy of [0, -15, -30]) {
    for (const dx of [0, -20, 20, -40, 40]) {
      const p = { ...rect, x: rect.x + dx, y: rect.y + dy };
      if (p.x < 4 || p.y < 4 || p.x + p.w > width - 4 || p.y + p.h > height - 4) continue;
      if (!blocked(p)) return p;
    }
  }
  return null;
}
