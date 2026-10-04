// Chooses the render engine and storage for where the page is running.
// Everything else in web/ talks only to these two interfaces, so the same
// front end works on the website and in the desktop app (docs/DESKTOP_PLAN.md).
//
// createPlatform() -> { kind, store, makeEngine(catalog) }
//
// engine (from makeEngine)
//   render(model, values, onEvent) -> { promise, cancel }
//     model:   built model JSON (data/models/<key>.json): key, entry, files, fixed, parameters
//     values:  { name: value } for the model's settings
//     onEvent: { type: "stage", stage } | { type: "log", line }
//     promise: resolves { blob (STL), ms, logs, cached }; rejects Error with .logs or .cancelled
//   label: short text for the header ("OpenSCAD 2026.10.02, in your browser")
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
    makeEngine(catalog) {
      const engine = new EngineClient({ commonFiles: catalog.common_files });
      engine.label = `OpenSCAD ${catalog.engine}, in your browser`;
      return engine;
    },
  };
}
