#!/usr/bin/env python3
"""Collect every coding agent on this PC into one JSON for the agent HUD.

Sources (all read-only; nothing is started, answered or changed):
  Herdr app / herdr-core   hc ls --json, hc get <t> --json
  herdr TUI                herdr agent list / workspace list / pane process-info
                           (an API call only: never starts a herdr server)
  T3 Code                  ~/.t3/userdata/statev2.sqlite, opened read-only
  Claude Code sessions     ~/.claude/sessions/<pid>.json, and the model from the
                           last assistant entry of the session's transcript
  Current Session usage    ~/.claude.json "cachedUsageUtilization" (Claude Code
                           refreshes it; statusLine is disabled by the
                           Enterprise policy allowManagedHooksOnly)
Prompt and transcript text is never copied out: only the model name is read.

Output: %LOCALAPPDATA%/hakoniwa/state.json (atomic), and stdout with --stdout.
Run once per call; the Herdr HUD mod calls it every few seconds.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HOME = Path.home()
LOCAL = Path(os.environ.get('LOCALAPPDATA') or HOME / 'AppData' / 'Local')
OUT_DIR = LOCAL / 'hakoniwa'
T3_DB = HOME / '.t3' / 'userdata' / 'statev2.sqlite'
SESSIONS = HOME / '.claude' / 'sessions'
PROJECTS = HOME / '.claude' / 'projects'
CLAUDE_JSON = HOME / '.claude.json'
LONG_IDLE_MS = 60 * 60 * 1000        # idle this long: a look (dozing), not a state
T3_RECENT_MS = 3 * 60 * 60 * 1000    # T3 threads shown when active this recently
T3_DONE_MS = 10 * 60 * 1000          # a finished T3 run reads "done" this long
NO_WINDOW = 0x08000000               # CREATE_NO_WINDOW: no console flash from a GUI parent
TAIL_BYTES = 512 * 1024
_MODEL = re.compile(rb'"model":"([^"]+)"')


def now_ms():
    return int(time.time() * 1000)


def iso_ms(text):
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(str(text).replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return None


def herdr_cli():
    found = shutil.which('herdr')
    if found:
        return found
    fallback = HOME / '.herdr' / 'packages' / 'standalone' / 'current' / 'herdr.exe'
    return str(fallback) if fallback.is_file() else None


def run_json(argv, timeout=8):
    """Run a CLI and parse its JSON output; raise RuntimeError with a short reason."""
    try:
        result = subprocess.run([str(a) for a in argv], capture_output=True, timeout=timeout,
                                creationflags=NO_WINDOW if os.name == 'nt' else 0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f'{Path(str(argv[0])).name}: {exc.__class__.__name__}') from exc
    text = result.stdout.decode('utf-8-sig', 'replace').strip()
    if result.returncode or not text:
        err = result.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise RuntimeError(f'{Path(str(argv[0])).name}: {(err or ["exit " + str(result.returncode)])[-1][:160]}')
    return json.loads(text)


# ---------------------------------------------------------------- processes

def process_table():
    """{pid: (parent pid, exe name)} from a Toolhelp snapshot (no WMI)."""
    if os.name != 'nt':
        return {}
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', ctypes.c_long),
                    ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return {}
    table = {}
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(Entry)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            table[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return table


def ancestors(pid, table, limit=40):
    seen = []
    while pid in table and len(seen) < limit:
        seen.append(pid)
        parent = table[pid][0]
        if parent == pid or parent in seen:
            break
        pid = parent
    return seen


# ---------------------------------------------------------------- models

def model_info(model):
    """(vendor, family, label) for a model id such as claude-opus-5-5."""
    m = (model or '').lower()
    for family in ('opus', 'sonnet', 'haiku', 'fable'):
        if family in m:
            ver = re.search(family + r'[-.]?(\d+)[-.](\d+)', m)
            label = family.capitalize() + (f' {ver.group(1)}.{ver.group(2)}' if ver else '')
            return 'anthropic', family, label
    oseries = re.search(r'(?:^|[/-])(o\d+)(?:-(mini|pro))?(?:$|[-.])', m)
    if oseries:
        return 'openai', 'o-series', oseries.group(1) + (f' {oseries.group(2)}' if oseries.group(2) else '')
    for key, vendor, label in (('deepseek', 'deepseek', 'DeepSeek'), ('gpt', 'openai', 'GPT'),
                               ('codex', 'openai', 'Codex'), ('gemini', 'google', 'Gemini'),
                               ('grok', 'xai', 'Grok'), ('qwen', 'alibaba', 'Qwen'), ('kimi', 'moonshot', 'Kimi'),
                               ('glm', 'zhipu', 'GLM'), ('mistral', 'mistral', 'Mistral'), ('llama', 'meta', 'Llama')):
        if key in m:
            ver = re.search(key + r'[-.]?v?([\d.]+)', m)
            return vendor, key, label + (f' {ver.group(1).strip(".")}' if ver and ver.group(1).strip('.') else '')
    if m:
        name = m.split('/')[-1]
        return None, 'other:' + name, name
    return None, None, None


# Clothes colour per model family.  Families not listed get a stable colour
# from FALLBACK (hashed), so a new model never collides silently with Opus.
FAMILY_COLOR = {
    'opus': '#7c4dff', 'sonnet': '#2f7cf6', 'haiku': '#12a594', 'fable': '#e0457b',
    'deepseek': '#f2711c', 'gpt': '#1f9d55', 'codex': '#1f9d55', 'o-series': '#0e7c6b',
    'gemini': '#0ea5e9', 'grok': '#3f4756', 'qwen': '#5b5bd6', 'kimi': '#c9971c',
    'glm': '#c2410c', 'mistral': '#f59e0b', 'llama': '#64748b',
}
FALLBACK_COLOR = ['#a855f7', '#ef4444', '#84cc16', '#06b6d4', '#f43f5e', '#8b5e3c', '#d946ef', '#0891b2']
UNKNOWN_COLOR = '#9aa3af'


def shade(hex_color, amount):
    """Lighten (amount > 0) or darken (< 0) a #rrggbb colour."""
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    mix = (lambda c: c + (255 - c) * amount) if amount > 0 else (lambda c: c * (1 + amount))
    return '#' + ''.join(f'{max(0, min(255, round(mix(c)))):02x}' for c in (r, g, b))


def assign_colors(agents):
    """Colour by family; versions of one family running together get distinct shades
    (newest = base, then darker, lighter, ...), so Opus 5.5 and Opus 4.6 differ."""
    by_family = {}
    for agent in agents:
        if agent.get('family'):
            by_family.setdefault(agent['family'], set()).add(agent.get('model_label') or '')
    shades = [0, -0.28, 0.3, -0.48, 0.5]
    for agent in agents:
        family = agent.get('family')
        if not family:
            agent['color'] = UNKNOWN_COLOR
            continue
        base = FAMILY_COLOR.get(family) or FALLBACK_COLOR[
            int(hashlib.sha1(family.encode()).hexdigest(), 16) % len(FALLBACK_COLOR)]
        versions = sorted(by_family[family], key=lambda v: [int(n) for n in re.findall(r'\d+', v)] or [0],
                          reverse=True)
        rank = versions.index(agent.get('model_label') or '')
        agent['color'] = shade(base, shades[rank % len(shades)])


_MODEL_ARG = re.compile(r'(?:^|\s)(?:--model|-m)(?:=|\s+)([^\s"\'`&|;]+)')
_SCRIPT_EXT = ('.cmd', '.bat', '.ps1')
_CALL_FORM = re.compile(r'''\s*(?:&\s*)?['"]?[A-Za-z]:[\\/]''')
_SCRIPT_PATH = re.compile(r'''[A-Za-z]:[\\/][^"'<>|?*\r\n]*?\.(?:cmd|bat|ps1)''', re.I)


def model_from_argv(argv):
    for i, arg in enumerate(argv or []):
        arg = str(arg)
        if arg in ('--model', '-m') and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith('--model='):
            return arg.split('=', 1)[1]
        if _CALL_FORM.match(arg) and _SCRIPT_PATH.search(arg) and ' ' in arg:  # a shell's -Command "& 'x.cmd' --model m": only text that STARTS as a script call (a prompt is never scanned)
            found = _MODEL_ARG.search(arg)
            if found:
                return found.group(1)
    return None


def _scripts_in(argv):
    seen = []
    for arg in (argv or [])[:6]:
        arg = str(arg).replace("'", '"')
        cands = _SCRIPT_PATH.findall(arg) or ([arg] if arg.lower().endswith(_SCRIPT_EXT) else [])
        for cand in cands:
            if cand not in seen:
                seen.append(cand)
    return seen


def wrapper_info(*argvs):
    """(model, kind text) read from the launcher scripts (.cmd/.bat/.ps1) an agent was started through.

    A child started through `sonnet-medium.cmd` has no `--model` in its argv: the script holds it.
    Only small existing files are read; nothing is run.
    """
    model, texts = None, []
    for argv in argvs:
        for path in _scripts_in(argv):
            try:
                p = Path(path)
                if not p.is_file() or p.stat().st_size > 65536:
                    continue
                text = p.read_text('utf-8', 'replace')
            except OSError:
                continue
            texts.append(text.lower())
            model = model or (_MODEL_ARG.search(text).group(1) if _MODEL_ARG.search(text) else None)
    return model, ' '.join(texts)


def resolve_model(transcript_model, argvs, cwd, app=None):
    """(model, is_default): only a model that was really chosen — the conversation record, --model / -m in the argv,
    or the launcher script that started it. ★101-1: a CLI's own default is a guess, so it is not used (the office shows
    "モデル不明" instead). `is_default` stays false (kept for older state files)."""
    model = transcript_model
    for argv in argvs:
        model = model or model_from_argv(argv)
    wmodel, _wtext = (None, '') if model else wrapper_info(*argvs)
    model = model or wmodel
    return (model, False) if model else (None, False)


class Transcripts:
    """The model of a Claude session, from the tail of its transcript (cached by size)."""

    def __init__(self, cache):
        self.paths = cache.setdefault('transcripts', {})
        self.models = cache.setdefault('models', {})

    def path(self, session_id, cwd):
        known = self.paths.get(session_id)
        if known and Path(known).is_file():
            return Path(known)
        guess = PROJECTS / re.sub(r'[^A-Za-z0-9]', '-', cwd or '') / f'{session_id}.jsonl'
        found = guess if guess.is_file() else next(PROJECTS.glob(f'*/{session_id}.jsonl'), None)
        if found:
            self.paths[session_id] = str(found)
        return found

    def model(self, session_id, cwd):
        path = self.path(session_id, cwd)
        if not path:
            return None
        size = path.stat().st_size
        cached = self.models.get(str(path))
        if cached and cached[0] == size:
            return cached[1]
        with path.open('rb') as f:
            f.seek(max(0, size - TAIL_BYTES))
            tail = f.read()
        models = [m.decode('utf-8', 'replace') for m in _MODEL.findall(tail)]
        models = [m for m in models if not m.startswith('<')]
        model = models[-1] if models else (cached[1] if cached else None)
        self.models[str(path)] = [size, model]
        return model


# ---------------------------------------------------------------- sources

def claude_sessions(table):
    """Live Claude Code processes: {pid: session record}."""
    live = {}
    for path in SESSIONS.glob('*.json'):
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            pid = int(record.get('pid'))
        except (OSError, ValueError, TypeError):
            continue
        if pid in table and table[pid][1].startswith('claude'):
            live[pid] = record
    return live


def session_for(pid_root, table, sessions):
    """The Claude session running at or under pid_root (a terminal's root process)."""
    for pid, record in sessions.items():
        if pid_root in ancestors(pid, table):
            return pid, record
    return None, None


class HcPipe:
    """herdr-core's API on its named pipe: JSON-RPC 2.0, one message per line.

    About 1 ms a call, where starting hc.exe takes 300-400 ms on this PC.
    Only read methods are used here (terminal.list, terminal.get).
    """

    def __init__(self):
        pipes = [n for n in os.listdir('\\\\.\\pipe\\')
                 if n.startswith('herdr-core-') and n.endswith('-default.sock')]
        if not pipes:
            raise RuntimeError('herdr-core가 실행 중이 아닙니다')
        self.file = open('\\\\.\\pipe\\' + pipes[0], 'r+b')
        self.next_id = 0

    def call(self, method, **params):
        self.next_id += 1
        self.file.write((json.dumps({'jsonrpc': '2.0', 'id': self.next_id, 'method': method,
                                     'params': params}) + '\n').encode('utf-8'))
        self.file.flush()
        reply = json.loads(self.file.readline())
        if 'error' in reply:
            raise RuntimeError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get('result')

    def close(self):
        self.file.close()


def collect_core(table, sessions, transcripts, errors):
    agents = []
    try:
        api = HcPipe()
    except (OSError, RuntimeError) as exc:
        errors['app'] = str(exc)
        return agents
    try:
        listing = api.call('terminal.list')
        for term in listing.get('terminals', []):
            if term.get('state') != 'live' or not term.get('status'):
                continue  # finished, or a plain program that reports no status
            agents.append(core_agent(term, api.call('terminal.get', terminal=term['address']),
                                     table, sessions, transcripts))
    except (OSError, ValueError, RuntimeError) as exc:
        errors['app'] = f'herdr-core: {exc}'
    finally:
        api.close()
    return agents


def core_agent(term, info, table, sessions, transcripts):
    address = term['address']
    status = info.get('status') if isinstance(info.get('status'), dict) else {'state': term.get('status')}
    pid, session = session_for(info.get('pid'), table, sessions) if info.get('pid') else (None, None)
    model = transcripts.model(session.get('sessionId'), session.get('cwd')) if session else None
    model, model_default = resolve_model(model, [info.get('argv'), (info.get('foreground') or {}).get('argv')],
                                         term.get('cwd') or info.get('cwd'), status.get('app') or term.get('agent'))
    space, _, tab = (term.get('where') or '').partition(' / ')
    return {
        'id': f'app:{address}', 'source': 'app', 'address': address,
        'name': ((info.get('labels') or {}).get('display') if isinstance(info.get('labels'), dict) else None) or info.get('name') or info.get('title') or address,   # ★96-3 labels.display first
        'title': info.get('title') or '', 'space': space, 'tab': tab, 'cwd': term.get('cwd'),
        'app': status.get('app') or term.get('agent'), 'status': status.get('state') or 'unknown',
        'blocked_kind': status.get('kind'), 'blocked_msg': status.get('msg'),
        'since': info.get('status_ms'), 'model': model, 'model_default': model_default,
        'session_id': session.get('sessionId') if session else None, 'pid': pid, 'root_pid': info.get('pid'),
        'labels': info.get('labels') or {}, 'parent': info.get('parent'),
    }


def collect_tui(table, sessions, transcripts, cache, errors):
    agents = []
    herdr = herdr_cli()
    if not herdr:
        errors['tui'] = 'herdr를 찾을 수 없습니다'
        return agents
    try:
        # One call for agents, workspaces and tabs (each herdr start costs ~0.3 s).
        snapshot = run_json([herdr, 'api', 'snapshot'])['result']['snapshot']
        listing = snapshot['agents']
    except (RuntimeError, ValueError, KeyError) as exc:
        errors['tui'] = str(exc)
        return agents
    spaces = {w['workspace_id']: w.get('label') or '' for w in snapshot.get('workspaces', [])}
    tabs = {t['tab_id']: t.get('label') or '' for t in snapshot.get('tabs', [])}
    pids = cache.setdefault('tui_pids', {})
    for pane in [p for p in pids if p not in {a.get('pane_id') for a in listing}]:
        del pids[pane]
    for agent in listing:
        pane = agent.get('pane_id')
        known = pids.get(pane)
        if not known or known.get('terminal') != agent.get('terminal_id') or known.get('pid') not in table:
            try:
                info = run_json([herdr, 'pane', 'process-info', '--pane', pane])['result']['process_info']
                fg = (info.get('foreground_processes') or [{}])[0]
                known = {'pid': fg.get('pid'), 'argv': fg.get('argv') or [], 'terminal': agent.get('terminal_id')}
            except (RuntimeError, ValueError, KeyError):
                known = {'pid': None, 'argv': [], 'terminal': agent.get('terminal_id')}
            pids[pane] = known
        session = sessions.get(known.get('pid'))
        if not session and known.get('pid'):
            _, session = session_for(known['pid'], table, sessions)
        model = transcripts.model(session.get('sessionId'), session.get('cwd')) if session else None
        model, model_default = resolve_model(model, [known.get('argv')], agent.get('cwd'), agent.get('agent'))
        agents.append({
            'id': f'tui:{pane}', 'source': 'tui', 'address': pane,
            'name': agent.get('name') or agent.get('terminal_title_stripped') or pane,
            'title': agent.get('terminal_title_stripped') or '',
            'space': spaces.get(agent.get('workspace_id'), ''), 'tab': tabs.get(agent.get('tab_id'), ''),
            'cwd': agent.get('cwd'),
            'app': agent.get('agent'), 'status': agent.get('agent_status') or 'unknown',
            'blocked_kind': None, 'blocked_msg': None,
            'since': session.get('statusUpdatedAt') if session else None, 'model': model, 'model_default': model_default,
            'session_id': session.get('sessionId') if session else None, 'pid': known.get('pid'), 'root_pid': known.get('pid'),
            'labels': {}, 'parent': None,
        })
    return agents


T3_PROVIDERS = {'claudeAgent': 'claude-code', 'opencode': 'opencode', 'codex': 'codex',
                'cursor': 'cursor', 'acpRegistry_copilot': 'copilot'}


def collect_t3(errors):
    agents = []
    if not T3_DB.is_file():
        errors['t3'] = 'T3 Code 데이터베이스가 없습니다'
        return agents
    try:
        con = sqlite3.connect(f'file:{T3_DB.as_posix()}?mode=ro', uri=True, timeout=2)
    except sqlite3.Error as exc:
        errors['t3'] = f'T3: {exc}'
        return agents
    try:
        threads = con.execute(
            'select thread_id, title, default_provider, updated_at, project_id from orchestration_v2_projection_threads '
            'where deleted_at is null and archived_at is null order by updated_at desc limit 60').fetchall()
        # A subagent's own thread is part of its parent: counted there as a helper.
        children = {row[0] for row in con.execute(
            'select child_thread_id from orchestration_v2_projection_subagents where child_thread_id is not null')}
        current = now_ms()
        try:
            projects = dict(con.execute('select project_id, title from projection_projects where deleted_at is null'))
        except sqlite3.Error:
            projects = {}
        for thread_id, title, provider, updated, project_id in threads:
            if thread_id in children:
                continue
            run = con.execute(
                'select status, provider, requested_at, completed_at from orchestration_v2_projection_runs '
                'where thread_id=? order by requested_at desc limit 1', (thread_id,)).fetchone()
            pending = con.execute(
                "select kind, created_at from orchestration_v2_projection_runtime_requests "
                "where thread_id=? and status='pending' order by created_at limit 1", (thread_id,)).fetchone()
            session = con.execute(
                "select provider, model, status from orchestration_v2_projection_provider_sessions "
                "where thread_id=? order by (status!='stopped') desc, updated_at desc limit 1", (thread_id,)).fetchone()
            helpers = con.execute(
                "select count(*) from orchestration_v2_projection_subagents where thread_id=? "
                "and status not in ('completed','failed','cancelled','error','stopped','interrupted')",
                (thread_id,)).fetchone()[0]
            run_status = run[0] if run else None
            last = max(filter(None, [iso_ms(updated), iso_ms(run[3]) if run else None, iso_ms(run[2]) if run else None]),
                       default=0)
            if not (pending or run_status == 'running' or current - last < T3_RECENT_MS):
                continue
            if pending:
                status, since = 'blocked', iso_ms(pending[1])
            elif run_status == 'running':
                status, since = 'working', iso_ms(run[2])
            else:
                since = (iso_ms(run[3]) if run else None) or iso_ms(updated)
                status = 'done' if since and current - since < T3_DONE_MS else 'idle'
            provider = (run[1] if run else None) or (session[0] if session else None) or provider
            agents.append({
                'id': f't3:{thread_id}', 'source': 't3', 'address': thread_id,
                'name': title or 'T3 Code', 'title': title or '', 'space': 'T3 Code', 'project': projects.get(project_id), 'tab': '', 'cwd': None,
                'app': T3_PROVIDERS.get(provider, provider), 'status': status,
                'blocked_kind': pending[0] if pending else None, 'blocked_msg': None,
                'since': since, 'model': session[1] if session else None,
                'session_id': None, 'pid': None, 'labels': {}, 'parent': None, 'helpers': helpers,
            })
    except sqlite3.Error as exc:
        errors['t3'] = f'T3 읽기 실패: {exc}'
    finally:
        con.close()
    return agents


def collect_usage(cache, errors):
    """Current Session (5h) and weekly usage from Claude Code's own cache."""
    try:
        mtime = CLAUDE_JSON.stat().st_mtime
    except OSError:
        errors['usage'] = '~/.claude.json 파일이 없습니다'
        return None
    saved = cache.get('usage')
    if saved and saved.get('mtime') == mtime:
        return saved['data']
    try:
        cached = json.loads(CLAUDE_JSON.read_text(encoding='utf-8')).get('cachedUsageUtilization') or {}
    except (OSError, ValueError) as exc:
        errors['usage'] = f'사용량 읽기 실패: {exc.__class__.__name__}'
        return saved['data'] if saved else None
    util = cached.get('utilization') or {}
    five = util.get('five_hour') or {}
    weekly = [{'label': ((l.get('scope') or {}).get('model') or {}).get('display_name') or l.get('kind'),
               'percent': l.get('percent'), 'resets_at': iso_ms(l.get('resets_at')), 'active': l.get('is_active')}
              for l in util.get('limits') or [] if l.get('group') == 'weekly']
    seven = util.get('seven_day') or {}
    if seven.get('utilization') is not None:
        weekly.insert(0, {'label': '全体', 'percent': seven.get('utilization'),
                          'resets_at': iso_ms(seven.get('resets_at')), 'active': True})
    extra = util.get('extra_usage') or {}
    data = {
        'fetched_at': cached.get('fetchedAtMs'),
        'session': {'percent': five.get('utilization'), 'resets_at': iso_ms(five.get('resets_at'))},
        'weekly': weekly,
        'extra': {'used': extra.get('used_credits'), 'limit': extra.get('monthly_limit'),
                  'enabled': extra.get('is_enabled')} if extra else None,
    }
    cache['usage'] = {'mtime': mtime, 'data': data}
    return data


CODEX_SESSIONS = HOME / '.codex' / 'sessions'
_RATE = re.compile(rb'"rate_limits":\{[^{}]*"primary":\{([^{}]*)\},"secondary":\{([^{}]*)\}')


def _window(raw):
    """{percent, minutes, resets_at (ms)} from the inside of a rate_limits window object."""
    def num(key):
        m = re.search(rb'"' + key + rb'":([0-9.]+)', raw)
        return float(m.group(1)) if m else None
    percent, minutes, resets = num(b'used_percent'), num(b'window_minutes'), num(b'resets_at')
    return {'percent': round(percent) if percent is not None else None,
            'minutes': int(minutes) if minutes else None,
            'resets_at': int(resets * 1000) if resets else None}


def collect_codex_usage(cache):
    """Codex's 5h / weekly limits: only the numbers of the last `rate_limits` in the newest
    session record (the conversation text is never decoded). None if there is none."""
    try:
        files = sorted(CODEX_SESSIONS.glob('*/*/*/rollout-*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return None
    saved = cache.get('codex_usage')
    for path in files[:6]:  # a fresh session may not have its first rate_limits yet
        try:
            stat = path.stat()
            if saved and saved.get('path') == str(path) and saved.get('size') == stat.st_size:
                return saved['data']
            with path.open('rb') as f:
                f.seek(max(0, stat.st_size - TAIL_BYTES))
                found = _RATE.findall(f.read())
        except OSError:
            continue
        if found:
            primary, secondary = _window(found[-1][0]), _window(found[-1][1])
            data = {'fetched_at': int(stat.st_mtime * 1000), 'session': primary, 'weekly': secondary}
            cache['codex_usage'] = {'path': str(path), 'size': stat.st_size, 'data': data}
            return data
    return saved['data'] if saved else None


# ---------------------------------------------------------------- memory (for the clean-up candidates)

MEM_EVERY_MS = 60 * 1000          # measure about once a minute; in between the last value is returned
_PQLI = 0x1000                    # PROCESS_QUERY_LIMITED_INFORMATION


def working_sets():
    """pid -> working set (bytes) reader. psapi through ctypes; nothing is started (no WMI, no processes)."""
    if os.name != 'nt':
        return lambda pid: None
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                    ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]

    def read(pid):
        handle = k32.OpenProcess(_PQLI, False, int(pid))
        if not handle:
            return None
        try:
            counters = Counters()
            counters.cb = ctypes.sizeof(Counters)
            ok = k32.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            return int(counters.WorkingSetSize) if ok else None
        finally:
            k32.CloseHandle(handle)
    return read


def private_bytes_reader():
    """pid -> private bytes (PagefileUsage, the task manager's "commit size"). psapi through ctypes; nothing is started."""
    if os.name != 'nt':
        return lambda pid: None
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                    ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]

    def read(pid):
        handle = k32.OpenProcess(_PQLI, False, int(pid))
        if not handle:
            return None
        try:
            counters = Counters()
            counters.cb = ctypes.sizeof(Counters)
            ok = k32.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            return int(counters.PagefileUsage) if ok else None
        finally:
            k32.CloseHandle(handle)
    return read


APP_MEM_EVERY_MS = 60 * 1000


def app_pid(table):
    """The Herdr App's pid: the ancestor of this collector (it starts us), else the first herdr-app process."""
    pid, seen = os.getppid(), set()
    for _ in range(12):
        if pid in seen or pid not in table:
            break
        seen.add(pid)
        parent, exe = table[pid]
        if exe.startswith('herdr-app'):
            return pid
        if parent == pid or parent == 0:
            break
        pid = parent
    for pid, (_parent, exe) in table.items():
        if exe.startswith('herdr-app'):
            return pid
    return None


def app_memory(cache, table):
    """★90 (H) the App's own private bytes, at most once a minute; read only, no process is started."""
    saved = cache.get('app_mem')
    current = now_ms()
    if isinstance(saved, list) and len(saved) == 2 and saved[1] and current - saved[1] < APP_MEM_EVERY_MS:
        return saved[0]
    pid = app_pid(table)
    value = private_bytes_reader()(pid) if pid else None
    cache['app_mem'] = [value, current]
    return value


def tree_memory(root, table, read):
    """Working set of a process and all its descendants (None if the root is gone)."""
    if root not in table:
        return None
    kids = {}
    for pid, (parent, _) in table.items():
        kids.setdefault(parent, []).append(pid)
    total, seen, stack = 0, set(), [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(kids.get(pid, []))
        size = read(pid)
        total += size or 0
    return total


def attach_memory(agents, table, cache):
    """mem_bytes / mem_at per agent: the process tree under its terminal's root (T3 Code threads: None).
    A root is measured at most once a minute (cache.json); a root seen for the first time is measured at once."""
    saved = cache.setdefault('mem', {})
    current = now_ms()
    read = None
    live = set()
    for agent in agents:
        root = agent.get('root_pid')
        agent['mem_bytes'], agent['mem_at'] = None, None
        if not root or root not in table:
            continue
        key = str(root)
        live.add(key)
        entry = saved.get(key)
        if not entry or current - entry[1] >= MEM_EVERY_MS:
            read = read or working_sets()
            entry = saved[key] = [tree_memory(root, table, read), current]
        agent['mem_bytes'], agent['mem_at'] = entry
    for key in [k for k in saved if k not in live]:
        del saved[key]


def cleanup_list(agents):
    """Long-idle agents (60 min+), biggest memory first, unmeasured last."""
    cands = [a for a in agents if a.get('long_idle')]
    cands.sort(key=lambda a: (a.get('mem_bytes') is None, -(a.get('mem_bytes') or 0)))
    return {'ids': [a['id'] for a in cands], 'total_bytes': sum(a.get('mem_bytes') or 0 for a in cands)}


# ---------------------------------------------------------------- assemble

STATES = ('blocked', 'working', 'done', 'idle')
ORDER = {'blocked': 0, 'done': 1, 'working': 2, 'idle': 3}


FREE_TITLE = 'フリーデスク'                                  # ★68-2: the island of the people in no space (office.py: is_free)
FREE_ISLAND = 'free:' + FREE_TITLE
FREE_SPACE_NAME = 'フリー'                                    # ★95: the App space the free desk's agents are in (actions.js FREE_NAME)


def island_of(agent):
    """(key, title): the group an agent works in. App: the space (hc label `where` before " / ", else the term's own);
    TUI: the workspace label; T3 Code: the project (else "T3 Code"). The key is "<source>:<title>"."""
    source = agent.get('source')
    labels = agent.get('labels') or {}
    if source == 'app':
        where = (labels.get('where') if isinstance(labels, dict) else None) or ''
        title = where.split(' / ')[0].strip() or agent.get('space') or ''      # the space's name, as the App's list shows it
        if title == FREE_SPACE_NAME:                                           # ★95: the real space "フリー" (the launch dialog's "スペースなし（フリー）") is the free desk island
            return FREE_ISLAND, FREE_TITLE
        if not title:                                                          # ★68-2: in no space (hc run --bg --no-parent: no where, no herdr.space): the free desk
            return FREE_ISLAND, FREE_TITLE
    elif source == 'tui':
        title = agent.get('space') or ''
        if not title:
            return FREE_ISLAND, FREE_TITLE
    else:
        title = agent.get('project') or 'T3 Code'
    return f'{source}:{title}', title


NEWCOMER_MS = 10 * 60 * 1000          # a sprout mark for the first 10 minutes
LEFT_KEEP_MS = 2 * 60 * 1000          # somebody who has gone stays in `left` for 2 minutes (the office shows him waving at the door)


def track_left(agents, cache):
    """`left`: the agents that were here at the last look and are not now ([{id, name, island, status, at}]), kept for 2 minutes."""
    current = now_ms()
    present = cache.get('present') or {}
    left = [e for e in cache.get('left') or [] if current - e['at'] < LEFT_KEEP_MS]
    now_ids = {a['id'] for a in agents}
    for aid, info in present.items():
        if aid not in now_ids and not any(e['id'] == aid for e in left):
            left.append({'id': aid, 'name': info.get('name'), 'island': info.get('island'), 'status': info.get('status'), 'at': current})
    cache['present'] = {a['id']: {'name': a.get('name'), 'island': a.get('island'), 'status': a.get('status')} for a in agents}
    cache['left'] = left
    return left


RECENT_APPROVAL_MS = 120_000


def read_approval_events(cache, path=None, now=None):
    """New lines of events.jsonl (written by an approval relay, when one is set up: one per Enter it pressed; none ships with the layout).
    Reads only from where the last run stopped; a cut file (its head trimmed) restarts at 0 and the last-seen time filters repeats.
    Returns (recent events of the last 2 minutes, counters). Never raises: no file / bad lines just mean no events."""
    st = cache.setdefault('approval_events', {'pos': 0, 'last_at': 0, 'recent': [], 'total': 0})
    st.setdefault('messages', [])
    now = now_ms() if now is None else now
    path = Path(path) if path else APP_HOME / 'hakoniwa-office' / 'events.jsonl'
    try:
        size = path.stat().st_size
        if size < st['pos']:
            st['pos'] = 0
        if size > st['pos']:
            with path.open('rb') as f:
                f.seek(st['pos'])
                chunk = f.read(min(size - st['pos'], 400_000))
            end = chunk.rfind(bytes([10])) + 1          # only whole lines (up to the last newline); the rest is read next time
            st['pos'] += end
            for raw in chunk[:end].splitlines():
                try:
                    row = json.loads(raw.decode('utf-8', 'replace'))
                    at = float(row['at'])
                except (ValueError, KeyError, TypeError):
                    continue
                if at <= st['last_at'] or row.get('kind') not in ('approved', 'message'):
                    continue
                st['last_at'] = at
                if row.get('kind') == 'message':            # ★66: one agent sent another a message (hc send); only who and when
                    if row.get('from') and row.get('to'):
                        st['messages'].append({'at': at, 'from': str(row['from']), 'to': str(row['to'])})
                    continue
                st['total'] += 1
                st['recent'].append({'at': at, 'agent': row.get('agent'), 'cwd': row.get('cwd'), 'what': row.get('what')})
    except OSError:
        pass
    st['recent'] = [e for e in st['recent'] if e['at'] * 1000 >= now - RECENT_APPROVAL_MS][-200:]
    st['messages'] = [e for e in st['messages'] if e['at'] * 1000 >= now - RECENT_APPROVAL_MS][-50:]
    return st['recent'], st


# ★66 messages between agents, from herdr-core itself (any kind of agent: Claude Code, Codex, Cursor, OpenCode ...): `hc send` puts
# <hc from="t7z name"> in front of the text the receiver gets. Only the terminals that started moving since the last look (their turn
# went up, or they turned to working) are read (terminal.read, the screen + 80 lines), at most MSG_READ_MAX a run. A mark is kept as a
# hash per terminal, so the same one is never passed twice; the first read of a terminal only learns what is there. Never the text.
MSG_MARK = re.compile(r'^[\s❯>›»│┃|*•·]*<hc from="([A-Za-z0-9_.:/-]{1,40})(?:\s[^"]{0,64})?">')
MSG_READ_MAX = 4               # terminals that started moving (a turn, or now working): the screen + history (a finished one is read by scrolling)
MSG_WORK_MAX = 8               # working ones besides: a message that comes in the middle of a turn moves neither; their screen only (about 1 ms)
MSG_READ_LINES = 80
MSG_NEW_TURNS = 2              # ★88-6 a terminal first seen with at most this many turns, after the collector's first look, is new: its marks count
MSG_SEEN_KEEP = 80
SHELL_IDLE_READ_MAX = 4

def has_background_shell(text):
    """Recognize a live background-shell count in the terminal's footer only."""
    for line in reversed(str(text or '').splitlines()[-12:]):
        codex = re.search(r'(?i)\b(\d+)\s+background\s+terminals?\s+running\b', line)
        if codex:
            return int(codex.group(1)) > 0
        if re.search(r'(?i)auto mode|bypass|shift\+tab|accept edits', line):
            shell = re.search(r'(?i)\b(\d+)\s+shells?\b', line)
            return bool(shell and int(shell.group(1)) > 0)
    return False

def is_waiting_for_shell(text):
    """Only explicit current-turn terminal-wait lines qualify."""
    for line in reversed(str(text or '').splitlines()[-12:]):
        if re.search(r'(?i)waiting for (?:a |the )?background terminal', line):
            return True
        if re.search(r'(?i)\bworking\s*\(|\bworked for\s+\d', line):
            return False
    return False

ACTIVITY_RULES = (
    (re.compile(r'번역|한글화|한국어화|locali[sz]|translation|i18n', re.I), '한국어화'),
    (re.compile(r'테스트|검증|확인|test|verif|check', re.I), '검증 중'),
    (re.compile(r'디자인|테마|화면|design|theme|layout', re.I), '화면 개선'),
    (re.compile(r'버그|오류|수정|fix|debug|error', re.I), '오류 수정'),
    (re.compile(r'커밋|commit|push|업로드', re.I), '변경 반영'),
    (re.compile(r'빌드|build|compile', re.I), '빌드 중'),
    (re.compile(r'검색|조사|분석|search|investigat|analy[sz]', re.I), '자료 분석'),
    (re.compile(r'구현|개발|코드|implement|develop|coding', re.I), '기능 개발'),
)

def recent_activity(text):
    """Prefer a short recent conversational excerpt, then a generic category."""
    lines = str(text or '').splitlines()
    for korean_only in (True, False):
        for line in reversed(lines):
            line = line.strip()
            match = re.match(r'^[›❯●⏺•]\s+(.+)', line)
            if not match:
                continue
            content = re.sub(r'\s+', ' ', match.group(1)).strip()
            if (len(content) < 4 or (korean_only and not re.search(r'[가-힣]', content))
                    or re.match(r'^(?:Ran |Running |Edited |Working|Worked|Tip:|Ask |Read |Reading |Searched |Searching |Explored |Exploring |Called |Calling |Rendering |Locating |https?://|[/\\]|[A-Za-z][\w.-]*\()', content, re.I)
                    or re.search(r'(?:password|passwd|secret|token|api[_ -]?key|비밀번호|비밀키)\s*[:=]', content, re.I)):
                continue
            return content if len(content) <= 10 else content[:9] + '…'
    for line in reversed(lines):
        line = line.strip()
        if len(line) < 4 or line.startswith(('│', '╭', '╰', '─', 'Tip:', '›')):
            continue
        for pattern, label in ACTIVITY_RULES:
            if pattern.search(line):
                return label
    return None


def message_marks(text):
    """[(sender, hash of the row)] for the rows that start with an <hc from=…> mark (a prompt row, not a command that prints one)."""
    out = []
    for line in str(text or '').splitlines():
        if '<hc from="' not in line:
            continue
        m = MSG_MARK.match(line)
        if m:
            out.append((m.group(1), hashlib.sha1(line.strip()[:200].encode('utf-8', 'replace')).hexdigest()[:12]))
    return out


def scan_messages(cache, api=None, now=None):
    """Reads the terminals that started moving; new marks go to cache['approval_events']['messages'] as {at (s), from, to} (addresses).
    Returns the number of terminals read. Never raises."""
    st = cache.setdefault('msg_scan', {'turns': {}, 'seen': {}})
    ev = cache.setdefault('approval_events', {'pos': 0, 'last_at': 0, 'recent': [], 'total': 0})
    ev.setdefault('messages', [])
    now = time.time() if now is None else now
    own = api is None
    read = 0
    try:
        api = api or HcPipe()
    except (OSError, RuntimeError):
        return 0
    try:
        terms = [t for t in (api.call('terminal.list') or {}).get('terminals', []) if t.get('state') == 'live' and t.get('status')]
        alive = {t['address'] for t in terms}
        for gone in [k for k in st['turns'] if k not in alive]:
            st['turns'].pop(gone, None)
            st['seen'].pop(gone, None)
            st.get('activity', {}).pop(gone, None)
            st.get('shell_active', {}).pop(gone, None)
            st.get('shell_waiting', {}).pop(gone, None)
        moved = []
        for t in terms:
            addr, turn, status = t['address'], t.get('turn'), t.get('status')
            status = status.get('state') if isinstance(status, dict) else status   # terminal.list gives {app, state, msg}
            prev = st['turns'].get(addr)
            st['turns'][addr] = [turn, status]
            if prev is None:
                # first sight: learn what is on its screen. ★88-6: but a terminal that is NEW while the collector has been running (it has few turns: it was just
                # started, `hc run --bg`) is read as it is: the first 5 s of its life (the brief, the first replies) are exactly when two agents talk, and they were skipped
                new_now = bool(st.get('primed')) and isinstance(turn, int) and turn <= MSG_NEW_TURNS
                moved.append((addr, not new_now))
            elif turn != prev[0] or (status == 'working' and prev[1] != 'working'):
                moved.append((addr, False))
        busy = [t['address'] for t in terms if (t['status'].get('state') if isinstance(t.get('status'), dict) else t.get('status')) == 'working'
                and t['address'] in st['seen'] and all(t['address'] != m[0] for m in moved)]
        reads = moved[:MSG_READ_MAX] + [(a, False) for a in busy[:MSG_WORK_MAX]]
        already = {a for a, _ in reads}
        resting = [t['address'] for t in terms if t['address'] not in already
                   and (t['status'].get('state') if isinstance(t['status'], dict) else t.get('status')) in ('idle', 'done')]
        if resting:
            start = int(st.get('shell_scan_offset', 0)) % len(resting)
            selected = (resting + resting)[start:start + min(SHELL_IDLE_READ_MAX, len(resting))]
            reads += [(a, False) for a in selected]
            st['shell_scan_offset'] = start + len(selected)
        for addr, learn in reads:
            try:
                text = (api.call('terminal.read', terminal=addr, lines=MSG_READ_LINES) or {}).get('text', '')
            except (OSError, ValueError, RuntimeError):
                continue
            read += 1
            st.setdefault('shell_active', {})[addr] = has_background_shell(text)
            st.setdefault('shell_waiting', {})[addr] = is_waiting_for_shell(text)
            activity = recent_activity(text)
            if activity:
                st.setdefault('activity', {})[addr] = activity
            seen = st['seen'].setdefault(addr, [])
            for sender, h in message_marks(text):
                if h in seen:
                    continue
                seen.append(h)
                if not learn and sender != addr and sender in alive:        # ★ not from itself (an echo of its own text) and not from a sender that is gone (an old line: there is nobody to walk over)
                    ev['messages'].append({'at': round(now, 3), 'from': sender, 'to': addr})
            del seen[:-MSG_SEEN_KEEP]
        st['primed'] = True                                       # the next new terminal is a new one, not the first look at old ones
        for addr, learn in moved[MSG_READ_MAX:]:                  # not read this time: looked at again next run
            if learn:
                st['turns'].pop(addr, None)                       # still a first sight next time
            else:
                st['turns'][addr][0] = None                       # counts as moved next time
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        pass
    finally:
        if own:
            try:
                api.close()
            except OSError:
                pass
    return read


DEMO_MESSAGE_MS = 40 * 1000


def demo_messages(agents, current):
    """★66 the demo: one message between two App agents every 40 s (the pair is fixed per 40 s window, so every refresh agrees)."""
    ids = sorted(a['id'] for a in agents if a.get('source') == 'app')
    if len(ids) < 2:
        return []
    out = []
    for w in (current // DEMO_MESSAGE_MS - 1, current // DEMO_MESSAGE_MS):
        h = (w * 2654435761) % (2 ** 32)
        f, t = ids[h % len(ids)], ids[(h // len(ids)) % len(ids)]
        at = w * DEMO_MESSAGE_MS + 2000
        if f != t and at <= current:
            out.append({'at': at, 'from': f, 'to': t})
    return out


def recent_messages(agents, cache):
    """★66 state.messages = [{at (ms), from, to}] (agent ids) of the last 2 minutes: the messages between two agents that are both here
    (matched by their terminal / pane address). Read after attach_approvals (it reads the file)."""
    by_addr = {str(a.get('address')): a['id'] for a in agents if a.get('address')}
    out = []
    for e in (cache.get('approval_events') or {}).get('messages', []):
        f, t = by_addr.get(e['from']), by_addr.get(e['to'])
        if f and t and f != t:
            out.append({'at': round(e['at'] * 1000), 'from': f, 'to': t})
    return out


def attach_approvals(agents, cache, path=None, now=None):
    """agents[].recent_approvals = [{at, what}] (the last 2 minutes). An event is matched to the agent whose address is the
    terminal / pane that ran the relay; else to the only agent with the same cwd. Unmatched ones are only counted (approvals_unmatched)."""
    recent, st = read_approval_events(cache, path, now)
    by_addr = {str(a.get('address')): a for a in agents if a.get('address')}
    by_cwd = {}
    for a in agents:
        if a.get('cwd'):
            by_cwd.setdefault(str(a['cwd']).lower(), []).append(a)
    for a in agents:
        a['recent_approvals'] = []
    unmatched = 0
    for e in recent:
        target = by_addr.get(str(e['agent']))
        if target is None and e.get('cwd'):
            same = by_cwd.get(str(e['cwd']).lower(), [])
            target = same[0] if len(same) == 1 else None
        if target is None:
            unmatched += 1
        else:
            target['recent_approvals'].append({'at': e['at'], 'what': e.get('what')})
    return {'recent': len(recent), 'unmatched': unmatched, 'total': st['total']}


def finish(agents, cache):
    """Fill in since/sleep/model labels and the action queue."""
    seen = cache.setdefault('since', {})
    current = now_ms()
    alive = {a['id'] for a in agents}
    for agent in agents:
        # Four states only; TUI "unknown" and anything else count as idle (shown with "?").
        agent['unknown'] = agent['status'] not in STATES
        agent['island'], agent['island_title'] = island_of(agent)
        if agent['unknown']:
            agent['status'] = 'idle'
        # A child that reported (done) to a parent that is still alive is handed back, not waiting for a person.
        parent = agent.get('parent')
        agent['parent_id'] = next((c for c in (f'app:{parent}', parent) if parent and c in alive), None)
        agent['handed_back'] = bool(agent['parent_id']) and agent['status'] == 'done'
        if agent['handed_back']:
            agent['status'] = 'idle'
        mark = seen.get(agent['id'])
        if not mark or mark['status'] != agent['status']:
            mark = seen[agent['id']] = {'status': agent['status'], 'at': current}
        agent['since'] = agent.get('since') or mark['at']
        agent['working_since'] = agent['since'] if agent['status'] == 'working' else None        # the stretch of work now going on
        born = cache.setdefault('first_seen', {})
        born.setdefault(agent['id'], current)
        agent['started_at'] = agent.get('started_at') or born[agent['id']]                       # when it was first seen (a process start time if known)
        agent['is_new'] = current - agent['started_at'] < NEWCOMER_MS
        agent['long_idle'] = agent['status'] == 'idle' and current - agent['since'] >= LONG_IDLE_MS
        vendor, family, label = model_info(agent.get('model'))
        agent.update(vendor=vendor, family=family, model_label=label)
    assign_colors(agents)  # ★101-1: no "既定: ..." any more (a CLI default is a guess; the office shows モデル不明)
    ids = {a['id'] for a in agents}
    for stale in [k for k in seen if k not in ids]:
        del seen[stale]
    queue = sorted((a for a in agents if a['status'] == 'blocked'), key=lambda a: a['since'])
    queue += sorted((a for a in agents if a['status'] == 'done'), key=lambda a: -a['since'])
    return [a['id'] for a in queue]


APP_HOME = Path(os.environ.get('HERDR_APP_HOME') or HOME / '.config' / 'herdr-app')
DEFAULT_SOURCES = {'app': True, 't3': 'auto', 'tui': 'auto'}


def load_sources(config_path):
    """officeSettings.sources of the mod's config.json: True collects, False skips, "auto" collects
    only if the box exists on this PC (and says nothing if it does not answer)."""
    try:
        config = json.loads(Path(config_path).read_text(encoding='utf-8'))
        settings = config.get('office') if isinstance(config.get('office'), dict) else config.get('officeSettings')
        given = (settings or {}).get('sources', {})
    except (OSError, ValueError, AttributeError):
        given = {}
    return {key: given.get(key, default) for key, default in DEFAULT_SOURCES.items()}


def collect(cache, sources=None):
    sources = sources or DEFAULT_SOURCES
    errors = {}
    table = process_table()
    sessions = claude_sessions(table)
    transcripts = Transcripts(cache)
    agents = []
    for key, present, gather in (
            ('t3', T3_DB.is_file, lambda: collect_t3(errors)),
            ('tui', lambda: bool(herdr_cli()), lambda: collect_tui(table, sessions, transcripts, cache, errors)),
            ('app', lambda: True, lambda: collect_core(table, sessions, transcripts, errors))):
        mode = sources.get(key, DEFAULT_SOURCES[key])
        if mode is False or (mode == 'auto' and not present()):
            continue
        found = gather()
        if mode == 'auto' and not found:
            errors.pop(key, None)     # an automatic box that does not answer is just not there
        agents += found
    queue = finish(agents, cache)
    if any(a.get('source') == 'app' for a in agents):
        try:
            scan_messages(cache)                          # ★66 before attach_approvals (which drops messages older than 2 minutes)
        except Exception:
            pass
    activities = (cache.get('msg_scan') or {}).get('activity', {})
    shells = (cache.get('msg_scan') or {}).get('shell_active', {})
    waits = (cache.get('msg_scan') or {}).get('shell_waiting', {})
    for agent in agents:
        if agent.get('source') == 'app':
            agent['shell_active'] = bool(shells.get(agent.get('address')))
            agent['shell_waiting'] = bool(waits.get(agent.get('address')))
        if agent.get('source') == 'app' and agent.get('status') == 'working':
            agent['activity'] = activities.get(agent.get('address'))
    try:
        approvals = attach_approvals(agents, cache)
    except Exception as exc:                          # the events are an extra: never break the state for them
        approvals = {'recent': 0, 'unmatched': 0, 'total': 0, 'error': str(exc)[:120]}
    attach_memory(agents, table, cache)
    counts = {key: sum(1 for a in agents if a['status'] == key) for key in ORDER}
    counts['long_idle'] = sum(1 for a in agents if a['long_idle'])
    by_source = {key: sum(1 for a in agents if a['source'] == key) for key in ('t3', 'tui', 'app')}
    claude = {'cli': sum(1 for s in sessions.values() if s.get('entrypoint') == 'cli'),
              'sdk': sum(1 for s in sessions.values() if s.get('entrypoint') == 'sdk-ts')}
    claude['total'] = len(sessions)
    return {
        'version': 1, 'updated_at': now_ms(), 'app_mem_bytes': app_memory(cache, table),  # ★90 (H) the App's private bytes
        'agents': sorted(agents, key=lambda a: (ORDER.get(a['status'], 9), a['source'], a['name'])),
        'queue': queue, 'counts': counts, 'cleanup': cleanup_list(agents), 'by_source': by_source, 'claude_sessions': claude,
        'usage': collect_usage(cache, errors), 'errors': errors,
        'codex_usage': collect_codex_usage(cache),
        'left': track_left(agents, cache), 'approvals': approvals,
        'messages': safe_messages(agents, cache),
    }


def safe_messages(agents, cache):
    try:
        return recent_messages(agents, cache)
    except Exception:                                 # an extra: never break the state for it
        return []


# ---------------------------------------------------------------- weather (Open-Meteo, asked by this collector only, every 30 minutes)

WEATHER_EVERY_MS = 30 * 60 * 1000
WEATHER_MAX_AGE_MS = 3 * 60 * 60 * 1000
# a place for each timezone offset (hours from UTC), used when the settings give no lat/lon: no service that finds a place from the IP address
WEATHER_PLACES = {9: (35.68, 139.69, '東京'), 0: (51.51, -0.13, 'London'), 1: (48.86, 2.35, 'Paris'), -5: (40.71, -74.0, 'New York'),
                  -8: (37.77, -122.42, 'San Francisco'), 8: (1.35, 103.82, 'Singapore'), 5.5: (28.61, 77.21, 'Delhi'), 10: (-33.87, 151.21, 'Sydney')}


def weather_kind(code):
    """WMO weather code -> clear / partly / cloudy / fog / rain / snow / thunder."""
    if code in (0, 1):
        return 'clear'
    if code == 2:
        return 'partly'
    if code == 3:
        return 'cloudy'
    if code in (45, 48):
        return 'fog'
    if code in (95, 96, 99):
        return 'thunder'
    if code in (71, 73, 75, 77, 85, 86):
        return 'snow'
    if code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82):
        return 'rain'
    return 'cloudy'


def load_weather_settings(config_path):
    """officeSettings.weather of the mod's config.json: {enabled (default true), lat, lon, label}."""
    try:
        config = json.loads(Path(config_path).read_text(encoding='utf-8'))
        settings = config.get('office') if isinstance(config.get('office'), dict) else config.get('officeSettings')
        given = (settings or {}).get('weather')
        return given if isinstance(given, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def find_place(name, cache):
    """A place name -> (lat, lon, label) by Open-Meteo's name search; asked once and remembered in cache.json until the name changes."""
    saved = cache.get('weather_place') or {}
    if saved.get('place') == name and isinstance(saved.get('lat'), (int, float)):
        return saved['lat'], saved['lon'], saved.get('label') or name
    query = urllib.parse.urlencode({'name': name, 'count': 1, 'language': 'en', 'format': 'json'})
    try:
        with urllib.request.urlopen('https://geocoding-api.open-meteo.com/v1/search?' + query, timeout=5) as resp:
            hit = json.loads(resp.read().decode('utf-8'))['results'][0]
        found = (float(hit['latitude']), float(hit['longitude']), str(hit.get('name') or name))
    except Exception:
        return None
    cache['weather_place'] = {'place': name, 'lat': found[0], 'lon': found[1], 'label': found[2]}
    return found


def weather_place(settings, cache=None):
    if isinstance(settings.get('lat'), (int, float)) and isinstance(settings.get('lon'), (int, float)):
        return float(settings['lat']), float(settings['lon']), str(settings.get('label') or '')
    if settings.get('place') and cache is not None:
        found = find_place(str(settings['place']), cache)
        if found:
            return found[0], found[1], str(settings.get('label') or found[2])
    offset = time.localtime().tm_gmtoff / 3600
    place = WEATHER_PLACES.get(offset)
    return (place[0], place[1], str(settings.get('label') or place[2])) if place else None


def collect_weather(cache, settings=None):
    """state.json `weather`: {kind, code, temp, is_day, sunrise, sunset (epoch ms), label, at}. Asked at most every 30 minutes; when the request fails the
    previous value is kept, and a value older than 3 hours is not used (None). `enabled: false` never asks."""
    settings = settings or {}
    if settings.get('enabled') is False:
        return None
    current = now_ms()
    saved = cache.get('weather') or {}
    data = saved.get('data')
    if data and current - saved.get('at', 0) < WEATHER_EVERY_MS:
        return data
    place = weather_place(settings, cache)
    if place:
        lat, lon, label = place
        query = urllib.parse.urlencode({'latitude': lat, 'longitude': lon, 'current': 'weather_code,temperature_2m,is_day',
                                        'daily': 'sunrise,sunset', 'timezone': 'auto', 'forecast_days': 1})
        try:
            with urllib.request.urlopen('https://api.open-meteo.com/v1/forecast?' + query, timeout=5) as resp:
                raw = json.loads(resp.read().decode('utf-8'))
            cur = raw['current']
            off = int(raw.get('utc_offset_seconds') or 0)

            def epoch(text):                              # local "2026-11-03T06:03" -> epoch ms
                try:
                    return int((datetime.strptime(text, '%Y-%m-%dT%H:%M').replace(tzinfo=None) - datetime(1970, 1, 1)).total_seconds() * 1000 - off * 1000)
                except (TypeError, ValueError):
                    return None
            daily = raw.get('daily') or {}
            data = {'kind': weather_kind(int(cur['weather_code'])), 'code': int(cur['weather_code']), 'temp': round(float(cur['temperature_2m']), 1),
                    'is_day': bool(cur.get('is_day', 1)), 'sunrise': epoch((daily.get('sunrise') or [None])[0]),
                    'sunset': epoch((daily.get('sunset') or [None])[0]), 'label': label, 'at': current}
            cache['weather'] = {'at': current, 'data': data}
            return data
        except Exception:                                  # no network, a bad answer: keep the previous value
            pass
    if data and current - data.get('at', 0) < WEATHER_MAX_AGE_MS:
        return data
    return None


# ---------------------------------------------------------------- demo

MIN = 60 * 1000


STORY_MS = 12000     # demo storyline: one step per 12 s


NAMES_DEMO = ['office-a', 'office-b', 'office-c', 'rev-cursor', 't12', 't13', 'release', 'api-w1', 'api-w2', 'fe-impl', 'fe-rev', 't21', 't22', 'ui-spec', 'qa-run',
              'data-etl', 'data-chk', 'ops-mon', 'ops-fix', 't31', 'doc-w1', 'doc-w2', 'bld-1', 'bld-2']          # ★19-3: terminal / agent names as they are in real use (no personal names)
TASKS_DEMO = ['로그인 화면: 입력 검증', '검색: 후보 표시', 'API: 인증 수정', '리뷰: PR 변경 사항', '테스트: 회귀 확인', 'DB: 마이그레이션 조사', '로그: 집계 개선', '알림: 문구 확인',
              '설정 화면: 저장 오류', '빌드: 경고 해결', '화면: 여백 조정', '보고서: 출력 확인', 'CI: 실행 시간 단축', '문서 갱신', '모니터링: 임계값 검토', '데이터: 누락 조사']   # the task each one is working on (short)
ROLES_DEMO = ['web-app', '앱 개발', 'cli-tool', 'api-gateway', '로그인 화면', '검색 페이지', 'data-pipeline', '운영 개선']                  # ★19-3: spaces / projects as in real use (★108: made-up names)


def demo_state(size=0, spaces=8, step=0, weather='clear'):
    """Made-up agents (every state, contract, model; parents and children), same shape as collect().
    size > 0: a big cast instead (size agents in `spaces` spaces, for the shrink-to-fit shots); step > 0: only the first
    `step` agents of the usual cast (islands appear one after another).
    Names are unrelated to any real work. `since` is relative to now, so the cast is always the same."""
    current = now_ms()
    # (key, source, name, app, status, minutes in this state, model, parent key, extra)
    cast = [
        ('release', 't3', '릴리스: 전체 진행 관리', 'claude-code', 'working', 42, 'claude-opus-5-5', None, {'helpers': 2}),
        ('office-a', 'app', '로그인 화면: 전체 진행', 'claude-code', 'working', 38, 'claude-opus-5-5', None, {}),
        ('office-b', 'app', '로그인 화면: 양식 구현', 'claude-code', 'working', 12, 'claude-sonnet-5-5', 'office-a', {}),
        ('rev-cursor', 'app', '로그인 화면: 입력 검증', 'copilot', 'blocked', 6, 'claude-haiku-5-5', 'office-a',
         {'blocked_kind': 'permission', 'blocked_msg': 'npm test를 실행해도 됩니까'}),
        ('office-c', 'app', '로그인 화면: 문구 확인', 'opencode', 'done', 2, 'deepseek-v4.1-flash', 'office-a', {}),
        ('t12', 'app', '로그인 화면: 버튼 색상', 'opencode', 'working', 4, 'deepseek-v4.1-flash', 'office-b', {}),
        ('t13', 'app', '로그인 화면: 여백 조정', 'claude-code', 'idle', 75, 'claude-haiku-5-5', 'office-b', {}),
        ('api-w1', 'app', '검색: 전체 진행', 'claude-code', 'working', 25, 'claude-opus-5-5', None, {}),
        ('api-w2', 'app', '검색: 후보 표시', 'codex', 'idle', 95, 'gpt-5.5', 'api-w1', {}),
        ('rev-agy', 'app', '검색: 대상 브라우저 조사', 'antigravity', 'blocked', 15, 'gemini-3.8-flash', 'api-w1',
         {'blocked_kind': 'question', 'blocked_msg': '대상 브라우저는 무엇입니까'}),
        ('core-impl', 'tui', 'core-impl', 'claude-code', 'working', 20, 'claude-sonnet-5-5', None, {}),
        ('core-plan', 'tui', 'core-plan', 'opencode', 'done', 3, 'deepseek-v4.1-flash', None, {}),
        ('core-impl-r2', 'tui', 'core-impl-r2', 'claude-code', 'idle', 130, 'claude-sonnet-5-5', None, {}),
        ('docs-rev', 'tui', 'docs-rev', 'codex', 'working', 11, 'gpt-5.5', None, {}),
    ]
    # the spaces the cast works in (the island of each): Herdr App spaces, herdr TUI workspaces, a T3 Code project (★19-3: names as in real use)
    space_of = {'release': 'cli-tool', 'office-a': '앱 개발', 'office-b': '앱 개발', 'rev-cursor': '앱 개발', 'office-c': '앱 개발', 't12': '앱 개발',
                't13': '앱 개발', 'api-w1': 'web-app', 'api-w2': 'web-app', 'rev-agy': 'web-app', 'story': 'web-app',
                'core-impl': 'cli-tool', 'core-plan': 'cli-tool', 'core-impl-r2': 'cli-tool', 'docs-rev': 'web-app'}
    if size:                                       # a big cast: `size` agents over `spaces` spaces (leader first, the rest its children)
        cast, space_of = [], {}
        statuses = ['working', 'working', 'idle', 'working', 'done', 'blocked', 'working', 'idle']
        # the spaces differ in size (★16-4: 40 people in 6 spaces: 12, 8, 7, 5, 4, 4): the base shares scaled to `size`, dealt round-robin so the leaders come first
        base = [12, 8, 7, 5, 4, 4, 3, 2][:max(1, spaces)] + [3] * max(0, spaces - 8)
        quota = [max(1, round(b_ * size / sum(base))) for b_ in base]
        quota[0] += size - sum(quota)
        deal = []
        while len(deal) < size:
            for i_, q_ in enumerate(quota):
                if quota[i_] > 0 and len(deal) < size:
                    deal.append(i_)
                    quota[i_] -= 1
        lead_of, lead_key = {}, {}
        for n in range(size):
            sp = deal[n]
            source = ('app', 'app', 'tui', 't3')[sp % 4]
            key = NAMES_DEMO[n % len(NAMES_DEMO)] + (str(n // len(NAMES_DEMO) + 1) if n >= len(NAMES_DEMO) else '')       # ★19-3: terminal names
            first = sp not in lead_of
            if first:
                lead_of[sp] = n
                lead_key[sp] = key
            parent = None if first else f'{source}:{lead_key[sp]}'
            cast.append((key, source, key if source == 'tui' else TASKS_DEMO[n % len(TASKS_DEMO)], ('claude-code', 'codex', 'cursor', 'opencode')[n % 4], statuses[n % len(statuses)],
                         5 + n * 3, ('claude-sonnet-5-5', 'gpt-5.5', 'claude-haiku-5-5')[n % 3], parent,
                         {'blocked_kind': 'permission', 'blocked_msg': '이 작업을 실행해도 됩니까'} if statuses[n % len(statuses)] == 'blocked' else {}))
            space_of[key] = ROLES_DEMO[sp % len(ROLES_DEMO)] + (str(sp // len(ROLES_DEMO) + 1) if sp >= len(ROLES_DEMO) else '')
    elif step:
        cast = cast[:step]
    # Storyline: one more agent whose state follows the clock (every STORY_MS), so a demo shows the whole life:
    # comes in -> works at its desk -> waits for approval in the line -> approved, back to the desk -> reports at the counter
    # -> dozes in the lounge (long wait) -> leaves. Each phase is STORY_MS long; "absent" = not in the list.
    story = [('working', 0, {}), ('blocked', 0, {'blocked_kind': 'permission', 'blocked_msg': '파일을 작성해도 됩니까'}),
             ('working', 0, {}), ('done', 0, {}), ('idle', 70, {}), ('idle', 90, {}), ('idle', 100, {})]
    phase_n = (current // STORY_MS) % len(story)
    st_status, st_idle_min, st_extra = story[phase_n]
    if st_status and not size and not step:
        into = current - (current // STORY_MS) * STORY_MS
        cast.append(('story', 'app', '빌드: 시나리오 예시', 'claude-code', st_status, ((st_idle_min or 0) * MIN + into) / MIN, 'claude-sonnet-5-5', None, st_extra))
    agents = []
    for key, source, name, app, status, minutes, model, parent, extra in cast:
        agents.append({
            'id': f'{source}:{key}', 'source': source, 'address': key, 'name': name, 'title': name,
            'space': space_of.get(key, '데모'), 'project': space_of.get(key) if source == 't3' else None, 'tab': '', 'cwd': None,
            'app': app, 'status': status, 'blocked_kind': extra.get('blocked_kind'),
            'blocked_msg': extra.get('blocked_msg'), 'since': int(current - minutes * MIN), 'model': model,
            'session_id': None, 'pid': None, 'labels': {}, 'parent': parent, 'helpers': extra.get('helpers', 0),
        })
    queue = finish(agents, {})
    fixed = {'api-w2': 820, 'core-impl-r2': 410, 't13': 1050}                       # MB: the three long-idle ones are the clean-up candidates
    for a in agents:
        key = a['address']
        mb = None if a['source'] == 't3' else fixed.get(key, 150 + sum(map(ord, key)) * 7919 % 450)
        a['mem_bytes'], a['mem_at'] = (mb * 1024 * 1024 if mb else None), current
    for i_, a_ in enumerate(agents):                           # for the office's life: a working stretch, a new-comer (the 2nd), when they started
        a_['working_since'] = a_['since'] if a_['status'] == 'working' else None
        a_['started_at'] = current - (4 * MIN if i_ == 1 else 3 * 60 * MIN)
        a_['is_new'] = current - a_['started_at'] < NEWCOMER_MS
    counts = {key: sum(1 for a in agents if a['status'] == key) for key in ORDER}
    counts['long_idle'] = sum(1 for a in agents if a['long_idle'])
    return {
        'version': 1, 'updated_at': current, 'demo': True,
        'agents': sorted(agents, key=lambda a: (ORDER.get(a['status'], 9), a['source'], a['name'])),
        'queue': queue, 'counts': counts, 'cleanup': cleanup_list(agents),
        'by_source': {key: sum(1 for a in agents if a['source'] == key) for key in ('t3', 'tui', 'app')},
        'claude_sessions': {'cli': 4, 'sdk': 1, 'total': 5},
        'usage': {'fetched_at': current,
                  'session': {'percent': 42, 'resets_at': current + 95 * MIN},
                  'weekly': [{'label': '全体', 'percent': 31, 'resets_at': current + 3 * 24 * 60 * MIN, 'active': True}],
                  'extra': None},
        'errors': {},
        'left': [{'id': 'demo:gone', 'name': '하나', 'island': agents[0].get('island'), 'status': 'idle', 'at': current - 20 * 1000}] if agents else [],
        'messages': demo_messages(agents, current),
        'weather': {'kind': weather, 'code': {'clear': 0, 'partly': 2, 'cloudy': 3, 'fog': 45, 'rain': 61, 'snow': 71, 'thunder': 95}.get(weather, 0), 'temp': 18.4,
                    'is_day': True, 'sunrise': None, 'sunset': None, 'label': '東京', 'at': current},
        'codex_usage': {'fetched_at': current, 'session': {'percent': 13, 'minutes': 300, 'resets_at': current + 140 * MIN},
                        'weekly': {'percent': 58, 'minutes': 10080, 'resets_at': current + 4 * 24 * 60 * MIN}},
    }


# ---------------------------------------------------------------- conversation (on click)

MAX_TEXT = 2400


def _tool_line(block):
    data = block.get('input') or {}
    detail = next((str(data[k]) for k in ('command', 'file_path', 'path', 'pattern', 'url', 'description',
                                          'prompt', 'query') if data.get(k)), '')
    return f"{block.get('name', 'tool')}: {detail}".strip(': ')[:200]


def claude_messages(path, limit):
    """Recent user / assistant / tool lines from a Claude Code transcript."""
    size = path.stat().st_size
    with path.open('rb') as f:
        f.seek(max(0, size - 3 * 1024 * 1024))
        lines = f.read().decode('utf-8', 'replace').splitlines()[1:]
    out = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get('type') not in ('user', 'assistant') or entry.get('isMeta') or entry.get('isSidechain'):
            continue
        content = (entry.get('message') or {}).get('content')
        at = iso_ms(entry.get('timestamp'))
        blocks = [{'type': 'text', 'text': content}] if isinstance(content, str) else (content or [])
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'text' and block.get('text', '').strip():
                text = block['text'].strip()
                if entry['type'] == 'user' and text.startswith(('<command-', '<local-command', '<system-reminder')):
                    continue
                out.append({'role': entry['type'], 'text': text[:MAX_TEXT], 'at': at})
            elif block.get('type') == 'tool_use':
                out.append({'role': 'tool', 'text': _tool_line(block), 'at': at})
    return out[-limit:]


def t3_messages(thread_id, limit):
    con = sqlite3.connect(f'file:{T3_DB.as_posix()}?mode=ro', uri=True, timeout=2)
    try:
        rows = con.execute('select role, created_at, payload_json from orchestration_v2_projection_messages '
                           'where thread_id=? order by created_at desc limit ?', (thread_id, limit)).fetchall()
    finally:
        con.close()
    out = []
    for role, created, payload in reversed(rows):
        try:
            text = (json.loads(payload).get('text') or '').strip()
        except ValueError:
            continue
        if text:
            out.append({'role': role, 'text': text[:MAX_TEXT], 'at': iso_ms(created)})
    return out


def screen_text(agent):
    """The terminal's recent text, for agents without a readable transcript."""
    if agent['source'] == 'app':
        api = HcPipe()
        try:
            return (api.call('terminal.read', terminal=agent['address'], lines=120) or {}).get('text', '')
        finally:
            api.close()
    result = subprocess.run([herdr_cli(), 'pane', 'read', agent['address'], '--source', 'recent-unwrapped',
                             '--lines', '120'], capture_output=True, timeout=10, creationflags=NO_WINDOW)
    return result.stdout.decode('utf-8', 'replace')


def conversation(agent_id, limit, state_path):
    state = json.loads(state_path.read_text(encoding='utf-8'))
    agent = next((a for a in state.get('agents', []) if a['id'] == agent_id), None)
    if not agent:
        return {'id': agent_id, 'error': '찾을 수 없습니다 (종료되었거나 아직 수집되지 않았습니다)', 'messages': []}
    result = {'id': agent_id, 'name': agent.get('name'), 'source': agent['source'], 'kind': 'messages',
              'messages': []}
    try:
        if agent['source'] == 't3':
            result['messages'] = t3_messages(agent['address'], limit)
        elif agent['source'] in ('app', 'tui') and str(agent.get('app') or '').lower() == 'codex':
            from codex_conversation import locate_codex, codex_messages
            screen = screen_text(agent)
            path = locate_codex(screen, CODEX_SESSIONS)
            if path:
                result['messages'] = codex_messages(path, limit)
            if not result['messages']:
                result.update(kind='screen', screen=screen[-12000:])
        elif agent.get('session_id'):
            path = Transcripts({}).path(agent['session_id'], agent.get('cwd'))
            if path:
                result['messages'] = claude_messages(path, limit)
        if not result['messages'] and result['kind'] != 'screen' and agent['source'] in ('app', 'tui'):
            result.update(kind='screen', screen=screen_text(agent)[-12000:])
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired) as exc:
        result['error'] = f'{exc.__class__.__name__}: {exc}'
    return result


def prompt_tui(agent_id, text, state_path, runner=None):
    """★74-3: send an instruction to a herdr TUI agent (`herdr agent prompt <pane> <text>`). Only source 'tui' (the App's terminals are
    driven by the App itself); a blocked agent is rejected by herdr itself (agent_blocked), never answered here. Returns a dict."""
    if not str(text or '').strip():
        return {'id': agent_id, 'ok': False, 'error': '지시가 비어 있습니다'}
    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'id': agent_id, 'ok': False, 'error': 'state.json을 읽을 수 없습니다'}
    agent = next((a for a in state.get('agents', []) if a['id'] == agent_id), None)
    if not agent:
        return {'id': agent_id, 'ok': False, 'error': '찾을 수 없습니다 (종료되었거나 아직 수집되지 않았습니다)'}
    if agent.get('source') != 'tui':
        return {'id': agent_id, 'ok': False, 'error': 'herdr TUI 에이전트에만 보낼 수 있습니다'}
    herdr = herdr_cli()
    if not herdr:
        return {'id': agent_id, 'ok': False, 'error': 'herdr를 찾을 수 없습니다'}
    argv = [herdr, 'agent', 'prompt', agent['address'], str(text)]
    try:
        result = (runner or subprocess.run)(argv, capture_output=True, timeout=15, creationflags=NO_WINDOW if os.name == 'nt' else 0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'id': agent_id, 'ok': False, 'error': f'{exc.__class__.__name__}: {exc}'}
    out = (result.stdout or b'').decode('utf-8', 'replace').strip() + ' ' + (result.stderr or b'').decode('utf-8', 'replace').strip()
    if result.returncode:
        blocked = 'agent_blocked' in out
        return {'id': agent_id, 'ok': False, 'blocked': blocked, 'error': '승인 대기 중이라 보낼 수 없습니다 (먼저 승인 화면에서 답변하세요)' if blocked else out.strip()[:300]}
    return {'id': agent_id, 'ok': True}


def write_atomic(path, text):
    """Replace path; a reader holding it open on Windows makes os.replace fail
    for a moment (WinError 5), so retry briefly before giving up."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(text, encoding='utf-8')
    for attempt in range(10):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 9:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


class RunLock:
    """One collector at a time: every HUD copy calls it, often together."""

    def __init__(self, path, stale_s=20):
        self.path, self.stale_s, self.held = path, stale_s, False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                self.held = True
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > self.stale_s:
                        self.path.unlink()  # left by a crashed run
                        continue
                except OSError:
                    pass
                return self
        return self

    def __exit__(self, *exc):
        if self.held:
            self.path.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=OUT_DIR / 'state.json')
    parser.add_argument('--stdout', action='store_true', help='also print the JSON')
    parser.add_argument('--conversation', metavar='AGENT_ID',
                        help='print the recent messages of one agent (from state.json) and exit')
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--prompt', metavar='AGENT_ID', help='★74-3: send --text to a herdr TUI agent (herdr agent prompt) and exit')
    parser.add_argument('--text', default='')
    parser.add_argument('--config', type=Path, default=APP_HOME / 'mods' / 'hakoniwa' / 'config.json',
                        help="the mod's config.json (officeSettings.sources decides which boxes are collected)")
    parser.add_argument('--demo-size', type=int, default=0, help='with --demo: a big cast of this many agents (e.g. 40)')
    parser.add_argument('--demo-spaces', type=int, default=8, help='with --demo-size: in this many spaces')
    parser.add_argument('--demo-step', type=int, default=0, help='with --demo: only the first N agents of the usual cast')
    parser.add_argument('--demo-weather', default='clear', choices=['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'thunder'], help='with --demo: the weather of the demo')
    parser.add_argument('--demo', action='store_true',
                        help='write made-up agents to state-demo.json (next to --out) and exit')
    parser.add_argument('--where', action='store_true',
                        help='★108: print where state.json is written, this Python and whether numpy / Pillow are there (the mod asks when it has no config.json), and exit')
    ns = parser.parse_args(argv)
    if ns.where:
        import importlib.util
        found = {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'PIL')}
        sys.stdout.buffer.write(json.dumps({'state_dir': str(ns.out.parent), 'state': str(ns.out), 'python': sys.executable,
                                            'version': list(sys.version_info[:2]), 'numpy': found['numpy'], 'pillow': found['PIL']}).encode('utf-8'))
        return 0
    if ns.demo:
        write_atomic(ns.out.with_name('state-demo.json'), json.dumps(demo_state(ns.demo_size, ns.demo_spaces, ns.demo_step, ns.demo_weather), ensure_ascii=False))
        return 0
    if ns.prompt:
        sys.stdout.buffer.write(json.dumps(prompt_tui(ns.prompt, ns.text, ns.out), ensure_ascii=False).encode('utf-8'))
        return 0
    if ns.conversation:
        out = json.dumps(conversation(ns.conversation, ns.limit, ns.out), ensure_ascii=False)
        sys.stdout.buffer.write(out.encode('utf-8'))
        return 0
    cache_path = ns.out.with_name('cache.json')
    with RunLock(ns.out.with_name('collector.lock')) as lock:
        if not lock.held:
            return 0  # another run is writing state.json right now
        try:
            cache = json.loads(cache_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            cache = {}
        state = collect(cache, load_sources(ns.config))
        state['weather'] = collect_weather(cache, load_weather_settings(ns.config))
        text = json.dumps(state, ensure_ascii=False)
        write_atomic(ns.out, text)
        try:
            write_atomic(cache_path, json.dumps(cache, ensure_ascii=False))
        except OSError:
            pass
    if ns.stdout:
        sys.stdout.buffer.write(text.encode('utf-8'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
