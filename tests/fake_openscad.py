#!/usr/bin/env python3
"""Stand-in for OpenSCAD in tests: writes an ASCII STL box sized from a few -D values."""
import sys, time
args = sys.argv[1:]
if "--version" in args:
    print("OpenSCAD version 0.0.0-fake"); sys.exit(0)
if "--help" in args:
    print("--backend arg  manifold | cgal\n--export-format arg  binstl"); sys.exit(0)
out = args[args.index("-o") + 1]
defs = dict(a.split("=", 1) for a in [args[i + 1] for i, x in enumerate(args) if x == "-D"])
if defs.get("FAIL") == "true" or "fail" in defs.get("label_text", ""):
    print("ERROR: fake failure"); sys.exit(1)
time.sleep(float(__import__("os").environ.get("FAKE_DELAY", "0.2")))
w = 42.0; d = 42.0; h = 21.0
v = [(0,0,0),(w,0,0),(w,d,0),(0,d,0),(0,0,h),(w,0,h),(w,d,h),(0,d,h)]
tris = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
with open(out, "w") as f:
    f.write("solid fake\n")
    for t in tris:
        f.write(" facet normal 0 0 0\n  outer loop\n")
        for i in t: f.write("   vertex %f %f %f\n" % v[i])
        f.write("  endloop\n endfacet\n")
    f.write("endsolid fake\n")
print("ECHO: fake render", " ".join(f"{k}={v}" for k, v in defs.items())[:500])
