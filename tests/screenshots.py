#!/usr/bin/env python3
"""Open the running site in Chromium, render models, and save screenshots.

    python3 tests/screenshots.py --base http://localhost:8000 --out shots gridfinity-rebuilt/bin ...
Exits non-zero if a model fails to render or the page logs a script error.
"""
import argparse, asyncio, sys
from playwright.async_api import async_playwright

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--out", default="shots")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("models", nargs="*")
    a = ap.parse_args()
    import os; os.makedirs(a.out, exist_ok=True)
    failures, errors = [], []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(a.base + "/")
        await pg.wait_for_selector(".cat-rows a")
        await pg.screenshot(path=f"{a.out}/00-catalog.png")
        for i, key in enumerate(a.models, 1):
            await pg.goto(f"{a.base}/m/{key}")
            try:
                await pg.wait_for_function(
                    "() => { const s = document.querySelector('#status'); return s && (s.classList.contains('ok') || s.classList.contains('error')); }",
                    timeout=a.timeout * 1000)
            except Exception:
                failures.append(f"{key}: timed out")
            await pg.wait_for_timeout(700)
            status = await pg.inner_text("#status")
            ok = "matches" in status
            print(("PASS " if ok else "FAIL ") + key + " :: " + status, flush=True)
            if not ok:
                failures.append(f"{key}: {status}")
            await pg.screenshot(path=f"{a.out}/{i:02d}-{key.replace('/', '--')}.png")
        # one interaction pass: change a setting, see the stale state, regenerate
        if a.models:
            await pg.goto(f"{a.base}/m/{a.models[0]}")
            await pg.wait_for_function("() => document.querySelector('#status').classList.contains('ok')", timeout=a.timeout * 1000)
            first = pg.locator("#params input[type=number]").first
            await first.fill("2")
            await pg.screenshot(path=f"{a.out}/90-stale.png")
            await pg.click("#generate")
            await pg.wait_for_function("() => document.querySelector('#status').classList.contains('ok')", timeout=a.timeout * 1000)
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f"{a.out}/91-regenerated.png")
            m = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
            await m.goto(f"{a.base}/m/{a.models[0]}")
            await m.wait_for_function("() => document.querySelector('#status').classList.contains('ok')", timeout=a.timeout * 1000)
            await m.wait_for_timeout(500)
            await m.screenshot(path=f"{a.out}/92-mobile.png")
        await b.close()
    for e in errors: print("PAGE ERROR:", e)
    return 1 if failures or errors else 0

sys.exit(asyncio.run(main()))
