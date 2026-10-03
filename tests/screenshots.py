#!/usr/bin/env python3
"""Open the built static site in Chromium, render models, save screenshots.

    python3 -m http.server -d _site 8000 &
    python3 tests/screenshots.py --base http://localhost:8000/ --out shots [model keys...]

With no keys, every model in data/catalog.json is rendered. Exits non-zero if
a model fails in the browser or the page logs a script error.
"""
import argparse
import asyncio
import json
import sys
import urllib.request

from playwright.async_api import async_playwright

DONE = "()=>{const s=document.querySelector('#status');return s&&(s.classList.contains('ok')||s.classList.contains('error'))}"


async def open_and_render(page, base, key, timeout):
    """Navigate to a model and wait for its own render (not the previous page's status)."""
    await page.goto(f"{base}#/m/{key}")
    await page.wait_for_function(
        f"()=>location.hash.endsWith('{key}') && document.querySelector('#status').classList.contains('busy')", timeout=30000)
    await page.wait_for_function(DONE, timeout=timeout * 1000)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000/")
    ap.add_argument("--out", default="shots")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("models", nargs="*")
    a = ap.parse_args()
    import os
    os.makedirs(a.out, exist_ok=True)
    models = a.models or [m["key"] for m in json.load(urllib.request.urlopen(a.base + "data/catalog.json"))["models"]]
    failures, errors, timings = [], [], []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(a.base)
        await pg.wait_for_selector(".cat-rows a")
        await pg.screenshot(path=f"{a.out}/00-catalog.png")
        for i, key in enumerate(models, 1):
            await pg.goto(f"{a.base}#/m/{key}")
            try:
                await pg.wait_for_function(
                    f"()=>location.hash.endsWith('{key}') && document.querySelector('#status').classList.contains('busy')", timeout=30000)
                await pg.wait_for_function(DONE, timeout=a.timeout * 1000)
            except Exception:
                failures.append(f"{key}: timed out")
            await pg.wait_for_timeout(500)
            status = await pg.inner_text("#status")
            ok = "matches" in status
            print(("PASS " if ok else "FAIL ") + key + " :: " + status, flush=True)
            timings.append({"key": key, "status": status})
            if not ok:
                failures.append(f"{key}: {status}")
            await pg.screenshot(path=f"{a.out}/{i:02d}-{key.replace('/', '--')}.png")

        # interaction: change a number, see the stale state, regenerate
        await open_and_render(pg, a.base, "gridfinity-rebuilt/bin", a.timeout)
        await pg.fill("#p-gridx", "2")
        await pg.screenshot(path=f"{a.out}/90-stale.png")
        await pg.click("#generate")
        await pg.wait_for_function("()=>document.querySelector('#status').classList.contains('busy')", timeout=30000)
        await pg.wait_for_function(DONE, timeout=a.timeout * 1000)
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=f"{a.out}/91-regenerated.png")

        # upstream editor metadata: GridFlock magnets switch and printer presets
        await open_and_render(pg, a.base, "gridflock/baseplate", a.timeout)
        sw = pg.locator(".group[data-group=Magnets] .group-switch")
        await sw.scroll_into_view_if_needed()
        await sw.check()
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{a.out}/92-gridflock-magnets.png")

        await pg.goto(f"{a.base}#/parts/opengrid-official/mounts-opengrid-wall-mount")
        await pg.wait_for_selector("#dims:not([hidden])", timeout=60000)
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=f"{a.out}/93-parts.png")

        m = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
        m.on("pageerror", lambda e: errors.append(str(e)))
        await open_and_render(m, a.base, "gridfinity-rebuilt/bin", a.timeout)
        await m.wait_for_timeout(500)
        await m.screenshot(path=f"{a.out}/94-mobile.png")
        await b.close()
    json.dump(timings, open(f"{a.out}/browser-results.json", "w"), indent=1)
    for e in errors:
        print("PAGE ERROR:", e)
    for f in failures:
        print("FAILED:", f)
    return 1 if failures or errors else 0


sys.exit(asyncio.run(main()))
