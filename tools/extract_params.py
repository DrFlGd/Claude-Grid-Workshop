#!/usr/bin/env python3
"""Extract OpenSCAD Customizer parameters from a SCAD entrypoint.

Reads the standard Customizer annotations that every collected project uses:

    /* [Group Name] */
    // Description shown to the user
    name = 42;            // [0:1:100]        -> slider (min:step:max)
    style = "a";          // [a:Label A, b]   -> dropdown
    flag = true;                              -> checkbox
    size = [2, 3];        // [1:10]           -> vector of numbers

Only top-level assignments before the first module/function body are
parameters, matching OpenSCAD's own Customizer. `[Hidden]` groups are skipped.
The output is a JSON document that the website turns into a form; a family
manifest can override labels, grouping, visibility and validation on top of it.

Usage:
    tools/extract_params.py vendor/foo/bar.scad            # print JSON
    tools/extract_params.py --all --out catalog/params     # every catalog model
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

GROUP_RE = re.compile(r"^\s*/\*\s*\[([^\]]+)\]\s*\*/")
ASSIGN_RE = re.compile(r"^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?);\s*(?://\s*(.*))?$")
BLOCK_START_RE = re.compile(r"^\s*(module|function)\b")


def strip_inline(value: str) -> str:
    return value.strip()


def parse_literal(text: str):
    """Parse an OpenSCAD literal. Returns (ok, value)."""
    t = text.strip()
    if t in ("true", "false"):
        return True, t == "true"
    if re.fullmatch(r"-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", t):
        v = float(t)
        return True, int(v) if v.is_integer() and "." not in t and "e" not in t.lower() else v
    if len(t) >= 2 and t[0] == '"' and t[-1] == '"' and '"' not in t[1:-1].replace('\\"', ""):
        return True, t[1:-1].replace('\\"', '"')
    if t.startswith("[") and t.endswith("]"):
        inner = t[1:-1].strip()
        if not inner:
            return True, []
        parts = split_top(inner, ",")
        out = []
        for p in parts:
            ok, v = parse_literal(p)
            if not ok:
                return False, None
            out.append(v)
        return True, out
    return False, None


def split_top(s: str, sep: str):
    parts, depth, cur, quote = [], 0, "", False
    for ch in s:
        if ch == '"':
            quote = not quote
        if not quote:
            if ch in "[(":
                depth += 1
            elif ch in "])":
                depth -= 1
            elif ch == sep and depth == 0:
                parts.append(cur)
                cur = ""
                continue
        cur += ch
    parts.append(cur)
    return [p.strip() for p in parts]


def parse_hint(hint: str | None, default):
    """Interpret the trailing `// [...]` hint."""
    if not hint:
        return {}
    h = hint.strip()
    m = re.match(r"^\[(.*)\]\s*$", h)
    if not m:
        return {}
    body = m.group(1).strip()
    # numeric range: [max] / [min:max] / [min:step:max]
    nums = body.split(":")
    num_re = r"\s*-?(\d+\.?\d*|\.\d+)\s*"
    if "," not in body and 1 <= len(nums) <= 3 and re.fullmatch(num_re, nums[0]) and all(
        re.fullmatch(num_re, n) or (i == len(nums) - 1 and not n.strip()) for i, n in enumerate(nums)
    ):
        vals = [float(n) if n.strip() else None for n in nums]
        if len(vals) == 1:
            r = {"min": 0, "max": vals[0]}
        elif len(vals) == 2:
            r = {"min": vals[0], "max": vals[1]}
        else:
            r = {"min": vals[0], "step": vals[1], "max": vals[2]}
        r = {k: (int(v) if isinstance(v, float) and v.is_integer() else v) for k, v in r.items() if v is not None}
        # open-ended ranges ([1:1:]) become bounded number inputs, not sliders
        r["widget"] = "slider" if "max" in r else "number"
        return r
    # dropdown: [a, b:Label, 3:Three]
    options = []
    for item in split_top(body, ","):
        if not item:
            continue
        if ":" in item and not item.startswith('"'):
            val, label = item.split(":", 1)
        elif item.startswith('"') and '":' in item:
            idx = item.index('":')
            val, label = item[: idx + 1], item[idx + 2 :]
        else:
            val, label = item, None
        ok, parsed = parse_literal(val)
        if not ok:
            parsed = val.strip().strip('"')
        if isinstance(default, str) and not isinstance(parsed, str):
            parsed = str(parsed)
        options.append({"value": parsed, "label": (label or str(parsed)).strip()})
    return {"widget": "dropdown", "options": options} if options else {}


def value_type(v):
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        if all(isinstance(x, bool) for x in v):
            return "boolean[]"
        if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            return "number[]"
        if all(isinstance(x, str) for x in v):
            return "string[]"
        return "list"
    return "unknown"


def extract(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    group = "Parameters"
    params, comments, skipped = [], [], []
    in_block_comment = False
    depth = 0
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        g = GROUP_RE.match(line)
        if g and depth == 0:
            group = g.group(1).strip()
            comments = []
            continue
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block_comment = True
            comments = []
            continue
        if depth == 0 and BLOCK_START_RE.match(stripped):
            break  # Customizer stops at the first module/function definition
        if depth == 0 and stripped.startswith("//"):
            comments.append(stripped.lstrip("/").strip())
            continue
        if not stripped:
            comments = []
            continue
        if depth == 0:
            m = ASSIGN_RE.match(stripped)
            if m and not stripped.startswith(("include", "use")):
                name, expr, hint = m.group(1), m.group(2), m.group(3)
                ok, default = parse_literal(expr)
                if group.lower() == "hidden" or name.startswith("$"):
                    comments = []
                    continue
                if not ok:
                    skipped.append({"name": name, "group": group, "expression": expr.strip()})
                    comments = []
                    continue
                p = {
                    "name": name,
                    "group": group,
                    "type": value_type(default),
                    "default": default,
                    "description": " ".join(c for c in comments if c) or None,
                }
                p.update(parse_hint(hint, default))
                if p.get("widget") == "dropdown" and default not in [o["value"] for o in p["options"]]:
                    # upstream default outside its own option list: keep it selectable
                    p["options"].insert(0, {"value": default, "label": str(default)})
                if p["type"] == "boolean":
                    p["widget"] = "checkbox"
                elif "widget" not in p:
                    p["widget"] = {"number": "number", "string": "text"}.get(p["type"], "vector")
                params.append(p)
                comments = []
                continue
        # track brace depth for non-parameter statements
        depth += line.count("{") - line.count("}")
        depth = max(depth, 0)
        comments = []
    groups = []
    for p in params:
        if p["group"] not in groups:
            groups.append(p["group"])
    return {
        "source": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
        "groups": groups,
        "parameters": params,
        "computed_skipped": skipped,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--all", action="store_true", help="extract every model listed in catalog/families")
    ap.add_argument("--out", type=Path, help="directory for <model-id>.json outputs")
    args = ap.parse_args()
    if args.all:
        out = args.out or ROOT / "catalog/params"
        out.mkdir(parents=True, exist_ok=True)
        summary = []
        for fam_file in sorted((ROOT / "catalog/families").glob("*.json")):
            fam = json.loads(fam_file.read_text())
            for model in fam["models"]:
                if not model.get("entrypoint"):
                    continue
                data = extract(ROOT / model["entrypoint"])
                data["model"] = f'{fam["id"]}/{model["id"]}'
                (out / f'{fam["id"]}--{model["id"]}.json').write_text(json.dumps(data, indent=2) + "\n")
                summary.append((data["model"], len(data["parameters"]), len(data["groups"]), len(data["computed_skipped"])))
        for s in summary:
            print(f"{s[0]:45s} params={s[1]:4d} groups={s[2]:3d} computed={s[3]}")
        return 0
    for f in args.files:
        print(json.dumps(extract(f.resolve()), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
