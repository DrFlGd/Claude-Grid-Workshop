// Browser storage for the site: small preferences in localStorage, saved
// settings in IndexedDB. The desktop app provides the same interface backed by
// files in the workspace folder (see platform.js for the contract).

const DB_NAME = "claude-grid-workshop"; // the name from before the rename to SCAD Workshop; kept so saved settings stay
const DB_VERSION = 1;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "id" }).createIndex("model", "model");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Storage is busy in another tab."));
  });
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Same interface as the IndexedDB store, kept in memory (private windows etc.). */
class MemorySettings {
  constructor() { this.rows = new Map(); this.persistent = false; }
  async list(model) { return [...this.rows.values()].filter((r) => r.model === model).sort(byName); }
  async get(id) { return this.rows.get(id) || null; }
  async put(row) { this.rows.set(row.id, row); return row; }
  async remove(id) { this.rows.delete(id); }
}

class IDBSettings {
  constructor(db) { this.db = db; this.persistent = true; }
  tx(mode) { return this.db.transaction("settings", mode).objectStore("settings"); }
  async list(model) { return (await done(this.tx("readonly").index("model").getAll(model))).sort(byName); }
  async get(id) { return (await done(this.tx("readonly").get(id))) || null; }
  async put(row) { await done(this.tx("readwrite").put(row)); return row; }
  async remove(id) { await done(this.tx("readwrite").delete(id)); }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export class BrowserStore {
  constructor() {
    this.kind = "browser";
    this.prefs = {
      get(key, fallback = null) {
        let v;
        try { v = localStorage.getItem(key); } catch { return fallback; }
        if (v == null) return fallback;
        try { return JSON.parse(v); } catch { return v; } // values written before this store existed are plain strings
      },
      set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep for this visit only */ }
      },
    };
    this._backend = openDB().then((db) => new IDBSettings(db)).catch(() => new MemorySettings());
    const backend = () => this._backend;
    this.settings = {
      /** True when saved settings survive closing the tab. */
      async persistent() { return (await backend()).persistent; },
      async list(model) { return (await backend()).list(model); },
      async get(id) { return (await backend()).get(id); },
      /** Create ({model, name, values, edits?}) or update ({id, ...changes}); returns the stored record.
       *  edits: the Code tab's edited files, { path: { text, base } } (null: none). */
      async save(rec) {
        const b = await backend();
        const now = new Date().toISOString();
        const old = rec.id ? await b.get(rec.id) : null;
        const row = old ? { ...old, ...rec, updated: now }
          : { id: newId(), model: rec.model, name: rec.name, values: rec.values, ...(rec.edits ? { edits: rec.edits } : {}), created: now, updated: now };
        return b.put(row);
      },
      async remove(id) { return (await backend()).remove(id); },
    };
  }
}
