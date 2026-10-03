#!/usr/bin/env python3
"""Import a folder of ready-made parts into an STL library.

Files are grouped into items by name (opengrid-wall-mount.3mf, .step and
.shapr become one item with three downloads), measured, hashed and written to
catalog/libraries/<id>.json. Copies files into libraries/<id>/ unless they're
already there.

    tools/import_library.py SRC_DIR --id opengrid-official --name "openGrid" \
        --license CC-BY-4.0 --exclude "openGrid/*" --exclude "openGrid Lite/*"

Re-running keeps hand-edited fields (name, category, tags, description, generator) for
items that still exist.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from mesh_stats import stats  # noqa: E402

FORMATS = {".stl": "stl", ".3mf": "3mf", ".step": "step", ".stp": "step", ".shapr": "shapr", ".obj": "obj",
           ".f3d": "f3d", ".pdf": "pdf"}
PREVIEWABLE = ("3mf", "stl")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def title(stem: str) -> str:
    s = re.sub(r"^opengrid-", "", stem)
    s = s.replace("-", " ").replace("_", " ")
    s = re.sub(r"\bv(\d)(\d)\b", r"v\1.\2", s)
    return s[:1].upper() + s[1:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--summary", default="")
    ap.add_argument("--system", default="")
    ap.add_argument("--license", default="NOASSERTION")
    ap.add_argument("--public-use", default="review", choices=["ok", "review", "blocked"])
    ap.add_argument("--author", action="append", default=[])
    ap.add_argument("--source-url", default="")
    ap.add_argument("--exclude", action="append", default=[], help="glob relative to SRC (repeatable)")
    ap.add_argument("--kit", action="append", default=[],
                    help="folder whose files form ONE item (modelling kits), repeatable")
    args = ap.parse_args()

    dest = ROOT / "libraries" / args.id
    manifest_path = ROOT / "catalog/libraries" / f"{args.id}.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    old_items = {i["id"]: i for i in old.get("items", [])}

    groups: dict[str, dict] = {}
    for f in sorted(p for p in args.src.rglob("*") if p.is_file()):
        rel = f.relative_to(args.src).as_posix()
        fmt = FORMATS.get(f.suffix.lower())
        if not fmt or any(fnmatch.fnmatch(rel, pat) for pat in args.exclude):
            continue
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        kit = folder in args.kit
        key = slug(folder) if kit else slug(f"{folder}-{f.stem}") if folder else slug(f.stem)
        g = groups.setdefault(key, {"folder": folder, "stem": folder if kit else f.stem, "kit": kit, "files": []})
        g["files"].append((f, rel, fmt))

    items = []
    for key, g in groups.items():
        files = []
        preview = None
        for f, rel, fmt in sorted(g["files"], key=lambda x: (x[2] not in PREVIEWABLE, x[1])):
            target = dest / slug(g["folder"] or "misc") / f.name
            target.parent.mkdir(parents=True, exist_ok=True)
            if f.resolve() != target.resolve():
                shutil.copy2(f, target)
            entry = {"path": target.relative_to(dest).as_posix(), "format": fmt, "bytes": target.stat().st_size,
                     "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
            if g["kit"]:
                entry["label"] = title(f.stem)
            if fmt in PREVIEWABLE and preview is None:
                try:
                    s = stats(target)
                    entry["size_mm"], entry["triangles"] = s["size_mm"], s["triangles"]
                    preview = entry["path"]
                except Exception as e:  # unreadable mesh: still downloadable
                    print(f"warning: could not measure {rel}: {e}", file=sys.stderr)
            files.append(entry)
        prev = old_items.get(key, {})
        item = {
            "id": key,
            "name": prev.get("name") or (f"{g['folder']} (kit)" if g["kit"] else title(g["stem"])),
            "category": prev.get("category") or g["folder"] or "Other",
            "kind": "modelling-kit" if g["kit"] else ("printable" if preview else "modelling"),
            "tags": prev.get("tags", []),
            "files": files,
        }
        for k in ("description", "generator"):
            if prev.get(k):
                item[k] = prev[k]
        if preview:
            item["preview"] = preview
            item["dimensions"] = next(x["size_mm"] for x in files if x["path"] == preview)
        items.append(item)

    manifest = {
        "$schema": "../../schema/stl-library.schema.json",
        "id": args.id,
        "name": old.get("name") or args.name,
        "summary": old.get("summary") or args.summary,
        "system": old.get("system") or args.system,
        "authors": old.get("authors") or [{"name": a} for a in args.author],
        "license": old.get("license") if old.get("license", {}).get("spdx", "NOASSERTION") != "NOASSERTION"
        else {"spdx": args.license, "public_use": args.public_use},
        "source_url": old.get("source_url") or args.source_url,
        "status": "available",
        "storage": {"kind": "repo", "base": f"libraries/{args.id}/"},
        **{k: old[k] for k in ("excluded", "notes") if k in old},
        "items": sorted(items, key=lambda i: (i["category"], i["name"])),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(f["bytes"] for i in items for f in i["files"])
    print(f"{len(items)} items, {sum(len(i['files']) for i in items)} files, {total / 1e6:.1f} MB -> {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
