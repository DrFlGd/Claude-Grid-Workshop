// The `index` seam (docs/DESKTOP_PLAN.md, section 5), in memory over the
// built catalog. Items are generators and ready-made parts; queries do
// free-text search (prefix, typo-tolerant, synonyms, setting names), typed
// filters (kind:, tag:, project:, cat:, license:), facets, sorting and paging.
// The desktop app will swap in SQLite behind the same interface (Phase 2).

const SYNONYMS = {
  cog: ["gear"], gear: ["cog"], box: ["enclosure", "case", "bin"], case: ["box", "enclosure"], enclosure: ["box", "case"],
  tray: ["bin"], cable: ["channel", "cord"], cord: ["cable", "channel"], wall: ["grid", "pegboard"],
  pegboard: ["wall", "grid"], tag: ["label"], sign: ["label", "text"], screw: ["bolt", "fastener"], bolt: ["screw", "fastener"],
  lid: ["cover"], cover: ["lid"], base: ["baseplate"], plate: ["baseplate"], drawer: ["drawers", "kitchen"],
};
const KINDS = { generator: "Generators", part: "Parts" };
export const LICENSE_TEXT = { ok: "OK to share", review: "Check license", blocked: "License unclear" };

/** "Updated" buckets for the filter, relative to today. */
export const AGE_TEXT = { month: "In the last month", quarter: "In the last 3 months", year: "In the last year", older: "Over a year ago", unknown: "Date not known" };
function ageBucket(date) {
  if (!date) return "unknown";
  const days = (Date.now() - Date.parse(date)) / 864e5;
  return days <= 31 ? "month" : days <= 92 ? "quarter" : days <= 366 ? "year" : "older";
}

const words = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9.]+/).filter(Boolean);

/** Levenshtein distance up to 1 (enough for a typo in a word of 5+ letters). */
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function parseQuery(text) {
  const filters = {};
  const free = [];
  for (const part of (text || "").match(/(\w+:"[^"]*"|\S+)/g) || []) {
    const m = part.match(/^(kind|tag|tags|project|source|cat|category|license|updated):(.+)$/i);
    if (m) {
      const key = { tags: "tag", source: "project", category: "cat" }[m[1].toLowerCase()] || m[1].toLowerCase();
      (filters[key] ||= []).push(m[2].replace(/^"|"$/g, "").toLowerCase());
    } else free.push(part);
  }
  return { text: free.join(" "), filters };
}

export class LocalIndex {
  constructor(catalog, libraries) {
    const famById = Object.fromEntries((catalog.families || []).map((f) => [f.id, f]));
    const catLabel = Object.fromEntries((catalog.categories || []).map((c) => [c.id, c.label]));
    this.items = [];
    for (const m of catalog.models) {
      const fam = famById[m.family] || {};
      this.items.push({
        id: `gen:${m.key}`, kind: "generator", key: m.key, name: m.name, project: m.family_name, projectId: m.family,
        category: m.category, categoryLabel: catLabel[m.category] || m.category_label || m.category,
        tags: m.tags || [], summary: m.summary || "", license: m.license || {}, licenseStatus: m.license?.public_use || "ok",
        authors: (fam.authors || []).map((a) => a.name), thumb: m.thumb || null, settings: m.settings ?? null,
        desktopOnly: m.browser === false, terms: m.terms || "", href: `#/m/${m.key}`,
        updated: m.updated || null, updatedFrom: m.updated_from || null,
        folder: m.folder || "", fields: m.fields || {},
      });
    }
    for (const lib of libraries || []) {
      for (const it of lib.items) {
        this.items.push({
          id: `part:${lib.id}/${it.id}`, kind: "part", key: `${lib.id}/${it.id}`, name: it.name, project: lib.name, projectId: lib.id,
          category: "parts", categoryLabel: "Ready-made parts", subcategory: it.category, tags: it.tags || [],
          summary: it.description || "", license: lib.license || {}, licenseStatus: lib.license?.public_use || "ok",
          authors: (lib.authors || []).map((a) => a.name), thumb: it.thumb || null, dims: it.dimensions || null,
          files: it.files || [], preview: it.preview_url || null, generator: it.generator || null, terms: "",
          href: `#/parts/${lib.id}/${it.id}`, updated: it.updated || lib.updated || null, updatedFrom: null,
          folder: it.folder || "", fields: it.meta?.fields || {},
        });
      }
    }
    this.byId = new Map(this.items.map((i) => [i.id, i]));
    // search fields per item, weighted: name 6, project/tags 3, category 2, summary/authors 1, settings 1
    this.fields = this.items.map((i) => [
      [words(i.name), 6], [words(i.project), 3], [words(i.tags.join(" ")), 3],
      [words(`${i.categoryLabel} ${i.subcategory || ""}`), 2], [words(`${i.summary} ${i.authors.join(" ")}`), 1],
      [words(`${i.terms} ${Object.values(i.fields).join(" ")}`), 1],
    ]);
    /** Names of the open metadata fields any item has ("material", ...), for filters and columns. */
    this.fieldNames = [...new Set(this.items.flatMap((i) => Object.keys(i.fields)))].sort((a, b) => a.localeCompare(b));
    this.vocab = new Set(this.fields.flatMap((f) => f.flatMap(([w]) => w)));
  }

  get(id) { return this.byId.get(id) || null; }

  /** Expand a typed word: synonyms, and close spellings from the index's own vocabulary. */
  expand(word) {
    const out = new Set([word, ...(SYNONYMS[word] || [])]);
    if (word.endsWith("s") && word.length > 3) out.add(word.slice(0, -1));
    if (word.length >= 5 && !this.vocab.has(word) && ![...this.vocab].some((v) => v.startsWith(word))) {
      for (const v of this.vocab) if (within1(word, v)) out.add(v);
    }
    return [...out];
  }

  score(idx, terms) {
    let total = 0;
    for (const alts of terms) {
      let best = 0;
      for (const [ws, weight] of this.fields[idx]) {
        for (const w of ws) {
          for (const [k, a] of alts.entries()) {
            const factor = k === 0 ? 1 : 0.7; // the word as typed beats its synonyms and corrections
            if (w === a) best = Math.max(best, weight * 1.2 * factor);
            else if (w.startsWith(a)) best = Math.max(best, weight * factor);
          }
        }
      }
      if (!best) return 0; // every word must match somewhere
      total += best;
    }
    return total;
  }

  /**
   * query({ text, scope, filters, sort, offset, limit }) -> { total, items, facets, ms }
   * scope: { kind?, category?, project?, ids? } narrows before search (the sidebar's choice);
   * filters: { kind: [], cat: [], project: [], tag: [], license: [] } from chips or typed filters.
   */
  query({ text = "", scope = {}, filters = {}, sort = "relevance", offset = 0, limit = Infinity } = {}) {
    const t0 = performance.now();
    const parsed = parseQuery(text);
    const exact = filters;          // chips: whole values
    const typed = parsed.filters;   // typed "tag:gear": parts of values
    const terms = words(parsed.text).map((w) => this.expand(w));
    const ids = scope.ids ? new Set(scope.ids) : null;
    const customKeys = Object.keys(filters).filter((k) => k.startsWith("f:") && filters[k]?.length);
    const inScope = (i) => (!scope.kind || i.kind === scope.kind) && (!scope.category || i.category === scope.category) &&
      (!scope.project || i.projectId === scope.project) && (!ids || ids.has(i.id));
    const has = (key, cands, skip) => {
      if (skip === key) return true;
      const c = cands.map((x) => (x || "").toLowerCase());
      return (!exact[key]?.length || exact[key].some((v) => c.includes(v))) &&
        (!typed[key]?.length || typed[key].some((v) => c.some((x) => x.includes(v))));
    };
    const pass = (i, skip) =>
      has("kind", [i.kind, KINDS[i.kind]], skip) &&
      has("cat", [i.category, i.categoryLabel, i.subcategory], skip) &&
      has("project", [i.projectId, i.project], skip) &&
      has("tag", i.tags, skip) &&
      has("license", [i.licenseStatus, LICENSE_TEXT[i.licenseStatus], i.license.spdx], skip) &&
      has("updated", [ageBucket(i.updated), AGE_TEXT[ageBucket(i.updated)]], skip) &&
      customKeys.every((k) => has(k, [String(i.fields[k.slice(2)] ?? "")], skip));

    const scored = [];
    this.items.forEach((item, idx) => {
      if (!inScope(item)) return;
      const s = terms.length ? this.score(idx, terms) : 1;
      if (s) scored.push({ item, s });
    });
    // facets: counts for each filter group, ignoring that group's own selection
    const facets = { kind: {}, cat: {}, project: {}, license: {}, updated: {}, fields: {} };
    for (const { item } of scored) {
      if (pass(item, "kind")) facets.kind[item.kind] = (facets.kind[item.kind] || 0) + 1;
      const cat = item.kind === "part" ? item.subcategory || item.categoryLabel : item.categoryLabel;
      if (pass(item, "cat")) facets.cat[cat] = (facets.cat[cat] || 0) + 1;
      if (pass(item, "project")) facets.project[item.project] = (facets.project[item.project] || 0) + 1;
      if (pass(item, "license")) facets.license[item.licenseStatus] = (facets.license[item.licenseStatus] || 0) + 1;
      const age = ageBucket(item.updated);
      if (pass(item, "updated")) facets.updated[age] = (facets.updated[age] || 0) + 1;
      for (const [k, v] of Object.entries(item.fields)) {
        if (!pass(item, `f:${k}`)) continue;
        const f = (facets.fields[k] ||= {});
        f[String(v)] = (f[String(v)] || 0) + 1;
      }
    }
    let hits = scored.filter(({ item }) => pass(item));
    const by = {
      name: (a, b) => a.item.name.localeCompare(b.item.name, undefined, { numeric: true }) || a.item.project.localeCompare(b.item.project),
      project: (a, b) => a.item.project.localeCompare(b.item.project) || a.item.name.localeCompare(b.item.name, undefined, { numeric: true }),
      kind: (a, b) => a.item.kind.localeCompare(b.item.kind) || by.name(a, b),
      settings: (a, b) => (b.item.settings ?? -1) - (a.item.settings ?? -1) || by.name(a, b),
      license: (a, b) => a.item.licenseStatus.localeCompare(b.item.licenseStatus) || by.name(a, b),
      relevance: (a, b) => b.s - a.s || by.project(a, b),
      updated: (a, b) => (b.item.updated || "").localeCompare(a.item.updated || "") || by.name(a, b), // newest first
      given: (a, b) => (order.get(a.item.id) ?? 1e9) - (order.get(b.item.id) ?? 1e9), // e.g. most recent first
    };
    if (sort.startsWith("f:")) {
      const k = sort.slice(2);
      by[sort] = (a, b) => String(a.item.fields[k] ?? "\uffff").localeCompare(String(b.item.fields[k] ?? "\uffff"), undefined, { numeric: true }) || by.name(a, b);
    }
    const order = new Map((scope.ids || []).map((id, i) => [id, i]));
    hits.sort(by[sort] || (terms.length ? by.relevance : by.project));
    const total = hits.length;
    hits = hits.slice(offset, offset + limit);
    return { total, items: hits.map((h) => h.item), facets, ms: performance.now() - t0, parsed };
  }
}
