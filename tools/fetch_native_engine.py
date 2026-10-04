#!/usr/bin/env python3
"""Download the native OpenSCAD pinned in engine.json ("native") for the desktop app.

    python3 tools/fetch_native_engine.py --out build/desktop/engine            # this OS
    python3 tools/fetch_native_engine.py --out build/desktop/engine --extract build/native
    python3 tools/fetch_native_engine.py --platform linux-x86_64 --file OpenSCAD.AppImage --out ...

Linux: the AppImage file is placed in --out (the app unpacks it on first run);
--extract also unpacks it there for command-line use (workshop-cli).
Windows: the snapshot ZIP is unpacked into --out.
"""
import argparse
import hashlib
import json
import platform
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ap = argparse.ArgumentParser()
ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--platform")
ap.add_argument("--file", type=Path, help="use a local copy instead of downloading")
ap.add_argument("--extract", type=Path, help="Linux: also unpack the AppImage into this folder")
a = ap.parse_args()

plat = a.platform or {"linux": "linux-x86_64", "win32": "windows-x86_64"}.get(sys.platform)
if platform.machine().lower() not in ("x86_64", "amd64") and not a.platform:
    raise SystemExit(f"no native engine pinned for {sys.platform}/{platform.machine()}")
pins = json.loads((ROOT / "engine.json").read_text())
pin = pins["native"].get(plat or "")
if not pin:
    raise SystemExit(f"no native engine pinned for {plat}")

data = a.file.read_bytes() if a.file else urllib.request.urlopen(pin["url"], timeout=600).read()
digest = hashlib.sha256(data).hexdigest()
if digest != pin["sha256"]:
    raise SystemExit(f"checksum mismatch: got {digest}, engine.json pins {pin['sha256']}")

if a.out.exists():
    shutil.rmtree(a.out)
a.out.mkdir(parents=True)
name = pin["url"].rsplit("/", 1)[-1]
if name.endswith(".AppImage"):
    target = a.out / name
    target.write_bytes(data)
    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if a.extract:
        if a.extract.exists():
            shutil.rmtree(a.extract)
        a.extract.mkdir(parents=True)
        subprocess.run([str(target.resolve()), "--appimage-extract"], cwd=a.extract, check=True, stdout=subprocess.DEVNULL)
        print(f"unpacked -> {a.extract / 'squashfs-root'}")
else:
    tmp = a.out / "engine.zip"
    tmp.write_bytes(data)
    with zipfile.ZipFile(tmp) as z:
        z.extractall(a.out)
    tmp.unlink()
shutil.copy2(ROOT / "assets/engine/COPYING", a.out / "COPYING")
(a.out / "NOTICE.txt").write_text(
    f"OpenSCAD {pins['version']} ({plat}), official snapshot, unmodified.\nDownloaded from {pin['url']}\n"
    f"License: GNU General Public License version 2 or later.\nSource code: {pins['source']}\n")
print(f"OpenSCAD {pins['version']} {plat} -> {a.out}")
