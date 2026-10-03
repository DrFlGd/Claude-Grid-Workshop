// Claude Grid Workshop front end (static): catalog, settings forms with
// upstream editor metadata, in-browser OpenSCAD renders, 3D preview, parts.
import { Viewer } from "./viewer.js";
import { EngineClient } from "./engine-client.js";

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const getJSON = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw Object.assign(new Error(`Couldn't load ${path} (${r.status})`), { status: r.status });
  return r.json();
};

const FILAMENTS = [
  ["Tool yellow", "#f2b705"], ["Signal blue", "#2f6fd0"], ["Galaxy grey", "#6b7680"],
  ["Orange", "#ee6a1f"], ["Green", "#3c9a5f"], ["White", "#f4f4f2"], ["Black", "#26292c"],
];
const GRID_CATEGORIES = new Set(["gridfinity"]);
const FORMAT_LABEL = { "3mf": "3MF", stl: "STL", step: "STEP", shapr: "Shapr3D", pdf: "PDF", obj: "OBJ" };

const state = {
  catalog: null, engine: null, viewer: null, viewerOwner: null,
  model: null, values: {}, rendered: null, lastResult: null, job: null, conditions: [],
  libraries: [], libDetail: {}, openLib: null, downloadUrl: null,
};

// ---------------------------------------------------------------- helpers
function humanize(name) {
  const axis = name.match(/^([a-z]{3,})([xyz])$/);
  if (axis) name = `${axis[1]}_${axis[2].toUpperCase()}`;
  const s = name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  return s.split(" ").map((w, i) => {
    if (/^(mm|deg)$/i.test(w)) return `(${w.toLowerCase()})`;
    if (/^[A-Z0-9]{2,}$/.test(w) || /^[XYZ]$/.test(w)) return w;
    return i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
  }).join(" ");
}
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (n) => (n > 1048576 ? `${fmt(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const savedColor = (() => { try { return localStorage.getItem("gw-filament"); } catch { return null; } })() || FILAMENTS[0][1];

function licenseBadge(lic) {
  if (!lic || lic.public_use === "ok") return null;
  const text = lic.public_use === "blocked" ? "License unclear" : "Check license";
  return el("span", { class: `badge ${lic.public_use}`, title: lic.notes || lic.spdx, text });
}

/** Keep simple formatting from third-party descriptions; drop anything active. */
const SAFE_TAGS = new Set(["A", "B", "STRONG", "I", "EM", "BR", "P", "SPAN", "CODE", "UL", "OL", "LI", "DIV", "SMALL"]);
function safeHTML(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!SAFE_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        for (const attr of [...child.attributes]) {
          const keep = (attr.name === "href" && /^https?:\/\//i.test(attr.value)) ||
            attr.name === "data-display-condition" || (attr.name === "class" && /^alert/.test(attr.value));
          if (!keep) child.removeAttribute(attr.name);
        }
        if (child.tagName === "A") { child.target = "_blank"; child.rel = "noopener"; }
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) child.remove();
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  return [...root.childNodes];
}

/** Upstream display conditions are small JS expressions over parameter names. */
function compileCondition(expr, names) {
  try {
    const fn = new Function(...names, `"use strict"; return (${expr});`);
    return (values) => { try { return !!fn(...names.map((n) => values[n])); } catch { return true; } };
  } catch { return () => true; }
}

// ---------------------------------------------------------------- routing
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const m = h.match(/^m\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
  const p = h.match(/^parts\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/);
  if (m) openModel(`${m[1]}/${m[2]}`);
  else if (p) openLibrary(p[1], p[2]);
  else if (h === "about") showAbout();
  else showCatalog();
}
window.addEventListener("hashchange", route);

function showView(name) {
  for (const v of ["catalog", "model", "library", "about"]) $(`#view-${v}`).hidden = v !== name;
  const stage = $(".stage");
  if (name === "model" && stage.parentElement.id !== "view-model") $("#view-model").append(stage);
  if (name === "library" && stage.parentElement.id !== "view-library") $("#view-library").append(stage);
  if ((name === "model" || name === "library") && !state.viewer) {
    state.viewer = new Viewer($("#viewer"));
    state.viewer.setColor(savedColor);
  }
  state.viewer?.resize();
  if (name !== "model") cancelJob();
}

function setCrumbs(parts) {
  const c = $("#crumbs");
  c.replaceChildren();
  parts.forEach((p, i) => {
    if (i) c.append(el("span", { class: "sep", "aria-hidden": "true", text: "/" }));
    c.append(p.href ? el("a", { href: p.href, text: p.text }) : el("span", { text: p.text }));
  });
}

// ---------------------------------------------------------------- catalog
function showCatalog() {
  showView("catalog");
  document.title = "Claude Grid Workshop";
  setCrumbs([]);
  renderCatalog($("#catalog-search").value);
}

function renderCatalog(query = "") {
  const list = $("#catalog-list");
  list.replaceChildren();
  if (!state.catalog) return;
  const q = query.trim().toLowerCase();
  let shown = 0;
  for (const cat of state.catalog.categories) {
    const models = cat.models.filter((m) => !q ||
      [m.name, m.family_name, m.summary, ...(m.tags || [])].join(" ").toLowerCase().includes(q));
    if (!models.length) continue;
    shown += models.length;
    list.append(el("section", { class: "cat-section" },
      el("h2", {}, cat.label, el("small", { text: `${models.length} generator${models.length > 1 ? "s" : ""}` })),
      el("ul", { class: "cat-rows" }, models.map((m) => el("li", {},
        el("a", { href: `#/m/${m.key}` },
          el("span", { class: "m-name", text: m.name }),
          el("span", { class: "m-family", text: m.family_name }),
          licenseBadge(m.license) && el("span", { class: "m-badge" }, licenseBadge(m.license))))))));
  }
  const hits = [];
  for (const lib of state.libraries) {
    for (const it of lib.items) {
      if (q && [it.name, it.category, lib.name, ...(it.tags || [])].join(" ").toLowerCase().includes(q)) hits.push([lib, it]);
    }
  }
  if (state.libraries.length && (!q || hits.length)) {
    shown += q ? hits.length : state.libraries.length;
    list.append(el("section", { class: "cat-section" },
      el("h2", {}, "Ready-made parts", el("small", { text: q ? `${hits.length} part${hits.length === 1 ? "" : "s"}` : `${state.libraries.length} collection${state.libraries.length > 1 ? "s" : ""}` })),
      el("ul", { class: "cat-rows" }, q
        ? hits.slice(0, 30).map(([lib, it]) => el("li", {}, el("a", { href: `#/parts/${lib.id}/${it.id}` },
            el("span", { class: "m-name", text: it.name }), el("span", { class: "m-family", text: `${lib.name}, ${it.category.toLowerCase()}` }))))
        : state.libraries.map((lib) => el("li", {}, el("a", { href: `#/parts/${lib.id}` },
            el("span", { class: "m-name", text: lib.name }),
            el("span", { class: "m-family", text: `${lib.item_count} parts: ${lib.categories.join(", ").toLowerCase()}` })))))));
  }
  if (!shown) list.append(el("p", { class: "empty", text: `Nothing matches “${query}”. Try “bin”, “baseplate”, “label” or “connector”.` }));
  const missing = state.catalog.families.filter((f) => f.status === "missing-source");
  if (!q && missing.length) {
    list.append(el("p", { class: "missing", text: `Coming once their source files are added: ${missing.map((f) => f.name).join(", ")}.` }));
  }
}
$("#catalog-search").addEventListener("input", (e) => renderCatalog(e.target.value));

// ---------------------------------------------------------------- model page
async function openModel(key) {
  showView("model");
  if (state.model?.key === key) {
    if (state.viewerOwner !== "model") {
      state.viewerOwner = "model";
      $("#stage-empty").hidden = true;
      if (state.lastResult) showResult(state.lastResult, state.lastResultValues, true);
      else { state.viewer.clear(); $("#dims").hidden = true; }
    }
    return;
  }
  state.viewerOwner = "model";
  let detail;
  try {
    detail = await getJSON(`data/models/${key.replace("/", "--")}.json`);
  } catch (e) {
    setStatus("error", e.status === 404 ? "This generator doesn't exist. Pick one from the catalog." : e.message);
    return;
  }
  state.model = detail;
  state.rendered = null;
  state.lastResult = null;
  state.viewer.clear();
  $("#stage-empty").hidden = true;
  $("#dims").hidden = true;
  $("#log").hidden = true;
  setDownload(null);
  document.title = `${detail.name}, ${detail.family_name} | Claude Grid Workshop`;
  setCrumbs([{ text: "Generators", href: "#/" }, { text: detail.family_name }]);

  const fam = detail.family_name, nm = detail.name;
  $("#model-title").textContent = fam.toLowerCase().endsWith(nm.toLowerCase()) ? fam : `${fam} ${nm.toLowerCase()}`;
  $("#model-summary").textContent = detail.summary;
  const credit = $("#model-credit");
  credit.replaceChildren();
  if (detail.authors?.length) {
    credit.append("By ");
    detail.authors.forEach((a, i) => {
      if (i) credit.append(i === detail.authors.length - 1 ? " and " : ", ");
      credit.append(a.url ? el("a", { href: a.url, target: "_blank", rel: "noopener", text: a.name }) : a.name);
    });
    credit.append(". ");
  }
  if (detail.source?.repository) credit.append(el("a", { href: detail.source.repository, target: "_blank", rel: "noopener", text: "Source" }), ". ");
  credit.append(`License: ${detail.license?.spdx === "NOASSERTION" ? "not stated" : detail.license?.spdx}.`);
  $("#model-license").replaceChildren(...[licenseBadge(detail.license)].filter(Boolean));
  const notes = $("#model-notes");
  notes.replaceChildren(...(detail.description_html ? safeHTML(detail.description_html) : []));
  notes.hidden = !detail.description_html;

  state.values = Object.fromEntries(detail.parameters.map((p) => [p.name, structuredClone(p.default)]));
  $("#param-search").value = "";
  buildForm();
  generate(); // show the default part straight away
}

// ---------------------------------------------------------------- form
function buildForm() {
  const form = $("#params");
  form.replaceChildren();
  const { parameters, groups, tabs = {} } = state.model;
  const names = parameters.map((p) => p.name).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  state.conditions = [];
  for (const p of parameters) if (p.show_if) state.conditions.push({ test: compileCondition(p.show_if, names), name: p.name });
  for (const node of $("#model-notes").querySelectorAll("[data-display-condition]")) {
    state.conditions.push({ test: compileCondition(node.dataset.displayCondition, names), node });
  }
  groups.forEach((g, gi) => {
    const tab = tabs[g] || {};
    const fields = parameters.filter((p) => p.group === g && !p.hidden && p.name !== tab.control);
    const control = tab.control && parameters.find((p) => p.name === tab.control);
    const body = el("div", { class: "group-body" },
      tab.description_html ? el("div", { class: "group-note" }, safeHTML(tab.description_html)) : null,
      fields.map(buildField));
    const title = el("span", { class: "group-title", text: g === "Parameters" ? "Settings" : g });
    const summary = el("summary", {}, title);
    if (control) {
      const box = el("input", { type: "checkbox", class: "group-switch", "aria-label": `Use ${g.toLowerCase()}`,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { setValue(control, e.target.checked); det.open = e.target.checked; } });
      box.checked = !!state.values[control.name];
      summary.prepend(box);
    }
    if (tab.help_link) summary.append(el("a", { class: "help-link", href: tab.help_link, target: "_blank", rel: "noopener", text: "Help", onclick: (e) => e.stopPropagation() }));
    summary.append(el("span", { class: "changed-count" }));
    const open = control ? !!state.values[control.name] : tab.collapsed ? false : gi < 2 || groups.length <= 3;
    const det = el("details", { class: "group", "data-group": g, open }, summary, body);
    if (!fields.length && !control) return;
    form.append(det);
  });
  refreshChanged();
  applyConditions();
}

function buildField(p) {
  const id = `p-${p.name}`;
  const label = p.label || humanize(p.name);
  const helpNodes = [];
  if (p.description_html) helpNodes.push(el("div", { class: "help", id: `${id}-help` }, safeHTML(p.description_html)));
  else if (p.description) helpNodes.push(el("p", { class: "help", id: `${id}-help`, text: p.description }));
  const reset = el("button", { type: "button", class: "reset", text: "Reset", hidden: true,
    "aria-label": `Reset ${label}`, onclick: () => { setValue(p, structuredClone(p.default)); syncField(p); } });
  const helpLink = p.help_link ? el("a", { class: "help-link", href: p.help_link, target: "_blank", rel: "noopener", text: "Help" }) : null;
  const head = (labelNode) => el("div", { class: "field-head" }, labelNode, helpLink, reset);
  const wrap = el("div", { class: "field", "data-name": p.name, "data-search": `${p.name} ${label} ${p.description || ""}`.toLowerCase() });
  const describedby = helpNodes.length ? `${id}-help` : null;

  if (p.widget === "checkbox") {
    wrap.classList.add("check");
    wrap.append(el("input", { type: "checkbox", id, "aria-describedby": describedby, onchange: (e) => setValue(p, e.target.checked) }),
      head(el("label", { for: id, text: label })), ...helpNodes);
  } else if (p.widget === "dropdown") {
    const sel = el("select", { id, "aria-describedby": describedby,
      onchange: (e) => setValue(p, p.options[e.target.selectedIndex].value) },
      p.options.map((o) => el("option", { text: o.label })));
    wrap.append(head(el("label", { for: id, text: label })), sel, ...helpNodes);
  } else if (p.widget === "slider" && !Array.isArray(p.default)) {
    const step = p.step ?? (Number.isInteger(p.default) && Number.isInteger(p.min ?? 0) && Number.isInteger(p.max ?? 0) ? 1 : "any");
    const range = el("input", { type: "range", min: p.min, max: p.max, step: step === "any" ? (p.max - p.min) / 100 : step,
      "aria-hidden": "true", tabindex: "-1", oninput: (e) => { setValue(p, +e.target.value); syncField(p, "range"); } });
    const num = el("input", { type: "number", id, min: p.min, max: p.max, step, "aria-describedby": describedby,
      oninput: (e) => { if (e.target.value !== "" && e.target.checkValidity()) { setValue(p, +e.target.value); syncField(p, "number"); } } });
    wrap.append(head(el("label", { for: id, text: label })), el("div", { class: "slider" }, range, num), ...helpNodes);
  } else if (Array.isArray(p.default)) {
    const axes = p.default.length <= 3 ? ["X", "Y", "Z"] : p.default.map((_, i) => `${i + 1}`);
    const editable = p.default.every((v) => typeof v !== "object");
    const inputs = p.default.map((v, i) => {
      const t = typeof v === "boolean" ? "checkbox" : typeof v === "number" ? "number" : "text";
      return el("label", {}, axes[i] || `${i + 1}`, el("input", { type: t, "data-i": i, step: "any", min: p.min, max: p.max, disabled: !editable,
        oninput: (e) => {
          const next = structuredClone(state.values[p.name]);
          next[i] = t === "checkbox" ? e.target.checked : t === "number" ? (e.target.value === "" ? next[i] : +e.target.value) : e.target.value;
          setValue(p, next);
        } }));
    });
    wrap.append(head(el("span", { class: "label", id, text: label })),
      el("div", { class: "vector", role: "group", "aria-labelledby": id, style: `--n:${Math.min(p.default.length, 4)}` }, inputs), ...helpNodes);
  } else {
    const t = p.type === "number" ? "number" : "text";
    wrap.append(head(el("label", { for: id, text: label })),
      el("input", { type: t, id, step: "any", min: p.min, max: p.max, maxlength: t === "text" ? 200 : null, "aria-describedby": describedby,
        oninput: (e) => {
          if (t === "number") { if (e.target.value !== "" && e.target.checkValidity()) setValue(p, +e.target.value); }
          else setValue(p, e.target.value);
        } }), ...helpNodes);
  }
  if (p.presets) {
    const sel = el("select", { class: "presets", "aria-label": `${p.presets.label} for ${label}`,
      onchange: (e) => {
        const pick = p.presets.values[e.target.selectedIndex - 1];
        if (pick) { setValue(p, structuredClone(pick.value)); syncField(p); }
      } },
      el("option", { text: `${p.presets.label}…` }), p.presets.values.map((v) => el("option", { text: v.label })));
    wrap.insertBefore(sel, wrap.querySelector(".help") || null);
  }
  queueMicrotask(() => syncField(p));
  return wrap;
}

function syncField(p, skip) {
  const wrap = $(`.field[data-name="${CSS.escape(p.name)}"]`);
  if (!wrap) return;
  const v = state.values[p.name];
  if (p.widget === "checkbox") $("input", wrap).checked = v;
  else if (p.widget === "dropdown") $("select", wrap).selectedIndex = Math.max(0, p.options.findIndex((o) => same(o.value, v)));
  else if (p.widget === "slider" && !Array.isArray(p.default)) {
    if (skip !== "range") $('input[type="range"]', wrap).value = v;
    if (skip !== "number") $('input[type="number"]', wrap).value = v;
  } else if (Array.isArray(p.default)) {
    wrap.querySelectorAll("input[data-i]").forEach((inp) => {
      const x = v[+inp.dataset.i];
      if (inp.type === "checkbox") inp.checked = x; else if (document.activeElement !== inp) inp.value = typeof x === "object" ? JSON.stringify(x) : x;
    });
  } else {
    const inp = $("input", wrap);
    if (document.activeElement !== inp) inp.value = v;
  }
  if (p.presets) {
    const i = p.presets.values.findIndex((x) => same(x.value, v));
    $(".presets", wrap).selectedIndex = i + 1;
  }
  refreshChanged();
}

function setValue(p, v) {
  state.values[p.name] = v;
  refreshChanged();
  applyConditions();
  updateStatusForEdits();
}

function applyConditions() {
  for (const c of state.conditions) {
    const show = c.test(state.values);
    if (c.node) c.node.hidden = !show, c.node.style.display = show ? "" : "none";
    else $(`.field[data-name="${CSS.escape(c.name)}"]`)?.classList.toggle("cond-hidden", !show);
  }
}

function refreshChanged() {
  if (!state.model) return;
  for (const p of state.model.parameters) {
    const wrap = $(`.field[data-name="${CSS.escape(p.name)}"]`);
    if (!wrap) continue;
    const changed = !same(state.values[p.name], p.default);
    wrap.classList.toggle("changed", changed);
    $(".reset", wrap).hidden = !changed;
  }
  document.querySelectorAll(".group").forEach((g) => {
    const n = g.querySelectorAll(".field.changed").length;
    $(".changed-count", g).textContent = n ? `${n} changed` : "";
  });
}

$("#reset-all").addEventListener("click", () => {
  if (!state.model) return;
  for (const p of state.model.parameters) { state.values[p.name] = structuredClone(p.default); syncField(p); }
  document.querySelectorAll(".group-switch").forEach((b) => {
    const g = b.closest(".group"); const tab = state.model.tabs?.[g.dataset.group];
    if (tab?.control) { b.checked = !!state.values[tab.control]; g.open = b.checked; }
  });
  applyConditions();
  updateStatusForEdits();
});

$("#param-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".group").forEach((g) => {
    let any = false;
    g.querySelectorAll(".field").forEach((f) => {
      const hit = !q || f.dataset.search.includes(q);
      f.classList.toggle("search-hidden", !hit);
      any ||= hit && !f.classList.contains("cond-hidden");
    });
    g.hidden = q ? !any : false;
    if (q && any) g.open = true;
  });
});

// ---------------------------------------------------------------- rendering
function setStatus(kind, text) {
  const s = $("#status");
  s.className = `status ${kind || ""}`;
  s.textContent = text;
}

function updateStatusForEdits() {
  if (state.job) return;
  const a = $("#download");
  if (state.rendered && same(JSON.parse(state.rendered), state.values)) {
    setStatus("ok", "Preview matches your settings.");
    if (!a.classList.contains("is-disabled")) a.textContent = "Download STL";
  } else if (state.rendered) {
    setStatus("stale", "Settings changed. Generate to update the preview and download.");
    if (!a.classList.contains("is-disabled")) a.textContent = "Download last render";
  }
}

function friendlyName(model, values) {
  let base = `${model.family}-${model.id}`;
  const dims = [];
  for (const k of ["gridx", "gridy", "gridz", "Width", "Depth", "Height", "Width_Units", "Length_Units",
    "Board_Width", "Board_Height", "shelf_width", "shelf_depth", "GridSize", "plate_size"]) {
    if (k in values) [].concat(values[k]).forEach((x) => { if (typeof x === "number") dims.push(String(x)); });
  }
  const part = model.part_parameter;
  if (part && ["string", "number"].includes(typeof values[part])) base += `-${values[part]}`;
  return (base + (dims.length ? "-" + dims.slice(0, 4).join("x") : "")).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) + ".stl";
}

function setDownload(blob, name) {
  const a = $("#download");
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = blob ? URL.createObjectURL(blob) : null;
  a.href = state.downloadUrl || "#";
  a.download = name || "model.stl";
  a.classList.toggle("is-disabled", !blob);
  if (blob) a.removeAttribute("aria-disabled"); else a.setAttribute("aria-disabled", "true");
  a.textContent = "Download STL";
}

function generate() {
  if (!state.model || !state.engine) return;
  cancelJob();
  const values = structuredClone(state.values);
  const model = state.model;
  const started = Date.now();
  $("#generate").disabled = true;
  $("#log").hidden = true;
  let stage = "Starting…";
  const job = state.engine.render(model, values, (ev) => { if (ev.type === "stage") stage = ev.stage; });
  state.job = job;
  const tick = () => {
    if (state.job !== job) return;
    const secs = Math.round((Date.now() - started) / 1000);
    setStatus("busy", `${stage} ${secs}s`);
    if (secs >= 1 || !state.rendered) showOverlay(`${stage}${secs > 15 ? " Detailed parts can take a minute or more on slower devices." : ""}`);
    job.timer = setTimeout(tick, 500);
  };
  tick();
  job.promise.then(async (result) => {
    if (state.job !== job) return;
    finishJob();
    await showResult(result, values);
  }, (err) => {
    if (state.job !== job) return;
    finishJob();
    if (err.cancelled) { setStatus("stale", "Render cancelled."); return; }
    setStatus("error", err.message);
    if (err.logs?.length) { $("#log-text").textContent = err.logs.join("\n"); $("#log").hidden = false; }
  });
}

function finishJob() {
  if (state.job) clearTimeout(state.job.timer);
  state.job = null;
  showOverlay(null);
  $("#generate").disabled = false;
}

function cancelJob() {
  if (!state.job) return;
  const j = state.job;
  finishJob();
  j.cancel();
}

async function showResult(result, values, restoring = false) {
  try {
    const url = URL.createObjectURL(result.blob);
    const dims = await state.viewer.load(url);
    URL.revokeObjectURL(url);
    state.rendered = JSON.stringify(values);
    state.lastResult = result;
    state.lastResultValues = values;
    showDims(dims, result.blob.size);
    setDownload(result.blob, friendlyName(state.model, values));
    if (!restoring) {
      setStatus("ok", result.cached ? "Preview matches your settings." : `Preview matches your settings. Made in ${fmt(result.ms / 1000)} s on this device.`);
    }
    if (!same(values, state.values)) updateStatusForEdits();
  } catch (e) {
    setStatus("error", e.message);
  }
}

function showOverlay(text) {
  $("#stage-overlay").hidden = !text;
  if (text) $("#overlay-text").textContent = text;
}

function showDims(d, size) {
  const box = $("#dims");
  const grid = state.viewerOwner === "model" && GRID_CATEGORIES.has(state.model?.category);
  const units = (v) => fmt(Math.round(v / 42 * 2) / 2);
  const gridText = `About ${units(d.x)} × ${units(d.y)} grid units` + (d.z >= 7 ? `, ${fmt(d.z / 7)} height units` : "");
  box.replaceChildren(...[
    el("span", { class: "mm", text: `${fmt(d.x)} × ${fmt(d.y)} × ${fmt(d.z)} mm` }),
    grid && el("span", { class: "units", text: gridText }),
    el("span", { class: "meta", text: `${d.triangles.toLocaleString()} triangles${size ? `, ${bytes(size)}` : ""}` }),
  ].filter(Boolean));
  box.hidden = false;
}

$("#generate").addEventListener("click", generate);
$("#params").addEventListener("submit", (e) => { e.preventDefault(); generate(); });
$("#params").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input:not([type=checkbox])")) { e.preventDefault(); generate(); }
});
$("#cancel").addEventListener("click", () => { cancelJob(); setStatus("stale", "Render cancelled."); });

// ---------------------------------------------------------------- part libraries
async function openLibrary(libId, itemId) {
  showView("library");
  let lib = state.libDetail[libId];
  if (!lib) {
    try {
      lib = state.libDetail[libId] = await getJSON(`data/libraries/${libId}.json`);
    } catch {
      $("#lib-title").textContent = "Parts not found";
      $("#lib-summary").textContent = "This collection doesn't exist. Go back to the catalog to pick one.";
      return;
    }
  }
  if (state.openLib !== libId) {
    state.openLib = libId;
    $("#lib-title").textContent = lib.name;
    $("#lib-summary").textContent = lib.summary || "";
    const credit = $("#lib-credit");
    credit.replaceChildren();
    if (lib.authors?.length) credit.append(`By ${lib.authors.map((a) => a.name).join(", ")}. `);
    if (lib.source_url) credit.append(el("a", { href: lib.source_url, target: "_blank", rel: "noopener", text: "Original page" }), ". ");
    credit.append(`License: ${lib.license?.spdx}.`);
    $("#part-search").value = "";
    buildPartList(lib);
  }
  const item = lib.items.find((i) => i.id === itemId) || lib.items.find((i) => i.preview_url) || lib.items[0];
  if (!itemId && item) history.replaceState(null, "", `#/parts/${libId}/${item.id}`);
  showPart(lib, item);
}

function buildPartList(lib) {
  const nav = $("#part-list");
  nav.replaceChildren();
  for (const c of [...new Set(lib.items.map((i) => i.category))]) {
    nav.append(el("div", { class: "part-group", "data-cat": c },
      el("h2", { text: c }),
      el("ul", {}, lib.items.filter((i) => i.category === c).map((i) => el("li", {},
        el("a", { href: `#/parts/${lib.id}/${i.id}`, "data-id": i.id, "data-search": [i.name, c, ...(i.tags || [])].join(" ").toLowerCase() },
          el("span", { text: i.name }),
          el("span", { class: "formats", text: [...new Set(i.files.map((f) => FORMAT_LABEL[f.format] || f.format))].join(" ") })))))));
  }
}

$("#part-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".part-group").forEach((g) => {
    let any = false;
    g.querySelectorAll("a").forEach((a) => { const hit = !q || a.dataset.search.includes(q); a.parentElement.hidden = !hit; any ||= hit; });
    g.hidden = !any;
  });
});

async function showPart(lib, item) {
  if (!item) return;
  document.title = `${item.name}, ${lib.name} | Claude Grid Workshop`;
  setCrumbs([{ text: "Generators", href: "#/" }, { text: lib.name, href: `#/parts/${lib.id}` }, { text: item.name }]);
  document.querySelectorAll("#part-list a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.id === item.id));
  const nav = $("#part-list"), cur = $(`#part-list a[data-id="${CSS.escape(item.id)}"]`);
  if (cur && nav.scrollHeight > nav.clientHeight + 1) {
    const top = cur.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop || top > nav.scrollTop + nav.clientHeight - 80) nav.scrollTop = top - nav.clientHeight / 3;
  }
  const status = $("#part-status");
  status.replaceChildren(el("p", { class: "part-name", text: item.name }));
  if (item.description) status.append(el("p", { class: "help", text: item.description }));
  if (item.generator) status.append(el("p", { class: "help" }, el("a", { href: `#/m/${item.generator}`, text: "Open the generator" }), " to print it at any size."));
  const dl = $("#part-downloads");
  dl.replaceChildren(...item.files.map((f, i) => el("a", {
    class: `button ${i === 0 && !["step", "shapr"].includes(f.format) ? "primary" : "secondary"}`, href: f.url,
    download: f.path.split("/").pop(), title: f.path.split("/").pop(),
    text: `${f.label ? f.label + ": " : ""}${FORMAT_LABEL[f.format] || f.format} (${bytes(f.bytes)})` })));
  dl.classList.toggle("many", item.files.length > 4);
  state.viewerOwner = "library";
  $("#log").hidden = true;
  showOverlay(null);
  state.viewer.clear();
  $("#dims").hidden = true;
  const empty = $("#stage-empty");
  if (!item.preview_url) {
    empty.textContent = "No 3D preview: this part comes as CAD files (STEP or Shapr3D) for remixing.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  try {
    const d = await state.viewer.load(item.preview_url);
    if (state.viewerOwner === "library") showDims(d);
  } catch (e) {
    empty.textContent = `Preview unavailable: ${e.message}`;
    empty.hidden = false;
  }
}

// ---------------------------------------------------------------- about
function showAbout() {
  showView("about");
  document.title = "About | Claude Grid Workshop";
  setCrumbs([{ text: "Generators", href: "#/" }, { text: "About" }]);
  const c = state.catalog;
  const body = $("#about-body");
  body.replaceChildren(
    el("p", { text: `Every part is made in your browser by OpenSCAD ${c?.engine || ""} (WebAssembly build). Nothing you configure is sent to a server, and once loaded the site keeps working offline.` }),
    el("p", {}, "OpenSCAD is free software under the GNU GPL, version 2 or later: ",
      el("a", { href: "https://github.com/openscad/openscad", target: "_blank", rel: "noopener", text: "source code" }), ", ",
      el("a", { href: "engine/COPYING", target: "_blank", text: "license" }), "."),
    el("h2", { text: "Generators" }),
    el("ul", {}, (c?.families || []).filter((f) => f.status !== "missing-source").map((f) => el("li", {},
      el("b", { text: f.name }), ` by ${(f.authors || []).map((a) => a.name).join(", ") || "unknown"}. License: ${f.license?.spdx === "NOASSERTION" ? "not stated" : f.license?.spdx}.`))),
    el("h2", { text: "Parts" }),
    el("ul", {}, state.libraries.map((l) => el("li", {}, el("b", { text: l.name }), ` by ${(l.authors || []).map((a) => a.name).join(", ")}. License: ${l.license?.spdx}.`))),
    el("p", { class: "muted", text: "Fonts for text on parts: Liberation Sans and Liberation Mono (SIL Open Font License). 3D preview: three.js (MIT)." }));
}

// ---------------------------------------------------------------- viewer tools
document.querySelectorAll(".hud-tools [data-view]").forEach((b) => b.addEventListener("click", () => state.viewer?.view(b.dataset.view)));
document.querySelectorAll(".hud-tools [data-toggle]").forEach((b) => b.addEventListener("click", () => {
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", String(on));
  if (b.dataset.toggle === "edges") state.viewer?.setEdges(on);
  if (b.dataset.toggle === "grid") state.viewer?.setGrid(on);
}));
const fil = $("#filament");
FILAMENTS.forEach(([name, hex]) => {
  const b = el("button", { type: "button", class: "swatch", role: "radio", "aria-checked": String(hex === savedColor),
    "aria-label": name, title: name, style: `--c:${hex}`,
    onclick: () => {
      fil.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-checked", String(s === b)));
      state.viewer?.setColor(hex);
      try { localStorage.setItem("gw-filament", hex); } catch { /* private mode */ }
    } });
  fil.append(b);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    state.catalog = await getJSON("data/catalog.json");
    state.engine = new EngineClient({ commonFiles: state.catalog.common_files });
    $("#engine").textContent = `OpenSCAD ${state.catalog.engine}, in your browser`;
    state.libraries = await Promise.all((state.catalog.libraries || []).map((l) => getJSON(`data/libraries/${l.id}.json`)));
    for (const l of state.libraries) state.libDetail[l.id] = l;
  } catch (e) {
    $("#catalog-list").replaceChildren(el("p", { class: "empty", text: `Couldn't load the generator list: ${e.message}. Reload to try again.` }));
  }
  route();
})();
