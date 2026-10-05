//! Merging another library into the open one: projects it doesn't have are
//! copied; projects both have keep one copy, with missing versions added and the
//! user's edits combined. Edits that differ are reported as conflicts (the open
//! library's value stays until the user picks the other).

use crate::config::{read_json_object, Prefs};
use crate::library::Library;
use crate::meta;
use crate::project::copy_tree;
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::Path;

fn same_origin(a: &Value, b: &Value) -> bool {
    if a["kind"] != b["kind"] {
        return false;
    }
    let (oa, ob) = (&a["origin"], &b["origin"]);
    match a["kind"].as_str() {
        Some("github") => {
            let low = |v: &Value| v.as_str().unwrap_or("").to_lowercase();
            low(&oa["owner"]) == low(&ob["owner"]) && low(&oa["repo"]) == low(&ob["repo"]) && oa["subdir"] == ob["subdir"]
        }
        Some("bundled") => true,
        Some("zip") => a["versions"][0]["sha256"] == b["versions"][0]["sha256"] || oa["file"] == ob["file"],
        _ => oa == ob,
    }
}

/// Combine `theirs` into `ours` field by field. Returns conflicts.
fn merge_meta(ours: &mut Value, theirs: &Value, source: &str) -> Vec<Value> {
    let mut conflicts = vec![];
    let mut merge_level = |section: &str, key: Option<&str>, t: &Map<String, Value>, ours: &mut Value| {
        let lvl = meta::level_mut(ours, section, key);
        for (field, tv) in t {
            match lvl.get(field) {
                None => {
                    lvl.insert(field.clone(), tv.clone());
                }
                Some(ov) if ov == tv => {}
                Some(ov) => conflicts.push(json!({
                    "source": source, "section": section, "key": key, "field": field, "ours": ov, "theirs": tv,
                })),
            }
        }
    };
    if let Some(p) = theirs.get("project").and_then(Value::as_object) {
        merge_level("project", None, p, ours);
    }
    for section in ["folders", "items", "parts"] {
        for (k, v) in theirs.get(section).and_then(Value::as_object).into_iter().flatten() {
            if let Some(t) = v.as_object() {
                merge_level(section, Some(k), t, ours);
            }
        }
    }
    meta::prune(ours);
    conflicts
}

pub fn merge(lib: &Library, other: &Path, _prefs: &Prefs) -> Result<Value> {
    lib.writable()?;
    let other_meta = read_json_object(&other.join("library.json"));
    if !other.join("sources").is_dir() && !other.join("library.json").is_file() {
        bail!("{} isn't a SCAD Workshop library (no library.json or sources folder).", other.display());
    }
    if other.canonicalize().ok() == lib.root().canonicalize().ok() {
        bail!("That's the library that's open.");
    }
    if other_meta["format"].as_u64().unwrap_or(1) > crate::library::FORMAT {
        bail!("That library was made by a newer version of SCAD Workshop; update the app to merge it.");
    }
    let (mut copied, mut combined, mut conflicts) = (vec![], vec![], vec![]);
    let mut ids: Vec<String> = std::fs::read_dir(other.join("sources"))
        .map(|rd| rd.flatten().filter(|e| e.path().join("source.json").is_file()).filter_map(|e| e.file_name().to_str().map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    for id in ids {
        let from = other.join("sources").join(&id);
        let theirs: Value = serde_json::from_slice(&std::fs::read(from.join("source.json"))?).with_context(|| format!("{id}/source.json"))?;
        if theirs["kind"] == "local" {
            // their own projects live in their local/ folder: bring the folder over
            if let Some(rel) = theirs["origin"]["path"].as_str() {
                let target = lib.root().join(rel);
                if !target.exists() {
                    copy_tree(&other.join(rel), &target)?;
                    copied.push(json!({ "id": id, "as": rel }));
                }
            }
            continue;
        }
        match lib.source(&id) {
            Err(_) => {
                copy_tree(&from, &lib.source_dir(&id)?)?;
                copied.push(json!({ "id": id }));
            }
            Ok(ours) if same_origin(&ours, &theirs) => {
                let to = lib.source_dir(&id)?;
                for sub in ["files", "derived", "thumbs", "previews"] {
                    for e in std::fs::read_dir(from.join(sub)).map(|rd| rd.flatten().collect::<Vec<_>>()).unwrap_or_default() {
                        let dst = to.join(sub).join(e.file_name());
                        if !dst.exists() {
                            if e.path().is_dir() {
                                copy_tree(&e.path(), &dst)?;
                            } else {
                                std::fs::create_dir_all(to.join(sub))?;
                                std::fs::copy(e.path(), &dst)?;
                            }
                        }
                    }
                }
                // versions known to either side
                let mut ours = ours;
                let mut versions = ours["versions"].as_array().cloned().unwrap_or_default();
                for v in theirs["versions"].as_array().into_iter().flatten() {
                    if !versions.iter().any(|x| x["id"] == v["id"]) {
                        versions.push(v.clone());
                    }
                }
                ours["versions"] = Value::Array(versions);
                lib.save_source(&ours)?;
                let mut m = lib.metadata(&id);
                let c = merge_meta(&mut m, &read_json_object(&from.join("metadata.json")), &id);
                lib.save_metadata(&id, &m)?;
                conflicts.extend(c);
                combined.push(json!({ "id": id }));
            }
            Ok(_) => {
                let new_id = lib.new_source_id(&format!("{id} merged"));
                copy_tree(&from, &lib.source_dir(&new_id)?)?;
                let mut s = lib.source(&new_id)?;
                s["id"] = json!(new_id);
                lib.save_source(&s)?;
                // derived data names its own files by project id
                copied.push(json!({ "id": id, "as": new_id }));
            }
        }
    }
    // saved settings: new ones by id
    let mut recipes = 0;
    for e in std::fs::read_dir(other.join("recipes")).map(|rd| rd.flatten().collect::<Vec<_>>()).unwrap_or_default() {
        let dst = lib.root().join("recipes").join(e.file_name());
        if e.path().extension().is_some_and(|x| x == "json") && !dst.exists() {
            std::fs::copy(e.path(), dst)?;
            recipes += 1;
        }
    }
    // favourites, library-wide metadata and categories
    let mut mine = lib.meta();
    let mut favs = mine["favourites"].as_array().cloned().unwrap_or_default();
    for f in other_meta["favourites"].as_array().into_iter().flatten() {
        if !favs.contains(f) {
            favs.push(f.clone());
        }
    }
    let mut patch = json!({ "favourites": favs });
    for section in ["metadata", "categories"] {
        let mut ours = mine[section].as_object().cloned().unwrap_or_default();
        for (k, v) in other_meta[section].as_object().into_iter().flatten() {
            match ours.get(k) {
                None => {
                    ours.insert(k.clone(), v.clone());
                }
                Some(o) if o == v => {}
                Some(o) => conflicts.push(json!({ "source": null, "section": format!("library.{section}"), "key": null, "field": k, "ours": o, "theirs": v })),
            }
        }
        if !ours.is_empty() {
            patch[section] = Value::Object(ours);
        }
    }
    mine = lib.update_meta(patch)?;
    let _ = mine;
    Ok(json!({ "copied": copied, "combined": combined, "recipes": recipes, "conflicts": conflicts }))
}

/// Apply the user's picks for merge conflicts: [{source, section, key, field, value}].
pub fn resolve(lib: &Library, choices: &Value) -> Result<()> {
    for c in choices.as_array().into_iter().flatten() {
        let field = c["field"].as_str().context("choice without field")?;
        let section = c["section"].as_str().unwrap_or("project");
        if let Some(sec) = section.strip_prefix("library.") {
            let mut m = lib.meta()[sec].as_object().cloned().unwrap_or_default();
            m.insert(field.into(), c["value"].clone());
            lib.update_meta(json!({ sec: m }))?;
            continue;
        }
        let id = c["source"].as_str().context("choice without project")?;
        let mut m = lib.metadata(id);
        meta::level_mut(&mut m, section, c["key"].as_str()).insert(field.into(), c["value"].clone());
        lib.save_metadata(id, &m)?;
    }
    Ok(())
}
