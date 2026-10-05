// Quick look (Space): a large 3D view without leaving the list. Generators render
// with default settings (the desktop app's cache makes repeats instant); parts load
// their preview file.
import { html, useEffect, useRef, useState } from "../lib/html.js";
import { useStore } from "../lib/store.js";
import { ui, addJob, isDark } from "./state.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";
import { Viewer } from "../viewer.js";
import { fmt } from "../lib/util.js";

let viewer = null;

export function QuickLook() {
  const id = useStore(ui, (s) => s.quicklook);
  const canvas = useRef();
  const [msg, setMsg] = useState("");
  const [dims, setDims] = useState(null);
  const item = id ? ctx.index.get(id) : null;

  useEffect(() => {
    if (!item) return;
    let cancelled = false, job = null, done = null;
    setDims(null);
    if (!viewer || viewer.canvas !== canvas.current) {
      viewer = new Viewer(canvas.current);
      viewer.setColor(ctx.platform.store.prefs.get("gw-filament") || "#f2b705");
    }
    viewer.setTheme?.(isDark());
    viewer.clear();
    const show = async (blob) => {
      const url = URL.createObjectURL(blob);
      try { const d = await viewer.load(url); if (!cancelled) { setDims(d); setMsg(""); } } finally { URL.revokeObjectURL(url); }
    };
    (async () => {
      try {
        if (item.kind === "part") {
          if (!item.preview) { setMsg("No 3D preview: this part comes as CAD files."); return; }
          setMsg("Loading…");
          await show(await (await ctx.platform.fetch(item.preview)).blob());
        } else if (item.needs?.length) {
          setMsg(`This component needs values first (${item.needs.join(", ")}): open it to set them.`);
        } else {
          setMsg("Making it with default settings…");
          const { detail, values } = await ctx.loadModel(item.key);
          if (cancelled) return;
          job = ctx.engine.render(detail, values, (ev) => { if (ev.type === "stage" && !cancelled) setMsg(ev.stage); });
          done = addJob(`Quick look: ${item.name}`, () => job.cancel());
          const r = await job.promise;
          if (!cancelled) await show(r.blob);
        }
      } catch (e) {
        if (!cancelled && !e.cancelled) setMsg(`Couldn't show it: ${e.message}`);
      } finally { done?.(); }
    })();
    return () => { cancelled = true; job?.cancel(); done?.(); };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const key = (e) => {
      if (e.key === "Escape" || (e.key === " " && !e.target.closest("input, textarea, select"))) {
        e.preventDefault();
        e.stopPropagation(); // or the list's own Space handler opens it again
        ui.set({ quicklook: null });
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [id]);

  return html`<div class="quicklook-backdrop" hidden=${!item} onPointerDown=${(e) => { if (e.target === e.currentTarget) ui.set({ quicklook: null }); }}>
    <div class="quicklook" role="dialog" aria-modal="true" aria-label=${item ? `Quick look: ${item.name}` : "Quick look"}>
      <div class="ql-head">
        <div><b>${item?.name}</b> <span class="muted">${item?.project}</span></div>
        ${dims ? html`<span class="ql-dims">${fmt(dims.x)} × ${fmt(dims.y)} × ${fmt(dims.z)} mm</span>` : null}
        ${item ? html`<a class="button primary" href=${item.href} onClick=${() => ui.set({ quicklook: null })}>Open</a>` : null}
        <button type="button" class="ghost" aria-label="Close" onClick=${() => ui.set({ quicklook: null })}>${Icon.close(16)}</button>
      </div>
      <div class="ql-stage"><canvas ref=${canvas}></canvas>${msg ? html`<p class="ql-msg">${msg}</p>` : null}</div>
    </div>
  </div>`;
}
