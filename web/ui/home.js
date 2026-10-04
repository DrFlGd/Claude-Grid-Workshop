// Home: continue where you left off, favourites, categories to browse, and what needs attention.
import { html } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { scopeInfo } from "./sidebar.js";

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
  const { index, catalog, libraries, platform } = ctx;
  const recent = s.recent.map((r) => ({ ...index.get(r.id), t: r.t })).filter((i) => i.id).slice(0, 8);
  const favs = s.favs.map((id) => index.get(id)).filter(Boolean);
  const tile = (scope, label, sub, thumb) => html`<a class="tile" href=${scopeHash(scope)} data-scope=${scope}>
    <span class="thumb">${thumb ? html`<img src=${thumb} alt="" loading="lazy" />` : null}</span>
    <b>${label}</b><span class="muted">${sub}</span></a>`;
  const firstThumb = (pred) => index.items.find((i) => pred(i) && i.thumb)?.thumb;
  const attention = scopeInfo("attention").query.ids;
  const attentionProjects = [...new Set(attention.map((id) => index.get(id).project))];
  const gens = index.items.filter((i) => i.kind === "generator").length;
  return html`<div class="home">
    <header class="home-head">
      <h1>Make things that fit</h1>
      <p>Pick a generator, set the sizes and save a print-ready file. ${gens} generators and ${index.items.length - gens} ready-made parts, made
        ${platform.kind === "desktop" ? " on this computer" : " right here in your browser"} with OpenSCAD. Every model is open work, credited to its author.</p>
    </header>
    ${recent.length ? html`<section><h2>Continue</h2><div class="home-recent">
      ${recent.map((i) => html`<a class="recent" href=${i.href} key=${i.id}>
        <span class="thumb">${i.thumb ? html`<img src=${i.thumb} alt="" loading="lazy" />` : null}</span>
        <span><b>${i.name}</b><span class="muted">${i.project} · ${ago(i.t)}</span></span></a>`)}
    </div></section>` : null}
    <section><h2>Browse</h2><div class="home-tiles">
      ${catalog.categories.map((c) => tile(`cat:${c.id}`, c.label, `${c.models.length} generators`, firstThumb((i) => i.category === c.id)))}
      ${libraries.map((l) => tile(`lib:${l.id}`, l.name, `${l.items.length} ready-made parts`, firstThumb((i) => i.projectId === l.id && i.kind === "part")))}
    </div></section>
    <div class="home-pair">
      <section class="home-card"><h2>Favourites</h2>
        ${favs.length ? html`<div class="home-favs">${favs.slice(0, 12).map((i) => html`<a href=${i.href} title=${`${i.name}, ${i.project}`} key=${i.id}>
          <span class="thumb">${i.thumb ? html`<img src=${i.thumb} alt=${i.name} loading="lazy" />` : i.name}</span></a>`)}</div>
          ${favs.length > 12 ? html`<a href=${scopeHash("favs")}>All ${favs.length} favourites</a>` : null}`
          : html`<p class="muted">Star a generator or part (or select it and press F) to keep it here.</p>`}
      </section>
      ${attentionProjects.length ? html`<section class="home-card attention"><h2>Needs attention</h2>
        <p class="muted">License or author not stated, or not cleared for sharing. Check before sharing or selling prints.</p>
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
