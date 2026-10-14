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

// Tabs are at least TAB_MIN wide; those that don't fit go in a "+N" list at the
// end of the row (the active one always stays in the row). When the row is
// crowded the tabs leave out their project's name first.
const TAB_MIN = 180, TAB_ROOMY = 240;

export function Tabs() {
  const s = useStore(ui, (st) => ({ tabs: st.tabs, active: st.activeTab, view: st.view }));
  const strip = useRef();
  const bar = useRef();
  const [width, setWidth] = useState(0);
  const any = s.tabs.length > 0;
  useEffect(() => {
    if (!any || !bar.current) return undefined;
    const el = bar.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [any]);
  useEffect(() => { strip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [s.active, s.view, s.tabs.length]);
  if (!any) return null;
  const close = (key, e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.closeModelTab(key);
  };
  const item = (key) => ctx.index.get(`${key.startsWith("@") ? "comp" : "gen"}:${key}`);
  const libActive = s.view !== "model";
  // how many fit beside the Library tab (about 110 px) and, when some don't, the +N button (about 64 px)
  const room = Math.max(0, (width || 2000) - 110);
  let shown = s.tabs, more = [];
  if (s.tabs.length * TAB_MIN > room) {
    const fit = Math.max(1, Math.floor((room - 64) / TAB_MIN));
    shown = s.tabs.slice(0, fit);
    const ai = s.tabs.indexOf(s.active);
    if (s.view === "model" && ai >= fit) shown = [...shown.slice(0, fit - 1), s.active];
    more = s.tabs.filter((k) => !shown.includes(k));
  }
  const crowded = shown.length * TAB_ROOMY > room;
  return html`<div class="tabbar" ref=${bar}>
    <div class=${`tabstrip${crowded ? " crowded" : ""}`} role="tablist" aria-label="Open models" ref=${strip}>
      <a role="tab" class=${`tab tab-lib${libActive ? " active" : ""}`} aria-selected=${libActive ? "true" : "false"}
        href=${ui.get().lastBrowse || "#/"}>${Icon.grid(14)} Library</a>
      ${shown.map((key) => {
        const it = item(key);
        const on = s.view === "model" && s.active === key;
        return html`<a role="tab" class=${`tab${on ? " active" : ""}`} aria-selected=${on ? "true" : "false"} href=${`#/m/${key}`} key=${key}
          data-tab=${key} title=${it ? `${it.name}, ${it.project}` : "No longer in the library"}
          onAuxClick=${(e) => { if (e.button === 1) close(key, e); }}>
          ${it?.thumb ? html`<img src=${it.thumb} alt="" />` : null}
          <span class="tab-name">${it ? it.name : key.split("/").pop()}</span><span class="tab-project">${it?.project}</span>
          <button type="button" class="tab-close" aria-label=${`Close ${it?.name || key}`} onClick=${(e) => close(key, e)}>${Icon.close(12)}</button>
        </a>`;
      })}
    </div>
    ${more.length ? html`<details class="menu tab-more" key="more">
      <summary class="ghost small" title="The other open models" aria-label=${`${more.length} more open models`}>+${more.length} ▾</summary>
      <div class="menu-panel">${more.map((key) => {
        const it = item(key);
        return html`<div class="tab-more-row" key=${key}>
          <button type="button" data-tab-more=${key} onClick=${(e) => { e.target.closest("details").open = false; location.hash = `#/m/${key}`; }}>
            <b>${it ? it.name : key}</b>${it?.project ? html` <span class="muted">${it.project}</span>` : null}</button>
          <button type="button" class="tab-close" aria-label=${`Close ${it?.name || key}`} onClick=${(e) => close(key, e)}>${Icon.close(12)}</button>
        </div>`;
      })}</div>
    </details>` : null}
  </div>`;
}

function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return html`<span class="unit">${Math.round((Date.now() - since) / 1000)} s</span>`;
}

export function StatusBar() {
  const s = useStore(ui, (st) => ({ jobs: st.jobs, ready: st.ready }));
  const [open, setOpen] = useState(false);
  if (!s.ready) return null;
  const shown = ctx.index.items.filter((i) => !i.hidden);
  const gens = shown.filter((i) => i.kind === "generator").length;
  const comps = shown.filter((i) => i.kind === "component").length;
  const latest = s.jobs[s.jobs.length - 1];
  return html`<div class="statusbar-inner">
    <span>${plural(gens, "parametric model")}${comps ? ` · ${plural(comps, "component")}` : ""} · ${plural(shown.length - gens - comps, "part")}${ctx.index.hiddenCount ? ` · ${ctx.index.hiddenCount} hidden` : ""}</span>
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
