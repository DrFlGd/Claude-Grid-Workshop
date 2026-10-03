#!/usr/bin/env python3
"""Bounding box, volume, area and triangle count for STL and 3MF meshes.

Used to check that a generator reproduces a published part (same size and
same amount of material), and to fill in STL-library manifests.

    tools/mesh_stats.py part.stl other.3mf ...      # JSON lines
"""
from __future__ import annotations

import json
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np


def _stl(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + 50 * n == len(data):
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")]), count=n, offset=84)
            return rec["v"].reshape(-1, 3, 3).astype(np.float64)
    tris, cur = [], []
    for line in data.decode(errors="replace").splitlines():
        s = line.split()
        if s and s[0] == "vertex":
            cur.append([float(x) for x in s[1:4]])
            if len(cur) == 3:
                tris.append(cur)
                cur = []
    return np.array(tris, dtype=np.float64).reshape(-1, 3, 3)


def _mat(transform: str | None) -> np.ndarray:
    m = np.eye(4)
    if transform:
        v = [float(x) for x in transform.split()]
        m[:3, :4] = np.array(v).reshape(4, 3).T
    return m


def _3mf(path: Path) -> np.ndarray:
    z = zipfile.ZipFile(path)
    models = {}
    for name in z.namelist():
        if name.lower().endswith(".model"):
            models["/" + name] = ET.fromstring(z.read(name))
    ns = lambda tag: tag.split("}")[-1]
    objects = {}
    root_name = next((k for k in models if k.lower() == "/3d/3dmodel.model"), next(iter(models)))
    for mname, root in models.items():
        for obj in root.iter():
            if ns(obj.tag) != "object":
                continue
            mesh = comps = None
            for ch in obj:
                if ns(ch.tag) == "mesh":
                    mesh = ch
                elif ns(ch.tag) == "components":
                    comps = ch
            entry = {"tris": None, "components": []}
            if mesh is not None:
                verts, tris = [], []
                for part in mesh:
                    if ns(part.tag) == "vertices":
                        verts = [(float(v.get("x")), float(v.get("y")), float(v.get("z"))) for v in part]
                    elif ns(part.tag) == "triangles":
                        tris = [(int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))) for t in part]
                if verts and tris:
                    entry["tris"] = np.array(verts)[np.array(tris)]
            if comps is not None:
                for c in comps:
                    ref = c.get("{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path") or mname
                    entry["components"].append((ref, c.get("objectid"), _mat(c.get("transform"))))
            objects[(mname, obj.get("id"))] = entry

    def resolve(key, m):
        e = objects[key]
        out = []
        if e["tris"] is not None:
            t = e["tris"]
            h = np.concatenate([t, np.ones(t.shape[:2] + (1,))], axis=2)
            out.append((h @ m.T)[..., :3])
        for ref, oid, cm in e["components"]:
            out += resolve((ref, oid), m @ cm)
        return out

    parts = []
    for item in models[root_name].iter():
        if ns(item.tag) == "item":
            parts += resolve((root_name, item.get("objectid")), _mat(item.get("transform")))
    return np.concatenate(parts) if parts else np.zeros((0, 3, 3))


def load(path: Path) -> np.ndarray:
    return _3mf(path) if path.suffix.lower() == ".3mf" else _stl(path)


def stats(path: Path) -> dict:
    t = load(path)
    if not len(t):
        return {"file": str(path), "triangles": 0}
    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    vol = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)
    area = float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum() / 2.0)
    lo, hi = t.reshape(-1, 3).min(0), t.reshape(-1, 3).max(0)
    return {
        "file": str(path),
        "triangles": int(len(t)),
        "size_mm": [round(float(x), 3) for x in hi - lo],
        "volume_mm3": round(abs(vol), 1),
        "area_mm2": round(area, 1),
    }


if __name__ == "__main__":
    for f in sys.argv[1:]:
        print(json.dumps(stats(Path(f))))
