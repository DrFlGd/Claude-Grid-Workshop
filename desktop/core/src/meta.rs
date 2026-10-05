//! Layered metadata (docs/DESKTOP_PLAN.md, "Metadata levels"): what a project
//! detected about itself, and the user's edits at library, project, folder and
//! item level. Resolving gives each field's value and where it came from.
//!
//! A project's edits live in sources/<id>/metadata.json:
//! ```json
//! { "project": { "license": { "spdx": "CC-BY-4.0" } },
//!   "folders": { "lids": { "tags": ["lids"] } },
//!   "items":   { "bin": { "name": "Basic bin" } },
//!   "parts":   { "latch": { "license": { "spdx": "MIT" } } } }
//! ```

use serde_json::{json, Map, Value};

/// Fields an item takes from its folder and project unless it has its own.
/// ("hidden" on a project hides all its items; an item can say false.)
pub const INHERITED: [&str; 7] = ["summary", "category", "tags", "license", "authors", "origin", "hidden"];
/// Fields that belong to one level only. On an item: "broken" ({ note, date }: it
/// doesn't work), "deleted" (left out of the library, also after updates) and
/// "project" (listed under another project; credits stay with its own).
pub const OWN: [&str; 6] = ["name", "notes", "icon", "broken", "deleted", "project"];

/// Every editable field (plus open "fields": { key: value }).
pub fn is_field(k: &str) -> bool {
    INHERITED.contains(&k) || OWN.contains(&k) || k == "fields"
}

/// Where a resolved value came from.
fn from_label(level: &str) -> Value {
    json!(level)
}

/// Tidy a user value: license objects get their "public_use" from the SPDX id.
pub fn normalise(field: &str, v: &Value) -> Value {
    match (field, v) {
        ("license", Value::String(s)) => license_value(s),
        ("license", Value::Object(o)) => {
            let spdx = o.get("spdx").and_then(Value::as_str).unwrap_or("NOASSERTION");
            let mut l = license_value(spdx);
            if let Some(pu) = o.get("public_use") {
                l["public_use"] = pu.clone();
            }
            if let Some(n) = o.get("notes") {
                l["notes"] = n.clone();
            }
            l
        }
        ("hidden" | "deleted", v) => json!(v.as_bool().unwrap_or(!v.is_null())),
        ("broken", Value::Bool(true)) => json!({}),
        ("broken", Value::String(s)) => json!({ "note": s }),
        ("tags", Value::String(s)) => json!(s.split(',').map(str::trim).filter(|t| !t.is_empty()).collect::<Vec<_>>()),
        ("authors", Value::String(s)) => json!(s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(|n| json!({ "name": n })).collect::<Vec<_>>()),
        _ => v.clone(),
    }
}

pub fn license_value(spdx: &str) -> Value {
    let spdx = if spdx.trim().is_empty() { "NOASSERTION" } else { spdx.trim() };
    let public_use = if spdx == "NOASSERTION" { "review" } else { crate::scan::public_use(Some(spdx)) };
    json!({ "spdx": spdx, "public_use": public_use })
}

/// The levels that apply to one item, most specific first.
pub struct Layers<'a> {
    pub item: Option<&'a Map<String, Value>>,
    /// The item's folder edits, deepest folder first, with their paths.
    pub folders: Vec<(String, &'a Map<String, Value>)>,
    pub project: Option<&'a Map<String, Value>>,
    pub detected_item: &'a Map<String, Value>,
    pub detected_project: &'a Map<String, Value>,
    pub library: Option<&'a Map<String, Value>>,
}

/// The folder edits that apply to `folder` ("a/b/c" -> c, then b, then a), deepest first.
pub fn folder_chain<'a>(meta: &'a Value, folder: &str) -> Vec<(String, &'a Map<String, Value>)> {
    let Some(folders) = meta.get("folders").and_then(Value::as_object) else { return vec![] };
    let mut out = vec![];
    let mut cur = folder.trim_matches('/').to_string();
    while !cur.is_empty() {
        if let Some(m) = folders.get(&cur).and_then(Value::as_object) {
            out.push((cur.clone(), m));
        }
        cur = cur.rsplit_once('/').map(|(a, _)| a.to_string()).unwrap_or_default();
    }
    out
}

/// Resolve every field: (values, where each came from).
pub fn resolve(l: &Layers) -> (Map<String, Value>, Map<String, Value>) {
    let mut values = Map::new();
    let mut from = Map::new();
    let pick = |field: &str, inherited: bool| -> Option<(Value, Value)> {
        if let Some(v) = l.item.and_then(|m| m.get(field)).filter(|v| !v.is_null()) {
            return Some((v.clone(), from_label("item")));
        }
        if inherited {
            for (path, m) in &l.folders {
                if let Some(v) = m.get(field).filter(|v| !v.is_null()) {
                    return Some((v.clone(), json!(format!("folder:{path}"))));
                }
            }
            if let Some(v) = l.project.and_then(|m| m.get(field)).filter(|v| !v.is_null()) {
                return Some((v.clone(), from_label("project")));
            }
        }
        if let Some(v) = l.detected_item.get(field).filter(|v| !v.is_null() && !is_empty_value(v)) {
            return Some((v.clone(), from_label("detected")));
        }
        if inherited {
            if let Some(v) = l.detected_project.get(field).filter(|v| !v.is_null() && !is_empty_value(v)) {
                return Some((v.clone(), from_label("detected")));
            }
            if let Some(v) = l.library.and_then(|m| m.get(field)).filter(|v| !v.is_null()) {
                return Some((v.clone(), from_label("library")));
            }
        }
        None
    };
    for f in INHERITED {
        if let Some((v, src)) = pick(f, true) {
            values.insert(f.into(), normalise(f, &v));
            from.insert(f.into(), src);
        }
    }
    for f in OWN {
        if let Some((v, src)) = pick(f, false) {
            values.insert(f.into(), v);
            from.insert(f.into(), src);
        }
    }
    // open fields: each key resolved on its own
    let mut keys: Vec<String> = vec![];
    for m in [l.item, l.project, l.library].into_iter().flatten().chain(l.folders.iter().map(|(_, m)| *m)) {
        for k in m.get("fields").and_then(Value::as_object).into_iter().flatten().map(|(k, _)| k.clone()) {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    for k in l.detected_item.get("fields").and_then(Value::as_object).into_iter().chain(l.detected_project.get("fields").and_then(Value::as_object)).flatten() {
        if !keys.contains(k.0) {
            keys.push(k.0.clone());
        }
    }
    if !keys.is_empty() {
        let mut fields = Map::new();
        let mut ffrom = Map::new();
        for k in keys {
            let get = |m: Option<&Map<String, Value>>| m.and_then(|m| m.get("fields")).and_then(|f| f.get(&k)).filter(|v| !v.is_null()).cloned();
            let found = get(l.item)
                .map(|v| (v, json!("item")))
                .or_else(|| l.folders.iter().find_map(|(p, m)| get(Some(m)).map(|v| (v, json!(format!("folder:{p}"))))))
                .or_else(|| get(l.project).map(|v| (v, json!("project"))))
                .or_else(|| get(Some(l.detected_item)).map(|v| (v, json!("detected"))))
                .or_else(|| get(Some(l.detected_project)).map(|v| (v, json!("detected"))))
                .or_else(|| get(l.library).map(|v| (v, json!("library"))));
            if let Some((v, src)) = found {
                fields.insert(k.clone(), v);
                ffrom.insert(k, src);
            }
        }
        values.insert("fields".into(), Value::Object(fields));
        from.insert("fields".into(), Value::Object(ffrom));
    }
    (values, from)
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty() || o.get("spdx").and_then(Value::as_str) == Some("NOASSERTION") && o.len() <= 2,
        _ => false,
    }
}

/// Apply a patch to one level's edits ({field: value}, null removes). Returns the
/// previous values of the patched fields (null where there was none), for undo.
pub fn patch_level(level: &mut Map<String, Value>, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut previous = Map::new();
    for (k, v) in patch {
        if k == "fields" {
            let prev_fields = level.get("fields").cloned().unwrap_or(json!({}));
            let mut fields = prev_fields.as_object().cloned().unwrap_or_default();
            let mut prev = Map::new();
            for (fk, fv) in v.as_object().into_iter().flatten() {
                prev.insert(fk.clone(), fields.get(fk).cloned().unwrap_or(Value::Null));
                if fv.is_null() {
                    fields.shift_remove(fk);
                } else {
                    fields.insert(fk.clone(), fv.clone());
                }
            }
            previous.insert("fields".into(), Value::Object(prev));
            if fields.is_empty() {
                level.shift_remove("fields");
            } else {
                level.insert("fields".into(), Value::Object(fields));
            }
            continue;
        }
        if !is_field(k) {
            continue;
        }
        previous.insert(k.clone(), level.get(k).cloned().unwrap_or(Value::Null));
        if v.is_null() {
            level.shift_remove(k);
        } else {
            level.insert(k.clone(), normalise(k, v));
        }
    }
    previous
}

/// Where in metadata.json a level lives: ("project", None), ("folders", Some(path)),
/// ("items", Some(model id)) or ("parts", Some(part id)).
pub fn level_mut<'a>(meta: &'a mut Value, section: &str, key: Option<&str>) -> &'a mut Map<String, Value> {
    if !meta.is_object() {
        *meta = json!({});
    }
    let obj = meta.as_object_mut().unwrap();
    match key {
        None => {
            let e = obj.entry(section.to_string()).or_insert_with(|| json!({}));
            if !e.is_object() {
                *e = json!({});
            }
            e.as_object_mut().unwrap()
        }
        Some(k) => {
            let sec = obj.entry(section.to_string()).or_insert_with(|| json!({}));
            if !sec.is_object() {
                *sec = json!({});
            }
            let e = sec.as_object_mut().unwrap().entry(k.to_string()).or_insert_with(|| json!({}));
            if !e.is_object() {
                *e = json!({});
            }
            e.as_object_mut().unwrap()
        }
    }
}

/// Drop empty levels so metadata.json stays small (and is removed when nothing is left).
pub fn prune(meta: &mut Value) {
    let Some(obj) = meta.as_object_mut() else { return };
    for section in ["folders", "items", "parts"] {
        if let Some(Value::Object(m)) = obj.get_mut(section) {
            m.retain(|_, v| v.as_object().is_some_and(|o| !o.is_empty()));
        }
    }
    obj.retain(|_, v| !v.as_object().is_some_and(Map::is_empty));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn precedence() {
        let meta = json!({
            "project": { "license": "CC-BY-4.0", "tags": ["box"] },
            "folders": { "lids": { "tags": ["lids"] }, "lids/round": { "category": "carrying" } },
            "items": { "x": { "license": "MIT", "name": "Mine" } }
        });
        let di = m(json!({ "name": "Detected name" }));
        let dp = m(json!({ "license": { "spdx": "GPL-3.0", "public_use": "ok" }, "summary": "From README", "category": "other" }));
        let lib = m(json!({ "authors": [{ "name": "Me" }] }));
        let project = meta["project"].as_object();
        // item with its own license
        let (v, f) = resolve(&Layers { item: meta["items"]["x"].as_object(), folders: folder_chain(&meta, "lids/round"), project, detected_item: &di, detected_project: &dp, library: Some(&lib) });
        assert_eq!(v["license"]["spdx"], "MIT");
        assert_eq!(f["license"], "item");
        assert_eq!(v["name"], "Mine");
        assert_eq!(v["tags"], json!(["lids"]));
        assert_eq!(f["tags"], "folder:lids");
        assert_eq!(v["category"], "carrying");
        assert_eq!(f["category"], "folder:lids/round");
        assert_eq!(v["summary"], "From README");
        assert_eq!(f["summary"], "detected");
        assert_eq!(v["authors"], json!([{ "name": "Me" }]));
        assert_eq!(f["authors"], "library");
        // another item takes the project's license over the detected one
        let (v, f) = resolve(&Layers { item: None, folders: vec![], project, detected_item: &di, detected_project: &dp, library: None });
        assert_eq!(v["license"], json!({ "spdx": "CC-BY-4.0", "public_use": "ok" }));
        assert_eq!(f["license"], "project");
        assert_eq!(v["name"], "Detected name");
    }

    #[test]
    fn patches_undo() {
        let mut meta = json!({});
        let lvl = level_mut(&mut meta, "project", None);
        let prev = patch_level(lvl, &m(json!({ "license": "CC-BY-NC-4.0", "fields": { "material": "PETG" } })));
        assert_eq!(prev["license"], Value::Null);
        assert_eq!(meta["project"]["license"]["public_use"], "review");
        let lvl = level_mut(&mut meta, "project", None);
        let undo = patch_level(lvl, &prev);
        assert_eq!(undo["license"]["spdx"], "CC-BY-NC-4.0");
        prune(&mut meta);
        assert_eq!(meta, json!({}));
    }
}
