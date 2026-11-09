// hakoniwa ★84: the one set of small pictures (stroke icons, 24px, in icons/*.svg of this mod) the header, the left list and the right window all use,
// so the same thing is always the same picture. `svg()` resolves against the App's directory: the files are installed with the mod.
import { svg } from "gpui-kit";

export const ICON_DIR = "mods/hakoniwa/icons";
export const ICON_NAMES = ["pencil", "trash", "more", "x", "check", "stop", "play", "grip", "plus", "search", "down", "right", "left", "refresh", "link", "legend", "agent-add", "terminal-add", "room-add", "folder", "chart", "terminal", "chat", "tree", "crown", "minimize", "maximize", "office", "board", "p-claude", "p-codex", "p-opencode", "p-cursor", "p-agy"]; // ★105-3: minimize/maximize/office/board = the header's line pictures; 4th W5: p-* = the launch window's provider tiles (plain line pictures, not the vendors' logos; the shell uses "terminal")
export const iconPath = (name) => `${ICON_DIR}/${name}.svg`;
// A picture of the given name; an unknown name draws nothing (never a broken picture).
export const icon = (name, size = 14, color = null) => {
  if (!ICON_NAMES.includes(name)) return svg(iconPath("more")).size(0).flex_none();
  const el = svg(iconPath(name)).size(size).flex_none();
  return color ? el.text_color(color) : el;
};
