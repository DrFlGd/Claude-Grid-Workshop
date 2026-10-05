#!/usr/bin/env python3
"""Thumbnails for every generator (default settings) and ready-made part.

    python3 tools/thumbnails.py --site _site --stl-dir build/stl              # STLs from `cli.mjs bench --stl-dir`
    python3 tools/thumbnails.py --site _site --native-engine <openscad>       # render missing STLs natively

Renders each STL in headless Chromium with the site's own viewer (same camera,
colour and grid for everything, transparent background) and writes WebP files to
<site>/thumbs/. catalog.json models and data/libraries/*.json items get a
"thumb" path. Models without an STL are listed and left without a thumbnail.
"""
import argparse
import base64
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--site", type=Path, default=Path("_site"))
ap.add_argument("--stl-dir", type=Path, help="STLs named <family>--<model>.stl (e.g. from cli.mjs bench --stl-dir)")
ap.add_argument("--native-engine", type=Path, help="native openscad, to render STLs that --stl-dir doesn't have")
ap.add_argument("--size", default="480x360")
ap.add_argument("--only", help="comma-separated model keys (testing)")
a = ap.parse_args()
W, H = (int(x) for x in a.size.split("x"))
site = a.site.resolve()
catalog = json.loads((site / "data/catalog.json").read_text())


def native_stl(key: str, out: Path) -> bool:
    """Default-settings render with native OpenSCAD (same layout as the desktop app)."""
    m = json.loads((site / "data/models" / (key.replace("/", "--") + ".json")).read_text())
    files = {**catalog["common_files"], **m["files"]}
    values = {p["name"]: p["default"] for p in m["parameters"]}
    values.update(m.get("fixed", {}))
    defines = [p["name"] for p in m["parameters"] if p.get("define")]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for vpath, sha in files.items():
            dst = root / vpath.lstrip("/")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(site / "fs" / sha, dst)
        ps = {k: (v if isinstance(v, str) else json.dumps(v)) for k, v in values.items() if k not in defines}
        (root / "p.json").write_text(json.dumps({"fileFormatVersion": "1", "parameterSets": {"site": ps}}))
        args = [str(a.native_engine.resolve()), str(root / m["entry"].lstrip("/"))]
        for d in defines:
            args += ["-D", f"{d}={json.dumps(values[d])}"]
        args += ["--backend=Manifold", "--export-format=binstl", "-P", "site", "-p", str(root / "p.json"), "-o", str(out)]
        env = {**os.environ, "OPENSCADPATH": str(root / "libraries"), "OPENSCAD_FONT_PATH": str(root / "fonts")}
        r = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=900)
        return r.returncode == 0 and out.exists() and out.stat().st_size > 84


# ---- collect STLs: generators (default render) and parts (their preview STL)
work = Path(tempfile.mkdtemp(prefix="thumbs-"))
jobs = []  # (kind, id, stl url relative to the served root, output path relative to site)
keys = [m["key"] for m in catalog["models"]]
if a.only:
    keys = [k for k in keys if k in a.only.split(",")]
missing = []
for key in keys:
    name = key.replace("/", "--")
    src = a.stl_dir / f"{name}.stl" if a.stl_dir else None
    dst = work / f"{name}.stl"
    if src and src.exists():
        shutil.copyfile(src, dst)
    elif not (a.native_engine and native_stl(key, dst)):
        missing.append(key)
        continue
    jobs.append(("gen", key, f"_work/{name}.stl", f"thumbs/gen/{name}.webp"))
libs = {}
for lib in catalog.get("libraries", []):
    detail = json.loads((site / "data/libraries" / f"{lib['id']}.json").read_text())
    libs[lib["id"]] = detail
    if a.only:
        continue
    for it in detail["items"]:
        if it.get("preview_url"):
            jobs.append(("part", f"{lib['id']}/{it['id']}", it["preview_url"], f"thumbs/part/{lib['id']}--{it['id']}.webp"))

# ---- render in Chromium with the site's viewer, served from the site folder
page_dir = site / "_thumb"
page_dir.mkdir(exist_ok=True)
(site / "_work").mkdir(exist_ok=True)
for f in work.iterdir():
    shutil.copyfile(f, site / "_work" / f.name)
(page_dir / "index.html").write_text(f"""<!doctype html><html><head>
<script type="importmap">{{ "imports": {{ "three": "../vendor/three/three.module.js" }} }}</script>
<style>html,body{{margin:0;background:transparent}} #wrap{{width:{W}px;height:{H}px}} canvas{{width:100%;height:100%;display:block}}</style>
</head><body><div id="wrap"><canvas id="c"></canvas></div>
<script type="module">
import {{ Viewer }} from "../viewer.js";
const v = new Viewer(document.getElementById("c"));
v.renderer.setPixelRatio(1);
v.setEdges(false);
v.setGrid(false); // part only, on a transparent background: works on light and dark cards
window.thumb = async (url) => {{
  await v.load("../" + url);
  v.view("iso");
  // frame tightly (the viewer leaves room for orbiting and has a minimum size for small parts)
  const size = v.bbox.getSize(v.camera.position.clone());
  const r = Math.max(size.length() / 2, 1);
  const dist = r / Math.sin((v.camera.fov / 2) * Math.PI / 180) * 0.95;
  const dir = v.camera.position.clone().sub(v.controls.target).normalize();
  v.camera.position.copy(v.controls.target).addScaledVector(dir, dist);
  v.camera.near = dist / 200; v.camera.far = dist * 50; v.camera.updateProjectionMatrix();
  v.controls.update();
  v.resize();
  v.renderer.render(v.scene, v.camera);
  return v.renderer.domElement.toDataURL("image/webp", 0.86);
}};
window.ready = true;
</script></body></html>""")

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


handler = functools.partial(Quiet, directory=str(site))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

from playwright.sync_api import sync_playwright  # noqa: E402

done, failed = {}, []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": W, "height": H})
        pg.goto(f"http://127.0.0.1:{port}/_thumb/index.html")
        pg.wait_for_function("window.ready === true")
        for kind, ident, url, out in jobs:
            try:
                data = pg.evaluate("(u) => window.thumb(u)", url)
                target = site / out
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(data.split(",", 1)[1]))
                done[(kind, ident)] = out
            except Exception as e:  # keep going; report at the end
                failed.append(f"{ident}: {e}")
        b.close()
finally:
    server.shutdown()
    shutil.rmtree(page_dir, ignore_errors=True)
    shutil.rmtree(site / "_work", ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)

# ---- record the paths
for m in catalog["models"]:
    if ("gen", m["key"]) in done:
        m["thumb"] = done[("gen", m["key"])]
(site / "data/catalog.json").write_text(json.dumps(catalog, separators=(",", ":")))
for lid, detail in libs.items():
    for it in detail["items"]:
        if ("part", f"{lid}/{it['id']}") in done:
            it["thumb"] = done[("part", f"{lid}/{it['id']}")]
    (site / "data/libraries" / f"{lid}.json").write_text(json.dumps(detail, separators=(",", ":")))

size = sum((site / v).stat().st_size for v in done.values())
print(f"thumbnails: {sum(1 for k in done if k[0] == 'gen')} generators, {sum(1 for k in done if k[0] == 'part')} parts, "
      f"{size / 1e6:.1f} MB")
for k in missing:
    print("NO STL:", k, file=sys.stderr)
for f in failed:
    print("FAILED:", f, file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::error title=thumbnails::{f[:900]}")
sys.exit(1 if failed else 0)
