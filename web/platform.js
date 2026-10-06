// Chooses the render engine and storage for where the page is running.
// Everything else in web/ talks only to these two interfaces, so the same
// front end works on the website and in the desktop app (docs/DESKTOP_PLAN.md).
//
// createPlatform() -> { kind, store, makeEngine(catalog), fetch(path), modelFile(sha), openUrl(url), save?(blob, name) }
//   fetch: site files (data/, parts/) by relative path; the desktop app reads them from its bundle
//   modelFile: a model file's text by its content hash (the side viewer's Code tab)
//   save:  desktop only; a save dialog instead of a browser download
//
// engine (from makeEngine)
//   render(model, values, onEvent) -> { promise, cancel }
//     model:   built model JSON (data/models/<key>.json): key, entry, files, fixed, parameters
//     values:  { name: value } for the model's settings
//     onEvent: { type: "stage", stage } | { type: "log", line }
//     promise: resolves { blob (STL), ms, logs, cached }; rejects Error with .logs or .cancelled
//   label: short text for the header ("OpenSCAD 2026.10.02, in your browser")
//   concurrency: how many renders can run at once (batches use it)
//
// store
//   prefs.get(key, fallback) / prefs.set(key, value)   small UI preferences, synchronous
//   settings.list(modelKey) -> [{ id, model, name, values, created, updated }]
//   settings.get(id) / settings.save(record) / settings.remove(id)
//   settings.persistent() -> whether saved settings outlive the session
//   Saved values hold only the settings that differ from the model's defaults.
import { EngineClient } from "./engine-client.js";
import { BrowserStore } from "./store-browser.js";

export async function createPlatform() {
  if (globalThis.__TAURI_INTERNALS__) {
    // desktop build (Phase 1): native OpenSCAD and the workspace folder
    const desktop = await import("./platform-desktop.js");
    return desktop.createPlatform();
  }
  return {
    kind: "browser",
    store: new BrowserStore(),
    fetch: (path) => fetch(path),
    modelFile: async (sha) => {
      const r = await fetch(`fs/${sha}`);
      if (!r.ok) throw new Error(`Couldn't read the file (${r.status}).`);
      return r.text();
    },
    openUrl: (url) => window.open(url, "_blank", "noopener"),
    makeEngine(catalog) {
      const engine = new EngineClient({ commonFiles: catalog.common_files });
      engine.label = `OpenSCAD ${catalog.engine}, in your browser`;
      engine.concurrency = 1; // each WebAssembly render already uses a lot of memory
      return engine;
    },
  };
}
