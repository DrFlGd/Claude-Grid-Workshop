"""API tests. Uses the real engine if OPENSCAD points at one, else a fake.

    python3 -m pytest tests -q           (or)    python3 tests/test_api.py
"""
import os, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("OPENSCAD", str(ROOT / "tests/fake_openscad.py"))
os.environ.setdefault("GW_CACHE_DIR", str(ROOT / "data/test-cache"))
from starlette.testclient import TestClient
from app.main import app, catalog

def wait(c, job, limit=900):
    t = time.time()
    while job["status"] in ("queued", "running"):
        assert time.time() - t < limit, "render timed out"
        time.sleep(0.25)
        job = c.get(f"/api/jobs/{job['id']}").json()
    return job

def test_catalog_and_detail():
    with TestClient(app) as c:
        data = c.get("/api/models").json()
        keys = [m["key"] for cat in data["categories"] for m in cat["models"]]
        assert "gridfinity-rebuilt/bin" in keys and "anylid/lid" in keys
        d = c.get("/api/models/gridfinity-rebuilt/bin").json()
        assert d["parameters"] and d["groups"]
        assert c.get("/api/models/nope/nope").status_code == 404

def test_validation_rejects_bad_input():
    with TestClient(app) as c:
        r = c.post("/api/render", json={"model": "gridfinity-rebuilt/bin", "params": {"gridx": "3; import os"}})
        assert r.status_code == 422
        r = c.post("/api/render", json={"model": "gridfinity-rebuilt/bin", "params": {"evil": 1}})
        assert r.status_code == 422
        r = c.post("/api/render", json={"model": "../../etc/passwd"})
        assert r.status_code == 404

def test_render_download_and_cache():
    with TestClient(app) as c:
        model = os.environ.get("TEST_MODEL", "gridfinity-rebuilt/baseplate")
        job = wait(c, c.post("/api/render", json={"model": model, "params": {}}).json())
        assert job["status"] == "done", job
        r = c.get(job["download_url"])
        assert r.status_code == 200 and len(r.content) > 100
        assert "attachment" in r.headers.get("content-disposition", "")
        again = c.post("/api/render", json={"model": model, "params": {}}).json()
        assert again["status"] == "done" and again["cached"]

def test_part_library():
    with TestClient(app) as c:
        libs = c.get("/api/libraries").json()["libraries"]
        assert any(l["id"] == "opengrid-official" for l in libs)
        lib = c.get("/api/libraries/opengrid-official").json()
        item = next(i for i in lib["items"] if i.get("preview_url"))
        r = c.get(item["preview_url"])
        assert r.status_code == 200 and len(r.content) > 84
        f = item["files"][0]
        r = c.get(f["url"])
        assert r.status_code == 200 and len(r.content) == f["bytes"]
        assert c.get("/api/libraries/opengrid-official/files/../../app/main.py").status_code == 404
        assert c.get("/api/libraries/opengrid-official/files/README.md").status_code == 404  # not in manifest
        assert c.get("/api/libraries/nope").status_code == 404

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
