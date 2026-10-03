#!/usr/bin/env python3
"""Verify vendored checksums and render every catalog entrypoint with OpenSCAD.

Driven by catalog/families/*.json, so a new generator is validated as soon as
its manifest is added. Default mode compiles to CSG (fast: catches parse
errors and missing includes). --stl also exports a mesh with default
parameters. Neither proves printability.

    python3 tools/validate_sources.py                     # hashes + CSG
    python3 tools/validate_sources.py --stl --output sources/validation.json
    python3 tools/validate_sources.py --hashes-only
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check_hashes():
    bad, count = [], 0
    for line in (ROOT / "sources/SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        count += 1
        p = ROOT / name
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            bad.append(name)
    return count, bad


def catalog_entries():
    for fam_file in sorted((ROOT / "catalog/families").glob("*.json")):
        fam = json.loads(fam_file.read_text())
        for m in fam["models"]:
            if m.get("entrypoint") and m.get("status") == "available":
                engine = {**(fam.get("engine") or {}), **m.get("engine_override", {})}
                lib_paths = (fam.get("engine") or {}).get("library_paths", [])
                yield dict(id=f'{fam["id"]}/{m["id"]}', entrypoint=m["entrypoint"],
                           fixed=m.get("fixed", {}), defaults=m.get("defaults", {}),
                           library_paths=lib_paths, min_version=engine.get("min_version"))


def scad_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, list):
        return "[" + ",".join(scad_value(x) for x in v) + "]"
    return repr(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--stl", action="store_true", help="export STL instead of CSG")
    ap.add_argument("--hashes-only", action="store_true")
    ap.add_argument("--openscad", default=os.environ.get("OPENSCAD", "openscad"))
    ap.add_argument("--jobs", type=int, default=2)
    args = ap.parse_args()

    count, bad = check_hashes()
    report = dict(checksum_files=count, checksum_mismatches=bad)
    if args.hashes_only:
        print(json.dumps(report, indent=2))
        return 1 if bad else 0
    if not shutil.which(args.openscad) and not Path(args.openscad).exists():
        raise SystemExit(f"OpenSCAD not found ({args.openscad}); use --hashes-only or set OPENSCAD")

    version = subprocess.run([args.openscad, "--version"], capture_output=True, text=True)
    backend = []
    help_text = subprocess.run([args.openscad, "--help"], capture_output=True, text=True)
    if "--backend" in help_text.stdout + help_text.stderr:
        backend = ["--backend=manifold"]
    ext = "stl" if args.stl else "csg"

    with tempfile.TemporaryDirectory() as tmp:
        def run(e):
            out = Path(tmp) / (e["id"].replace("/", "--") + "." + ext)
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen",
                       OPENSCADPATH=os.pathsep.join(str(ROOT / p) for p in e["library_paths"]))
            cmd = [args.openscad, *backend, "-o", str(out)]
            for k, v in {**e["defaults"], **e["fixed"]}.items():
                cmd += ["-D", f"{k}={scad_value(v)}"]
            cmd.append(str(ROOT / e["entrypoint"]))
            try:
                r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=args.timeout, cwd=ROOT)
                diag = (r.stderr + r.stdout).strip()
                errors = [l for l in diag.splitlines() if l.startswith("ERROR")]
                warnings = [l for l in diag.splitlines() if l.startswith("WARNING")]
                ok = r.returncode == 0 and out.is_file() and out.stat().st_size > 0 and not errors
                res = dict(id=e["id"], entrypoint=e["entrypoint"], status="pass" if ok else "fail",
                           warnings=len(warnings), returncode=r.returncode, diagnostics=diag[-4000:])
                if ok and args.stl:
                    res["bytes"] = out.stat().st_size
                return res
            except subprocess.TimeoutExpired:
                return dict(id=e["id"], entrypoint=e["entrypoint"], status="timeout",
                            diagnostics=f"Exceeded {args.timeout}s")

        entries = list(catalog_entries())
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
            results = list(ex.map(run, entries))

    report.update(engine=(version.stderr + version.stdout).strip(), mode=ext, results=results)
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(text)
    for r in results:
        print(f'{r["status"]:8s} {r["id"]}' + (f'  ({r.get("warnings")} warnings)' if r.get("warnings") else ""))
    print(f"checksums: {count} files, {len(bad)} mismatches")
    if os.environ.get("GITHUB_ACTIONS"):
        # one annotation carrying the whole table, readable through the checks API
        lines = [report["engine"]] + [
            f'{r["status"]} {r["id"]} {r.get("bytes", "")} w={r.get("warnings", "")}' for r in results]
        print("::notice title=Render summary::" + "%0A".join(lines))
        for r in results:
            if r["status"] != "pass":
                print(f'::error title={r["id"]}::' + r["diagnostics"][-800:].replace("\n", "%0A"))
    return 1 if bad or any(r["status"] != "pass" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
