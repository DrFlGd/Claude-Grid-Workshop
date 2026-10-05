#!/usr/bin/env python3
"""A stand-in for the parts of GitHub's API the app uses, serving local git clones.
For testing adding projects and update checks without network access.

    python3 tests/github_mock.py --repos <folder with clones named owner__repo> --port 8795
    WORKSHOP_GITHUB_API=http://127.0.0.1:8795 workshop-cli serve ...

POST /_mock/head {"repo": "owner/repo", "sha": "<commit>"} moves a repository's
branch (simulates an upstream change); without it the clone's HEAD is used.
"""
import argparse
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--repos", type=Path, required=True)
ap.add_argument("--port", type=int, default=8795)
a = ap.parse_args()
heads = {}  # "owner/repo" -> sha
lock = threading.Lock()


def git(repo, *args, text=True):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=True, text=text).stdout


def clone(owner, name):
    p = a.repos / f"{owner}__{name}"
    if not p.is_dir():
        p = a.repos / name
    return p if (p / ".git").exists() else None


def commit_json(repo, sha):
    sha, date, author, msg = git(repo, "log", "-1", "--format=%H%x00%cI%x00%an%x00%s", sha).strip().split("\x00")
    return {"sha": sha, "commit": {"committer": {"date": date}, "author": {"name": author}, "message": msg}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/_mock/head":
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            with lock:
                heads[body["repo"].lower()] = body["sha"]
            return self.send(200, {"ok": True})
        self.send(404, {"message": "Not Found"})

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if len(parts) < 3 or parts[0] != "repos":
            return self.send(404, {"message": "Not Found"})
        owner, name = parts[1], parts[2]
        repo = clone(owner, name)
        if not repo:
            return self.send(404, {"message": "Not Found"})
        key = f"{owner}/{name}".lower()
        head = heads.get(key) or git(repo, "rev-parse", "HEAD").strip()
        branch = "master"
        if len(parts) == 3:
            lic = (repo / "LICENSE").exists() or (repo / "LICENSE.txt").exists()
            return self.send(200, {
                "name": name, "full_name": f"{owner}/{name}", "html_url": f"https://github.com/{owner}/{name}",
                "default_branch": branch, "description": f"{name} (local test copy)", "topics": ["openscad"],
                "license": {"spdx_id": "NOASSERTION"} if lic else None,
                "owner": {"login": owner, "html_url": f"https://github.com/{owner}"},
            })
        if parts[3] == "commits" and len(parts) >= 5:
            ref = "/".join(parts[4:])
            sha = head if ref in (branch, "main", "HEAD") else ref
            try:
                return self.send(200, commit_json(repo, sha))
            except subprocess.CalledProcessError:
                return self.send(404, {"message": "No commit found"})
        if parts[3] == "tarball" and len(parts) >= 5:
            sha = parts[4]
            data = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar.gz", f"--prefix={owner}-{name}-{sha[:7]}/", sha],
                                  capture_output=True, check=True).stdout
            return self.send(200, data, "application/gzip")
        if parts[3] == "compare" and len(parts) >= 5:
            base, _, target = parts[4].partition("...")
            shas = git(repo, "rev-list", "--reverse", f"{base}..{target}").split()
            files = git(repo, "diff", "--name-status", base, target).splitlines()
            return self.send(200, {"ahead_by": len(shas), "commits": [commit_json(repo, s) for s in shas],
                                   "files": [{"filename": l.split("\t")[-1], "status": l.split("\t")[0]} for l in files]})
        self.send(404, {"message": "Not Found"})


print(f"GitHub stand-in on http://127.0.0.1:{a.port}/ serving {a.repos}", flush=True)
ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
