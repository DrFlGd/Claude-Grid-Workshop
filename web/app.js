// Claude Grid Workshop front end: catalog, auto-built settings form, render jobs, preview.
import { Viewer } from "./viewer.js";

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status });
  return data;
};

const FILAMENTS = [
  ["Tool yellow", "#f2b705"], ["Signal blue", "#2f6fd0"], ["Galaxy grey", "#6b7680"],
  ["Orange", "#ee6a1f"], ["Green", "#3c9a5f"], ["White", "#f4f4f2"], ["Black", "#26292c"],
];
const GRID_FAMILIES = new Set(["gridfinity"]);

const state = {
  catalog: null,
  model: null,       // detail of the open model
  values: {},        // current form values
  rendered: null,    // JSON of values used for the shown preview
  job: null,
  pollTimer: null,
  viewer: null,
};

// ---------------------------------------------------------------- helpers
function humanize(name) {
  const axis = name.match(/^([a-z]{3,})([xyz])$/);
  if (axis) name = `${axis[1]}_${axis[2].toUpperCase()}`;
  const s = name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  const words = s.split(" ").map((w, i) => {
    if (/^(mm|deg)$/i.test(w)) return `(${w.toLowerCase()})`;
    if (/^[A-Z0-9]{2,}$/.test(w) || /^[XYZ]$/.test(w)) return w;
    return i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
  });
  return words.join(" ");
}
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (n) => (n > 1048576 ? `${fmt(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function licenseBadge(lic) {
  if (!lic || lic.public_use === "ok") return null;
  const text = lic.public_use === "blocked" ? "License unclear" : "Check license";
  return el("span", { class: `badge ${lic.public_use}`, title: lic.notes || lic.spdx, text });
}

// ---------------------------------------------------------------- routing
function route() {
  const m = location.pathname.match(/^\/m\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
  const p = location.pathname.match(/^\/parts\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/);
  stopPolling();
  if (m) openModel(`${m[1]}/${m[2]}`);
  else if (p) openLibrary(p[1], p[2]);
  else showCatalog();
}

function showView(name) {
  for (const v of ["catalog", "model", "library"]) $(`#view-${v}`).hidden = v !== name;
  const stage = $(".stage");
  if (name === "model" && stage.parentElement.id !== "view-model") $("#view-model").append(stage);
  if (name === "library" && stage.parentElement.id !== "view-library") $("#view-library").append(stage);
  if (name !== "catalog" && !state.viewer) {
    state.viewer = new Viewer($("#viewer"));
    state.viewer.setColor(savedColor);
  }
  state.viewer?.resize();
}
function go(path) {
  if (path !== location.pathname) history.pushState({}, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
window.addEventListener("popstate", route);

function setCrumbs(parts) {
  const c = $("#crumbs");
  c.replaceChildren();
  parts.forEach((p, i) => {
    if (i) c.append(el("span", { class: "sep", "aria-hidden": "true", text: "/" }));
    c.append(p.href ? el("a", { href: p.href, "data-link": true, text: p.text }) : el("span", { text: p.text }));
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
        el("a", { href: `/m/${m.key}`, "data-link": true },
          el("span", { class: "m-name", text: m.name }),
          el("span", { class: "m-family", text: m.family_name }),
          licenseBadge(m.license) && el("span", { class: "m-badge" }, licenseBadge(m.license))))))));
  }
  // ready-made parts: whole libraries when browsing, matching parts when searching
  const libs = state.libraries || [];
  const partHits = [];
  for (const lib of libs) {
    for (const it of lib.items) {
      if (q && [it.name, it.category, lib.name, ...(it.tags || [])].join(" ").toLowerCase().includes(q)) partHits.push([lib, it]);
    }
  }
  if (libs.length && (!q || partHits.length)) {
    shown += q ? partHits.length : libs.length;
    list.append(el("section", { class: "cat-section" },
      el("h2", {}, "Ready-made parts", el("small", { text: q ? `${partHits.length} part${partHits.length === 1 ? "" : "s"}` : `${libs.length} collection${libs.length > 1 ? "s" : ""}` })),
      el("ul", { class: "cat-rows" }, q
        ? partHits.slice(0, 30).map(([lib, it]) => el("li", {}, el("a", { href: `/parts/${lib.id}/${it.id}`, "data-link": true },
            el("span", { class: "m-name", text: it.name }), el("span", { class: "m-family", text: `${lib.name}, ${it.category.toLowerCase()}` }))))
        : libs.map((lib) => el("li", {}, el("a", { href: `/parts/${lib.id}`, "data-link": true },
            el("span", { class: "m-name", text: lib.name }),
            el("span", { class: "m-family", text: `${lib.item_count} parts: ${lib.categories.join(", ").toLowerCase()}` })))))));
  }
  if (!shown) list.append(el("p", { class: "empty", text: `Nothing matches “${query}”. Try “bin”, “baseplate”, “label” or “connector”.` }));
  const missing = state.catalog.families.filter((f) => f.status === "missing-source");
  if (!q && missing.length) {
    list.append(el("p", { class: "missing",
      text: `Coming once their source files are added: ${missing.map((f) => f.name).join(", ")}.` }));
  }
}
$("#catalog-search").addEventListener("input", (e) => renderCatalog(e.target.value));

// ---------------------------------------------------------------- model view
async function openModel(key) {
  showView("model");
  $("#filament").hidden = false;
  if (state.model?.key === key) {
    if (state.viewerOwner !== "model") {
      state.viewerOwner = "model";
      state.viewer.clear();
      $("#dims").hidden = true;
      if (state.lastJob?.download_url) {
        state.viewer.load(state.lastJob.download_url.replace(/\?.*/, "?inline=1")).then((d) => showDims(d, state.lastJob)).catch(() => {});
      }
    }
    return;
  }
  state.viewerOwner = "model";
  let detail;
  try {
    detail = await api(`/api/models/${key}`);
  } catch (e) {
    setStatus("error", e.status === 404 ? "This generator doesn't exist. Pick one from the catalog." : e.message);
    return;
  }
  state.model = detail;
  $("#stage-empty").hidden = true;
  state.rendered = null;
  state.viewer.clear();
  $("#dims").hidden = true;
  $("#log").hidden = true;
  setDownload(null);
  document.title = `${detail.name} · ${detail.family_name} · Claude Grid Workshop`;
  setCrumbs([{ text: "Generators", href: "/" }, { text: detail.family_name }]);

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
  const lic = $("#model-license");
  lic.replaceChildren();
  const badge = licenseBadge(detail.license);
  if (badge) lic.append(badge);

  state.values = Object.fromEntries(detail.parameters.map((p) => [p.name, structuredClone(p.default)]));
  $("#param-search").value = "";
  buildForm();
  generate(); // show the default part straight away (cached after the first time)
}

// ---------------------------------------------------------------- form
function buildForm() {
  const form = $("#params");
  form.replaceChildren();
  const { parameters, groups } = state.model;
  groups.forEach((g, gi) => {
    const fields = parameters.filter((p) => p.group === g);
    const body = el("div", { class: "group-body" }, fields.map(buildField));
    const det = el("details", { class: "group", "data-group": g, open: gi < 2 || groups.length <= 3 },
      el("summary", {}, el("span", { text: g === "Parameters" ? "Settings" : g }), el("span", { class: "changed-count" })),
      body);
    form.append(det);
  });
  refreshChanged();
}

function buildField(p) {
  const id = `p-${p.name}`;
  const label = humanize(p.name);
  const help = p.description ? el("p", { class: "help", id: `${id}-help`, text: p.description }) : null;
  const reset = el("button", { type: "button", class: "reset", text: "Reset", hidden: true,
    "aria-label": `Reset ${label}`, onclick: () => { setValue(p, structuredClone(p.default)); syncField(p); } });
  const wrap = el("div", { class: "field", "data-name": p.name, "data-search": `${p.name} ${label} ${p.description || ""}`.toLowerCase() });
  const describedby = help ? `${id}-help` : null;

  if (p.widget === "checkbox") {
    wrap.classList.add("check");
    const input = el("input", { type: "checkbox", id, "aria-describedby": describedby,
      onchange: (e) => setValue(p, e.target.checked) });
    wrap.append(input, el("div", { class: "field-head" }, el("label", { for: id, text: label }), reset), ...(help ? [help] : []));
  } else if (p.widget === "dropdown") {
    const sel = el("select", { id, "aria-describedby": describedby,
      onchange: (e) => setValue(p, p.options[e.target.selectedIndex].value) },
      p.options.map((o) => el("option", { text: o.label })));
    wrap.append(el("div", { class: "field-head" }, el("label", { for: id, text: label }), reset), sel, ...(help ? [help] : []));
  } else if (p.widget === "slider" && !Array.isArray(p.default)) {
    const step = p.step ?? (Number.isInteger(p.default) && Number.isInteger(p.min ?? 0) && Number.isInteger(p.max ?? 0) ? 1 : "any");
    const range = el("input", { type: "range", min: p.min, max: p.max, step: step === "any" ? (p.max - p.min) / 100 : step,
      "aria-hidden": "true", tabindex: "-1", oninput: (e) => { setValue(p, +e.target.value); syncField(p, "range"); } });
    const num = el("input", { type: "number", id, min: p.min, max: p.max, step, "aria-describedby": describedby,
      oninput: (e) => { if (e.target.value !== "" && e.target.checkValidity()) { setValue(p, +e.target.value); syncField(p, "number"); } } });
    wrap.append(el("div", { class: "field-head" }, el("label", { for: id, text: label }), reset), el("div", { class: "slider" }, range, num), ...(help ? [help] : []));
  } else if (Array.isArray(p.default)) {
    const axes = p.default.length <= 3 ? ["X", "Y", "Z"] : p.default.map((_, i) => `${i + 1}`);
    const editable = p.default.every((v) => typeof v !== "object");
    const inputs = p.default.map((v, i) => {
      const t = typeof v === "boolean" ? "checkbox" : typeof v === "number" ? "number" : "text";
      const inp = el("input", { type: t, "data-i": i, step: "any", min: p.min, max: p.max, disabled: !editable,
        oninput: (e) => {
          const next = structuredClone(state.values[p.name]);
          next[i] = t === "checkbox" ? e.target.checked : t === "number" ? (e.target.value === "" ? next[i] : +e.target.value) : e.target.value;
          setValue(p, next);
        } });
      return el("label", {}, axes[i] || `${i + 1}`, inp);
    });
    wrap.append(el("div", { class: "field-head" }, el("span", { class: "label", id, text: label }), reset),
      el("div", { class: "vector", role: "group", "aria-labelledby": id, style: `--n:${Math.min(p.default.length, 4)}` }, inputs), ...(help ? [help] : []));
  } else {
    const t = p.type === "number" ? "number" : "text";
    const input = el("input", { type: t, id, step: "any", min: p.min, maxlength: t === "text" ? 200 : null, "aria-describedby": describedby,
      oninput: (e) => {
        if (t === "number") { if (e.target.value !== "" && e.target.checkValidity()) setValue(p, +e.target.value); }
        else setValue(p, e.target.value);
      } });
    wrap.append(el("div", { class: "field-head" }, el("label", { for: id, text: label }), reset), input, ...(help ? [help] : []));
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
  refreshChanged();
}

function setValue(p, v) {
  state.values[p.name] = v;
  refreshChanged();
  updateStatusForEdits();
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
  updateStatusForEdits();
});

$("#param-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".group").forEach((g) => {
    let any = false;
    g.querySelectorAll(".field").forEach((f) => {
      const hit = !q || f.dataset.search.includes(q);
      f.hidden = !hit; any ||= hit;
    });
    g.hidden = !any;
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
  if (state.job && ["queued", "running"].includes(state.job.status)) return;
  const a = $("#download");
  if (state.rendered && same(JSON.parse(state.rendered), state.values)) {
    setStatus("ok", "Preview matches your settings.");
    if (!a.classList.contains("is-disabled")) a.textContent = "Download STL";
  } else if (state.rendered) {
    setStatus("stale", "Settings changed. Generate to update the preview and download.");
    if (!a.classList.contains("is-disabled")) a.textContent = "Download last render";
  }
}

function setDownload(job) {
  const a = $("#download");
  if (job?.download_url) {
    a.href = job.download_url;
    a.classList.remove("is-disabled");
    a.removeAttribute("aria-disabled");
    a.textContent = "Download STL";
  } else {
    a.href = "#";
    a.classList.add("is-disabled");
    a.setAttribute("aria-disabled", "true");
    a.textContent = "Download STL";
  }
}

async function generate() {
  if (!state.model) return;
  const values = structuredClone(state.values);
  const model = state.model.key;
  stopPolling();
  $("#generate").disabled = true;
  $("#log").hidden = true;
  setStatus("busy", "Sending to OpenSCAD…");
  let job;
  try {
    job = await api("/api/render", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, params: values }) });
  } catch (e) {
    $("#generate").disabled = false;
    setStatus("error", e.message);
    return;
  }
  state.job = job;
  track(job, values, model);
}

function track(job, values, model) {
  const started = Date.now();
  const tick = async () => {
    if (state.model?.key !== model) return;
    if (["queued", "running"].includes(job.status)) {
      const secs = Math.round((Date.now() - started) / 1000);
      const msg = job.status === "queued" ? "Waiting for a free renderer…" : `Rendering in OpenSCAD… ${secs}s`;
      setStatus("busy", msg);
      showOverlay(secs > 1 || !state.rendered ? `${msg}${secs > 20 ? " Large or detailed parts can take a few minutes." : ""}` : null);
      state.pollTimer = setTimeout(async () => {
        try { job = state.job = await api(`/api/jobs/${job.id}`); } catch (e) { job = { ...job, status: "failed", error: e.message }; }
        tick();
      }, secs < 5 ? 400 : 1000);
      return;
    }
    showOverlay(null);
    $("#generate").disabled = false;
    if (job.status === "done") {
      try {
        setStatus("busy", "Loading preview…");
        const dims = await state.viewer.load(job.download_url.replace(/\?.*/, "?inline=1"));
        state.lastJob = job;
        state.rendered = JSON.stringify(values);
        showDims(dims, job);
        setDownload(job);
        setStatus("ok", job.cached ? "Preview matches your settings. Served from cache." : `Preview matches your settings. Rendered in ${fmt(job.seconds)}s.`);
        if (!same(values, state.values)) updateStatusForEdits(); // edited while it rendered
      } catch (e) {
        setStatus("error", e.message);
      }
    } else if (job.status === "cancelled") {
      setStatus("stale", "Render cancelled.");
    } else {
      setDownload(null);
      setStatus("error", job.error || "The render failed.");
      if (job.log) { $("#log-text").textContent = job.log; $("#log").hidden = false; }
    }
  };
  tick();
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  showOverlay(null);
  $("#generate").disabled = false;
}

function showOverlay(text) {
  $("#stage-overlay").hidden = !text;
  if (text) $("#overlay-text").textContent = text;
}

function showDims(d, job) {
  const box = $("#dims");
  const grid = GRID_FAMILIES.has(state.model.category);
  const units = (v) => fmt(Math.round(v / 42 * 2) / 2);
  const gridText = `About ${units(d.x)} × ${units(d.y)} grid units` + (d.z >= 7 ? `, ${fmt(d.z / 7)} height units` : "");
  box.replaceChildren(...[
    el("span", { class: "mm", text: `${fmt(d.x)} × ${fmt(d.y)} × ${fmt(d.z)} mm` }),
    grid && el("span", { class: "units", text: gridText }),
    el("span", { class: "meta", text: `${d.triangles.toLocaleString()} triangles, ${bytes(job.bytes)}` }),
  ].filter(Boolean));
  box.hidden = false;
}

$("#generate").addEventListener("click", generate);
$("#params").addEventListener("submit", (e) => { e.preventDefault(); generate(); });
$("#params").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input:not([type=checkbox])")) { e.preventDefault(); generate(); }
});
$("#cancel").addEventListener("click", async () => {
  if (!state.job) return;
  stopPolling();
  try { await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" }); } catch {}
  state.job = { ...state.job, status: "cancelled" };
  setStatus("stale", "Render cancelled.");
});

// ---------------------------------------------------------------- part libraries
const FORMAT_LABEL = { "3mf": "3MF", stl: "STL", step: "STEP", shapr: "Shapr3D", pdf: "PDF", obj: "OBJ" };

async function openLibrary(libId, itemId) {
  showView("library");
  stopPolling();
  let lib = state.libDetail?.[libId];
  if (!lib) {
    try {
      lib = await api(`/api/libraries/${libId}`);
    } catch (e) {
      $("#lib-title").textContent = "Parts not found";
      $("#lib-summary").textContent = "This collection doesn't exist. Go back to the catalog to pick one.";
      return;
    }
    state.libDetail = { ...(state.libDetail || {}), [libId]: lib };
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
  if (!itemId && item) history.replaceState({}, "", `/parts/${libId}/${item.id}`);
  showPart(lib, item);
}

function buildPartList(lib) {
  const nav = $("#part-list");
  nav.replaceChildren();
  const cats = [...new Set(lib.items.map((i) => i.category))];
  for (const c of cats) {
    nav.append(el("div", { class: "part-group", "data-cat": c },
      el("h2", { text: c }),
      el("ul", {}, lib.items.filter((i) => i.category === c).map((i) => el("li", {},
        el("a", { href: `/parts/${lib.id}/${i.id}`, "data-link": true, "data-id": i.id,
          "data-search": [i.name, c, ...(i.tags || [])].join(" ").toLowerCase() },
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
  document.title = `${item.name} · ${lib.name} · Claude Grid Workshop`;
  setCrumbs([{ text: "Generators", href: "/" }, { text: lib.name, href: `/parts/${lib.id}` }, { text: item.name }]);
  document.querySelectorAll("#part-list a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.id === item.id));
  const nav = $("#part-list"), cur = $(`#part-list a[data-id="${CSS.escape(item.id)}"]`);
  if (cur && nav.scrollHeight > nav.clientHeight + 1) {  // desktop: the list scrolls on its own
    const top = cur.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop || top > nav.scrollTop + nav.clientHeight - 40) nav.scrollTop = top - nav.clientHeight / 3;
  }
  const status = $("#part-status");
  status.replaceChildren(el("p", { class: "part-name", text: item.name }));
  if (item.description) status.append(el("p", { class: "help", text: item.description }));
  if (item.generator) status.append(el("p", { class: "help" }, el("a", { href: `/m/${item.generator}`, "data-link": true, text: "Open the generator" }), " to print it at any size."));
  const dl = $("#part-downloads");
  dl.replaceChildren(...item.files.map((f, i) => el("a", {
    class: `button ${i === 0 && f.format !== "step" && f.format !== "shapr" ? "primary" : "secondary"}`, href: f.url, download: true,
    title: f.path.split("/").pop(),
    text: `${f.label ? f.label + ": " : ""}${FORMAT_LABEL[f.format] || f.format} (${bytes(f.bytes)})` })));
  dl.classList.toggle("many", item.files.length > 4);
  state.viewerOwner = "library";
  $("#filament").hidden = false;
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
    if (state.viewerOwner !== "library") return;
    const box = $("#dims");
    box.replaceChildren(el("span", { class: "mm", text: `${fmt(d.x)} × ${fmt(d.y)} × ${fmt(d.z)} mm` }),
      el("span", { class: "meta", text: `${d.triangles.toLocaleString()} triangles` }));
    box.hidden = false;
  } catch (e) {
    empty.textContent = `Preview unavailable: ${e.message}`;
    empty.hidden = false;
  }
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
const savedColor = (() => { try { return localStorage.getItem("gw-filament"); } catch { return null; } })() || FILAMENTS[0][1];
FILAMENTS.forEach(([name, hex]) => {
  const b = el("button", { type: "button", class: "swatch", role: "radio", "aria-checked": String(hex === savedColor),
    "aria-label": name, title: name, style: `--c:${hex}`,
    onclick: () => {
      fil.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-checked", String(s === b)));
      state.viewer?.setColor(hex);
      try { localStorage.setItem("gw-filament", hex); } catch {}
    } });
  fil.append(b);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const [health, catalog, libs] = await Promise.all([api("/api/health"), api("/api/models"), api("/api/libraries")]);
    state.catalog = catalog;
    // part libraries are small manifests; load them so the catalog search covers every part
    state.libraries = await Promise.all(libs.libraries.map((l) => api(`/api/libraries/${l.id}`)));
    state.libDetail = Object.fromEntries(state.libraries.map((l) => [l.id, l]));
    const eng = $("#engine");
    if (health.engine) eng.textContent = health.engine.replace(/^OpenSCAD version /i, "OpenSCAD ");
    else { eng.textContent = "OpenSCAD not installed"; eng.classList.add("off"); }
  } catch (e) {
    $("#catalog-list").replaceChildren(el("p", { class: "empty", text: `Couldn't load the generator list: ${e.message}. Reload to try again.` }));
  }
  route();
})();
