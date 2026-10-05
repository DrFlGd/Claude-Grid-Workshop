//! Turning a project in the library into model pages ("reading" it): its models'
//! files, settings (OpenSCAD's own export, run natively) and metadata, saved as
//! sources/<id>/derived/<version>.json. Also packaging the website build's
//! catalog as starter-library projects that ship with the app.

use crate::ingest;
use crate::library::{self, slug, Library};
use crate::render::{RenderRequest, Renderer};
use crate::scan::{self, LibraryDir};
use crate::sitebuild;
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Version of the derived-data format (bump to re-read every project).
pub const DERIVED_FORMAT: u64 = 1;

/// A library project that others can include from.
#[derive(Clone, Debug)]
pub struct LibrarySource {
    pub dir: LibraryDir,
    pub source: String,
    pub version: String,
}

/// The library projects (role "library") in a library, at their current versions.
pub fn library_sources(lib: &Library) -> Vec<LibrarySource> {
    let mut out = vec![];
    for id in lib.source_ids() {
        let Ok(src) = lib.source(&id) else { continue };
        if src["role"] != "library" {
            continue;
        }
        let version = src["version"].as_str().unwrap_or("").to_string();
        let Ok(path) = lib.version_dir(&src, &version) else { continue };
        let name = src["library_name"]
            .as_str()
            .map(String::from)
            .or_else(|| src["origin"]["repo"].as_str().map(String::from))
            .unwrap_or_else(|| src["detected"]["name"].as_str().unwrap_or(&id).to_string());
        out.push(LibrarySource { dir: LibraryDir { name, path }, source: id, version });
    }
    out
}

fn sha_file(p: &Path) -> Result<String> {
    Ok(hex::encode(Sha256::digest(std::fs::read(p).with_context(|| format!("couldn't read {}", p.display()))?)))
}

/// Model id from an entry path: "box.scad" -> "box", "examples/My Box.scad" -> "examples-my-box".
pub fn model_id(entry: &str) -> String {
    let no_ext = entry.rsplit_once('.').map(|(a, _)| a).unwrap_or(entry);
    let id = slug(no_ext);
    if id.is_empty() { "model".into() } else { id }
}

/// Read a project at one version. Returns the derived data (also saved in the library).
pub async fn ingest(
    lib: &Library,
    renderer: &Arc<Renderer>,
    common_files: &BTreeMap<String, String>,
    src: &Value,
    version: &str,
    on_progress: impl Fn(String),
) -> Result<Value> {
    let id = src["id"].as_str().context("project has no id")?.to_string();
    let root = lib.version_dir(src, version)?;
    if !root.is_dir() {
        bail!("The files for {id} aren't there ({}).", root.display());
    }
    on_progress("Looking through the files…".into());
    let found = {
        let root = root.clone();
        tokio::task::spawn_blocking(move || scan::survey(&root)).await?
    };
    let det = &src["detected"];
    let role = src["role"].as_str().unwrap_or("project");
    let entries: Vec<String> = if role == "library" { vec![] } else { found.entries.clone() };
    let words = format!(
        "{} {} {} {}",
        det["name"].as_str().unwrap_or(""),
        det["summary"].as_str().unwrap_or(""),
        det["tags"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        entries.join(" ")
    );
    let category = if role == "library" { "libraries" } else { scan::guess_category(&words) };
    let origin_url = det["origin"].as_str().or(src["origin"]["url"].as_str());
    let mut source_info = Map::new();
    if let Some(u) = origin_url {
        source_info.insert("repository".into(), json!(u));
    }
    if src["kind"] == "github" {
        let v = src["versions"].as_array().into_iter().flatten().find(|v| v["id"] == version);
        if let Some(v) = v {
            source_info.insert("commit".into(), v["commit"].clone());
            source_info.insert("commit_date".into(), v["date"].clone());
        }
    } else {
        source_info.insert("supplied_by".into(), json!(format!("added {}", src["version_date"].as_str().unwrap_or(""))));
    }
    let mut fam = json!({
        "id": id, "name": det["name"], "status": "available", "category": category,
        "category_label": category_label(category),
        "summary": det["summary"].as_str().unwrap_or(""), "tags": det["tags"].clone(),
        "license": det["license"].clone(), "authors": det["authors"].clone(),
        "links": origin_url.map(|u| json!({ "source": u })).unwrap_or(json!({})),
        "source": Value::Object(source_info),
        "models": [],
    });
    let editor_cfg = match &found.editor_toml {
        Some(p) => ingest::load_editor_toml(&root.join(p)).unwrap_or(json!({})),
        None => json!({}),
    };
    let libs = library_sources(lib).into_iter().filter(|l| l.source != id).collect::<Vec<_>>();
    let lib_dirs: Vec<LibraryDir> = libs.iter().map(|l| l.dir.clone()).collect();
    let mut problems: Vec<Value> = found.problems.iter().map(|p| json!({ "kind": "scan", "message": p })).collect();
    let mut blobs: BTreeMap<String, String> = BTreeMap::new();
    let mut renderable: Vec<(String, PathBuf)> = vec![];
    let mut used_ids: Vec<String> = vec![];
    let mut planned = vec![];
    for entry in &entries {
        let mut mid = model_id(entry);
        let base = mid.clone();
        let mut n = 2;
        while used_ids.contains(&mid) {
            mid = format!("{base}-{n}");
            n += 1;
        }
        used_ids.push(mid.clone());
        let resolver = scan::resolver(&root, &lib_dirs);
        let (files, missing) = resolver.collect(entry);
        let mut fmap = BTreeMap::new();
        let mut input_bytes = 0u64;
        for (vpath, (host, which)) in &files {
            let sha = sha_file(host)?;
            input_bytes += std::fs::metadata(host).map(|m| m.len()).unwrap_or(0);
            let (owner, base) = match which {
                Some(i) => (format!("{}@{}", libs[*i].source, libs[*i].version), libs[*i].dir.path.clone()),
                None => (format!("{id}@{version}"), root.clone()),
            };
            let rel = host.strip_prefix(&base).map(|r| r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")).unwrap_or_default();
            blobs.insert(sha.clone(), format!("{owner}:{rel}"));
            renderable.push((sha.clone(), host.clone()));
            fmap.insert(vpath.clone(), sha);
        }
        if !missing.is_empty() {
            problems.push(json!({
                "kind": "missing", "model": format!("{id}/{mid}"), "files": missing,
                "message": format!("{} can't find {}", entry, missing.iter().map(|m| m.trim_start_matches("/libraries/")).collect::<Vec<_>>().join(", ")),
            }));
        }
        let stem = Path::new(entry).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let model = json!({
            "id": mid, "name": scan::humanize(&stem), "entrypoint": entry, "status": "available",
            "presets": scan::presets_for(&root, entry),
        });
        let editor = ingest::editor_model_meta(&editor_cfg, Path::new(entry).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default().as_str());
        planned.push((mid, model, fmap, editor, input_bytes, entry.clone()));
    }
    renderer.add_blobs(renderable);
    // settings: several OpenSCAD processes at once (the renderer limits how many)
    let mut set = tokio::task::JoinSet::new();
    for (i, (mid, _, fmap, _, _, entry)) in planned.iter().enumerate() {
        let mut files = common_files.clone();
        files.extend(fmap.clone());
        let req = RenderRequest { model: format!("{id}/{mid}"), entry: format!("/{entry}"), files, values: Default::default(), defines: vec![] };
        let r = renderer.clone();
        set.spawn(async move { (i, r.export_params(&req).await) });
    }
    let total = planned.len();
    let mut raws: Vec<Option<Result<Value, String>>> = vec![None; total];
    let mut done = 0;
    while let Some(res) = set.join_next().await {
        let (i, r) = res?;
        done += 1;
        on_progress(format!("Reading settings: {done} of {total}"));
        raws[i] = Some(r.map_err(|e| {
            let tail: Vec<&String> = e.logs.iter().filter(|l| l.starts_with("ERROR") || l.starts_with("WARNING")).take(5).collect();
            format!("{}{}", e.message, if tail.is_empty() { String::new() } else { format!(" ({})", tail.into_iter().cloned().collect::<Vec<_>>().join("; ")) })
        }));
    }
    let mut models = vec![];
    for ((mid, model, fmap, editor, input_bytes, entry), raw) in planned.into_iter().zip(raws) {
        let key = format!("{id}/{mid}");
        match raw.unwrap_or_else(|| Err("not read".into())) {
            Ok(raw) => {
                fam["models"].as_array_mut().unwrap().push(model.clone());
                let (_, mut detail) = sitebuild::assemble_model(&fam, &model, &key, &format!("/{entry}"), &fmap, &editor, &raw, input_bytes)?;
                detail["folder"] = json!(ingest::dirname(&format!("/{entry}")).trim_start_matches('/'));
                models.push(detail);
            }
            Err(e) => problems.push(json!({ "kind": "settings", "model": key, "message": format!("{entry}: {e}") })),
        }
    }
    let derived = json!({
        "format": DERIVED_FORMAT,
        "engine": renderer.engine().version,
        "made": library::now(),
        "source": id, "version": version,
        "family": fam,
        "models": models,
        "parts": found.parts,
        "blobs": blobs,
        "problems": problems,
        "stats": { "scad_files": found.scad_files, "library_files": found.library_files, "entries": found.entries.len() },
        "readme": found.readme.as_ref().map(|(p, _)| p.clone()),
        "license_file": found.license.as_ref().map(|(p, _)| p.clone()),
        "editor_toml": found.editor_toml,
    });
    lib.save_derived(&id, version, &derived)?;
    Ok(derived)
}

pub fn category_label(id: &str) -> String {
    scan::EXTRA_CATEGORIES
        .iter()
        .find(|(c, _)| *c == id)
        .map(|(_, l)| l.to_string())
        .unwrap_or_else(|| sitebuild::category_label(id))
}

/// Where a blob entry ("<source>@<version>:<path>") is on disk.
pub fn blob_path(lib: &Library, entry: &str) -> Option<PathBuf> {
    let (owner, rel) = entry.split_once(':')?;
    let (source, version) = owner.split_once('@')?;
    let src = lib.source(source).ok()?;
    let dir = lib.version_dir(&src, version).ok()?;
    let p = dir.join(library::rel_inside(rel).ok()?);
    Some(p)
}

// ------------------------------------------------------------------ starter library

/// Package a built site's catalog (tools/build_site.py output, with thumbnails)
/// as library projects in `out/sources/`: one per family and one per parts pack.
/// Projects whose content didn't change keep their version id between builds.
pub fn bundle_site(site: &Path, out: &Path) -> Result<Vec<String>> {
    let catalog: Value = serde_json::from_slice(&std::fs::read(site.join("data/catalog.json"))?)?;
    let made = library::now();
    let sources = out.join("sources");
    std::fs::create_dir_all(&sources)?;
    let mut ids = vec![];
    for fam in catalog["families"].as_array().into_iter().flatten() {
        let id = fam["id"].as_str().context("family without id")?.to_string();
        let keys: Vec<String> = catalog["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["family"] == id.as_str())
            .filter_map(|m| m["key"].as_str().map(String::from))
            .collect();
        if keys.is_empty() {
            continue;
        }
        let mut details = vec![];
        for k in &keys {
            let d: Value = serde_json::from_slice(&std::fs::read(site.join("data/models").join(format!("{}.json", k.replace('/', "--"))))?)?;
            details.push(d);
        }
        let mut h = Sha256::new();
        for d in &details {
            h.update(serde_json::to_vec(d)?);
        }
        let version = format!("bundle-{}", &hex::encode(h.finalize())[..12]);
        let dir = sources.join(&id);
        let files = dir.join("files").join(&version);
        let mut blobs = BTreeMap::new();
        for d in &details {
            for (vpath, sha) in d["files"].as_object().into_iter().flatten() {
                let sha = sha.as_str().unwrap_or("");
                let rel = library::rel_inside(vpath)?;
                let dst = files.join(&rel);
                if !dst.exists() {
                    std::fs::create_dir_all(dst.parent().unwrap())?;
                    std::fs::copy(site.join("fs").join(sha), &dst).with_context(|| format!("copying {vpath}"))?;
                }
                blobs.insert(sha.to_string(), format!("{id}@{version}:{}", vpath.trim_start_matches('/')));
            }
        }
        let first = &details[0];
        let mut thumbs_made = 0;
        for d in &details {
            let k = d["key"].as_str().unwrap_or("");
            let t = site.join("thumbs/gen").join(format!("{}.webp", k.replace('/', "--")));
            if t.is_file() {
                std::fs::create_dir_all(dir.join("thumbs"))?;
                std::fs::copy(&t, dir.join("thumbs").join(format!("{}.webp", d["id"].as_str().unwrap_or(""))))?;
                thumbs_made += 1;
            }
        }
        let updated = first["updated"].as_str().map(String::from);
        let origin_url = fam["source"].as_str().map(String::from).or_else(|| first["source"]["repository"].as_str().map(String::from));
        let family = json!({
            "id": id, "name": fam["name"], "status": "available", "category": first["category"],
            "category_label": first["category_label"], "summary": first["summary"], "tags": first["tags"],
            "license": fam["license"], "authors": fam["authors"], "links": first["links"], "source": first["source"],
            "models": details.iter().map(|d| json!({ "id": d["id"], "name": d["name"] })).collect::<Vec<_>>(),
        });
        let derived = json!({
            "format": DERIVED_FORMAT, "engine": catalog["engine"], "made": made, "source": id, "version": version,
            "family": family, "models": details, "parts": [], "blobs": blobs, "problems": [],
            "stats": { "thumbnails": thumbs_made },
        });
        crate::config::write_atomic(&dir.join("derived").join(format!("{version}.json")), &serde_json::to_vec(&derived)?)?;
        let src = json!({
            "id": id, "kind": "bundled", "role": "project", "added": made,
            "origin": { "bundle": "scad-workshop", "url": origin_url },
            "version": version, "version_date": updated.clone().unwrap_or_else(|| made.clone()),
            "versions": [{ "id": version, "date": updated, "added": made }],
            "detected": {
                "name": fam["name"], "summary": first["summary"], "license": fam["license"], "authors": fam["authors"],
                "tags": first["tags"], "origin": origin_url, "category": first["category"],
            },
        });
        crate::config::write_json(&dir.join("source.json"), &src)?;
        ids.push(id);
    }
    for l in catalog["libraries"].as_array().into_iter().flatten() {
        let id = l["id"].as_str().context("library without id")?.to_string();
        let detail: Value = serde_json::from_slice(&std::fs::read(site.join("data/libraries").join(format!("{id}.json")))?)?;
        let mut h = Sha256::new();
        h.update(serde_json::to_vec(&detail)?);
        let version = format!("bundle-{}", &hex::encode(h.finalize())[..12]);
        let dir = sources.join(&id);
        let files = dir.join("files").join(&version);
        let mut parts = vec![];
        for it in detail["items"].as_array().into_iter().flatten() {
            let item_id = it["id"].as_str().unwrap_or("").to_string();
            let mut it = it.clone();
            for f in it["files"].as_array_mut().into_iter().flatten() {
                let path = f["path"].as_str().unwrap_or("").to_string();
                let dst = files.join(library::rel_inside(&path)?);
                if !dst.exists() {
                    std::fs::create_dir_all(dst.parent().unwrap())?;
                    std::fs::copy(site.join("parts").join(&id).join(&path), &dst).with_context(|| format!("copying {path}"))?;
                }
                f.as_object_mut().unwrap().shift_remove("url");
            }
            if let Some(pv) = it["preview_url"].as_str().map(String::from) {
                let src_pv = site.join(&pv);
                if pv.contains("/_preview/") && src_pv.is_file() {
                    std::fs::create_dir_all(dir.join("previews"))?;
                    std::fs::copy(&src_pv, dir.join("previews").join(format!("{item_id}.stl")))?;
                    it["preview_stl"] = json!(format!("previews/{item_id}.stl"));
                }
            }
            it.as_object_mut().unwrap().shift_remove("preview_url");
            it.as_object_mut().unwrap().shift_remove("thumb");
            let t = site.join("thumbs/part").join(format!("{id}--{item_id}.webp"));
            if t.is_file() {
                std::fs::create_dir_all(dir.join("thumbs"))?;
                std::fs::copy(&t, dir.join("thumbs").join(format!("part-{item_id}.webp")))?;
            }
            parts.push(it);
        }
        let family = json!({
            "id": id, "name": detail["name"], "status": "available", "category": "parts",
            "summary": detail["summary"], "tags": [], "license": detail["license"], "authors": detail["authors"],
            "links": detail["source_url"].as_str().map(|u| json!({ "source": u })).unwrap_or(json!({})),
            "source": { "repository": detail["source_url"] }, "models": [],
        });
        let derived = json!({
            "format": DERIVED_FORMAT, "engine": catalog["engine"], "made": made, "source": id, "version": version,
            "family": family, "models": [], "parts": parts, "blobs": {}, "problems": [],
            "notes": detail["notes"],
        });
        crate::config::write_atomic(&dir.join("derived").join(format!("{version}.json")), &serde_json::to_vec(&derived)?)?;
        let src = json!({
            "id": id, "kind": "bundled", "role": "project", "added": made,
            "origin": { "bundle": "scad-workshop", "url": detail["source_url"] },
            "version": version, "version_date": made, "versions": [{ "id": version, "date": made, "added": made }],
            "detected": {
                "name": detail["name"], "summary": detail["summary"], "license": detail["license"], "authors": detail["authors"],
                "tags": [], "origin": detail["source_url"],
            },
        });
        crate::config::write_json(&dir.join("source.json"), &src)?;
        ids.push(id);
    }
    crate::config::write_json(&out.join("starter.json"), &json!({ "made": made, "engine": catalog["engine"], "sources": ids }))?;
    Ok(ids)
}

/// Copy starter projects into a library: new ones are installed (unless the user
/// removed them before), changed ones arrive as an update to accept.
/// Returns (installed, updates offered).
pub fn sync_starter(lib: &Library, starter: &Path) -> Result<(Vec<String>, Vec<String>)> {
    if lib.read_only().is_some() || !starter.join("starter.json").is_file() {
        return Ok((vec![], vec![]));
    }
    let removed: Vec<String> = lib.meta()["removed_starter"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    let (mut installed, mut updates) = (vec![], vec![]);
    let dir = starter.join("sources");
    let mut ids: Vec<String> = std::fs::read_dir(&dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(String::from)).collect()).unwrap_or_default();
    ids.sort();
    for id in ids {
        let Ok(bundled) = serde_json::from_slice::<Value>(&std::fs::read(dir.join(&id).join("source.json")).unwrap_or_default()) else { continue };
        let version = bundled["version"].as_str().unwrap_or("").to_string();
        match lib.source(&id) {
            Err(_) => {
                if removed.contains(&id) || lib.source_dir(&id)?.exists() {
                    continue;
                }
                copy_tree(&dir.join(&id), &lib.source_dir(&id)?)?;
                installed.push(id);
            }
            Ok(mut have) => {
                if have["kind"] != "bundled" || have["version"] == version.as_str() || have["update"]["latest"]["id"] == version.as_str() {
                    continue;
                }
                // bring the new version in beside the current one; the user accepts it like any update
                let target = lib.source_dir(&id)?;
                copy_tree(&dir.join(&id).join("files").join(&version), &target.join("files").join(&version))?;
                copy_tree(&dir.join(&id).join("derived"), &target.join("derived"))?;
                for extra in ["thumbs", "previews"] {
                    if dir.join(&id).join(extra).is_dir() {
                        copy_tree(&dir.join(&id).join(extra), &target.join(extra))?;
                    }
                }
                have["update"] = json!({
                    "state": "available", "checked": library::now(), "from": "app",
                    "latest": { "id": version, "date": bundled["version_date"], "message": "Updated with the app" },
                });
                lib.save_source(&have)?;
                updates.push(id);
            }
        }
    }
    Ok((installed, updates))
}

/// Copy a folder tree (files overwrite).
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    for f in scan::list_files(from) {
        let dst = to.join(&f.rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from.join(&f.rel), &dst).with_context(|| format!("couldn't copy {}", f.rel))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids() {
        assert_eq!(model_id("box.scad"), "box");
        assert_eq!(model_id("examples/My Box.scad"), "examples-my-box");
    }
}
