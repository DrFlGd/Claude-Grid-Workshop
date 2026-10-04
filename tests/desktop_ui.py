#!/usr/bin/env python3
"""Drive the built desktop app through tauri-driver (WebDriver) and save screenshots.

    tauri-driver &                     # needs WebKitWebDriver (Linux) or msedgedriver (Windows)
    python3 tests/desktop_ui.py --app desktop/target/release/claude-grid-workshop --out shots

Checks: the catalog loads (including desktop-only models), native renders work
(one model the browser engine can't render), saved settings land in the
workspace folder, the settings page shows the workspace and engine, and a
ready-made part previews. Exits non-zero on any failure.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions

ap = argparse.ArgumentParser()
ap.add_argument("--app", required=True)
ap.add_argument("--out", default="shots")
ap.add_argument("--workspace", help="expected workspace folder (default: ~/Claude Grid Workshop)")
ap.add_argument("--driver", default="http://127.0.0.1:4444")
a = ap.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
workspace = Path(a.workspace) if a.workspace else Path.home() / "Claude Grid Workshop"

opts = ArgOptions()
opts.set_capability("browserName", "wry")
opts.set_capability("tauri:options", {"application": str(Path(a.app).resolve())})
print("starting a session…", flush=True)
d = webdriver.Remote(command_executor=a.driver, options=opts)
print("session started", flush=True)
d.set_script_timeout(30)
try:
    d.set_window_size(1400, 900)
except Exception as e:  # some drivers can't resize
    print("resize:", e, flush=True)
failures, report = [], {}


def shot(name):
    d.save_screenshot(str(out / f"{name}.png"))


def wait(js, timeout=180, what=""):
    print(f"waiting for {what or js[:60]}…", flush=True)
    end = time.time() + timeout
    while time.time() < end:
        try:
            if d.execute_script(f"return !!({js})"):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    failures.append(f"timed out waiting for {what or js}")
    try:
        shot(f"timeout-{len(failures):02d}")
        print("page says:", d.execute_script("return document.body.innerText.slice(0, 400)"), flush=True)
        print("errors:", d.execute_script("return window.__errors || []"), flush=True)
    except Exception as e:
        print("couldn't inspect the page:", e, flush=True)
    return False


def text(sel):
    return d.execute_script(f"const n=document.querySelector({json.dumps(sel)});return n?n.textContent:''")


DONE = "(()=>{const s=document.querySelector('#status');return s&&(s.classList.contains('ok')||s.classList.contains('error'))})()"


def open_model(key, timeout=300):
    d.execute_script(f"location.hash = '#/m/{key}'")
    wait(f"document.body.dataset.model === '{key}'", 60, f"{key} to open")
    ok = wait(DONE, timeout, f"{key} to render")
    status = text("#status")
    report[key] = status
    print(("PASS " if "matches" in status else "FAIL ") + key + " :: " + status, flush=True)
    if not ok or "matches" not in status:
        failures.append(f"{key}: {status}")


try:
    if not wait("document.querySelector('.project .chip')", 90, "the catalog"):
        raise SystemExit("the catalog never appeared; skipping the rest")
    time.sleep(0.5)
    shot("00-catalog")
    report["engine"] = text("#engine")
    report["platform"] = d.execute_script("return document.body.dataset.platform || ''")
    print("engine:", report["engine"], "| platform:", report["platform"])
    if "native" not in report["engine"]:
        failures.append(f"engine label: {report['engine']}")
    if not d.execute_script("return !!document.querySelector('a.chip[href=\"#/m/underware/t-channel\"]')"):
        failures.append("desktop-only model missing from the catalog")

    open_model("gridfinity-rebuilt/bin")
    time.sleep(1)
    shot("01-rebuilt-bin")
    open_model("underware/t-channel")  # crashes the WebAssembly engine; native only
    time.sleep(1)
    shot("02-underware-t-channel")
    open_model("minimalist-kitchen-gridfinity/bin")  # ~25 s in the browser
    report["kitchen_status"] = text("#status")

    # saved settings go to the workspace as files
    open_model("gridfinity-rebuilt/bin")
    d.execute_script("""
      const i = document.querySelector('#p-gridx'); i.value = '4'; i.dispatchEvent(new Event('input', {bubbles: true}));""")
    d.find_element(By.ID, "settings-save").click()
    time.sleep(0.3)
    d.execute_script("document.querySelector('#save-name').value = 'CI four wide'")
    d.find_element(By.ID, "save-primary").click()
    wait("document.querySelector('#settings-note') && document.querySelector('#settings-note').textContent.startsWith('Saved')", 20, "save note")
    saved = list((workspace / "settings/saved").glob("*.json"))
    names = [json.loads(p.read_text()).get("name") for p in saved]
    report["saved_files"] = names
    print("saved settings files:", names)
    if "CI four wide" not in names:
        failures.append(f"saved settings not in {workspace}: {names}")

    d.execute_script("location.hash = '#/settings'")
    wait("document.querySelector('.profile-grid')", 20, "settings page")
    time.sleep(0.5)
    shot("03-settings")
    report["settings_text"] = text("#about-body")[:600]

    d.execute_script("location.hash = '#/parts/opengrid-official/mounts-opengrid-wall-mount'")
    if wait("!document.querySelector('#dims').hidden", 60, "part preview"):
        report["part_dims"] = text("#dims")
    time.sleep(0.5)
    shot("04-part")
    errors = d.execute_script("return (window.__errors || []).slice(0, 20)")
    if errors:
        failures.extend(errors)
finally:
    (out / "desktop-ui.json").write_text(json.dumps({"report": report, "failures": failures}, indent=1))
    d.quit()

for f in failures:
    print("FAILED:", f)
sys.exit(1 if failures else 0)
