#!/usr/bin/env python3
"""Record when each pinned upstream commit was made, for "Updated" in the interface.

    python3 tools/source_dates.py          # fills source.commit_date in catalog/families/*.json

Fetches just the pinned commit (shallow) from each git source. Supplied files
have no upstream date; the interface uses the date they were added instead.
"""
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for f in sorted((ROOT / "catalog/families").glob("*.json")):
    fam = json.loads(f.read_text())
    src = fam.get("source") or {}
    repo, commit = src.get("repository"), src.get("commit")
    if not repo or not commit or "github.com" not in repo:
        continue
    with tempfile.TemporaryDirectory() as tmp:
        run = lambda *a: subprocess.run(["git", "-C", tmp, *a], capture_output=True, text=True)
        run("init", "-q")
        r = run("fetch", "-q", "--depth", "1", repo, commit)
        date = run("log", "-1", "--format=%cI", "FETCH_HEAD").stdout.strip() if r.returncode == 0 else ""
    if date and src.get("commit_date") != date:
        src["commit_date"] = date
        fam["source"] = src
        f.write_text(json.dumps(fam, indent=2, ensure_ascii=False) + "\n")
    print(f"{fam['id']:32s} {date or 'not found: ' + r.stderr.strip()[:80]}")
