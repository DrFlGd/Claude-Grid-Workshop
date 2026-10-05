// The library in the desktop app: adding projects, project pages (details,
// README, files, versions, updates), "Needs attention", thumbnails for newly
// read models, and the library section of Settings. On the website none of
// this shows (there is no library there).
import { html, useState, useEffect, useMemo } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui, addJob } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { Icon } from "./icons.js";
import { Viewer } from "../viewer.js";
import { bytes, plural } from "../lib/util.js";
import { hideProject, deleteProject } from "./actions.js";

export const isDesktop = () => ctx.platform?.kind === "desktop";
export const api = (cmd, args) => ctx.platform.api(cmd, args);
export const readOnly = () => !!ctx.catalog?.library?.read_only;

/** A project (source) entry from the catalog. */
export const sourceById = (id) => (ctx.catalog?.sources || []).find((s) => s.id === id) || null;

/** Start a backend job and follow it in the status bar. Resolves with its result. */
export async function runJob(startPromise, label) {
  const { job } = await startPromise;
  const done = addJob(label);
  try {
    return await ctx.platform.library.waitJob(job, (stage) => done.update(`${label}: ${stage}`));
  } finally {
    done();
  }
}

const KIND_TEXT = { github: "GitHub", zip: "ZIP file", folder: "Folder (copied)", linked: "Linked folder", local: "Your project (local/)", bundled: "Comes with the app" };
export const kindText = (s) => KIND_TEXT[s?.kind] || s?.kind || "";

// ---------------------------------------------------------------- markdown (README)
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(t, base) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt) => (alt ? `<em>[${alt}]</em>` : "")); // no remote images
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, text, href) => {
    const url = /^https?:\/\//.test(href) ? href : base && !href.startsWith("#") ? `${base}/${href}` : null;
    return url ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>");
  return s;
}
/** A README rendered safely: text is escaped first, then simple Markdown applied. */
export function markdown(text, base = null) {
  const out = [];
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      i++;
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2], base)}</h${n}>`); i++; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""), base)}</li>`); i++; }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(`<table>${body.map((r, n) => `<tr>${cells(r).map((c) => (n === 0 ? `<th>${inline(c, base)}</th>` : `<td>${inline(c, base)}</td>`)).join("")}</tr>`).join("")}</table>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(q.join(" "), base)}</blockquote>`);
      continue;
    }
    if (!l.trim() || /^\s*(-{3,}|={3,}|\*{3,})\s*$/.test(l) || /^\s*<\/?[a-z]/i.test(l)) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|\s*([-*+]|\d+\.)\s|\s*>|\s*\|)/.test(lines[i]) && !/^\s*<\/?[a-z]/i.test(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out.push(`<p>${inline(para.join(" "), base)}</p>`);
    else i++;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- adding a project
export function AddProject() {
  const [tab, setTab] = useState("github");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [link, setLink] = useState(false);
  const [asLibrary, setAsLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => ui.set({ dialog: null });
  const pick = async () => {
    const lib = ctx.platform.library;
    const p = tab === "zip" ? await lib.pickFile("Choose a ZIP file", ["zip"]) : await lib.pickFolder("Choose a project folder");
    if (p) setPath(p);
  };
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    // the field itself, not state: a link pasted and submitted at once may not have re-rendered yet
    const url = e.currentTarget.querySelector("#add-url")?.value ?? "";
    const args = tab === "github" ? { kind: "github", url } : tab === "zip" ? { kind: "zip", path } : { kind: "folder", path, link };
    if (asLibrary) args.role = "library";
    if (tab === "github" ? !url.trim() : !path) { setError(tab === "github" ? "Paste a GitHub link first." : "Choose a file or folder first."); return; }
    setBusy(true);
    try {
      const label = tab === "github" ? url.replace(/^https?:\/\/(www\.)?github\.com\//, "") : path.split(/[\\/]/).filter(Boolean).pop();
      close();
      const res = await runJob(api("source_add", args), `Adding ${label}`);
      await ctx.reloadCatalog();
      const n = res.read?.models ?? 0, parts = res.read?.parts ?? 0;
      const problems = (res.read?.problems || []).length;
      ctx.toast(`Added ${sourceById(res.source)?.name || label}: ${plural(n, "generator")}${parts ? `, ${plural(parts, "part")}` : ""}${problems ? `; ${plural(problems, "problem")} to look at` : ""}.`);
      location.hash = scopeHash(`source:${res.source}`);
      makeThumbnails();
    } catch (err) {
      ctx.toast(`Couldn't add it: ${err.message || err}`);
    } finally {
      setBusy(false);
    }
  };
  const tabBtn = (id, label) => html`<button type="button" role="tab" aria-selected=${tab === id ? "true" : "false"} class=${`seg-btn${tab === id ? " on" : ""}`}
    onClick=${() => { setTab(id); setPath(""); setError(""); }} data-add-tab=${id}>${label}</button>`;
  return html`<form class="dialog add-project" onSubmit=${submit} aria-label="Add a project">
    <div class="dialog-head"><h2>Add a project</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <div class="seg tabs-seg" role="tablist">${tabBtn("github", "GitHub link")}${tabBtn("zip", "ZIP file")}${tabBtn("folder", "Folder")}</div>
    ${tab === "github" ? html`<label class="field-block"><span>Repository link</span>
        <input type="url" id="add-url" value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repository" autofocus />
        <small class="muted">A branch, tag or commit (/tree/…, /commit/…) and a subfolder work too. The app downloads that version as plain files (no git needed) and checks for newer commits later.</small></label>`
      : html`<div class="field-block"><span>${tab === "zip" ? "ZIP file" : "Folder"}</span>
        <div class="pick-row"><code class="pick-path">${path || "Nothing chosen"}</code><button type="button" class="ghost" onClick=${pick} id="add-pick">Choose…</button></div>
        ${tab === "folder" ? html`<label class="check"><input type="checkbox" checked=${link} onChange=${(e) => setLink(e.target.checked)} id="add-link" />
          Link instead of copying (for a project you're still editing; it won't move with the library)</label>` : null}</div>`}
    <label class="check"><input type="checkbox" checked=${asLibrary} onChange=${(e) => setAsLibrary(e.target.checked)} id="add-library" />
      It's a library other projects include (like BOSL2): don't list its files as generators</label>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : null}
    <div class="dialog-actions"><button type="button" class="ghost" onClick=${close}>Cancel</button>
      <button type="submit" class="primary" disabled=${busy} id="add-go">Add</button></div>
  </form>`;
}

// ---------------------------------------------------------------- a project's page
export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function UpdateBanner({ src }) {
  const u = src.update || {};
  const [busy, setBusy] = useState(false);
  if (u.state !== "available") return null;
  const ch = u.changes || {};
  const latest = u.latest || {};
  const act = async (cmd, label) => {
    setBusy(true);
    try {
      await api(cmd, { id: src.id });
      await ctx.reloadCatalog();
      ctx.toast(label);
    } catch (e) { ctx.toast(String(e.message || e)); } finally { setBusy(false); }
  };
  return html`<div class="update-banner" role="region" aria-label="Update">
    <p><b>Update ready</b>${latest.date ? ` from ${when(latest.date)}` : ""}${latest.message ? `: ${latest.message}` : ""}</p>
    ${latest.commits?.length ? html`<details><summary>${plural(latest.commits.length, "change")} upstream</summary>
      <ul class="commit-list">${latest.commits.map((c) => html`<li><code>${c.sha}</code> ${c.message} <span class="muted">${c.author || ""} ${when(c.date)}</span></li>`)}</ul></details>` : null}
    <ul class="change-list">
      ${ch.added?.length ? html`<li>New: ${ch.added.join(", ")}</li>` : null}
      ${ch.removed?.length ? html`<li>Removed: ${ch.removed.join(", ")}</li>` : null}
      ${(ch.settings || []).map((m) => html`<li>${m.model}: ${[
        m.added?.length ? `new settings ${m.added.join(", ")}` : "",
        m.removed?.length ? `removed ${m.removed.join(", ")}` : "",
        m.defaults?.length ? `new defaults for ${m.defaults.map((d) => d.name).join(", ")}` : ""].filter(Boolean).join("; ")}</li>`)}
      ${!ch.added?.length && !ch.removed?.length && !(ch.settings || []).length ? html`<li>No generator or setting changes found.</li>` : null}
    </ul>
    <p class="muted">The current version stays until you accept, and your edits are kept either way.</p>
    <div class="button-row"><button type="button" class="primary" disabled=${busy} onClick=${() => act("update_apply", "Updated.")} data-update="apply">Use the new version</button>
      <button type="button" class="ghost" disabled=${busy} onClick=${() => act("update_skip", "Skipped this update.")} data-update="skip">Skip it</button></div>
  </div>`;
}

export function SourcePanel({ id }) {
  const v = useStore(ui, (s) => s.catalogVersion);
  const tab = useStore(ui, (s) => s.sourceTab || "items");
  const setTab = (t) => ui.set({ sourceTab: t });
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState("");
  const src = sourceById(id);
  useEffect(() => {
    setInfo(null);
    if (src && tab !== "items") api("source_get", { id }).then(setInfo, (e) => setInfo({ error: String(e) }));
  }, [id, tab, v]);
  if (!src) return html`<p class="empty">This project isn't in the library.</p>`;
  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (e) { ctx.toast(String(e.message || e)); } finally { setBusy(""); }
  };
  const ro = readOnly();
  const origin = src.origin || {};
  const url = origin.url || src.meta?.origin;
  const problems = src.problems || [];
  const tabs = [["items", "Items"], ["about", "About"], ["files", "Files"], ["versions", "Versions"]];
  return html`<section class="source-panel" data-source=${id}>
    <div class="source-head">
      ${src.icon ? html`<img class="source-icon" src=${src.icon} alt="" />` : null}
      <div>
        <p class="source-kind">${kindText(src)}${src.role === "library" ? " · library" : ""}${src.version_date ? ` · version of ${when(src.version_date)}` : ""}</p>
        <p class="source-sub">${url ? html`<a href=${url} target="_blank" rel="noopener">${url.replace(/^https?:\/\//, "")}</a>`
          : html`<span title=${origin.path || origin.file || ""}>${(origin.path || origin.file || "").split(/[\\/]/).filter(Boolean).slice(-2).join("/")}</span>`}
          ${src.meta?.license?.spdx ? html` · ${src.meta.license.spdx === "NOASSERTION" ? "License not stated" : src.meta.license.spdx}` : null}</p>
      </div>
      <div class="source-actions">
        <button type="button" class="ghost" disabled=${ro} onClick=${() => ui.set({ dialog: { type: "edit", level: "project", source: id } })} data-act="edit">Edit details</button>
        <button type="button" class="ghost" disabled=${ro} onClick=${() => hideProject(id, !src.hidden)} data-act="hide-project"
          title=${src.hidden ? "List it again" : "Keep it and everything in it out of browsing and search"}>${src.hidden ? "Unhide" : "Hide"}</button>
        ${src.kind === "github" ? html`<button type="button" class="ghost" disabled=${!!busy || ro} data-act="check" onClick=${() => act("check", async () => {
          const r = await runJob(api("updates_check", { id }), `Checking ${src.name}`);
          await ctx.reloadCatalog();
          ctx.toast(r.updates?.length ? "An update is ready to review." : "No newer version.");
        })}>${busy === "check" ? "Checking…" : "Check for updates"}</button>` : null}
        ${src.kind !== "bundled" ? html`<button type="button" class="ghost" disabled=${!!busy || ro} data-act="reread" onClick=${() => act("read", async () => {
          await runJob(api("source_read", { id }), `Reading ${src.name}`);
          await ctx.reloadCatalog();
          makeThumbnails();
        })}>${busy === "read" ? "Reading…" : "Read again"}</button>` : null}
        <details class="menu"><summary class="ghost" aria-label="More">⋯</summary><div class="menu-panel">
          <button type="button" onClick=${() => api("source_get", { id }).then((i) => i.folder && ctx.platform.library.openPath(i.folder))}>Open its folder</button>
          ${src.kind !== "bundled" && src.kind !== "local" ? html`<button type="button" disabled=${ro} onClick=${() => act("role", async () => {
            await runJob(api("source_role", { id, role: src.role === "library" ? "project" : "library" }), `Reading ${src.name}`);
            await ctx.reloadCatalog();
          })}>${src.role === "library" ? "Treat as a project (list its models)" : "Treat as a library (others include it)"}</button>` : null}
          <button type="button" class="danger-text" disabled=${ro} data-act="remove" onClick=${() => act("remove", async () => {
            if (await deleteProject(id)) location.hash = "#/";
          })}>Delete project…</button>
        </div></details>
      </div>
    </div>
    <${UpdateBanner} src=${src} />
    ${src.update?.state === "error" ? html`<p class="lic-summary">Couldn't check for updates: ${src.update.error}</p>` : null}
    ${problems.length ? html`<details class="problems"><summary>${plural(problems.length, "problem")} reading this project</summary>
      <ul>${problems.map((p) => html`<li>${p.message}</li>`)}</ul></details>` : null}
    <div class="seg tabs-seg source-tabs" role="tablist">${tabs.map(([t, l]) => html`<button type="button" role="tab" class=${`seg-btn${tab === t ? " on" : ""}`}
      aria-selected=${tab === t ? "true" : "false"} onClick=${() => setTab(t)} data-source-tab=${t}>${l}</button>`)}</div>
    ${tab === "about" ? html`<div class="readme">${!info ? html`<p class="muted">Loading…</p>` : info.readme
      ? html`<div dangerouslySetInnerHTML=${{ __html: markdown(info.readme, url && /github\.com/.test(url) ? `${url}/blob/HEAD` : null) }}></div>`
      : html`<p class="muted">${src.meta?.summary || "No README."}</p>`}
      ${info?.license_text ? html`<details><summary>License text</summary><pre class="license-text">${info.license_text}</pre></details>` : null}</div>` : null}
    ${tab === "files" ? html`<div class="file-list">${!info ? html`<p class="muted">Loading…</p>` : html`
      <p class="muted">${plural(info.files.length, "file")}${info.files.length >= 2000 ? " (first 2000)" : ""} in <code>${info.folder}</code></p>
      <ul>${info.files.map(([p, n]) => html`<li><span>${p}</span><span class="muted">${bytes(n)}</span></li>`)}</ul>`}</div>` : null}
    ${tab === "versions" ? html`<div class="versions">${!info ? html`<p class="muted">Loading…</p>` : html`
      <ul>${(info.source.versions || []).slice().reverse().map((ver) => html`<li class=${ver.id === info.source.version ? "current" : ""}>
        <code>${ver.id}</code> ${when(ver.date)} ${ver.message ? html`<span class="muted">${ver.message}</span>` : null}
        ${ver.id === info.source.version ? html`<b> (in use)</b>` : null}</li>`)}</ul>
      ${(info.source.versions || []).length > 1 ? html`<button type="button" class="ghost" disabled=${ro} onClick=${() => act("clean", async () => {
        const r = await api("source_clean", { id });
        ctx.toast(r.removed.length ? `Removed ${plural(r.removed.length, "old version")}.` : "Nothing to remove.");
        setTab("versions"); await ctx.reloadCatalog();
      })}>Remove versions not in use</button>` : null}`}</div>` : null}
  </section>`;
}

// ---------------------------------------------------------------- needs attention
const ATTN_TEXT = { update: "Update ready", missing: "Missing files", settings: "Settings couldn't be read", unread: "Not read", reread: "Read with an older version",
  "missing-folder": "Folder missing", license: "License", scan: "Note", broken: "Flagged as broken" };
const attnLink = (a) => (a.kind === "broken" && a.model ? `#/m/${a.model}` : a.kind === "broken" && a.part ? `#/parts/${a.part}` : scopeHash(`source:${a.source}`));

export function AttentionList() {
  useStore(ui, (s) => s.catalogVersion);
  const items = ctx.catalog?.attention || [];
  if (!items.length) return null;
  const byKind = {};
  for (const a of items) (byKind[a.kind] ||= []).push(a);
  return html`<section class="attention-list" aria-label="Projects that need attention">
    ${Object.entries(byKind).map(([kind, list]) => html`<div class="attn-group"><h3>${ATTN_TEXT[kind] || kind} <span class="muted">${list.length}</span></h3>
      <ul>${list.slice(0, 40).map((a) => html`<li><a href=${attnLink(a)}>${sourceById(a.source)?.name || a.source}</a>: ${a.message}</li>`)}</ul></div>`)}
  </section>`;
}

// ---------------------------------------------------------------- thumbnails for new models
let thumbRunning = false;
let thumbViewer = null;

function thumbViewerFor() {
  if (thumbViewer) return thumbViewer;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:360px;pointer-events:none";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  wrap.append(canvas);
  document.body.append(wrap);
  thumbViewer = new Viewer(canvas);
  thumbViewer.renderer.setPixelRatio(1);
  thumbViewer.setEdges(false);
  thumbViewer.setGrid(false);
  return thumbViewer;
}

/** Draw an STL as a thumbnail (same camera and framing as tools/thumbnails.py). */
async function drawThumb(url) {
  const v = thumbViewerFor();
  v.setColor(ctx.platform.store.prefs.get("gw-filament") || "#f2b705");
  await v.load(url);
  v.view("iso");
  const size = v.bbox.getSize(v.camera.position.clone());
  const r = Math.max(size.length() / 2, 1);
  const dist = (r / Math.sin((v.camera.fov / 2) * Math.PI / 180)) * 0.95;
  const dir = v.camera.position.clone().sub(v.controls.target).normalize();
  v.camera.position.copy(v.controls.target).addScaledVector(dir, dist);
  v.camera.near = dist / 200; v.camera.far = dist * 50; v.camera.updateProjectionMatrix();
  v.controls.update();
  v.resize();
  v.renderer.render(v.scene, v.camera);
  return v.renderer.domElement.toDataURL("image/webp", 0.86);
}

/** Make thumbnails for library models and parts that have none (renders defaults). */
export async function makeThumbnails() {
  if (!isDesktop() || thumbRunning || readOnly()) return;
  const todo = ctx.index.items.filter((i) => !i.thumb && (i.kind === "generator" || i.preview) && sourceById(i.sourceId || i.projectId)?.kind !== "bundled");
  if (!todo.length) return;
  thumbRunning = true;
  const done = addJob(`Making thumbnails (0 of ${todo.length})`);
  let made = 0;
  try {
    for (const [n, it] of todo.entries()) {
      done.update(`Making thumbnails (${n + 1} of ${todo.length})`);
      if (!ctx.index.get(it.id)) continue; // deleted meanwhile
      try {
        let blob;
        if (it.kind === "generator") {
          const { detail, values } = await ctx.loadModel(it.key);
          blob = (await ctx.engine.render(detail, values, () => {}).promise).blob;
        } else {
          blob = await (await ctx.platform.fetch(it.preview)).blob();
        }
        const url = URL.createObjectURL(blob);
        let data;
        try { data = await drawThumb(url); } finally { URL.revokeObjectURL(url); }
        const name = it.kind === "generator" ? it.key.split("/")[1] : `part-${it.key.split("/")[1]}`;
        await api("thumb_put", { source: it.sourceId || it.projectId, name, data });
        made++;
      } catch (e) {
        console.warn("thumbnail", it.id, e);
      }
    }
  } finally {
    done();
    thumbRunning = false;
  }
  if (made) await ctx.reloadCatalog();
}

// ---------------------------------------------------------------- merge conflicts
export function MergeConflicts({ result }) {
  const [picks, setPicks] = useState(() => result.conflicts.map(() => "ours"));
  const close = () => ui.set({ dialog: null });
  const show = (v) => (v == null ? "(none)" : typeof v === "object" ? (v.spdx || v.label || JSON.stringify(v)) : String(v));
  const apply = async () => {
    const choices = result.conflicts.filter((_, i) => picks[i] === "theirs").map((c) => ({ ...c, value: c.theirs }));
    try { await api("merge_resolve", { choices }); await ctx.reloadCatalog(); ctx.toast("Merged."); close(); } catch (e) { ctx.toast(String(e)); }
  };
  return html`<div class="dialog merge-dialog" aria-label="Merge differences">
    <div class="dialog-head"><h2>Merged, with ${plural(result.conflicts.length, "difference")}</h2><button type="button" class="ghost" aria-label="Close" onClick=${close}>${Icon.close(16)}</button></div>
    <p>${plural(result.copied.length, "new project")}, ${plural(result.combined.length, "project")} in both libraries combined, ${plural(result.recipes, "saved setting")} copied. Where both libraries edited the same detail differently, pick which to keep:</p>
    <table class="table-view merge-table"><thead><tr><th>Where</th><th>Detail</th><th>This library</th><th>The other</th></tr></thead><tbody>
      ${result.conflicts.map((c, i) => html`<tr><td>${c.source ? sourceById(c.source)?.name || c.source : "Library"}${c.key ? ` › ${c.key}` : ""}</td><td>${c.field}</td>
        <td><label><input type="radio" name=${`m${i}`} checked=${picks[i] === "ours"} onChange=${() => setPicks(picks.map((p, j) => (j === i ? "ours" : p)))} /> ${show(c.ours)}</label></td>
        <td><label><input type="radio" name=${`m${i}`} checked=${picks[i] === "theirs"} onChange=${() => setPicks(picks.map((p, j) => (j === i ? "theirs" : p)))} /> ${show(c.theirs)}</label></td></tr>`)}
    </tbody></table>
    <div class="dialog-actions"><button type="button" class="primary" onClick=${apply}>Keep these</button></div>
  </div>`;
}

/** Read projects in the library's local/ folder (and linked folders) that changed. */
export async function rescanLocal(quiet = true) {
  if (!isDesktop() || readOnly()) return;
  try {
    const r = await runJob(api("source_rescan", {}), "Looking for changed projects");
    if (r.read?.length) {
      await ctx.reloadCatalog();
      if (!quiet) ctx.toast(`Read ${plural(r.read.length, "project")} again.`);
      makeThumbnails();
    } else if (!quiet) ctx.toast("No changes found.");
  } catch (e) {
    if (!quiet) ctx.toast(String(e.message || e));
  }
}

/** Check GitHub projects for updates at most once a day (desktop). */
export function dailyUpdateCheck() {
  if (!isDesktop() || readOnly()) return;
  const prefs = ctx.platform.store.prefs;
  const last = prefs.get("gw-update-check", 0) || 0;
  if (Date.now() - last < 864e5) return;
  if (!(ctx.catalog?.sources || []).some((s) => s.kind === "github")) return;
  prefs.set("gw-update-check", Date.now());
  runJob(api("updates_check", {}), "Checking for updates").then(async (r) => {
    if (r.updates?.length) {
      await ctx.reloadCatalog();
      ctx.toast(`${plural(r.updates.length, "update")} ready to review.`, { label: "Show", run: () => { location.hash = scopeHash("attention"); } });
    }
  }, () => {});
}

export { useMemo };
