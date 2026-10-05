#!/usr/bin/env python3
"""Phase 2 and 3 acceptance test: the desktop app's page against its real backend
(`workshop-cli serve`, the same command table as the Tauri app), in Chromium.

    python3 tests/desktop_page.py --cli desktop/target/release/workshop-cli --ui build/desktop/ui \\
        --app-site build/desktop/site --starter build/desktop/starter --engine build/native/squashfs-root \\
        --home /tmp/home --out shots [--github-api http://127.0.0.1:8795]

Checks: the starter library; adding three public GitHub projects by URL (one
pinned to an old commit, one a library); a local project that includes the
library; search; a render from library files; an upstream change detected and
summarised, accepted, with edits surviving; a project-wide license with one item
keeping its own; a condensed group showing the icon chosen for it; hiding,
flagging as broken, deleting (undo, restore) and moving items to another
project; categories added, removed and brought back; a hidden project; a deleted
project through the trash; Components (Phase 3): the bevel-gear flow (search,
the doc example's values, change teeth and module, preview, download, in under a
minute), pinning a component as a model, the OpenSCAD code, a form edit stored in
the shape of a manifest's ui block, and switching between your BOSL2 and the
app's; and the library opening the same after being moved (library-summary). Writes
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
            projects = await pg.evaluate("() => window.__workshop.catalog.sources.length")
            check("starter library installed", n == 58 and parts == 44 and projects == 19, f"{n} generators, {parts} parts, {projects} projects")
            heads = await pg.eval_on_selector_all(".sidebar .nav-head", "els => els.map(e => e.textContent.trim())")
            pcats = await pg.locator('.sidebar [data-scope^="pcat:"]').count()
            ccats = await pg.locator('.sidebar [data-scope^="ccat:"]').count()
            check("left menu: Parametric Models, Components and Parts Library by category",
                  heads[:3] == ["Parametric Models", "Components", "Parts Library"] and pcats >= 1 and ccats >= 8, (heads, pcats, ccats))
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
            top = await pg.eval_on_selector_all('.results [data-item^="gen:"]', "els=>els.slice(0,5).map(e=>e.dataset.item)")
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

            # 5b. Components: the libraries' modules as forms (your BOSL2, added above, wins over the app's)
            comps = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.kind === 'component').length")
            libs = await pg.evaluate("() => window.__workshop.catalog.component_libraries.map((l) => [l.name, l.provider, l.active])")
            check("Components: modules of the bundled libraries, your BOSL2 in use", comps > 700 and ["BOSL2", "project", True] in libs
                  and ["BOSL2", "bundled", False] in libs and ["NopSCADlib", "bundled", True] in libs, (comps, libs))
            # the bevel-gear flow: search, open the first result (a doc example's values), change teeth and module, preview, download
            t0 = time.time()
            await pg.goto(B + "#/")
            await pg.fill("#global-search", "bevel gear")
            await pg.wait_for_function("()=>/ms$/.test(document.querySelector('.browse-count')?.textContent || '')")
            first = await pg.eval_on_selector(".results [data-item]", "e => e.dataset.item")
            check("search 'bevel gear': BOSL2 bevel_gear() is the first result", first == "comp:@bosl2/bevel_gear", first)
            await pg.dblclick(f'.results [data-item="{first}"]')
            await pg.wait_for_function("()=>document.body.dataset.model==='@bosl2/bevel_gear'")
            await pg.wait_for_function(DONE, timeout=120000)
            start = {k: await pg.input_value(f"#p-{k}") for k in ("teeth", "mate_teeth", "circ_pitch")}
            await pg.fill("#p-teeth", "24")
            await pg.fill("#p-circ_pitch", "")
            await pg.fill("#p-mod", "2")
            await pg.click("#generate")
            await pg.wait_for_function("()=>!document.querySelector('#generate').disabled", timeout=120000)
            await pg.wait_for_function(DONE, timeout=120000)
            status = await pg.inner_text("#status")
            await pg.click("#download")
            saved_stl = home / "saved-files"
            for _ in range(50):
                if saved_stl.is_dir() and any(saved_stl.glob("*.stl")):
                    break
                await pg.wait_for_timeout(200)
            took = time.time() - t0
            stl = next(iter(saved_stl.glob("*.stl")), None) if saved_stl.is_dir() else None
            check("bevel gear: form from the docs' example, teeth and module changed, preview, download, under a minute",
                  start == {"teeth": "36", "mate_teeth": "36", "circ_pitch": "5"} and "matches" in status and stl and stl.stat().st_size > 10000 and took < 60,
                  (start, status, stl.name if stl else None, round(took, 1)))
            await pg.screenshot(path=str(out / "p3-01-bevel-component.png"))
            code = await pg.evaluate("() => window.__workshop.platform.api('component_code', { key: '@bosl2/bevel_gear', values: { teeth: 24, mod: 2, mate_teeth: 36 } })")
            check("the component's OpenSCAD code", "include <BOSL2/gears.scad>" in code and "bevel_gear(teeth=24, mate_teeth=36" in code and "mod=2" in code, code.replace("\n", " | "))
            # pin it as a model (the settings it has now become its defaults)
            await pg.click("#pin-component")
            await pg.wait_for_selector(".pin-dialog #pin-name")
            await pg.fill("#pin-name", "Bevel gear 24T")
            await pg.click("#pin-go")
            await pg.wait_for_function("() => location.hash === '#/m/pinned/bevel-gear-24t'", timeout=60000)
            await pg.wait_for_function(DONE, timeout=120000)
            pin = await pg.evaluate("() => { const i = window.__workshop.index.get('gen:pinned/bevel-gear-24t'); return i && [i.kind, i.category, i.project]; }")
            pinned_teeth = await pg.input_value("#p-teeth")
            check("pinned as a model under Parametric Models, with its settings", pin == ["generator", "mechanical", "Pinned components"] and pinned_teeth == "24"
                  and (library / "sources/pinned/pins/bevel-gear-24t.json").is_file(), (pin, pinned_teeth))
            # the form editor: stored in the shape of a family manifest's model entry
            await pg.click("#edit-form")
            await pg.wait_for_selector(".form-editor")
            await pg.click("[data-fe=teeth] .fe-name")
            await pg.fill("[data-form='teeth.label']", "Tooth count")
            await pg.fill("[data-form='teeth.min']", "8")
            await pg.click("[data-fe=mate_teeth] .fe-name")
            await pg.fill("[data-form='mate_teeth.when']", "teeth > 10")
            await pg.click("[data-form='spiral.show']")
            await pg.screenshot(path=str(out / "p3-02-form-editor.png"))
            await pg.click("#fe-save")
            await pg.wait_for_selector(".form-editor", state="detached")
            await pg.wait_for_function("() => document.querySelector('[data-name=teeth] label')?.textContent === 'Tooth count'", timeout=60000)
            stored = json.loads((library / "sources/pinned/metadata.json").read_text())["items"]["bevel-gear-24t"]["form"]
            want = {"ui": {"teeth": {"label": "Tooth count", "min": 8}, "mate_teeth": {"display-condition": {"js": "teeth > 10"}}}, "hidden": ["spiral"]}
            spiral_gone = await pg.evaluate("() => !document.querySelector('[data-name=spiral]')")
            check("form edit stored as a manifest ui block, and applied", stored == want and spiral_gone, stored)
            # your BOSL2 or the app's: switch, projects that include it are read again, and back
            await pg.goto(B + "#/library-settings")
            await pg.click('#ls-libraries [data-library="BOSL2"][data-provider="bundled"] [data-act=prefer]')
            await pg.wait_for_selector('#ls-libraries [data-library="BOSL2"][data-provider="bundled"][data-active]', timeout=300000)
            switched = await pg.evaluate("""() => [window.__workshop.catalog.components.find((c) => c.key === '@bosl2/bevel_gear')?.provider,
                window.__workshop.catalog.attention.filter((a) => a.kind === 'libraries').length]""")
            await pg.click('#ls-libraries [data-library="BOSL2"][data-provider="project"] [data-act=prefer]')
            await pg.wait_for_selector('#ls-libraries [data-library="BOSL2"][data-provider="project"][data-active]', timeout=300000)
            back = await pg.evaluate("() => window.__workshop.catalog.components.find((c) => c.key === '@bosl2/bevel_gear')?.provider")
            prefer = json.loads((library / "library.json").read_text()).get("prefer_bundled")
            check("switch between your BOSL2 and the app's (projects read again)", switched == ["bundled", 0] and back == "project" and not prefer, (switched, back, prefer))

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
            await pg.wait_for_function(f"() => window.__workshop.index.get('{cup}')?.license?.spdx === 'CC-BY-SA-4.0'", timeout=20000)
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

            # 9. hide, flag as broken, delete and list under another project (with undo and restore)
            gens = sorted(i["id"] for i in await index_items(pg, v76) if i["kind"] == "generator" and i["id"] not in (cup, other))
            hide_id, flag_id, del_id, move_id = gens[:4]
            await pg.goto(B + f"#/browse/source/{v76}")
            await pg.wait_for_selector(f'.results [data-item="{hide_id}"]')
            await pg.click(f'.results [data-item="{hide_id}"]')
            await pg.click(".inspector [data-act=hide]")
            await pg.wait_for_selector(f'.results [data-item="{hide_id}"]', state="detached")
            await pg.click("[data-show-hidden]")
            await pg.wait_for_selector(f'.results [data-item="{hide_id}"][data-hidden]')
            check("hidden item leaves the list; Show hidden brings it back", True)
            await pg.click("[data-show-hidden]")
            await pg.click(f'.results [data-item="{flag_id}"]')
            await pg.click(".inspector [data-act=flag]")
            await pg.fill("#flag-note", "Lid too tight")
            await pg.click("#flag-save")
            await pg.wait_for_selector(".inspector .insp-flag.broken")
            key = flag_id.split(":", 1)[1]
            attn = await pg.evaluate(f"() => window.__workshop.catalog.attention.some((a) => a.kind === 'broken' && a.model === '{key}')")
            note = await pg.evaluate(f"() => window.__workshop.index.get('{flag_id}').broken?.note")
            check("flagged as broken, with its note, under Needs attention", attn and note == "Lid too tight", note)
            await pg.click(f'.results [data-item="{del_id}"]')
            await pg.click(".inspector [data-act=delete]")
            await pg.wait_for_selector(f'.results [data-item="{del_id}"]', state="detached")
            await pg.keyboard.press("Control+z")
            await pg.wait_for_selector(f'.results [data-item="{del_id}"]')
            await pg.click(f'.results [data-item="{del_id}"]')
            await pg.click(".inspector [data-act=delete]")
            await pg.wait_for_selector(f'.results [data-item="{del_id}"]', state="detached")
            removed = await pg.evaluate("() => window.__workshop.catalog.removed_items.map((r) => r.target)")
            check("deleted item leaves the library (Ctrl+Z undoes)", del_id.split("/")[-1] in removed, removed)
            await pg.click(f'.results [data-item="{move_id}"]')
            await pg.click(".inspector [data-act=edit]")
            await pg.wait_for_selector("#meta-save:not([disabled])")
            prefilled = await pg.input_value("#meta-license")
            await pg.select_option("#meta-project", ids["gears"])
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.wait_for_function(f"() => window.__workshop.index.get('{move_id}')?.projectId === '{ids['gears']}'", timeout=20000)
            mv = await pg.evaluate(f"() => window.__workshop.index.get('{move_id}')")
            check("edit dialog starts with the values in use", prefilled == "CC-BY-SA-4.0", prefilled)
            check("item listed under another project; credits stay", mv["projectId"] == ids["gears"] and mv["sourceId"] == v76 and mv["license"]["spdx"] == "CC-BY-SA-4.0",
                  (mv["projectId"], mv["sourceId"], mv["license"]))

            # 10. library settings: categories, deleted items, project hide, trash
            await pg.goto(B + "#/library-settings")
            await pg.wait_for_selector("#ls-category-table")
            await pg.fill("#category-new", "Kitchen")
            await pg.click("#category-add")
            await pg.wait_for_selector('[data-category="kitchen"]')
            await pg.click('[data-category="labels"] [data-act=remove-category]')
            await pg.select_option('[data-category="labels"] [data-move-to]', "gridfinity")
            await pg.click('[data-category="labels"] [data-act=remove-confirm]')
            await pg.wait_for_selector('[data-category="labels"]', state="detached")
            left = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.category === 'labels').length")
            await pg.click(".ls-removed summary")
            await pg.click("[data-act=restore-category]")
            await pg.wait_for_selector('[data-category="labels"]')
            back = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.category === 'labels').length")
            check("categories: add, remove (items move), bring back", left == 0 and back >= 5, (left, back))
            await pg.click("#ls-deleted [data-act=restore-item]")
            await pg.wait_for_function(f"() => !!window.__workshop.index.get('{del_id}')")
            check("a deleted item comes back from Library settings", True)
            await pg.click(f'[data-source="{ids["gears"]}"] [data-act=hide-project]')
            await pg.wait_for_function(f"() => window.__workshop.index.items.filter((i) => i.projectId === '{ids['gears']}').every((i) => i.hidden)")
            hidden_n = await pg.evaluate(f"() => window.__workshop.index.query({{ scope: {{ project: '{ids['gears']}' }} }}).total")
            await pg.click(f'[data-source="{ids["gears"]}"] [data-act=hide-project]')
            await pg.wait_for_function(f"() => window.__workshop.index.query({{ scope: {{ project: '{ids['gears']}' }} }}).total > 0")
            check("a hidden project hides everything in it", hidden_n == 0)
            await pg.click('[data-source="local-bevel"] [data-act=delete-project]')
            await pg.wait_for_selector("[data-entry]")
            in_trash = not (library / "local/bevel").exists() and any((library / "trash").iterdir())
            await pg.click("[data-entry] [data-act=trash-restore]")
            await pg.wait_for_selector('[data-source="local-bevel"]')
            restored = (library / "local/bevel/bevel_gear.scad").is_file()
            await pg.click('[data-source="local-bevel"] [data-act=delete-project]')
            await pg.wait_for_selector("[data-entry]")
            await pg.screenshot(path=str(out / "p2-06-library-settings.png"), full_page=True)
            await pg.click("#trash-empty")
            await pg.wait_for_selector("#trash-none")
            emptied = not any((library / "trash").iterdir())
            check("deleted project goes to the trash, comes back, trash empties", in_trash and restored and emptied, (in_trash, restored, emptied))
            await b.close()
    finally:
        server.terminate()
        server.wait(timeout=20)

    # 11. portable: the library opens the same after moving it
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
