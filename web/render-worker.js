// Runs OpenSCAD (WebAssembly) for one render, then exits. The page creates a
// fresh worker per render: terminating it is the only way to stop a running
// WASM render, and the engine can't be reused after a run anyway.
//
// Message in:  { engineUrl, module?, files: {virtualPath: url}, entry, values }
// Messages out: { type: "log", line } ... then { type: "done", stl, ms, logs } or { type: "error", error, logs }
import OpenSCAD from "./engine/openscad.js";

const CACHE = "gw-fs-v1";
const logs = [];
const log = (line) => {
  line = String(line);
  logs.push(line);
  if (logs.length > 400) logs.shift();
  self.postMessage({ type: "log", line });
};

// Source files are content-addressed (URL = hash), so a cached copy never goes stale.
async function getFile(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache Storage (e.g. private mode) */ }
  const hit = cache && (await cache.match(url));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download a model file (${res.status}). Check your connection and try again.`);
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota: just skip caching */ } }
  return new Uint8Array(await res.arrayBuffer());
}

function parameterSet(values) {
  const set = {};
  for (const [k, v] of Object.entries(values)) set[k] = typeof v === "string" ? v : JSON.stringify(v);
  return JSON.stringify({ fileFormatVersion: "1", parameterSets: { site: set } });
}

self.onmessage = async ({ data }) => {
  const started = performance.now();
  try {
    const { files, entry, values } = data;
    self.postMessage({ type: "stage", stage: "Loading model files…" });
    const entries = Object.entries(files);
    const contents = await Promise.all(entries.map(([, url]) => getFile(url)));

    self.postMessage({ type: "stage", stage: "Starting OpenSCAD…" });
    const engine = await OpenSCAD({
      noInitialRun: true,
      print: log,
      printErr: log,
      // reuse the module the page already compiled, if it sent one
      ...(data.module ? {
        instantiateWasm(imports, done) {
          WebAssembly.instantiate(data.module, imports).then((inst) => done(inst, data.module));
          return {};
        },
      } : { locateFile: (p) => new URL(`./engine/${p}`, self.location.href).href }),
    });
    if (engine.ENV) Object.assign(engine.ENV, { FONTCONFIG_PATH: "/fonts", FONTCONFIG_FILE: "/fonts/fonts.conf", HOME: "/tmp" });
    engine.FS.mkdirTree("/tmp/fontconfig");
    entries.forEach(([p], i) => {
      engine.FS.mkdirTree(p.slice(0, p.lastIndexOf("/")) || "/");
      engine.FS.writeFile(p, contents[i]);
    });
    engine.FS.writeFile("/params.json", parameterSet(values));

    self.postMessage({ type: "stage", stage: "Rendering…" });
    let code;
    try {
      code = engine.callMain([entry, "--backend=Manifold", "--export-format=binstl",
        "-p", "/params.json", "-P", "site", "-o", "/out.stl"]);
    } catch (e) {
      throw new Error(typeof e === "number" ? `OpenSCAD stopped with code ${e}.`
        : `The engine crashed (${e && e.message ? e.message : e}). This model may be too complex for the browser.`);
    }
    const errors = logs.filter((l) => /^ERROR:/.test(l));
    let stl = null;
    try { stl = engine.FS.readFile("/out.stl"); } catch { /* no output */ }
    if (code !== 0 || errors.length || !stl || stl.length <= 84) {
      throw new Error(errors[0] || "OpenSCAD produced no geometry. These settings may not be valid for this model.");
    }
    const buf = stl.slice().buffer;
    self.postMessage({ type: "done", stl: buf, ms: performance.now() - started, logs }, [buf]);
  } catch (e) {
    self.postMessage({ type: "error", error: e && e.message ? e.message : String(e), logs });
  }
};
