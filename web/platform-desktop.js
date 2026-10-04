// Desktop app side of web/platform.js: native OpenSCAD and the workspace folder,
// reached through the Tauri commands in desktop/src-tauri/src/main.rs.

const tauri = globalThis.__TAURI__;
const invoke = (cmd, args, opts) => tauri.core.invoke(cmd, args, opts);

const MIME = { json: "application/json", stl: "model/stl", "3mf": "model/3mf", png: "image/png", svg: "image/svg+xml" };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

class DesktopEngine {
  constructor(info, catalog) {
    this.common = catalog.common_files || {};
    this.info = info;
    this.concurrency = info.concurrency || 1;
    this.label = info.engine ? `OpenSCAD ${info.engine}, native` : "OpenSCAD not available";
    this.n = 0;
  }

  render(model, values, onEvent = () => {}) {
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
        resolve({ blob: new Blob([buf], { type: "model/stl" }), ms, cached: meta ? !!meta.cached : ms < 40, logs: meta?.logs || [] });
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
        rejectRun(Object.assign(new Error("Render cancelled."), { cancelled: true }));
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
    makeEngine: (catalog) => new DesktopEngine(info, catalog),
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
