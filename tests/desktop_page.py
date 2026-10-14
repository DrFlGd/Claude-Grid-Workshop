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
app's; 0.3.1: the left menu's category panel, a doc-listed setting as a drop-down,
Edit… in Library settings, long text kept inside its box; 0.4: the side viewer (a
model's code, a project's README, a component's file at its module), settings from
the values in a model's module call (the Gears examples; LEGO.scad's style, borrowing the library's
descriptions and drop-downs); 0.4.1: the Code tab as an editor (Generate uses the
edits, saved as a variant with the settings, the project's file untouched); 0.4.3: Condense with a
selection, the category picker, Scan for changes, a library backup and restore; and the library opening
the same after being moved (library-summary). Writes
<out>/library-summary.json and <out>/library.zip for the cross-platform check.
"""
import argparse
import asyncio
import hashlib
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
# anything in the open dialog that reaches past its edges
OVERFLOW = """() => { const d = document.querySelector('.dialog'); if (!d) return ['no dialog']; const r = d.getBoundingClientRect();
  return [...d.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > r.right + 1 || b.left < r.left - 1); })
    .map((e) => e.tagName + '.' + e.className).slice(0, 5); }"""
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


async def gen(pg):
    """Generate and wait for it; the dimensions shown."""
    await pg.click("#generate")
    await pg.wait_for_function("()=>!document.querySelector('#generate').disabled", timeout=120000)
    await pg.wait_for_function(DONE, timeout=120000)
    return (await pg.inner_text("#dims")).split("\n")[0]


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
            # (a render that fails answers 500, which the browser logs: section 13b's model that doesn't
            # render at its defaults does so on purpose, and the checks report any other failed render)
            pg.on("console", lambda m: errors.append(f"{m.text} ({m.location.get('url', '')})") if m.type == "error" and "net::ERR_" not in m.text
                  and not ("status of 500" in m.text and m.location.get("url", "").endswith("/invoke/render")) else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await pg.goto(B)
            await pg.wait_for_selector(".home .tile", timeout=120000)
            await pg.wait_for_function("() => !!window.__workshop", timeout=10000)

            # 1. the starter library
            n = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.kind === 'generator').length")
            parts = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.kind === 'part').length")
            projects = await pg.evaluate("() => window.__workshop.catalog.sources.length")
            check("starter library installed", n == 58 and parts == 44 and projects == 19, f"{n} generators, {parts} parts, {projects} projects")
            await pg.screenshot(path=str(out / "p2-00-home.png"))
            # the left menu: the three sections; the one being browsed shows its categories in a panel beside it
            sections = await pg.eval_on_selector_all(".sidebar [data-section-row] .nav-label", "els => els.map(e => e.textContent.trim())")
            panel_home = await pg.locator(".catpanel").count()
            await pg.click('.sidebar [data-scope="components"]')
            await pg.wait_for_selector('.catpanel [data-scope^="ccat:"]')
            ccats = await pg.locator('.catpanel [data-scope^="ccat:"]').count()
            scrolls = await pg.eval_on_selector(".catpanel-list", "e => getComputedStyle(e).overflowY")
            await pg.click('.sidebar [data-scope="parts"]')
            await pg.wait_for_selector('.catpanel [data-scope^="pcat:"]')
            pcats = await pg.locator('.catpanel [data-scope^="pcat:"]').count()
            await pg.click(".catpanel .nav-toggle >> nth=0")
            await pg.click('.catpanel [data-scope^="lib:"] >> nth=0')
            await pg.wait_for_function("() => location.hash.includes('/browse/lib/')")
            within = await pg.wait_for_selector('.sidebar [data-scope="parts"].within', timeout=5000) and 1
            await pg.click("#catpanel-toggle")
            await pg.wait_for_selector(".catpanel.folded")
            await pg.click("#catpanel-toggle")
            await pg.wait_for_selector('.catpanel:not(.folded) [data-scope^="pcat:"]')
            check("left menu: Parametric Models, Components, Parts Library; the categories in a panel beside it (projects inside, folds away, scrolls)",
                  sections == ["Parametric Models", "Components", "Parts Library"] and panel_home == 0 and ccats >= 8 and pcats >= 1 and within == 1 and scrolls == "auto",
                  (sections, panel_home, ccats, pcats, within, scrolls))

            # 1b. (0.4.5) skins: Drafting Sheet unless chosen; Settings offers all four; each one in light and dark
            await pg.goto(B + "#/settings")
            await pg.wait_for_selector("#skin-pick input")
            default_skin = await pg.evaluate("document.documentElement.dataset.skin")
            offered = await pg.eval_on_selector_all("#skin-pick input", "els => els.map((e) => e.value)")
            first_gen = await pg.evaluate("() => window.__workshop.index.items.find((i) => i.kind === 'generator' && !i.hidden).id.replace(/^gen:/, '')")
            applied = []
            for skin in offered:
                for theme in ("light", "dark"):
                    await pg.goto(B + "#/settings")
                    await pg.wait_for_selector("#skin-pick input")
                    await pg.check(f'#skin-pick input[value="{skin}"]')
                    await pg.check(f'#theme-pick input[value="{theme}"]')
                    applied.append(await pg.evaluate("[document.documentElement.dataset.skin, document.documentElement.dataset.theme].join('/')"))
                    for page, target in (("home", "#/"), ("browse", "#/browse/all"), ("model", f"#/m/{first_gen}")):
                        await pg.goto(B + target)
                        await pg.wait_for_selector({"home": ".home .tile", "browse": ".results [data-item]", "model": "#generate"}[page])
                        await asyncio.sleep(1.5)
                        await pg.screenshot(path=str(out / f"p5-skin-{skin}-{theme}-{page}.png"))
            await pg.goto(B + "#/settings")
            await pg.wait_for_selector("#skin-pick input")
            await pg.check('#skin-pick input[value="partsbin"]')
            await pg.check('#theme-pick input[value="system"]')
            await asyncio.sleep(1)   # preferences are written a moment after a change
            await pg.reload()
            await pg.wait_for_function("() => !!window.__workshop")
            kept = await pg.evaluate("document.documentElement.dataset.skin")
            await pg.wait_for_selector("#skin-pick input")
            await pg.check('#skin-pick input[value="drafting"]')
            fonts_ok = True
            if (Path(a.ui) / "vendor/fonts/fonts.css").is_file():   # bundled by build_desktop.py --fetch-fonts
                # (at every weight in use, for letters, not just "·": Review 2's UI-13, where a "·"-only face
                # with no weight range took over regular text)
                fonts_ok = await pg.evaluate("""async () => (await Promise.all(['Overpass', 'Overpass Mono', 'Sofia Sans', 'Atkinson Hyperlegible', 'M PLUS Rounded 1c']
                    .flatMap((f) => [400, 600, 700].map((w) => document.fonts.load(`${w} 14px "${f}"`, 'Gridfinity 28')
                      .then((l) => l.some((x) => !/00B7/i.test(x.unicodeRange))))))).every(Boolean)""")
            check("skins: Drafting Sheet by default; Settings offers four, each applies in light and dark and is kept; their fonts are bundled",
                  default_skin == "drafting" and offered == ["drafting", "partsbin", "layerline", "classic"] and applied == [f"{s}/{t}" for s in offered for t in ("light", "dark")]
                  and kept == "partsbin" and fonts_ok, (default_skin, offered, applied, kept, fonts_ok))
            await pg.goto(B + "#/")

            # 2. three public projects by URL
            ids = {}
            add_toasts = []
            for short, url, lib in REPOS:
                await pg.click("#add-project")
                await pg.fill("#add-url", url)
                if "/commit/" in url:   # (0.4.9) a link to a commit asks what updates follow; the branch by default
                    follow_pick = await pg.eval_on_selector_all("#add-follow input", "els => els.map((e) => [e.value, e.checked])")
                if lib:
                    await pg.check("#add-library")
                await pg.click("#add-go")
                await pg.wait_for_function("() => location.hash.includes('/source/')", timeout=600000)
                await pg.wait_for_selector(".source-panel")
                src = (await pg.evaluate("location.hash")).split("/source/")[1]
                ids[short] = src
                add_toasts.append(await pg.locator("#toast").text_content() or "")
                items = await index_items(pg, src)
                ok = (len(items) == 0) if lib else (len([i for i in items if i["kind"] == "generator"]) > 0)
                check(f"added {url.split('github.com/')[1]}", ok, f"{src}: {len(items)} items")
                await pg.goto(B + "#/")
            await pg.screenshot(path=str(out / "p2-01-added.png"))
            v76_origin = json.loads((library / f"sources/{ids['vector76-gridfinity']}/source.json").read_text())["origin"]
            check("a link to a commit asks whether to follow new releases or the branch; the project records what it follows and the commit it was added from",
                  follow_pick == [["releases", False], ["branch", True]] and v76_origin.get("track", "").startswith("branch:")
                  and v76_origin.get("added_from") == OLD and "requested" not in v76_origin, (follow_pick, v76_origin))
            check("the messages say models, and that a library's modules are in Components (not generators)",
                  not any("generator" in t for t in add_toasts) and any("a library, its modules are in Components" in t for t in add_toasts)
                  and any(" model" in t for t in add_toasts), add_toasts)

            # 3. a project of your own that includes the library (<BOSL2/...>)
            (library / "local/bevel").mkdir(parents=True, exist_ok=True)
            (library / "local/bevel/bevel_gear.scad").write_text(
                "include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n\n// Number of teeth\nteeth = 20; // [8:60]\n"
                "// Tooth size (module)\nmod = 2; // [0.5:0.5:5]\n\nbevel_gear(mod=mod, teeth=teeth, mate_teeth=teeth, face_width=10);\n")
            # and one in LEGO.scad's style: Customizer variables passed to the module by the library's own
            # call, and an example whose values (a fraction among them) are typed into its call
            (library / "local/bricks/examples").mkdir(parents=True, exist_ok=True)
            (library / "local/bricks/brick.scad").write_text(
                "/* [General] */\n\n// Width of the block, in studs\nblock_width = 2;\n\n// Length of the block, in studs\nblock_length = 4;\n\n"
                "// Height of the block: 1/3 is a plate, 1 a brick\nblock_height_ratio = 1; // [.33333333333:1/3, .5:1/2, 1:1, 2:2]\n\n"
                "// What type of block should this be?\nblock_type = \"brick\"; // [brick:Brick, tile:Tile]\n\n"
                "block(width=block_width, length=block_length, height=block_height_ratio, type=block_type);\n\n"
                "module block(width=1, length=2, height=1, type=\"brick\") {\n    cube([width * 8 - 0.2, length * 8 - 0.2, height * 9.6]);\n"
                "    if (type == \"brick\")\n        for (x = [0:width - 1], y = [0:length - 1])\n"
                "            translate([x * 8 + 4, y * 8 + 4, height * 9.6]) cylinder(d=4.8, h=1.8, $fn=24);\n}\n")
            (library / "local/bricks/examples/plate.scad").write_text(
                "use <../brick.scad>;\n\nblock(\n    width=2,\n    length=4,\n    height=1/3,\n    type=\"tile\"\n);\n")
            await pg.reload()
            await pg.wait_for_function("() => window.__workshop?.index.get('gen:local-bevel/bevel-gear') && window.__workshop?.index.get('gen:local-bricks/examples-plate')", timeout=180000)
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
            # (0.4.6) the page is titled with the component's own name, its library under it; settings are
            # named as on model forms, with the code name on hover (UI-4, UI-5)
            head = [await pg.inner_text("#model-title"), await pg.inner_text("#model-project")]
            mate = [await pg.inner_text("label[for='p-mate_teeth']"), await pg.get_attribute("label[for='p-mate_teeth']", "title") or ""]
            check("component page: its own name with its library under it; settings named like a model's, the code name on hover",
                  head[0] == "Bevel gear" and head[1] == "BOSL2 · bevel_gear() · your copy"
                  and mate[0] == "Mate teeth" and "In the code: mate_teeth" in mate[1], (head, mate))
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
            await pg.click("#model-more summary")
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
            # the form editor: stored in the shape of a family manifest's model entry (under ⋯ since 0.4.9)
            await pg.click("#model-more summary")
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
            # (the row can show the switch before its projects are read again, when something else reloads the
            # catalog first: wait for the switch's own message)
            try:
                await pg.wait_for_function("() => (document.querySelector('#toast')?.textContent || '').includes('comes with the app is used now')", timeout=120000)
            except Exception:
                pass
            switched = await pg.evaluate("""() => [window.__workshop.catalog.components.find((c) => c.key === '@bosl2/bevel_gear')?.provider,
                window.__workshop.catalog.attention.filter((a) => a.kind === 'libraries').map((a) => a.message)]""")
            switched[1] = switched[1] or 0   # (the messages, when there are any)
            # (0.4.9) the pin made with your BOSL2 records that copy, and is marked while the app's is used
            pin_from = json.loads((library / "sources/pinned/pins/bevel-gear-24t.json").read_text()).get("from", {})
            pin_marked = await pg.evaluate("() => (window.__workshop.catalog.sources.find((s) => s.id === 'pinned')?.problems || []).some((p) => p.kind === 'pin_library')")
            await pg.click('#ls-libraries [data-library="BOSL2"][data-provider="project"] [data-act=prefer]')
            await pg.wait_for_selector('#ls-libraries [data-library="BOSL2"][data-provider="project"][data-active]', timeout=300000)
            try:
                await pg.wait_for_function("() => (document.querySelector('#toast')?.textContent || '').includes('your copy is used now')", timeout=120000)
            except Exception:
                pass
            back = await pg.evaluate("() => window.__workshop.catalog.components.find((c) => c.key === '@bosl2/bevel_gear')?.provider")
            prefer = json.loads((library / "library.json").read_text()).get("prefer_bundled")
            pin_back = await pg.evaluate("() => (window.__workshop.catalog.sources.find((s) => s.id === 'pinned')?.problems || []).some((p) => p.kind === 'pin_library')")
            check("switch between your BOSL2 and the app's (projects read again); a pin records the copy it was made with and is marked while another is used",
                  switched == ["bundled", 0] and back == "project" and not prefer
                  and pin_from.get("copy", "").startswith("github-belfryscad-bosl2@") and pin_marked and not pin_back, (switched, back, prefer, pin_from, pin_marked, pin_back))

            # 5c. a setting whose doc lists its values is a drop-down (BOSL2 spheroid's style), and renders with the choice
            await pg.goto(B + "#/m/@bosl2/spheroid")
            await pg.wait_for_function("()=>document.body.dataset.model==='@bosl2/spheroid'")
            await pg.wait_for_function(DONE, timeout=120000)
            tag = await pg.eval_on_selector("#p-style", "e => e.tagName")
            opts = await pg.eval_on_selector_all("#p-style option", "els => els.map(e => e.textContent)")
            await pg.select_option("#p-style", label="icosa")
            await pg.click("#generate")
            await pg.wait_for_function("()=>!document.querySelector('#generate').disabled", timeout=120000)
            await pg.wait_for_function(DONE, timeout=120000)
            status = await pg.inner_text("#status")
            check("a setting whose doc lists its values is a drop-down (spheroid style), and renders with the choice",
                  tag == "SELECT" and opts == ["orig", "aligned", "stagger", "octa", "icosa"] and "matches" in status, (tag, opts, status))

            # 5d. the side viewer (Phase 4): a model's code and its project's README (HTML kept in the
            # library, pictures from the project's own files), a component's file at its module, the
            # app's README for a built-in model, a project file from its Files tab, folding away
            gears = ids["gears"]
            await pg.goto(B + f"#/m/{gears}/examples-bevel-gear")
            await pg.wait_for_function(f"()=>document.body.dataset.model==='{gears}/examples-bevel-gear'")
            # (its values are typed into a module call, bevel_gear(modul=1, tooth_number=30, ...): they become settings)
            await pg.wait_for_function(DONE, timeout=120000)
            lifted = await pg.eval_on_selector_all("#params .field[data-name]", "els => els.map(e => e.dataset.name)")
            dims0 = await pg.inner_text("#dims")
            await pg.fill("#p-tooth_number", "18")
            await pg.click("#generate")
            await pg.wait_for_function("()=>!document.querySelector('#generate').disabled", timeout=120000)
            await pg.wait_for_function(DONE, timeout=120000)
            status = await pg.inner_text("#status")
            dims1 = await pg.inner_text("#dims")
            check("a model whose values are typed into its module call has them as settings, and renders with a change",
                  {"modul", "tooth_number", "partial_cone_angle", "bore"} <= set(lifted) and "matches" in status and dims0 != dims1,
                  (lifted, status, dims0.split("\n")[0], dims1.split("\n")[0]))
            # (in LEGO.scad's style, the settings borrow the library's descriptions and drop-downs, and 1/3 is
            # the library's own 1/3)
            await pg.goto(B + "#/m/local-bricks/examples-plate")
            await pg.wait_for_function("()=>document.body.dataset.model==='local-bricks/examples-plate'")
            await pg.wait_for_function(DONE, timeout=120000)
            fields = await pg.eval_on_selector_all("#params .field[data-name]", """els => Object.fromEntries(els.map((e) => {
                const s = e.querySelector('select'); const l = e.querySelector('label');
                return [e.dataset.name, [s ? s.options[s.selectedIndex].text : e.querySelector('input')?.type, l?.title || '']]; }))""")
            dims0 = await pg.inner_text("#dims")
            await pg.select_option("#p-height", label="1")
            await pg.click("#generate")
            await pg.wait_for_function("()=>!document.querySelector('#generate').disabled", timeout=120000)
            await pg.wait_for_function(DONE, timeout=120000)
            dims1 = await pg.inner_text("#dims")
            check("settings from a module call borrow the library's descriptions and choices (a fraction is the library's 1/3)",
                  fields.get("width", [None])[0] == "number" and fields["width"][1].startswith("Width of the block, in studs") and fields.get("height", [None])[0] == "1/3"
                  and fields.get("type", [None])[0] == "Tile" and "15.8 × 31.8 × 3.2" in dims0 and "× 9.6" in dims1.split("\n")[0],
                  (fields, dims0.split("\n")[0], dims1.split("\n")[0]))
            # 5e. the Code tab edits the model (0.4.1): Generate uses the edits, Save keeps them with the
            # settings as a variant (not a copy of the model), Defaults goes back to the original code, and
            # the project's file is never written
            plate = (library / "local/bricks/examples/plate.scad").read_text()
            await pg.click("#model-extra [data-side-open=code]")
            await pg.wait_for_selector("#side-editor")
            await pg.wait_for_function("() => document.querySelector('#side-editor').value.includes('width = 2;')")
            original = await pg.input_value("#side-editor")
            await pg.fill("#side-editor", original.replace("width = 2;", "width = 3;"))
            stale = await pg.inner_text("#status")
            dims_edit = await gen(pg)
            await pg.click("#side-save")
            await pg.wait_for_selector("#save-dialog[open]")
            await pg.fill("#save-name", "Three wide")
            await pg.click("#save-primary")
            await pg.wait_for_selector("#save-dialog", state="hidden")
            recs = [json.loads(f.read_text()) for f in (library / "recipes").glob("*.json")]
            rec = next((r for r in recs if r.get("model") == "local-bricks/examples-plate" and r.get("name") == "Three wide"), {})
            stored = rec.get("edits") or {}
            entry_edit = stored.get("/examples/plate.scad") or {}
            await pg.select_option("#settings-pick", "default")
            await pg.wait_for_function("() => !document.querySelector('#side-editor').value.includes('width = 3;')")
            await pg.wait_for_function(DONE, timeout=120000)
            dims_default = (await pg.inner_text("#dims")).split("\n")[0]
            await pg.select_option("#settings-pick", f"saved:{rec.get('id')}")
            await pg.wait_for_function("() => document.querySelector('#side-editor').value.includes('width = 3;')")
            await pg.wait_for_function(DONE, timeout=120000)
            dims_variant = (await pg.inner_text("#dims")).split("\n")[0]
            listed = await pg.eval_on_selector_all("#settings-pick option", "els => els.map((e) => e.textContent)")
            items_after = [i for i in await index_items(pg, "local-bricks") if "plate" in i["id"]]
            bricks_version = await pg.evaluate("() => window.__workshop.catalog.sources.find((s) => s.id === 'local-bricks').version")
            check("the Code tab edits a model: Generate uses the edits; saved as a variant with the settings; Defaults is the original code; the file is untouched",
                  "Code changed" in stale and "23.8 × 31.8 × 9.6" in dims_edit and "width = 3;" in entry_edit.get("text", "")
                  and len(entry_edit.get("base") or "") == 64 and rec.get("values") == {"height": 1}
                  # (0.4.8) the project version it was saved with; its edit based on the project's file, not the app's copy
                  and rec.get("version") == bricks_version and entry_edit.get("base") == hashlib.sha256(plate.encode()).hexdigest() and len(entry_edit.get("copy") or "") == 64
                  and "15.8 × 31.8 × 3.2" in dims_default and "23.8 × 31.8 × 9.6" in dims_variant
                  and "Three wide · code edited" in listed and len(items_after) == 1
                  and (library / "local/bricks/examples/plate.scad").read_text() == plate,
                  (stale, dims_edit, dims_default, dims_variant, rec.get("values"), list(stored), listed, len(items_after)))
            await pg.screenshot(path=str(out / "p4-03-code-edited.png"))
            await pg.select_option("#settings-pick", "default")
            await pg.wait_for_function(DONE, timeout=120000)
            await pg.goto(B + f"#/m/{gears}/examples-bevel-gear")
            await pg.wait_for_function(f"()=>document.body.dataset.model==='{gears}/examples-bevel-gear'")
            await pg.wait_for_function(DONE, timeout=120000)
            await pg.click("#model-extra [data-side-open=code]")
            await pg.wait_for_selector(".side-panel[data-side-panel=code] .code .cl")
            code = await pg.inner_text(".side-panel .code")
            await pg.click("[data-side-tab=readme]")
            await pg.wait_for_selector(".side-panel[data-side-panel=readme] .doc-frame")
            await pg.wait_for_function("() => document.querySelector('.doc-frame')?.contentDocument?.querySelector('h1')")
            h1 = await pg.frame_locator(".doc-frame").locator("h1").first.inner_text()
            await pg.wait_for_function("""() => [...(document.querySelector('.doc-frame').contentDocument.images || [])]
                .some((i) => i.src.includes('/library/') && i.complete && i.naturalWidth > 0)""", timeout=15000)
            stored = any((library / f"sources/{gears}/docs").rglob("readme.html"))
            await pg.screenshot(path=str(out / "p4-01-readme.png"))
            # (0.4.8) the 3D view's size and view buttons stay clear of the open side viewer
            hud = await pg.evaluate("""() => { const p = document.querySelector('.side-panel').getBoundingClientRect().left;
                return ['.hud-dims', '.hud-tools'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().right - p)); }""")
            check("side viewer: a model's code, its project's README as HTML kept in the library, pictures from its files; the 3D view's size bar stays clear of it",
                  "include" in code and "tooth_number = 30" in code and "Gear" in h1 and stored and all(x <= 1 for x in hud), (code[:60], h1, stored, hud))
            await pg.goto(B + "#/m/@bosl2/bevel_gear")
            await pg.wait_for_function("()=>document.body.dataset.model==='@bosl2/bevel_gear'")
            await pg.wait_for_selector(".side-panel[data-side-panel=readme] .doc-frame")
            await pg.wait_for_function("() => /BOSL2/.test(document.querySelector('.doc-frame')?.contentDocument?.querySelector('h1')?.textContent || '')")
            await pg.click("[data-side-tab=code]")
            await pg.wait_for_selector(".side-panel[data-side-panel=code] .code .cl")
            generated = await pg.inner_text(".side-panel .code")
            await pg.select_option("#side-file", index=1)
            await pg.wait_for_selector(".side-panel .code .cl.mark")
            marked = await pg.inner_text(".side-panel .code .cl.mark")
            await pg.screenshot(path=str(out / "p4-02-component-code.png"))
            await pg.goto(B + "#/m/gridfinity-extended/bin")
            await pg.wait_for_function("()=>document.body.dataset.model==='gridfinity-extended/bin'")
            await pg.click("[data-side-tab=readme]")
            await pg.wait_for_function("() => /Gridfinity Extended/.test(document.querySelector('.doc-frame')?.contentDocument?.querySelector('h1')?.textContent || '')")
            await pg.click("[data-side-tab=readme]")
            await pg.wait_for_selector(".side-panel", state="detached")
            await pg.goto(B + f"#/browse/source/{gears}")
            await pg.wait_for_selector(".source-panel")
            await pg.click("[data-source-tab=files]")
            await pg.click("[data-code-file] >> nth=0")
            await pg.wait_for_selector(".side-panel[data-side-panel=code] .code .cl")
            from_files = await pg.inner_text(".side-head")
            await pg.click(".side-close")
            await pg.wait_for_selector(".side-panel", state="detached")
            check("side viewer: a component's generated code and its module's file, the BOSL2 and Gridfinity Extended READMEs, a project file",
                  "bevel_gear(" in generated and "module bevel_gear(" in marked and ".scad" in from_files, (generated[:80], marked[:60], from_files))

            # 6. upstream change: edit first, then detect, summarise, accept; edits survive
            v76 = ids["vector76-gridfinity"]
            await pg.goto(B + f"#/browse/source/{v76}")
            await pg.wait_for_selector(".source-panel")
            await pg.click("#source-more summary")
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
            # (no other background work: the daily check may still be reading the new version)
            await pg.wait_for_selector(".status-idle", timeout=600000)
            await pg.click("[data-act=check]")
            await pg.wait_for_selector(".update-banner", timeout=600000)
            # (the banner can be there already, from the daily check: wait for this check to finish)
            await pg.wait_for_function("() => document.querySelector('[data-act=check]')?.textContent === 'Check for updates'", timeout=600000)
            await pg.wait_for_selector(".status-idle", timeout=600000)
            banner = await pg.inner_text(".update-banner")
            check("upstream change detected and summarised", "Update ready" in banner, banner.replace("\n", " | ")[:300])
            await pg.screenshot(path=str(out / "p2-04-update.png"))
            before = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{v76}').version")
            t_apply = time.time()
            await pg.click("[data-update=apply]")
            try:
                await pg.wait_for_selector(".update-banner", state="detached", timeout=60000)
            except Exception:
                toasts = await pg.eval_on_selector_all(".toast", "els => els.map(e => e.textContent)")
                raise SystemExit(f"the update wasn't applied; the page said: {toasts}")
            after = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{v76}').version")
            items = {i["id"]: i for i in await index_items(pg, v76)}
            check("update accepted", before != after, f"{before} -> {after}")
            check("edits survive the update", items.get(cup, {}).get("name") == "My cup" and items[cup]["license"] == "CC-BY-4.0",
                  items.get(cup))
            # (0.4.8) the new version's models are rendered at their defaults again, with new thumbnails
            n_models = len([i for i in items.values() if i["kind"] == "generator"])
            checks_file, rechecked = library / f"sources/{v76}/checks.json", {}
            for _ in range(600):
                rechecked = json.loads(checks_file.read_text()) if checks_file.is_file() else {}
                if rechecked.get("version") == after and len(rechecked.get("models", {})) >= n_models:
                    break
                await pg.wait_for_timeout(1000)
            fresh = [m for m, r in rechecked.get("models", {}).items() if r.get("ok")
                     and (library / f"sources/{v76}/thumbs/{m}.webp").is_file() and (library / f"sources/{v76}/thumbs/{m}.webp").stat().st_mtime >= t_apply]
            check("after an update its models are rendered at their defaults again, and their thumbnails remade",
                  rechecked.get("version") == after and len(rechecked.get("models", {})) >= n_models
                  and len(fresh) == len([r for r in rechecked.get("models", {}).values() if r.get("ok")]),
                  (rechecked.get("version"), after, len(rechecked.get("models", {})), n_models, len(fresh)))

            # 7. project-wide license; one item keeps its own
            other = f"gen:{v76}/gridfinity-baseplate"
            await pg.click(f'.results [data-item="{other}"]')
            await pg.click(".inspector [data-act=edit]")
            await pg.fill("#meta-license", "MIT")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.click("#source-more summary")
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
            await pg.wait_for_function(f"() => !!window.__workshop.catalog.sources.find((s) => s.id === '{v76}').icon", timeout=20000)
            await pg.click(".group-crumb .link-btn")
            tile = pg.locator(".group-tile", has_text=name).first
            await tile.wait_for()
            try:
                await tile.locator(".thumb > img").first.wait_for(timeout=10000)
            except Exception:
                pass
            check("condensed group shows its chosen icon", await tile.locator(".thumb > img").count() == 1)
            await pg.screenshot(path=str(out / "p2-05-condensed.png"))
            await pg.click("[data-condense]")
            await pg.select_option("select[aria-label=Group]", "none")

            # 8b. Condense with a selection (owner's report, 0.4.3): turning it on clears the selection and
            # groups by project; inside a group, arrow keys and Ctrl+A stay in it; turning it off goes back
            # to no grouping and keeps what was selected
            await pg.wait_for_selector(".results [data-item]")
            sel_q = "() => [...document.querySelectorAll('.results [data-item][aria-selected=true]')].map((e) => e.dataset.item)"
            first_ids = await pg.eval_on_selector_all(".results [data-item]", "els => els.slice(0, 3).map((e) => e.dataset.item)")
            await pg.click(f'.results [data-item="{first_ids[0]}"]')
            await pg.click(f'.results [data-item="{first_ids[2]}"]', modifiers=["Shift"])
            ranged = await pg.evaluate(sel_q)
            await pg.click("[data-condense]")
            await pg.wait_for_selector(".group-tile")
            on_group = await pg.eval_on_selector("select[aria-label=Group]", "e => e.value")
            on_empty = await pg.locator(".inspector .insp-empty").count() == 1
            # the biggest group, so arrow keys have room to run past it
            await pg.evaluate("""() => { const t = [...document.querySelectorAll('.group-tile[data-group]')].sort((a, b) => parseInt(b.querySelector('.card-sub').textContent) - parseInt(a.querySelector('.card-sub').textContent))[0]; t.click(); }""")
            await pg.wait_for_selector(".group-crumb")
            in_group = await pg.eval_on_selector_all(".results [data-item]", "els => els.map((e) => e.dataset.item)")
            await pg.click(f'.results [data-item="{in_group[0]}"]')
            for _ in range(len(in_group) + 5):
                await pg.keyboard.press("ArrowRight")
            walked = await pg.evaluate(sel_q)
            await pg.keyboard.press("Control+a")
            all_sel = await pg.evaluate(sel_q)
            keep = in_group[min(1, len(in_group) - 1)]
            await pg.click(f'.results [data-item="{keep}"]')
            await pg.click("[data-condense]")
            await pg.wait_for_selector(".results [data-item]")
            off_group = await pg.eval_on_selector("select[aria-label=Group]", "e => e.value")
            kept = await pg.evaluate(sel_q)
            insp = await pg.locator(".inspector .insp-empty").count() == 0
            check("Condense: on clears the selection and groups by project; arrow keys and Ctrl+A stay in an open group; off goes back to no grouping, keeping the selection",
                  len(ranged) == 3 and on_group == "project" and on_empty and walked == [in_group[-1]] and sorted(all_sel) == sorted(in_group)
                  and off_group == "none" and kept == [keep] and insp,
                  (len(ranged), on_group, on_empty, walked, in_group[-1], len(all_sel), len(in_group), off_group, kept, insp))
            await pg.screenshot(path=str(out / "p4-04-condense-off.png"))

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
            check("flagged as broken, with its note (counted in Library settings)", attn and note == "Lid too tight", note)
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
            await pg.click('[data-category="labels"] #category-move-to')
            await pg.click('.catpick-opt[data-cat="gridfinity"]')
            await pg.click('[data-category="labels"] [data-act=remove-confirm]')
            await pg.wait_for_selector('[data-category="labels"]', state="detached")
            left = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.category === 'labels').length")
            await pg.click(".ls-removed summary")
            await pg.click("[data-act=restore-category]")
            await pg.wait_for_selector('[data-category="labels"]')
            back = await pg.evaluate("() => window.__workshop.index.items.filter((i) => i.category === 'labels').length")
            check("categories: add, remove (items move), bring back", left == 0 and back >= 5, (left, back))
            # a picture of your own as a category's icon (the file dialog answered through /test/pick)
            icon_src = home / "kitchen.svg"
            icon_src.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f2b705"/></svg>')
            urllib.request.urlopen(urllib.request.Request(B + "test/pick", data=json.dumps({"path": str(icon_src)}).encode(), method="POST"))
            await pg.click('[data-category="kitchen"] [data-act=category-image]')
            await pg.wait_for_selector('[data-category="kitchen"] img.ls-cat-icon', timeout=30000)
            icon_ok = await pg.evaluate("""() => { const i = document.querySelector('[data-category="kitchen"] img.ls-cat-icon'); return !!i && i.complete && i.naturalWidth > 0; }""")
            check("a category icon from an image file, kept in the library", icon_ok and (library / "icons/category-kitchen.svg").is_file(), icon_ok)
            await pg.click("#ls-deleted [data-act=restore-item]")
            await pg.wait_for_function(f"() => !!window.__workshop.index.get('{del_id}')")
            check("a deleted item comes back from Library settings", True)
            await pg.click(f'[data-source="{ids["gears"]}"] [data-act=hide-project]')
            await pg.wait_for_function(f"() => window.__workshop.index.items.filter((i) => i.projectId === '{ids['gears']}').every((i) => i.hidden)")
            hidden_n = await pg.evaluate(f"() => window.__workshop.index.query({{ scope: {{ project: '{ids['gears']}' }} }}).total")
            await pg.click(f'[data-source="{ids["gears"]}"] [data-act=hide-project]')
            await pg.wait_for_function(f"() => window.__workshop.index.query({{ scope: {{ project: '{ids['gears']}' }} }}).total > 0")
            check("a hidden project hides everything in it", hidden_n == 0)
            # Edit… on a project's row: its details; long text stays inside the boxes (they grow), and a long folder path too
            long_tags = "a-very-long-tag-name-that-keeps-going, another-long-tag-for-wrapping, yet-another-tag-so-it-needs-three-lines, edited-from-library-settings"
            await pg.click(f'[data-source="{ids["gears"]}"] [data-act=edit-project]')
            await pg.wait_for_selector(".meta-editor #meta-save:not([disabled])")
            one_line = await pg.eval_on_selector("#meta-tags", "e => e.offsetHeight")
            await pg.fill("#meta-tags", long_tags)
            grown = await pg.eval_on_selector("#meta-tags", "e => e.offsetHeight") >= one_line + 15
            spill = await pg.evaluate(OVERFLOW)
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.wait_for_timeout(500)
            stored_tags = json.loads((library / f"sources/{ids['gears']}/metadata.json").read_text()).get("project", {}).get("tags")
            long_path = str(home / "a folder with a long name that keeps on going" / "and-another-folder-inside-it-with-no-spaces-at-all" / "project")
            urllib.request.urlopen(urllib.request.Request(B + "test/pick", data=json.dumps({"path": long_path}).encode(), method="POST"))
            await pg.click("#settings-add-project")
            await pg.click("[data-add-tab=folder]")
            await pg.click("#add-pick")
            await pg.wait_for_function("() => document.querySelector('#add-path')?.textContent.includes('project')")
            spill_path = await pg.evaluate(OVERFLOW)
            await pg.screenshot(path=str(out / "p3-04-long-path.png"))
            await pg.keyboard.press("Escape")
            await pg.wait_for_selector(".dialog", state="detached")
            check("Edit… in Library settings edits the project; long text stays inside its box (folder path, details)",
                  grown and not spill and not spill_path and "edited-from-library-settings" in (stored_tags or []), (grown, spill, spill_path, stored_tags))
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

            # 12. (0.4.3) the category picker lists every category even with one chosen, and makes new ones
            await pg.goto(B + f"#/browse/source/{ids['gears']}")
            await pg.wait_for_selector(".results [data-item]")
            await pg.locator(".results [data-item]").first.click()
            await pg.click(".inspector [data-act=edit]")
            await pg.wait_for_selector("#meta-save:not([disabled])")
            await pg.click("#meta-category")
            await pg.wait_for_selector(".catpick-pop")
            n_choices = await pg.evaluate("() => window.__workshop.catalog.category_choices.length")
            listed = await pg.eval_on_selector_all(".catpick-opt[data-cat]", "els => els.map((e) => e.dataset.cat)")
            await pg.screenshot(path=str(out / "p4-05-category-picker.png"))
            await pg.fill(".catpick-filter", "Garden tools")
            await pg.keyboard.press("Enter")
            shown_new = await pg.inner_text("#meta-category")
            picked_item = await pg.evaluate("() => document.querySelector('.results [data-item]').dataset.item")
            await pg.click("#meta-save")
            await pg.wait_for_selector(".dialog", state="detached")
            await pg.wait_for_function(f"() => window.__workshop.index.get('{picked_item}')?.category === 'garden-tools'", timeout=20000)
            made = await pg.evaluate("() => window.__workshop.catalog.category_choices.some((c) => c.id === 'garden-tools' && c.label === 'Garden tools')")
            cats_listed = [c for c in listed if c not in ("empty", "newprompt", "new")]
            check("category picker: every category listed with one chosen; a new one typed in is made",
                  len(cats_listed) == n_choices and "newprompt" in listed and "Garden tools" in shown_new and made, (len(cats_listed), n_choices, listed[-2:], shown_new, made))

            # 13. (0.4.3) Scan for changes: a file added to a project's stored copy, a new local/ project, a missing one
            await pg.goto(B + "#/library-settings")
            await pg.wait_for_selector("#library-rescan")
            gsrc = await pg.evaluate(f"() => window.__workshop.catalog.sources.find((s) => s.id === '{ids['gears']}')")
            (library / f"sources/{ids['gears']}/files/{gsrc['version']}/scan_extra.scad").write_text("size = 3; // [1:10]\ncube(size);\n")
            (library / "local/scanned").mkdir(parents=True, exist_ok=True)
            (library / "local/scanned/plate.scad").write_text("w = 20; // [5:50]\ncube([w, w, 2]);\n")
            await pg.click("#library-rescan")
            try:
                await pg.wait_for_function(f"() => window.__workshop.index.get('gen:{ids['gears']}/scan-extra') && window.__workshop.index.get('gen:local-scanned/plate')", timeout=180000)
            except Exception:
                pass
            seen = await pg.evaluate(f"() => [!!window.__workshop.index.get('gen:{ids['gears']}/scan-extra'), !!window.__workshop.index.get('gen:local-scanned/plate')]")
            toast1 = await pg.eval_on_selector_all(".toast", "els => els.map((e) => e.textContent).join(' | ')")
            shutil.rmtree(library / "local/scanned")
            # (a click while another scan runs, one started when the window got focus, only waits for that
            # one, whose message doesn't mention the folder: click again until a scan of our own reports it)
            for _ in range(3):
                await pg.click("#library-rescan")
                try:
                    await pg.wait_for_function("() => window.__workshop.catalog.attention.some((a) => a.kind === 'missing-folder' && a.source === 'local-scanned')"
                                               " && document.querySelector('#toast')?.textContent.includes('missing')", timeout=30000)
                    break
                except Exception:
                    pass
            missing = await pg.evaluate("() => window.__workshop.catalog.attention.some((a) => a.kind === 'missing-folder' && a.source === 'local-scanned')")
            toast2 = await pg.eval_on_selector_all(".toast", "els => els.map((e) => e.textContent).join(' | ')")
            # (0.4.4) no Needs attention: a project's problems are marked in Library settings › Projects, beside its license
            await pg.wait_for_selector('[data-source="local-scanned"] [data-problem="missing-folder"]', timeout=30000)
            marked = await pg.locator('[data-source="local-scanned"] [data-problem="missing-folder"]').count()
            check("Scan for changes: a file added to a stored copy and a new local/ project are read; a folder gone is marked in Library settings",
                  all(seen) and missing and marked == 1 and "missing" in toast2, (seen, missing, marked, toast1, toast2))
            lic = await pg.eval_on_selector_all("#ls-project-table td.ls-license", "els => els.map((e) => e.textContent.trim())")
            nav_attn = await pg.locator(".sidebar .nav-attention").count()
            check("Library settings lists each project's license (one not cleared is marked), and the menu has no Needs attention",
                  len(lic) >= 3 and any("Check license" in t or "License unclear" in t for t in lic) and nav_attn == 0, (lic[:6], nav_attn))
            await pg.click('[data-source="local-scanned"] [data-act=delete-project]')

            # 13b. (0.4.6) defaults that work: a number without a Customizer comment whose default is a
            # fraction is accepted at its default (Gridfinity Anylid's width units, 1.5); a default off its
            # slider's step is reported; every model is rendered once at its defaults (with its thumbnail)
            # and one that fails is marked in Library settings and on its page, with OpenSCAD's message
            await pg.goto(B + "#/m/anylid/lid")
            await pg.wait_for_selector("#p-Width_Units")
            invalid = await pg.evaluate("() => [...document.querySelectorAll('.field input')].filter((i) => !i.checkValidity()).map((i) => i.id)")
            check("Gridfinity Anylid opens with no setting marked invalid at its defaults (1.5 and 2.5 units)", not invalid, invalid)
            (library / "local/defaults").mkdir(parents=True, exist_ok=True)
            (library / "local/defaults/tray.scad").write_text("// width in grid units\nunits = 1.5;\n// height\nheight = 2.5; // [0:1:10]\ncube([units * 42, 42, height]);\n")
            (library / "local/defaults/broken.scad").write_text("size = 10;\nassert(size < 5, \"size must be under 5\");\ncube(size);\n")
            await pg.goto(B + "#/library-settings")
            await pg.wait_for_selector("#library-rescan")
            await pg.click("#library-rescan")
            checks_file = library / "sources/local-defaults/checks.json"
            for _ in range(240):
                if checks_file.is_file() and len(json.loads(checks_file.read_text()).get("models", {})) >= 2:
                    break
                await pg.wait_for_timeout(500)
            checks = json.loads(checks_file.read_text()) if checks_file.is_file() else {}
            got = {k: (v.get("ok"), v.get("message") or "") for k, v in checks.get("models", {}).items()}
            try:
                await pg.wait_for_selector('[data-source="local-defaults"] [data-problem="render"]', timeout=30000)
            except Exception:
                pass
            marks = await pg.eval_on_selector_all('[data-source="local-defaults"] [data-problem]', "els => els.map((e) => [e.dataset.problem, e.title])")
            check("each model is rendered at its defaults when it's added; results kept in checks.json; failures and settings off their limits marked in Library settings",
                  got.get("tray", (None,))[0] is True and got.get("broken", (None, ""))[0] is False and "size must be under 5" in got["broken"][1]
                  and any(k == "render" and "size must be under 5" in t for k, t in marks) and any(k == "limits" and "Height" in t for k, t in marks),
                  (got, marks))
            await pg.goto(B + "#/m/local-defaults/broken")
            await pg.wait_for_selector("#model-title")
            alert = await pg.locator("#default-check").inner_text() if await pg.locator("#default-check").count() else ""
            title = [await pg.inner_text("#model-title"), await pg.inner_text("#model-project")]
            await pg.screenshot(path=str(out / "p6-01-default-check.png"))
            check("a model that didn't render at its defaults says so on its page, with OpenSCAD's message; the page has the model's own name, its project under it",
                  "size must be under 5" in alert and title == ["Broken", "Defaults"], (alert, title))
            await pg.goto(B + "#/browse/source/local-defaults")
            await pg.click("#source-more summary")
            await pg.click("[data-act=check-defaults]")
            try:
                await pg.wait_for_function("() => /didn't render/.test(document.querySelector('#toast')?.textContent || '')", timeout=60000)
            except Exception:
                pass
            toast = await pg.inner_text("#toast")
            check("Check defaults (project ⋯ menu) renders every model again and says how many failed", "1 model of 2" in toast.lower(), toast)  # (the Drafting Sheet's status bar is in capitals)
            # 13c. (0.4.7) one project description: workshop.json beside every project's files; Save as project
            # file writes one into your own project's folder; a project's own workshop.json says what its models are
            await pg.click("#source-more summary")
            await pg.click("[data-act=save-project-file]")
            own = library / "local/defaults/workshop.json"
            for _ in range(40):
                if own.is_file():
                    break
                await pg.wait_for_timeout(250)
            saved = json.loads(own.read_text()) if own.is_file() else {}
            # (saving changed the project's files: its models' thumbnails are made again in the background;
            # let that finish so it doesn't load a model the edit below removes)
            await pg.wait_for_selector(".status-idle", timeout=180000)
            beside = (library / "sources/local-defaults/workshop.json").is_file()
            saved["category"] = "labels"
            saved["models"] = [dict(m, name="Grid tray") for m in saved.get("models", []) if m.get("id") == "tray"]
            own.write_text(json.dumps(saved, indent=2))
            await pg.goto(B + "#/library-settings")
            await pg.click("#library-rescan")
            try:
                await pg.wait_for_function("() => window.__workshop.index.get('gen:local-defaults/tray')?.name === 'Grid tray' && !window.__workshop.index.get('gen:local-defaults/broken')", timeout=120000)
            except Exception:
                pass
            tray = await pg.evaluate("() => { const t = window.__workshop.index.get('gen:local-defaults/tray'); return t && [t.name, t.category]; }")
            gone = await pg.evaluate("() => !window.__workshop.index.get('gen:local-defaults/broken')")
            origins = {json.loads(p.read_text()).get("origin", {}).get("type") for p in (library / "sources").glob("*/source.json")}
            versions_ok = all(v.get("files") and v.get("content") for p in (library / "sources").glob("*/source.json")
                              for s in [json.loads(p.read_text())] if s["kind"] in ("github", "local") for v in s["versions"] if v["id"] == s["version"])
            check("workshop.json: written beside every project's files; Save as project file writes your project's; its models, names and category are used when it's read; every project records where it came from and its version's files the same way",
                  [m.get("id") for m in json.loads(own.read_text()).get("models", [])] == ["tray"] and beside and tray == ["Grid tray", "labels"] and gone
                  and None not in origins and versions_ok, (beside, tray, gone, origins, versions_ok))
            await pg.goto(B + "#/library-settings")
            await pg.click('[data-source="local-defaults"] [data-act=delete-project]')

            # 13d. (0.4.8) a project from a ZIP and one linked to a folder outside the library are kept the
            # same way as the others (Review 3 compares them); the Settings page is laid out like Library
            # settings; a yes/no setting's box is in the value column; the library's README explains the
            # folders that differ
            outside = home / "outside"
            (outside / "zipped").mkdir(parents=True, exist_ok=True)
            (outside / "zipped/peg.scad").write_text("// Peg length\nlength = 20; // [5:1:60]\ncylinder(d=6, h=length, $fn=24);\n")
            (outside / "zipped/hook.scad").write_text("// Hook depth\ndepth = 12; // [4:1:30]\ncube([6, depth, 6]);\n")
            zip_path = Path(shutil.make_archive(str(outside / "pegs"), "zip", outside / "zipped"))
            (outside / "linked shelf").mkdir(parents=True, exist_ok=True)
            (outside / "linked shelf/shelf.scad").write_text("// Shelf width\nwidth = 80; // [40:5:200]\ncube([width, 30, 4]);\n")
            added = {}
            for tab, pick in (("zip", zip_path), ("folder", outside / "linked shelf")):
                await pg.goto(B + "#/")
                await pg.click("#add-project")
                await pg.click(f"[data-add-tab={tab}]")
                urllib.request.urlopen(urllib.request.Request(B + "test/pick", data=json.dumps({"path": str(pick)}).encode(), method="POST"))
                await pg.click("#add-pick")
                await pg.wait_for_function("(p) => document.querySelector('#add-path')?.textContent === p", arg=str(pick))
                if tab == "folder" and not await pg.is_checked("#add-link"):
                    await pg.check("#add-link")
                await pg.click("#add-go")
                await pg.wait_for_function("() => location.hash.includes('/source/')", timeout=180000)
                await pg.wait_for_selector(".source-panel")
                added[tab] = [(await pg.evaluate("location.hash")).split("/source/")[1], await pg.locator("#toast").text_content() or ""]
            zid, lid = added["zip"][0], added["folder"][0]
            for _ in range(240):   # (each model's check is written just before its thumbnail)
                if len(list((library / f"sources/{zid}/thumbs").glob("*.webp"))) >= 2 and len(list((library / f"sources/{lid}/thumbs").glob("*.webp"))) >= 1:
                    break
                await pg.wait_for_timeout(500)
            shapes = {}
            for t, i in (("zip", zid), ("linked", lid)):
                sj = json.loads((library / f"sources/{i}/source.json").read_text())
                cur = next((v for v in sj.get("versions", []) if v["id"] == sj.get("version")), {})
                d = library / f"sources/{i}"
                shapes[t] = [sj.get("origin", {}).get("type"), bool(cur.get("files") and cur.get("content") and cur.get("added")), (d / "workshop.json").is_file(),
                             (d / "checks.json").is_file(), len(list((d / "thumbs").glob("*.webp"))) if (d / "thumbs").is_dir() else 0]
            check("a ZIP project and a project linked to a folder are kept like the others: where it came from, its version's files, workshop.json, checks and thumbnails",
                  shapes == {"zip": ["zip", True, True, True, 2], "linked": ["linked", True, True, True, 1]}
                  and "2 models" in added["zip"][1] and "1 model" in added["folder"][1], (shapes, added))
            await pg.goto(B + "#/settings")
            await pg.wait_for_selector("#ls-appearance")
            toc = await pg.eval_on_selector_all("#about-body .ls-toc a", "els => els.map((e) => e.textContent)")
            await pg.goto(B + "#/m/anylid/lid")
            await pg.wait_for_selector("#p-Mirror_X")
            cols = await pg.evaluate("() => ['#p-Mirror_X', '#p-Width_Units'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().left))")
            readme = (library / "README.txt").read_text()
            check("Settings is laid out like Library settings; a yes/no setting's box is in the value column; the library's README explains pins, your own projects and old versions",
                  toc[:4] == ["Appearance", "Printer profile", "Library", "Engine"] and abs(cols[0] - cols[1]) <= 2
                  and "sources/pinned/pins/" in readme and "Remove versions not in use" in readme, (toc, cols))

            # 13e. (0.4.9, F-1) the starter projects that are on GitHub as the app had them become GitHub projects
            # at the same commit, in upstream's own layout: same model ids, saved settings' code edits moved to
            # the new paths, thumbnails kept, update checks possible; the others stay as they are
            on_github = ["cullenect-label", "gridfinity-basket", "gridfinity-extended", "gridfinity-rebuilt", "label-generator-gridfinity", "underware"]
            def model_ids(i):
                sj = json.loads((library / f"sources/{i}/source.json").read_text())
                d = library / f"sources/{i}/derived/{sj['version']}.json"
                return sorted(m["id"] for m in json.loads(d.read_text())["models"]) if d.is_file() else []
            ids_before = {i: model_ids(i) for i in on_github}
            thumbs_before = {i: len(list((library / f"sources/{i}/thumbs").glob("*.webp"))) for i in on_github}
            (library / "recipes/f1-edit.json").write_text(json.dumps({"id": "f1-edit", "model": "gridfinity-basket/basket", "name": "Edited basket", "values": {},
                "edits": {"/vendor/gridfinity-basket/gridfinityBasket.scad": {"text": "// edited\n", "base": "0" * 64}}}))
            await pg.goto(B + "#/library-settings")
            await pg.wait_for_selector("#starter-convert")
            offer = await pg.inner_text("#starter-convert")
            # (0.4.10, F-13) models of projects from before the app checked new ones are offered a check at their defaults
            unchecked = await pg.inner_text("#unchecked-offer") if await pg.locator("#unchecked-offer").count() else ""
            await pg.click("#starter-convert button")
            try:
                await pg.wait_for_function("() => !document.querySelector('#starter-convert')", timeout=900000)
            except Exception:
                pass
            toast = await pg.locator("#toast").text_content() or ""
            conv, old_copy = {}, {}
            for i in on_github:
                sj = json.loads((library / f"sources/{i}/source.json").read_text())
                d = library / f"sources/{i}/derived/{sj['version']}.json"
                # (0.4.10, F-16) the app's old copy is removed when upstream's files are the same, else it says what it was
                was = sj.get("origin", {}).get("converted", {}).get("version", "")
                old_v = [v for v in sj.get("versions", []) if v.get("id") == was]
                old_copy[i] = "removed" if not old_v and not (library / f"sources/{i}/files/{was}").exists() else (old_v[0].get("message", "") if old_v else "?")
                conv[i] = [sj["kind"], sj.get("origin", {}).get("track", "")[:7], json.loads(d.read_text()).get("described_by") if d.is_file() else None,
                           model_ids(i) == ids_before[i], len(list((library / f"sources/{i}/thumbs").glob("*.webp"))) == thumbs_before[i]]
            print("the app's old copies:", old_copy)
            edit_keys = list(json.loads((library / "recipes/f1-edit.json").read_text())["edits"])
            others = {json.loads((library / f"sources/{i}/source.json").read_text())["kind"] for i in ("hsw", "gridflock", "anylid")}
            await pg.goto(B + "#/m/gridfinity-basket/basket")
            try:
                await pg.wait_for_function("() => /\\d/.test(document.querySelector('.hud-dims')?.textContent || '')", timeout=180000)
            except Exception:
                pass
            dims = await pg.inner_text(".hud-dims")
            await pg.screenshot(path=str(out / "p6-03-from-github.png"))
            check("starter projects on GitHub become GitHub projects at the same commit (same models, edits moved to upstream's paths, thumbnails kept); the others stay as they are",
                  "Gridfinity Rebuilt" in offer and "checked at their default settings" in unchecked
                  and all(v == "removed" or v.startswith("The app's copy of") for v in old_copy.values())
                  and all(v == ["github", "branch:", "description.json", True, True] for v in conv.values())
                  and edit_keys == ["/gridfinityBasket.scad"] and others == {"bundled"} and "mm" in dims, (conv, old_copy, edit_keys, others, dims, toast, unchecked[:120]))

            # 13f. (0.4.9) suggested projects (catalog/suggested.json) under Add project, less the ones already
            # in the library; adding one is the ordinary Add from GitHub, and its models are checked at their defaults
            await pg.goto(B + "#/")
            await pg.click("#add-project")
            await pg.wait_for_selector("#add-suggested")
            chips = await pg.eval_on_selector_all("#add-suggested [data-suggested]", "els => els.map((e) => e.dataset.suggested)")
            await pg.click('#add-suggested [data-suggested="LEGO.scad"]')
            facts = await pg.text_content("#add-suggested-facts")   # (0.4.10, UI-23) what adding it brings
            await pg.click("#add-go")
            await pg.wait_for_function("() => location.hash.includes('/source/')", timeout=180000)
            lego = (await pg.evaluate("location.hash")).split("/source/")[1]
            lego_models, lego_checks = [], {}
            for _ in range(600):
                sj = json.loads((library / f"sources/{lego}/source.json").read_text())
                d = library / f"sources/{lego}/derived/{sj['version']}.json"
                lego_models = [m["id"] for m in json.loads(d.read_text())["models"]] if d.is_file() else []
                c = library / f"sources/{lego}/checks.json"
                lego_checks = json.loads(c.read_text()).get("models", {}) if c.is_file() else {}
                if "lego" in lego_checks:   # (its 180 examples are checked too, in the background)
                    break
                await pg.wait_for_timeout(500)
            failing = {m: v.get("message", "")[:120] for m, v in lego_checks.items() if not v.get("ok")}
            print("LEGO.scad at its defaults:", len(lego_models), "models,", len(failing), "failing", failing)
            check("suggested projects under Add project leave out the ones already added; adding one reads it and checks every model at its defaults",
                  chips == ["LEGO.scad"] and "182 models" in facts and "License MIT" in facts
                  and "lego" in lego_models and lego_checks.get("lego", {}).get("ok"), (chips, facts, len(lego_models), failing))

            # 13g. (0.4.11, milestone 4) Save as part keeps what's made in the Parts Library (local/Made parts/<model>/)
            # with a recipe; its page opens the model with those settings or makes it again, and says when
            # the model's project has changed since
            await pg.goto(B + "#/m/local-bevel/bevel-gear")
            await pg.wait_for_function("()=>document.body.dataset.model==='local-bevel/bevel-gear'")
            await pg.wait_for_function(DONE, timeout=300000)
            await pg.click("#save-part")
            await pg.fill("#save-part-name", "Test gear")
            await pg.click("#save-part-save")
            toast_js = "(t)=>{const e=document.querySelector('#toast');return e&&!e.hidden&&e.textContent.includes(t)}"
            await pg.wait_for_function(toast_js, arg="Parts Library", timeout=120000)
            made = list((library / "local" / "Made parts").glob("*/Test gear.stl"))
            recipe_path = made[0].with_name("Test gear.recipe.json") if made else None
            recipe = json.loads(recipe_path.read_text()) if recipe_path and recipe_path.is_file() else {}
            await pg.click("#toast .ghost")
            await pg.wait_for_selector("#made-from", timeout=20000)
            made_text = await pg.inner_text("#made-from")
            cats = await pg.evaluate("""() => { const i = window.__workshop.index.items;
                const part = i.find((x) => x.kind === 'part' && x.madeFrom?.model === 'local-bevel/bevel-gear');
                return [part?.category, i.find((x) => x.id === 'gen:local-bevel/bevel-gear')?.category] }""")
            check("Save as part writes the part and its recipe; the part is in the Parts Library in its model's category, saying what it was made from",
                  len(made) == 1 and recipe.get("model") == "local-bevel/bevel-gear" and "Made from" in made_text
                  and cats[0] and cats[0] == cats[1], (made, recipe.get("model"), made_text, cats))
            part_hash = await pg.evaluate("location.hash")
            # the project changes after the part was made: its page says so, and Make again brings it up to date
            recipe["project_version"] = "an-older-version"
            recipe_path.write_text(json.dumps(recipe))
            before = made[0].stat().st_mtime_ns
            await pg.evaluate("import('/ui/library.js').then(async (m) => { await m.rescanLocal(false); await m.rescanLocal(false); })")  # (the second: after any scan already running)
            await pg.wait_for_function("(h)=>location.hash===h && /updated since/.test(document.querySelector('#made-from')?.textContent || '')", arg=part_hash, timeout=30000)
            await pg.click("#made-again")
            await pg.wait_for_function(toast_js, arg="Made Test gear again", timeout=300000)
            again = json.loads(recipe_path.read_text())
            check("Make again replaces the part's file and brings its recipe up to the project's version",
                  again.get("project_version") not in (None, "an-older-version") and made[0].stat().st_mtime_ns != before
                  and len(list(made[0].parent.glob("*.stl"))) == 1, (again.get("project_version"), list(made[0].parent.iterdir())))
            await pg.goto(B + part_hash)
            await pg.wait_for_selector("#made-open", timeout=20000)
            await pg.click("#made-open")
            await pg.wait_for_function("()=>document.body.dataset.model==='local-bevel/bevel-gear' && location.hash==='#/m/local-bevel/bevel-gear'")
            await pg.wait_for_function(DONE, timeout=300000)
            check("Open with these settings opens the model and makes it", "matches" in await pg.inner_text("#status"))

            # 14. (0.4.3) back up the library to a ZIP, then restore it as a new library
            backup = home / "backups" / "library backup.zip"
            backup.parent.mkdir(parents=True, exist_ok=True)
            await pg.goto(B + "#/library-settings")
            await pg.wait_for_selector("#backup-leave-out")
            urllib.request.urlopen(urllib.request.Request(B + "test/pick", data=json.dumps({"path": str(backup)}).encode(), method="POST"))
            await pg.click("#backup-leave-out")
            await pg.click("#library-backup")
            for _ in range(600):
                if backup.is_file():
                    break
                await pg.wait_for_timeout(500)
            import zipfile
            names = zipfile.ZipFile(backup).namelist() if backup.is_file() else []
            thumbs_in = any("/thumbs/" in n for n in names)
            check("Back up library: one ZIP of the library folder, without thumbnails when asked",
                  "library.json" in names and any(n.startswith("recipes/") for n in names) and any(n.startswith("sources/") for n in names) and not thumbs_in,
                  (len(names), thumbs_in))
            n_sources = await pg.evaluate("() => window.__workshop.catalog.sources.length")
            restored_dir = home / "restored library"
            for pick in (backup, restored_dir):
                urllib.request.urlopen(urllib.request.Request(B + "test/pick", data=json.dumps({"path": str(pick)}).encode(), method="POST"))
            await pg.click("#library-restore")
            try:
                await pg.wait_for_function(f"() => window.__workshop?.catalog?.library?.path?.includes('restored library')", timeout=180000)
            except Exception:
                pass
            await pg.wait_for_function("() => !!window.__workshop?.catalog", timeout=60000)
            r_path = await pg.evaluate("() => window.__workshop.catalog.library?.path")
            r_sources = await pg.evaluate("() => window.__workshop.catalog.sources.length")
            check("Restore from backup: a new library folder, opened, with the same projects",
                  (restored_dir / "library.json").is_file() and "restored library" in (r_path or "") and r_sources == n_sources, (r_path, r_sources, n_sources))
            await pg.screenshot(path=str(out / "p4-06-restored.png"))
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
