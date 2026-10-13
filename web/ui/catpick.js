// Choosing a category: one control wherever a category is picked (Edit details,
// Pin as model, Library settings). A button showing the current category opens a
// list of every category (built-in and your own) with how many models and parts
// each holds, a box to filter it, and "New category…". Unlike a text box with
// suggestions, the whole list shows whatever is chosen now.
import { html, useState, useEffect, useRef, useLayoutEffect } from "../lib/html.js";
import { ctx } from "./context.js";
import { Icon } from "./icons.js";

export const categoryChoices = () => ctx.catalog?.category_choices || [];

const counts = (c) => [c.models ? `${c.models} model${c.models === 1 ? "" : "s"}` : "", c.parts ? `${c.parts} part${c.parts === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");

/**
 * value: a category id, or the label of one not made yet (shown as new), or "".
 * onChange(value): an id, or { create: label } for a new category, or "" for emptyLabel.
 * emptyLabel: offer an entry that clears the choice ("Leave as is", "The level above's").
 * allowNew: offer "New category…". exclude: ids not to offer.
 */
export function CategoryPicker({ id, value, onChange, emptyLabel = null, allowNew = true, exclude = [], placeholder = "Choose a category", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const btn = useRef(null);
  const pop = useRef(null);
  const box = useRef(null);
  const [pos, setPos] = useState(null);
  const [naming, setNaming] = useState(false); // "New category…" chosen: the box takes the name
  const cats = categoryChoices().filter((c) => !exclude.includes(c.id));
  const current = cats.find((c) => c.id === value) || categoryChoices().find((c) => c.id === value);
  const shown = value === "" || value == null ? (emptyLabel || placeholder) : current ? current.label : `${value} (new)`;

  const q = filter.trim().toLowerCase();
  const list = cats.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q));
  const exact = q && cats.some((c) => c.label.toLowerCase() === q);
  // the options in order: [kind, payload, label]
  const options = [
    ...(emptyLabel != null && !q ? [["empty", "", emptyLabel]] : []),
    ...list.map((c) => ["cat", c.id, c.label, c]),
    ...(allowNew && q && !exact ? [["new", filter.trim(), `New category “${filter.trim()}”`]] : []),
    ...(allowNew && !q ? [["newprompt", "", "New category…"]] : []),
  ];

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 260 && r.top > below;
    setPos({ left: r.left, width: Math.max(r.width, 240), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }), max: Math.max(160, (up ? r.top : below) - 16) });
  };
  useLayoutEffect(() => { if (open) place(); else setNaming(false); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const onMove = () => place();
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    setTimeout(() => box.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDoc, true); window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open]);
  useEffect(() => {
    // opening: start on the current category
    if (!open) return;
    const i = options.findIndex((o) => o[0] === "cat" && o[1] === value);
    setActive(i >= 0 ? i : 0);
  }, [open]);
  // the highlighted option, kept inside the list (it may have just got shorter)
  const at = Math.max(0, Math.min(active, options.length - 1));
  useEffect(() => { pop.current?.querySelector(".catpick-opt.active")?.scrollIntoView({ block: "nearest" }); }, [at, open]);

  const choose = (o) => {
    if (o?.[0] === "newprompt") { setNaming(true); box.current?.focus(); return; }
    setNaming(false);
    setOpen(false);
    setFilter("");
    if (!o) return;
    if (o[0] === "new") onChange({ create: o[1] });
    else onChange(o[1]);
    btn.current?.focus();
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(options.length - 1, at + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, at - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (options.length) choose(options[at]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); setFilter(""); setNaming(false); btn.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return html`<span class="catpick">
    <button type="button" class="catpick-btn" id=${id} ref=${btn} disabled=${disabled} aria-haspopup="listbox" aria-expanded=${open ? "true" : "false"}
      data-value=${value || ""} onClick=${() => setOpen(!open)}
      onKeyDown=${(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}>
      ${current?.icon ? html`<img class="catpick-icon" src=${current.icon} alt="" />` : null}
      <span class=${`catpick-label${value ? "" : " muted"}`}>${shown}</span>${Icon.chevron(12)}</button>
    ${open && pos ? html`<div class="catpick-pop" ref=${pop} role="dialog" aria-label="Categories"
        onClick=${(e) => { if (e.target.tagName !== "INPUT") e.preventDefault(); /* inside a <label>, a click would reach the button */ }}
        style=${{ left: `${pos.left}px`, width: `${pos.width}px`, ...(pos.top != null ? { top: `${pos.top}px` } : { bottom: `${pos.bottom}px` }) }}>
      <input class="catpick-filter" ref=${box} value=${filter} placeholder=${naming ? "Name of the new category" : allowNew ? "Filter, or type a new name" : "Filter"} aria-label="Filter categories"
        onInput=${(e) => { setFilter(e.target.value); setActive(0); /* typing: the best match first */ }} onKeyDown=${onKey} />
      <ul class="catpick-list" role="listbox" style=${{ maxHeight: `${pos.max - 48}px` }}>
        ${options.map((o, i) => html`<li role="option" aria-selected=${o[0] === "cat" && o[1] === value ? "true" : "false"}
            class=${`catpick-opt${i === at ? " active" : ""}${o[0] !== "cat" ? ` catpick-${o[0]}` : ""}${o[0] === "cat" && o[1] === value ? " chosen" : ""}`}
            data-cat=${o[0] === "cat" ? o[1] : o[0]} onMouseMove=${() => i !== at && setActive(i)} onMouseDown=${(e) => e.preventDefault()} onClick=${() => choose(o)}>
          ${o[0] === "new" || o[0] === "newprompt" ? Icon.plus(12) : null}<span class="catpick-name">${o[2]}${o[3] && !o[3].builtin ? html` <small class="muted">(yours)</small>` : null}</span>
          ${o[3] ? html`<small class="catpick-count muted">${counts(o[3])}</small>` : null}</li>`)}
        ${!options.length ? html`<li class="catpick-none muted">No category matches.</li>` : null}
      </ul>
      ${naming && !q ? html`<p class="catpick-hint muted">Type the new category's name, then press Enter.</p>` : null}
    </div>` : null}
  </span>`;
}
