"""Read Codex transcripts only when the visible terminal uniquely identifies one."""
import json
import re

MAX_TAIL = 3 * 1024 * 1024


def _entries(path):
    with path.open('rb') as f:
        size = f.seek(0, 2)
        f.seek(max(0, size - MAX_TAIL))
        data = f.read().decode('utf-8', 'replace').splitlines()
    if size > MAX_TAIL:
        data = data[1:]
    for line in data:
        try:
            yield json.loads(line)
        except (ValueError, TypeError):
            continue


def _text(payload):
    return '\n'.join(str(b.get('text', '')) for b in payload.get('content', [])
                     if isinstance(b, dict) and b.get('type') in ('input_text', 'output_text'))


def _normal(text):
    return re.sub(r'\s+', '', str(text)).casefold()


def _user_text(payload):
    if payload.get('type') != 'message' or payload.get('role') != 'user':
        return ''
    text = _text(payload).strip()
    if not text or text.startswith(('<', '# AGENTS.md', '[Request interrupted', 'This session is being continued')):
        return ''
    return text


def _tool_detail(payload):
    raw = payload.get('arguments') or payload.get('input') or ''
    try:
        args = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        args = {}
    if isinstance(args, dict):
        detail = next((str(args[k]) for k in ('cmd', 'command', 'path', 'file_path', 'query') if args.get(k)), '')
        if detail:
            return detail
    if isinstance(raw, str):
        match = re.search(r'\bcmd\s*:\s*("(?:\\.|[^"\\])*")', raw)
        if match:
            try:
                return json.loads(match.group(1))
            except ValueError:
                pass
        if 'tools.apply_patch' in raw:
            return '파일 수정'
        if 'tools.view_image' in raw:
            return '이미지 확인'
    return ''


def locate_codex(screen, root, limit=50):
    """Match visible user requests; ambiguity or insufficient evidence returns None."""
    prompts = []
    for line in str(screen or '').splitlines():
        m = re.match(r'^\s*[›❯]\s*(.+?)\s*$', line)
        if not m or re.match(r'Ask Codex to do anything', m.group(1), re.I):
            continue
        value = _normal(m.group(1))
        if len(value) >= 16:
            prompts.append(value)
    if not prompts:
        return None
    try:
        files = sorted(root.glob('*/*/*/rollout-*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    except OSError:
        return None
    prompt = prompts[-1]
    matches = []
    for path in files:
        try:
            for entry in _entries(path):
                if entry.get('type') != 'response_item':
                    continue
                text = _normal(_user_text(entry.get('payload') or {}))
                if text and prompt in text:
                    matches.append(path)
                    break
        except OSError:
            continue
    return matches[0] if len(matches) == 1 else None


def codex_messages(path, limit):
    out = []
    for entry in _entries(path):
        if entry.get('type') != 'response_item':
            continue
        payload = entry.get('payload') or {}
        typ, role = payload.get('type'), payload.get('role')
        if typ == 'message' and role in ('user', 'assistant'):
            text = _user_text(payload) if role == 'user' else _text(payload).strip()
            if text:
                out.append({'role': role, 'text': text[:2400], 'at': None})
        elif typ in ('function_call', 'custom_tool_call'):
            name = str(payload.get('name') or 'tool')
            detail = _tool_detail(payload)
            out.append({'role': 'tool', 'text': (name + (': ' + detail if detail else ''))[:200], 'at': None})
    return out[-limit:]
