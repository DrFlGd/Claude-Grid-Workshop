// Claude Grid Workshop front end (static): catalog, settings forms with
// upstream editor metadata, in-browser OpenSCAD renders, 3D preview, parts.
import { Viewer } from "./viewer.js";
import { createPlatform } from "./platform.js";
import { makeZip } from "./zip.js";
import { changedValues, withChanges, encodeShare, decodeShare, toOpenSCAD, fromOpenSCAD } from "./settings-codec.js";

// page errors, for the desktop UI test (tests/desktop_ui.py)
window.addEventListener("error", (e) => { (window.__errors ||= []).push(String(e.message)); });
window.addEventListener("unhandledrejection", (e) => { (window.__errors ||= []).push(String(e.reason?.message || e.reason)); });

const platform = await createPlatform();
const store = platform.store;

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
  const r = await platform.fetch(path);
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
  const axis = name.match(/^(grid|size|offset|pos|position|count|units|scale|rotate|spacing|divisions?)([xyz])$/);
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
const savedColor = store.prefs.get("gw-filament") || FILAMENTS[0][1];

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
  const m = h.match(/^m\/([a-z0-9-]+)\/([a-z0-9-]+)\/?(?:\?(.*))?$/);
  const p = h.match(/^parts\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/);
  if (m) openModel(`${m[1]}/${m[2]}`, new URLSearchParams(m[3] || "").get("s"));
  else if (p) openLibrary(p[1], p[2]);
  else if (h === "about" || h.startsWith("licenses")) showLicenses(h.split("/")[1]);
  else if (h === "settings") showSettings();
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

// Collapsed/expanded state of home-page sections, remembered per browser
const openState = store.prefs.get("gw-open", {}) || {};
const saveOpen = (id, open) => { openState[id] = open; store.prefs.set("gw-open", openState); };

function foldable(id, defaultOpen, cls, summary, ...body) {
  const d = el("details", { class: cls, "data-fold": id }, el("summary", {}, summary), ...body);
  d.open = id in openState ? openState[id] : defaultOpen;
  d.addEventListener("toggle", () => { if (!d.dataset.searching) saveOpen(id, d.open); });
  return d;
}

/** Home page: type -> project -> generators. Each project is one compact block. */
function renderCatalog(query = "") {
  const list = $("#catalog-list");
  list.replaceChildren();
  if (!state.catalog) return;
  const q = query.trim().toLowerCase();
  const famById = Object.fromEntries(state.catalog.families.map((f) => [f.id, f]));
  const hit = (...words) => !q || words.join(" ").toLowerCase().includes(q);
  const sections = [];
  let shown = 0;

  for (const cat of state.catalog.categories) {
    const projects = new Map();
    for (const m of cat.models) {
      if (!projects.has(m.family)) projects.set(m.family, { fam: famById[m.family] || {}, name: m.family_name, summary: m.summary, tags: m.tags || [], models: [] });
      projects.get(m.family).models.push(m);
    }
    // a search shows the generators whose own name matches; if none do, a match on the
    // project's name, author, tags or description shows the whole project
    for (const [id, p] of projects) {
      if (!q) continue;
      const named = p.models.filter((m) => hit(m.name));
      if (named.length) p.models = named;
      else if (!hit(p.name, p.summary, ...p.tags, ...(p.fam.authors || []).map((a) => a.name))) projects.delete(id);
    }
    if (!projects.size) continue;
    const blocks = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      shown += p.models.length;
      const authors = (p.fam.authors || []).map((a) => a.name).join(", ");
      return el("div", { class: "project" },
        el("div", { class: "project-head" },
          el("h3", { text: p.name }),
          el("p", { class: "project-meta" }, `${p.models.length} generator${p.models.length > 1 ? "s" : ""}${authors ? `, by ${authors}` : ""}`)),
        el("ul", { class: "chips" }, p.models.map((m) => el("li", {},
          el("a", { href: `#/m/${m.key}`, class: "chip", title: m.summary, text: p.models.length === 1 && m.name === p.name ? "Open" : m.name })))));
    });
    const count = [...projects.values()].reduce((n, p) => n + p.models.length, 0);
    sections.push(foldable(`type:${cat.id}`, true, "type-section",
      [el("h2", { text: cat.label }), el("small", { text: `${projects.size} project${projects.size > 1 ? "s" : ""}, ${count} generator${count > 1 ? "s" : ""}` })],
      el("div", { class: "projects" }, blocks)));
  }

  // ready-made parts: libraries as projects, their categories as chips
  const libBlocks = [];
  for (const lib of state.libraries) {
    const items = lib.items.filter((it) => hit(it.name, it.category, lib.name, ...(it.tags || [])));
    if (!items.length) continue;
    shown += q ? items.length : 1;
    const chips = q
      ? items.slice(0, 40).map((it) => el("li", {}, el("a", { class: "chip", href: `#/parts/${lib.id}/${it.id}`, text: it.name })))
      : [...new Set(lib.items.map((i) => i.category))].map((c) => {
          const first = lib.items.find((i) => i.category === c);
          const n = lib.items.filter((i) => i.category === c).length;
          return el("li", {}, el("a", { class: "chip", href: `#/parts/${lib.id}/${first.id}`, text: `${c} (${n})` }));
        });
    libBlocks.push(el("div", { class: "project" },
      el("div", { class: "project-head" }, el("h3", { text: lib.name }),
        el("p", { class: "project-meta" }, `${lib.item_count} parts, by ${(lib.authors || []).map((a) => a.name).join(", ")}`)),
      el("ul", { class: "chips" }, chips)));
  }
  if (libBlocks.length) {
    sections.push(foldable("type:parts", true, "type-section",
      [el("h2", { text: "Ready-made parts" }), el("small", { text: `${libBlocks.length} collection${libBlocks.length > 1 ? "s" : ""}` })],
      el("div", { class: "projects" }, libBlocks)));
  }

  if (q) for (const s of sections) { s.dataset.searching = "1"; s.open = true; }
  // jump bar: one link per type, so a long page stays easy to move around
  if (!q && sections.length > 2) {
    list.append(el("nav", { class: "type-nav", "aria-label": "Jump to a type" },
      sections.map((s) => el("a", { href: "#", text: s.querySelector("h2").textContent,
        onclick: (e) => { e.preventDefault(); s.open = true; s.scrollIntoView({ behavior: "smooth", block: "start" }); } }))));
  }
  list.append(...sections);
  if (!shown) list.append(el("p", { class: "empty", text: `Nothing matches “${query}”. Try “bin”, “baseplate”, “label” or “connector”.` }));
  const missing = state.catalog.families.filter((f) => f.status === "missing-source");
  if (!q && missing.length) {
    list.append(el("p", { class: "missing", text: `Coming once their source files are added: ${missing.map((f) => f.name).join(", ")}.` }));
  }
  list.append(el("footer", { class: "site-footer" },
    el("a", { href: "#/licenses", text: "Licenses & credits" }),
    el("span", { text: "Every model is open work by its author. See each project's license before sharing or selling prints." })));
}
$("#catalog-search").addEventListener("input", (e) => renderCatalog(e.target.value));

// ---------------------------------------------------------------- model page
async function openModel(key, shareCode = null) {
  showView("model");
  if (shareCode) history.replaceState(null, "", `#/m/${key}`); // the link has done its job; edits shouldn't look shared
  if (state.model?.key === key && shareCode) {
    const shared = await readShare(shareCode);
    if (shared && !shared.error) { setAllValues(shared.values); generate(); }
    if (shared) noteShared(shared);
    return;
  }
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
  if (detail.browser === false && platform.kind === "browser") {
    showView("catalog");
    renderCatalog();
    setCrumbs([{ text: "Generators", href: "#/" }]);
    $("#catalog-list").prepend(el("p", { class: "missing", text: `${detail.family_name} ${detail.name} is too complex for the browser engine. It works in the desktop app.` }));
    return;
  }
  applyProfile(detail);
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
  // "Gridfinity Rebuilt basic bin", but keep single letters and acronyms: "Underware X channel"
  const soft = nm.split(" ").map((w) => (/^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(" ");
  $("#model-title").textContent = fam.toLowerCase().includes(nm.toLowerCase()) ? fam : `${fam} ${soft}`;
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
  credit.append(el("a", { href: `#/licenses/${detail.family}`, text: "License details" }), ".");
  // author notes fold away; their conditional warnings stay visible above the form
  const notesNodes = detail.description_html ? safeHTML(detail.description_html) : [];
  const holder = document.createElement("div");
  holder.append(...notesNodes);
  const alerts = [...holder.querySelectorAll("[class^=alert]")];
  alerts.forEach((a) => a.remove());
  $("#model-alerts").replaceChildren(...alerts);
  const hasNotes = !!holder.textContent.trim();
  $("#model-notes-body").replaceChildren(...holder.childNodes);
  $("#model-notes").hidden = !hasNotes;
  $("#model-notes").open = false;

  state.values = Object.fromEntries(detail.parameters.map((p) => [p.name, structuredClone(p.default)]));
  saved.active = null;
  const shared = shareCode ? await readShare(shareCode) : null;
  if (shared && !shared.error) state.values = shared.values;
  $("#param-search").value = "";
  buildForm();
  if (shared) noteShared(shared);
  loadSaved();
  generate(); // show the default part straight away
  document.body.dataset.model = key; // lets tests know which model's render is on screen
}

// ---------------------------------------------------------------- form
function buildForm() {
  const form = $("#params");
  form.replaceChildren();
  const { parameters, groups, tabs = {}, presets = [] } = state.model;
  form.append(settingsBar(presets));
  const names = parameters.map((p) => p.name).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  state.conditions = [];
  for (const p of parameters) if (p.show_if) state.conditions.push({ test: compileCondition(p.show_if, names), name: p.name });
  for (const node of document.querySelectorAll("#model-alerts [data-display-condition], #model-notes-body [data-display-condition]")) {
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
    if (tab.help_link) summary.append(el("a", { class: "help-link", href: tab.help_link, target: "_blank", rel: "noopener", text: "?", title: "Documentation", "aria-label": `Documentation for ${g}`, onclick: (e) => e.stopPropagation() }));
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
  const reset = el("button", { type: "button", class: "reset", text: "↺", hidden: true, title: `Reset to ${JSON.stringify(p.default)}`,
    "aria-label": `Reset ${label}`, onclick: () => { setValue(p, structuredClone(p.default)); syncField(p); } });
  const helpLink = p.help_link ? el("a", { class: "help-link", href: p.help_link, target: "_blank", rel: "noopener", text: "?",
    title: "Documentation", "aria-label": `Documentation for ${label}` }) : null;
  const tip = p.description || (p.description_html ? helpNodes[0].textContent : null);
  const head = (labelNode) => {
    if (tip) labelNode.title = tip; // short labels; full explanation on hover or with Help on
    const prof = p.profiled ? el("a", { class: "profile-tag", href: "#/settings", text: "profile",
      title: "Starts from your printer profile (Settings)" }) : null;
    return el("div", { class: "field-head" }, labelNode, prof, helpLink, reset);
  };
  const wrap = el("div", { class: "field", "data-name": p.name, "data-search": `${p.name} ${label} ${p.description || ""}`.toLowerCase() });
  const describedby = helpNodes.length ? `${id}-help` : null;

  if (p.widget === "checkbox") {
    wrap.classList.add("check");
    wrap.append(head(el("label", { for: id, text: label })),
      el("input", { type: "checkbox", id, "aria-describedby": describedby, onchange: (e) => setValue(p, e.target.checked) }), ...helpNodes);
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
    const axes = p.axes || (p.default.length <= 3 ? ["X", "Y", "Z"] : p.default.map((_, i) => `${i + 1}`));
    const editable = p.default.every((v) => typeof v !== "object");
    const inputs = p.default.map((v, i) => {
      const t = typeof v === "boolean" ? "checkbox" : typeof v === "number" ? "number" : "text";
      const ax = axes[i] || `${i + 1}`;
      return el("label", { "data-axis": ax, style: `--ax:${ax.length}` }, ax, el("input", { type: t, "data-i": i, "aria-label": `${label} ${axes[i] || i + 1}`, step: "any", min: p.min, max: p.max, disabled: !editable,
        oninput: (e) => {
          const next = structuredClone(state.values[p.name]);
          next[i] = t === "checkbox" ? e.target.checked : t === "number" ? (e.target.value === "" ? next[i] : +e.target.value) : e.target.value;
          setValue(p, next);
        } }));
    });
    wrap.append(head(el("span", { class: "label", id, text: label })),
      el("div", { class: p.default.length >= 3 && axes.some((a) => a.length > 2) ? "vector named" : "vector", role: "group", "aria-labelledby": id, style: `--n:${Math.min(p.default.length, 4)}` }, inputs), ...helpNodes);
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
  // a section whose settings are all switched off by conditions disappears too
  document.querySelectorAll("#params .group").forEach((g) => {
    const fields = g.querySelectorAll(".field");
    g.classList.toggle("cond-hidden", !g.querySelector(".group-switch") && fields.length > 0 &&
      [...fields].every((f) => f.classList.contains("cond-hidden")));
  });
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

const helpBtn = $("#help-toggle");
const setHelp = (on) => {
  document.body.classList.toggle("show-help", on);
  helpBtn.setAttribute("aria-pressed", String(on));
  store.prefs.set("gw-help", on);
};
helpBtn.addEventListener("click", () => setHelp(!document.body.classList.contains("show-help")));
setHelp(!!store.prefs.get("gw-help", false));

/** Replace every setting (missing names fall back to defaults) and update the form. */
function setAllValues(values) {
  for (const p of state.model.parameters) {
    state.values[p.name] = structuredClone(p.name in values ? values[p.name] : p.default);
    syncField(p);
  }
  document.querySelectorAll(".group-switch").forEach((b) => {
    const g = b.closest(".group"); const tab = state.model.tabs?.[g.dataset.group];
    if (tab?.control) { b.checked = !!state.values[tab.control]; g.open = b.checked; }
  });
  applyConditions();
  updateStatusForEdits();
}

$("#reset-all").addEventListener("click", () => {
  if (!state.model) return;
  setAllValues({});
  saved.active = null;
  renderSettingsPick();
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

// ---------------------------------------------------------------- saved settings and share links
// saved.active: "default" | "preset:<i>" | "saved:<id>" (what the picker shows)
const saved = { list: [], active: null };

function settingsBar(presets) {
  const pick = el("select", { id: "settings-pick", "aria-label": "Start from defaults, a preset or your saved settings",
    onchange: (e) => chooseSettings(e.target.value) });
  const more = el("details", { class: "menu", id: "settings-more" },
    el("summary", { class: "ghost", "aria-label": "More settings actions", title: "More", text: "⋯" }),
    el("div", { class: "menu-panel", role: "menu" },
      el("button", { type: "button", role: "menuitem", id: "settings-rename", text: "Rename…", onclick: () => { closeMenu(); openSaveDialog("rename"); } }),
      el("button", { type: "button", role: "menuitem", id: "settings-delete", text: "Delete", onclick: () => { closeMenu(); deleteSaved(); } }),
      el("hr"),
      el("button", { type: "button", role: "menuitem", id: "settings-export", text: "Export for OpenSCAD", title: "All saved settings for this model, as an OpenSCAD Customizer file", onclick: () => { closeMenu(); exportSettings(); } }),
      el("button", { type: "button", role: "menuitem", id: "settings-import-btn", text: "Import OpenSCAD file…", onclick: () => { closeMenu(); $("#settings-import").click(); } })));
  const bar = el("div", { class: "preset-bar" },
    el("label", { for: "settings-pick", class: "visually-hidden", text: "Start from" }), pick,
    el("button", { type: "button", class: "ghost", id: "settings-save", text: "Save", title: "Save these settings in this browser", onclick: () => openSaveDialog("save") }),
    el("button", { type: "button", class: "ghost", id: "settings-share", text: "Share", title: "Copy a link that opens this model with these settings", onclick: shareSettings }),
    more);
  const note = el("p", { id: "settings-note", class: "settings-note", role: "status", hidden: true });
  saved.presets = presets;
  queueMicrotask(renderSettingsPick);
  return el("div", { class: "settings-bar" }, bar, note);
}

const closeMenu = () => { const m = $("#settings-more"); if (m) m.open = false; };
document.addEventListener("click", (e) => { if (!e.target.closest?.("#settings-more")) closeMenu(); });

function renderSettingsPick() {
  const pick = $("#settings-pick");
  if (!pick || !state.model) return;
  const presets = state.model.presets || [];
  pick.replaceChildren(
    el("option", { value: "default", text: "Defaults" }),
    presets.length ? el("optgroup", { label: "Presets" }, presets.map((ps, i) => el("option", { value: `preset:${i}`, text: ps.label }))) : null,
    saved.list.length ? el("optgroup", { label: "Saved" }, saved.list.map((r) => el("option", { value: `saved:${r.id}`, text: r.name }))) : null);
  pick.value = saved.active || "default";
  if (pick.selectedIndex < 0) pick.value = "default";
  const isSaved = (saved.active || "").startsWith("saved:");
  $("#settings-rename").disabled = !isSaved;
  $("#settings-delete").disabled = !isSaved;
  $("#settings-export").disabled = false;
}

async function loadSaved() {
  const key = state.model.key;
  try { saved.list = await store.settings.list(key); } catch { saved.list = []; }
  if (state.model?.key === key) renderSettingsPick();
}

const activeSaved = () => saved.list.find((r) => `saved:${r.id}` === saved.active) || null;

let noteTimer = null;
function note(text, kind = "") {
  const n = $("#settings-note");
  if (!n) return;
  n.textContent = text;
  n.className = `settings-note ${kind}`;
  n.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { n.hidden = true; }, 9000);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const skippedText = (n) => (n ? ` ${plural(n, "setting")} didn't match this version of the model and stayed at the default.` : "");

function chooseSettings(value) {
  if (value === "default") setAllValues({});
  else if (value.startsWith("preset:")) {
    const ps = state.model.presets[+value.slice(7)];
    if (!ps) return;
    setAllValues({ ...state.values, ...ps.values }); // author presets set only what they're about (e.g. size)
  } else if (value.startsWith("saved:")) {
    const rec = saved.list.find((r) => `saved:${r.id}` === value);
    if (!rec) return;
    const { values, skipped } = withChanges(state.model, rec.values);
    setAllValues(values);
    if (skipped.length) note(skippedText(skipped.length).trim(), "warn");
  }
  saved.active = value;
  renderSettingsPick();
  generate();
}

function openSaveDialog(mode) {
  if (!state.model) return;
  const dlg = $("#save-dialog");
  const cur = activeSaved();
  const changes = Object.keys(changedValues(state.model, state.values)).length;
  dlg.dataset.mode = mode;
  $("#save-title").textContent = mode === "rename" ? "Rename saved settings" : "Save settings";
  const name = $("#save-name");
  name.value = mode === "rename" ? cur?.name || "" : cur ? cur.name : suggestName();
  const updating = mode === "save" && !!cur;
  dlg.dataset.updating = updating ? "1" : "";
  $("#save-alt").hidden = !updating; // "Save as new"
  $("#save-primary").textContent = mode === "rename" ? "Rename" : updating ? `Update “${cur.name}”` : "Save";
  store.settings.persistent().then((keep) => {
    $("#save-note").textContent = mode === "rename" ? "" :
      `Keeps the ${plural(changes, "setting")} you changed from the defaults` +
      (platform.kind === "browser" ? (keep ? ", in this browser." : ". This browser isn't keeping site data (private window?), so they'll be gone when you close the tab.") : ".");
  });
  dlg.showModal();
  name.select();
}

function suggestName() {
  const c = changedValues(state.model, state.values);
  const byName = new Map(state.model.parameters.map((p) => [p.name, p]));
  const bits = Object.entries(c).slice(0, 3).map(([k, v]) => `${byName.get(k)?.label || humanize(k)} ${Array.isArray(v) ? v.join("×") : v}`);
  return bits.join(", ").slice(0, 60) || "My settings";
}

function uniqueName(name, exceptId = null) {
  const taken = new Set(saved.list.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
}

async function saveSettings(asNew) {
  const dlg = $("#save-dialog");
  const mode = dlg.dataset.mode;
  const name = $("#save-name").value.trim();
  if (!name) { $("#save-name").focus(); return; }
  const cur = activeSaved();
  const key = state.model.key;
  try {
    let rec;
    if (mode === "rename" && cur) rec = await store.settings.save({ id: cur.id, name: uniqueName(name, cur.id) });
    else if (!asNew && cur) rec = await store.settings.save({ id: cur.id, name: uniqueName(name, cur.id), values: changedValues(state.model, state.values) });
    else rec = await store.settings.save({ model: key, name: uniqueName(name), values: changedValues(state.model, state.values) });
    dlg.close();
    saved.active = `saved:${rec.id}`;
    await loadSaved();
    note(mode === "rename" ? `Renamed to “${rec.name}”.` : `Saved “${rec.name}”.`, "ok");
  } catch (e) {
    note(`Couldn't save: ${e.message}`, "warn");
  }
}

async function deleteSaved() {
  const cur = activeSaved();
  if (!cur || !confirm(`Delete saved settings “${cur.name}”? The form keeps its current values.`)) return;
  await store.settings.remove(cur.id);
  saved.active = null;
  await loadSaved();
  note(`Deleted “${cur.name}”.`);
}

async function shareSettings() {
  if (!state.model) return;
  const changes = changedValues(state.model, state.values);
  const n = Object.keys(changes).length;
  const base = `${location.origin}${location.pathname}#/m/${state.model.key}`;
  const url = n ? `${base}?s=${await encodeShare(changes)}` : base;
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* not allowed here */ }
  if (copied) note(n ? `Link copied. It opens this model with your ${plural(n, "changed setting")}.` : "Link copied. You haven't changed any settings, so it opens the defaults.", "ok");
  else prompt("Copy this link:", url);
  document.body.dataset.shareLink = url; // for tests
}

async function readShare(code) {
  try {
    const changes = await decodeShare(code);
    return withChanges(state.model || { parameters: [] }, changes);
  } catch {
    return { error: true };
  }
}

function noteShared(shared) {
  if (shared.error) { note("That share link is damaged or incomplete, so the defaults are shown.", "warn"); return; }
  note(`Opened a shared link: ${plural(shared.applied, "setting")} changed from the defaults.${skippedText(shared.skipped.length)}`, shared.skipped.length ? "warn" : "ok");
}

function exportSettings() {
  const sets = saved.list.map((r) => ({ name: r.name, values: withChanges(state.model, r.values).values }));
  const cur = changedValues(state.model, state.values);
  if (!sets.some((s) => same(changedValues(state.model, s.values), cur))) sets.unshift({ name: "Current settings", values: state.values });
  const text = toOpenSCAD(state.model, sets);
  const fname = state.model.entry.split("/").pop().replace(/\.scad$/i, ".json");
  deliver(new Blob([text], { type: "application/json" }), fname);
  note(`Exported ${plural(sets.length, "set")} as ${fname}. Put it next to the .scad file and OpenSCAD's Customizer lists them.`, "ok");
}

async function importSettings(file) {
  if (!file || !state.model) return;
  let sets;
  try { sets = fromOpenSCAD(state.model, await file.text()); } catch (e) { note(e.message, "warn"); return; }
  if (!sets.length) { note("That file has no parameter sets.", "warn"); return; }
  let first = null, skipped = 0;
  for (const s of sets) {
    const rec = await store.settings.save({ model: state.model.key, name: uniqueName(s.name), values: s.changes });
    saved.list.push(rec); // so the next name is unique too
    first ||= rec;
    skipped += s.skipped;
  }
  await loadSaved();
  chooseSettings(`saved:${first.id}`);
  note(`Imported ${plural(sets.length, "set")} and opened “${first.name}”.${skipped ? ` ${plural(skipped, "value")} didn't match this model and ${skipped === 1 ? "was" : "were"} skipped.` : ""}`, skipped ? "warn" : "ok");
}

$("#save-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(!$("#save-dialog").dataset.updating); });
$("#save-alt").addEventListener("click", () => saveSettings(true));
$("#save-cancel").addEventListener("click", () => $("#save-dialog").close());
$("#settings-import").addEventListener("change", (e) => { importSettings(e.target.files[0]); e.target.value = ""; });

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
  document.body.dataset.engine = result.engine || ""; // which engine made it (desktop on Windows races two)
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

// ---------------------------------------------------------------- batch
const BATCH_MAX = 200;
const batch = { rows: [], running: null };
const batchable = () => state.model.parameters.filter((p) => !p.hidden && !Array.isArray(p.default) &&
  ["number", "string", "boolean"].includes(p.type));

function batchRow(p) {
  // sensible starting values for the chosen setting
  const v = state.values[p.name];
  if (p.widget === "dropdown") return { name: p.name, kind: "choice", picked: [v] };
  if (p.type === "boolean") return { name: p.name, kind: "choice", picked: [false, true] };
  if (p.type === "number") {
    const step = p.step && p.step > 0 ? p.step : (Number.isInteger(v) ? Math.max(1, Math.round(Math.abs(v) / 5) || 1) : 1);
    return { name: p.name, kind: "range", from: v, to: v + step * 4, step };
  }
  return { name: p.name, kind: "list", text: String(v) };
}

function rowValues(row) {
  const p = state.model.parameters.find((x) => x.name === row.name);
  if (row.kind === "choice") return row.picked;
  if (row.kind === "list") return row.text.split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => (p.type === "number" ? Number(s) : s)).filter((x) => p.type !== "number" || Number.isFinite(x));
  const out = [];
  const { from, to, step } = row;
  if (!(step > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return out;
  for (let x = from, i = 0; (from <= to ? x <= to + 1e-9 : x >= to - 1e-9) && i <= BATCH_MAX; x = from <= to ? x + step : x - step, i++) {
    out.push(Math.round(x * 1e6) / 1e6);
  }
  return out;
}

function batchCombos() {
  let combos = [{}];
  for (const row of batch.rows) {
    const vals = rowValues(row);
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [row.name]: v })));
  }
  return combos;
}

function renderBatchRows() {
  const box = $("#batch-rows");
  const params = batchable();
  box.replaceChildren(...batch.rows.map((row, ri) => {
    const p = params.find((x) => x.name === row.name);
    const label = (x) => x.label || humanize(x.name);
    const pick = el("select", { "aria-label": "Setting to vary", onchange: (e) => {
      batch.rows[ri] = batchRow(params[e.target.selectedIndex]); renderBatchRows();
    } }, params.map((x) => el("option", { text: `${label(x)}${x.group !== "Parameters" ? ` (${x.group})` : ""}` })));
    pick.selectedIndex = params.indexOf(p);
    let editor;
    if (row.kind === "range") {
      const num = (k, text) => el("label", {}, text, el("input", { type: "number", step: "any", value: row[k],
        oninput: (e) => { row[k] = e.target.value === "" ? NaN : +e.target.value; updateBatchCount(); } }));
      editor = el("div", { class: "batch-range" }, num("from", "From"), num("to", "To"), num("step", "Step"));
    } else if (row.kind === "choice") {
      const opts = p.widget === "dropdown" ? p.options : [{ value: false, label: "Off" }, { value: true, label: "On" }];
      editor = el("div", { class: "batch-choices" }, opts.map((o) => {
        const cb = el("input", { type: "checkbox", onchange: (e) => {
          row.picked = e.target.checked ? [...row.picked, o.value] : row.picked.filter((x) => !same(x, o.value));
          updateBatchCount();
        } });
        cb.checked = row.picked.some((x) => same(x, o.value));
        return el("label", {}, cb, o.label);
      }));
    } else {
      editor = el("label", { class: "batch-list" }, "Values, separated by commas",
        el("input", { type: "text", value: row.text, oninput: (e) => { row.text = e.target.value; updateBatchCount(); } }));
    }
    const remove = batch.rows.length > 1 ? el("button", { type: "button", class: "ghost", text: "Remove",
      onclick: () => { batch.rows.splice(ri, 1); renderBatchRows(); } }) : null;
    return el("fieldset", { class: "batch-row" }, el("legend", { text: ri ? "And vary" : "Vary" }), el("div", { class: "batch-row-head" }, pick, remove), editor);
  }));
  $("#batch-add").hidden = batch.rows.length >= 2 || params.length < 2;
  updateBatchCount();
}

function updateBatchCount() {
  const n = batchCombos().length;
  const run = $("#batch-run");
  $("#batch-count").textContent = n > BATCH_MAX ? `${n} combinations: the limit is ${BATCH_MAX}. Narrow the ranges.`
    : n ? `${n} file${n === 1 ? "" : "s"} will be made.` : "Pick at least one value.";
  run.disabled = !n || n > BATCH_MAX || !!batch.running;
  run.textContent = n && n <= BATCH_MAX ? `Generate ${n} and download ZIP` : "Generate";
}

$("#batch-open").addEventListener("click", () => {
  if (!state.model) return;
  const params = batchable();
  if (!batch.rows.length || batch.model !== state.model.key) {
    batch.model = state.model.key;
    // start from the most likely thing to vary: a length/size number, else the first number
    const guess = params.find((p) => p.type === "number" && /len|length|size|width|height|grid/i.test(p.name)) ||
      params.find((p) => p.type === "number") || params[0];
    batch.rows = guess ? [batchRow(guess)] : [];
  }
  $("#batch-progress").hidden = true;
  renderBatchRows();
  $("#batch").showModal();
});
$("#batch-add").addEventListener("click", () => {
  const used = new Set(batch.rows.map((r) => r.name));
  const next = batchable().find((p) => !used.has(p.name));
  if (next) { batch.rows.push(batchRow(next)); renderBatchRows(); }
});
$("#batch-close").addEventListener("click", () => {
  if (batch.running) { batch.running.cancel(); batch.running = null; }
  $("#batch").close();
});
$("#batch").addEventListener("cancel", () => { if (batch.running) { batch.running.cancel(); batch.running = null; } });

$("#batch-run").addEventListener("click", async () => {
  const model = state.model;
  const combos = batchCombos();
  if (!combos.length || combos.length > BATCH_MAX) return;
  cancelJob();
  const files = [];
  const names = new Set();
  const bar = $("#batch-bar"), text = $("#batch-progress-text");
  $("#batch-progress").hidden = false;
  batch.running = { cancelled: false, job: null, cancel() { this.cancelled = true; this.job?.cancel(); } };
  const run = batch.running;
  updateBatchCount();
  const started = Date.now();
  run.jobs = new Set();
  run.cancel = function () { this.cancelled = true; for (const j of this.jobs) j.cancel(); };
  const width = Math.max(1, Math.min(state.engine.concurrency || 1, combos.length));
  const results = new Array(combos.length);
  let next = 0, done = 0;
  const progress = () => {
    bar.style.width = `${(done / combos.length) * 100}%`;
    text.textContent = width > 1 ? `Making ${combos.length} parts, ${width} at a time: ${done} done`
      : `Making ${Math.min(done + 1, combos.length)} of ${combos.length}: ${Object.entries(combos[Math.min(done, combos.length - 1)]).map(([k, v]) => `${humanize(k)} ${v}`).join(", ")}`;
  };
  const worker = async () => {
    while (next < combos.length) {
      if (run.cancelled) throw Object.assign(new Error("Batch cancelled."), { cancelled: true });
      const i = next++;
      const values = { ...structuredClone(state.values), ...combos[i] };
      const job = state.engine.render(model, values);
      run.jobs.add(job);
      try { results[i] = { values, result: await job.promise }; } finally { run.jobs.delete(job); }
      done++;
      progress();
    }
  };
  try {
    progress();
    await Promise.all(Array.from({ length: width }, worker));
    for (let i = 0; i < combos.length; i++) {
      let name = `${model.family}-${model.id}-` + Object.entries(combos[i]).map(([k, v]) => `${k}-${v}`).join("-");
      name = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 140);
      while (names.has(name)) name += "_";
      names.add(name);
      files.push({ name: `${name}.stl`, data: new Uint8Array(await results[i].result.blob.arrayBuffer()) });
    }
    const last = results[combos.length - 1];
    state.viewerOwner = "model";
    await showResult(last.result, last.values, true);
    bar.style.width = "100%";
    const zip = makeZip(files);
    const took = Math.round((Date.now() - started) / 1000);
    const saved = await deliver(zip, `${model.family}-${model.id}-batch-${files.length}.zip`);
    text.textContent = `Done: ${files.length} files (${bytes(zip.size)}) in ${took} s. ` +
      (saved === null ? "Not saved." : saved ? `Saved to ${saved}.` : "Your download has started.");
    setStatus("ok", `Batch of ${files.length} ${saved === null ? "made" : saved ? "saved" : "downloaded"}. The preview shows the last one.`);
  } catch (e) {
    text.textContent = e.cancelled ? "Batch cancelled. Nothing was downloaded." : `Stopped: ${e.message}`;
  } finally {
    batch.running = null;
    updateBatchCount();
  }
});

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
    credit.append(el("a", { href: `#/licenses/${lib.id}`, text: "License details" }), ".");
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
    const url = platform.kind === "browser" ? item.preview_url : URL.createObjectURL(await (await platform.fetch(item.preview_url)).blob());
    const d = await state.viewer.load(url);
    if (url !== item.preview_url) URL.revokeObjectURL(url);
    if (state.viewerOwner === "library") showDims(d);
  } catch (e) {
    empty.textContent = `Preview unavailable: ${e.message}`;
    empty.hidden = false;
  }
}

// ---------------------------------------------------------------- licenses & credits
const STATUS_TEXT = { ok: "OK to share", review: "Check license", blocked: "License unclear" };
const spdx = (l) => (!l?.spdx || l.spdx === "NOASSERTION" ? "Not stated" : l.spdx);

function showLicenses(focus) {
  showView("about");
  $("#about-title").textContent = "Licenses & credits";
  document.title = "Licenses & credits | Claude Grid Workshop";
  setCrumbs([{ text: "Generators", href: "#/" }, { text: "Licenses & credits" }]);
  const c = state.catalog;
  const fams = (c?.families || []).filter((f) => f.status !== "missing-source").sort((a, b) => a.name.localeCompare(b.name));
  const row = (id, name, what, authors, lic, source) => el("tr", { id: `lic-${id}`, class: id === focus ? "focus" : null },
    el("th", { scope: "row" }, el("div", { class: "lic-name" }, el("b", { text: name }), el("span", { class: "muted", text: what }))),
    el("td", { text: authors || "Not stated" }),
    el("td", { text: spdx(lic) }),
    el("td", {}, el("span", { class: `badge ${lic?.public_use || "ok"}`, text: STATUS_TEXT[lic?.public_use || "ok"] }),
      lic?.notes ? el("span", { class: "lic-note", text: lic.notes }) : null),
    el("td", {}, source ? el("a", { href: source, target: "_blank", rel: "noopener", text: "Source" }) : "Supplied file"));
  const table = (rows) => el("div", { class: "lic-wrap" }, el("table", { class: "lic-table" },
    el("thead", {}, el("tr", {}, ["Project", "Authors", "License", "Status", "Source"].map((h) => el("th", { scope: "col", text: h })))),
    el("tbody", {}, rows)));
  const review = fams.filter((f) => f.license?.public_use && f.license.public_use !== "ok");
  $("#about-body").replaceChildren(
    el("p", { text: "Every generator and part here is someone else's open work, credited below with its license. Generated files carry the same license as the project that made them." }),
    review.length ? el("p", { class: "lic-summary" },
      `${review.length} project${review.length > 1 ? "s need" : " needs"} a license check before files are shared or sold: `,
      ...review.flatMap((f, i) => [i ? ", " : "", el("a", { href: `#/licenses/${f.id}`, text: f.name })]), ".") : null,
    el("h2", { text: "Generators" }),
    table(fams.map((f) => row(f.id, f.name, (f.models || []).join(", "), (f.authors || []).map((a) => a.name).join(", "), f.license, f.source))),
    el("h2", { text: "Ready-made parts" }),
    table(state.libraries.map((l) => row(l.id, l.name, `${l.item_count} parts`, (l.authors || []).map((a) => a.name).join(", "), l.license, l.source_url))),
    el("h2", { text: "This site" }),
    el("ul", {},
      el("li", {}, `OpenSCAD ${c?.engine || ""} (WebAssembly build) makes every part in your browser. GNU GPL version 2 or later: `,
        el("a", { href: "https://github.com/openscad/openscad", target: "_blank", rel: "noopener", text: "source code" }), ", ",
        el("a", { href: "engine/COPYING", target: "_blank", text: "license text" }), "."),
      el("li", { text: "3D preview: three.js (MIT)." }),
      el("li", { text: "Fonts for text on parts: Liberation Sans and Liberation Mono (SIL Open Font License 1.1)." }),
      el("li", { text: "Nothing you configure is sent to a server; once loaded, the site keeps working offline." })));
  const target = focus && document.getElementById(`lic-${focus}`);
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "center" }));
  else window.scrollTo(0, 0);
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
      store.prefs.set("gw-filament", hex);
    } });
  fil.append(b);
});

// ---------------------------------------------------------------- files out (download or save)
let toastTimer = null;
function toast(text, action) {
  const t = $("#toast");
  t.replaceChildren(el("span", { text }), action ? el("button", { type: "button", class: "ghost light", text: action.label, onclick: action.run }) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
}

/**
 * Hand a file to the user: a download in the browser, a save dialog in the desktop
 * app. Resolves to the saved path (desktop), "" (browser download) or null (cancelled).
 */
async function deliver(blob, name) {
  if (!platform.save) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return "";
  }
  try {
    const path = await platform.save(blob, name);
    if (path) toast(`Saved ${path.split(/[\\/]/).pop()}`, { label: "Show in folder", run: () => platform.reveal(path) });
    return path || null;
  } catch (e) {
    toast(`Couldn't save: ${e?.message || e}`);
    return null;
  }
}

// In the desktop app, download links (STL, parts, ZIPs) open a save dialog instead.
if (platform.save) {
  document.addEventListener("click", async (e) => {
    const a = e.target.closest?.("a[download]");
    if (!a || a.classList.contains("is-disabled") || a.getAttribute("href") === "#") return;
    e.preventDefault();
    const href = a.getAttribute("href");
    const name = a.getAttribute("download") || href.split("/").pop();
    try {
      const blob = href.startsWith("blob:") ? await (await fetch(href)).blob() : await (await platform.fetch(href)).blob();
      deliver(blob, name);
    } catch (err) {
      toast(`Couldn't read the file: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------- printer profile
// Values the user sets once (Settings) that generators asking for them start from.
const PROFILE_FIELDS = [
  { id: "bed", label: "Print bed size", unit: "mm", axes: ["width (X)", "depth (Y)"], kind: "vec2", min: 50, max: 2000 },
  { id: "nozzle", label: "Nozzle diameter", unit: "mm", kind: "number", min: 0.1, max: 2, step: 0.05 },
];
const getProfile = () => store.prefs.get("gw-profile", {}) || {};

function profileValue(path, profile = getProfile()) {
  const [field, axis] = path.split(".");
  const v = profile[field];
  if (v == null) return undefined;
  if (axis) return Array.isArray(v) ? v[{ x: 0, y: 1, z: 2 }[axis]] : undefined;
  return v;
}

function applyProfile(detail) {
  for (const p of detail.parameters) {
    if (!p.profile) continue;
    const v = profileValue(p.profile);
    const d = p.default;
    const fits = Array.isArray(d) ? Array.isArray(v) && v.length === d.length && v.every((x) => typeof x === "number")
      : typeof d === "number" && typeof v === "number";
    if (fits) { p.default = structuredClone(v); p.profiled = true; }
  }
}

function showSettings() {
  showView("about");
  document.title = "Settings | Claude Grid Workshop";
  setCrumbs([{ text: "Generators", href: "#/" }, { text: "Settings" }]);
  $("#about-title").textContent = "Settings";
  const profile = getProfile();
  const uses = state.catalog?.profile_uses || {};
  const nameOf = (key) => { const m = state.catalog?.models.find((x) => x.key === key); return m ? `${m.family_name} ${m.name}` : key; };
  const saveProfile = (id, value) => {
    const next = { ...getProfile() };
    if (value == null) delete next[id]; else next[id] = value;
    store.prefs.set("gw-profile", next);
    if (state.model) state.model = null; // reopen models with the new defaults
    $("#profile-note").textContent = "Saved. Generators open with these values from now on.";
  };
  const fields = PROFILE_FIELDS.map((f) => {
    const cur = profile[f.id];
    const used = [...new Set((uses[f.id] || []).map((u) => u.key))].map((k) => el("a", { href: `#/m/${k}`, text: nameOf(k) }));
    let inputs;
    if (f.kind === "vec2") {
      inputs = el("div", { class: "vector named", style: "--n:2" }, f.axes.map((ax, i) => el("label", { "data-axis": ax, style: `--ax:${ax.length}` }, ax,
        el("input", { type: "number", min: f.min, max: f.max, step: "any", value: cur ? cur[i] : "", "aria-label": `${f.label} ${ax}`, placeholder: "not set",
          onchange: (e) => {
            const ins = e.target.closest(".vector").querySelectorAll("input");
            const vals = [...ins].map((x) => (x.value === "" ? null : +x.value));
            saveProfile(f.id, vals.every((x) => x != null && x > 0) ? vals : null);
          } }))));
    } else {
      inputs = el("input", { type: "number", min: f.min, max: f.max, step: f.step || "any", value: cur ?? "", placeholder: "not set", "aria-label": f.label,
        onchange: (e) => saveProfile(f.id, e.target.value === "" ? null : +e.target.value) });
    }
    return el("div", { class: "field profile-field" },
      el("div", { class: "field-head" }, el("span", { class: "label", text: `${f.label} (${f.unit})` })), inputs,
      el("p", { class: "help-inline" }, used.length ? ["Used by ", ...used.flatMap((a, i) => [i ? ", " : "", a]), "."] : "No generator uses this yet."));
  });
  const body = [
    el("h2", { text: "Printer profile" }),
    el("p", { text: "Generators that ask for these start with your values instead of the author's. Leave a value empty to keep the defaults. Magnet and tolerance settings aren't linked: each project measures them differently." }),
    el("div", { class: "profile-grid" }, fields),
    el("p", { id: "profile-note", class: "muted", role: "status" }),
  ];
  if (platform.kind === "desktop") body.push(...desktopSettings());
  else body.push(el("h2", { text: "Your data" }),
    el("p", { text: "Saved settings and this profile are kept in this browser only. Use Export for OpenSCAD on a model to keep a copy as a file." }));
  $("#about-body").replaceChildren(...body);
}

function desktopSettings() {
  const info = platform.info || {};
  const gb = (n) => (n == null ? "unknown" : bytes(n));
  const cacheLine = el("span", { text: gb(info.cache_bytes) });
  return [
    el("h2", { text: "Workspace" }),
    el("p", { text: "Everything you save lives in this folder as plain files, so you can back it up or sync it." }),
    el("p", { class: "path" }, el("code", { text: info.workspace || info.workspace_error || "not available" })),
    el("div", { class: "button-row" },
      el("button", { type: "button", class: "ghost", text: "Open folder", onclick: () => platform.workspace.open().catch((e) => toast(String(e))) }),
      el("button", { type: "button", class: "ghost", text: "Use another folder…", onclick: async () => {
        try { if (await platform.workspace.choose()) location.reload(); } catch (e) { toast(String(e)); }
      } })),
    el("h2", { text: "Engine" }),
    info.engine
      ? el("p", {}, `OpenSCAD ${info.engine}, native, up to ${info.concurrency || 1} render${info.concurrency > 1 ? "s" : ""} at once. `, el("br"), el("code", { text: info.engine_path || "" }))
      : el("p", { class: "lic-summary", text: info.engine_error || "OpenSCAD isn't available." }),
    info.os === "windows" ? (() => {
      const picks = store.prefs.get("gw-engine-pick", {}) || {};
      const wasm = Object.values(picks).filter((v) => v === "wasm").length;
      const line = el("p", {}, `On Windows, OpenSCAD is slow with projects made of many files, where the WebAssembly engine (the website's) is faster. The first time you make a model, both run and the faster one is remembered: ${wasm} of ${Object.keys(picks).length} models so far use WebAssembly. `,
        el("button", { type: "button", class: "ghost", text: "Forget", onclick: () => { store.prefs.set("gw-engine-pick", {}); line.firstChild.textContent = "Forgotten: the next render of each model tries both engines again. "; } }));
      return line;
    })() : null,
    el("p", {}, "Finished renders are kept so repeating one is instant: ", cacheLine, ". ",
      el("button", { type: "button", class: "ghost", text: "Clear", onclick: async () => {
        try { await platform.workspace.clearCache(); const i = await platform.refreshInfo(); cacheLine.textContent = gb(i.cache_bytes); } catch (e) { toast(String(e)); }
      } })),
  ];
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    state.catalog = await getJSON("data/catalog.json");
    if (platform.kind === "browser") {
      // models that need native OpenSCAD only appear in the desktop app
      state.catalog.models = state.catalog.models.filter((m) => m.browser !== false);
      for (const c of state.catalog.categories) c.models = c.models.filter((m) => m.browser !== false);
    } else {
      document.body.dataset.platform = platform.kind;
      const intro = $(".catalog-head p");
      if (intro) intro.textContent = intro.textContent.replace("right here in your browser", "on this computer");
    }
    state.engine = platform.makeEngine(state.catalog);
    $("#engine").textContent = state.engine.label;
    state.libraries = await Promise.all((state.catalog.libraries || []).map((l) => getJSON(`data/libraries/${l.id}.json`)));
    for (const l of state.libraries) state.libDetail[l.id] = l;
  } catch (e) {
    $("#catalog-list").replaceChildren(el("p", { class: "empty", text: `Couldn't load the generator list: ${e.message}. Reload to try again.` }));
  }
  route();
})();
