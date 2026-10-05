// Home: continue where you left off, favourites, the categories of Parametric
// Models and the Parts Library to browse, and what needs attention.
import { html } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { scopeInfo } from "./sidebar.js";
import { plural } from "../lib/util.js";
import { Icon } from "./icons.js";

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

export function Home() {
  const s = useStore(ui, (st) => ({ favs: st.favs, recent: st.recent }));
  const { index, catalog, platform } = ctx;
  const recent = s.recent.map((r) => ({ ...index.get(r.id), t: r.t })).filter((i) => i.id).slice(0, 8);
  const favs = s.favs.map((id) => index.get(id)).filter(Boolean);
  const tile = (scope, label, sub, thumb) => html`<a class="tile" href=${scopeHash(scope)} data-scope=${scope}>
    <span class="thumb">${thumb ? html`<img src=${thumb} alt="" loading="lazy" />` : null}</span>
    <b>${label}</b><span class="muted">${sub}</span></a>`;
  const shown = index.items.filter((i) => !i.hidden);
  const firstThumb = (pred) => shown.find((i) => pred(i) && i.thumb)?.thumb;
  const attention = scopeInfo("attention").query.ids;
  const attentionProjects = [...new Set(attention.map((id) => index.get(id).project))];
  const gens = shown.filter((i) => i.kind === "generator").length;
  const parts = shown.filter((i) => i.kind === "part").length;
  /** Category tiles for one kind, in the library's category order. */
  const categories = (kind) => {
    const counts = new Map();
    for (const i of shown) if (i.kind === kind) counts.set(i.category, { label: i.categoryLabel, n: (counts.get(i.category)?.n || 0) + 1 });
    const order = (kind === "component" ? catalog.component_groups || [] : catalog.category_choices || catalog.categories || []).map((c) => c.id);
    const rank = (id) => (id === "other" ? 1e6 : order.includes(id) ? order.indexOf(id) : 1e5);
    const scope = { part: "pcat", component: "ccat" }[kind] || "cat";
    const noun = { part: "part", component: "component" }[kind] || "model";
    return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([id, c]) =>
      tile(`${scope}:${id}`, c.label, plural(c.n, noun), firstThumb((i) => i.kind === kind && i.category === id)));
  };
  const comps = shown.filter((i) => i.kind === "component").length;
  return html`<div class="home">
    <header class="home-head">
      <h1>Make things that fit</h1>
      <p>Pick a model, set the sizes and save a print-ready file. ${plural(gens, "parametric model")} and ${plural(parts, "part")}, made
        ${platform.kind === "desktop" ? " on this computer" : " right here in your browser"} with OpenSCAD. Every model is open work, credited to its author.</p>
      ${platform.kind === "desktop" && !catalog.library?.read_only ? html`<div class="home-actions">
        <button type="button" class="primary" id="home-add-project" onClick=${() => ui.set({ dialog: { type: "add-project" } })}>${Icon.plus(16)} Add a project</button>
        <span class="muted">From a GitHub link, a ZIP file or a folder. Its models and parts join the library.</span>
      </div>` : null}
    </header>
    ${recent.length ? html`<section><h2>Continue</h2><div class="home-recent">
      ${recent.map((i) => html`<a class="recent" href=${i.href} key=${i.id}>
        <span class="thumb">${i.thumb ? html`<img src=${i.thumb} alt="" loading="lazy" />` : null}</span>
        <span><b>${i.name}</b><span class="muted">${i.project} · ${ago(i.t)}</span></span></a>`)}
    </div></section>` : null}
    <section><h2>Parametric Models</h2><div class="home-tiles">${categories("generator")}</div></section>
    ${comps ? html`<section data-home="components"><h2>Components</h2>
      <p class="muted section-note">Modules from ${(catalog.component_libraries || []).filter((l) => l.active).map((l) => l.name).join(", ")}, as forms. Search for one (“bevel gear”, “threaded rod”) or pick a topic.</p>
      <div class="home-tiles">${categories("component")}</div></section>` : null}
    ${parts ? html`<section><h2>Parts Library</h2><div class="home-tiles">${categories("part")}</div></section>` : null}
    <div class="home-pair">
      <section class="home-card"><h2>Favourites</h2>
        ${favs.length ? html`<div class="home-favs">${favs.slice(0, 12).map((i) => html`<a href=${i.href} title=${`${i.name}, ${i.project}`} key=${i.id}>
          <span class="thumb">${i.thumb ? html`<img src=${i.thumb} alt=${i.name} loading="lazy" />` : i.name}</span></a>`)}</div>
          ${favs.length > 12 ? html`<a href=${scopeHash("favs")}>All ${favs.length} favourites</a>` : null}`
          : html`<p class="muted">Star a model or part (or select it and press F) to keep it here.</p>`}
      </section>
      ${attentionProjects.length ? html`<section class="home-card attention"><h2>Needs attention</h2>
        <p class="muted">Flagged as broken, or license or author not stated or not cleared for sharing. Check before sharing or selling prints.</p>
        <p>${attentionProjects.join(" · ")}</p>
        <a href=${scopeHash("attention")}>Show ${attention.length} items</a>
      </section>` : null}
    </div>
    <footer class="site-footer">
      <a href="#/licenses">Licenses & credits</a>
      <span>Every model is open work by its author. See each project's license before sharing or selling prints.</span>
    </footer>
  </div>`;
}
