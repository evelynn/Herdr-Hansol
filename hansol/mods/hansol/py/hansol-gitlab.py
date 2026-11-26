"""hansol: a GitLab repository's open merge requests, open issues and recent pipelines, as one JSON object on stdout.

    python hansol-gitlab.py <repository folder>

Read only. The token is the one Git already keeps for that host (`git credential fill`, the Windows credential manager):
it is never printed, written or passed on the command line. Used by the Git window's "원격" side (git-tree.js).
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


def git(root, *args, stdin=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    r = subprocess.run(["git", "-C", root, *args], input=stdin, capture_output=True, text=True, timeout=20, env=env)
    return r.returncode, r.stdout


def remote_of(root):
    """(host, project path) of the first GitLab-looking remote (origin first)."""
    code, out = git(root, "remote")
    names = [n for n in out.split() if n]
    names.sort(key=lambda n: n != "origin")
    for n in names:
        _, url = git(root, "remote", "get-url", n)
        url = url.strip()
        m = re.match(r"^(?:https?://)(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+?)(?:\.git)?/?$", url) or re.match(r"^(?:ssh://)?[^@]+@([^:/]+)[:/](?:\d+/)?(.+?)(?:\.git)?/?$", url)
        if m and "github.com" not in m.group(1):
            return m.group(1), m.group(2)
    return None, None


def token_for(root, host):
    code, out = git(root, "-c", "credential.interactive=never", "credential", "fill", stdin=f"protocol=https\nhost={host}\n\n")
    if code:
        return None
    for line in out.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib copies every header (the token too) to a redirect's target, whatever its host: no redirects at all."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirect to another address refused ({code})", headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def get(host, path, token):
    url = f"https://{host}/api/v4/{path}"
    last = None
    for header in (("PRIVATE-TOKEN", token), ("Authorization", f"Bearer {token}")):
        req = urllib.request.Request(url, headers={header[0]: header[1], "Accept": "application/json"})
        try:
            with OPENER.open(req, timeout=15) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code != 401:
                break
    raise last


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "저장소 폴더가 필요함"}, ensure_ascii=False))
        return
    root = sys.argv[1]
    host, project = remote_of(root)
    if not host:
        print(json.dumps({"ok": False, "error": "GitLab 원격 저장소가 없음"}, ensure_ascii=False))
        return
    token = token_for(root, host)
    if not token:
        print(json.dumps({"ok": False, "host": host, "project": project, "error": f"{host}의 Git 자격 증명(토큰)이 없음"}, ensure_ascii=False))
        return
    pid = urllib.parse.quote(project, safe="")
    out = {"ok": True, "host": host, "project": project, "web": f"https://{host}/{project}"}
    try:
        mrs = get(host, f"projects/{pid}/merge_requests?state=opened&per_page=20&order_by=updated_at", token)
        issues = get(host, f"projects/{pid}/issues?state=opened&per_page=20&order_by=updated_at", token)
        pipes = get(host, f"projects/{pid}/pipelines?per_page=8", token)
    except urllib.error.HTTPError as e:
        print(json.dumps({**out, "ok": False, "error": f"GitLab API {e.code}: {e.reason}"}, ensure_ascii=False))
        return
    except Exception as e:  # network, certificate, JSON
        print(json.dumps({**out, "ok": False, "error": f"GitLab에 연결하지 못함: {type(e).__name__}: {str(e)[:160]}"}, ensure_ascii=False))
        return
    out["mrs"] = [{"iid": m.get("iid"), "title": m.get("title", ""), "author": (m.get("author") or {}).get("name", ""), "source": m.get("source_branch", ""),
                   "target": m.get("target_branch", ""), "draft": bool(m.get("draft") or m.get("work_in_progress")), "url": m.get("web_url", ""), "updated": m.get("updated_at", "")} for m in mrs]
    out["issues"] = [{"iid": i.get("iid"), "title": i.get("title", ""), "author": (i.get("author") or {}).get("name", ""), "labels": i.get("labels", [])[:4],
                      "url": i.get("web_url", ""), "updated": i.get("updated_at", "")} for i in issues]
    out["pipelines"] = [{"id": p.get("id"), "status": p.get("status", ""), "ref": p.get("ref", ""), "url": p.get("web_url", ""), "created": p.get("created_at", "")} for p in pipes]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
