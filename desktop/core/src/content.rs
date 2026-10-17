//! Pictures you choose and content you add (milestone 6, docs/DESKTOP_PLAN.md "Milestone 6 design").
//!
//! A chosen picture is a level's `icon` in `metadata.json`: `item:<project>/<item>`, `file:<path>` (a
//! picture in the project's files) or `picture:<name>` (one you added, in `sources/<id>/pictures/`).
//! Content you add is copied into `sources/<id>/attachments/` and listed under its level as
//! `attachments: [{ name, file | url, added }]`; the side viewer shows it beside the project's documents.

use crate::library::{self, Library};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;

pub const PICTURE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}

/// The pictures in a project's files (at most 200) and those you added: { files: [path], added: [name] }.
pub fn pictures(lib: &Library, id: &str, files_dir: &Path) -> Value {
    let files: Vec<String> = crate::scan::list_files(files_dir)
        .into_iter()
        .filter(|f| PICTURE_EXTS.contains(&ext_of(&f.rel).as_str()))
        .take(200)
        .map(|f| f.rel)
        .collect();
    let added: Vec<String> = lib
        .source_dir(id)
        .ok()
        .and_then(|d| std::fs::read_dir(d.join("pictures")).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| !n.starts_with('.') && PICTURE_EXTS.contains(&ext_of(n).as_str()))
        .collect();
    json!({ "files": files, "added": added })
}

/// Copy a file into `dir` under its own name (made unique, "name 2.pdf"), returning the name.
pub fn copy_in(dir: &Path, from: &Path) -> Result<String> {
    if !from.is_file() {
        bail!("{} isn't a file", from.display());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("couldn't create {}", dir.display()))?;
    let name = from.file_name().and_then(|n| n.to_str()).context("the file has no name")?;
    let clean: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let clean = clean.trim_start_matches('.').to_string();
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (clean.clone(), String::new()),
    };
    let mut out = format!("{stem}{ext}");
    let mut n = 2;
    while dir.join(&out).exists() {
        out = format!("{stem} {n}{ext}");
        n += 1;
    }
    let tmp = dir.join(format!(".{out}.tmp"));
    std::fs::copy(from, &tmp).with_context(|| format!("couldn't copy {}", from.display()))?;
    std::fs::rename(&tmp, dir.join(&out))?;
    Ok(out)
}

/// The kind of document an attachment is shown as.
pub fn kind_of(a: &Value) -> &'static str {
    if a["url"].is_string() {
        return "link";
    }
    match ext_of(a["file"].as_str().unwrap_or("")).as_str() {
        "pdf" => "pdf",
        "txt" | "md" | "markdown" | "csv" | "json" | "scad" | "log" => "text",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg" => "image",
        "mp4" | "webm" | "mov" | "m4v" | "ogg" => "video",
        _ => "file",
    }
}

/// A project's attachments as documents for the side viewer: each says which level it's for
/// ("project", "item:<id>", "part:<id>"), with its file under `sources/<id>/` or its link.
pub fn docs(lib: &Library, id: &str, url_prefix: &str) -> Vec<Value> {
    let meta = lib.metadata(id);
    let src_dir = lib.source_dir(id).ok();
    let mut out = vec![];
    let mut add = |list: &Value, level: &str, target: Option<&str>| {
        for (i, a) in list.as_array().into_iter().flatten().enumerate() {
            let kind = kind_of(a);
            let for_ = match target {
                Some(t) => format!("{level}:{t}"),
                None => "project".into(),
            };
            let mut d = json!({
                "id": format!("att-{}-{i}", for_.replace([':', '/'], "-")), "title": a["name"], "kind": kind, "attachment": true,
                "for": for_, "level": level, "target": target, "index": i, "added": a["added"],
            });
            if let Some(f) = a["file"].as_str() {
                if library::rel_inside(f).is_err() {
                    continue; // a hand-edited name that points outside attachments/
                }
                let rel = format!("attachments/{f}");
                d["file"] = json!(rel);
                d["href"] = json!(format!("{url_prefix}sources/{id}/{}", rel.split('/').map(crate::catalog::urlencode).collect::<Vec<_>>().join("/")));
                if let Some(p) = src_dir.as_ref().map(|d| d.join(&rel)) {
                    d["path"] = json!(p.display().to_string());
                    d["missing"] = json!(!p.is_file());
                }
            } else {
                d["url"] = a["url"].clone();
            }
            out.push(d);
        }
    };
    add(&meta["project"]["attachments"], "project", None);
    for (section, level) in [("items", "item"), ("parts", "part")] {
        for (t, m) in meta[section].as_object().into_iter().flatten() {
            add(&m["attachments"], level, Some(t));
        }
    }
    out
}

/// The `attachments` list of one level of `metadata.json` (created when missing).
pub fn list_mut<'a>(meta: &'a mut Value, section: &str, key: Option<&str>) -> &'a mut Vec<Value> {
    let level = crate::meta::level_mut(meta, section, key);
    let list = level.entry("attachments").or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    list.as_array_mut().unwrap()
}

/// Move a removed attachment's file to `backups/removed/` (rather than deleting it).
pub fn set_aside(lib: &Library, id: &str, file: &str) -> Result<()> {
    let from = lib.source_dir(id)?.join("attachments").join(library::rel_inside(file)?);
    if !from.is_file() {
        return Ok(());
    }
    let dir = lib.root().join("backups").join("removed");
    std::fs::create_dir_all(&dir)?;
    let stamp: String = library::now().chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    let name = from.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    std::fs::rename(&from, dir.join(format!("{stamp}-{id}-{name}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_get_their_own_names() {
        let t = std::env::temp_dir().join(format!("content-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let f = t.join("Guide.pdf");
        std::fs::write(&f, b"%PDF").unwrap();
        let dir = t.join("attachments");
        assert_eq!(copy_in(&dir, &f).unwrap(), "Guide.pdf");
        assert_eq!(copy_in(&dir, &f).unwrap(), "Guide 2.pdf");
        assert_eq!(kind_of(&json!({ "file": "Guide 2.pdf" })), "pdf");
        assert_eq!(kind_of(&json!({ "file": "build.MP4" })), "video");
        assert_eq!(kind_of(&json!({ "url": "https://example.com" })), "link");
        let _ = std::fs::remove_dir_all(&t);
    }
}
