// Sidebar: Home, Recent, Favourites, generators by category and project,
// ready-made parts, "Needs attention", and links to Settings and Licenses.
import { html, useState } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { Icon } from "./icons.js";

export function scopeInfo(scope) {
  const { catalog, libraries, index } = ctx;
  const s = ui.get();
  if (scope === "home") return { label: "Home" };
  if (scope === "search") return { label: "Search", query: {} };
  if (scope === "all") return { label: "All generators", query: { kind: "generator" } };
  if (scope === "favs") return { label: "Favourites", query: { ids: s.favs }, sort: "given" };
  if (scope === "recent") return { label: "Recent", query: { ids: s.recent.map((r) => r.id) }, sort: "given" };
  if (scope === "parts") return { label: "Ready-made parts", query: { kind: "part" } };
  if (scope === "attention") {
    const ids = index.items.filter((i) => i.licenseStatus !== "ok").map((i) => i.id);
    return { label: "Needs attention", note: "License or author not stated, or not cleared for sharing. Check before sharing or selling prints.", query: { ids } };
  }
  const [kind, id] = scope.split(":");
  if (kind === "cat") return { label: catalog.categories.find((c) => c.id === id)?.label || id, query: { kind: "generator", category: id } };
  if (kind === "project") {
    const fam = catalog.families.find((f) => f.id === id);
    return { label: fam?.name || id, query: { kind: "generator", project: id }, project: fam };
  }
  if (kind === "lib") return { label: libraries.find((l) => l.id === id)?.name || id, query: { kind: "part", project: id } };
  return { label: scope, query: {} };
}

function count(query) {
  return ctx.index.query({ scope: query }).total;
}

function Row({ scope, label, n, icon, depth = 0, expand, open, onToggle, current }) {
  const active = current === scope;
  return html`<li class="nav-row" style=${`--depth:${depth}`}>
    ${expand ? html`<button type="button" class="nav-toggle" aria-expanded=${open ? "true" : "false"} aria-label=${`${open ? "Collapse" : "Expand"} ${label}`}
      onClick=${onToggle}>${Icon.chevron(12)}</button>` : html`<span class="nav-toggle-space"></span>`}
    <a href=${scopeHash(scope)} class=${`nav-link${active ? " active" : ""}`} aria-current=${active ? "page" : null}
      onClick=${() => ui.set({ navOpen: false })} data-scope=${scope}>
      ${icon ? html`<span class="nav-icon">${icon}</span>` : null}<span class="nav-label">${label}</span>${n != null ? html`<span class="nav-count">${n}</span>` : null}
    </a>
  </li>`;
}

export function Sidebar() {
  const s = useStore(ui, (st) => ({ scope: st.scope, view: st.view, favs: st.favs.length, recent: st.recent.length, ready: st.ready, navOpen: st.navOpen }));
  const [open, setOpen] = useState(() => ({}));
  if (!s.ready) return null;
  const { catalog, libraries } = ctx;
  const current = s.view === "browse" ? s.scope : null;
  const toggle = (k) => () => setOpen({ ...open, [k]: !open[k] });
  const fams = (catId) => {
    const keys = new Set(catalog.categories.find((c) => c.id === catId)?.models || []);
    const ids = [...new Set(catalog.models.filter((m) => keys.has(m.key)).map((m) => m.family))];
    return ids.map((id) => catalog.families.find((f) => f.id === id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  };
  const attention = count(scopeInfo("attention").query);
  return html`${s.navOpen ? html`<div class="nav-backdrop" onClick=${() => ui.set({ navOpen: false })}></div>` : null}
  <nav class=${`sidebar${s.navOpen ? " open" : ""}`} aria-label="Library"
    onKeyDown=${(e) => { if (e.key === "Escape" && ui.get().navOpen) ui.set({ navOpen: false }); }}>
    <ul class="nav-list">
      <${Row} scope="home" label="Home" icon=${Icon.home(15)} current=${current} />
      <${Row} scope="recent" label="Recent" n=${s.recent} icon=${Icon.clock(15)} current=${current} />
      <${Row} scope="favs" label="Favourites" n=${s.favs} icon=${Icon.star(15)} current=${current} />
    </ul>
    <h2 class="nav-head">Generators</h2>
    <ul class="nav-list">
      <${Row} scope="all" label="All generators" n=${count({ kind: "generator" })} current=${current} />
      ${catalog.categories.map((c) => html`
        <${Row} scope=${`cat:${c.id}`} label=${c.label} n=${count({ kind: "generator", category: c.id })} current=${current}
          expand=${true} open=${open[c.id]} onToggle=${toggle(c.id)} />
        ${open[c.id] ? fams(c.id).map((f) => html`<${Row} scope=${`project:${f.id}`} label=${f.name} depth=${1}
          n=${count({ kind: "generator", project: f.id })} current=${current} />`) : null}`)}
    </ul>
    ${libraries.length ? html`<h2 class="nav-head">Library</h2>
      <ul class="nav-list">
        <${Row} scope="parts" label="Ready-made parts" n=${count({ kind: "part" })} icon=${Icon.box(15)} current=${current}
          expand=${libraries.length > 0} open=${open.__parts} onToggle=${toggle("__parts")} />
        ${open.__parts ? libraries.map((l) => html`<${Row} scope=${`lib:${l.id}`} label=${l.name} depth=${1} n=${l.items.length} current=${current} />`) : null}
      </ul>` : null}
    ${attention ? html`<ul class="nav-list nav-attention">
      <${Row} scope="attention" label="Needs attention" n=${attention} icon=${Icon.alert(15)} current=${current} />
    </ul>` : null}
    <ul class="nav-list nav-foot">
      <li><a class="nav-link" href="#/settings" onClick=${() => ui.set({ navOpen: false })}><span class="nav-icon">${Icon.gear(15)}</span><span class="nav-label">Settings</span></a></li>
      <li><a class="nav-link" href="#/licenses" onClick=${() => ui.set({ navOpen: false })}><span class="nav-icon"></span><span class="nav-label">Licenses & credits</span></a></li>
    </ul>
  </nav>`;
}
