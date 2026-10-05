// Mounts the interface islands into the page. The workbench (model form and
// 3D view), the parts page and the text pages stay as they were (app.js).
import { html, render } from "../lib/html.js";
import { ui, initState } from "./state.js";
import { setContext, ctx } from "./context.js";
import { Sidebar } from "./sidebar.js";
import { Browser } from "./browser.js";
import { Palette } from "./palette.js";
import { QuickLook } from "./quicklook.js";
import { TopSearch, TopButtons, Tabs, StatusBar } from "./chrome.js";
import { useStore } from "../lib/store.js";
import { AddProject, MergeConflicts, makeThumbnails, dailyUpdateCheck, rescanLocal } from "./library.js";
import { MetaEditor, undoNow } from "./metaedit.js";
import { FlagDialog } from "./actions.js";

/** Modal dialogs (desktop): adding a project, editing details, flagging as broken, merge differences. */
function Dialogs() {
  const d = useStore(ui, (s) => s.dialog);
  if (!d) return null;
  const close = (e) => { if (e.target === e.currentTarget) ui.set({ dialog: null }); };
  const body = d.type === "add-project" ? html`<${AddProject} />` : d.type === "edit" ? html`<${MetaEditor} spec=${d} key=${JSON.stringify(d)} />`
    : d.type === "flag" ? html`<${FlagDialog} spec=${d} />` : d.type === "merge" ? html`<${MergeConflicts} result=${d.result} />` : null;
  return html`<div class="dialog-backdrop" onPointerDown=${close} onKeyDown=${(e) => { if (e.key === "Escape") ui.set({ dialog: null }); }}>${body}</div>`;
}

export function mountShell(context) {
  setContext(context);
  window.__workshop = ctx; // for tests (tests/desktop_page.py reads the index and catalog)
  initState(context.platform.store);
  const mount = (id, C) => { const el = document.getElementById(id); if (el) render(html`<${C} />`, el); };
  mount("topsearch", TopSearch);
  mount("topbuttons", TopButtons);
  mount("sidebar-root", Sidebar);
  mount("tabs-root", Tabs);
  mount("view-browse", Browser);
  mount("statusbar", StatusBar);
  mount("palette-root", Palette);
  mount("quicklook-root", QuickLook);
  mount("dialog-root", Dialogs);
  // Ctrl+Z undoes the last edit of details (outside text fields)
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !e.target.closest?.("input, textarea, select, [contenteditable]") && ui.get().undo.length) {
      e.preventDefault();
      undoNow();
    }
  });
  if (context.platform.kind === "desktop") {
    setTimeout(async () => { await rescanLocal(); makeThumbnails(); dailyUpdateCheck(); }, 1500);
  }
}

export { ui };
