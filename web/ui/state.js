// Interface state shared by the islands (sidebar, browser, inspector, tabs,
// status bar, palette, quick look). Preferences persist through the platform's
// store: browser storage on the website, the workspace folder in the app.
import { createStore } from "../lib/store.js";

export const ui = createStore({
  ready: false,
  view: "browse",          // browse | model | library | about (which main view is showing)
  scope: "home",           // home | all | cat:<id> | project:<id> | parts | lib:<id> | favs | recent | attention
  q: "",                   // search text (may contain typed filters)
  filters: {},             // chip filters: { kind: [], cat: [], project: [], license: [] }
  layout: "grid",          // grid | list | table | grouped
  size: "m",               // thumbnail size in the grid: s | m | l
  sort: "default",
  group: "none",           // none | project | cat | kind | license
  columns: ["project", "categoryLabel", "license", "settings", "updated"],
  selection: [],           // selected item ids
  anchor: null,            // last clicked id (for shift-click ranges)
  favs: [],
  recent: [],              // [{ id, t }], newest first
  tabs: [],                // open model keys
  activeTab: null,
  jobs: [],                // [{ id, label, started, cancel }]
  theme: "system",
  quicklook: null,         // item id
  palette: false,
  navOpen: false,          // sidebar drawer on small screens
  catPanel: true,          // the category panel beside the menu is open (false: folded to a strip)
  side: { open: false, tab: "code", width: 560, wrap: false }, // the side viewer (code, documents)
  sideFile: null,          // a project file shown in the side viewer's Code tab: { rel, label, ref }
  inspector: true,
  condensed: false,        // grouped results shown as one tile per group
  openGroup: null,         // the condensed group being looked into
  showHidden: false,       // list hidden items and projects too
  catalogVersion: 0,       // bumps when the catalog is reloaded (desktop: library changes)
  dialog: null,            // { type: "add-project" | "edit" | "merge", ... }
  undo: [],                // [{ label, run }] newest last (metadata edits)
});

let prefs = null;
const LAYOUT_KEY = "gw-ui";

/** Load saved preferences (call once the platform store exists). */
export function initState(store) {
  prefs = store.prefs;
  const saved = prefs.get(LAYOUT_KEY, {}) || {};
  ui.set({
    favs: prefs.get("gw-favs", []) || [],
    recent: prefs.get("gw-recent", []) || [],
    tabs: prefs.get("gw-tabs", []) || [],
    theme: saved.theme || "system",
    size: saved.size || "m",
    sort: saved.sort || "default",
    group: saved.group || "none",
    columns: saved.columns || ui.get().columns,
    inspector: saved.inspector !== false,
    layouts: saved.layouts || {},
    condensed: !!saved.condensed,
    catPanel: saved.catPanel !== false,
    side: { ...ui.get().side, ...(saved.side || {}) },
  });
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
}

function savePrefs() {
  const s = ui.get();
  prefs?.set(LAYOUT_KEY, { theme: s.theme, size: s.size, sort: s.sort, group: s.group, columns: s.columns, inspector: s.inspector, layouts: s.layouts, condensed: s.condensed, catPanel: s.catPanel, side: s.side });
}

export function setPref(patch) {
  ui.set(patch);
  savePrefs();
}

/** The view (grid, list, table, grouped) is remembered per place. */
export function layoutFor(scope) {
  const s = ui.get();
  if (s.layouts?.[scope]) return s.layouts[scope];
  return scope === "parts" || scope.startsWith("lib:") ? "grid" : scope === "attention" ? "table" : "grid";
}
export function setLayout(layout) {
  const s = ui.get();
  ui.set({ layout, layouts: { ...(s.layouts || {}), [s.scope]: layout } });
  savePrefs();
}

export const THEMES = [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"], ["night", "Night (dim, warm, for a dark workshop)"]];

/** The theme in use: light, dark or night ("system" resolves to light or dark). */
export function resolvedTheme() {
  const t = ui.get().theme;
  if (t === "system") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return t;
}
export const isDark = () => resolvedTheme() !== "light";
export function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  window.dispatchEvent(new CustomEvent("gw-theme"));
}
/** Top-bar button: light -> dark -> night -> light. */
export function cycleTheme() {
  const next = { light: "dark", dark: "night", night: "light" }[resolvedTheme()];
  setTheme(next);
}
export function setTheme(theme) {
  setPref({ theme });
  applyTheme();
}

export function toggleFav(ids) {
  const s = ui.get();
  const all = ids.every((id) => s.favs.includes(id));
  const favs = all ? s.favs.filter((f) => !ids.includes(f)) : [...s.favs, ...ids.filter((id) => !s.favs.includes(id))];
  ui.set({ favs });
  prefs?.set("gw-favs", favs);
}

export function recordRecent(id) {
  const recent = [{ id, t: Date.now() }, ...ui.get().recent.filter((r) => r.id !== id)].slice(0, 40);
  ui.set({ recent });
  prefs?.set("gw-recent", recent);
}

export function setTabs(tabs, activeTab = ui.get().activeTab) {
  ui.set({ tabs, activeTab });
  prefs?.set("gw-tabs", tabs);
}

let jobSeq = 0;
/** Background work shown in the status bar. Returns a function that removes it;
 *  its .update(label) changes the text shown. */
export function addJob(label, cancel) {
  const job = { id: ++jobSeq, label, started: Date.now(), cancel };
  ui.set((s) => ({ jobs: [...s.jobs, job] }));
  const done = () => ui.set((s) => ({ jobs: s.jobs.filter((j) => j.id !== job.id) }));
  done.update = (text) => ui.set((s) => ({ jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, label: text } : j)) }));
  return done;
}

/** Remember how to undo an edit (Ctrl+Z, or the toast's Undo). */
export function pushUndo(label, run) {
  ui.set((s) => ({ undo: [...s.undo.slice(-49), { label, run }] }));
}
export async function undoLast() {
  const s = ui.get();
  const last = s.undo[s.undo.length - 1];
  if (!last) return null;
  ui.set({ undo: s.undo.slice(0, -1) });
  await last.run();
  return last.label;
}
