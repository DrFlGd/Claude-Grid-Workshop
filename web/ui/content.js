// Pictures you choose and content you add (milestone 6, docs/DESKTOP_PLAN.md "Milestone 6 design").
// Choose picture… shows every picture there is to choose as a picture: the render, the project's
// own pictures, its items' thumbnails (a project) and those you added. Add content… copies a file
// into the library (or keeps a link), shown in the side viewer beside the project's documents.
import { html, useState, useEffect } from "../lib/html.js";
import { ui } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";

const api = (cmd, args) => ctx.platform.api(cmd, args);
const toastErr = (what) => (e) => ctx.toast(`${what}: ${e?.message || e}`);

/** spec: { source, level: project|item|part, target?, name, current (the icon now, or null) } */
export function PictureDialog({ spec }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const close = () => ui.set({ dialog: null });
  useEffect(() => {
    api("pictures_list", { source: spec.source }).then(setList, (e) => setList({ error: String(e.message || e) }));
  }, [spec.source]);
  const choose = async (icon) => {
    setBusy(true);
    try {
      await api("meta_set", { source: spec.source, level: spec.level, target: spec.target, patch: { icon } });
      await ctx.reloadCatalog();
      close();
      ctx.toast(icon ? "Picture chosen." : "The render is shown again.");
    } catch (e) { toastErr("Couldn't choose it")(e); } finally { setBusy(false); }
  };
  const add = async () => {
    const path = await ctx.platform.library.pickFile("Choose a picture", ["png", "jpg", "jpeg", "webp", "gif"]);
    if (!path) return;
    try { await choose((await api("picture_add", { source: spec.source, path })).icon); } catch (e) { toastErr("Couldn't add it")(e); }
  };
  // a project can also show one of its items' thumbnails
  const items = spec.level === "project"
    ? (ctx.index?.items || []).filter((i) => i.sourceId === spec.source && i.thumb && !i.hidden).slice(0, 60).map((i) => ({
      value: `item:${i.sourceId}/${i.kind === "part" ? `part-${i.key.split("/")[1]}` : i.key.split("/")[1]}`, url: i.thumb, path: i.name }))
    : [];
  const tile = (c) => html`<button type="button" class=${`pic-tile${(spec.current || null) === c.value ? " on" : ""}`} key=${c.value || "render"}
      data-pic=${c.value || ""} title=${c.path || "The render"} disabled=${busy} onClick=${() => choose(c.value)}>
      ${c.url ? html`<img src=${c.url} alt="" loading="lazy" />` : html`<span class="pic-render">${Icon.box(28)}</span>`}
      <span class="pic-name">${c.value ? (c.path || "").split("/").pop() : "The render"}</span></button>`;
  const section = (title, cs) => (cs.length ? html`<h3>${title}</h3><div class="pic-grid">${cs.map(tile)}</div>` : null);
  return html`<div class="dialog picture-dialog" aria-label="Choose picture">
    <div class="dialog-head"><h2>Choose a picture for ${spec.name}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    ${!list ? html`<p class="muted">Loading…</p>` : list.error ? html`<p class="muted">${list.error}</p>` : html`<div class="pic-scroll">
      <div class="pic-grid">${tile({ value: null })}
        <button type="button" class="pic-tile pic-add" id="pic-add" disabled=${busy} onClick=${add}><span class="pic-render">${Icon.plus(24)}</span><span class="pic-name">Add a picture…</span></button></div>
      ${section("Pictures you added", list.added)}
      ${section("In the project's files", list.files)}
      ${section("Its items", items)}
      ${!list.files.length && !items.length && !list.added.length ? html`<p class="muted">The project has no pictures of its own. Add one from your computer, and it's copied into the library.</p>` : null}
    </div>`}
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Close</button></div>
  </div>`;
}

/** spec: { source, level: project|item|part, target?, name } */
export function ContentDialog({ spec }) {
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => ui.set({ dialog: null });
  const pick = async () => {
    const p = await ctx.platform.library.pickFile("Choose a file to add", []);
    if (p) { setPath(p); setUrl(""); }
  };
  const save = async (e) => {
    e.preventDefault();
    if (!path && !url.trim()) return;
    setBusy(true);
    try {
      const r = await api("attachment_add", { source: spec.source, level: spec.level, target: spec.target, path: path || null, url: path ? null : url.trim(), name: name.trim() || null });
      await ctx.reloadCatalog();
      close();
      ctx.toast(`Added ${r.name}. It's in the side panel on the right.`);
    } catch (err) { toastErr("Couldn't add it")(err); } finally { setBusy(false); }
  };
  return html`<form class="dialog content-dialog" onSubmit=${save} aria-label="Add content">
    <div class="dialog-head"><h2>Add content to ${spec.name}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <p class="muted">A build video, an assembly guide, photos, a link: kept with ${spec.level === "project" ? "the project" : "it"} in your library and shown beside its documents. Files are copied in.</p>
    <div class="field-block"><span>A file</span>
      <div class="pick-row"><code class="pick-path" id="content-path" title=${path || null}>${path || "Nothing chosen"}</code>
        <button type="button" class="ghost" id="content-pick" onClick=${pick}>Choose…</button></div></div>
    <label class="field-block"><span>Or a link</span>
      <input id="content-url" type="url" value=${url} disabled=${!!path} onInput=${(e) => setUrl(e.target.value)} /></label>
    <label class="field-block"><span>Name</span>
      <input id="content-name" value=${name} onInput=${(e) => setName(e.target.value)} maxlength="100" /></label>
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="submit" class="primary" id="content-add" disabled=${busy || (!path && !url.trim())}>Add</button></div>
  </form>`;
}
