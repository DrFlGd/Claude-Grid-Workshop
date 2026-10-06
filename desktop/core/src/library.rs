//! The library folder: everything the user adds, makes or edits, as plain files
//! with relative paths, so it can be moved, copied, synced or kept in git, and
//! opened by any build of the app (docs/DESKTOP_PLAN.md, "Library folder").
//!
//! ```text
//! library/
//!   library.json                  format, id, name, favourites, library-level metadata, categories
//!   sources/<id>/source.json      where a project came from, what was detected, versions, updates
//!   sources/<id>/metadata.json    the user's edits (project, folder and item level)
//!   sources/<id>/files/<version>/ downloaded or extracted files, untouched
//!   sources/<id>/derived/<v>.json what ingest found (models, parts, problems); rebuildable
//!   sources/<id>/thumbs/          thumbnails; rebuildable
//!   local/<project>/              the user's own projects, edited in place
//!   collections/                  (Phase 4)
//!   recipes/<id>.json             saved settings
//! ```
//!
//! No database lives here: the app's search index and render cache are on the computer.

use crate::config::{read_json_object, write_json, Prefs};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};

/// The library format this build writes. A library with a higher number opens read-only.
pub const FORMAT: u64 = 1;

const SUBDIRS: [&str; 4] = ["sources", "local", "collections", "recipes"];

const README: &str = "SCAD Workshop library\n\
\n\
This folder is a library for the SCAD Workshop desktop app: projects you added,\n\
your own projects, saved settings and all your edits. Move it, copy it, sync it\n\
or keep it in git, then use \"Open library...\" in the app to use it anywhere.\n\
\n\
  library.json    name, favourites and library-wide settings\n\
  sources/        one folder per project: source.json (where it came from),\n\
                  metadata.json (your edits), files/ (the project's files, untouched)\n\
  local/          your own projects: put .scad or model files in a folder here\n\
  recipes/        saved settings\n\
\n\
The app's render cache and search index are kept on each computer, not here.\n";

#[derive(Clone, Debug)]
pub struct Library {
    root: PathBuf,
    /// Made by a newer app (format above [`FORMAT`]): nothing is written.
    read_only: Option<String>,
}

/// What opening a Phase 1 workspace moved.
#[derive(Debug, Default)]
pub struct Migration {
    pub recipes: usize,
    pub prefs_moved: bool,
    pub cache_removed: bool,
}

pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 96 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') || id.starts_with('.') {
        bail!("invalid id {id}");
    }
    Ok(())
}

/// A library-relative path ("sources/x/files/abc/a.scad") that stays inside the library.
pub fn rel_inside(rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel.trim_start_matches('/'));
    if rel.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("invalid library path {rel}");
    }
    Ok(p.to_path_buf())
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    iso_from_unix(secs as i64)
}

/// "2026-10-05T09:48:26Z" from seconds since 1970.
pub fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now() -> String {
    now_iso()
}

fn random_id(prefix: &str) -> String {
    use sha2::{Digest, Sha256};
    let seed = format!("{:?}{}{:?}", std::time::SystemTime::now(), std::process::id(), std::thread::current().id());
    format!("{prefix}{}", &hex::encode(Sha256::digest(seed.as_bytes()))[..16])
}

impl Library {
    /// Open a library folder, creating it if needed and upgrading a Phase 1
    /// workspace (saved settings -> recipes/, preferences -> the app, cache removed).
    pub fn open(root: impl Into<PathBuf>, app_prefs: &Prefs) -> Result<(Self, Migration)> {
        let root = root.into();
        std::fs::create_dir_all(&root).with_context(|| format!("couldn't create {}", root.display()))?;
        let meta_path = root.join("library.json");
        let mut migration = Migration::default();
        if meta_path.is_file() {
            let meta = read_json_object(&meta_path);
            let format = meta["format"].as_u64().unwrap_or(0);
            if format > FORMAT {
                let msg = format!(
                    "This library was made by a newer version of SCAD Workshop (library format {format}; this version reads up to {FORMAT}). \
                     It's open read-only: update the app to change it."
                );
                return Ok((Self { root, read_only: Some(msg) }, migration));
            }
        }
        let lib = Self { root, read_only: None };
        for d in SUBDIRS {
            let p = lib.root.join(d);
            std::fs::create_dir_all(&p).with_context(|| format!("couldn't create {}", p.display()))?;
        }
        if !meta_path.is_file() {
            migration = lib.migrate_workspace(app_prefs)?;
            let name = lib.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Library".into());
            write_json(
                &meta_path,
                &json!({ "format": FORMAT, "id": random_id("lib-"), "name": name, "created": now_iso(), "favourites": migration_favs(&lib) }),
            )?;
            let _ = std::fs::remove_file(lib.root.join(".favourites-migrated.json"));
        }
        let readme = lib.root.join("README.txt");
        let old_readme = std::fs::read_to_string(&readme).ok();
        if old_readme.as_deref().is_none_or(|t| t.starts_with("SCAD Workshop workspace") || t.starts_with("Claude Grid Workshop workspace")) {
            let _ = std::fs::write(&readme, README);
        }
        Ok((lib, migration))
    }

    /// Phase 1 kept saved settings in settings/saved, preferences in settings/prefs.json
    /// and the render cache in cache/.
    fn migrate_workspace(&self, app_prefs: &Prefs) -> Result<Migration> {
        let mut m = Migration::default();
        let saved = self.root.join("settings/saved");
        if saved.is_dir() {
            for e in std::fs::read_dir(&saved)?.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "json") {
                    let dst = self.root.join("recipes").join(p.file_name().unwrap());
                    if !dst.exists() {
                        std::fs::rename(&p, &dst).or_else(|_| std::fs::copy(&p, &dst).map(|_| ()))?;
                        m.recipes += 1;
                    }
                }
            }
            let _ = std::fs::remove_dir(&saved);
        }
        let old_prefs = self.root.join("settings/prefs.json");
        if old_prefs.is_file() {
            let mut prefs = read_json_object(&old_prefs);
            let favs = prefs.as_object_mut().and_then(|o| o.shift_remove("gw-favs")).unwrap_or(json!([]));
            // favourites go with the library; everything else (printer profile, view) stays with the app
            std::fs::write(self.root.join(".favourites-migrated.json"), serde_json::to_vec(&favs)?)?;
            let mut app = app_prefs.get();
            for (k, v) in prefs.as_object().into_iter().flatten() {
                if app.get(k).is_none() {
                    app[k] = v.clone();
                }
            }
            app_prefs.set(&app)?;
            std::fs::remove_file(&old_prefs)?;
            m.prefs_moved = true;
        }
        let _ = std::fs::remove_dir(self.root.join("settings"));
        let _ = std::fs::remove_dir(self.root.join("libraries"));
        let cache = self.root.join("cache");
        if cache.is_dir() && std::fs::remove_dir_all(&cache).is_ok() {
            m.cache_removed = true;
        }
        Ok(m)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn read_only(&self) -> Option<&str> {
        self.read_only.as_deref()
    }

    pub fn writable(&self) -> Result<()> {
        match &self.read_only {
            Some(msg) => bail!("{msg}"),
            None => Ok(()),
        }
    }

    pub fn meta(&self) -> Value {
        read_json_object(&self.root.join("library.json"))
    }

    /// Merge `patch` into library.json (top-level keys).
    pub fn update_meta(&self, patch: Value) -> Result<Value> {
        self.writable()?;
        let mut meta = self.meta();
        for (k, v) in patch.as_object().into_iter().flatten() {
            if k == "format" || k == "id" {
                continue;
            }
            if v.is_null() {
                meta.as_object_mut().unwrap().shift_remove(k);
            } else {
                meta[k] = v.clone();
            }
        }
        write_json(&self.root.join("library.json"), &meta)?;
        Ok(meta)
    }

    pub fn info(&self) -> Value {
        let meta = self.meta();
        json!({
            "path": self.root.display().to_string(),
            "id": meta["id"], "name": meta["name"], "format": meta["format"],
            "read_only": self.read_only,
        })
    }

    // ------------------------------------------------------------ favourites

    pub fn favourites(&self) -> Value {
        match self.meta().get("favourites") {
            Some(v @ Value::Array(_)) => v.clone(),
            _ => json!([]),
        }
    }

    pub fn set_favourites(&self, favs: &Value) -> Result<()> {
        if !favs.is_array() {
            bail!("favourites must be a list");
        }
        if &self.favourites() == favs {
            return Ok(());
        }
        self.update_meta(json!({ "favourites": favs }))?;
        Ok(())
    }

    // ------------------------------------------------------------ recipes (saved settings)

    fn recipes_dir(&self) -> PathBuf {
        self.root.join("recipes")
    }

    /// Saved settings for one model, sorted by name.
    pub fn recipes(&self, model: &str) -> Result<Vec<Value>> {
        let dir = self.recipes_dir();
        let mut out: Vec<Value> = std::fs::read_dir(&dir)
            .with_context(|| format!("couldn't read {}", dir.display()))?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
            .filter(|v| v["model"].as_str() == Some(model))
            .collect();
        out.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_lowercase());
        Ok(out)
    }

    /// Every saved setting (for "More from" lists and the inspector).
    pub fn all_recipes(&self) -> Vec<Value> {
        std::fs::read_dir(self.recipes_dir())
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                    .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn recipe(&self, id: &str) -> Result<Option<Value>> {
        valid_id(id)?;
        let p = self.recipes_dir().join(format!("{id}.json"));
        if !p.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&std::fs::read(p)?)?))
    }

    /// Store a complete record (must have "id" and "model").
    pub fn put_recipe(&self, rec: &Value) -> Result<()> {
        self.writable()?;
        let id = rec["id"].as_str().context("record has no id")?;
        valid_id(id)?;
        if rec["model"].as_str().is_none() {
            bail!("record has no model");
        }
        write_json(&self.recipes_dir().join(format!("{id}.json")), rec)
    }

    pub fn remove_recipe(&self, id: &str) -> Result<()> {
        self.writable()?;
        valid_id(id)?;
        let p = self.recipes_dir().join(format!("{id}.json"));
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ sources

    pub fn sources_dir(&self) -> PathBuf {
        self.root.join("sources")
    }

    pub fn source_dir(&self, id: &str) -> Result<PathBuf> {
        valid_id(id)?;
        Ok(self.sources_dir().join(id))
    }

    /// Ids of every project in the library, sorted.
    pub fn source_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = std::fs::read_dir(self.sources_dir())
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().join("source.json").is_file())
                    .filter_map(|e| e.file_name().to_str().map(String::from))
                    .filter(|id| valid_id(id).is_ok())
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }

    pub fn source(&self, id: &str) -> Result<Value> {
        let p = self.source_dir(id)?.join("source.json");
        let v: Value = serde_json::from_slice(&std::fs::read(&p).with_context(|| format!("no project {id}"))?)
            .with_context(|| format!("{} isn't valid JSON", p.display()))?;
        Ok(v)
    }

    pub fn save_source(&self, src: &Value) -> Result<()> {
        self.writable()?;
        let id = src["id"].as_str().context("project has no id")?;
        write_json(&self.source_dir(id)?.join("source.json"), src)
    }

    /// A new, unused project id based on `base` ("github-belfryscad-bosl2", "-2", ...).
    pub fn new_source_id(&self, base: &str) -> String {
        let base = slug(base);
        let base = if base.is_empty() { "project".to_string() } else { base };
        let mut id = base.clone();
        let mut n = 2;
        while self.sources_dir().join(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    /// Where a project's files are on disk for one version.
    pub fn version_dir(&self, src: &Value, version: &str) -> Result<PathBuf> {
        let id = src["id"].as_str().context("project has no id")?;
        match src["kind"].as_str() {
            Some("local") => Ok(self.root.join(rel_inside(src["origin"]["path"].as_str().context("local project has no path")?)?)),
            Some("linked") => Ok(PathBuf::from(src["origin"]["path"].as_str().context("linked project has no path")?)),
            Some("pinned") => Ok(self.source_dir(id)?.join("pins")),
            _ => {
                valid_id(version)?;
                Ok(self.source_dir(id)?.join("files").join(version))
            }
        }
    }

    /// The library-relative form of a path inside the library (None if outside).
    pub fn relative(&self, p: &Path) -> Option<String> {
        let rel = p.strip_prefix(&self.root).ok()?;
        Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
    }

    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        Ok(self.root.join(rel_inside(rel)?))
    }

    pub fn derived(&self, id: &str, version: &str) -> Option<Value> {
        valid_id(version).ok()?;
        let p = self.source_dir(id).ok()?.join("derived").join(format!("{version}.json"));
        serde_json::from_slice(&std::fs::read(p).ok()?).ok()
    }

    pub fn save_derived(&self, id: &str, version: &str, v: &Value) -> Result<()> {
        self.writable()?;
        valid_id(version)?;
        let mut bytes = serde_json::to_vec(v)?;
        bytes.push(b'\n');
        crate::config::write_atomic(&self.source_dir(id)?.join("derived").join(format!("{version}.json")), &bytes)
    }

    // ------------------------------------------------------------ metadata (the user's edits)

    /// A project's edits file: sources/<id>/metadata.json.
    pub fn metadata_path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.source_dir(id)?.join("metadata.json"))
    }

    pub fn metadata(&self, id: &str) -> Value {
        self.metadata_path(id).map(|p| read_json_object(&p)).unwrap_or_else(|_| json!({}))
    }

    pub fn save_metadata(&self, id: &str, meta: &Value) -> Result<()> {
        self.writable()?;
        let p = self.metadata_path(id)?;
        let empty = meta.as_object().is_none_or(|o| o.values().all(|v| v.is_null() || v.as_object().is_some_and(Map::is_empty)));
        if empty {
            if p.exists() {
                std::fs::remove_file(&p)?;
            }
            return Ok(());
        }
        write_json(&p, meta)
    }

    // ------------------------------------------------------------ trash

    /// Deleted projects wait in trash/<time>-<id>/ (source/, local/ for your own
    /// project's folder, trash.json) until restored or the trash is emptied.
    pub fn trash_dir(&self) -> PathBuf {
        self.root.join("trash")
    }

    /// Move a project to the trash. Returns its trash entry.
    pub fn trash_source(&self, id: &str, name: &str) -> Result<Value> {
        self.writable()?;
        let src = self.source(id)?;
        let stamp: String = now().chars().filter(char::is_ascii_digit).take(14).collect();
        let entry = format!("{stamp}-{id}");
        let dest = self.trash_dir().join(&entry);
        std::fs::create_dir_all(&dest)?;
        let mut local = Value::Null;
        if src["kind"] == "local" {
            let rel = src["origin"]["path"].as_str().unwrap_or("");
            let from = self.root.join(rel_inside(rel)?);
            if from.is_dir() {
                std::fs::rename(&from, dest.join("local")).with_context(|| format!("couldn't move {} to the trash", from.display()))?;
                local = json!(rel);
            }
        }
        let dir = self.source_dir(id)?;
        std::fs::rename(&dir, dest.join("source")).with_context(|| format!("couldn't move {} to the trash", dir.display()))?;
        let info = json!({ "entry": entry, "kind": "project", "id": id, "name": name, "deleted": now(), "local": local, "source_kind": src["kind"] });
        write_json(&dest.join("trash.json"), &info)?;
        Ok(info)
    }

    /// What's in the trash, newest first, with sizes.
    pub fn trash_list(&self) -> Vec<Value> {
        let mut out: Vec<Value> = std::fs::read_dir(self.trash_dir())
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let mut info = read_json_object(&e.path().join("trash.json"));
                        info.get("id")?;
                        info["entry"] = json!(e.file_name().to_string_lossy());
                        info["bytes"] = json!(dir_bytes(&e.path()));
                        Some(info)
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b["deleted"].as_str().cmp(&a["deleted"].as_str()));
        out
    }

    /// Put a deleted project back. Fails if a project with its id came back meanwhile.
    pub fn trash_restore(&self, entry: &str) -> Result<Value> {
        self.writable()?;
        valid_id(entry)?;
        let dir = self.trash_dir().join(entry);
        let info = read_json_object(&dir.join("trash.json"));
        let id = info["id"].as_str().context("not a trash entry")?.to_string();
        let target = self.source_dir(&id)?;
        if target.exists() {
            bail!("A project with the id {id} is in the library already; delete it first to bring this one back.");
        }
        if let Some(rel) = info["local"].as_str() {
            let to = self.root.join(rel_inside(rel)?);
            if to.exists() {
                bail!("{rel} exists already; move it away to bring this project back.");
            }
            std::fs::create_dir_all(to.parent().unwrap_or(&self.root))?;
            std::fs::rename(dir.join("local"), &to)?;
        }
        std::fs::create_dir_all(self.sources_dir())?;
        std::fs::rename(dir.join("source"), &target)?;
        std::fs::remove_dir_all(&dir)?;
        Ok(info)
    }

    /// Delete one trash entry for good, or all of them. Returns how many went.
    pub fn trash_empty(&self, entry: Option<&str>) -> Result<usize> {
        self.writable()?;
        let entries: Vec<String> = match entry {
            Some(e) => {
                valid_id(e)?;
                vec![e.to_string()]
            }
            None => std::fs::read_dir(self.trash_dir()).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default(),
        };
        let mut n = 0;
        for e in entries {
            let p = self.trash_dir().join(&e);
            if p.is_dir() {
                std::fs::remove_dir_all(&p).with_context(|| format!("couldn't delete {}", p.display()))?;
                n += 1;
            } else if p.is_file() {
                std::fs::remove_file(&p)?;
            }
        }
        Ok(n)
    }
}

/// Total size of the files under a folder.
fn dir_bytes(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| match e.file_type() {
                    Ok(t) if t.is_dir() => dir_bytes(&e.path()),
                    Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

fn migration_favs(lib: &Library) -> Value {
    std::fs::read(lib.root.join(".favourites-migrated.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_array)
        .unwrap_or_else(|| json!([]))
}

/// "BelfrySCAD/BOSL2" -> "belfryscad-bosl2": lowercase letters, digits and single hyphens.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(60).collect::<String>().trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("workshop-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn dates() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_791_150_506), "2026-10-04T21:48:26Z");
        assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("BelfrySCAD/BOSL2"), "belfryscad-bosl2");
        assert_eq!(slug("  My  Project!! "), "my-project");
    }

    #[test]
    fn migrates_a_phase_1_workspace() {
        let dir = temp_dir("migrate");
        std::fs::create_dir_all(dir.join("settings/saved")).unwrap();
        std::fs::create_dir_all(dir.join("cache/renders")).unwrap();
        std::fs::write(dir.join("settings/saved/a1.json"), r#"{"id":"a1","model":"m/x","name":"A","values":{}}"#).unwrap();
        std::fs::write(dir.join("settings/prefs.json"), r#"{"gw-favs":["gen:m/x"],"gw-profile":{"bed":[220,220]},"gw-ui":{"theme":"night"}}"#).unwrap();
        let prefs = Prefs::new(dir.join("app/prefs.json"));
        let (lib, m) = Library::open(&dir, &prefs).unwrap();
        assert_eq!(m.recipes, 1);
        assert!(m.prefs_moved && m.cache_removed);
        assert_eq!(lib.recipes("m/x").unwrap().len(), 1);
        assert_eq!(lib.favourites(), json!(["gen:m/x"]));
        assert_eq!(prefs.get()["gw-profile"]["bed"], json!([220, 220]));
        assert!(prefs.get().get("gw-favs").is_none());
        assert!(!dir.join("settings").exists() && !dir.join("cache").exists());
        assert_eq!(lib.meta()["format"], json!(FORMAT));
        // opening again changes nothing
        let (lib2, m2) = Library::open(&dir, &prefs).unwrap();
        assert_eq!(m2.recipes, 0);
        assert_eq!(lib2.meta()["id"], lib.meta()["id"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_format_is_read_only() {
        let dir = temp_dir("newer");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("library.json"), r#"{"format": 99, "id": "x", "name": "Future"}"#).unwrap();
        let (lib, _) = Library::open(&dir, &Prefs::new(dir.join("p.json"))).unwrap();
        assert!(lib.read_only().is_some());
        assert!(lib.put_recipe(&json!({"id": "a", "model": "m/x"})).is_err());
        assert!(lib.set_favourites(&json!(["a"])).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_round_trip() {
        let dir = temp_dir("trash");
        let (lib, _) = Library::open(&dir, &Prefs::new(dir.join("p.json"))).unwrap();
        // your own project: its local/ folder goes to the trash with it
        std::fs::create_dir_all(dir.join("local/bevel")).unwrap();
        std::fs::write(dir.join("local/bevel/gear.scad"), "cube(1);").unwrap();
        lib.save_source(&json!({ "id": "local-bevel", "kind": "local", "origin": { "path": "local/bevel" }, "version": "v" })).unwrap();
        let info = lib.trash_source("local-bevel", "Bevel").unwrap();
        assert!(!dir.join("local/bevel").exists() && lib.source("local-bevel").is_err());
        let list = lib.trash_list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "Bevel");
        assert!(list[0]["bytes"].as_u64().unwrap() > 0);
        lib.trash_restore(info["entry"].as_str().unwrap()).unwrap();
        assert!(dir.join("local/bevel/gear.scad").is_file() && lib.source("local-bevel").is_ok());
        assert!(lib.trash_list().is_empty());
        // emptying
        lib.trash_source("local-bevel", "Bevel").unwrap();
        assert_eq!(lib.trash_empty(None).unwrap(), 1);
        assert!(lib.trash_list().is_empty() && !dir.join("local/bevel").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paths_stay_inside() {
        assert!(rel_inside("sources/a/files/v/x.scad").is_ok());
        assert!(rel_inside("../x").is_err());
        assert!(rel_inside("/etc/passwd").is_ok()); // leading slash is dropped: still relative
        assert!(rel_inside("a/../../b").is_err());
        assert!(valid_id("../x").is_err());
    }
}
