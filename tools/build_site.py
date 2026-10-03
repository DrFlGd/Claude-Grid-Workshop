#!/usr/bin/env python3
"""Build the static website (GitHub Pages) into _site/.

    python3 tools/build_site.py --engine path/to/openscad-wasm [--out _site]

Steps
1. Copy the front end (web/) and the OpenSCAD WebAssembly engine.
2. For every available catalog model, find the files it needs by following
   include/use/import from its entrypoint, as OpenSCAD would: next to the
   including file first, then the family's library folders (mounted at
   /libraries in the engine). Files are stored once, by content hash, in fs/.
3. Ask the engine for each model's Customizer parameters
   (--export-format=param), then layer on site settings: the family manifest
   (fixed/hidden/defaults/ui) and the upstream project's editor.toml
   (web-openscad-editor format: display conditions, presets, help links,
   collapsed tabs, warnings).
4. Copy part libraries and make STL previews for their 3MF files.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

INCLUDE_RE = re.compile(r"^\s*(?:include|use)\s*<([^>]+)>")
IMPORT_RE = re.compile(r"""\b(?:import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"]+)\"""")
CATEGORY_LABELS = {"gridfinity": "Gridfinity", "carrying": "Boxes & Baskets", "labels": "Labels",
                   "wall": "Wall Storage", "other": "Other"}
FONTS_DIR = ROOT / "assets/fonts"


class Store:
    """Content-addressed files under <out>/fs/<sha256>."""

    def __init__(self, out: Path):
        self.dir = out / "fs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.bytes = 0

    def put(self, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        p = self.dir / sha
        if not p.exists():
            p.write_bytes(data)
            self.bytes += len(data)
        return sha


# ---------------------------------------------------------------- dependencies
def collect_files(entry: str, library_paths: list[str]) -> tuple[dict[str, Path], list[str]]:
    """Return {virtual path: host path} for an entrypoint, plus unresolved references."""
    libs = [ROOT / p for p in library_paths]

    def host(v: str) -> Path | None:
        if v.startswith("/libraries/"):
            rel = v[len("/libraries/"):]
            for lib in libs:
                if (lib / rel).is_file():
                    return lib / rel
            return None
        p = ROOT / v.lstrip("/")
        return p if p.is_file() else None

    files: dict[str, Path] = {}
    missing: list[str] = []
    todo = ["/" + entry]
    while todo:
        v = todo.pop()
        if v in files:
            continue
        h = host(v)
        if h is None:
            missing.append(v)
            continue
        files[v] = h
        if h.suffix.lower() != ".scad":
            continue
        text = h.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
        base = posixpath.dirname(v)
        for line in text.splitlines():
            line = line.split("//", 1)[0]
            m = INCLUDE_RE.match(line)
            if m:
                ref = m.group(1).strip()
                rel = posixpath.normpath(posixpath.join(base, ref))
                todo.append(rel if host(rel) else "/libraries/" + posixpath.normpath(ref))
                continue
            for imp in IMPORT_RE.findall(line):
                rel = posixpath.normpath(posixpath.join(base, imp))
                if host(rel):
                    todo.append(rel)
    return files, sorted(set(missing))


# ---------------------------------------------------------------- editor.toml
def load_editor_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text()) if path.is_file() else {}


def editor_model_meta(cfg: dict, model_file: str) -> dict:
    """Merge templates (default + named) and the [[model]] entry for one file."""
    if not cfg:
        return {}
    templates = cfg.get("model-template", {})

    def resolve(name, seen=()):
        t = templates.get(name, {})
        chain = []
        for parent in t.get("template", []) if isinstance(t.get("template"), list) else ([t["template"]] if t.get("template") else []):
            if parent not in seen:
                chain += resolve(parent, seen + (name,))
        return chain + [t]

    for model in cfg.get("model", []):
        if model.get("file") != model_file:
            continue
        names = model.get("template", ["default"])
        names = [names] if isinstance(names, str) else names
        if "default" not in names and "template" not in model:
            names = ["default"] + names
        layers = []
        for n in names:
            layers += resolve(n)
        # web-openscad-editor applies templates whose name starts with "section-" to models
        # that contain the referenced tab; include them generically (they only add tab metadata)
        layers += [t for n, t in templates.items() if n.startswith("section-")]
        layers.append(model)
        merged: dict = {"param-metadata": [], "tab-metadata": {}}
        for layer in layers:
            for k, v in layer.items():
                if k == "param-metadata":
                    merged["param-metadata"] += list(v.items())
                elif k == "tab-metadata":
                    for tab, meta in v.items():
                        merged["tab-metadata"].setdefault(tab, {}).update(meta)
                elif k not in ("file", "template"):
                    merged[k] = v
        return merged
    return {}


SAFE_TAGS = {"a", "b", "strong", "i", "em", "br", "p", "span", "code", "ul", "ol", "li", "div", "small"}


def clean_html(html: str | None) -> str | None:
    """Keep simple formatting only (the browser re-sanitises too)."""
    if not html:
        return None
    html = re.sub(r"<\s*(script|style|iframe|object|embed)[^>]*>.*?<\s*/\s*\1\s*>", "", html, flags=re.S | re.I)
    html = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", html, flags=re.I)
    html = re.sub(r"javascript:", "", html, flags=re.I)
    return html.strip()


# ---------------------------------------------------------------- parameters
def convert_params(raw: dict) -> tuple[list[dict], list[str]]:
    """OpenSCAD's --export-format=param output -> the site's parameter schema."""
    params, groups = [], []
    for p in raw.get("parameters", []):
        group = p.get("group") or "Parameters"
        if group.lower() == "hidden" or p["name"].startswith("$"):
            continue  # $fn/$fa/$fs quality knobs stay at the model's defaults
        initial = p.get("initial")
        out = {"name": p["name"], "group": group, "description": (p.get("caption") or "").strip() or None, "default": initial}
        if isinstance(initial, bool):
            out["type"], out["widget"] = "boolean", "checkbox"
        elif isinstance(initial, list):
            out["type"] = "number[]" if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in initial) else "list"
            out["widget"] = "vector"
        elif isinstance(initial, (int, float)):
            out["type"], out["widget"] = "number", "number"
        else:
            out["type"], out["widget"] = "string", "text"
        for k in ("min", "max", "step"):
            if p.get(k) is not None:
                out[k] = p[k]
        if p.get("options"):
            out["widget"] = "dropdown"
            out["options"] = [{"value": o.get("value"), "label": str(o.get("name", o.get("value")))} for o in p["options"]]
            if all(o["value"] != initial for o in out["options"]):
                out["options"].insert(0, {"value": initial, "label": str(initial)})
        elif out["type"] == "number" and "max" in out and "min" in out:
            out["widget"] = "slider"
        # normalise floats that are integers (OpenSCAD exports 3 as 3.0)
        for k in ("default", "min", "max", "step"):
            v = out.get(k)
            if isinstance(v, float) and v.is_integer():
                out[k] = int(v)
            elif isinstance(v, list):
                out[k] = [int(x) if isinstance(x, float) and x.is_integer() else x for x in v]
        if out.get("options"):
            for o in out["options"]:
                if isinstance(o["value"], float) and o["value"].is_integer():
                    o["value"] = int(o["value"])
        params.append(out)
        if group not in groups:
            groups.append(group)
    return params, groups


def apply_metadata(params: list[dict], groups: list[str], fam: dict, model: dict, meta: dict) -> tuple[list, dict]:
    fixed = dict(model.get("fixed", {}))
    hidden = set(model.get("hidden", [])) | set(fixed)
    defaults = model.get("defaults", {})
    ui = model.get("ui", {})
    names = {p["name"] for p in params}
    pmeta = meta.get("param-metadata", [])
    out = []
    for p in params:
        if p["name"] in hidden:
            continue
        p = dict(p)
        if p["name"] in defaults:
            p["default"] = defaults[p["name"]]
        m: dict = {}
        for pattern, md in pmeta:
            if fnmatch.fnmatchcase(p["name"], pattern):
                m.update(md)
        m.update(ui.get(p["name"], {}))
        cond = m.get("display-condition")
        if isinstance(cond, dict):
            if cond.get("fixed") is False:
                p["hidden"] = True
            elif cond.get("js"):
                p["show_if"] = cond["js"]
        if m.get("help-link"):
            p["help_link"] = m["help-link"]
        if m.get("description-html"):
            p["description_html"] = clean_html(m["description-html"])
        if isinstance(m.get("presets"), dict) and m["presets"].get("values"):
            p["presets"] = {"label": m["presets"].get("text", "Presets"),
                            "values": [{"label": k, "value": v} for k, v in m["presets"]["values"].items()]}
        for k in ("label", "unit", "advanced"):
            if k in m:
                p[k] = m[k]
        out.append(p)
    tabs = {}
    for tab, tm in meta.get("tab-metadata", {}).items():
        if tab not in groups:
            continue
        t = {}
        if "collapsed" in tm:
            t["collapsed"] = bool(tm["collapsed"])
        if tm.get("control-boolean") in names:
            t["control"] = tm["control-boolean"]
        for src, dst in (("help-link", "help_link"), ("description-html", "description_html"),
                         ("description-collapsed-html", "description_collapsed_html")):
            if tm.get(src):
                t[dst] = clean_html(tm[src]) if dst.endswith("html") else tm[src]
        tabs[tab] = t
    return out, tabs


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

    store = Store(out)
    common = {"/fonts/fonts.conf": store.put(
        b'<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        b"<fontconfig><dir>/fonts</dir><cachedir>/tmp/fontconfig</cachedir></fontconfig>\n")}
    for font in sorted(FONTS_DIR.glob("*.ttf")):
        common[f"/fonts/{font.name}"] = store.put(font.read_bytes())

    (out / "data/models").mkdir(parents=True)
    families, models, problems = [], [], []
    for fam_file in sorted((ROOT / "catalog/families").glob("*.json")):
        fam = json.loads(fam_file.read_text())
        if fam.get("status") == "disabled":
            continue
        use = fam.get("license", {}).get("public_use", "ok")
        if (args.public and use != "ok") or (args.hide_blocked and use == "blocked"):
            continue
        families.append({"id": fam["id"], "name": fam["name"], "status": fam["status"], "category": fam["category"],
                         "license": fam.get("license", {}), "authors": fam.get("authors", [])})
        editor_cfg = load_editor_toml(ROOT / fam["editor_toml"]) if fam.get("editor_toml") else {}
        lib_paths = (fam.get("engine") or {}).get("library_paths", [])
        for m in fam.get("models", []):
            if m.get("status") != "available" or not m.get("entrypoint") or m.get("browser") is False:
                continue
            key = f'{fam["id"]}/{m["id"]}'
            files, missing = collect_files(m["entrypoint"], lib_paths)
            if missing:
                problems.append(f"{key}: unresolved {missing}")
            fmap = {v: store.put(h.read_bytes()) for v, h in sorted(files.items())}
            models.append({"key": key, "fam": fam, "meta": m, "files": fmap, "entry": "/" + m["entrypoint"],
                           "editor": editor_model_meta(editor_cfg, m.get("editor_model") or Path(m["entrypoint"]).name)})

    # provisional catalog so the engine runner can read common files
    (out / "data/catalog.json").write_text(json.dumps({"common_files": common, "models": []}))
    for mdl in models:
        (out / "data/models" / (mdl["key"].replace("/", "--") + ".json")).write_text(
            json.dumps({"entry": mdl["entry"], "files": mdl["files"], "parameters": []}))
    raw = json.loads(subprocess.run(["node", str(ROOT / "tools/engine/cli.mjs"), "params", str(args.engine), str(out),
                                     *[m["key"] for m in models]], capture_output=True, text=True, check=True).stdout)

    listing = []
    for mdl in models:
        fam, m, key = mdl["fam"], mdl["meta"], mdl["key"]
        if "error" in raw[key]:
            problems.append(f"{key}: parameter export failed\n{raw[key]['error']}")
            continue
        params, groups = convert_params(raw[key])
        params, tabs = apply_metadata(params, groups, fam, m, mdl["editor"])
        groups = [g for g in groups if any(p["group"] == g for p in params)]
        summary = {
            "key": key, "family": fam["id"], "family_name": fam["name"], "id": m["id"], "name": m["name"],
            "category": fam["category"], "category_label": CATEGORY_LABELS.get(fam["category"], fam["category"]),
            "summary": fam.get("summary", ""), "tags": fam.get("tags", []), "license": fam.get("license", {}),
        }
        detail = {
            **summary,
            "authors": fam.get("authors", []), "links": fam.get("links", {}), "source": fam.get("source"),
            "notes": m.get("notes"), "part_parameter": m.get("part_parameter"),
            "description_html": clean_html(mdl["editor"].get("description-extra-html")),
            "entry": mdl["entry"], "files": mdl["files"], "fixed": m.get("fixed", {}),
            "groups": groups, "tabs": tabs, "parameters": params,
            "input_bytes": sum((out / "fs" / s).stat().st_size for s in mdl["files"].values()),
        }
        (out / "data/models" / (key.replace("/", "--") + ".json")).write_text(json.dumps(detail, separators=(",", ":")))
        listing.append(summary)

    cats = {}
    for s in listing:
        cats.setdefault(s["category"], []).append(s)
    order = list(CATEGORY_LABELS)
    libraries = [] if args.skip_libraries else build_libraries(out)
    catalog = {
        "engine": engine_version,
        "common_files": common,
        "models": listing,
        "categories": [{"id": c, "label": CATEGORY_LABELS.get(c, c), "models": cats[c]}
                       for c in sorted(cats, key=lambda c: order.index(c) if c in order else 99)],
        "families": families,
        "libraries": libraries,
    }
    (out / "data/catalog.json").write_text(json.dumps(catalog, separators=(",", ":")))
    print(f"engine {engine_version}; {len(listing)} models; {len(libraries)} libraries; "
          f"{len(list((out / 'fs').iterdir()))} source files ({store.bytes / 1e6:.1f} MB)")
    for p in problems:
        print("PROBLEM:", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
