// Edited model files (the side viewer's Code tab): { "/path/file.scad": text }. The
// engines render them in place of the originals; a key tells two sets of edits apart.

/** A short hash of a text (FNV-1a, 32 bits), for keys and "changed?" checks. */
export function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** "" for no edits, else a key that changes whenever an edited file's text does. */
export function editsKey(edits) {
  const e = Object.entries(edits || {});
  if (!e.length) return "";
  return e.sort((a, b) => a[0].localeCompare(b[0])).map(([p, t]) => `${p}:${t.length}:${textHash(t)}`).join("|");
}
