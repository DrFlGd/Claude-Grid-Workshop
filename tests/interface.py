#!/usr/bin/env python3
"""Check the library interface in Chromium: views, search, filters, inspector,
quick look, command palette, tabs, the side viewer (code, README), favourites,
themes and phone width.

    python3 -m http.server -d _site 8000 &
    python3 tests/interface.py --base http://localhost:8000/ --out shots

Exits non-zero if a check fails or the page logs a script error. Screenshots go
to <out>/ui-*.png.
"""
import argparse
import asyncio
import json
import re
import sys
import urllib.request

from playwright.async_api import async_playwright

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{' :: ' + str(detail) if detail != '' else ''}", flush=True)


async def items(pg):
    return await pg.locator(".results [data-item]").count()


async def search(pg, q):
    """Type a search; return (result count, reported ms, first result names)."""
    await pg.fill("#global-search", q)
    await pg.wait_for_function("()=>/ms$/.test(document.querySelector('.browse-count')?.textContent || '')")
    text = await pg.inner_text(".browse-count")
    ms = re.search(r"([<\d.]+) ms", text).group(1)
    names = await pg.eval_on_selector_all(".results [data-item]", "els=>els.slice(0,5).map(e=>e.dataset.item)")
    return int(text.split()[0]), (0.5 if ms.startswith("<") else float(ms)), names


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000/")
    ap.add_argument("--out", default="shots")
    a = ap.parse_args()
    import os
    os.makedirs(a.out, exist_ok=True)
    catalog = json.load(urllib.request.urlopen(a.base + "data/catalog.json"))
    gens = [m for m in catalog["models"] if m.get("browser") is not False]
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        # missing files (404) count; network failures (net::ERR_..., e.g. web fonts offline) don't
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "net::ERR_" not in m.text else None)

        # home
        await pg.goto(a.base)
        await pg.wait_for_selector(".home .tile")
        check("home shows browse tiles", await pg.locator(".home .tile").count() >= len(catalog["categories"]))
        await pg.screenshot(path=f"{a.out}/ui-00-home.png")

        # all parametric models, four views
        await pg.click('.sidebar [data-scope="all"]')
        await pg.wait_for_selector(".results [data-item]")
        n = await items(pg)
        check("all parametric models listed", n == len(gens), f"{n} of {len(gens)}")
        thumbs = await pg.locator(".results .card img").count()
        check("models have thumbnails", thumbs == n, f"{thumbs} of {n}")
        for layout in ["grid", "list", "table", "grouped"]:
            await pg.click(f'button[data-layout="{layout}"]')
            await pg.wait_for_selector(f'.results[data-layout="{layout}"] [data-item]')
            got = await items(pg)
            check(f"{layout} view shows every item", got == n, got)
            await pg.screenshot(path=f"{a.out}/ui-01-{layout}.png")
        await pg.click('button[data-layout="table"]')
        await pg.click('.th-btn:has-text("Updated")')
        first = await pg.eval_on_selector_all(".table-view tbody tr[data-item]", "rs=>rs.slice(0,3).map(r=>r.dataset.item)")
        dates = [m.get("updated") or "" for m in gens]
        newest = max(dates)
        check("table sorts by updated date", first and next(m for m in gens if f"gen:{m['key']}" == first[0]).get("updated") == newest, first)
        await pg.click('button[data-layout="grid"]')
        await pg.select_option('select[aria-label="Sort"]', "default")  # the sort is remembered; searches below want best match

        # the parts library
        parts = 0
        for lib in catalog.get("libraries", []):
            parts += len(json.load(urllib.request.urlopen(a.base + f"data/libraries/{lib['id']}.json"))["items"])
        await pg.click('.sidebar [data-scope="parts"]')
        await pg.wait_for_function(f"()=>document.querySelectorAll('.results [data-item^=\"part:\"]').length === {parts}")
        check("all parts listed", True, parts)
        await pg.locator(".results [data-item]").first.click()
        await pg.wait_for_selector(".inspector .insp-files a")
        check("a part's inspector offers its files", True, await pg.locator(".inspector .insp-files a").count())
        await pg.screenshot(path=f"{a.out}/ui-01-parts.png")
        await pg.click('.sidebar [data-scope="all"]')
        await pg.wait_for_selector('.results [data-item^="gen:"]')

        # the left menu: Parametric Models and the Parts Library; the section being browsed shows its
        # categories (projects inside, collapsed) in a panel beside the menu, which folds away
        sections = await pg.eval_on_selector_all(".sidebar [data-section-row] .nav-label", "els => els.map(e => e.textContent.trim())")
        cats = await pg.locator('.catpanel [data-section="generator"] [data-scope^="cat:"]').count()
        projs = await pg.locator('.catpanel [data-scope^="project:"]').count()
        await pg.click('.sidebar [data-scope="parts"]')
        await pg.wait_for_selector('.catpanel [data-section="part"] [data-scope^="pcat:"]')
        pcats = await pg.locator('.catpanel [data-section="part"] [data-scope^="pcat:"]').count()
        check("left menu: models and parts; their categories beside it, collapsed", sections[:2] == ["Parametric Models", "Parts Library"] and cats >= 4 and pcats >= 1 and projs == 0,
              (sections, cats, pcats, projs))
        await pg.click('.catpanel [data-section="part"] .nav-toggle >> nth=0')
        await pg.wait_for_selector('.catpanel [data-scope^="lib:"]')
        await pg.click('.catpanel [data-scope^="lib:"] >> nth=0')
        await pg.wait_for_selector('.results [data-item^="part:"]')
        check("a parts category opens to its projects", await items(pg) > 0, await pg.inner_text(".browse-title h1"))
        await pg.click('.catpanel [data-section="part"] .nav-toggle >> nth=0')
        await pg.click("#catpanel-toggle")
        await pg.wait_for_selector(".catpanel.folded")
        await pg.click("#catpanel-toggle")
        await pg.wait_for_selector('.catpanel:not(.folded) [data-scope^="pcat:"]')
        check("the category panel folds away and comes back", True)
        await pg.click('.sidebar [data-scope="all"]')
        await pg.wait_for_selector('.results [data-item^="gen:"]')

        # Condense, with no grouping chosen, groups by project: one tile per project
        await pg.click("[data-condense]")
        await pg.wait_for_selector(".group-tile")
        check("Condense groups by project", await pg.input_value('select[aria-label="Group"]') == "project")
        tiles = await pg.locator(".group-tile").count()
        families = len({m["family"] for m in gens})
        check("condensed groups: one tile per project", tiles == families, f"{tiles} tiles, {families} projects")
        await pg.screenshot(path=f"{a.out}/ui-01-condensed.png")
        await pg.locator(".group-tile").first.click()
        await pg.wait_for_selector(".group-crumb")
        inside = await items(pg)
        check("opening a group shows its items", 0 < inside < n, inside)
        await pg.click(".group-crumb .link-btn")
        await pg.wait_for_selector(".group-tile")
        await pg.click("[data-condense]")
        await pg.select_option('select[aria-label="Group"]', "none")
        await pg.wait_for_selector('.results [data-item^="gen:"]')

        # filters
        await pg.click('[data-filter="updated"]')
        opts = await pg.locator('.filter-panel[aria-label="Updated"] .filter-opt').all_inner_texts()
        check("Updated filter lists date ranges", len(opts) >= 1, opts)
        await pg.locator('.filter-panel[aria-label="Updated"] input').first.check()
        filtered = await items(pg)
        expect = int(opts[0].split()[-1])
        check("Updated filter narrows results to its count", filtered == expect, f"{filtered} vs {expect}")
        await pg.click('.filter-panel[aria-label="Updated"] .link-btn')  # Clear
        await pg.keyboard.press("Escape")
        await pg.wait_for_selector('.filter-panel[aria-label="Updated"]', state="detached")
        check("Escape closes a filter menu", await items(pg) == n)

        # search: relevance, typos, typed filters, speed
        cases = [("label", lambda ids: any("label" in i for i in ids[:3])),
                 ("baseplte", lambda ids: any("baseplate" in i for i in ids[:3])),         # one typo
                 ("cog", lambda ids: True),                                                 # synonym; may be empty
                 ("project:underware channel", lambda ids: all(i.startswith("gen:underware/") for i in ids)),
                 ("rugged box", lambda ids: ids and ids[0].startswith("gen:gridfinity-rugged-box/"))]
        worst = 0
        for q, ok in cases:
            count, ms, ids = await search(pg, q)
            worst = max(worst, ms)
            check(f"search “{q}”", ok(ids), f"{count} results, {ms} ms, top {ids[:3]}")
        check("search answers in under 100 ms", worst < 100, f"slowest {worst} ms")
        await pg.screenshot(path=f"{a.out}/ui-02-search.png")

        # inspector and quick look
        await search(pg, "cullenect")
        card = pg.locator(".results [data-item]").first
        item_id = await card.get_attribute("data-item")
        await card.click()
        await pg.wait_for_selector(f'.inspector[data-item="{item_id}"]')
        check("inspector shows the selection", await pg.locator(".inspector .insp-title").inner_text() != "")
        await pg.keyboard.press(" ")
        await pg.wait_for_selector(".quicklook-backdrop:not([hidden]) .ql-dims", timeout=120000)
        check("quick look renders the default model", True, await pg.inner_text(".ql-dims"))
        await pg.screenshot(path=f"{a.out}/ui-03-quicklook.png")
        await pg.keyboard.press(" ")
        await pg.wait_for_selector(".quicklook-backdrop[hidden]", state="attached")
        check("Space closes quick look", True)

        # favourites
        await pg.locator(f'.results [data-item="{item_id}"]').focus()
        await pg.keyboard.press("f")
        await pg.click('.sidebar [data-scope="favs"]')
        await pg.wait_for_selector(".results [data-item]")
        check("favourite shows under Favourites", await pg.locator(f'.results [data-item="{item_id}"]').count() == 1)

        # command palette opens a generator in a tab
        await pg.keyboard.press("Control+k")
        await pg.fill(".palette input", "rebuilt bin")
        await pg.wait_for_selector(".palette-row")
        await pg.keyboard.press("Enter")
        await pg.wait_for_function("()=>document.body.dataset.model === 'gridfinity-rebuilt/bin'", timeout=30000)
        check("palette opens a generator", True)
        await pg.goto(f"{a.base}#/m/gridfinity-rebuilt/baseplate")
        await pg.wait_for_function("()=>document.body.dataset.model === 'gridfinity-rebuilt/baseplate'", timeout=30000)
        tabs = await pg.locator(".tabstrip [data-tab]").count()
        check("each opened generator gets a tab", tabs >= 2, tabs)
        await pg.fill("#p-gridx", "3")
        await pg.click('.tabstrip [data-tab="gridfinity-rebuilt/bin"]')
        await pg.wait_for_function("()=>document.body.dataset.model === 'gridfinity-rebuilt/bin'", timeout=30000)
        await pg.click('.tabstrip [data-tab="gridfinity-rebuilt/baseplate"]')
        await pg.wait_for_function("()=>document.body.dataset.model === 'gridfinity-rebuilt/baseplate'", timeout=30000)
        kept = await pg.input_value("#p-gridx")
        check("a tab keeps its unsaved settings", kept == "3", kept)
        await pg.screenshot(path=f"{a.out}/ui-04-tabs.png")
        # the side viewer: the model's OpenSCAD code and its project's README, in a panel on the right
        await pg.click("#model-extra [data-side-open=code]")
        await pg.wait_for_selector(".side-panel[data-side-panel=code] .code .cl")
        lines = await pg.locator(".side-panel .code .cl").count()
        files = await pg.locator("#side-file option").count()
        await pg.click("[data-side-tab=readme]")
        await pg.wait_for_selector(".side-panel[data-side-panel=readme] .doc-frame")
        await pg.wait_for_function("() => document.querySelector('.doc-frame')?.contentDocument?.querySelector('h1')")
        h1 = await pg.frame_locator(".doc-frame").locator("h1").first.inner_text()
        await pg.screenshot(path=f"{a.out}/ui-08-side-readme.png")
        await pg.click("[data-side-tab=readme]")
        await pg.wait_for_selector(".side-panel", state="detached")
        check("side viewer: the model's code and its project's README, folding away", lines > 20 and files > 1 and "Gridfinity" in h1, (lines, files, h1))
        await pg.click('.tabstrip [data-tab="gridfinity-rebuilt/baseplate"] .tab-close')
        await pg.wait_for_function("()=>!document.querySelector('.tabstrip [data-tab=\"gridfinity-rebuilt/baseplate\"]')")
        check("closing a tab removes it", True)
        await pg.click(".tabstrip .tab-lib")
        await pg.wait_for_selector(".results [data-item], .home")

        # themes: the button cycles light -> dark -> night -> light
        seen = []
        await pg.click('.sidebar [data-scope="all"]')
        await pg.wait_for_selector(".results [data-item]")
        for _ in range(3):
            await pg.click("#theme-toggle")
            theme = await pg.evaluate("document.documentElement.dataset.theme")
            seen.append(theme)
            if theme != "light":
                await pg.screenshot(path=f"{a.out}/ui-05-{theme}.png")
        check("theme button cycles dark, night, light", seen == ["dark", "night", "light"], seen)
        bg = {}
        for theme in ["light", "dark", "night"]:
            await pg.evaluate(f"document.documentElement.dataset.theme = '{theme}'")
            bg[theme] = await pg.evaluate("getComputedStyle(document.body).backgroundColor")
        check("each theme has its own background", len(set(bg.values())) == 3, bg)

        # licenses page and settings still reachable
        await pg.click('.sidebar a[href="#/licenses"]')
        await pg.wait_for_selector("#view-about:not([hidden])")
        check("licenses page opens from the sidebar", "Preact" in await pg.inner_text("#view-about"))

        # phone width: drawer sidebar, a tap opens the item
        m = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        m.on("pageerror", lambda e: errors.append(str(e)))
        await m.goto(a.base)
        await m.wait_for_selector(".home .tile")
        await m.click(".nav-burger")
        await m.wait_for_selector(".sidebar.open")
        await m.wait_for_timeout(400)  # slide-in
        await m.screenshot(path=f"{a.out}/ui-06-mobile-nav.png")
        await m.click(".nav-backdrop", position={"x": 350, "y": 400})
        await m.wait_for_selector(".sidebar.open", state="detached")
        check("tapping beside the drawer closes it", True)
        await m.click(".nav-burger")
        await m.wait_for_selector(".sidebar.open")
        await m.wait_for_timeout(400)
        await m.click('.sidebar [data-scope="all"]')
        await m.wait_for_selector(".results [data-item]")
        await m.screenshot(path=f"{a.out}/ui-07-mobile-grid.png")
        wide = await m.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        check("no sideways scrolling at 390 px", wide)
        await m.locator(".results [data-item]").first.click()
        await m.wait_for_function("()=>!!document.body.dataset.model", timeout=30000)
        check("tapping an item opens it on a phone", True)
        await b.close()

    for e in errors:
        print("PAGE ERROR:", e)
    failed = [n for n, ok in results if not ok]
    print(f"{len(results) - len(failed)} of {len(results)} checks passed")
    return 1 if failed or errors else 0


sys.exit(asyncio.run(main()))
