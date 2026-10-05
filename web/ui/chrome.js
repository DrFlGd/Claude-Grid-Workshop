// The parts around the main view: the top bar's search and buttons, the
// workbench tabs, and the status bar with background jobs.
import { html, useEffect, useRef, useState } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui, setTabs, cycleTheme, resolvedTheme } from "./state.js";
import { ctx, scopeHash } from "./context.js";
import { Icon } from "./icons.js";
import { plural } from "../lib/util.js";

export function searchTo(q) {
  const target = q ? `#/search?q=${encodeURIComponent(q)}` : "#/search";
  ui.set({ q, scope: "search", view: "browse", selection: [] });
  if (location.hash.startsWith("#/search")) history.replaceState(null, "", target);
  else location.hash = target;
}

export function TopSearch() {
  const s = useStore(ui, (st) => ({ q: st.q, scope: st.scope, view: st.view }));
  const input = useRef();
  const value = s.view === "browse" ? s.q : "";
  useEffect(() => {
    const key = (e) => {
      const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ui.set({ palette: !ui.get().palette }); }
      else if (e.key === "/" && !typing) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return html`<div class="topsearch">
    <span class="topsearch-icon">${Icon.search(16)}</span>
    <input ref=${input} type="search" id="global-search" value=${value} placeholder="Search models, parts, settings…"
      aria-label="Search everything" autocomplete="off" spellcheck="false"
      onInput=${(e) => searchTo(e.target.value)}
      onKeyDown=${(e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); document.querySelector(".results")?.focus(); } }} />
    <button type="button" class="kbd" onClick=${() => ui.set({ palette: true })} title="Command palette">Ctrl K</button>
  </div>`;
}

export function TopButtons() {
  const theme = useStore(ui, (s) => s.theme);
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); window.addEventListener("gw-theme", f); return () => window.removeEventListener("gw-theme", f); }, []);
  const cur = resolvedTheme();
  const next = { light: "dark", dark: "night", night: "light" }[cur];
  return html`<button type="button" class="topicon nav-burger" aria-label="Menu" onClick=${() => ui.set({ navOpen: !ui.get().navOpen })}>${Icon.menu(18)}</button>
    <button type="button" class="topicon" id="theme-toggle" aria-label=${`Theme: ${cur}. Switch to ${next}`} title=${`Theme: ${cur}${theme === "system" ? " (system)" : ""}. Click for ${next}.`}
      onClick=${cycleTheme}>${cur === "light" ? Icon.sun(17) : cur === "dark" ? Icon.moon(17) : Icon.night(17)}</button>`;
}

export function Tabs() {
  const s = useStore(ui, (st) => ({ tabs: st.tabs, active: st.activeTab, view: st.view }));
  const strip = useRef();
  useEffect(() => { strip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [s.active, s.view, s.tabs.length]);
  if (!s.tabs.length) return null;
  // a mouse wheel scrolls the strip sideways when there are more tabs than fit
  const onWheel = (e) => {
    const el = strip.current;
    if (el && el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
  };
  const close = (key, e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.closeModelTab(key);
  };
  const libActive = s.view !== "model";
  return html`<div class="tabstrip" role="tablist" aria-label="Open models" ref=${strip} onWheel=${onWheel}>
    <a role="tab" class=${`tab tab-lib${libActive ? " active" : ""}`} aria-selected=${libActive ? "true" : "false"}
      href=${ui.get().lastBrowse || "#/"}>${Icon.grid(14)} Library</a>
    ${s.tabs.map((key) => {
      const it = ctx.index.get(`gen:${key}`);
      const on = s.view === "model" && s.active === key;
      return html`<a role="tab" class=${`tab${on ? " active" : ""}`} aria-selected=${on ? "true" : "false"} href=${`#/m/${key}`} key=${key}
        data-tab=${key} title=${it ? `${it.name}, ${it.project}` : key}
        onAuxClick=${(e) => { if (e.button === 1) close(key, e); }}>
        ${it?.thumb ? html`<img src=${it.thumb} alt="" />` : null}
        <span class="tab-name">${it ? it.name : key}</span><span class="tab-project">${it?.project}</span>
        <button type="button" class="tab-close" aria-label=${`Close ${it?.name || key}`} onClick=${(e) => close(key, e)}>${Icon.close(12)}</button>
      </a>`;
    })}
  </div>`;
}

function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return html`${Math.round((Date.now() - since) / 1000)} s`;
}

export function StatusBar() {
  const s = useStore(ui, (st) => ({ jobs: st.jobs, ready: st.ready }));
  const [open, setOpen] = useState(false);
  if (!s.ready) return null;
  const shown = ctx.index.items.filter((i) => !i.hidden);
  const gens = shown.filter((i) => i.kind === "generator").length;
  const latest = s.jobs[s.jobs.length - 1];
  return html`<div class="statusbar-inner">
    <span>${plural(gens, "parametric model")} · ${plural(shown.length - gens, "part")}${ctx.index.hiddenCount ? ` · ${ctx.index.hiddenCount} hidden` : ""}</span>
    <span class="status-jobs">
      ${latest ? html`<button type="button" class="status-job" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>
        <span class="dot busy"></span>${latest.label}… <${Elapsed} since=${latest.started} />${s.jobs.length > 1 ? ` · ${s.jobs.length} running` : ""}</button>`
        : html`<span class="status-idle"><span class="dot"></span>Ready</span>`}
      ${open && s.jobs.length ? html`<div class="jobs-panel" role="dialog" aria-label="Background work">
        ${s.jobs.map((j) => html`<div class="job" key=${j.id}><span>${j.label}</span><span class="muted"><${Elapsed} since=${j.started} /></span>
          ${j.cancel ? html`<button type="button" class="ghost" onClick=${() => j.cancel()}>Cancel</button>` : null}</div>`)}
      </div>` : null}
    </span>
  </div>`;
}

export { setTabs, scopeHash };
