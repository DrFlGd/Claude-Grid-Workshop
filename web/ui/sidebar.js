// Sidebar: Home, Recent, Favourites; Parametric Models and the Parts Library,
// each as categories (collapsed until opened) with their projects inside;
// "Needs attention"; Add a project (desktop); Settings, Library settings, Licenses.
import { html, useState } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { Icon } from "./icons.js";
import { isDesktop, readOnly, sourceById } from "./library.js";
import { categoryLabel } from "./index-local.js";

/** The name of a project as the index lists it (moved items included). */
function projectName(id, kind) {
  const it = ctx.index.items.find((i) => i.projectId === id && (!kind || i.kind === kind));
  return it?.project || sourceById(id)?.name || ctx.catalog.families?.find((f) => f.id === id)?.name || ctx.libraries?.find((l) => l.id === id)?.name || id;
}

/** Everything that needs a look: licenses not cleared for sharing, and models flagged as broken. */
export const needsAttention = (i) => i.licenseStatus !== "ok" || !!i.broken;

export function scopeInfo(scope) {
  const { catalog, index } = ctx;
  const s = ui.get();
  if (scope === "home") return { label: "Home" };
  if (scope === "search") return { label: "Search", query: {} };
  if (scope === "all") return { label: "Parametric Models", query: { kind: "generator" } };
  if (scope === "parts") return { label: "Parts Library", query: { kind: "part" } };
  if (scope === "favs") return { label: "Favourites", query: { ids: s.favs }, sort: "given" };
  if (scope === "recent") return { label: "Recent", query: { ids: s.recent.map((r) => r.id) }, sort: "given" };
  if (scope === "attention") {
    const ids = index.items.filter((i) => needsAttention(i) && !i.hidden).map((i) => i.id);
    return { label: "Needs attention", note: "Models flagged as broken, and items whose license or author isn't stated or isn't cleared for sharing. Check before sharing or selling prints.", query: { ids } };
  }
  const [kind, id] = scope.split(":");
  if (kind === "cat") return { label: categoryLabel(catalog, id), query: { kind: "generator", category: id } };
  if (kind === "pcat") return { label: `${categoryLabel(catalog, id)} parts`, query: { kind: "part", category: id } };
  if (kind === "project") return { label: projectName(id, "generator"), query: { kind: "generator", project: id } };
  if (kind === "lib") return { label: projectName(id, "part"), query: { kind: "part", project: id } };
  if (kind === "source") return { label: sourceById(id)?.name || projectName(id), query: { project: id }, source: id };
  return { label: scope, query: {} };
}

function count(query) {
  return ctx.index.query({ scope: query }).total;
}

/**
 * One section's categories with their projects: [{ id, label, n, projects: [{ id, name, n }] }],
 * in the library's category order ("Other" last). Hidden items don't count.
 */
function tree(kind) {
  const cats = new Map();
  const perProject = new Map();
  for (const i of ctx.index.items) {
    if (i.kind !== kind || i.hidden) continue;
    perProject.set(i.projectId, (perProject.get(i.projectId) || 0) + 1);
    let c = cats.get(i.category);
    if (!c) cats.set(i.category, (c = { id: i.category, label: i.categoryLabel, n: 0, projects: new Map() }));
    c.n++;
    if (!c.projects.has(i.projectId)) c.projects.set(i.projectId, { id: i.projectId, name: i.project });
  }
  const order = (ctx.catalog.category_choices || ctx.catalog.categories || []).map((c) => c.id);
  const rank = (id) => (id === "other" ? 1e6 : order.includes(id) ? order.indexOf(id) : 1e5);
  return [...cats.values()]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label))
    .map((c) => ({ ...c, projects: [...c.projects.values()].map((p) => ({ ...p, n: perProject.get(p.id) })).sort((a, b) => a.name.localeCompare(b.name)) }));
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

/** A section: "All …", then each category, opening to its projects. */
function Section({ kind, current, open, toggle }) {
  const catScope = kind === "part" ? "pcat" : "cat";
  const projScope = kind === "part" ? "lib" : "project";
  const all = kind === "part" ? "parts" : "all";
  return html`<ul class="nav-list" data-section=${kind}>
    <${Row} scope=${all} label=${kind === "part" ? "All parts" : "All models"} n=${count({ kind })} current=${current}
      icon=${kind === "part" ? Icon.box(15) : Icon.grid(15)} />
    ${tree(kind).map((c) => {
      const key = `${kind}:${c.id}`;
      return html`<${Row} scope=${`${catScope}:${c.id}`} label=${c.label} n=${c.n} current=${current} key=${key}
          expand=${true} open=${open[key]} onToggle=${toggle(key)} />
        ${open[key] ? c.projects.map((p) => html`<${Row} scope=${`${projScope}:${p.id}`} label=${p.name} depth=${1}
          n=${p.n} current=${current} key=${`${key}/${p.id}`} />`) : null}`;
    })}
  </ul>`;
}

export function Sidebar() {
  const s = useStore(ui, (st) => ({ scope: st.scope, view: st.view, favs: st.favs.length, recent: st.recent.length, ready: st.ready, navOpen: st.navOpen, v: st.catalogVersion }));
  const [open, setOpen] = useState(() => ({}));
  if (!s.ready) return null;
  const current = s.view === "browse" ? s.scope : null;
  const toggle = (k) => () => setOpen({ ...open, [k]: !open[k] });
  const hasParts = ctx.index.items.some((i) => i.kind === "part" && !i.hidden);
  const attention = count(scopeInfo("attention").query) + (ctx.catalog.attention || []).filter((a) => a.kind !== "license" && a.kind !== "broken").length;
  const page = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return html`${s.navOpen ? html`<div class="nav-backdrop" onClick=${() => ui.set({ navOpen: false })}></div>` : null}
  <nav class=${`sidebar${s.navOpen ? " open" : ""}`} aria-label="Library"
    onKeyDown=${(e) => { if (e.key === "Escape" && ui.get().navOpen) ui.set({ navOpen: false }); }}>
    <ul class="nav-list">
      <${Row} scope="home" label="Home" icon=${Icon.home(15)} current=${current} />
      <${Row} scope="recent" label="Recent" n=${s.recent} icon=${Icon.clock(15)} current=${current} />
      <${Row} scope="favs" label="Favourites" n=${s.favs} icon=${Icon.star(15)} current=${current} />
    </ul>
    <h2 class="nav-head">Parametric Models</h2>
    <${Section} kind="generator" current=${current} open=${open} toggle=${toggle} />
    ${hasParts ? html`<h2 class="nav-head">Parts Library</h2>
      <${Section} kind="part" current=${current} open=${open} toggle=${toggle} />` : null}
    ${isDesktop() && !readOnly() ? html`<ul class="nav-list nav-add"><li>
      <button type="button" class="nav-link" id="add-project" title="Add a project from GitHub, a ZIP or a folder. Its models and parts appear under Parametric Models and the Parts Library."
        onClick=${() => ui.set({ dialog: { type: "add-project" }, navOpen: false })}><span class="nav-icon">${Icon.plus(15)}</span><span class="nav-label">Add a project</span></button>
    </li></ul>` : null}
    ${attention ? html`<ul class="nav-list nav-attention">
      <${Row} scope="attention" label="Needs attention" n=${attention} icon=${Icon.alert(15)} current=${current} />
    </ul>` : null}
    <ul class="nav-list nav-foot">
      <li><a class=${`nav-link${page === "settings" ? " active" : ""}`} href="#/settings" onClick=${() => ui.set({ navOpen: false })}><span class="nav-icon">${Icon.gear(15)}</span><span class="nav-label">Settings</span></a></li>
      ${isDesktop() ? html`<li><a class=${`nav-link${page === "library-settings" ? " active" : ""}`} href="#/library-settings" id="nav-library-settings" onClick=${() => ui.set({ navOpen: false })}><span class="nav-icon">${Icon.box(15)}</span><span class="nav-label">Library settings</span></a></li>` : null}
      <li><a class="nav-link" href="#/licenses" onClick=${() => ui.set({ navOpen: false })}><span class="nav-icon"></span><span class="nav-label">Licenses & credits</span></a></li>
    </ul>
  </nav>`;
}
