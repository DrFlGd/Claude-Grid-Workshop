// Desktop app side of web/platform.js: native OpenSCAD and the workspace folder,
// reached through the Tauri commands in desktop/src-tauri/src/main.rs.

import { EngineClient } from "./engine-client.js";

const tauri = globalThis.__TAURI__;
const invoke = (cmd, args, opts) => tauri.core.invoke(cmd, args, opts);

const MIME = { json: "application/json", stl: "model/stl", "3mf": "model/3mf", png: "image/png", svg: "image/svg+xml" };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

const cancelledError = () => Object.assign(new Error("Render cancelled."), { cancelled: true });

/**
 * Native OpenSCAD, plus (on Windows) the same WebAssembly engine as the website.
 * Native OpenSCAD on Windows is slow with projects made of many `use`d files
 * (Gridfinity Extended: ~10 s vs ~1 s in WebAssembly), while it's much faster
 * for heavy geometry. So on Windows the first render of each model races both
 * engines, keeps the faster one's result and remembers the winner for that model.
 */
class DesktopEngine {
  constructor(info, catalog, prefs) {
    this.common = catalog.common_files || {};
    this.info = info;
    this.prefs = prefs;
    this.concurrency = info.concurrency || 1;
    this.label = info.engine ? `OpenSCAD ${info.engine}, native` : "OpenSCAD not available";
    this.n = 0;
    this.hybrid = info.os === "windows";
    this.wasm = null;
  }

  wasmEngine() {
    this.wasm ||= new EngineClient({
      commonFiles: this.common,
      readFile: async (sha) => new Uint8Array(await invoke("site_read", { path: `fs/${sha}` })),
    });
    return this.wasm;
  }

  picks() { return this.prefs.get("gw-engine-pick", {}) || {}; }

  remember(key, engine) {
    if (this.picks()[key] !== engine) this.prefs.set("gw-engine-pick", { ...this.picks(), [key]: engine });
  }

  render(model, values, onEvent = () => {}) {
    if (!this.hybrid || model.browser === false || !this.info.engine) return this.renderNative(model, values, onEvent);
    const pick = this.picks()[model.key];
    if (pick === "native") return this.renderNative(model, values, onEvent);
    if (pick === "wasm") return this.withFallback(this.wasmEngine().render(model, values, onEvent), model, values, onEvent);
    return this.race(model, values, onEvent);
  }

  /** WebAssembly first; if it fails (memory, crash), native. */
  withFallback(job, model, values, onEvent) {
    let current = job;
    const promise = job.promise.then((r) => ({ ...r, engine: "wasm" }), (e) => {
      if (e.cancelled) throw e;
      current = this.renderNative(model, values, onEvent);
      return current.promise;
    });
    return { promise, cancel: () => current.cancel() };
  }

  race(model, values, onEvent) {
    const jobs = { native: this.renderNative(model, values, onEvent), wasm: this.wasmEngine().render(model, values, () => {}) };
    let settled = false, rejectRace;
    const promise = new Promise((resolve, reject) => {
      rejectRace = reject;
      const errors = {};
      for (const [name, job] of Object.entries(jobs)) {
        job.promise.then((result) => {
          if (settled) return;
          settled = true;
          for (const [other, j] of Object.entries(jobs)) if (other !== name) j.cancel();
          if (!result.cached) this.remember(model.key, name); // a cache hit says nothing about speed
          resolve({ ...result, engine: name });
        }, (e) => {
          if (settled || e.cancelled) return;
          errors[name] = e;
          if (Object.keys(errors).length === 2) { settled = true; reject(errors.native); }
        });
      }
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        for (const j of Object.values(jobs)) j.cancel();
        rejectRace(cancelledError());
      },
    };
  }

  renderNative(model, values, onEvent = () => {}) {
    const job = `j${Date.now().toString(36)}${(this.n++).toString(36)}`;
    const started = performance.now();
    let meta = null;
    let rejectRun;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      rejectRun = reject;
      if (!this.info.engine) {
        reject(Object.assign(new Error(this.info.engine_error || "OpenSCAD isn't available."), { logs: [] }));
        return;
      }
      const channel = new tauri.core.Channel();
      channel.onmessage = (m) => { if (m?.type === "done") meta = m; else onEvent(m); };
      const req = {
        model: model.key, entry: model.entry,
        files: { ...this.common, ...model.files },
        values: { ...values, ...(model.fixed || {}) },
        defines: (model.parameters || []).filter((p) => p.define).map((p) => p.name),
      };
      invoke("render", { job, req, onEvent: channel }).then((buf) => {
        settled = true;
        const ms = meta?.ms ?? performance.now() - started;
        resolve({ blob: new Blob([buf], { type: "model/stl" }), ms, cached: meta ? !!meta.cached : ms < 40, logs: meta?.logs || [], engine: "native" });
      }, (e) => {
        settled = true;
        reject(Object.assign(new Error(e?.message || String(e)), { logs: e?.logs || [], cancelled: !!e?.cancelled }));
      });
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        invoke("render_cancel", { job }).catch(() => {});
        rejectRun(cancelledError());
      },
    };
  }
}

export async function createPlatform() {
  const info = await invoke("app_info").catch((e) => ({ engine_error: String(e) }));
  let prefs = await invoke("prefs_get").catch(() => ({}));
  let timer = null;
  const settings = {
    async persistent() { return true; },
    list: (model) => invoke("settings_list", { model }),
    get: (id) => invoke("settings_get", { id }),
    async save(rec) {
      const now = new Date().toISOString();
      const old = rec.id ? await invoke("settings_get", { id: rec.id }) : null;
      const row = old ? { ...old, ...rec, updated: now }
        : { id: newId(), model: rec.model, name: rec.name, values: rec.values, created: now, updated: now };
      await invoke("settings_put", { record: row });
      return row;
    },
    remove: (id) => invoke("settings_remove", { id }),
  };
  const store = {
    kind: "desktop",
    prefs: {
      get(key, fallback = null) { return key in prefs ? prefs[key] : fallback; },
      set(key, value) {
        prefs = { ...prefs, [key]: value };
        clearTimeout(timer);
        timer = setTimeout(() => invoke("prefs_set", { prefs }).catch(() => {}), 250);
      },
    },
    settings,
  };
  return {
    kind: "desktop",
    info,
    store,
    makeEngine: (catalog) => new DesktopEngine(info, catalog, store.prefs),
    /** Bundled site files (data/, parts/) instead of fetching relative URLs. */
    async fetch(path) {
      try {
        const buf = await invoke("site_read", { path: path.replace(/^\.?\//, "") });
        const ext = path.split(".").pop().toLowerCase();
        return new Response(buf, { status: 200, headers: { "content-type": MIME[ext] || "application/octet-stream" } });
      } catch (e) {
        return new Response(String(e), { status: 404 });
      }
    },
    /** Save dialog + write. Resolves to the saved path, or null if cancelled. */
    async save(blob, name) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return invoke("save_file", bytes, { headers: { "x-name": encodeURIComponent(name) } });
    },
    reveal: (path) => invoke("reveal", { path }),
    async refreshInfo() { Object.assign(info, await invoke("app_info")); return info; },
    workspace: {
      choose: () => invoke("workspace_choose"),
      open: () => invoke("workspace_open"),
      clearCache: () => invoke("cache_clear"),
    },
  };
}
