#!/usr/bin/env python3
"""Build the static website (GitHub Pages) into _site/.

    python3 tools/build_site.py --engine path/to/openscad-wasm [--out _site] [--cli workshop-cli]

Steps
1. Copy the front end (web/) and the OpenSCAD WebAssembly engine.
2. Catalog (workshop-cli site-prepare, from desktop/core: the same project reading
   as the desktop app's library ingest): for every available catalog model, find the
   files it needs by following include/use/import from its entrypoint, as OpenSCAD
   would (next to the including file first, then the family's library folders,
   mounted at /libraries in the engine). Files are stored once, by content hash, in fs/.
3. Ask the engine for each model's Customizer parameters (--export-format=param;
   desktop-only models with native OpenSCAD), then layer on site settings with
   workshop-cli site-finish: the family manifest (fixed/hidden/defaults/ui) and the
   upstream project's editor.toml (display conditions, presets, help links,
   collapsed tabs, warnings).
4. Copy part libraries and make STL previews for their 3MF files.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))


# ---------------------------------------------------------------- catalog (Rust)
def find_cli(given: Path | None) -> Path:
    """workshop-cli, built from desktop/core (cargo build --release -p workshop-core)."""
    exe = "workshop-cli.exe" if os.name == "nt" else "workshop-cli"
    for c in [given, os.environ.get("WORKSHOP_CLI") and Path(os.environ["WORKSHOP_CLI"]),
              ROOT / "desktop/target/release" / exe, ROOT / "desktop/target/debug" / exe]:
        if c and Path(c).is_file():
            return Path(c)
    raise SystemExit("workshop-cli not found: build it with `cd desktop && cargo build --release -p workshop-core`, "
                     "or pass --cli / set WORKSHOP_CLI")


# ---------------------------------------------------------------- libraries
def build_libraries(out: Path) -> list[dict]:
    from mesh_stats import load as load_mesh
    import numpy as np
    import struct

    listing = []
    (out / "data/libraries").mkdir(parents=True, exist_ok=True)
    for f in sorted((ROOT / "catalog/libraries").glob("*.json")):
        if f.name.startswith("_"):
            continue
        lib = json.loads(f.read_text())
        if lib.get("status", "available") != "available":
            continue
        base = ROOT / lib.get("storage", {}).get("base", f"libraries/{lib['id']}/")
        dest = out / "parts" / lib["id"]
        for item in lib["items"]:
            for fe in item["files"]:
                src = base / fe["path"]
                tgt = dest / fe["path"]
                tgt.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, tgt)
                fe["url"] = f"parts/{lib['id']}/{fe['path']}"
                fe.pop("sha256", None)
            if item.get("preview"):
                src = base / item["preview"]
                if src.suffix.lower() == ".stl":
                    item["preview_url"] = f"parts/{lib['id']}/{item['preview']}"
                else:
                    tris = load_mesh(src).astype("<f4")
                    rec = np.zeros(len(tris), dtype=np.dtype([("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")]))
                    rec["v"] = tris.reshape(-1, 9)
                    pv = dest / "_preview" / f"{item['id']}.stl"
                    pv.parent.mkdir(parents=True, exist_ok=True)
                    pv.write_bytes(b"preview".ljust(80, b" ") + struct.pack("<I", len(tris)) + rec.tobytes())
                    item["preview_url"] = f"parts/{lib['id']}/_preview/{item['id']}.stl"
        public = {k: v for k, v in lib.items() if not k.startswith("$")}
        public["item_count"] = len(lib["items"])
        public["categories"] = sorted({i["category"] for i in lib["items"]})
        (out / f"data/libraries/{lib['id']}.json").write_text(json.dumps(public, separators=(",", ":")))
        listing.append({k: public[k] for k in ("id", "name", "summary", "item_count", "categories", "license", "authors") if k in public})
    return listing


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", type=Path, required=True, help="folder with openscad.js and openscad.wasm")
    ap.add_argument("--out", type=Path, default=ROOT / "_site")
    ap.add_argument("--public", action="store_true", help="hide families not cleared for public use")
    ap.add_argument("--hide-blocked", action="store_true", help="hide only families whose license is marked blocked")
    ap.add_argument("--skip-libraries", action="store_true")
    ap.add_argument("--native-engine", type=Path,
                    help="native openscad executable; needed to include desktop-only models (\"browser\": false)")
    ap.add_argument("--cli", type=Path, help="workshop-cli (default: desktop/target/release, or $WORKSHOP_CLI)")
    args = ap.parse_args()
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    (out / ".nojekyll").write_text("")
    (out / "engine").mkdir()
    for name in ("openscad.js", "openscad.wasm"):
        shutil.copy2(args.engine / name, out / "engine" / name)
    for extra in ("COPYING", "LICENSE", "README.md", "NOTICE.txt"):
        if (args.engine / extra).exists():
            shutil.copy2(args.engine / extra, out / "engine" / extra)
    engine_version = subprocess.run(["node", str(ROOT / "tools/engine/cli.mjs"), "version", str(args.engine)],
                                    capture_output=True, text=True, check=True).stdout.strip()

    # Catalog: the same project reading as the desktop app's library ingest (desktop/core,
    # src/ingest.rs + src/sitebuild.rs): files by following include/use/import, settings from
    # OpenSCAD's Customizer export, then the family manifests' and editor.toml metadata.
    cli = find_cli(args.cli)
    flags = (["--desktop"] if args.native_engine else []) + (["--public"] if args.public else []) + \
        (["--hide-blocked"] if args.hide_blocked else [])
    prep = subprocess.run([str(cli), "site-prepare", "--repo", str(ROOT), "--out", str(out), *flags],
                          capture_output=True, text=True)
    sys.stderr.write(prep.stderr)
    if prep.returncode:
        raise SystemExit(prep.returncode)
    browser_keys = [k for k in prep.stdout.split("\n") if k.strip()]
    raw = subprocess.run(["node", str(ROOT / "tools/engine/cli.mjs"), "params", str(args.engine), str(out), *browser_keys],
                         capture_output=True, text=True, check=True).stdout
    (out / ".build/params-wasm.json").write_text(raw)
    fin = subprocess.run([str(cli), "site-finish", "--repo", str(ROOT), "--out", str(out), "--params",
                          str(out / ".build/params-wasm.json"), "--engine-version", engine_version,
                          *(["--native-engine", str(args.native_engine.resolve())] if args.native_engine else [])],
                         capture_output=True, text=True)
    sys.stderr.write(fin.stderr)
    if os.environ.get("GITHUB_ACTIONS"):  # CI logs aren't always reachable; annotations are
        for line in (prep.stderr + fin.stderr).splitlines():
            if line.startswith(("PROBLEM", "error")):
                print(f"::error title=build_site::{line[:900]}")
    if fin.returncode not in (0, 1):
        raise SystemExit(fin.returncode)
    catalog = json.loads((out / "data/catalog.json").read_text())
    libraries = [] if args.skip_libraries else build_libraries(out)
    catalog["libraries"] = libraries
    (out / "data/catalog.json").write_text(json.dumps(catalog, separators=(",", ":")))
    shutil.rmtree(out / ".build", ignore_errors=True)
    print(f"engine {engine_version}; {len(catalog['models'])} models; {len(libraries)} libraries; "
          f"{len(list((out / 'fs').iterdir()))} source files")
    return fin.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as e:
        if os.environ.get("GITHUB_ACTIONS"):
            print(f"::error title=build_site::{' '.join(map(str, e.cmd))[:300]} failed: {(e.stderr or '')[-900:]}".replace("\n", "%0A"))
        raise
