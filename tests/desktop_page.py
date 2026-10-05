#!/usr/bin/env python3
"""Phase 2 acceptance test: the desktop app's page against its real backend
(`workshop-cli serve`, the same command table as the Tauri app), in Chromium.

    python3 tests/desktop_page.py --cli desktop/target/release/workshop-cli --ui build/desktop/ui \\
        --app-site build/desktop/site --starter build/desktop/starter --engine build/native/squashfs-root \\
        --home /tmp/home --out shots [--github-api http://127.0.0.1:8795]

Checks: the starter library; adding three public GitHub projects by URL (one
pinned to an old commit, one a library); a local project that includes the
library; search; a render from library files; an upstream change detected and
summarised, accepted, with edits surviving; a project-wide license with one item
keeping its own; a condensed group showing the icon chosen for it; and the
library opening the same after being moved (library-summary). Writes
<out>/library-summary.json and <out>/library.zip for the cross-platform check.
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--cli", required=True)
ap.add_argument("--ui", required=True)
ap.add_argument("--app-site", required=True)
ap.add_argument("--starter", required=True)
ap.add_argument("--engine", required=True)
ap.add_argument("--home", required=True)
ap.add_argument("--out", default="shots")
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--github-api", help="a stand-in for GitHub's API (tests/github_mock.py)")
a = ap.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
home = Path(a.home).resolve()
shutil.rmtree(home, ignore_errors=True)
library = home / "library"
B = f"http://127.0.0.1:{a.port}/"
SHIM = Path(__file__).with_name("tauri_shim.js")
OLD = "af95c658fdd11e56bbc826b68ac13022c8bc79e4"  # vector76/gridfinity_openscad, Oct 2022 (newer commits exist)
REPOS = [
    ("vector76-gridfinity", f"https://github.com/vector76/gridfinity_openscad/commit/{OLD}", False),
    ("gears", "https://github.com/chrisspen/gears", False),
    ("bosl2", "https://github.com/BelfrySCAD/BOSL2", True),
]
DONE = "()=>{const s=document.querySelector('#status');return s&&(s.classList.contains('ok')||s.classList.contains('error'))}"
results, errors = [], []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{' :: ' + str(detail) if detail != '' else ''}", flush=True)


def start_server():
    env = dict(os.environ)
    if a.github_api:
        env["WORKSHOP_GITHUB_API"] = a.github_api
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"):
            env.pop(k, None)
    log = open(out / "serve.log", "w")
    p = subprocess.Popen([a.cli, "serve", "--ui", a.ui, "--app-site", a.app_site, "--starter", a.starter, "--engine", a.engine,
                          "--home", str(home), "--library", str(library), "--port", str(a.port)], stdout=log, stderr=log, env=env)
    for _ in range(100):
        try:
            urllib.request.urlopen(B, timeout=1)
            return p
        except Exception:
            time.sleep(0.2)
    raise SystemExit("the server didn't start; see serve.log")


async def index_items(pg, project):
    """Items of one project as the page's index has them (name, license)."""
    return await pg.evaluate("""(p) => window.__workshop.index.items.filter((i) => i.projectId === p)
        .map((i) => ({ id: i.id, name: i.name, license: i.license?.spdx, kind: i.kind }))""", project)


async def main():
    server = start_server()
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            ctx = await b.new_context(viewport={"width": 1400, "height": 900})
            await ctx.add_init_script(path=str(SHIM))
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "net::ERR_" not in m.text else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await pg.goto(B)
            await pg.wait_for_selector(".home .tile", timeout=120000)
            await pg.wait_for_function("() => !!window.__workshop", timeout=10000)

            # 1. the starter library
            n = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.kind === 'generator').length")
            parts = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.kind === 'part').length")
            projects = await pg.locator(".nav-projects .nav-link").count()
            check("starter library installed", n == 58 and parts == 44 and projects == 19, f"{n} generators, {parts} parts, {projects} projects")
            await pg.screenshot(path=str(out / "p2-00-home.png"))

            # 2. three public projects by URL
            ids = {}
            for short, url, lib in REPOS:
                await pg.click("#add-project")
                await pg.fill("#add-url", url)
                if lib:
                    await pg.check("#add-library")
                await pg.click("#add-go")
                await pg.wait_for_function("() => location.hash.includes('/source/')", timeout=600000)
                await pg.wait_for_selector(".source-panel")
                src = (await pg.evaluate("location.hash")).split("/source/")[1]
                ids[short] = src
                items = await index_items(pg, src)
                ok = (len(items) == 0) if lib else (len([i for i in items if i["kind"] == "generator"]) > 0)
                check(f"added {url.split('github.com/')[1]}", ok, f"{src}: {len(items)} items")
                await pg.goto(B + "#/")
            await pg.screenshot(path=str(out / "p2-01-added.png"))

            # 3. a project of your own that includes the library (<BOSL2/...>)
            (library / "local/bevel").mkdir(parents=True, exist_ok=True)
            (library / "local/bevel/bevel_gear.scad").write_text(
                "include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n\n// Number of teeth\nteeth = 20; // [8:60]\n"
                "// Tooth size (module)\nmod = 2; // [0.5:0.5:5]\n\nbevel_gear(mod=mod, teeth=teeth, mate_teeth=teeth, face_width=10);\n")
            await pg.reload()
            await pg.wait_for_function("() => window.__workshop?.index.get('gen:local-bevel/bevel-gear')", timeout=180000)
            check("local project read (includes BOSL2 from the library)", True)

            # 4. search finds the new generators
            await pg.fill("#global-search", "bevel gear")
            await pg.wait_for_function("()=>/ms$/.test(document.querySelector('.browse-count')?.textContent || '')")
            top = await pg.eval_on_selector_all(".results [data-item]", "els=>els.slice(0,5).map(e=>e.dataset.item)")
            check("search 'bevel gear' finds the new generators", any("local-bevel" in t for t in top) and any(ids["gears"] in t for t in top), top)
            await pg.fill("#global-search", "silverware")
            await pg.wait_for_function("()=>/ms$/.test(document.querySelector('.browse-count')?.textContent || '')")
            top = await pg.eval_on_selector_all(".results [data-item]", "els=>els.map(e=>e.dataset.item)")
            check("search 'silverware' finds the added project's too", any(ids["vector76-gridfinity"] in t for t in top), top)
            await pg.screenshot(path=str(out / "p2-02-search.png"))

            # 5. render from library files
            await pg.goto(B + "#/m/local-bevel/bevel-gear")
            await pg.wait_for_function("()=>document.body.dataset.model==='local-bevel/bevel-gear'")
            await pg.wait_for_function(DONE, timeout=300000)
            status = await pg.inner_text("#status")
            check("a model that includes BOSL2 renders", "matches" in status, status)
            await pg.screenshot(path=str(out / "p2-03-bevel.png"))

            # 6. upstream change: edit first, then detect, summarise, accept; edits survive
            v76 = ids["vector76-gridfinity"]
            await pg.goto(B + f"#/browse/source/{v76}")
            await pg.wait_for_selector(".source-panel")
            await pg.click(".source-actions [data-act=edit]")
            await pg.fill("#meta-license", "CC-BY-4.0")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.wait_for_timeout(500)
            cup = f"gen:{v76}/gridfinity-basic-cup"
            await pg.click(f'.results [data-item="{cup}"]')
            await pg.click(".inspector [data-act=edit]")
            await pg.fill("#meta-name", "My cup")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.click("[data-act=check]")
            await pg.wait_for_selector(".update-banner", timeout=600000)
            banner = await pg.inner_text(".update-banner")
            check("upstream change detected and summarised", "Update ready" in banner, banner.replace("\n", " | ")[:300])
            await pg.screenshot(path=str(out / "p2-04-update.png"))
            before = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{v76}').version")
            await pg.click("[data-update=apply]")
            await pg.wait_for_selector(".update-banner", state="detached", timeout=60000)
            after = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{v76}').version")
            items = {i["id"]: i for i in await index_items(pg, v76)}
            check("update accepted", before != after, f"{before} -> {after}")
            check("edits survive the update", items.get(cup, {}).get("name") == "My cup" and items[cup]["license"] == "CC-BY-4.0",
                  items.get(cup))

            # 7. project-wide license; one item keeps its own
            other = f"gen:{v76}/gridfinity-baseplate"
            await pg.click(f'.results [data-item="{other}"]')
            await pg.click(".inspector [data-act=edit]")
            await pg.fill("#meta-license", "MIT")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.click(".source-actions [data-act=edit]")
            await pg.fill("#meta-license", "CC-BY-SA-4.0")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.wait_for_timeout(800)
            items = await index_items(pg, v76)
            gens = [i for i in items if i["kind"] == "generator"]
            ok = all(i["license"] == ("MIT" if i["id"] == other else "CC-BY-SA-4.0") for i in gens)
            check("project license applies to all items but the one with its own", ok, [(i["id"].split("/")[-1], i["license"]) for i in gens])

            # 8. a condensed group shows the icon chosen for it
            await pg.goto(B + "#/browse/all")
            await pg.wait_for_selector(".results [data-item]")
            await pg.select_option("select[aria-label=Group]", "project")
            await pg.click("[data-condense]")
            name = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{v76}').name")
            await pg.locator(".group-tile", has_text=name).first.click()
            await pg.locator(".results [data-item]").first.click()
            await pg.click("[data-act=group-icon]")
            await pg.wait_for_timeout(800)
            await pg.click(".group-crumb .link-btn")
            tile = pg.locator(".group-tile", has_text=name).first
            await tile.wait_for()
            check("condensed group shows its chosen icon", await tile.locator(".thumb > img").count() == 1)
            await pg.screenshot(path=str(out / "p2-05-condensed.png"))
            await pg.click("[data-condense]")
            await pg.select_option("select[aria-label=Group]", "none")
            await b.close()
    finally:
        server.terminate()
        server.wait(timeout=20)

    # 9. portable: the library opens the same after moving it
    moved = home / "moved" / "My library"
    shutil.copytree(library, moved)

    def summary(path):
        r = subprocess.run([a.cli, "library-summary", "--library", str(path), "--app-site", a.app_site], capture_output=True, text=True)
        if r.returncode:
            print(r.stderr)
        return json.loads(r.stdout)
    s1, s2 = summary(library), summary(moved)
    check("library opens the same after moving", s1 == s2, f"{len(s1['sources'])} projects, {len(s1['models'])} models")
    (out / "library-summary.json").write_text(json.dumps(s1, indent=1))
    shutil.make_archive(str(out / "library"), "zip", library)

    for e in errors:
        print("PAGE ERROR:", e)
    failed = [n for n, ok in results if not ok]
    print(f"{len(results) - len(failed)} of {len(results)} checks passed")
    return 1 if failed or errors else 0


sys.exit(asyncio.run(main()))
