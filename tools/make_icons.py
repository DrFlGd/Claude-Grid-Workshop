"""Make the app's icons from the logo's two drawings (desktop/src-tauri/icons/src):
logo.svg for 64 px and up, logo-small.svg (no grid, dimensions or hidden lines) for 16 to 48 px.
Also copies the small one to web/favicon.svg. logo-design.png is the owner's design (2026-10-16) they were drawn from. Needs Playwright's Chromium and Pillow.

    python3 tools/make_icons.py [--chromium /path/to/chromium]
"""
import argparse, asyncio, io, shutil
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "desktop/src-tauri/icons"


async def render(chromium, svg, sizes):
    src = svg.read_text()
    out = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(**({"executable_path": chromium} if chromium else {}))
        pg = await b.new_page()
        for n in sizes:
            await pg.set_viewport_size({"width": n, "height": n})
            await pg.set_content('<body style="margin:0">' + src.replace("<svg ", f'<svg width="{n}" height="{n}" ', 1) + "</body>")
            out[n] = Image.open(io.BytesIO(await pg.screenshot(omit_background=True))).convert("RGBA")
        await b.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chromium")
    a = ap.parse_args()
    big = asyncio.run(render(a.chromium, ICONS / "src/logo.svg", [64, 128, 256, 512]))
    small = asyncio.run(render(a.chromium, ICONS / "src/logo-small.svg", [16, 24, 32, 48]))
    small[32].save(ICONS / "32x32.png")
    big[128].save(ICONS / "128x128.png")
    big[256].save(ICONS / "128x128@2x.png")
    big[512].save(ICONS / "icon.png")
    frames = [big[256], big[128], big[64], small[48], small[32], small[24], small[16]]
    frames[0].save(ICONS / "icon.ico", format="ICO", sizes=[f.size for f in frames], append_images=frames[1:])
    shutil.copy(ICONS / "src/logo-small.svg", ROOT / "web/favicon.svg")
    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
