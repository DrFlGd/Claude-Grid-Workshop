"""Load generator families and their extracted parameters into one catalog.

Everything the site can render comes from catalog/families/*.json; only those
entrypoints are ever passed to OpenSCAD. Parameter values from the browser are
validated against catalog/params/*.json before a render is queued.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CATEGORY_LABELS = {
    "gridfinity": "Gridfinity",
    "carrying": "Boxes & Baskets",
    "labels": "Labels",
    "wall": "Wall Storage",
    "other": "Other",
}

MAX_STRING = 200
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ParamError(ValueError):
    pass


@dataclass
class Model:
    family: dict
    meta: dict
    params: list[dict]
    groups: list[str]
    source_digest: str
    fixed: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f'{self.family["id"]}/{self.meta["id"]}'

    @property
    def entrypoint(self) -> Path:
        return ROOT / self.meta["entrypoint"]

    @property
    def library_paths(self) -> list[Path]:
        return [ROOT / p for p in (self.family.get("engine") or {}).get("library_paths", [])]

    def public_summary(self) -> dict:
        f = self.family
        return {
            "key": self.key,
            "family": f["id"],
            "family_name": f["name"],
            "id": self.meta["id"],
            "name": self.meta["name"],
            "category": f["category"],
            "category_label": CATEGORY_LABELS.get(f["category"], f["category"]),
            "summary": f.get("summary", ""),
            "tags": f.get("tags", []),
            "license": f.get("license", {}),
            "parameter_count": len(self.params),
        }

    def detail(self) -> dict:
        f = self.family
        return {
            **self.public_summary(),
            "authors": f.get("authors", []),
            "links": f.get("links", {}),
            "source": f.get("source"),
            "notes": self.meta.get("notes"),
            "part_parameter": self.meta.get("part_parameter"),
            "groups": self.groups,
            "parameters": self.params,
        }

    # -- validation -------------------------------------------------------
    def validate(self, values: dict) -> dict:
        """Return the full, validated parameter set (defaults filled in)."""
        if not isinstance(values, dict):
            raise ParamError("parameters must be an object")
        by_name = {p["name"]: p for p in self.params}
        unknown = [k for k in values if k not in by_name]
        if unknown:
            raise ParamError(f"unknown parameter(s): {', '.join(sorted(unknown)[:5])}")
        out = {}
        for p in self.params:
            v = values.get(p["name"], p["default"])
            out[p["name"]] = check_value(p, v)
        out.update(self.fixed)
        return out


def _num(p, v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ParamError(f'{p["name"]}: expected a number')
    if abs(v) > 1e6:
        raise ParamError(f'{p["name"]}: value out of range')
    if p.get("widget") == "slider":
        lo, hi = p.get("min"), p.get("max")
        if lo is not None and v < lo - 1e-9 or hi is not None and v > hi + 1e-9:
            raise ParamError(f'{p["name"]}: must be between {lo} and {hi}')
    elif p.get("min") is not None and v < p["min"] - 1e-9:
        raise ParamError(f'{p["name"]}: must be at least {p["min"]}')
    return v


def check_value(p: dict, v):
    t = p["type"]
    if p.get("widget") == "dropdown" and not isinstance(p["default"], list):
        for o in p["options"]:
            ov = o["value"]
            if isinstance(ov, bool) or isinstance(v, bool):
                if isinstance(ov, bool) and isinstance(v, bool) and ov == v:
                    return ov
            elif type(ov) is str or type(v) is str:
                if type(ov) is str and type(v) is str and ov == v:
                    return ov
            elif ov == v:
                return ov
        raise ParamError(f'{p["name"]}: not one of the allowed options')
    if t == "boolean":
        if not isinstance(v, bool):
            raise ParamError(f'{p["name"]}: expected true/false')
        return v
    if t == "number":
        return _num(p, v)
    if t == "string":
        if not isinstance(v, str) or len(v) > MAX_STRING or any(ord(c) < 32 for c in v):
            raise ParamError(f'{p["name"]}: invalid text')
        return v
    if t in ("number[]", "string[]", "boolean[]", "list"):
        d = p["default"]
        if not isinstance(v, list) or len(v) != len(d):
            raise ParamError(f'{p["name"]}: expected a list of {len(d)} values')
        res = []
        for item, dflt in zip(v, d):
            sub = {"name": p["name"], "type": {bool: "boolean", str: "string"}.get(type(dflt), "number"),
                   "default": dflt, "widget": "number" if p.get("widget") != "slider" else "slider",
                   "min": p.get("min"), "max": p.get("max")}
            if isinstance(dflt, list):
                if dflt != item:
                    raise ParamError(f'{p["name"]}: nested lists cannot be edited')
                res.append(item)
            else:
                res.append(check_value(sub, item))
        return res
    raise ParamError(f'{p["name"]}: unsupported parameter type')


def scad_literal(v) -> str:
    """Serialise a validated value as an OpenSCAD literal for -D."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(int(v)) if float(v).is_integer() and abs(v) < 1e15 else repr(float(v))
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, list):
        return "[" + ",".join(scad_literal(x) for x in v) + "]"
    raise TypeError(type(v))


def _digest_paths(paths: list[Path]) -> str:
    h = hashlib.sha256()
    for base in paths:
        files = [base] if base.is_file() else sorted(p for p in base.rglob("*") if p.is_file())
        for f in files:
            h.update(str(f.relative_to(ROOT)).encode())
            h.update(f.read_bytes())
    return h.hexdigest()


class Catalog:
    def __init__(self, root: Path = ROOT, public_mode: bool = False):
        self.root = root
        self.public_mode = public_mode
        self.models: dict[str, Model] = {}
        self.families: list[dict] = []
        self.load()

    def load(self):
        digest_cache: dict[tuple, str] = {}
        for fam_file in sorted((self.root / "catalog/families").glob("*.json")):
            fam = json.loads(fam_file.read_text())
            if fam.get("status") == "disabled":
                continue
            use = fam.get("license", {}).get("public_use", "ok")
            if self.public_mode and use != "ok":
                continue
            self.families.append(fam)
            for m in fam.get("models", []):
                if m.get("status") != "available" or not m.get("entrypoint"):
                    continue
                pfile = self.root / "catalog/params" / f'{fam["id"]}--{m["id"]}.json'
                if not pfile.exists():
                    continue
                pdata = json.loads(pfile.read_text())
                params, fixed = self._apply_overrides(pdata["parameters"], m)
                vendor = (fam.get("source") or {}).get("vendor_path")
                parts = [self.root / m["entrypoint"]]
                if vendor:
                    parts.append(self.root / vendor)
                parts += [self.root / p for p in (fam.get("engine") or {}).get("library_paths", [])]
                k = tuple(sorted(str(p) for p in parts))
                if k not in digest_cache:
                    digest_cache[k] = _digest_paths(parts)
                groups = [g for g in pdata["groups"] if any(p["group"] == g for p in params)]
                model = Model(fam, m, params, groups, digest_cache[k], fixed)
                self.models[model.key] = model

    @staticmethod
    def _apply_overrides(params: list[dict], meta: dict):
        fixed = dict(meta.get("fixed", {}))
        hidden = set(meta.get("hidden", [])) | set(fixed)
        defaults = meta.get("defaults", {})
        ui = meta.get("ui", {})
        out = []
        for p in params:
            if p["name"] in hidden:
                continue
            p = dict(p)
            if p["name"] in defaults:
                p["default"] = defaults[p["name"]]
            p.update(ui.get(p["name"], {}))
            out.append(p)
        for k in fixed:
            if not NAME_RE.match(k):
                raise ValueError(f"bad fixed parameter name {k}")
        return out, fixed

    def listing(self) -> dict:
        cats = {}
        for m in self.models.values():
            cats.setdefault(m.family["category"], []).append(m.public_summary())
        order = list(CATEGORY_LABELS)
        return {
            "categories": [
                {"id": c, "label": CATEGORY_LABELS.get(c, c), "models": cats[c]}
                for c in sorted(cats, key=lambda c: order.index(c) if c in order else 99)
            ],
            "families": [
                {"id": f["id"], "name": f["name"], "status": f["status"], "category": f["category"],
                 "license": f.get("license", {}), "authors": f.get("authors", [])}
                for f in self.families
            ],
        }
