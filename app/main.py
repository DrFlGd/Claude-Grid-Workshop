"""Claude Grid Workshop web server.

    uvicorn app.main:app --host 0.0.0.0 --port 8000

Environment:
    OPENSCAD          engine binary (default: openscad-nightly, then openscad)
    GW_CACHE_DIR      where rendered STLs are kept (default: ./data/cache)
    GW_WORKERS        concurrent renders (default: 2)
    GW_TIMEOUT        seconds per render (default: 600)
    GW_MEMORY_MB      address-space limit per render, MB (default: off; prefer container limits)
    GW_CACHE_MB       cache size before oldest files are removed (default: 4096)
    GW_PUBLIC         "1" hides families whose license is not cleared for public use
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .catalog import ROOT, Catalog, ParamError
from .engine import Renderer, detect_engine
from .libraries import MEDIA, Libraries

PUBLIC = os.environ.get("GW_PUBLIC") == "1"
catalog = Catalog(public_mode=PUBLIC)
engine = detect_engine([c for c in [os.environ.get("OPENSCAD"), "openscad-nightly", "openscad"] if c])
renderer = Renderer(
    engine,
    Path(os.environ.get("GW_CACHE_DIR", ROOT / "data/cache")),
    workers=int(os.environ.get("GW_WORKERS", 2)),
    timeout=int(os.environ.get("GW_TIMEOUT", 600)),
    memory_mb=int(os.environ["GW_MEMORY_MB"]) if os.environ.get("GW_MEMORY_MB") else None,
    cache_limit_mb=int(os.environ.get("GW_CACHE_MB", 4096)),
)
libraries = Libraries(public_mode=PUBLIC, cache_dir=renderer.cache_dir)
MAX_BODY = 64 * 1024


def error(msg: str, status: int = 400):
    return JSONResponse({"error": msg}, status_code=status)


async def health(request: Request):
    return JSONResponse({
        "ok": True,
        "engine": engine.version if engine else None,
        "manifold": bool(engine and engine.manifold),
        "models": len(catalog.models),
        "libraries": len(libraries.libs),
        "public_mode": PUBLIC,
    })


async def list_models(request: Request):
    return JSONResponse(catalog.listing())


async def model_detail(request: Request):
    key = f'{request.path_params["family"]}/{request.path_params["model"]}'
    m = catalog.models.get(key)
    return JSONResponse(m.detail()) if m else error("Unknown model", 404)


async def render(request: Request):
    body = await request.body()
    if len(body) > MAX_BODY:
        return error("Request too large", 413)
    try:
        data = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return error("Invalid JSON")
    m = catalog.models.get(str(data.get("model", "")))
    if not m:
        return error("Unknown model", 404)
    try:
        params = m.validate(data.get("params", {}))
    except ParamError as e:
        return error(str(e), 422)
    job = renderer.submit(m, params)
    return JSONResponse(job.public(), status_code=202 if job.status in ("queued", "running") else 200)


async def job_status(request: Request):
    job = renderer.jobs.get(request.path_params["job_id"])
    return JSONResponse(job.public()) if job else error("Unknown job", 404)


async def job_cancel(request: Request):
    job = renderer.cancel(request.path_params["job_id"])
    return JSONResponse(job.public()) if job else error("Unknown job", 404)


FILE_RE = re.compile(r"^[0-9a-f]{40}$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,130}\.stl$")


async def download(request: Request):
    key = request.path_params["key"]
    if not FILE_RE.match(key):
        return error("Not found", 404)
    path = renderer.cache_path(key)
    if not path.exists():
        return error("This file has expired. Generate it again.", 404)
    name = request.query_params.get("name", "model.stl")
    if not NAME_RE.match(name):
        name = "model.stl"
    inline = request.query_params.get("inline") == "1"
    return FileResponse(path, media_type="model/stl", filename=None if inline else name,
                        headers={"Cache-Control": "private, max-age=86400"})


async def list_libraries(request: Request):
    return JSONResponse({"libraries": libraries.listing()})


async def library_detail(request: Request):
    d = libraries.detail(request.path_params["lib"])
    return JSONResponse(d) if d else error("Unknown library", 404)


async def library_file(request: Request):
    found = libraries.file(request.path_params["lib"], request.path_params["path"])
    if not found:
        return error("Not found", 404)
    path, meta = found
    return FileResponse(path, media_type=MEDIA.get(meta["format"], "application/octet-stream"),
                        filename=path.name, headers={"Cache-Control": "public, max-age=86400"})


async def library_preview(request: Request):
    try:
        path = libraries.preview(request.path_params["lib"], request.path_params["item"])
    except Exception:
        return error("This part can't be previewed.", 422)
    if not path:
        return error("Not found", 404)
    return FileResponse(path, media_type="model/stl", headers={"Cache-Control": "public, max-age=86400"})


class SecureHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def wrapped(message):
            if message["type"] == "http.response.start":
                h = message.setdefault("headers", [])
                h += [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"same-origin"),
                      (b"x-frame-options", b"SAMEORIGIN")]
            await send(message)
        await self.app(scope, receive, wrapped) if scope["type"] == "http" else await self.app(scope, receive, send)


async def spa(request: Request):
    return FileResponse(ROOT / "web/index.html", headers={"Cache-Control": "no-cache"})


routes = [
    Route("/api/health", health),
    Route("/api/models", list_models),
    Route("/api/models/{family}/{model}", model_detail),
    Route("/api/render", render, methods=["POST"]),
    Route("/api/jobs/{job_id}", job_status),
    Route("/api/jobs/{job_id}/cancel", job_cancel, methods=["POST"]),
    Route("/api/files/{key}.stl", download),
    Route("/api/libraries", list_libraries),
    Route("/api/libraries/{lib}", library_detail),
    Route("/api/libraries/{lib}/files/{path:path}", library_file),
    Route("/api/libraries/{lib}/preview/{item}.stl", library_preview),
    Mount("/static", StaticFiles(directory=ROOT / "web"), name="static"),
    Route("/", spa),
    Route("/m/{rest:path}", spa),
    Route("/parts/{rest:path}", spa),
]

app = SecureHeaders(Starlette(routes=routes))
