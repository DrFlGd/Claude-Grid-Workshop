// Pinning a component as a model, and the form editor (desktop). Both write
// manifest-shaped data (docs/DESKTOP_PLAN.md, "Components"): a pin is like a
// family manifest's model entry with "component" instead of "entrypoint"; a form
// edit is a model's `ui`, `hidden`, `defaults` and `presets`, stored with the
// item's metadata and applied with the same code the website build uses.
import { html, useState, useEffect } from "../lib/html.js";
import { ui, pushUndo } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";
import { api } from "./library.js";
import { itemTarget } from "./metaedit.js";

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const close = () => ui.set({ dialog: null });
const toastErr = (what) => (e) => ctx.toast(`${what}: ${e.message || e}`);

/** The Parametric Models category a component's topic suggests. */
const TOPIC_CATEGORY = { gears: "mechanical", threads: "mechanical", bearings: "mechanical", hinges: "mechanical", motors: "mechanical",
  fasteners: "fasteners", enclosures: "enclosures", text: "labels" };

// ---------------------------------------------------------------- pin
export function PinDialog({ spec }) {
  const [detail, setDetail] = useState(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [shown, setShown] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ctx.loadModel(spec.key).then(({ detail, values }) => {
      setDetail({ detail, values: { ...values, ...(spec.values || {}) } });
      setName(`${detail.name}`);
      setCategory(TOPIC_CATEGORY[detail.category] || "other");
      // show the main settings and anything set away from its default
      const vals = { ...values, ...(spec.values || {}) };
      setShown(Object.fromEntries(detail.parameters.map((p) => [p.name, p.group === "Settings" || !same(vals[p.name], p.default)])));
    }, toastErr("Couldn't load the component"));
  }, [spec.key]);
  if (!detail) return html`<div class="dialog"><p class="muted">Loading…</p></div>`;
  const { detail: d, values } = detail;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const params = d.parameters;
      const defaults = {}, fixed = {}, hidden = [];
      for (const p of params) {
        const v = values[p.name];
        if (shown[p.name]) { if (!same(v, p.default)) defaults[p.name] = v; }
        else {
          hidden.push(p.name);
          if (!same(v, p.default) || v != null) fixed[p.name] = v; // hidden at the value it has now
        }
      }
      for (const k of Object.keys(fixed)) if (fixed[k] == null) delete fixed[k];
      const r = await api("pin_create", { component: d.key, name: name.trim(), category, defaults, hidden, fixed });
      await ctx.reloadCatalog();
      close();
      ctx.toast(`Pinned as ${name.trim()} under Parametric Models.`);
      location.hash = `#/m/${r.key}`;
    } catch (err) { toastErr("Couldn't pin it")(err); } finally { setBusy(false); }
  };
  const groups = [...new Set(d.parameters.map((p) => p.group))];
  return html`<form class="dialog pin-dialog" onSubmit=${save} aria-label="Pin as a model">
    <div class="dialog-head"><h2>${Icon.pin(18)} Pin as a model</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <p class="muted">${d.component?.library} <code>${d.component?.module}()</code> becomes a model under Parametric Models, with the values it has now as its defaults. Settings you don't show stay at those values.</p>
    <label class="field-block"><span>Name</span><input id="pin-name" value=${name} onInput=${(e) => setName(e.target.value)} required /></label>
    <label class="field-block"><span>Category</span>
      <select id="pin-category" value=${category} onChange=${(e) => setCategory(e.target.value)}>
        ${(ctx.catalog.category_choices || []).map((c) => html`<option value=${c.id} selected=${c.id === category}>${c.label}</option>`)}
      </select></label>
    <fieldset class="pin-settings"><legend>Settings to show</legend>
      ${groups.map((g) => html`<div class="pin-group"><b>${g}</b>
        ${d.parameters.filter((p) => p.group === g).map((p) => html`<label class="check" key=${p.name}>
          <input type="checkbox" data-pin-show=${p.name} checked=${!!shown[p.name]} onChange=${(e) => setShown({ ...shown, [p.name]: e.target.checked })} />
          ${p.label || p.name} <span class="muted">${values[p.name] == null ? "" : `= ${typeof values[p.name] === "object" ? JSON.stringify(values[p.name]) : values[p.name]}`}</span></label>`)}
      </div>`)}
    </fieldset>
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="submit" class="primary" disabled=${busy || !name.trim()} id="pin-go">Pin</button></div>
  </form>`;
}

// ---------------------------------------------------------------- form editor
const PROFILE = [["", "None"], ["bed", "Print bed size"], ["bed.x", "Bed width (X)"], ["bed.y", "Bed depth (Y)"], ["nozzle", "Nozzle diameter"]];

/** A setting's form edits as editable text: { label, description, axes, min, max, step, choices, when, profile, group, default, show }. */
function rowFor(p, form) {
  const u = form.ui?.[p.name] || {};
  const opts = u.options || null;
  return {
    show: !(form.hidden || []).includes(p.name),
    label: u.label ?? "", description: u.description ?? "",
    axes: (u.axes || []).join(", "), min: u.min ?? "", max: u.max ?? "", step: u.step ?? "",
    choices: opts ? opts.map((o) => (typeof o === "object" ? `${JSON.stringify(o.value)} = ${o.label ?? ""}` : JSON.stringify(o))).join("\n") : "",
    when: u["display-condition"]?.js ?? "", profile: u.profile ?? "", group: u.group ?? "",
    default: form.defaults && p.name in form.defaults ? JSON.stringify(form.defaults[p.name]) : "",
  };
}

const num = (t) => (t === "" || t == null ? undefined : Number(t));
const parseValue = (t) => { try { return JSON.parse(t); } catch { return t; } };

/** The rows back into a manifest-shaped form ({ ui, hidden, defaults, presets }), keeping only what's set. */
function formFrom(params, rows, presets) {
  const ui_ = {}, hidden = [], defaults = {};
  for (const p of params) {
    const r = rows[p.name];
    if (!r) continue;
    if (!r.show) hidden.push(p.name);
    const u = {};
    if (r.label.trim()) u.label = r.label.trim();
    if (r.description.trim()) u.description = r.description.trim();
    if (r.axes.trim()) u.axes = r.axes.split(",").map((s) => s.trim()).filter(Boolean);
    for (const k of ["min", "max", "step"]) { const v = num(String(r[k]).trim()); if (v !== undefined && !Number.isNaN(v)) u[k] = v; }
    if (r.choices.trim()) {
      u.options = r.choices.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(.*?)\s=\s(.*)$/);
        return m ? { value: parseValue(m[1].trim()), label: m[2].trim() || m[1].trim() } : { value: parseValue(l), label: l.replace(/^"|"$/g, "") };
      });
    }
    if (r.when.trim()) u["display-condition"] = { js: r.when.trim() };
    if (r.profile) u.profile = r.profile;
    if (r.group.trim()) u.group = r.group.trim();
    if (Object.keys(u).length) ui_[p.name] = u;
    if (r.default.trim()) defaults[p.name] = parseValue(r.default.trim());
  }
  const form = {};
  if (Object.keys(ui_).length) form.ui = ui_;
  if (hidden.length) form.hidden = hidden;
  if (Object.keys(defaults).length) form.defaults = defaults;
  if (presets.length) form.presets = presets;
  return Object.keys(form).length ? form : null;
}

export function FormEditor({ spec }) {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [presetName, setPresetName] = useState("");
  useEffect(() => {
    ctx.loadModel(spec.key).then(({ detail }) => {
      const params = detail.base_parameters || detail.parameters;
      const form = detail.form || {};
      setState({ detail, params, rows: Object.fromEntries(params.map((p) => [p.name, rowFor(p, form)])), presets: form.presets || [] });
    }, toastErr("Couldn't load the model"));
  }, [spec.key]);
  if (!state) return html`<div class="dialog"><p class="muted">Loading…</p></div>`;
  const { detail, params, rows, presets } = state;
  const item = ctx.index.get(`gen:${detail.key}`);
  const set = (name, k, v) => setState({ ...state, rows: { ...rows, [name]: { ...rows[name], [k]: v } } });
  const form = formFrom(params, rows, presets);
  const save = async (value) => {
    setBusy(true);
    try {
      const t = itemTarget(item);
      const r = await api("meta_set_many", { edits: [{ ...t, patch: { form: value } }] });
      const prev = r.previous?.[0];
      if (prev) pushUndo(`form of ${detail.name}`, () => api("meta_set_many", { edits: [{ ...t, patch: { form: prev.patch.form ?? null } }] }).then(() => ctx.refreshModel?.(detail.key)));
      await ctx.reloadCatalog();
      ctx.refreshModel?.(detail.key);
      close();
      ctx.toast(value ? "Form saved." : "Form back to how the project has it.", { label: "Undo", run: () => import("./metaedit.js").then((m) => m.undoNow()).then(() => ctx.refreshModel?.(detail.key)) });
    } catch (e) { toastErr("Couldn't save the form")(e); } finally { setBusy(false); }
  };
  const addPreset = () => {
    const values = ctx.currentValues?.(detail.key);
    if (!values || !presetName.trim()) return;
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => { const p = params.find((x) => x.name === k); return p && !same(v, p.default); }));
    setState({ ...state, presets: [...presets, { label: presetName.trim(), values: changed }] });
    setPresetName("");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(form || {}, null, 2)); ctx.toast("Copied: paste it as a model entry's ui, hidden, defaults and presets in catalog/families."); }
    catch { ctx.toast("The clipboard isn't available."); }
  };
  const input = (name, k, attrs = {}) => html`<input value=${rows[name][k]} onInput=${(e) => set(name, k, e.target.value)} data-form=${`${name}.${k}`} ...${attrs} />`;
  return html`<div class="dialog form-editor" aria-label="Edit form">
    <div class="dialog-head"><h2>${Icon.edit(18)} Edit the form: ${detail.name}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <p class="muted">Change how the settings look. The model's file isn't touched: this is saved with the model's details in your library, in the same shape as a family manifest's model entry (“Copy as JSON”).</p>
    <div class="fe-list">
      ${params.map((p) => {
        const r = rows[p.name];
        const isOpen = open === p.name;
        const changed = !same(rowFor(p, {}), { ...r });
        return html`<div class=${`fe-row${isOpen ? " open" : ""}${r.show ? "" : " fe-hidden"}`} key=${p.name} data-fe=${p.name}>
          <div class="fe-head">
            <label class="check" title="Show this setting"><input type="checkbox" checked=${r.show} onChange=${(e) => set(p.name, "show", e.target.checked)} data-form=${`${p.name}.show`} /></label>
            <button type="button" class="fe-name" onClick=${() => setOpen(isOpen ? null : p.name)} aria-expanded=${isOpen ? "true" : "false"}>
              <b>${r.label || p.label || p.name}</b> <code>${p.name}</code> <span class="muted">${p.group}</span>${changed ? html` <span class="badge-mini">edited</span>` : null}</button>
          </div>
          ${isOpen ? html`<div class="fe-body">
            <label><span>Label</span>${input(p.name, "label", { placeholder: p.label || p.name })}</label>
            <label><span>Help</span>${input(p.name, "description", { placeholder: p.description || "" })}</label>
            <label><span>Section</span>${input(p.name, "group", { placeholder: p.group })}</label>
            <label><span>Default</span>${input(p.name, "default", { placeholder: JSON.stringify(p.default) })}</label>
            ${p.type === "number" || p.widget === "slider" || Array.isArray(p.default) ? html`<div class="fe-three">
              <label><span>Min</span>${input(p.name, "min", { placeholder: p.min ?? "" })}</label>
              <label><span>Max</span>${input(p.name, "max", { placeholder: p.max ?? "" })}</label>
              <label><span>Step</span>${input(p.name, "step", { placeholder: p.step ?? "" })}</label></div>` : null}
            ${Array.isArray(p.default) ? html`<label><span>Box names</span>${input(p.name, "axes", { placeholder: (p.axes || ["X", "Y", "Z"]).join(", ") })}</label>` : null}
            <label><span>Choices</span><textarea rows="3" value=${r.choices} onInput=${(e) => set(p.name, "choices", e.target.value)} data-form=${`${p.name}.choices`}
              placeholder=${p.options ? p.options.map((o) => `${JSON.stringify(o.value)} = ${o.label}`).join("\n") : "one per line: value = label"}></textarea></label>
            <label><span>Show when</span>${input(p.name, "when", { placeholder: p.show_if || "e.g. style == \"round\"", class: "expr" })}</label>
            <label><span>Printer profile</span><select value=${r.profile} onChange=${(e) => set(p.name, "profile", e.target.value)} data-form=${`${p.name}.profile`}>
              ${PROFILE.map(([v, l]) => html`<option value=${v} selected=${v === r.profile}>${l}</option>`)}</select></label>
          </div>` : null}
        </div>`;
      })}
    </div>
    <section class="fe-presets"><h3>Presets</h3>
      ${presets.length ? html`<ul>${presets.map((ps, i) => html`<li key=${i}>${ps.label} <span class="muted">${Object.keys(ps.values).length} values</span>
        <button type="button" class="link-btn" onClick=${() => setState({ ...state, presets: presets.filter((_, j) => j !== i) })}>Remove</button></li>`)}</ul>` : html`<p class="muted">None. Presets appear under “Start from” on the model's page.</p>`}
      ${ctx.currentValues?.(detail.key) ? html`<div class="fe-add-preset"><input placeholder="Name for the current settings" value=${presetName} onInput=${(e) => setPresetName(e.target.value)} id="fe-preset-name" />
        <button type="button" class="ghost" onClick=${addPreset} disabled=${!presetName.trim()} id="fe-preset-add">Add as a preset</button></div>` : null}
    </section>
    <div class="dialog-actions">
      <button type="button" class="ghost" onClick=${copy} title="Copy the form as JSON for a family manifest">Copy as JSON</button>
      ${detail.form ? html`<button type="button" class="ghost danger-text" onClick=${() => save(null)} disabled=${busy} id="fe-reset">Reset the form</button>` : null}
      <span class="spacer"></span>
      <button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="button" class="primary" onClick=${() => save(form)} disabled=${busy} id="fe-save">Save</button>
    </div>
  </div>`;
}
