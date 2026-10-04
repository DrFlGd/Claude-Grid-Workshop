// Small helpers shared by the workbench (imperative DOM) and the interface (Preact).

export const $ = (s, root = document) => root.querySelector(s);

export const el = (tag, attrs = {}, ...kids) => {
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

export function humanize(name) {
  const axis = name.match(/^(grid|size|offset|pos|position|count|units|scale|rotate|spacing|divisions?)([xyz])$/);
  if (axis) name = `${axis[1]}_${axis[2].toUpperCase()}`;
  const s = name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  return s.split(" ").map((w, i) => {
    if (/^(mm|deg)$/i.test(w)) return `(${w.toLowerCase()})`;
    if (/^[A-Z0-9]{2,}$/.test(w) || /^[XYZ]$/.test(w)) return w;
    return i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
  }).join(" ");
}

export const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const bytes = (n) => (n > 1048576 ? `${fmt(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Keep simple formatting from third-party descriptions; drop anything active. */
const SAFE_TAGS = new Set(["A", "B", "STRONG", "I", "EM", "BR", "P", "SPAN", "CODE", "UL", "OL", "LI", "DIV", "SMALL"]);
export function safeHTML(html) {
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
export function compileCondition(expr, names) {
  try {
    const fn = new Function(...names, `"use strict"; return (${expr});`);
    return (values) => { try { return !!fn(...names.map((n) => values[n])); } catch { return true; } };
  } catch { return () => true; }
}

export const STATUS_TEXT = { ok: "OK to share", review: "Check license", blocked: "License unclear" };
export const spdx = (l) => (!l?.spdx || l.spdx === "NOASSERTION" ? "Not stated" : l.spdx);
export const FORMAT_LABEL = { "3mf": "3MF", stl: "STL", step: "STEP", shapr: "Shapr3D", pdf: "PDF", obj: "OBJ" };
