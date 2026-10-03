#!/usr/bin/env python3
"""Check that a generator reproduces published parts.

Reads sources/parity/*.json. Each check names a catalog model, one or more
candidate parameter sets, and the measured size/volume of a reference file.
Every candidate is rendered with OpenSCAD; the closest one is reported and
the check passes when size and volume are within the spec's tolerance.

    OPENSCAD=openscad-nightly python3 tools/parity.py [--output report.json]
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from app.catalog import Catalog, scad_literal  # noqa: E402
from mesh_stats import stats  # noqa: E402


def render(model, params, exe, tmp, tag):
    out = Path(tmp) / f"{tag}.stl"
    cmd = [exe, "--backend=manifold", "--export-format", "binstl", "-o", str(out)]
    for k, v in model.validate(params).items():
        cmd += ["-D", f"{k}={scad_literal(v)}"]
    cmd.append(str(model.entrypoint))
    env = dict(os.environ, OPENSCADPATH=os.pathsep.join(map(str, model.library_paths)))
    r = subprocess.run(cmd, cwd=model.entrypoint.parent, env=env, capture_output=True, text=True, timeout=600)
    if r.returncode or not out.exists():
        return {"error": (r.stdout + r.stderr)[-500:]}
    return stats(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path)
    ap.add_argument("--openscad", default=os.environ.get("OPENSCAD", "openscad"))
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()
    catalog = Catalog()
    report, failed = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for spec_file in sorted((ROOT / "sources/parity").glob("*.json")):
            spec = json.loads(spec_file.read_text())
            tol = spec["tolerance"]
            for check in spec["checks"]:
                model = catalog.models[check["model"]]
                ref = check["reference"]
                jobs = [(i, c) for i, c in enumerate(check["candidates"])]
                with concurrent.futures.ThreadPoolExecutor(args.jobs) as ex:
                    results = list(ex.map(lambda ic: (ic[1], render(model, ic[1], args.openscad, tmp, f'{check["id"]}-{ic[0]}')), jobs))
                scored = []
                for params, s in results:
                    if "error" in s:
                        continue
                    dsize = max(abs(a - b) for a, b in zip(sorted(s["size_mm"]), sorted(ref["size_mm"])))  # orientation-free
                    dvol = abs(s["volume_mm3"] - ref["volume_mm3"]) / ref["volume_mm3"] * 100
                    scored.append((dvol + dsize * 10, dsize, dvol, params, s))
                if not scored:
                    report.append({"id": check["id"], "status": "error", "errors": [s for _, s in results]})
                    failed += 1
                    continue
                _, dsize, dvol, params, s = min(scored, key=lambda x: x[0])
                ok = dsize <= tol["size_mm"] and dvol <= tol["volume_pct"]
                failed += not ok
                report.append({"id": check["id"], "status": "match" if ok else "differs", "best_params": params,
                               "size_diff_mm": round(dsize, 3), "volume_diff_pct": round(dvol, 2),
                               "generator": {k: s[k] for k in ("size_mm", "volume_mm3", "triangles")},
                               "reference": {k: ref[k] for k in ("size_mm", "volume_mm3", "file")}})
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(text + "\n")
    lines = [f'{r["status"]:8s} {r["id"]}: Δsize {r.get("size_diff_mm")} mm, Δvol {r.get("volume_diff_pct")}% '
             f'{json.dumps(r.get("best_params"))} gen={r.get("generator", {}).get("size_mm")}/{r.get("generator", {}).get("volume_mm3")} '
             f'ref={r.get("reference", {}).get("size_mm")}/{r.get("reference", {}).get("volume_mm3")}' for r in report]
    print("\n".join(lines))
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=Parity summary::" + "%0A".join(lines))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
