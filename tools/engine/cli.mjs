#!/usr/bin/env node
// Build-time and CI uses of the browser engine, run in Node.
//
//   node tools/engine/cli.mjs version <engineDir>
//   node tools/engine/cli.mjs params  <engineDir> <site> <modelKey>...      -> JSON on stdout
//   node tools/engine/cli.mjs bench   <site> [--out f.json] [--stl-dir d] [--only key,key] [--params f.json]
//
// "params" runs OpenSCAD's own Customizer export (--export-format=param) on each
// model's entrypoint. "bench" renders every model in the built site exactly as
// the browser worker does and records time, memory and result size.
import fs from "node:fs";
import path from "node:path";
import { loadEngine, modelFiles, parameterSet, isError } from "./engine.mjs";

const [cmd, ...rest] = process.argv.slice(2);

function readModel(site, key) {
  return JSON.parse(fs.readFileSync(path.join(site, "data", "models", key.replace("/", "--") + ".json"), "utf8"));
}

function flag(name, def = null) {
  const i = rest.indexOf(name);
  if (i < 0) return def;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

function stlTriangles(buf) {
  if (!buf || buf.length < 84) return 0;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(80, true);
}

if (cmd === "version") {
  const engine = await loadEngine(rest[0]);
  console.log(await engine.getVersion());
} else if (cmd === "params") {
  const [engineDir, site, ...keys] = rest;
  const engine = await loadEngine(engineDir);
  const catalog = JSON.parse(fs.readFileSync(path.join(site, "data", "catalog.json"), "utf8"));
  const out = {};
  for (const key of keys) {
    const m = readModel(site, key);
    const r = await engine.run(modelFiles(site, m, catalog.common_files), [m.entry, "--export-format=param", "-o", "/params.json"], ["/params.json"]);
    const data = r.outputs["/params.json"];
    out[key] = data ? JSON.parse(new TextDecoder().decode(data)) : { error: r.logs.slice(-20).join("\n") };
  }
  process.stdout.write(JSON.stringify(out));
} else if (cmd === "bench") {
  const out = flag("--out");
  const stlDir = flag("--stl-dir");
  const only = flag("--only");
  const paramsFile = flag("--params"); // {key: {param: value}} overrides, e.g. for parity checks
  const site = rest[0];
  const catalog = JSON.parse(fs.readFileSync(path.join(site, "data", "catalog.json"), "utf8"));
  const engine = await loadEngine(path.join(site, "engine"));
  const version = await engine.getVersion();
  let jobs = catalog.models.map((m) => ({ key: m.key, id: m.key, params: {} }));
  if (paramsFile) jobs = JSON.parse(fs.readFileSync(paramsFile, "utf8")).map((j) => ({ ...j, id: j.id || j.key }));
  if (only) jobs = jobs.filter((j) => only.split(",").includes(j.key));
  if (stlDir) fs.mkdirSync(stlDir, { recursive: true });
  const results = [];
  for (const job of jobs) {
    const m = readModel(site, job.key);
    const values = Object.fromEntries(m.parameters.map((p) => [p.name, p.default]));
    Object.assign(values, job.params, m.fixed || {});
    const files = modelFiles(site, m, catalog.common_files);
    const defineNames = new Set(m.parameters.filter((p) => p.define).map((p) => p.name));
    const plain = Object.fromEntries(Object.entries(values).filter(([k]) => !defineNames.has(k)));
    files.set("/params.json", new TextEncoder().encode(parameterSet(plain)));
    const args = [m.entry, "--backend=Manifold", "--export-format=binstl", "-p", "/params.json", "-P", "site", "-o", "/out.stl"];
    for (const k of defineNames) if (k in values) args.splice(1, 0, "-D", `${k}=${JSON.stringify(values[k])}`);
    const r = await engine.run(files, args, ["/out.stl"]);
    const stl = r.outputs["/out.stl"];
    const errors = r.logs.filter(isError);
    const warnings = r.logs.filter((l) => /^WARNING:/.test(l));
    const ok = r.code === 0 && stl && stl.length > 84 && !errors.length;
    if (ok && stlDir) fs.writeFileSync(path.join(stlDir, job.id.replace("/", "--") + ".stl"), stl);
    const res = {
      id: job.id, key: job.key, status: ok ? "pass" : "fail", seconds: +(r.ms / 1000).toFixed(2),
      heap_mb: r.heapBytes ? +(r.heapBytes / 1048576).toFixed(0) : null,
      bytes: stl ? stl.length : 0, triangles: stlTriangles(stl), warnings: warnings.length,
      files: files.size, input_kb: Math.round([...files.values()].reduce((a, b) => a + b.length, 0) / 1024),
      errors: errors.slice(0, 5), log_tail: ok ? undefined : r.logs.slice(-15),
    };
    results.push(res);
    console.error(`${res.status.padEnd(5)} ${job.id.padEnd(42)} ${String(res.seconds).padStart(7)}s  heap ${String(res.heap_mb).padStart(5)} MB  ${res.triangles} tris${res.warnings ? `  ${res.warnings} warnings` : ""}`);
  }
  const report = { engine: version, date: new Date().toISOString(), results };
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (results.some((r) => r.status !== "pass")) process.exitCode = 1;
} else {
  console.error("usage: cli.mjs version|params|bench ...");
  process.exitCode = 2;
}
