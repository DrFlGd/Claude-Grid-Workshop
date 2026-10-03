#!/usr/bin/env python3
"""Verify every vendored file against sources/SHA256SUMS.

Rendering checks run on the browser engine instead:
`node tools/engine/cli.mjs bench _site` (see .github/workflows/site.yml).
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
bad, count = [], 0
for line in (ROOT / "sources/SHA256SUMS").read_text().splitlines():
    digest, name = line.split("  ", 1)
    count += 1
    p = ROOT / name
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
        bad.append(name)
print(f"{count} vendored files checked, {len(bad)} mismatched")
for b in bad:
    print("MISMATCH", b)
sys.exit(1 if bad else 0)
