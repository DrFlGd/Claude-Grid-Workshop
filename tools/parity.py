#!/usr/bin/env python3
"""Check that generators reproduce published parts, using the browser engine.

Reads sources/parity/*.json. Each check names a model, candidate settings and
the measured size/volume of a reference file. Every candidate is rendered by
the built site's OpenSCAD WebAssembly engine; the closest one is reported and
passes when size and volume are within the spec's tolerance.

    python3 tools/parity.py --site _site [--output parity.json]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from mesh_stats import stats  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", type=Path, default=ROOT / "_site")
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    specs = [json.loads(f.read_text()) for f in sorted((ROOT / "sources/parity").glob("*.json"))]
    jobs = []
    for spec in specs:
        for check in spec["checks"]:
            for i, params in enumerate(check["candidates"]):
                jobs.append({"id": f'{check["id"]}--{i}', "key": check["model"], "params": params})
    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = Path(tmp) / "jobs.json"
        jobs_file.write_text(json.dumps(jobs))
        stl_dir = Path(tmp) / "stl"
        subprocess.run(["node", str(ROOT / "tools/engine/cli.mjs"), "bench", str(args.site), "--params", str(jobs_file),
                        "--stl-dir", str(stl_dir)], check=False)
        report, failed = [], 0
        for spec in specs:
            tol = spec["tolerance"]
            for check in spec["checks"]:
                ref, scored = check["reference"], []
                for i, params in enumerate(check["candidates"]):
                    f = stl_dir / f'{check["id"]}--{i}.stl'
                    if not f.exists():
                        continue
                    s = stats(f)
                    dsize = max(abs(a - b) for a, b in zip(sorted(s["size_mm"]), sorted(ref["size_mm"])))
                    dvol = abs(s["volume_mm3"] - ref["volume_mm3"]) / ref["volume_mm3"] * 100
                    scored.append((dvol + dsize * 10, dsize, dvol, params, s))
                if not scored:
                    report.append({"id": check["id"], "status": "error"})
                    failed += 1
                    continue
                _, dsize, dvol, params, s = min(scored, key=lambda x: x[0])
                ok = dsize <= tol["size_mm"] and dvol <= tol["volume_pct"]
                status = "match" if ok else "differs"
                failed += status != check.get("expect", "match")
                report.append({"id": check["id"], "status": status + (" (expected)" if check.get("expect") == status != "match" else ""), "best_params": params,
                               "size_diff_mm": round(dsize, 3), "volume_diff_pct": round(dvol, 2),
                               "generator": {k: s[k] for k in ("size_mm", "volume_mm3", "triangles")},
                               "reference": {k: ref[k] for k in ("size_mm", "volume_mm3", "file")}})
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    lines = [f'{r["status"]:8s} {r["id"]}: size diff {r.get("size_diff_mm")} mm, volume diff {r.get("volume_diff_pct")}% '
             f'{json.dumps(r.get("best_params"))}' for r in report]
    print("\n".join(lines))
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=Parity summary::" + "%0A".join(lines))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
