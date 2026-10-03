"""Run OpenSCAD safely and cache its output.

- Only catalog entrypoints are rendered; values arrive pre-validated and are
  passed as -D arguments in an argv list (never through a shell).
- Each render gets a time limit, its own temp directory and an optional memory
  limit; a semaphore bounds how many run at once.
- Results are cached by (engine, model sources, parameters), so a repeat
  request is served from disk without rendering.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import struct
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .catalog import Model, scad_literal


@dataclass
class EngineInfo:
    path: str
    version: str
    manifold: bool
    binstl: bool


def detect_engine(candidates: list[str]) -> EngineInfo | None:
    import subprocess

    for c in candidates:
        exe = shutil.which(c) or (c if Path(c).exists() else None)
        if not exe:
            continue
        try:
            v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
            h = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            continue
        help_text = h.stdout + h.stderr
        return EngineInfo(
            path=exe,
            version=(v.stdout + v.stderr).strip().splitlines()[-1] if (v.stdout + v.stderr).strip() else "unknown",
            manifold="manifold" in help_text,
            binstl="binstl" in help_text,
        )
    return None


@dataclass
class Job:
    id: str
    model: str
    cache_key: str
    status: str = "queued"  # queued | running | done | failed | cancelled
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    cached: bool = False
    log: str = ""
    error: str | None = None
    bytes: int | None = None
    triangles: int | None = None
    filename: str = "model.stl"
    _proc: asyncio.subprocess.Process | None = None
    _task: asyncio.Task | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "model": self.model,
            "status": self.status,
            "cached": self.cached,
            "queued_at": self.created,
            "started_at": self.started,
            "finished_at": self.finished,
            "seconds": round((self.finished or time.time()) - (self.started or self.created), 2),
            "error": self.error,
            "log": self.log[-6000:],
            "bytes": self.bytes,
            "triangles": self.triangles,
            "download_url": f"/api/files/{self.cache_key}.stl?name={self.filename}" if self.status == "done" else None,
        }


def stl_triangles(path: Path) -> int | None:
    try:
        with path.open("rb") as f:
            head = f.read(84)
            if len(head) == 84 and not head[:5].lower() == b"solid":
                n = struct.unpack("<I", head[80:84])[0]
                if 84 + 50 * n == path.stat().st_size:
                    return n
        # ASCII STL
        with path.open("rb") as f:
            return sum(1 for line in f if line.lstrip().startswith(b"facet"))
    except OSError:
        return None


def friendly_filename(model: Model, params: dict) -> str:
    base = f'{model.family["id"]}-{model.meta["id"]}'
    dims = []
    for key in ("gridx", "gridy", "gridz", "Width", "Depth", "Height", "Width_Units", "Length_Units",
                "Board_Width", "Board_Height", "shelf_width", "shelf_depth", "GridSize", "plate_size"):
        if key in params:
            v = params[key]
            v = v if isinstance(v, list) else [v]
            dims.extend(str(x).rstrip("0").rstrip(".") if isinstance(x, float) else str(x)
                        for x in v if isinstance(x, (int, float)) and not isinstance(x, bool))
    part = model.meta.get("part_parameter")
    if part and isinstance(params.get(part), (str, int)):
        base += f"-{params[part]}"
    name = base + ("-" + "x".join(dims[:4]) if dims else "")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120] + ".stl"


class Renderer:
    def __init__(self, engine: EngineInfo | None, cache_dir: Path, workers: int = 2,
                 timeout: int = 600, memory_mb: int | None = None, cache_limit_mb: int = 4096):
        self.engine = engine
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sem = asyncio.Semaphore(workers)
        self.timeout = timeout
        self.memory_mb = memory_mb
        self.cache_limit = cache_limit_mb * 1024 * 1024
        self.jobs: dict[str, Job] = {}
        self.inflight: dict[str, Job] = {}

    # -- public API ---------------------------------------------------------
    def cache_key(self, model: Model, params: dict) -> str:
        payload = json.dumps(
            {"engine": self.engine.version if self.engine else None, "model": model.key,
             "entry": model.meta["entrypoint"], "src": model.source_digest, "params": params},
            sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()[:40]

    def cache_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.stl"

    def submit(self, model: Model, params: dict) -> Job:
        key = self.cache_key(model, params)
        if key in self.inflight:  # identical request already rendering: share it
            return self.inflight[key]
        job = Job(id=uuid.uuid4().hex[:16], model=model.key, cache_key=key,
                  filename=friendly_filename(model, params))
        self.jobs[job.id] = job
        out = self.cache_path(key)
        if out.exists():
            os.utime(out)
            job.status, job.cached = "done", True
            job.started = job.finished = time.time()
            job.bytes = out.stat().st_size
            job.triangles = stl_triangles(out)
            return job
        if not self.engine:
            job.status, job.error = "failed", "OpenSCAD is not installed on this server."
            job.finished = time.time()
            return job
        self.inflight[key] = job
        job._task = asyncio.create_task(self._run(job, model, params))
        self._prune_jobs()
        return job

    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job and job.status in ("queued", "running"):
            job.status = "cancelled"
            job.finished = time.time()
            if job._proc and job._proc.returncode is None:
                job._proc.kill()
            if job._task and not job._proc:
                job._task.cancel()
            self.inflight.pop(job.cache_key, None)
        return job

    # -- internals ----------------------------------------------------------
    def _command(self, model: Model, params: dict, out: Path) -> list[str]:
        cmd = [self.engine.path]
        if self.engine.manifold:
            cmd.append("--backend=manifold")
        if self.engine.binstl:
            cmd += ["--export-format", "binstl"]
        cmd += ["-o", str(out)]
        for k, v in params.items():
            cmd += ["-D", f"{k}={scad_literal(v)}"]
        cmd.append(str(model.entrypoint))
        return cmd

    def _limits(self):
        if not self.memory_mb or os.name != "posix":
            return None
        mem = self.memory_mb * 1024 * 1024

        def apply():
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
            os.setsid()

        return apply

    async def _run(self, job: Job, model: Model, params: dict):
        try:
            async with self.sem:
                if job.status == "cancelled":
                    return
                job.status, job.started = "running", time.time()
                with tempfile.TemporaryDirectory(prefix="render-") as tmp:
                    out = Path(tmp) / "out.stl"
                    env = {
                        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                        "HOME": tmp,
                        "QT_QPA_PLATFORM": "offscreen",
                        "OPENSCADPATH": os.pathsep.join(str(p) for p in model.library_paths),
                    }
                    job._proc = await asyncio.create_subprocess_exec(
                        *self._command(model, params, out), cwd=str(model.entrypoint.parent), env=env,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                        stdin=asyncio.subprocess.DEVNULL, preexec_fn=self._limits())
                    try:
                        stdout, _ = await asyncio.wait_for(job._proc.communicate(), timeout=self.timeout)
                    except asyncio.TimeoutError:
                        job._proc.kill()
                        await job._proc.wait()
                        job.status, job.error = "failed", f"Render took longer than {self.timeout}s and was stopped."
                        return
                    job.log = stdout.decode(errors="replace").replace(str(model.entrypoint.parent) + "/", "")
                    if job.status == "cancelled":
                        return
                    errors = [l for l in job.log.splitlines() if l.startswith("ERROR")]
                    if job._proc.returncode != 0 or not out.exists() or out.stat().st_size == 0 or errors:
                        job.status = "failed"
                        job.error = (errors[0] if errors else
                                     "OpenSCAD produced no geometry. These settings may be invalid for this model.")
                        return
                    final = self.cache_path(job.cache_key)
                    shutil.move(str(out), final)
                    job.bytes = final.stat().st_size
                    job.triangles = stl_triangles(final)
                    job.status = "done"
                    self._prune_cache()
        except asyncio.CancelledError:
            job.status = "cancelled"
        except Exception as e:  # keep the server alive; report the failure
            job.status, job.error = "failed", f"Render error: {e}"
        finally:
            job.finished = job.finished or time.time()
            self.inflight.pop(job.cache_key, None)

    def _prune_cache(self):
        files = sorted(self.cache_dir.glob("*.stl"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > self.cache_limit:
            f = files.pop(0)
            total -= f.stat().st_size
            f.unlink(missing_ok=True)

    def _prune_jobs(self, keep: int = 2000):
        if len(self.jobs) > keep:
            for jid in sorted(self.jobs, key=lambda j: self.jobs[j].created)[: len(self.jobs) - keep]:
                if self.jobs[jid].status not in ("queued", "running"):
                    del self.jobs[jid]
