// Mounts the interface islands into the page. The workbench (model form and
// 3D view), the parts page and the text pages stay as they were (app.js).
import { html, render } from "../lib/html.js";
import { ui, initState } from "./state.js";
import { setContext } from "./context.js";
import { Sidebar } from "./sidebar.js";
import { Browser } from "./browser.js";
import { Palette } from "./palette.js";
import { QuickLook } from "./quicklook.js";
import { TopSearch, TopButtons, Tabs, StatusBar } from "./chrome.js";

export function mountShell(context) {
  setContext(context);
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
}

export { ui };
