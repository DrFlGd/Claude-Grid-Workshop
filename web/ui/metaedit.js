// Editing details (desktop): one item, several at once, a folder, a whole
// project, or library-wide defaults. Each field starts with the value in use, to
// edit in place; a note says where it comes from. A value left as it was stays
// inherited (so a later project-wide change still reaches it); "Reset" drops a
// value set at this level. An item can also be listed under another project.
// Edits are stored in the library (sources/<id>/metadata.json) and can be undone.
import { html, useState, useEffect } from "../lib/html.js";
import { ui, pushUndo, undoLast } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";
import { api, sourceById } from "./library.js";
import { plural } from "../lib/util.js";

const LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0", "CC0-1.0",
  "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-ND-4.0", "CC-BY-NC-ND-4.0", "Unlicense", "NOASSERTION"];
const FROM_TEXT = { item: "this item", project: "the project", detected: "the project's files", library: "library defaults" };
const fromText = (f) => (!f ? "" : f.startsWith("folder:") ? `folder ${f.slice(7)}` : FROM_TEXT[f] || f);
const choices = () => ctx.catalog.category_choices || [];

/** Field values as the form shows them (text). */
const toText = {
  name: (v) => v || "", summary: (v) => v || "", notes: (v) => v || "", origin: (v) => v || "",
  category: (v) => (v ? choices().find((c) => c.id === v)?.label || v : ""),
  tags: (v) => (Array.isArray(v) ? v.join(", ") : v || ""),
  authors: (v) => (Array.isArray(v) ? v.map((a) => a.name || a).join(", ") : v || ""),
  license: (v) => (v && typeof v === "object" ? v.spdx || "" : v || ""),
  icon: (v) => v || "",
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Which fields a level has. */
function fieldsFor(level) {
  const shared = ["summary", "category", "tags", "license", "authors", "origin"];
  if (level === "item") return ["name", ...shared, "notes"];
  if (level === "project") return ["name", ...shared, "icon"];
  if (level === "library") return ["license", "authors"];
  return shared; // folder, bulk
}

const LABEL = { name: "Name", summary: "Description", category: "Category", tags: "Tags", license: "License", authors: "Authors", origin: "Origin (link)", notes: "Notes", icon: "Icon" };

/** Where an edit goes for one catalog item: { source, level, target } (its own project, even when listed under another). */
export function itemTarget(item) {
  const [pack, local] = item.key.split("/");
  const source = item.sourceId || (item.kind === "part" ? pack : item.projectId);
  return item.kind === "part" ? { source, level: "part", target: local } : { source, level: "item", target: local };
}

async function reloadAndToast(text, undo) {
  await ctx.reloadCatalog();
  ctx.toast(text, undo ? { label: "Undo", run: () => undoNow() } : null);
}

export async function undoNow() {
  try {
    const label = await undoLast();
    if (label) { await ctx.reloadCatalog(); ctx.toast(`Undone: ${label}`); }
  } catch (e) { ctx.toast(`Couldn't undo: ${e.message || e}`); }
}

/** Projects an item can be listed under. */
const projectChoices = () => (ctx.catalog.sources || []).filter((s) => s.role !== "library" && s.read !== false)
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));

export function MetaEditor({ spec }) {
  const close = () => ui.set({ dialog: null });
  const [state, setState] = useState(null); // { own, eff, from }
  const [vals, setVals] = useState({});
  const [reset, setReset] = useState(() => new Set()); // fields whose own value goes
  const [fields, setFields] = useState([]); // custom fields [[k, v]]
  const [level, setLevel] = useState(spec.level);
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const items = (spec.items || []).map((id) => ctx.index.get(id)).filter(Boolean);
  const item = spec.item ? ctx.index.get(spec.item) : null;
  const source = spec.source || (item ? itemTarget(item).source : null);
  const src = source ? sourceById(source) : null;
  const folder = item?.folder || spec.target || "";

  // what this level holds, and the values in use
  useEffect(() => {
    let off = false;
    (async () => {
      let own = {}, eff = {}, from = {};
      if (level === "library") {
        own = ctx.catalog.library_meta?.metadata || {};
        eff = own;
      } else if (level !== "bulk") {
        const info = await api("source_get", { id: source });
        const m = info.metadata || {};
        if (level === "project") { own = m.project || {}; eff = src?.meta || {}; from = src?.from || {}; }
        else if (level === "folder") {
          own = m.folders?.[folder] || {};
          // the folder's own value, else the project's
          for (const f of fieldsFor("folder")) {
            eff[f] = own[f] ?? src?.meta?.[f];
            from[f] = own[f] != null ? "own" : src?.meta?.[f] != null ? "project" : null;
          }
        } else if (item) {
          const t = itemTarget(item);
          own = (t.level === "part" ? m.parts : m.items)?.[t.target] || {};
          if (item.kind === "generator") { const d = (await ctx.loadModel(item.key)).detail; eff = d.meta || {}; from = d.from || {}; }
          else {
            const [pack, id] = item.key.split("/");
            const it = ctx.libraries.find((l) => l.id === pack)?.items.find((x) => x.id === id);
            eff = it?.meta || {}; from = it?.from || {};
          }
        }
      }
      if (off) return;
      setState({ own, eff, from });
      setReset(new Set());
      setVals(Object.fromEntries(fieldsFor(level).map((f) => [f, level === "bulk" ? "" : toText[f](eff[f] ?? own[f])])));
      setFields(Object.entries((level === "bulk" ? {} : own.fields) || {}).map(([k, v]) => [k, String(v)]));
      setProject(level === "item" ? item?.projectId || "" : "");
    })().catch((e) => ctx.toast(String(e.message || e)));
    return () => { off = true; };
  }, [level]);

  const levels = item ? [["item", "This item"], ...(folder ? [["folder", `Folder ${folder}`]] : []), ["project", `Project: ${src?.name || source}`]] : null;
  const title = level === "library" ? "Library-wide defaults" : level === "bulk" ? `Edit ${plural(items.length, "item")}`
    : level === "project" ? `Edit ${src?.name || "project"}` : level === "folder" ? `Edit folder ${folder}` : `Edit ${item?.name || "item"}`;
  const isOwn = (f) => state?.own?.[f] != null && !reset.has(f);

  /** A typed value as stored: categories by id (a new one is created on save), licenses as { spdx }. */
  const stored = (f, text) => (f === "license" ? { spdx: text } : f === "category" ? choices().find((c) => c.label === text || c.id === text)?.id || text : text);

  const patchFrom = () => {
    const patch = {};
    for (const f of fieldsFor(level)) {
      const now = (vals[f] ?? "").trim();
      if (level === "bulk") {
        if (now) patch[f] = stored(f, now); // bulk: empty means "leave as is"
        continue;
      }
      if (reset.has(f) && !now) { if (state.own[f] != null) patch[f] = null; continue; }
      const effText = toText[f](state.eff[f] ?? state.own[f]).trim();
      if (now === effText && !reset.has(f)) continue; // unchanged: an inherited value stays inherited
      if (!now) { if (state.own[f] != null) patch[f] = null; continue; } // emptied: back to the level above
      patch[f] = stored(f, now);
    }
    const ownFields = level === "bulk" ? {} : state.own.fields || {};
    const newFields = Object.fromEntries(fields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    const fp = {};
    if (level !== "bulk") for (const k of Object.keys(ownFields)) if (!(k in newFields)) fp[k] = null;
    for (const [k, v] of Object.entries(newFields)) if (ownFields[k] !== v) fp[k] = v;
    if (Object.keys(fp).length) patch.fields = fp;
    return patch;
  };

  /** "List under another project" as a patch for one item (null: under its own). */
  const projectPatch = (it) => (!project || project === it.projectId ? undefined : project === itemTarget(it).source ? null : project);

  const save = async (e) => {
    e.preventDefault();
    const patch = patchFrom();
    const moving = (level === "item" ? [item] : level === "bulk" ? items : []).filter((it) => projectPatch(it) !== undefined);
    if (!Object.keys(patch).length && !moving.length) { close(); return; }
    setBusy(true);
    try {
      // a new category typed in: give it a label
      if (patch.category && !choices().some((c) => c.id === patch.category)) {
        const label = patch.category;
        patch.category = slug(label);
        await api("category_set", { id: patch.category, label });
      }
      if (level === "library") {
        const r = await api("library_defaults", { patch });
        pushUndo("library defaults", () => api("library_defaults", { patch: r.previous }));
      } else if (level === "bulk" || level === "item") {
        const list = level === "bulk" ? items : [item];
        const edits = list.map((it) => {
          const p = { ...patch };
          const pp = projectPatch(it);
          if (pp !== undefined) p.project = pp;
          return { ...itemTarget(it), patch: p };
        }).filter((ed) => Object.keys(ed.patch).length);
        const r = await api("meta_set_many", { edits });
        pushUndo(`edit of ${level === "bulk" ? plural(items.length, "item") : item.name}`, () => api("meta_set_many", { edits: r.previous }));
      } else {
        const target = level === "project" ? null : folder;
        const r = await api("meta_set", { source, level, target, patch });
        pushUndo(`edit of ${title.replace(/^Edit /, "")}`, () => api("meta_set", { source, level, target, patch: r.previous }));
      }
      close();
      await reloadAndToast("Saved.", true);
      // a project-wide change: items with their own value keep it; offer to clear them
      if (level === "project") {
        const m = (await api("source_get", { id: source })).metadata || {};
        for (const f of Object.keys(patch).filter((k) => k !== "name" && k !== "icon" && k !== "fields")) {
          const n = ["items", "parts", "folders"].reduce((s, sec) => s + Object.values(m[sec] || {}).filter((x) => x[f] != null).length, 0);
          if (n) {
            ctx.toast(`${plural(n, "item")} in ${src?.name} have their own ${LABEL[f].toLowerCase()}.`, { label: "Use the project's", run: async () => {
              const r = await api("meta_clear_items", { source, field: f });
              pushUndo(`clearing ${LABEL[f].toLowerCase()} overrides`, () => api("meta_restore", { source, field: f, previous: r.previous }));
              await reloadAndToast(`Cleared ${plural(r.cleared, "override")}.`, true);
            } });
            break;
          }
        }
      }
    } catch (err) {
      ctx.toast(`Couldn't save: ${err.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const projectItems = level === "project" ? ctx.index.items.filter((i) => i.projectId === source && i.thumb) : [];
  const input = (f) => {
    const set = (v) => setVals({ ...vals, [f]: v });
    const placeholder = level === "bulk" ? "leave as is" : reset.has(f) ? "the value from the level above" : "";
    const common = { id: `meta-${f}`, value: vals[f] ?? "", onInput: (e) => set(e.target.value), placeholder };
    if (f === "summary" || f === "notes") return html`<textarea rows="3" ...${common}></textarea>`;
    if (f === "license") return html`<input list="spdx-list" ...${common} /><datalist id="spdx-list">${LICENSES.map((l) => html`<option value=${l} />`)}</datalist>`;
    if (f === "category") return html`<input list="cat-list" ...${common} /><datalist id="cat-list">${choices().map((c) => html`<option value=${c.label} />`)}</datalist>`;
    if (f === "icon") return html`<select id="meta-icon" value=${vals.icon || ""} onChange=${(e) => set(e.target.value)}>
      <option value="">Thumbnails of its items</option>
      ${projectItems.map((i) => html`<option value=${`item:${i.sourceId}/${i.kind === "part" ? `part-${i.key.split("/")[1]}` : i.key.split("/")[1]}`}>${i.name}</option>`)}</select>`;
    return html`<input ...${common} />`;
  };
  /** Where the value in the field comes from, with Reset for a value set at this level. */
  const note = (f) => {
    if (level === "bulk" || level === "library" || !state) return null;
    if (isOwn(f)) return html`<small class="meta-from">Set here. <button type="button" class="link-btn" data-reset=${f}
      onClick=${() => { setReset(new Set([...reset, f])); setVals({ ...vals, [f]: "" }); }}>Reset</button></small>`;
    if (reset.has(f)) return html`<small class="meta-from">Goes back to the value from the level above when you save.</small>`;
    const from = state.from?.[f];
    if (!from || (state.eff?.[f] ?? "") === "") return html`<small class="meta-from">Not set.</small>`;
    const where = level === "folder" ? "the project" : fromText(from);
    return html`<small class="meta-from">From ${where}; edit to set it ${level === "item" ? "for this item" : level === "folder" ? "for this folder" : "for the project"}.</small>`;
  };
  const moveTo = level === "item" || level === "bulk";
  const actual = item ? sourceById(itemTarget(item).source) : null;

  return html`<form class="dialog meta-editor" onSubmit=${save} aria-label=${title}>
    <div class="dialog-head"><h2>${title}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    ${levels ? html`<div class="seg tabs-seg" role="tablist" aria-label="Apply to">${levels.map(([l, label]) => html`<button type="button" role="tab"
      class=${`seg-btn${level === l ? " on" : ""}`} aria-selected=${level === l ? "true" : "false"} data-level=${l} onClick=${() => setLevel(l)}>${label}</button>`)}</div>` : null}
    <p class="muted">${level === "project" ? "Applies to every item in the project that has no value of its own." : level === "folder" ? "Applies to the items in this folder that have no value of their own."
      : level === "bulk" ? "Fields you fill in are set on each selected item; empty fields stay as they are." : level === "library" ? "Used where a project states nothing itself."
      : "Edit any value to set it for this item. Values you leave as they are keep following the folder and project."}</p>
    ${!state ? html`<p class="muted">Loading…</p>` : html`<div class="meta-fields">
      ${moveTo ? html`<label class="meta-field" data-field="project"><span>Project</span>
        <select id="meta-project" value=${project} onChange=${(e) => setProject(e.target.value)}>
          ${level === "bulk" ? html`<option value="">Leave as is</option>` : null}
          ${projectChoices().map((p) => html`<option value=${p.id}>${p.name}${actual && p.id === actual.id ? " (where it comes from)" : ""}</option>`)}
        </select>
        <small class="meta-from">Where it's listed and grouped. Its files, license and credits stay with ${level === "bulk" ? "the project each comes from" : actual?.name || "its own project"}.</small></label>` : null}
      ${fieldsFor(level).map((f) => html`<label class="meta-field" data-field=${f}><span>${LABEL[f]}${f === "tags" || f === "authors" ? html` <small class="muted">comma-separated</small>` : null}</span>${input(f)}
        ${note(f)}</label>`)}
      <fieldset class="meta-custom"><legend>Other details <small class="muted">(any name: material, print time…; they become filters and table columns)</small></legend>
        ${fields.map(([k, v], i) => html`<div class="custom-row"><input aria-label="Name" value=${k} placeholder="name" onInput=${(e) => setFields(fields.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input aria-label="Value" value=${v} placeholder="value" onInput=${(e) => setFields(fields.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button type="button" class="ghost" aria-label="Remove" onClick=${() => setFields(fields.filter((_, j) => j !== i))}>${Icon.close(12)}</button></div>`)}
        <button type="button" class="ghost" onClick=${() => setFields([...fields, ["", ""]])} id="meta-add-field">Add a detail</button></fieldset>
    </div>`}
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="submit" class="primary" disabled=${busy || !state} id="meta-save">Save</button></div>
  </form>`;
}
