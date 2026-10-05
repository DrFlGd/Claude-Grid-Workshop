#!/usr/bin/env python3
"""Split a built site into what the desktop app bundles.

    python3 tools/build_desktop.py --site _site --out build/desktop [--fetch-fonts] [--cli workshop-cli]

  ui/       the front end loaded in the app window (HTML, JS, CSS, three.js, and
            the WebAssembly engine, which the Windows app races against native
            OpenSCAD because it is faster for some projects there)
  site/     the app's own files: data/catalog.json (engine version, common files)
            and fs/ (the fonts every render gets)
  starter/  the starter library: every generator and parts pack of the site,
            packaged as library projects (workshop-cli bundle). The app copies
            them into the user's library on first start.
  libs/     the OpenSCAD libraries the app ships with (fetched beforehand by
            tools/fetch_libraries.py --out build/desktop/libs); this adds the index
            of their modules (Components), libs/index/<Name>.json
The native engine goes in build/desktop/engine (tools/fetch_native_engine.py).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from build_site import find_cli  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--site", type=Path, default=Path("_site"))
ap.add_argument("--out", type=Path, default=Path("build/desktop"))
ap.add_argument("--cli", type=Path, help="workshop-cli (default: desktop/target/release, or $WORKSHOP_CLI)")
ap.add_argument("--fetch-fonts", action="store_true",
                help="bundle the Archivo UI font (SIL OFL, from google/fonts) instead of loading it from Google Fonts")
a = ap.parse_args()

DATA = {"data", "fs", "parts", "thumbs"}  # library content: goes into the starter library, not the window
if not (a.site / "data/catalog.json").exists():
    raise SystemExit(f"{a.site} is not a built site; run tools/build_site.py first")
for sub in ("ui", "site", "starter"):
    if (a.out / sub).exists():
        shutil.rmtree(a.out / sub)
(a.out / "ui").mkdir(parents=True)
for item in sorted(a.site.iterdir()):
    if item.name in DATA:
        continue
    dest = a.out / "ui" / item.name
    (shutil.copytree if item.is_dir() else shutil.copy2)(item, dest)

# the app's own files: engine version and the fonts every model gets
catalog = json.loads((a.site / "data/catalog.json").read_text())
(a.out / "site/data").mkdir(parents=True)
(a.out / "site/fs").mkdir()
(a.out / "site/data/catalog.json").write_text(json.dumps({"engine": catalog["engine"], "common_files": catalog["common_files"]}))
for sha in catalog["common_files"].values():
    shutil.copy2(a.site / "fs" / sha, a.out / "site/fs" / sha)

# everything else becomes the starter library
subprocess.run([str(find_cli(a.cli)), "bundle", "--site", str(a.site), "--out", str(a.out / "starter")], check=True)

# the bundled libraries' modules (Components)
if (a.out / "libs/libraries.json").exists():
    shutil.copy2(ROOT / "catalog/components.json", a.out / "libs/components.json")  # start values for modules without examples
    subprocess.run([str(find_cli(a.cli)), "libs-index", "--libs", str(a.out / "libs")], check=True)
else:
    print("no bundled libraries (run tools/fetch_libraries.py --out build/desktop/libs first): the app will have no Components", file=sys.stderr)

# The app works offline: no Google Fonts request. Bundle Archivo if asked (CI does),
# otherwise fall back to system fonts.
FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/"
index = a.out / "ui/index.html"
html = index.read_text()
lines = [l for l in html.splitlines() if "fonts.googleapis.com" not in l and "fonts.gstatic.com" not in l]
font_css = ""
if a.fetch_fonts:
    import urllib.request
    fonts = a.out / "ui/vendor/fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    for remote, local in (("Archivo%5Bwdth%2Cwght%5D.ttf", "Archivo-Variable.ttf"), ("OFL.txt", "Archivo-OFL.txt")):
        (fonts / local).write_bytes(urllib.request.urlopen(FONT_URL + remote, timeout=60).read())
    (fonts / "archivo.css").write_text(
        "@font-face { font-family: 'Archivo'; src: url('Archivo-Variable.ttf') format('truetype');\n"
        "  font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; }\n")
    font_css = '  <link rel="stylesheet" href="vendor/fonts/archivo.css">'
out_lines = []
for l in lines:
    if font_css and 'href="styles.css"' in l:
        out_lines.append(font_css)
    out_lines.append(l)
index.write_text("\n".join(out_lines) + "\n")

size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
print(f"ui {size(a.out / 'ui') / 1e6:.1f} MB, site {size(a.out / 'site') / 1e6:.1f} MB, "
      f"starter library {size(a.out / 'starter') / 1e6:.1f} MB, "
      f"libraries {size(a.out / 'libs') / 1e6 if (a.out / 'libs').exists() else 0:.1f} MB -> {a.out}")
