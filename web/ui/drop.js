// Files, folders and ZIPs dragged onto the window from outside (milestone 5, as Model Library's
// drop.js): a dialog asks where they go. A project of their own (copied into the library, like Add
// project › Folder or ZIP), or one of your own projects in local/ (the one open, or a new folder).
import { html, useState } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";
import { api, addProject, rescanLocal, sourceById, readOnly } from "./library.js";
import { plural } from "../lib/util.js";

const close = () => ui.set({ dialog: null });

/** The project of your own that's open (its page), if any: the place "Add to …" copies into. */
function openOwnProject() {
  const scope = ui.get().scope || "";
  const id = scope.startsWith("source:") ? scope.slice(7) : null;
  const src = id && sourceById(id);
  if (!src || src.kind !== "local" || id === "local-made-parts") return null;
  const folder = String(src.origin?.path || "").replace(/^local\//, "");
  return folder ? { id, name: src.name, folder } : null;
}

/** Something was dropped: what it is, then the dialog. */
export async function onDropped(paths) {
  ui.set({ dragging: false });
  if (!paths?.length || readOnly()) return;
  let info;
  try { info = await api("paths_info", { paths }); } catch { info = paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop(), dir: false, zip: /\.zip$/i.test(p), there: true })); }
  info = info.filter((i) => i.there);
  if (!info.length) return ctx.toast("Nothing to add: what was dropped isn't there any more.");
  ui.set({ dialog: { type: "drop", info, own: openOwnProject() } });
}

export function DropDialog({ spec }) {
  const { info, own } = spec;
  const [name, setName] = useState("");
  const zips = info.filter((i) => i.zip), dirs = info.filter((i) => i.dir), files = info.filter((i) => !i.dir && !i.zip);
  // each ZIP and folder is a project of its own; loose files go together in one
  const projects = zips.length + dirs.length + (files.length ? 1 : 0);
  const head = info.length === 1 ? info[0].name : [dirs.length ? plural(dirs.length, "folder") : "", zips.length ? plural(zips.length, "ZIP") : "", files.length ? plural(files.length, "file") : ""].filter(Boolean).join(", ");
  const asProjects = async () => {
    close();
    for (const z of zips) await addProject({ kind: "zip", path: z.path }, z.name);
    for (const d of dirs) await addProject({ kind: "folder", path: d.path }, d.name);
    if (files.length) await addProject({ kind: "files", paths: files.map((f) => f.path), name: name.trim() || null }, files.length === 1 ? files[0].name : plural(files.length, "file"));
  };
  const toOwn = async (folder) => {
    close();
    const from = location.hash; // the page to open the project from, unless you've moved on by then
    try {
      const r = await api("local_add", { paths: [...dirs, ...files].map((i) => i.path), folder: folder || null });
      await rescanLocal(true);
      await rescanLocal(true);
      ctx.toast(`Copied ${head} into ${r.folder}, one of your own projects.`);
      const src = (ctx.catalog?.sources || []).find((s) => s.kind === "local" && String(s.origin?.path || "").replace(/^local\//, "") === r.folder);
      if (src && location.hash === from) location.hash = `#/browse/source/${src.id}`;
    } catch (e) { ctx.toast(String(e.message || e)); }
  };
  const ownOk = !zips.length; // a ZIP is added as a project of its own, not unpacked into yours
  return html`<div class="dialog drop-dialog" role="dialog" aria-label="Add what was dropped">
    <div class="dialog-head"><h2>Add ${head}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <ul class="drop-list">${info.slice(0, 8).map((i) => html`<li>${i.dir ? "📁 " : ""}${i.name}</li>`)}${info.length > 8 ? html`<li class="muted">and ${info.length - 8} more</li>` : null}</ul>
    ${files.length > 1 ? html`<label class="field-block"><span>Project name <small class="muted">(for the ${files.length} files)</small></span>
      <input id="drop-name" value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${files[0].name.replace(/\.[^.]+$/, "")} /></label>` : null}
    <div class="drop-choices">
      <button type="button" class="primary" id="drop-project" onClick=${asProjects}>${projects === 1 ? "Add as a project" : `Add as ${projects} projects`}</button>
      <p class="muted">Copied into the library with its own name, license and credits, as Add project does.</p>
      ${ownOk && own ? html`<button type="button" id="drop-own" onClick=${() => toOwn(own.folder)}>Add to ${own.name}</button>
        <p class="muted">Copied into its folder (library/local/${own.folder}/).</p>` : null}
      ${ownOk ? html`<button type="button" class=${own ? "ghost" : ""} id="drop-own-new" onClick=${() => toOwn(null)}>Add as a project of your own</button>
        <p class="muted">Copied into a new folder in the library's local/ folder, for files you made yourself.</p>` : null}
    </div>
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button></div>
  </div>`;
}

/** While something is dragged over the window. */
export function DropHint() {
  const dragging = useStore(ui, (s) => s.dragging);
  if (!dragging || readOnly()) return null;
  return html`<div class="drop-hint" id="drop-hint" aria-hidden="true"><div class="drop-hint-box">${Icon.download(28)}<span>Drop to add it to the library</span></div></div>`;
}
