// What the interface needs from the rest of the app, set once at start-up by
// app.js: { platform, catalog, libraries, index, engine, loadModel, closeModelTab, deliver }.
export const ctx = {};
export function setContext(values) { Object.assign(ctx, values); }

/** Where a browse place lives in the URL, and back. */
export function scopeHash(scope, q = "") {
  const base = scope === "home" ? "#/" : `#/browse/${scope.replace(":", "/")}`;
  return q ? `${base === "#/" ? "#/browse/all" : base}?q=${encodeURIComponent(q)}` : base;
}

export function scopeFromPath(path) {
  // "browse/cat/gridfinity" -> "cat:gridfinity"
  const parts = path.split("/").slice(1);
  if (!parts.length || !parts[0]) return "all";
  return parts.length > 1 ? `${parts[0]}:${parts.slice(1).join("/")}` : parts[0];
}
