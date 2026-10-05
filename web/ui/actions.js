// Hiding, deleting and flagging (desktop). Items: hide (reversible from "Show
// hidden" or Library settings), delete (left out of the library, also after the
// project updates; Library settings can bring it back) and "broken" (a badge, a
// note, listed under Needs attention). Projects: hide, or delete (to the
// library's trash folder until the trash is emptied). Everything can be undone.
import { html, useState } from "../lib/html.js";
import { ui, pushUndo } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";
import { api, sourceById } from "./library.js";
import { itemTarget, undoNow } from "./metaedit.js";
import { plural } from "../lib/util.js";

const what = (items) => (items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item"));

/** Apply metadata patches as one undoable step. */
async function setMany(edits, label, done) {
  try {
    const r = await api("meta_set_many", { edits });
    pushUndo(label, () => api("meta_set_many", { edits: r.previous }));
    await ctx.reloadCatalog();
    ctx.toast(done, { label: "Undo", run: undoNow });
  } catch (e) {
    ctx.toast(`Couldn't do that: ${e.message || e}`);
  }
}

export function hideItems(items, hide = true) {
  // unhiding an item hidden with its project or folder takes an explicit "not hidden"
  const patch = (it) => ({ hidden: hide ? true : it.hidden === "item" ? null : false });
  return setMany(items.map((it) => ({ ...itemTarget(it), patch: patch(it) })), `${hide ? "hiding" : "showing"} ${what(items)}`,
    hide ? `Hid ${what(items)}. “Show hidden” in the filters brings hidden items back into view.` : `${what(items)} shown again.`);
}

/** Close the tabs of models that are going away. */
function closeTabs(keep) {
  for (const key of ui.get().tabs.filter((k) => !keep(k))) ctx.closeModelTab?.(key);
}

export function deleteItems(items) {
  ui.set({ selection: ui.get().selection.filter((id) => !items.some((i) => i.id === id)) });
  closeTabs((k) => !items.some((i) => i.kind === "generator" && i.key === k));
  return setMany(items.map((it) => ({ ...itemTarget(it), patch: { deleted: true } })), `deleting ${what(items)}`,
    `Deleted ${what(items)} from the library. Library settings can bring ${items.length === 1 ? "it" : "them"} back.`);
}

export function restoreItems(entries) {
  return setMany(entries.map((e) => ({ source: e.source, level: e.level, target: e.target, patch: { deleted: null } })),
    `bringing back ${plural(entries.length, "item")}`, `Brought back ${plural(entries.length, "item")}.`);
}

export function flagItems(items, note) {
  const today = new Date().toISOString().slice(0, 10);
  return setMany(items.map((it) => ({ ...itemTarget(it), patch: { broken: { note: note || "", date: today } } })), `flagging ${what(items)}`,
    `Flagged ${what(items)} as broken. ${items.length === 1 ? "It's" : "They're"} listed under Needs attention.`);
}

export function unflagItems(items) {
  return setMany(items.map((it) => ({ ...itemTarget(it), patch: { broken: null } })), `unflagging ${what(items)}`, `${what(items)} no longer flagged as broken.`);
}

export function hideProject(id, hide = true) {
  const name = sourceById(id)?.name || id;
  return setMany([{ source: id, level: "project", target: null, patch: { hidden: hide ? true : null } }], `${hide ? "hiding" : "showing"} ${name}`,
    hide ? `Hid ${name} and everything in it. Library settings lists hidden projects.` : `${name} shown again.`);
}

/** Delete a project: to the library's trash folder (undo, or Library settings, brings it back). */
export async function deleteProject(id, { confirmFirst = true } = {}) {
  const src = sourceById(id);
  const name = src?.name || id;
  const own = src?.kind === "local" ? " Your files in its local/ folder go to the trash too." : src?.kind === "linked" ? " The linked folder itself isn't touched." : "";
  if (confirmFirst && !confirm(`Delete ${name}? It goes to the library's trash folder until you empty the trash.${own}`)) return false;
  try {
    closeTabs((k) => !k.startsWith(`${id}/`));
    const info = await api("source_remove", { id });
    pushUndo(`deleting ${name}`, () => api("trash_restore", { entry: info.entry }));
    await ctx.reloadCatalog();
    ctx.toast(`Moved ${name} to the trash.`, { label: "Undo", run: undoNow });
    return true;
  } catch (e) {
    ctx.toast(`Couldn't delete ${name}: ${e.message || e}`);
    return false;
  }
}

/** "Flag as broken" with an optional note (dialog type "flag", { items: [ids] }). */
export function FlagDialog({ spec }) {
  const items = (spec.items || []).map((id) => ctx.index.get(id)).filter(Boolean);
  const [note, setNote] = useState(spec.note || "");
  const close = () => ui.set({ dialog: null });
  const save = async (e) => {
    e.preventDefault();
    close();
    await flagItems(items, note.trim());
  };
  return html`<form class="dialog flag-dialog" onSubmit=${save} aria-label="Flag as broken">
    <div class="dialog-head"><h2>Flag ${what(items)} as broken</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <label class="field-block"><span>What's wrong? <small class="muted">(optional)</small></span>
      <textarea id="flag-note" rows="3" value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="Fails to render at width 5; the lid doesn't fit…" autofocus></textarea></label>
    <p class="muted">Flagged models get a “broken” badge and are listed under Needs attention until you remove the flag.</p>
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="submit" class="primary" id="flag-save">Flag as broken</button></div>
  </form>`;
}

/** The hide / flag / delete buttons for a selection (inspector). */
export function ItemActions({ items }) {
  if (!items.length) return null;
  const allHidden = items.every((i) => i.hidden);
  const allBroken = items.every((i) => i.broken);
  return html`<div class="insp-actions item-actions">
    <button type="button" class="ghost" data-act="hide" onClick=${() => hideItems(items, !allHidden)}
      title=${allHidden ? "List it again" : "Keep it out of browsing and search (Show hidden brings it back)"}>${Icon.eye(15)} ${allHidden ? "Unhide" : "Hide"}</button>
    <button type="button" class="ghost" data-act="flag" onClick=${() => (allBroken ? unflagItems(items) : ui.set({ dialog: { type: "flag", items: items.map((i) => i.id) } }))}
      title=${allBroken ? "Remove the broken flag" : "Mark that it doesn't work, with a note"}>${Icon.alert(15)} ${allBroken ? "Not broken" : "Flag as broken"}</button>
    <button type="button" class="ghost danger-text" data-act="delete" onClick=${() => deleteItems(items)}
      title="Remove from the library (also after the project updates); Library settings can bring it back">${Icon.close(14)} Delete</button>
  </div>`;
}
