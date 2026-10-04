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
ap.add_argument("--fetch-fonts", action="store_true",
                help="bundle the Archivo UI font (SIL OFL, from google/fonts) instead of loading it from Google Fonts")
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
print(f"ui {size(a.out / 'ui') / 1e6:.1f} MB, site {size(a.out / 'site') / 1e6:.1f} MB -> {a.out}")
