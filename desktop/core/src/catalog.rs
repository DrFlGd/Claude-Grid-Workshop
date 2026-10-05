//! The app's catalog: every project in the open library, with the user's edits
//! applied, in the same shape as the website's data/catalog.json (so the page
//! needs no second code path), plus the projects themselves and what needs attention.

use crate::library::Library;
use crate::meta::{self, Layers};
use crate::project::{self, category_label};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

/// Everything the page reads, built once per change.
#[derive(Default)]
pub struct Catalog {
    pub catalog: Value,
    /// "family/model" -> model page JSON (edits applied)
    pub models: HashMap<String, Value>,
    /// parts pack id -> data/libraries/<id>.json shape
    pub parts: HashMap<String, Value>,
    /// sha256 -> file on disk, for renders
    pub blobs: HashMap<String, PathBuf>,
    /// source id -> (derived data of the current version, folder of that version)
    pub derived: HashMap<String, (Value, PathBuf)>,
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Build the catalog. `url` is how the page reaches library files ("library://localhost/").
pub fn build(lib: &Library, engine: &str, common_files: &Value, url: &str) -> Catalog {
    let mut out = Catalog::default();
    let lib_meta = lib.meta();
    let lib_defaults = lib_meta.get("metadata").and_then(Value::as_object).cloned();
    let custom_cats: Map<String, Value> = lib_meta.get("categories").and_then(Value::as_object).cloned().unwrap_or_default();
    let (mut models, mut families, mut libraries, mut sources, mut attention) = (vec![], vec![], vec![], vec![], vec![]);
    let mut profile_uses: Map<String, Value> = Map::new();
    // category -> (model keys, number of parts)
    let mut cats: Vec<(String, Vec<Value>, usize)> = vec![];
    // items the user deleted (kept out of the catalog; Library settings can bring them back)
    let mut removed_items: Vec<Value> = vec![];
    // a removed category points to the one its items moved to
    let moved: HashMap<String, String> = custom_cats
        .iter()
        .filter_map(|(k, v)| v["moved_to"].as_str().filter(|t| !t.is_empty() && *t != k).map(|t| (k.clone(), t.to_string())))
        .collect();
    let canon = |c: &str| -> String {
        let mut c = if c.is_empty() || c == "parts" { "other".to_string() } else { c.to_string() };
        for _ in 0..8 {
            match moved.get(&c) {
                Some(t) => c = t.clone(),
                None => break,
            }
        }
        c
    };
    let cat_label = |c: &str| custom_cats.get(c).and_then(|x| x["label"].as_str()).map(String::from).unwrap_or_else(|| category_label(c));
    let file_url = |rel: &str| format!("{url}{}", rel.split('/').map(urlencode).collect::<Vec<_>>().join("/"));
    for id in lib.source_ids() {
        let Ok(src) = lib.source(&id) else { continue };
        let version = src["version"].as_str().unwrap_or("").to_string();
        let edits = lib.metadata(&id);
        let det_project = {
            let mut d = obj(&src["detected"]);
            if let Some(Value::Object(o)) = src.get("detected") {
                if o.get("category").is_none() {
                    d.remove("category");
                }
            }
            d
        };
        let derived = lib.derived(&id, &version);
        let dir = lib.version_dir(&src, &version).ok();
        let mut entry = json!({
            "id": id, "kind": src["kind"], "role": src["role"], "origin": src["origin"],
            "version": version, "version_date": src["version_date"], "added": src["added"],
            "update": src["update"], "read": derived.is_some(),
        });
        if src["kind"] == "linked" && !dir.as_ref().is_some_and(|d| d.is_dir()) {
            attention.push(json!({ "kind": "missing-folder", "source": id, "message": format!("The linked folder {} is missing; relink it or remove the project.", src["origin"]["path"].as_str().unwrap_or("")) }));
        }
        if src["update"]["state"] == "available" {
            attention.push(json!({ "kind": "update", "source": id, "message": "An update is ready to review." }));
        }
        let Some(derived) = derived else {
            entry["name"] = src["detected"]["name"].clone();
            attention.push(json!({ "kind": "unread", "source": id, "message": "Not read yet (or reading failed)." }));
            sources.push(entry);
            continue;
        };
        if derived["format"].as_u64().unwrap_or(0) < project::DERIVED_FORMAT && src["kind"] != "bundled" {
            attention.push(json!({ "kind": "reread", "source": id, "message": "Read with an older version of the app; read it again." }));
        }
        // the project's own resolved metadata
        let fam = &derived["family"];
        let mut det = det_project.clone();
        for k in ["name", "summary", "license", "authors", "tags", "category"] {
            if det.get(k).is_none_or(|v| v.is_null() || v.as_str() == Some("")) {
                if let Some(v) = fam.get(k).filter(|v| !v.is_null()) {
                    det.insert(k.into(), v.clone());
                }
            }
        }
        if let Some(c) = fam.get("category").filter(|_| det.get("category").is_none()) {
            det.insert("category".into(), c.clone());
        }
        let empty = Map::new();
        let (pvals, pfrom) = meta::resolve(&Layers {
            item: edits.get("project").and_then(Value::as_object),
            folders: vec![],
            project: None,
            detected_item: &det,
            detected_project: &empty,
            library: lib_defaults.as_ref(),
        });
        let pname = pvals.get("name").cloned().unwrap_or(json!(id));
        let pcat = canon(pvals.get("category").and_then(Value::as_str).unwrap_or("other"));
        if pvals.get("hidden").and_then(Value::as_bool) == Some(true) {
            entry["hidden"] = json!(true);
        }
        let project_thumb = edits["project"]["icon"].as_str().map(|i| icon_url(i, &id, &file_url));
        entry["name"] = pname.clone();
        entry["meta"] = Value::Object(pvals.clone());
        entry["from"] = Value::Object(pfrom.clone());
        entry["icon"] = project_thumb.clone().map(Value::String).unwrap_or(Value::Null);
        entry["models"] = json!(derived["models"].as_array().map(|m| m.len()).unwrap_or(0));
        entry["parts"] = json!(derived["parts"].as_array().map(|p| p.len()).unwrap_or(0));
        entry["problems"] = derived["problems"].clone();
        for p in derived["problems"].as_array().into_iter().flatten() {
            attention.push(json!({ "kind": p["kind"], "source": id, "model": p["model"], "message": p["message"] }));
        }
        if pvals.get("license").and_then(|l| l["public_use"].as_str()).is_some_and(|u| u != "ok") {
            attention.push(json!({ "kind": "license", "source": id, "message": "License not stated, or not cleared for sharing prints." }));
        }
        // blobs for renders
        for (sha, e) in derived["blobs"].as_object().into_iter().flatten() {
            if let Some(p) = e.as_str().and_then(|e| project::blob_path(lib, e)) {
                out.blobs.insert(sha.clone(), p);
            }
        }
        let thumbs = lib.source_dir(&id).map(|d| d.join("thumbs")).ok();
        let has_thumb = |name: &str| thumbs.as_ref().is_some_and(|t| t.join(name).is_file());
        // models
        let mut model_names = vec![];
        for d in derived["models"].as_array().into_iter().flatten() {
            let mid = d["id"].as_str().unwrap_or("").to_string();
            let key = d["key"].as_str().unwrap_or("").to_string();
            let folder = d["folder"].as_str().unwrap_or("");
            let det_item = obj(&json!({ "name": d["name"] }));
            let (vals, from) = meta::resolve(&Layers {
                item: edits.get("items").and_then(|i| i.get(&mid)).and_then(Value::as_object),
                folders: meta::folder_chain(&edits, folder),
                project: edits.get("project").and_then(Value::as_object),
                detected_item: &det_item,
                detected_project: &det,
                library: lib_defaults.as_ref(),
            });
            if vals.get("deleted").and_then(Value::as_bool) == Some(true) {
                removed_items.push(json!({ "source": id, "level": "item", "target": mid, "name": vals.get("name").unwrap_or(&d["name"]), "project": pname }));
                continue;
            }
            let mut detail = d.clone();
            apply(&mut detail, &vals, &custom_cats);
            let c = canon(detail["category"].as_str().unwrap_or("other"));
            detail["category_label"] = json!(cat_label(&c));
            detail["category"] = json!(c);
            detail["family_name"] = pname.clone();
            detail["from"] = Value::Object(from.clone());
            detail["meta"] = Value::Object(vals.clone());
            detail["source_id"] = json!(id);
            if has_thumb(&format!("{mid}.webp")) {
                detail["thumb"] = json!(file_url(&format!("sources/{id}/thumbs/{mid}.webp")));
            }
            if let Some(icon) = vals.get("icon").and_then(Value::as_str) {
                detail["thumb"] = json!(icon_url(icon, &id, &file_url));
            }
            let mut summary = Map::new();
            for k in ["key", "family", "family_name", "id", "name", "category", "category_label", "summary", "tags", "license", "browser", "updated", "updated_from", "settings", "terms", "thumb", "source_id", "folder"] {
                if let Some(v) = detail.get(k).filter(|v| !v.is_null()) {
                    summary.insert(k.into(), v.clone());
                }
            }
            if let Some(f) = vals.get("fields") {
                summary.insert("fields".into(), f.clone());
            }
            if let Some(a) = vals.get("authors") {
                summary.insert("authors".into(), a.clone());
            }
            flags(&mut summary, &vals, &from, &id, &mut attention, json!({ "model": key }));
            for p in detail["parameters"].as_array().into_iter().flatten() {
                if let Some(profile) = p["profile"].as_str() {
                    let field = profile.split('.').next().unwrap_or(profile).to_string();
                    profile_uses.entry(field).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!({ "key": key, "param": p["name"] }));
                }
            }
            let cat = summary.get("category").and_then(Value::as_str).unwrap_or("other").to_string();
            match cats.iter_mut().find(|(c, _, _)| *c == cat) {
                Some((_, v, _)) => v.push(json!(key)),
                None => cats.push((cat, vec![json!(key)], 0)),
            }
            model_names.push(detail["name"].clone());
            out.models.insert(key, detail);
            models.push(Value::Object(summary));
        }
        // ready-made parts: one pack per project
        let parts = derived["parts"].as_array().cloned().unwrap_or_default();
        if !parts.is_empty() {
            let mut items = vec![];
            let mut part_cats: Vec<String> = vec![];
            for it in parts {
                let pid = it["id"].as_str().unwrap_or("").to_string();
                let folder = it["files"][0]["path"].as_str().map(|p| crate::ingest::dirname(&format!("/{p}")).trim_start_matches('/').to_string()).unwrap_or_default();
                let det_item = obj(&json!({ "name": it["name"] }));
                let (vals, from) = meta::resolve(&Layers {
                    item: edits.get("parts").and_then(|i| i.get(&pid)).and_then(Value::as_object),
                    folders: meta::folder_chain(&edits, &folder),
                    project: edits.get("project").and_then(Value::as_object),
                    detected_item: &det_item,
                    detected_project: &det,
                    library: lib_defaults.as_ref(),
                });
                if vals.get("deleted").and_then(Value::as_bool) == Some(true) {
                    removed_items.push(json!({ "source": id, "level": "part", "target": pid, "name": vals.get("name").unwrap_or(&it["name"]), "project": pname }));
                    continue;
                }
                let mut it = it.clone();
                if let Some(n) = vals.get("name") {
                    it["name"] = n.clone();
                }
                // the library-wide category (the pack's own "category" is a subcategory: "Connectors", ...)
                let c = canon(vals.get("category").and_then(Value::as_str).unwrap_or(&pcat));
                it["category_label"] = json!(cat_label(&c));
                it["category_id"] = json!(c.clone());
                match cats.iter_mut().find(|(x, _, _)| *x == c) {
                    Some((_, _, n)) => *n += 1,
                    None => cats.push((c, vec![], 1)),
                }
                if let Some(a) = vals.get("authors") {
                    it["authors"] = a.clone();
                }
                if let Some(o) = it.as_object_mut() {
                    flags(o, &vals, &from, &id, &mut attention, json!({ "part": format!("{id}/{pid}") }));
                }
                for k in ["tags", "license", "summary"] {
                    if let Some(v) = vals.get(k) {
                        it[k] = v.clone();
                    }
                }
                if let Some(s) = vals.get("summary") {
                    it["description"] = s.clone();
                }
                it["meta"] = Value::Object(vals.clone());
                it["from"] = Value::Object(from);
                it["folder"] = json!(folder);
                for f in it["files"].as_array_mut().into_iter().flatten() {
                    let rel = format!("sources/{id}/files/{version}/{}", f["path"].as_str().unwrap_or(""));
                    f["url"] = json!(format!("library/{rel}"));
                }
                if let Some(stl) = it["preview_stl"].as_str() {
                    it["preview_url"] = json!(format!("library/sources/{id}/{stl}"));
                } else if let Some(p) = it["preview"].as_str().filter(|p| p.to_lowercase().ends_with(".stl")) {
                    it["preview_url"] = json!(format!("library/sources/{id}/files/{version}/{p}"));
                }
                if has_thumb(&format!("part-{pid}.webp")) {
                    it["thumb"] = json!(file_url(&format!("sources/{id}/thumbs/part-{pid}.webp")));
                }
                if let Some(icon) = vals.get("icon").and_then(Value::as_str) {
                    it["thumb"] = json!(icon_url(icon, &id, &file_url));
                }
                if let Some(c) = it["category"].as_str() {
                    if !part_cats.contains(&c.to_string()) {
                        part_cats.push(c.to_string());
                    }
                }
                items.push(it);
            }
            part_cats.sort();
            if !items.is_empty() {
                let pack = json!({
                    "id": id, "name": pname, "summary": pvals.get("summary").cloned().unwrap_or(json!("")),
                    "license": pvals.get("license").cloned().unwrap_or(json!({})), "authors": pvals.get("authors").cloned().unwrap_or(json!([])),
                    "source_url": pvals.get("origin").cloned().unwrap_or(Value::Null), "notes": derived["notes"],
                    "status": "available", "items": items, "item_count": items.len(), "categories": part_cats,
                    "source_id": id, "category": pcat, "category_label": cat_label(&pcat),
                });
                libraries.push(json!({
                    "id": id, "name": pack["name"], "summary": pack["summary"], "item_count": pack["item_count"],
                    "categories": pack["categories"], "license": pack["license"], "authors": pack["authors"], "source_id": id,
                    "category": pcat,
                }));
                out.parts.insert(id.clone(), pack);
            }
        }
        if !model_names.is_empty() {
            families.push(json!({
                "id": id, "name": pname, "status": "available", "category": pcat,
                "license": pvals.get("license").cloned().unwrap_or(json!({})), "authors": pvals.get("authors").cloned().unwrap_or(json!([])),
                "source": pvals.get("origin").cloned().unwrap_or(Value::Null), "models": model_names,
                "summary": pvals.get("summary").cloned().unwrap_or(json!("")), "source_id": id, "icon": project_thumb,
            }));
        }
        out.derived.insert(id.clone(), (derived, dir.unwrap_or_default()));
        sources.push(entry);
    }
    // project overrides ("list this item under another project"), now that every project's name is known
    // (a moved item is hidden with the project it's listed under, not the one it came from)
    let names: HashMap<String, (Value, bool)> =
        sources.iter().filter_map(|s| Some((s["id"].as_str()?.to_string(), (s["name"].clone(), s["hidden"] == true)))).collect();
    let relist = |o: &mut Map<String, Value>, id_key: &str, name_key: &str| {
        let shown = o.shift_remove("shown").is_some(); // "not hidden" set on the item itself
        let Some(t) = o.shift_remove("project_override") else { return };
        let Some((n, hidden)) = t.as_str().and_then(|t| names.get(t)) else { return };
        o.insert(name_key.into(), n.clone());
        o.insert(id_key.into(), t);
        if o.get("hidden").and_then(Value::as_str) == Some("project") {
            o.shift_remove("hidden");
        }
        if *hidden && !shown && !o.contains_key("hidden") {
            o.insert("hidden".into(), json!("project"));
        }
    };
    for m in models.iter_mut() {
        if let Some(o) = m.as_object_mut() {
            relist(o, "family", "family_name");
        }
    }
    for pack in out.parts.values_mut() {
        for it in pack["items"].as_array_mut().into_iter().flatten() {
            if let Some(o) = it.as_object_mut() {
                relist(o, "project_id", "project_name");
            }
        }
    }
    // categories: built-in, found in projects, or made by the user; a removed one points elsewhere
    let builtin = |c: &str| crate::sitebuild::CATEGORY_LABELS.iter().chain(crate::scan::EXTRA_CATEGORIES.iter()).any(|(id, _)| *id == c);
    let order = |c: &str| -> (u8, usize, String) {
        match crate::sitebuild::CATEGORY_LABELS.iter().position(|(id, _)| *id == c) {
            _ if c == "other" => (2, 0, String::new()),
            Some(p) => (0, p, String::new()),
            None => (1, 0, cat_label(c).to_lowercase()),
        }
    };
    cats.sort_by_key(|c| order(&c.0));
    let categories: Vec<Value> = cats
        .iter()
        .map(|(c, keys, parts)| {
            json!({
                "id": c,
                "label": cat_label(c),
                "icon": custom_cats.get(c).and_then(|x| x["icon"].as_str()).map(|i| icon_url(i, "", &file_url)),
                "models": keys,
                "parts": parts,
            })
        })
        .collect();
    let mut ids: Vec<String> = crate::sitebuild::CATEGORY_LABELS
        .iter()
        .chain(crate::scan::EXTRA_CATEGORIES.iter())
        .map(|(id, _)| id.to_string())
        .chain(custom_cats.keys().cloned())
        .chain(cats.iter().map(|c| c.0.clone()))
        .collect();
    ids.dedup();
    let mut seen = std::collections::HashSet::new();
    ids.retain(|c| seen.insert(c.clone()));
    ids.sort_by_key(|c| order(c));
    let count = |c: &str| cats.iter().find(|x| x.0 == c).map(|x| (x.1.len(), x.2)).unwrap_or((0, 0));
    let all_categories: Vec<Value> = ids
        .iter()
        .filter(|c| !moved.contains_key(*c))
        .map(|c| {
            let (m, p) = count(c);
            json!({ "id": c, "label": cat_label(c), "builtin": builtin(c), "models": m, "parts": p,
                    "icon": custom_cats.get(c).and_then(|x| x["icon"].as_str()).map(|i| icon_url(i, "", &file_url)) })
        })
        .collect();
    let removed_categories: Vec<Value> = ids
        .iter()
        .filter_map(|c| moved.get(c).map(|t| json!({ "id": c, "label": cat_label(c), "moved_to": t, "moved_to_label": cat_label(&canon(t)) })))
        .collect();
    out.catalog = json!({
        "engine": engine,
        "common_files": common_files,
        "models": models,
        "categories": categories,
        "category_choices": all_categories,
        "categories_removed": removed_categories,
        "removed_items": removed_items,
        "families": families,
        "libraries": libraries,
        "profile_uses": profile_uses,
        "sources": sources,
        "attention": attention,
        "library": lib.info(),
        "library_meta": { "metadata": lib_meta.get("metadata").cloned().unwrap_or(json!({})), "categories": custom_cats },
    });
    out
}

/// The user's flags on an item, for the page: "hidden" (where it was hidden: "item",
/// "project", "folder:<path>"), "broken" ({ note, date }, also listed under Needs
/// attention) and "project_override" (resolved to a name once every project is known).
fn flags(out: &mut Map<String, Value>, vals: &Map<String, Value>, from: &Map<String, Value>, source: &str, attention: &mut Vec<Value>, what: Value) {
    match vals.get("hidden").and_then(Value::as_bool) {
        Some(true) => {
            out.insert("hidden".into(), from.get("hidden").cloned().unwrap_or(json!("item")));
        }
        Some(false) if from.get("hidden").and_then(Value::as_str) == Some("item") => {
            out.insert("shown".into(), json!(true));
        }
        _ => {}
    }
    if let Some(b) = vals.get("broken").filter(|b| !b.is_null() && b.as_bool() != Some(false)) {
        let b = if b.is_object() { b.clone() } else { json!({}) };
        let note = b["note"].as_str().filter(|n| !n.is_empty()).map(|n| format!(": {n}")).unwrap_or_default();
        let name = vals.get("name").and_then(Value::as_str).unwrap_or("");
        let mut a = json!({ "kind": "broken", "source": source, "message": format!("{name} is flagged as broken{note}") });
        for (k, v) in what.as_object().into_iter().flatten() {
            a[k] = v.clone();
        }
        attention.push(a);
        out.insert("broken".into(), b);
    }
    if let Some(t) = vals.get("project").and_then(Value::as_str).filter(|t| !t.is_empty() && *t != source) {
        out.insert("project_override".into(), json!(t));
    }
}

/// Apply resolved metadata to a model page's JSON.
fn apply(detail: &mut Value, vals: &Map<String, Value>, custom_cats: &Map<String, Value>) {
    for k in ["name", "summary", "tags", "license", "authors", "notes"] {
        if let Some(v) = vals.get(k) {
            detail[k] = v.clone();
        }
    }
    if let Some(c) = vals.get("category").and_then(Value::as_str) {
        detail["category"] = json!(c);
        detail["category_label"] = json!(custom_cats.get(c).and_then(|x| x["label"].as_str()).map(String::from).unwrap_or_else(|| category_label(c)));
    }
    if let Some(o) = vals.get("origin") {
        detail["links"] = json!({ "source": o });
    }
}

/// An icon value: "item:<model or part id>" (that item's thumbnail) or a library path.
fn icon_url(icon: &str, source: &str, file_url: &dyn Fn(&str) -> String) -> String {
    if let Some(item) = icon.strip_prefix("item:") {
        let (src, item) = item.split_once('/').unwrap_or((source, item));
        return file_url(&format!("sources/{src}/thumbs/{item}.webp"));
    }
    file_url(icon.trim_start_matches('/'))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The blob registry as (sha, path) pairs for the renderer.
pub fn blob_list(c: &Catalog) -> Vec<(String, PathBuf)> {
    c.blobs.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Sources sorted for display.
pub fn sorted_sources(c: &Catalog) -> BTreeMap<String, Value> {
    c.catalog["sources"].as_array().into_iter().flatten().filter_map(|s| Some((s["id"].as_str()?.to_string(), s.clone()))).collect()
}
