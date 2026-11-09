"""OpenCode's own usage record, read only (hakoniwa ⑤, ★106 office-feed106).

Prints one JSON line: tokens (input + output + reasoning; the cache is not counted) and the number of answers in the last
5 hours and 24 hours, taken from OpenCode's local database. OpenCode has no quota of its own, so no "percent" is made up:
the mod shows these counts and says the limit is not available. Nothing is written, no program is started.
"""
import json
import os
import sqlite3
import sys
import time


def db_path():
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'opencode', 'opencode.db')


def main():
    path = db_path()
    if not os.path.exists(path):
        print(json.dumps({'ok': False, 'reason': 'no_db'}))
        return
    now = int(time.time() * 1000)
    out = {'ok': True, 'now': now, 'h5': {'tokens': 0, 'answers': 0}, 'h24': {'tokens': 0, 'answers': 0}, 'last': None}
    try:
        con = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=2)
        rows = con.execute(
            "select time_created, json_extract(data,'$.tokens.input'), json_extract(data,'$.tokens.output'),"
            " json_extract(data,'$.tokens.reasoning') from message"
            " where json_extract(data,'$.role')='assistant' and time_created >= ?", (now - 24 * 3600 * 1000,)).fetchall()
        con.close()
    except sqlite3.Error as exc:
        print(json.dumps({'ok': False, 'reason': exc.__class__.__name__}))
        return
    for t, i, o, r in rows:
        n = int(i or 0) + int(o or 0) + int(r or 0)
        out['last'] = max(out['last'] or 0, int(t))
        for key, span in (('h24', 24), ('h5', 5)):
            if now - int(t) <= span * 3600 * 1000:
                out[key]['tokens'] += n
                out[key]['answers'] += 1
    print(json.dumps(out))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
