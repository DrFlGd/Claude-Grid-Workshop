// Library settings (desktop, #/library-settings): the library folder; projects
// (add, hide, delete); OpenSCAD libraries (bundled or your copy, for Components
// and includes); categories (add, rename, remove); hidden and deleted
// items; the trash folder; defaults; GitHub. Everything here is stored in the
// library folder, so it moves with it (except the GitHub token, kept on this computer).
import { html, useState, useEffect } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui, pushUndo } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { Icon } from "./icons.js";
import { api, runJob, kindText, rescanLocal, when, makeThumbnails } from "./library.js";
import { hideItems, hideProject, deleteProject, restoreItems } from "./actions.js";
import { undoNow } from "./metaedit.js";
import { bytes, plural } from "../lib/util.js";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fail = (e) => ctx.toast(String(e.message || e));

function Section({ id, title, children, intro }) {
  return html`<section class="ls-section" id=${`ls-${id}`}><h2>${title}</h2>${intro ? html`<p class="muted">${intro}</p>` : null}${children}</section>`;
}

// ---------------------------------------------------------------- folder
function Folder({ info, lib, ro }) {
  const [name, setName] = useState(ctx.catalog?.library?.name || "");
  const open = async (path) => {
    if (!path) return;
    try { await api("library_open", { path }); location.reload(); } catch (e) { fail(e); }
  };
  const merge = async () => {
    const path = await ctx.platform.library.pickFolder("Choose the library to merge in");
    if (!path) return;
    try {
      const r = await runJob(api("library_merge", { path }), "Merging a library");
      await ctx.reloadCatalog();
      if (r.conflicts?.length) ui.set({ dialog: { type: "merge", result: r } });
      else ctx.toast(`Merged: ${plural(r.copied.length, "new project")}, ${plural(r.combined.length, "project")} combined, ${plural(r.recipes, "saved setting")}.`);
    } catch (e) { fail(e); }
  };
  return html`<${Section} id="folder" title="Library folder"
    intro="Everything you add, save or edit lives in this folder as plain files. Move it, copy it or sync it, then open it here or on another computer.">
    ${lib.read_only ? html`<p class="lic-summary">${lib.read_only}</p>` : null}
    <p class="path"><code>${lib.path || info.workspace || info.library_error || "not available"}</code></p>
    <div class="button-row">
      <button type="button" class="ghost" onClick=${() => ctx.platform.workspace.open().catch(fail)}>Open folder</button>
      <button type="button" class="ghost" onClick=${async () => open(await ctx.platform.library.pickFolder("Open a library folder (or an empty folder for a new library)"))} id="library-open">Open another library…</button>
      <button type="button" class="ghost" disabled=${ro} onClick=${merge} id="library-merge">Merge a library into this one…</button>
    </div>
    <form class="inline-form" onSubmit=${async (e) => { e.preventDefault(); try { await api("library_rename", { name }); await ctx.reloadCatalog(); ctx.toast("Renamed."); } catch (err) { fail(err); } }}>
      <label>Name <input value=${name} onInput=${(e) => setName(e.target.value)} disabled=${ro} /></label>
      <button type="submit" class="ghost" disabled=${ro}>Rename</button></form>
    ${(info.recent_libraries || []).length > 1 ? html`<p class="muted">Recent: ${(info.recent_libraries || []).filter((p) => p !== lib.path).map((p, i) => html`${i ? ", " : ""}<button type="button" class="link-btn" onClick=${() => open(p)}>${p}</button>`)}</p>` : null}
  </${Section}>`;
}

// ---------------------------------------------------------------- projects
function Projects({ ro }) {
  const sources = (ctx.catalog?.sources || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return html`<${Section} id="projects" title="Projects"
    intro="A project's models are listed under Parametric Models and its parts in the Parts Library, by category. Libraries that other projects include (like BOSL2) are only listed here.">
    <div class="button-row">
      <button type="button" class="ghost" disabled=${ro} onClick=${() => ui.set({ dialog: { type: "add-project" } })} id="settings-add-project">${Icon.plus(14)} Add a project…</button>
      <button type="button" class="ghost" disabled=${ro} onClick=${() => rescanLocal(false)} id="library-rescan">Look for changes</button>
      <button type="button" class="ghost" disabled=${ro} onClick=${async () => { const r = await api("source_restore_starter"); await ctx.reloadCatalog(); ctx.toast(r.installed.length ? `Brought back ${plural(r.installed.length, "project")}.` : "All the starter projects are there."); }}>Bring back starter projects</button>
    </div>
    <p class="muted">Your own projects go in the library's <code>local/</code> folder (one folder each); the app reads them when they change.</p>
    <table class="table-view ls-table" id="ls-project-table"><thead><tr><th>Project</th><th>From</th><th class="num">Items</th><th></th></tr></thead><tbody>
      ${sources.map((s) => html`<tr key=${s.id} data-source=${s.id} data-hidden=${s.hidden ? "" : null}>
        <td><a href=${scopeHash(`source:${s.id}`)}>${s.name}</a>
          ${s.hidden ? html` <span class="badge-mini hidden">hidden</span>` : null}
          ${s.update?.state === "available" ? html` <span class="badge-mini update">update</span>` : null}</td>
        <td class="muted">${kindText(s)}${s.role === "library" ? " · library" : ""}</td>
        <td class="num">${s.role === "library" ? "–" : (s.models || 0) + (s.parts || 0)}</td>
        <td class="ls-actions">
          <button type="button" class="ghost small" disabled=${ro} data-act="hide-project" onClick=${() => hideProject(s.id, !s.hidden)}>${s.hidden ? "Unhide" : "Hide"}</button>
          <button type="button" class="ghost small danger-text" disabled=${ro} data-act="delete-project" onClick=${() => deleteProject(s.id)}>Delete…</button>
        </td></tr>`)}
    </tbody></table>
  </${Section}>`;
}

// ---------------------------------------------------------------- categories
function Categories({ ro }) {
  const cats = ctx.catalog?.category_choices || [];
  const removed = ctx.catalog?.categories_removed || [];
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState(null); // { id, label }
  const [removing, setRemoving] = useState(null); // { id, to }
  const set = async (args, done, undo) => {
    try {
      const r = await api("category_set", args);
      const prev = r.previous || {};
      // undo: put the category's entry back as it was ("" removes a key)
      if (undo) pushUndo(undo, () => api("category_set", { id: args.id, label: prev.label || "", icon: prev.icon || "", moved_to: prev.moved_to || "" }));
      await ctx.reloadCatalog();
      ctx.toast(done, undo ? { label: "Undo", run: undoNow } : null);
    } catch (e) { fail(e); }
  };
  const add = async (e) => {
    e.preventDefault();
    const label = adding.trim();
    if (!label) return;
    const id = slug(label);
    if (!id) return;
    if (cats.some((c) => c.id === id)) { ctx.toast(`There's a category called ${cats.find((c) => c.id === id).label} already.`); return; }
    setAdding("");
    await set({ id, label }, `Added ${label}. Edit a project or item to put things in it.`);
  };
  return html`<${Section} id="categories" title="Categories"
    intro="Both Parametric Models and the Parts Library list things by these categories. Removing one moves its items to another; projects added later that would land in it go there too.">
    <form class="inline-form" onSubmit=${add}>
      <label>New category <input id="category-new" value=${adding} onInput=${(e) => setAdding(e.target.value)} placeholder="Kitchen, Workshop, Toys…" disabled=${ro} /></label>
      <button type="submit" class="ghost" disabled=${ro || !adding.trim()} id="category-add">${Icon.plus(14)} Add</button></form>
    <table class="table-view ls-table" id="ls-category-table"><thead><tr><th>Category</th><th class="num">Models</th><th class="num">Parts</th><th></th></tr></thead><tbody>
      ${cats.map((c) => html`<tr key=${c.id} data-category=${c.id}>
        <td>${editing?.id === c.id ? html`<form class="inline-form tight" onSubmit=${async (e) => { e.preventDefault(); const label = editing.label.trim(); setEditing(null); if (label && label !== c.label) await set({ id: c.id, label }, `Renamed to ${label}.`, `renaming ${c.label}`); }}>
            <input value=${editing.label} onInput=${(e) => setEditing({ ...editing, label: e.target.value })} aria-label="Name" autofocus data-rename-input />
            <button type="submit" class="ghost small">Save</button><button type="button" class="ghost small" onClick=${() => setEditing(null)}>Cancel</button></form>`
          : html`${c.icon ? html`<img class="ls-cat-icon" src=${c.icon} alt="" /> ` : null}${c.label}${c.builtin ? "" : html` <span class="muted">(yours)</span>`}`}</td>
        <td class="num">${c.models || ""}</td><td class="num">${c.parts || ""}</td>
        <td class="ls-actions">
          ${removing?.id === c.id ? html`<span class="ls-move">Move its items to
            <select value=${removing.to} onChange=${(e) => setRemoving({ ...removing, to: e.target.value })} data-move-to>
              ${cats.filter((x) => x.id !== c.id).map((x) => html`<option value=${x.id}>${x.label}</option>`)}</select>
            <button type="button" class="ghost small danger-text" data-act="remove-confirm" onClick=${async () => { const to = removing.to; setRemoving(null);
              await set({ id: c.id, moved_to: to }, `Removed ${c.label}; its items are in ${cats.find((x) => x.id === to)?.label}.`, `removing ${c.label}`); }}>Remove</button>
            <button type="button" class="ghost small" onClick=${() => setRemoving(null)}>Cancel</button></span>`
          : html`<button type="button" class="ghost small" disabled=${ro} data-act="rename-category" onClick=${() => setEditing({ id: c.id, label: c.label })}>Rename</button>
            ${c.icon ? html`<button type="button" class="ghost small" disabled=${ro} onClick=${() => set({ id: c.id, icon: "" }, "Icon cleared.")}>Clear icon</button>` : null}
            ${c.id !== "other" ? html`<button type="button" class="ghost small danger-text" disabled=${ro} data-act="remove-category"
              onClick=${() => setRemoving({ id: c.id, to: "other" })}>Remove…</button>` : null}`}
        </td></tr>`)}
    </tbody></table>
    <p class="muted">To give a category an icon, group by category, condense, and use “Use as the group's icon” on an item in it.</p>
    ${removed.length ? html`<details class="ls-removed"><summary>${plural(removed.length, "removed category", "removed categories")}</summary>
      <ul>${removed.map((c) => html`<li>${c.label} <span class="muted">→ ${c.moved_to_label}</span>
        <button type="button" class="ghost small" disabled=${ro} onClick=${() => set({ id: c.id, moved_to: "" }, `${c.label} is back.`)} data-act="restore-category">Bring back</button></li>`)}</ul></details>` : null}
  </${Section}>`;
}

// ---------------------------------------------------------------- OpenSCAD libraries
function Libraries({ ro }) {
  const libs = ctx.catalog?.component_libraries || [];
  const [busy, setBusy] = useState(null);
  const prefer = async (name, bundled) => {
    setBusy(name);
    try {
      const r = await runJob(api("library_prefer", { name, bundled }), bundled ? `Switching to the bundled ${name}` : `Switching to your ${name}`);
      await ctx.reloadCatalog();
      ctx.toast(`${name}: ${bundled ? "the copy that comes with the app" : "your copy"} is used now${r?.read?.length ? `; ${plural(r.read.length, "project")} read again` : ""}.`);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const missing = ctx.index.items.filter((i) => i.kind === "component" && !i.thumb && !i.needs?.length).length;
  const names = [...new Set(libs.map((l) => l.name))];
  return html`<${Section} id="libraries" title="OpenSCAD libraries"
    intro="The modules of these libraries are the Components, and projects that include them (include <BOSL2/…>) find them. The app comes with a copy of each; a library you add as a project (Add a project → “It's a library”) is used instead of the app's copy with the same name, unless you switch back here.">
    <table class="table-view ls-table" id="ls-libraries"><thead><tr><th>Library</th><th>Copy</th><th>Version</th><th>License</th><th class="num">Components</th><th></th></tr></thead><tbody>
      ${names.map((name) => {
        const copies = libs.filter((l) => l.name === name);
        const bundled = copies.find((l) => l.provider === "bundled");
        const own = copies.find((l) => l.provider === "project");
        return copies.map((l) => html`<tr key=${`${name}/${l.provider}`} data-library=${name} data-provider=${l.provider} data-active=${l.active ? "" : null}>
          <td>${l === copies[0] ? html`<b>${name}</b>${l.summary ? html`<br /><span class="muted">${l.summary}</span>` : null}` : null}</td>
          <td>${l.provider === "bundled" ? "Comes with the app" : html`Your project <a href=${scopeHash(`source:${l.source_id}`)}>${l.title || l.source_id}</a>`}
            ${l.active ? html` <span class="badge-mini ok">in use</span>` : null}</td>
          <td class="nowrap">${l.commit ? html`<code>${l.commit.slice(0, 7)}</code>` : "–"} <span class="muted">${l.date || ""}</span></td>
          <td>${l.license || "not stated"}</td>
          <td class="num">${l.components}</td>
          <td class="ls-actions">${bundled && own && !l.active ? html`<button type="button" class="ghost small" disabled=${ro || busy === name} data-act="prefer"
            onClick=${() => prefer(name, l.provider === "bundled")}>${busy === name ? "Switching…" : "Use this copy"}</button>` : null}
            ${l.docs ? html`<a class="button ghost small" href=${l.docs} target="_blank" rel="noopener">Docs</a>` : null}</td>
        </tr>`);
      })}
    </tbody></table>
    ${libs.some((l) => l.provider === "project") ? null : html`<p class="muted">To use your own copy of a library (a newer BOSL2, say), add it as a project and tick “It's a library”.</p>`}
    ${missing ? html`<p><button type="button" class="ghost" disabled=${ro} id="component-previews" onClick=${async () => { const n = await makeThumbnails({ components: true }); if (n) ctx.toast(`Made ${plural(n, "preview")}.`); }}>
      Make previews for ${plural(missing, "component")}</button> <span class="muted">Each component also gets one the first time you make it.</span></p>` : null}
  </${Section}>`;
}

// ---------------------------------------------------------------- hidden and deleted items
function HiddenAndDeleted({ ro }) {
  const hidden = ctx.index.items.filter((i) => i.hidden === "item");
  const deleted = ctx.catalog?.removed_items || [];
  return html`<${Section} id="items" title="Hidden and deleted items"
    intro="Hidden items stay in the library but out of browsing and search (“Show hidden” in the filters shows them). Deleted items are left out, also when their project updates.">
    <h3>Hidden ${hidden.length ? html`<span class="muted">${hidden.length}</span>` : null}</h3>
    ${hidden.length ? html`<ul class="ls-list" id="ls-hidden">${hidden.map((i) => html`<li key=${i.id}><a href=${i.href}>${i.name}</a> <span class="muted">${i.project}</span>
        <button type="button" class="ghost small" disabled=${ro} onClick=${() => hideItems([i], false)} data-act="unhide">Unhide</button></li>`)}</ul>
      ${hidden.length > 1 ? html`<button type="button" class="ghost small" disabled=${ro} onClick=${() => hideItems(hidden, false)}>Unhide all</button>` : null}`
      : html`<p class="muted">Nothing hidden. (Projects you hid are marked in the list above.)</p>`}
    <h3>Deleted ${deleted.length ? html`<span class="muted">${deleted.length}</span>` : null}</h3>
    ${deleted.length ? html`<ul class="ls-list" id="ls-deleted">${deleted.map((d) => html`<li key=${`${d.source}/${d.target}`}>${d.name} <span class="muted">${d.project}</span>
        <button type="button" class="ghost small" disabled=${ro} onClick=${() => restoreItems([d])} data-act="restore-item">Bring back</button></li>`)}</ul>
      ${deleted.length > 1 ? html`<button type="button" class="ghost small" disabled=${ro} onClick=${() => restoreItems(deleted)}>Bring them all back</button>` : null}`
      : html`<p class="muted">Nothing deleted.</p>`}
  </${Section}>`;
}

// ---------------------------------------------------------------- trash
function Trash({ ro, v }) {
  const [list, setList] = useState(null);
  const load = () => api("trash_list").then(setList, (e) => { setList([]); fail(e); });
  useEffect(() => { load(); }, [v]);
  const total = (list || []).reduce((n, t) => n + (t.bytes || 0), 0);
  const restore = async (t) => {
    try { await api("trash_restore", { entry: t.entry }); await ctx.reloadCatalog(); ctx.toast(`${t.name} is back.`); } catch (e) { fail(e); }
  };
  const remove = async (t) => {
    if (!confirm(t ? `Delete ${t.name} for good? This can't be undone.` : `Empty the trash? ${plural(list.length, "project")} (${bytes(total)}) are deleted for good. This can't be undone.`)) return;
    try { const r = await api("trash_empty", t ? { entry: t.entry } : {}); ctx.toast(t ? `${t.name} deleted for good.` : `Emptied the trash (${plural(r.removed, "project")}).`); load(); } catch (e) { fail(e); }
  };
  return html`<${Section} id="trash" title="Trash"
    intro="Deleted projects wait in the library's trash folder (with your own project's files) until you bring them back or empty the trash.">
    ${!list ? html`<p class="muted">Loading…</p>` : list.length ? html`
      <table class="table-view ls-table" id="ls-trash-table"><thead><tr><th>Project</th><th>Deleted</th><th class="num">Size</th><th></th></tr></thead><tbody>
        ${list.map((t) => html`<tr key=${t.entry} data-entry=${t.entry}><td>${t.name}</td><td class="nowrap">${when(t.deleted)}</td><td class="num">${bytes(t.bytes)}</td>
          <td class="ls-actions"><button type="button" class="ghost small" disabled=${ro} onClick=${() => restore(t)} data-act="trash-restore">Bring back</button>
            <button type="button" class="ghost small danger-text" disabled=${ro} onClick=${() => remove(t)} data-act="trash-delete">Delete for good</button></td></tr>`)}
      </tbody></table>
      <p><button type="button" class="ghost danger-text" disabled=${ro} onClick=${() => remove(null)} id="trash-empty">${Icon.close(14)} Empty the trash (${bytes(total)})</button></p>`
      : html`<p class="muted" id="trash-none">The trash is empty.</p>`}
  </${Section}>`;
}

// ---------------------------------------------------------------- defaults and GitHub
function DefaultsAndGitHub({ info, setInfo, ro }) {
  const [token, setToken] = useState("");
  return html`<${Section} id="defaults" title="Defaults">
    <p><button type="button" class="ghost" disabled=${ro} onClick=${() => ui.set({ dialog: { type: "edit", level: "library" } })}>Library-wide defaults…</button>
      <span class="muted"> License and author for projects that state none (your own, say).</span></p>
  </${Section}>
  <${Section} id="github" title="GitHub"
    intro="Adding projects and checking for updates uses GitHub's public API (60 requests an hour). A personal access token (no scopes needed for public projects) raises that and lets you add private repositories. It's kept on this computer, not in the library.">
    <form class="inline-form" onSubmit=${async (e) => { e.preventDefault(); const set = await api("github_token", { token }); setToken(""); setInfo({ ...info, github_token: set }); ctx.toast(set ? "Token saved." : "Token removed."); }}>
      <label>Token <input type="password" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder=${info.github_token ? "saved (type to replace, empty to remove)" : "ghp_…"} autocomplete="off" /></label>
      <button type="submit" class="ghost">Save</button></form>
    <p><button type="button" class="ghost" id="check-all-updates" onClick=${async () => {
      try { const r = await runJob(api("updates_check", {}), "Checking for updates"); await ctx.reloadCatalog(); ctx.toast(r.updates.length ? `${plural(r.updates.length, "update")} ready to review.` : "Everything is up to date."); } catch (e) { fail(e); }
    }}>Check every GitHub project for updates</button></p>
  </${Section}>`;
}

export function LibrarySettingsPage() {
  const v = useStore(ui, (s) => s.catalogVersion);
  const [info, setInfo] = useState(ctx.platform.info || {});
  useEffect(() => { ctx.platform.refreshInfo().then((i) => setInfo({ ...i })); }, [v]);
  const lib = info.library || ctx.catalog?.library || {};
  const ro = !!lib.read_only;
  return html`<div class="library-settings" data-v=${v}>
    <nav class="ls-toc" aria-label="On this page">${[["folder", "Folder"], ["projects", "Projects"], ["libraries", "Libraries"], ["categories", "Categories"], ["items", "Hidden and deleted"], ["trash", "Trash"], ["defaults", "Defaults"], ["github", "GitHub"]]
      .map(([id, label]) => html`<a href=${`#/library-settings`} onClick=${(e) => { e.preventDefault(); document.getElementById(`ls-${id}`)?.scrollIntoView({ behavior: "smooth" }); }}>${label}</a>`)}</nav>
    <${Folder} info=${info} lib=${lib} ro=${ro} />
    <${Projects} ro=${ro} />
    <${Libraries} ro=${ro} />
    <${Categories} ro=${ro} />
    <${HiddenAndDeleted} ro=${ro} />
    <${Trash} ro=${ro} v=${v} />
    <${DefaultsAndGitHub} info=${info} setInfo=${setInfo} ro=${ro} />
  </div>`;
}
