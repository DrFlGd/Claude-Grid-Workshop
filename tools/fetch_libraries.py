#!/usr/bin/env python3
"""Fetch the OpenSCAD libraries the desktop app ships with (libraries.json).

    python3 tools/fetch_libraries.py --out build/desktop/libs
    python3 tools/fetch_libraries.py --out build/desktop/libs --from-git ~/clones   # local clones named like the libraries
    python3 tools/fetch_libraries.py --hashes --from-git ~/clones                   # print content hashes for libraries.json

Each library is downloaded from GitHub at its pinned commit (or taken from a
local git clone at that commit), reduced to the files OpenSCAD can use (.scad
and the data files they import, plus license and readme), and checked against
the pinned "content_sha256": a SHA-256 over the sorted lines "<path>\\0<file
sha256>\\n", so a download and a checkout check the same way.

Writes <out>/<Name>/... and <out>/libraries.json (the pins, with file counts).
"""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEEP_EXT = {".scad", ".stl", ".dxf", ".svg", ".dat", ".json", ".csv", ".off"}
MAX_DATA = 2_000_000  # data files larger than this are demos, not parts (threads-scad's 20 MB demo STL)
SKIP_TOP = {"tests", "test", "docs", "gallery", "examples", "scripts", "tutorials", "images", ".github"}
TOP_DOCS = ("license", "copying", "lgpl", "readme")


def wanted(rel, size=0):
    """Files the app keeps: .scad and data files outside docs/tests, and the top-level license and readme."""
    parts = rel.split("/")
    if Path(rel).suffix.lower() != ".scad" and size > MAX_DATA:
        return False
    if any(p.startswith(".") for p in parts):
        return False
    if len(parts) == 1 and parts[0].lower().startswith(TOP_DOCS):
        return True
    if parts[0] in SKIP_TOP and len(parts) > 1:
        return False
    return Path(rel).suffix.lower() in KEEP_EXT


def content_hash(files):
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel}\0{hashlib.sha256(files[rel]).hexdigest()}\n".encode())
    return h.hexdigest()


def from_tarball(pin):
    url = f"https://codeload.github.com/{pin['repo']}/tar.gz/{pin['commit']}"
    data = urllib.request.urlopen(url, timeout=600).read()
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            rel = m.name.split("/", 1)[1] if "/" in m.name else ""
            if rel and wanted(rel, m.size):
                files[rel] = t.extractfile(m).read()
    return files


def from_git(pin, clones):
    repo = clones / pin["name"]
    if not (repo / ".git").exists():
        sys.exit(f"{repo} isn't a git clone of {pin['repo']}")
    tree = subprocess.run(["git", "-C", str(repo), "ls-tree", "-r", "-l", "-z", pin["commit"]],
                          capture_output=True, check=True).stdout.decode().split("\0")
    files = {}
    for line in tree:
        if not line:
            continue
        info, rel = line.split("\t", 1)
        size = info.split()[3]
        if wanted(rel, int(size) if size.isdigit() else 0):
            files[rel] = subprocess.run(["git", "-C", str(repo), "show", f"{pin['commit']}:{rel}"], capture_output=True, check=True).stdout
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--from-git", type=Path, help="folder of local clones named like the libraries (BOSL2, MCAD, ...)")
    ap.add_argument("--hashes", action="store_true", help="print each library's content hash instead of checking it")
    ap.add_argument("--only", action="append", help="just this library (repeatable)")
    a = ap.parse_args()
    pins = json.loads((ROOT / "libraries.json").read_text())
    if a.out and not a.hashes:
        if a.out.exists():
            shutil.rmtree(a.out)
        a.out.mkdir(parents=True)
    listing = []
    for pin in pins["libraries"]:
        if a.only and pin["name"] not in a.only:
            continue
        files = from_git(pin, a.from_git) if a.from_git else from_tarball(pin)
        digest = content_hash(files)
        if a.hashes:
            print(f"{pin['name']}: {digest} ({len(files)} files)")
            continue
        if digest != pin["content_sha256"]:
            sys.exit(f"{pin['name']}: content hash {digest} doesn't match libraries.json ({pin['content_sha256']})")
        for rel, data in files.items():
            p = a.out / pin["name"] / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        size = sum(len(d) for d in files.values())
        listing.append({**pin, "files": len(files), "bytes": size})
        print(f"{pin['name']} @ {pin['commit'][:7]}: {len(files)} files, {size / 1e6:.1f} MB")
    if a.out and not a.hashes:
        (a.out / "libraries.json").write_text(json.dumps({"libraries": listing}, indent=2) + "\n")


if __name__ == "__main__":
    main()
