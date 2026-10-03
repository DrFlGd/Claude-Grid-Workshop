#!/usr/bin/env python3
"""Download the pinned OpenSCAD WebAssembly engine (engine.json) and verify it.

    python3 tools/fetch_engine.py --out build/engine            # download
    python3 tools/fetch_engine.py --out build/engine --zip f.zip  # use a local copy
"""
import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ap = argparse.ArgumentParser()
ap.add_argument("--out", type=Path, default=ROOT / "build/engine")
ap.add_argument("--zip", type=Path)
a = ap.parse_args()
pin = json.loads((ROOT / "engine.json").read_text())
data = a.zip.read_bytes() if a.zip else urllib.request.urlopen(pin["url"], timeout=120).read()
digest = hashlib.sha256(data).hexdigest()
if digest != pin["sha256"]:
    raise SystemExit(f"checksum mismatch: got {digest}, engine.json pins {pin['sha256']}")
if a.out.exists():
    shutil.rmtree(a.out)
a.out.mkdir(parents=True)
tmp = a.out / "engine.zip"
tmp.write_bytes(data)
with zipfile.ZipFile(tmp) as z:
    for name in z.namelist():
        if name.rsplit("/", 1)[-1] in ("openscad.js", "openscad.wasm"):
            (a.out / name.rsplit("/", 1)[-1]).write_bytes(z.read(name))
tmp.unlink()
shutil.copy2(ROOT / "assets/engine/COPYING", a.out / "COPYING")
(a.out / "NOTICE.txt").write_text(
    f"OpenSCAD {pin['version']} WebAssembly build, unmodified.\nDownloaded from {pin['url']}\n"
    f"License: GNU General Public License version 2 or later.\nSource code: {pin['source']}\n")
print(f"OpenSCAD {pin['version']} -> {a.out}")
