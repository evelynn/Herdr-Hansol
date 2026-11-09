#!/usr/bin/env python3
"""hakoniwa ★79: the models and efforts the "+ エージェント" dialog offers, taken from each CLI's own list.

Writes <out> (default: %LOCALAPPDATA%\\..\\.config\\herdr-app\\hakoniwa-office\\models.json, i.e. ~/.config/herdr-app/hakoniwa-office/models.json):
  { "at": <epoch ms>, "kinds": { "<kind>": { "models": [{ "id", "label", "efforts"? }], "efforts": [..] | null, "at": <ms> } }, "errors": { "<kind>": "..." } }

Where each list comes from (nothing is typed in by hand except the aliases the Claude Code help itself names):
  claude    `claude --help`: the aliases named in --model's help (fable / opus / sonnet ...) and the values listed under --effort.
  codex     `codex debug models` (the raw model catalog as JSON): visible models and their reasoning levels.
  opencode  `opencode models` (provider/model lines).
  cursor    `cursor-agent models`.
  agy       `agy models` and `agy --help` (--effort values).
A kind that cannot be read keeps its previous list (errors[kind] says why). Run by the mod's exec (once a day, or the dialog's 更新), never in a render.
These are plain list / help commands of the person's own agents (nothing is started, no prompt is sent).
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

OUT = Path(os.environ.get('HERDR_APP_HOME') or (Path.home() / '.config' / 'herdr-app')) / 'hakoniwa-office' / 'models.json'
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
CAP = 16   # the dialog shows at most this many models per kind (the CLI's own order)


def run(cmd, timeout=45, scrub_herdr=False):
    exe = shutil.which(cmd[0])
    if not exe:
        raise RuntimeError(f'{cmd[0]} not found')
    env = dict(os.environ)
    if scrub_herdr:  # claude's wrapper starts the approval supervisor inside herdr; a help text needs none
        for k in [k for k in env if k.upper().startswith('HERDR')]:
            env.pop(k)
    r = subprocess.run([exe, *cmd[1:]], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL, env=env)
    out = ANSI.sub('', (r.stdout or b'').decode('utf-8', 'replace') + '\n' + (r.stderr or b'').decode('utf-8', 'replace'))
    if r.returncode:
        raise RuntimeError(f'{cmd[0]} exit {r.returncode}: {out.strip()[-120:]}')
    return out


def efforts_in(text, flag):
    """The values a help text lists for a flag: "--effort <level> ... (low, medium, ...)" or "(low|medium|...)"."""
    i = text.find(flag)
    if i < 0:
        return None
    m = re.search(r'\(([a-z0-9]+(?:\s*[,|]\s*[a-z0-9]+)+)\)', text[i:i + 400])
    return re.split(r'\s*[,|]\s*', m.group(1)) if m else None


def claude():
    h = run(['claude', '--help'], scrub_herdr=True)
    i = h.find('--model <model>')
    seg = h[i:i + 400] if i >= 0 else ''
    aliases = re.findall(r"'([a-z][a-z0-9-]*)'", seg)   # e.g. 'fable', 'opus', 'sonnet'
    aliases = [a for a in dict.fromkeys(aliases)]
    if not aliases:
        raise RuntimeError('no model alias in claude --help')
    if 'haiku' not in aliases:
        aliases.append('haiku')  # named by the user (2026-11-05); the CLI accepts any alias of its models
    return {'models': [{'id': a, 'label': f'{a}（最新）'} for a in aliases], 'efforts': efforts_in(h, '--effort')}


def codex():
    raw = run(['codex', 'debug', 'models'], timeout=60)
    j = raw[raw.find('{'):] if '{' in raw else raw
    try:
        data = json.loads(j[:j.rfind('}') + 1])
    except Exception:
        data = json.loads(raw[raw.find('['):raw.rfind(']') + 1])
    items = data.get('models', data) if isinstance(data, dict) else data
    models, union = [], []
    for m in items:
        if str(m.get('visibility', 'list')) not in ('list', 'visible'):
            continue
        levels = [str(x.get('effort')) for x in m.get('supported_reasoning_levels', []) if isinstance(x, dict) and x.get('effort')] or [str(x) for x in m.get('supported_reasoning_levels', []) if isinstance(x, str)]
        slug = m.get('slug') or m.get('id')
        if not slug:
            continue
        models.append({'id': slug, 'label': m.get('display_name') or slug, **({'efforts': levels} if levels else {})})
        union += [x for x in levels if x not in union]
    if not models:
        raise RuntimeError('no visible model in codex debug models')
    return {'models': models[:CAP], 'efforts': union or None}


def lines(text):
    return [l.strip() for l in text.splitlines() if l.strip()]


def opencode():
    ms = [l for l in lines(run(['opencode', 'models'])) if re.fullmatch(r'[\w.-]+/[\w./:-]+', l)]
    if not ms:
        raise RuntimeError('no model in opencode models')
    ms.sort(key=lambda m: (not m.startswith('opencode/'), 0))  # stable: the opencode / provider's own first
    return {'models': [{'id': m, 'label': m} for m in ms[:CAP]], 'efforts': None}


def cursor():
    ms = []
    for l in lines(run(['cursor-agent', 'models'])):
        m = re.match(r'([a-z0-9][\w.\-]*) - (.+)$', l)
        if m:
            ms.append({'id': m.group(1), 'label': re.sub(r'\s*\(.*?\)', '', m.group(2)).strip()})
    if not ms:
        raise RuntimeError('no model in cursor-agent models')
    return {'models': ms[:CAP], 'efforts': None}


def agy():
    ms = []
    for l in lines(run(['agy', 'models'])):
        m = re.match(r'([a-z0-9][\w.\-]*)\s+(.+)$', l)
        if m:
            ms.append({'id': m.group(1), 'label': m.group(2)})
    if not ms:
        raise RuntimeError('no model in agy models')
    return {'models': ms[:CAP], 'efforts': efforts_in(run(['agy', '--help']), '--effort')}


def main():
    out = Path(sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv else OUT
    old = {}
    try:
        old = json.loads(out.read_text(encoding='utf-8'))
    except Exception:
        pass
    kinds, errors, now = dict(old.get('kinds') or {}), {}, int(time.time() * 1000)
    for key, fn in (('claude', claude), ('codex', codex), ('opencode', opencode), ('cursor', cursor), ('agy', agy)):
        try:
            kinds[key] = {**fn(), 'at': now}
        except Exception as e:   # unreadable: the previous list stays (or none: only "default")
            errors[key] = str(e)[:200]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.tmp')
    tmp.write_text(json.dumps({'at': now, 'kinds': kinds, 'errors': errors}, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, out)
    print(json.dumps({'ok': not errors, 'kinds': {k: len(v.get('models', [])) for k, v in kinds.items()}, 'errors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
