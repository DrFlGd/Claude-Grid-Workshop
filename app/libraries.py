"""Ready-made part libraries (catalog/libraries/*.json + files under libraries/).

Only files listed in a manifest can be downloaded. 3MF previews are
converted to binary STL once and cached, so the browser viewer needs only
its STL loader.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

MEDIA = {"stl": "model/stl", "3mf": "model/3mf", "step": "model/step", "shapr": "application/octet-stream",
         "pdf": "application/pdf", "obj": "model/obj"}


class Libraries:
    def __init__(self, root: Path = ROOT, public_mode: bool = False, cache_dir: Path | None = None):
        self.root = root
        self.cache_dir = cache_dir or root / "data/cache"
        self.libs: dict[str, dict] = {}
        for f in sorted((root / "catalog/libraries").glob("*.json")):
            if f.name.startswith("_"):
                continue
            lib = json.loads(f.read_text())
            if lib.get("status", "available") != "available":
                continue
            if public_mode and lib.get("license", {}).get("public_use") != "ok":
                continue
            base = root / lib.get("storage", {}).get("base", f"libraries/{lib['id']}/")
            lib["_base"] = base
            lib["_files"] = {fe["path"]: fe for it in lib["items"] for fe in it["files"]}
            lib["_items"] = {it["id"]: it for it in lib["items"]}
            self.libs[lib["id"]] = lib

    @staticmethod
    def _public(lib: dict, with_items: bool) -> dict:
        out = {k: v for k, v in lib.items() if not k.startswith(("_", "$"))}
        out["item_count"] = len(lib["items"])
        out["categories"] = sorted({i["category"] for i in lib["items"]})
        if not with_items:
            out.pop("items", None)
        else:
            for it in out["items"]:
                it["files"] = [{k: v for k, v in fe.items() if k != "sha256"} | {
                    "url": f'/api/libraries/{lib["id"]}/files/{fe["path"]}'} for fe in it["files"]]
                if it.get("preview"):
                    it["preview_url"] = f'/api/libraries/{lib["id"]}/preview/{it["id"]}.stl'
        return out

    def listing(self) -> list[dict]:
        return [self._public(l, False) for l in self.libs.values()]

    def detail(self, lib_id: str) -> dict | None:
        lib = self.libs.get(lib_id)
        if not lib:
            return None
        copy = json.loads(json.dumps({k: v for k, v in lib.items() if not k.startswith("_")}))
        return self._public(copy, True)

    def file(self, lib_id: str, path: str) -> tuple[Path, dict] | None:
        lib = self.libs.get(lib_id)
        if not lib or path not in lib["_files"]:
            return None
        p = (lib["_base"] / path).resolve()
        if not p.is_file() or lib["_base"].resolve() not in p.parents:
            return None
        return p, lib["_files"][path]

    def preview(self, lib_id: str, item_id: str) -> Path | None:
        lib = self.libs.get(lib_id)
        item = lib and lib["_items"].get(item_id)
        if not item or not item.get("preview"):
            return None
        found = self.file(lib_id, item["preview"])
        if not found:
            return None
        src, meta = found
        if meta["format"] == "stl":
            return src
        out = self.cache_dir / f'lib-{meta.get("sha256", item_id)[:40]}.stl'
        if not out.exists():
            from mesh_stats import load  # numpy-based 3MF reader

            tris = load(src).astype("<f4")
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp")
            with tmp.open("wb") as fh:
                fh.write(b"grid-workshop preview".ljust(80, b" "))
                fh.write(struct.pack("<I", len(tris)))
                import numpy as np

                rec = np.zeros(len(tris), dtype=np.dtype([("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")]))
                rec["v"] = tris.reshape(-1, 9)
                fh.write(rec.tobytes())
            tmp.replace(out)
        return out
