// hakoniwa ★108: what the mod needs from its config.json when the file is missing or leaves something out (a copy made from the
// layout collection has no config.json). The Python scripts are looked for in the mod's own py/ folder, python on PATH
// (Windows: pythonw first, so no console window flashes), and the collector itself says where it writes state.json (`--where`).
// Pure: the caller hands in `probe(python, collector)` (an exec of `python collector --where`), so the tests can fake it.

export const MOD_DIR = "mods/hakoniwa";
const trimEnd = (p) => String(p ?? "").replace(/[\\/]+$/, "");
export const isWindowsHome = (home) => /^[A-Za-z]:[\\/]/.test(String(home ?? "")) || String(home ?? "").includes("\\");
// pythonw / python / py on Windows (python3 there is often the Store's stand-in); python3 first elsewhere.
export const pythonCandidates = (home) => (isWindowsHome(home) ? ["pythonw", "python", "py"] : ["python3", "python"]);
export const defaultScripts = (appHomeDir) => {
  const py = `${trimEnd(appHomeDir)}/${MOD_DIR}/py`;
  return { collector: `${py}/hakoniwa-collector.py`, office_script: `${py}/hakoniwa-office.py` };
};
const hasOfficeScript = (c) => typeof c?.office === "string" || !!c?.office_script || !!c?.office_py;
export const needsDefaults = (c) => !c || !c.python || !c.collector || !c.state || !c.state_dir || !hasOfficeScript(c);

// The collector's `--where` answer: { state_dir, state, python, version: [major, minor], numpy, pillow }; anything else is null.
export function parseWhere(text) {
  try {
    const w = JSON.parse(String(text ?? "").trim());
    return w && typeof w.state === "string" && typeof w.state_dir === "string" ? w : null;
  } catch { return null; }
}

// Fills what is missing (a value config.json gives is kept). Returns { config, problem }: problem is null, "python" (no Python 3.10+ ran
// the collector) or "packages" (it ran, but numpy or Pillow is missing: the floor cannot be drawn).
export async function withDefaults(config, { appHomeDir, homeDir, probe }) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  if (!needsDefaults(c)) return { config: c, problem: null };
  const scripts = defaultScripts(appHomeDir);
  if (!c.collector) c.collector = scripts.collector;
  if (!hasOfficeScript(c)) c.office_script = scripts.office_script;
  let where = null;
  for (const py of c.python ? [c.python] : pythonCandidates(homeDir)) {
    try { where = parseWhere(await probe(py, c.collector)); } catch { where = null; }
    if (where) { if (!c.python) c.python = py; break; }
  }
  if (!where) return { config: c, problem: "python" };
  if (!c.state_dir) c.state_dir = where.state_dir;
  if (!c.state) c.state = where.state;
  return { config: c, problem: where.numpy === false || where.pillow === false ? "packages" : null };
}

export const problemText = (problem, python) =>
  problem === "python" ? "Python 3.10 以上が見つかりません（PATH に入れるか、config.json の python に場所を書く）"
    : problem === "packages" ? `numpy と Pillow がありません（${String(python ?? "python").replace(/pythonw(\.exe)?$/i, "python$1")} -m pip install numpy pillow）`
      : null;
