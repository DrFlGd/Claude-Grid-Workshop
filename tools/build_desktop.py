#!/usr/bin/env python3
"""Split a built site into what the desktop app bundles.

    python3 tools/build_desktop.py --site _site --out build/desktop

  ui/    the front end loaded in the app window (HTML, JS, CSS, three.js)
  site/  data/, fs/ and parts/, shipped as app resources and read through the
         app (the WebAssembly engine in _site/engine is not needed: the app
         renders with native OpenSCAD)
The native engine goes in build/desktop/engine (tools/fetch_native_engine.py).
"""
import argparse
import shutil
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--site", type=Path, default=Path("_site"))
ap.add_argument("--out", type=Path, default=Path("build/desktop"))
a = ap.parse_args()

DATA = {"data", "fs", "parts"}
SKIP = {"engine"}  # the WebAssembly engine; the app renders natively
if not (a.site / "data/catalog.json").exists():
    raise SystemExit(f"{a.site} is not a built site; run tools/build_site.py first")
for sub in ("ui", "site"):
    if (a.out / sub).exists():
        shutil.rmtree(a.out / sub)
(a.out / "ui").mkdir(parents=True)
(a.out / "site").mkdir(parents=True)
for item in sorted(a.site.iterdir()):
    if item.name in SKIP:
        continue
    dest = a.out / ("site" if item.name in DATA else "ui") / item.name
    (shutil.copytree if item.is_dir() else shutil.copy2)(item, dest)
size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
print(f"ui {size(a.out / 'ui') / 1e6:.1f} MB, site {size(a.out / 'site') / 1e6:.1f} MB -> {a.out}")
