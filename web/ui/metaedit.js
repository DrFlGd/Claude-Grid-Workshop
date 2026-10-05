// Editing details (desktop): one item, several at once, a folder, a whole
// project, or library-wide defaults. Each field shows the value in use and where
// it comes from; an empty field takes the value from the level above. Edits are
// stored in the library (sources/<id>/metadata.json) and can be undone.
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

/** Field values as the form shows them (text). */
const toText = {
  name: (v) => v || "", summary: (v) => v || "", notes: (v) => v || "", origin: (v) => v || "", category: (v) => v || "",
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

/** Where an edit goes for one catalog item: { source, level, target }. */
export function itemTarget(item) {
  const [, local] = item.key.split("/");
  return item.kind === "part" ? { source: item.projectId, level: "part", target: local } : { source: item.projectId, level: "item", target: local };
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

export function MetaEditor({ spec }) {
  const close = () => ui.set({ dialog: null });
  const [state, setState] = useState(null); // { own, eff, from, extra }
  const [vals, setVals] = useState({});
  const [fields, setFields] = useState([]); // custom fields [[k, v]]
  const [level, setLevel] = useState(spec.level);
  const [busy, setBusy] = useState(false);
  const items = (spec.items || []).map((id) => ctx.index.get(id)).filter(Boolean);
  const item = spec.item ? ctx.index.get(spec.item) : null;
  const source = spec.source || item?.projectId;
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
      } else if (level === "bulk") {
        own = {};
      } else {
        const info = await api("source_get", { id: source });
        const m = info.metadata || {};
        if (level === "project") { own = m.project || {}; eff = src?.meta || {}; from = src?.from || {}; }
        else if (level === "folder") { own = m.folders?.[folder] || {}; eff = src?.meta || {}; from = src?.from || {}; }
        else if (item) {
          const t = itemTarget(item);
          own = (t.level === "part" ? m.parts : m.items)?.[t.target] || {};
          if (item.kind === "generator") { const d = (await ctx.loadModel(item.key)).detail; eff = d.meta || {}; from = d.from || {}; }
          else { const lib = ctx.libraries.find((l) => l.id === item.projectId); const it = lib?.items.find((x) => `${lib.id}/${x.id}` === item.key); eff = it?.meta || {}; from = it?.from || {}; }
        }
      }
      if (off) return;
      setState({ own, eff, from });
      setVals(Object.fromEntries(fieldsFor(level).map((f) => [f, toText[f](own[f])])));
      setFields(Object.entries(own.fields || {}).map(([k, v]) => [k, String(v)]));
    })().catch((e) => ctx.toast(String(e.message || e)));
    return () => { off = true; };
  }, [level]);

  const choices = ctx.catalog.category_choices || [];
  const levels = item ? [["item", "This item"], ...(folder ? [["folder", `Folder ${folder}`]] : []), ["project", `Project: ${src?.name || source}`]] : null;
  const title = level === "library" ? "Library-wide defaults" : level === "bulk" ? `Edit ${plural(items.length, "item")}`
    : level === "project" ? `Edit ${src?.name || "project"}` : level === "folder" ? `Edit folder ${folder}` : `Edit ${item?.name || "item"}`;

  const patchFrom = () => {
    const patch = {};
    for (const f of fieldsFor(level)) {
      const before = toText[f](state.own[f]);
      const now = (vals[f] ?? "").trim();
      if (now === before) continue;
      if (level === "bulk" && !now) continue; // bulk: empty means "leave as is"
      patch[f] = now ? (f === "license" ? { spdx: now } : now) : null;
    }
    const ownFields = state.own.fields || {};
    const newFields = Object.fromEntries(fields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    const fp = {};
    for (const k of Object.keys(ownFields)) if (!(k in newFields)) fp[k] = null;
    for (const [k, v] of Object.entries(newFields)) if (ownFields[k] !== v) fp[k] = v;
    if (Object.keys(fp).length) patch.fields = fp;
    return patch;
  };

  const save = async (e) => {
    e.preventDefault();
    const patch = patchFrom();
    if (!Object.keys(patch).length) { close(); return; }
    setBusy(true);
    try {
      // a new category typed in: give it a label
      if (patch.category && !choices.some((c) => c.id === patch.category || c.label === patch.category)) {
        const id = slug(patch.category);
        await api("category_set", { id, label: patch.category });
        patch.category = id;
      } else if (patch.category) {
        patch.category = choices.find((c) => c.label === patch.category)?.id || patch.category;
      }
      if (level === "library") {
        const r = await api("library_defaults", { patch });
        pushUndo("library defaults", () => api("library_defaults", { patch: r.previous }));
      } else if (level === "bulk") {
        const prevs = [];
        for (const it of items) {
          const t = itemTarget(it);
          const r = await api("meta_set", { ...t, patch });
          prevs.push([t, r.previous]);
        }
        pushUndo(`edit of ${plural(items.length, "item")}`, async () => { for (const [t, p] of prevs) await api("meta_set", { ...t, patch: p }); });
      } else {
        const target = level === "project" ? null : level === "folder" ? folder : itemTarget(item).target;
        const lvl = level === "item" ? itemTarget(item).level : level;
        const r = await api("meta_set", { source, level: lvl, target, patch });
        pushUndo(`edit of ${title.replace(/^Edit /, "")}`, () => api("meta_set", { source, level: lvl, target, patch: r.previous }));
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
    const placeholder = state?.eff?.[f] != null && level !== "bulk" ? `${toText[f](state.eff[f])}${state.from?.[f] ? `  (from ${fromText(state.from[f])})` : ""}` : level === "bulk" ? "leave as is" : "";
    const set = (v) => setVals({ ...vals, [f]: v });
    const common = { id: `meta-${f}`, value: vals[f] ?? "", onInput: (e) => set(e.target.value), placeholder };
    if (f === "summary" || f === "notes") return html`<textarea rows="3" ...${common}></textarea>`;
    if (f === "license") return html`<input list="spdx-list" ...${common} /><datalist id="spdx-list">${LICENSES.map((l) => html`<option value=${l} />`)}</datalist>`;
    if (f === "category") return html`<input list="cat-list" ...${common} value=${choices.find((c) => c.id === vals[f])?.label || vals[f] || ""} placeholder=${state?.eff?.category ? `${choices.find((c) => c.id === state.eff.category)?.label || state.eff.category}${state.from?.category ? `  (from ${fromText(state.from.category)})` : ""}` : placeholder} />
      <datalist id="cat-list">${choices.map((c) => html`<option value=${c.label} />`)}</datalist>`;
    if (f === "icon") return html`<select id="meta-icon" value=${vals.icon || ""} onChange=${(e) => set(e.target.value)}>
      <option value="">Thumbnails of its items</option>
      ${projectItems.map((i) => html`<option value=${i.kind === "part" ? `item:part-${i.key.split("/")[1]}` : `item:${i.key.split("/")[1]}`}>${i.name}</option>`)}</select>`;
    return html`<input ...${common} />`;
  };

  return html`<form class="dialog meta-editor" onSubmit=${save} aria-label=${title}>
    <div class="dialog-head"><h2>${title}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    ${levels ? html`<div class="seg tabs-seg" role="tablist" aria-label="Apply to">${levels.map(([l, label]) => html`<button type="button" role="tab"
      class=${`seg-btn${level === l ? " on" : ""}`} aria-selected=${level === l ? "true" : "false"} data-level=${l} onClick=${() => setLevel(l)}>${label}</button>`)}</div>` : null}
    <p class="muted">${level === "project" ? "Applies to every item in the project that has no value of its own." : level === "folder" ? "Applies to the items in this folder that have no value of their own."
      : level === "bulk" ? "Fields you fill in are set on each selected item; empty fields stay as they are." : level === "library" ? "Used where a project states nothing itself."
      : "Empty fields use the value shown, from the level named."}</p>
    ${!state ? html`<p class="muted">Loading…</p>` : html`<div class="meta-fields">
      ${fieldsFor(level).map((f) => html`<label class="meta-field" data-field=${f}><span>${LABEL[f]}${f === "tags" || f === "authors" ? html` <small class="muted">comma-separated</small>` : null}</span>${input(f)}
        ${vals[f] && level !== "bulk" ? html`<button type="button" class="link-btn" onClick=${() => setVals({ ...vals, [f]: "" })}>Clear</button>` : null}</label>`)}
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
