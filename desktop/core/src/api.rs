//! The app's commands, behind one entry point ([`App::call`]) so the Tauri app
//! and `workshop-cli serve` (a local stand-in used for testing the page) share
//! them exactly. Long work (adding, reading, updating projects) runs as jobs
//! the page polls.

use crate::catalog::{self, Catalog};
use crate::components::{self, ComponentLibrary};
use crate::config::{AppConfig, Prefs};
use crate::library::{self, Library};
use crate::meta;
use crate::project;
use crate::render::{default_concurrency, Renderer};
use crate::sources::{self, AddRequest};
use crate::{NativeEngine, SiteDir};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Where the app keeps things on this computer, and what it ships with.
#[derive(Clone, Debug)]
pub struct AppPaths {
    /// config.json and prefs.json
    pub config_dir: PathBuf,
    /// render cache, unpacked engine
    pub data_dir: PathBuf,
    /// the app's own files: data/catalog.json (common files, engine) and fs/ (fonts)
    pub site: PathBuf,
    /// the starter library shipped with the app (sources/<id>/...)
    pub starter: Option<PathBuf>,
    /// bundled OpenSCAD (folder or executable)
    pub engine: PathBuf,
    /// OpenSCAD libraries shipped with the app (libs/: libraries.json, <Name>/, index/)
    pub libs: Option<PathBuf>,
    /// how the page reaches library files: "library://localhost/", "/library/"...
    pub library_url: String,
}

pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, Default)]
struct Job {
    id: String,
    label: String,
    stage: String,
    done: bool,
    error: Option<String>,
    result: Value,
    started: String,
}

pub struct App {
    pub paths: AppPaths,
    site: SiteDir,
    common_files: Value,
    engine_version_site: String,
    engine: tokio::sync::OnceCell<Result<NativeEngine, String>>,
    renderer: tokio::sync::Mutex<Option<Arc<Renderer>>>,
    library: RwLock<Option<Library>>,
    catalog: Mutex<Option<Arc<Catalog>>>,
    jobs: Mutex<Vec<Job>>,
    job_seq: Mutex<u64>,
    /// one library change at a time (adding, reading, merging)
    busy: tokio::sync::Mutex<()>,
    /// one update check at a time (the daily one and a click can overlap)
    checking: tokio::sync::Mutex<()>,
    /// the bundled libraries and their components (read once)
    bundled: std::sync::OnceLock<Vec<ComponentLibrary>>,
    /// components of library projects read before 0.3 (no index in their derived data): (source, version) -> index
    project_indexes: Mutex<BTreeMap<(String, String), Value>>,
}

fn e2s(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn arg<'a>(args: &'a Value, k: &str) -> Result<&'a str> {
    args[k].as_str().filter(|s| !s.is_empty()).with_context(|| format!("missing {k}"))
}

/// Where a metadata edit goes in metadata.json, from { level, target }.
fn level_key(args: &Value) -> std::result::Result<(&'static str, Option<String>), String> {
    let target = || arg(args, "target").map(String::from).map_err(e2s);
    Ok(match args["level"].as_str().unwrap_or("item") {
        "project" => ("project", None),
        "folder" => ("folders", Some(target()?.trim_matches('/').to_string())),
        "part" => ("parts", Some(target()?)),
        _ => ("items", Some(target()?)),
    })
}

impl App {
    pub fn new(paths: AppPaths) -> Result<Arc<Self>> {
        let site = SiteDir::new(&paths.site)?;
        let cat = site.catalog()?;
        Ok(Arc::new(Self {
            common_files: cat["common_files"].clone(),
            engine_version_site: cat["engine"].as_str().unwrap_or("").to_string(),
            site,
            paths,
            engine: tokio::sync::OnceCell::new(),
            renderer: tokio::sync::Mutex::new(None),
            library: RwLock::new(None),
            catalog: Mutex::new(None),
            jobs: Mutex::new(vec![]),
            job_seq: Mutex::new(0),
            busy: tokio::sync::Mutex::new(()),
            checking: tokio::sync::Mutex::new(()),
            bundled: std::sync::OnceLock::new(),
            project_indexes: Mutex::new(BTreeMap::new()),
        }))
    }

    fn config_path(&self) -> PathBuf {
        self.paths.config_dir.join("config.json")
    }
    pub fn config(&self) -> AppConfig {
        AppConfig::load(&self.config_path())
    }
    fn prefs(&self) -> Prefs {
        Prefs::new(self.paths.config_dir.join("prefs.json"))
    }

    pub async fn engine(&self) -> Result<NativeEngine, String> {
        self.engine
            .get_or_init(|| async {
                let scratch = self.paths.data_dir.join("engine");
                NativeEngine::prepare(&self.paths.engine, &scratch).await.map_err(e2s)
            })
            .await
            .clone()
    }

    pub async fn renderer(&self) -> Result<Arc<Renderer>, String> {
        let mut g = self.renderer.lock().await;
        if let Some(r) = g.as_ref() {
            return Ok(r.clone());
        }
        let engine = self.engine().await?;
        let jobs = self.config().concurrency.unwrap_or_else(default_concurrency);
        let r = Arc::new(Renderer::new(engine, self.site.clone(), self.paths.data_dir.join("cache"), jobs).map_err(e2s)?);
        *g = Some(r.clone());
        drop(g);
        if let Ok(c) = self.catalog() {
            r.add_blobs(catalog::blob_list(&c));
        }
        Ok(r)
    }

    /// The open library (opening the configured one, with the starter projects, on first use).
    pub fn library(&self) -> Result<Library, String> {
        if let Some(l) = self.library.read().unwrap().as_ref() {
            return Ok(l.clone());
        }
        let path = self.config().library_path();
        self.open_library(&path).map_err(e2s)
    }

    fn open_library(&self, path: &Path) -> Result<Library> {
        let (lib, _migration) = Library::open(path, &self.prefs())?;
        if let Some(starter) = &self.paths.starter {
            if let Err(e) = project::sync_starter(&lib, starter) {
                eprintln!("starter library: {e:#}");
            }
        }
        let _ = sources::sync_local(&lib);
        let mut cfg = self.config();
        if cfg.library.as_deref() != Some(path) || cfg.recent_libraries.first().map(PathBuf::as_path) != Some(path) {
            cfg.set_library(path);
            cfg.save(&self.config_path())?;
        }
        *self.library.write().unwrap() = Some(lib.clone());
        self.invalidate();
        Ok(lib)
    }

    fn invalidate(&self) {
        *self.catalog.lock().unwrap() = None;
    }

    /// The libraries shipped with the app.
    pub fn bundled(&self) -> &[ComponentLibrary] {
        self.bundled.get_or_init(|| self.paths.libs.as_deref().map(components::bundled).unwrap_or_default())
    }

    /// Start values for modules without examples (shipped with the libraries).
    fn curated(&self) -> Value {
        self.paths.libs.as_deref().map(components::curated).unwrap_or(json!({}))
    }

    /// Library projects (role "library") with their components.
    fn project_libraries(&self, lib: &Library) -> Vec<ComponentLibrary> {
        let mut out = vec![];
        for ls in project::library_sources(lib) {
            let Ok(src) = lib.source(&ls.source) else { continue };
            // (an index stored by an older version is made again, in memory, until the project is read again)
            let stored = lib.derived(&ls.source, &ls.version).map(|d| d["components"].clone());
            let index = match stored.filter(|c| c.is_object() && c["format"].as_u64() == Some(components::FORMAT)) {
                Some(i) => i,
                None => {
                    let key = (ls.source.clone(), ls.version.clone());
                    let cached = self.project_indexes.lock().unwrap().get(&key).cloned();
                    match cached {
                        Some(i) => i,
                        None => {
                            let info = project::project_lib_info(&src, &ls.version, &ls.dir.name);
                            let cur = self.curated();
                            let i = components::index_library(&info, &ls.dir.path, cur.get(&ls.dir.name), cur.get("$no_guess").and_then(|n| n.get(&ls.dir.name)))
                                .unwrap_or(Value::Null);
                            self.project_indexes.lock().unwrap().insert(key, i.clone());
                            i
                        }
                    }
                }
            };
            if !index.is_object() {
                continue;
            }
            out.push(ComponentLibrary {
                info: project::project_lib_info(&src, &ls.version, &ls.dir.name),
                provider: "project".into(),
                source_id: Some(ls.source.clone()),
                root: ls.dir.path.clone(),
                index,
            });
        }
        out
    }

    fn prefer_bundled(lib: &Library) -> Vec<String> {
        lib.meta()["prefer_bundled"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect()
    }

    /// What reading a project needs about libraries.
    fn ingest_libs(&self, lib: &Library) -> project::IngestLibs {
        project::IngestLibs { bundled: self.bundled().to_vec(), prefer_bundled: Self::prefer_bundled(lib), curated: self.curated() }
    }

    pub fn catalog(&self) -> Result<Arc<Catalog>, String> {
        if let Some(c) = self.catalog.lock().unwrap().as_ref() {
            return Ok(c.clone());
        }
        let lib = self.library()?;
        let projects = self.project_libraries(&lib);
        let prefer = Self::prefer_bundled(&lib);
        let effective = components::effective(self.bundled(), &projects, &prefer);
        let libs = catalog::Libs { effective: &effective, bundled: self.bundled(), projects: &projects, prefer_bundled: &prefer };
        let c = Arc::new(catalog::build(&lib, &self.engine_version_site, &self.common_files, &self.paths.library_url, libs));
        if let Ok(g) = self.renderer.try_lock() {
            if let Some(r) = g.as_ref() {
                r.add_blobs(catalog::blob_list(&c));
            }
        }
        *self.catalog.lock().unwrap() = Some(c.clone());
        Ok(c)
    }

    // ------------------------------------------------------------ jobs

    fn start_job(self: &Arc<Self>, label: &str) -> String {
        let mut seq = self.job_seq.lock().unwrap();
        *seq += 1;
        let id = format!("job{}", *seq);
        let mut jobs = self.jobs.lock().unwrap();
        // keep running jobs and the last few finished ones
        let finished = jobs.iter().filter(|j| j.done).count();
        let mut drop_n = finished.saturating_sub(30);
        jobs.retain(|j| {
            if j.done && drop_n > 0 {
                drop_n -= 1;
                false
            } else {
                true
            }
        });
        jobs.push(Job { id: id.clone(), label: label.into(), stage: "Starting…".into(), started: library::now(), ..Default::default() });
        id
    }

    fn job_stage(&self, id: &str, stage: impl Into<String>) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) {
            j.stage = stage.into();
        }
    }

    fn job_done(&self, id: &str, r: Result<Value>) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) {
            j.done = true;
            match r {
                Ok(v) => j.result = v,
                Err(e) => j.error = Some(e2s(e)),
            }
        }
        self.invalidate();
    }

    /// Run long work in the background; the page polls `job`.
    fn spawn<F, Fut>(self: &Arc<Self>, label: &str, work: F) -> Value
    where
        F: FnOnce(Arc<Self>, String) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Value>> + Send + 'static,
    {
        let id = self.start_job(label);
        let app = self.clone();
        let jid = id.clone();
        tokio::spawn(async move {
            let _g = app.busy.lock().await;
            let r = work(app.clone(), jid.clone()).await;
            app.job_done(&jid, r);
        });
        json!({ "job": id })
    }

    fn jobs_json(&self) -> Value {
        Value::Array(
            self.jobs
                .lock()
                .unwrap()
                .iter()
                .map(|j| json!({ "id": j.id, "label": j.label, "stage": j.stage, "done": j.done, "error": j.error, "result": j.result, "started": j.started }))
                .collect(),
        )
    }

    // ------------------------------------------------------------ reading projects

    /// Read (ingest) one project at its current version, or at `version`.
    pub async fn read_project(self: &Arc<Self>, id: &str, version: Option<&str>, job: Option<&str>) -> Result<Value> {
        let lib = self.library().map_err(|e| anyhow!(e))?;
        let src = lib.source(id)?;
        if src["kind"] == "pinned" {
            self.invalidate(); // pins are read when the catalog is made
            return Ok(json!({ "source": id, "version": "pins" }));
        }
        let version = version.map(String::from).unwrap_or_else(|| src["version"].as_str().unwrap_or("").to_string());
        let renderer = self.renderer().await.map_err(|e| anyhow!(e))?;
        let common: BTreeMap<String, String> = serde_json::from_value(self.common_files.clone()).unwrap_or_default();
        let app = self.clone();
        let jid = job.map(String::from);
        let libs_ctx = self.ingest_libs(&lib);
        let derived = project::ingest(&lib, &renderer, &common, &libs_ctx, &src, &version, move |s| {
            if let Some(j) = &jid {
                app.job_stage(j, s);
            }
        })
        .await?;
        self.invalidate();
        Ok(json!({
            "source": id, "version": version,
            "models": derived["models"].as_array().map(|m| m.len()).unwrap_or(0),
            "parts": derived["parts"].as_array().map(|m| m.len()).unwrap_or(0),
            "problems": derived["problems"],
        }))
    }

    /// Check GitHub projects for new commits; download and read what changed.
    async fn check_updates(self: &Arc<Self>, only: Option<String>, job: &str) -> Result<Value> {
        let _one = self.checking.lock().await;
        let lib = self.library().map_err(|e| anyhow!(e))?;
        let token = self.config().github_token();
        let mut found = vec![];
        let ids: Vec<String> = lib.source_ids().into_iter().filter(|id| only.as_deref().is_none_or(|o| o == id)).collect();
        for id in ids {
            let mut src = lib.source(&id)?;
            if src["kind"] != "github" {
                continue;
            }
            self.job_stage(job, format!("Checking {id}…"));
            let t = token.clone();
            let lib2 = lib.clone();
            let s2 = src.clone();
            let r = tokio::task::spawn_blocking(move || sources::fetch_update(&lib2, &s2, t)).await?;
            let now = library::now();
            match r {
                Err(e) => {
                    src["update"] = json!({ "state": "error", "checked": now, "error": e2s(e) });
                }
                Ok(None) => {
                    src["update"] = json!({ "state": "current", "checked": now });
                }
                Ok(Some((version, info))) => {
                    if src["update"]["skipped"] == version.as_str() {
                        src["update"]["checked"] = json!(now);
                        lib.save_source(&src)?;
                        continue;
                    }
                    let mut versions = src["versions"].as_array().cloned().unwrap_or_default();
                    if !versions.iter().any(|v| v["id"] == version.as_str()) {
                        versions.push(json!({ "id": version, "commit": info["commit"], "date": info["date"], "message": info["message"], "added": now, "files": info["files"] }));
                    }
                    src["versions"] = Value::Array(versions);
                    lib.save_source(&src)?;
                    self.job_stage(job, format!("Reading the new version of {id}…"));
                    let summary = match self.read_project(&id, Some(&version), Some(job)).await {
                        Ok(_) => changes(&lib, &id, src["version"].as_str().unwrap_or(""), &version),
                        Err(e) => json!({ "error": e2s(e) }),
                    };
                    src = lib.source(&id)?;
                    if src["version"] == version.as_str() {
                        // accepted while this check was reading it
                        src["update"] = json!({ "state": "current", "checked": now });
                    } else {
                        src["update"] = json!({ "state": "available", "checked": now, "from": "github", "latest": info, "changes": summary });
                        found.push(id.clone());
                    }
                }
            }
            lib.save_source(&src)?;
        }
        Ok(json!({ "updates": found }))
    }

    // ------------------------------------------------------------ the command table

    pub async fn call(self: &Arc<Self>, cmd: &str, args: Value) -> Result<Reply, String> {
        let j = |v: Value| Ok(Reply::Json(v));
        match cmd {
            "app_info" => {
                let engine = self.engine().await;
                let lib = self.library();
                let r = self.renderer().await.ok();
                j(json!({
                    "version": crate::VERSION,
                    "os": std::env::consts::OS,
                    "engine": engine.as_ref().ok().map(|e| e.version.clone()),
                    "engine_path": engine.as_ref().ok().map(|e| e.exe.display().to_string()),
                    "engine_error": engine.err(),
                    "workspace": lib.as_ref().ok().map(|l| l.root().display().to_string()),
                    "library": lib.as_ref().ok().map(Library::info),
                    "library_error": lib.err(),
                    "library_url": self.paths.library_url,
                    "recent_libraries": self.config().recent_libraries,
                    "github_token": self.config().github_token().is_some(),
                    "concurrency": r.as_ref().map(|r| r.concurrency()),
                    "cache_bytes": r.as_ref().map(|r| r.cache_size()),
                }))
            }
            "read" => self.read_file(arg(&args, "path").map_err(e2s)?).map(Reply::Bytes).map_err(e2s),
            "blob" => {
                let sha = arg(&args, "sha").map_err(e2s)?;
                let p = self.site.blob(sha).map_err(e2s)?;
                if p.is_file() {
                    return std::fs::read(p).map(Reply::Bytes).map_err(|e| e.to_string());
                }
                let c = self.catalog()?;
                let p = c.blobs.get(sha).ok_or_else(|| format!("file {sha} isn't in the library"))?;
                let data = std::fs::read(p).map_err(|e| e.to_string())?;
                let scad = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("scad"));
                Ok(Reply::Bytes(if scad { crate::sitebuild::replace_crlf(&data) } else { data }))
            }
            "jobs" => j(self.jobs_json()),
            "prefs_get" => {
                let mut p = self.prefs().get();
                if let Ok(lib) = self.library() {
                    p["gw-favs"] = lib.favourites();
                }
                j(p)
            }
            "prefs_set" => {
                let mut p = args["prefs"].clone();
                if let Some(favs) = p.as_object_mut().and_then(|o| o.shift_remove("gw-favs")) {
                    if let Ok(lib) = self.library() {
                        if lib.read_only().is_none() {
                            lib.set_favourites(&favs).map_err(e2s)?;
                        }
                    }
                }
                self.prefs().set(&p).map_err(e2s)?;
                j(Value::Null)
            }
            "settings_list" => j(json!(self.library()?.recipes(arg(&args, "model").map_err(e2s)?).map_err(e2s)?)),
            "settings_get" => j(json!(self.library()?.recipe(arg(&args, "id").map_err(e2s)?).map_err(e2s)?)),
            "settings_put" => {
                self.library()?.put_recipe(&args["record"]).map_err(e2s)?;
                j(Value::Null)
            }
            "settings_remove" => {
                self.library()?.remove_recipe(arg(&args, "id").map_err(e2s)?).map_err(e2s)?;
                j(Value::Null)
            }
            "library_open" => {
                let path = PathBuf::from(arg(&args, "path").map_err(e2s)?);
                let lib = self.open_library(&path).map_err(e2s)?;
                if let Ok(g) = self.renderer.try_lock() {
                    if let Some(r) = g.as_ref() {
                        r.clear_blobs();
                    }
                }
                let _ = self.catalog();
                j(lib.info())
            }
            "library_rename" => {
                let lib = self.library()?;
                lib.update_meta(json!({ "name": arg(&args, "name").map_err(e2s)? })).map_err(e2s)?;
                self.invalidate();
                j(lib.info())
            }
            "library_defaults" => {
                // library-level metadata (fills fields nothing else sets)
                let lib = self.library()?;
                let mut m = lib.meta()["metadata"].as_object().cloned().unwrap_or_default();
                let prev = meta::patch_level(&mut m, args["patch"].as_object().ok_or("missing patch")?);
                lib.update_meta(json!({ "metadata": if m.is_empty() { Value::Null } else { Value::Object(m) } })).map_err(e2s)?;
                self.invalidate();
                j(json!({ "previous": prev }))
            }
            "category_set" => {
                let lib = self.library()?;
                let id = arg(&args, "id").map_err(e2s)?.to_string();
                let mut cats = lib.meta()["categories"].as_object().cloned().unwrap_or_default();
                let prev = cats.get(&id).cloned().unwrap_or(Value::Null);
                let mut c = cats.get(&id).and_then(Value::as_object).cloned().unwrap_or_default();
                // moved_to: remove the category, its items going to that one ("" brings it back)
                if args["moved_to"].as_str() == Some(id.as_str()) {
                    return Err("A category can't move to itself.".into());
                }
                for k in ["label", "icon", "moved_to"] {
                    match &args[k] {
                        Value::Null => {}
                        Value::String(s) if s.is_empty() => {
                            c.shift_remove(k);
                        }
                        v => {
                            c.insert(k.into(), v.clone());
                        }
                    }
                }
                if c.is_empty() {
                    cats.shift_remove(&id);
                } else {
                    cats.insert(id, Value::Object(c));
                }
                lib.update_meta(json!({ "categories": cats })).map_err(e2s)?;
                self.invalidate();
                j(json!({ "previous": prev }))
            }
            "library_prefer" => {
                // { name, bundled: bool }: use the bundled copy of a library instead of your own (or back);
                // projects that include it are read again
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let name = arg(&args, "name").map_err(e2s)?.to_string();
                let mut list = Self::prefer_bundled(&lib);
                list.retain(|n| !n.eq_ignore_ascii_case(&name));
                if args["bundled"].as_bool() == Some(true) {
                    list.push(name.clone());
                }
                lib.update_meta(json!({ "prefer_bundled": if list.is_empty() { Value::Null } else { json!(list) } })).map_err(e2s)?;
                self.invalidate();
                Ok(Reply::Json(self.spawn(&format!("Switching {name}"), move |app, job| async move {
                    let c = app.catalog().map_err(|e| anyhow!(e))?;
                    let ids: Vec<String> = c.catalog["attention"].as_array().into_iter().flatten()
                        .filter(|a| a["kind"] == "libraries").filter_map(|a| a["source"].as_str().map(String::from)).collect();
                    for id in &ids {
                        app.read_project(id, None, Some(&job)).await?;
                    }
                    Ok(json!({ "read": ids }))
                })))
            }
            "component_code" => {
                // { key, values } -> the OpenSCAD file a render of this component uses
                let c = self.catalog()?;
                let key = arg(&args, "key").map_err(e2s)?;
                let model = c.models.get(key).ok_or_else(|| format!("no model {key}"))?;
                let call: components::Call = serde_json::from_value(model["call"].clone()).map_err(|_| format!("{key} isn't a component"))?;
                let mut values: BTreeMap<String, Value> = serde_json::from_value(args["values"].clone()).unwrap_or_default();
                for (k, v) in model["fixed"].as_object().into_iter().flatten() {
                    values.insert(k.clone(), v.clone());
                }
                j(json!(components::call_source(&call, &values).map_err(e2s)?))
            }
            "pin_create" => {
                // { component, name, category?, summary?, defaults, hidden: [names], fixed: {name: value} } -> { key }
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let comp = arg(&args, "component").map_err(e2s)?.to_string();
                let c = self.catalog()?;
                let model = c.models.get(&comp).filter(|m| m["kind"] == "component").ok_or_else(|| format!("no component {comp}"))?;
                let name = args["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or_else(|| model["name"].as_str().unwrap_or("Pinned component")).to_string();
                let src = ensure_pinned(&lib).map_err(e2s)?;
                let dir = lib.source_dir(&src).map_err(e2s)?.join("pins");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let base = library::slug(&name);
                let base = if base.is_empty() { "pin".to_string() } else { base };
                let mut pid = base.clone();
                let mut n = 2;
                while dir.join(format!("{pid}.json")).exists() {
                    pid = format!("{base}-{n}");
                    n += 1;
                }
                let group = model["category"].as_str().unwrap_or("other");
                let pin = json!({
                    "id": pid, "name": name, "component": comp,
                    "category": args["category"].as_str().filter(|c| !c.is_empty()).unwrap_or(components::model_category(group)),
                    "summary": args["summary"].as_str().map(String::from).unwrap_or_else(|| model["summary"].as_str().unwrap_or("").to_string()),
                    "defaults": args["defaults"].as_object().cloned().unwrap_or_default(),
                    "hidden": args["hidden"].as_array().cloned().unwrap_or_default(),
                    "fixed": args["fixed"].as_object().cloned().unwrap_or_default(),
                    "created": library::now(),
                });
                crate::config::write_atomic(&dir.join(format!("{pid}.json")), &serde_json::to_vec_pretty(&pin).map_err(|e| e.to_string())?).map_err(e2s)?;
                self.invalidate();
                j(json!({ "key": format!("{src}/{pid}"), "source": src, "id": pid }))
            }
            "github_token" => {
                let mut cfg = self.config();
                cfg.github_token = args["token"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
                cfg.save(&self.config_path()).map_err(e2s)?;
                j(json!(cfg.github_token.is_some()))
            }
            "source_add" => {
                let kind = arg(&args, "kind").map_err(e2s)?;
                let req = match kind {
                    "github" => AddRequest::GitHub { url: arg(&args, "url").map_err(e2s)?.to_string() },
                    "zip" => AddRequest::Zip { path: PathBuf::from(arg(&args, "path").map_err(e2s)?) },
                    "folder" => AddRequest::Folder { path: PathBuf::from(arg(&args, "path").map_err(e2s)?), link: args["link"].as_bool() == Some(true) },
                    other => return Err(format!("unknown kind {other}")),
                };
                let role = if args["role"] == "library" { "library" } else { "project" }.to_string();
                let label = match &req {
                    AddRequest::GitHub { url } => format!("Adding {}", url.trim_start_matches("https://").trim_start_matches("github.com/")),
                    AddRequest::Zip { path } | AddRequest::Folder { path, .. } => {
                        format!("Adding {}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
                    }
                };
                Ok(Reply::Json(self.spawn(&label, move |app, job| async move {
                    let lib = app.library().map_err(|e| anyhow!(e))?;
                    app.job_stage(&job, match &req { AddRequest::GitHub { .. } => "Downloading…", _ => "Copying files…" });
                    let token = app.config().github_token();
                    let lib2 = lib.clone();
                    let src = tokio::task::spawn_blocking(move || sources::add(&lib2, &req, &role, token)).await??;
                    let id = src["id"].as_str().unwrap_or("").to_string();
                    app.invalidate();
                    let read = app.read_project(&id, None, Some(&job)).await?;
                    Ok(json!({ "source": id, "read": read }))
                })))
            }
            "source_read" => {
                let id = arg(&args, "id").map_err(e2s)?.to_string();
                Ok(Reply::Json(self.spawn(&format!("Reading {id}"), move |app, job| async move {
                    app.read_project(&id, None, Some(&job)).await
                })))
            }
            "source_rescan" => {
                // the library's local/ folder and linked folders, read again where they changed
                Ok(Reply::Json(self.spawn("Looking for changed projects", move |app, job| async move {
                    let lib = app.library().map_err(|e| anyhow!(e))?;
                    let changed = sources::sync_local(&lib)?;
                    let mut unread: Vec<String> = lib.source_ids().into_iter().filter(|id| {
                        lib.source(id).ok().is_some_and(|s| s["kind"] != "bundled" && s["kind"] != "pinned" && lib.derived(id, s["version"].as_str().unwrap_or("")).is_none())
                    }).collect();
                    // and those whose libraries changed (the app's copy, or which copy is used)
                    if let Ok(c) = app.catalog() {
                        for a in c.catalog["attention"].as_array().into_iter().flatten().filter(|a| a["kind"] == "libraries") {
                            if let Some(id) = a["source"].as_str() {
                                unread.push(id.to_string());
                            }
                        }
                    }
                    let mut read = vec![];
                    for id in changed.iter().chain(unread.iter()) {
                        if read.contains(id) {
                            continue;
                        }
                        app.read_project(id, None, Some(&job)).await?;
                        read.push(id.clone());
                    }
                    Ok(json!({ "read": read }))
                })))
            }
            "source_get" => {
                let id = arg(&args, "id").map_err(e2s)?;
                let lib = self.library()?;
                let src = lib.source(id).map_err(e2s)?;
                let c = self.catalog()?;
                let entry = c.catalog["sources"].as_array().into_iter().flatten().find(|s| s["id"] == id).cloned().unwrap_or(json!({}));
                let (readme, license_text, files) = match c.derived.get(id) {
                    Some((d, dir)) => (
                        d["readme"].as_str().and_then(|p| std::fs::read_to_string(dir.join(p)).ok()).map(|t| t.chars().take(100_000).collect::<String>()),
                        d["license_file"].as_str().and_then(|p| std::fs::read_to_string(dir.join(p)).ok()).map(|t| t.chars().take(20_000).collect::<String>()),
                        json!(crate::scan::list_files(dir).iter().take(2000).map(|f| json!([f.rel, f.bytes])).collect::<Vec<_>>()),
                    ),
                    None => (None, None, json!([])),
                };
                let derived = c.derived.get(id).map(|(d, _)| json!({ "stats": d["stats"], "problems": d["problems"], "made": d["made"], "engine": d["engine"], "editor_toml": d["editor_toml"] }));
                j(json!({
                    "source": src, "entry": entry, "metadata": lib.metadata(id), "readme": readme, "license_text": license_text,
                    "files": files, "derived": derived,
                    "folder": lib.version_dir(&src, src["version"].as_str().unwrap_or("")).ok().map(|p| p.display().to_string()),
                }))
            }
            "source_remove" => {
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let id = arg(&args, "id").map_err(e2s)?;
                let src = lib.source(id).map_err(e2s)?;
                if src["kind"] == "bundled" {
                    let mut removed = lib.meta()["removed_starter"].as_array().cloned().unwrap_or_default();
                    if !removed.iter().any(|v| v == id) {
                        removed.push(json!(id));
                    }
                    lib.update_meta(json!({ "removed_starter": removed })).map_err(e2s)?;
                }
                // into the library's trash/ folder (with your own project's local/ folder), until the trash is emptied
                let name = self.catalog().ok().and_then(|c| catalog::sorted_sources(&c).get(id).and_then(|s| s["name"].as_str().map(String::from)))
                    .or_else(|| src["detected"]["name"].as_str().map(String::from))
                    .unwrap_or_else(|| id.to_string());
                let info = lib.trash_source(id, &name).map_err(e2s)?;
                self.invalidate();
                j(info)
            }
            "trash_list" => j(json!(self.library()?.trash_list())),
            "trash_restore" => {
                let lib = self.library()?;
                let info = lib.trash_restore(arg(&args, "entry").map_err(e2s)?).map_err(e2s)?;
                if info["source_kind"] == "bundled" {
                    let mut removed = lib.meta()["removed_starter"].as_array().cloned().unwrap_or_default();
                    removed.retain(|v| *v != info["id"]);
                    lib.update_meta(json!({ "removed_starter": if removed.is_empty() { Value::Null } else { json!(removed) } })).map_err(e2s)?;
                }
                self.invalidate();
                j(info)
            }
            "trash_empty" => {
                let lib = self.library()?;
                let n = lib.trash_empty(args["entry"].as_str()).map_err(e2s)?;
                j(json!({ "removed": n }))
            }
            "source_restore_starter" => {
                let lib = self.library()?;
                lib.update_meta(json!({ "removed_starter": Value::Null })).map_err(e2s)?;
                let r = match &self.paths.starter {
                    Some(s) => project::sync_starter(&lib, s).map_err(e2s)?,
                    None => (vec![], vec![]),
                };
                self.invalidate();
                j(json!({ "installed": r.0 }))
            }
            "source_role" => {
                let lib = self.library()?;
                let id = arg(&args, "id").map_err(e2s)?.to_string();
                let mut src = lib.source(&id).map_err(e2s)?;
                src["role"] = json!(if args["role"] == "library" { "library" } else { "project" });
                if let Some(n) = args["library_name"].as_str() {
                    src["library_name"] = json!(n);
                }
                lib.save_source(&src).map_err(e2s)?;
                Ok(Reply::Json(self.spawn(&format!("Reading {id}"), move |app, job| async move {
                    app.read_project(&id, None, Some(&job)).await
                })))
            }
            "updates_check" => {
                let only = args["id"].as_str().map(String::from);
                Ok(Reply::Json(self.spawn("Checking for updates", move |app, job| async move { app.check_updates(only, &job).await })))
            }
            "update_apply" => {
                let lib = self.library()?;
                let id = arg(&args, "id").map_err(e2s)?;
                let mut src = lib.source(id).map_err(e2s)?;
                let latest = src["update"]["latest"]["id"].as_str().ok_or("No update is waiting.")?.to_string();
                if lib.derived(id, &latest).is_none() {
                    return Err("The new version hasn't been read; check for updates again.".into());
                }
                let previous = src["version"].clone();
                src["version"] = json!(latest);
                src["version_date"] = src["update"]["latest"]["date"].clone();
                src["previous_version"] = previous;
                src["update"] = json!({ "state": "current", "checked": src["update"]["checked"], "applied": library::now() });
                lib.save_source(&src).map_err(e2s)?;
                self.invalidate();
                j(src)
            }
            "update_skip" => {
                let lib = self.library()?;
                let id = arg(&args, "id").map_err(e2s)?;
                let mut src = lib.source(id).map_err(e2s)?;
                let latest = src["update"]["latest"]["id"].clone();
                src["update"] = json!({ "state": "skipped", "skipped": latest, "checked": src["update"]["checked"] });
                lib.save_source(&src).map_err(e2s)?;
                self.invalidate();
                j(src)
            }
            "source_clean" => {
                let lib = self.library()?;
                let src = lib.source(arg(&args, "id").map_err(e2s)?).map_err(e2s)?;
                let removed = sources::clean_versions(&lib, &src).map_err(e2s)?;
                let mut src = src;
                if let Some(vs) = src["versions"].as_array_mut() {
                    vs.retain(|v| !v["id"].as_str().is_some_and(|i| removed.iter().any(|r| r == i)));
                }
                lib.save_source(&src).map_err(e2s)?;
                j(json!({ "removed": removed }))
            }
            "meta_set" => {
                // { source, level: project|folder|item|part, target, patch } -> { previous }
                let lib = self.library()?;
                let id = arg(&args, "source").map_err(e2s)?;
                lib.source(id).map_err(e2s)?;
                let patch = args["patch"].as_object().ok_or("missing patch")?.clone();
                let mut m = lib.metadata(id);
                let (section, key) = level_key(&args)?;
                let prev = meta::patch_level(meta::level_mut(&mut m, section, key.as_deref()), &patch);
                meta::prune(&mut m);
                lib.save_metadata(id, &m).map_err(e2s)?;
                self.invalidate();
                j(json!({ "previous": prev }))
            }
            "meta_set_many" => {
                // { edits: [{ source, level, target, patch }] } -> { previous: [same shape, for undo] }
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let edits = args["edits"].as_array().ok_or("missing edits")?;
                let mut by_source: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
                for e in edits {
                    by_source.entry(arg(e, "source").map_err(e2s)?.to_string()).or_default().push(e);
                }
                let mut previous = vec![];
                for (id, es) in by_source {
                    lib.source(&id).map_err(e2s)?;
                    let mut m = lib.metadata(&id);
                    for e in es {
                        let (section, key) = level_key(e)?;
                        let patch = e["patch"].as_object().ok_or("missing patch")?;
                        let prev = meta::patch_level(meta::level_mut(&mut m, section, key.as_deref()), patch);
                        previous.push(json!({ "source": id, "level": e["level"], "target": e["target"], "patch": prev }));
                    }
                    meta::prune(&mut m);
                    lib.save_metadata(&id, &m).map_err(e2s)?;
                }
                self.invalidate();
                j(json!({ "previous": previous }))
            }
            "meta_clear_items" => {
                // remove one field from every item/part of a project ("use the project's value everywhere")
                let lib = self.library()?;
                let id = arg(&args, "source").map_err(e2s)?;
                let field = arg(&args, "field").map_err(e2s)?.to_string();
                let mut m = lib.metadata(id);
                let mut previous = Map::new();
                for section in ["items", "parts", "folders"] {
                    if let Some(Value::Object(sec)) = m.get_mut(section) {
                        for (k, v) in sec.iter_mut() {
                            if let Some(old) = v.as_object_mut().and_then(|o| o.shift_remove(&field)) {
                                previous.insert(format!("{section}/{k}"), old);
                            }
                        }
                    }
                }
                meta::prune(&mut m);
                lib.save_metadata(id, &m).map_err(e2s)?;
                self.invalidate();
                j(json!({ "previous": previous, "cleared": previous.len() }))
            }
            "meta_restore" => {
                // undo of meta_clear_items: { source, field, previous: { "items/x": value } }
                let lib = self.library()?;
                let id = arg(&args, "source").map_err(e2s)?;
                let field = arg(&args, "field").map_err(e2s)?;
                let mut m = lib.metadata(id);
                for (k, v) in args["previous"].as_object().into_iter().flatten() {
                    if let Some((section, key)) = k.split_once('/') {
                        meta::level_mut(&mut m, section, Some(key)).insert(field.to_string(), v.clone());
                    }
                }
                lib.save_metadata(id, &m).map_err(e2s)?;
                self.invalidate();
                j(Value::Null)
            }
            "thumb_put" => {
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let id = arg(&args, "source").map_err(e2s)?;
                let name = arg(&args, "name").map_err(e2s)?;
                if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                    return Err("invalid thumbnail name".into());
                }
                let data = decode_data_url(arg(&args, "data").map_err(e2s)?).map_err(e2s)?;
                let p = lib.source_dir(id).map_err(e2s)?.join("thumbs").join(format!("{name}.webp"));
                crate::config::write_atomic(&p, &data).map_err(e2s)?;
                self.invalidate();
                j(Value::Null)
            }
            "icon_import" => {
                // { category, path }: an image of your own as a category's icon, copied into the library's icons/ folder
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let id = arg(&args, "category").map_err(e2s)?.to_string();
                let from = PathBuf::from(arg(&args, "path").map_err(e2s)?);
                let ext = from.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
                if !["png", "jpg", "jpeg", "webp", "svg"].contains(&ext.as_str()) {
                    return Err("Choose a PNG, JPEG, WebP or SVG image.".into());
                }
                let data = std::fs::read(&from).map_err(|e| format!("couldn't read {}: {e}", from.display()))?;
                if data.len() > 4 << 20 {
                    return Err("That image is over 4 MB; use a smaller one.".into());
                }
                let rel = format!("icons/category-{}.{ext}", library::slug(&id));
                crate::config::write_atomic(&lib.root().join(&rel), &data).map_err(e2s)?;
                let mut cats = lib.meta()["categories"].as_object().cloned().unwrap_or_default();
                let mut c = cats.get(&id).and_then(Value::as_object).cloned().unwrap_or_default();
                let prev = c.insert("icon".into(), json!(rel));
                cats.insert(id, Value::Object(c));
                lib.update_meta(json!({ "categories": cats })).map_err(e2s)?;
                self.invalidate();
                j(json!({ "icon": rel, "previous": prev }))
            }
            "component_thumb" => {
                // { key: "@lib/module", data: webp data URL }: a thumbnail made after the component was rendered
                let lib = self.library()?;
                lib.writable().map_err(e2s)?;
                let key = arg(&args, "key").map_err(e2s)?;
                let c = self.catalog()?;
                let m = c.models.get(key).filter(|m| m["kind"] == "component").ok_or_else(|| format!("no component {key}"))?;
                let module = m["id"].as_str().unwrap_or("");
                let libname = m["component"]["library"].as_str().unwrap_or("");
                if !module.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                    return Err("invalid module name".into());
                }
                let data = decode_data_url(arg(&args, "data").map_err(e2s)?).map_err(e2s)?;
                let p = lib.root().join("thumbs/components").join(catalog::component_thumb_dir(libname)).join(format!("{module}.webp"));
                crate::config::write_atomic(&p, &data).map_err(e2s)?;
                self.invalidate();
                j(Value::Null)
            }
            "library_merge" => {
                let from = PathBuf::from(arg(&args, "path").map_err(e2s)?);
                Ok(Reply::Json(self.spawn("Merging a library", move |app, job| async move {
                    let lib = app.library().map_err(|e| anyhow!(e))?;
                    app.job_stage(&job, "Copying projects…");
                    let lib2 = lib.clone();
                    let prefs = app.prefs();
                    tokio::task::spawn_blocking(move || crate::merge::merge(&lib2, &from, &prefs)).await?
                })))
            }
            "merge_resolve" => {
                let lib = self.library()?;
                crate::merge::resolve(&lib, &args["choices"]).map_err(e2s)?;
                self.invalidate();
                j(Value::Null)
            }
            "render_default" => {
                // render a model at its defaults (tests and the starter check)
                let key = arg(&args, "key").map_err(e2s)?;
                let c = self.catalog()?;
                let model = c.models.get(key).ok_or_else(|| format!("no model {key}"))?;
                let req = crate::render::default_request(model, &c.catalog["common_files"]).map_err(e2s)?;
                let r = self.renderer().await?;
                r.add_blobs(catalog::blob_list(&c));
                let out = r.render(&format!("default-{}", key.replace('/', "-")), &req, |_| {}).await.map_err(|e| e.message)?;
                j(json!({ "key": key, "triangles": crate::render::stl_triangles(&out.stl), "bytes": out.stl.len(), "ms": out.ms, "cached": out.cached }))
            }
            "cache_clear" => {
                let r = self.renderer().await?;
                let freed = tokio::task::spawn_blocking(move || r.clear_cache()).await.map_err(|e| e.to_string())?.map_err(e2s)?;
                j(json!(freed))
            }
            other => Err(format!("unknown command {other}")),
        }
    }

    /// Files the page reads: the catalog, model pages and parts packs (from the
    /// library, with edits applied), library files, and the app's own data.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let path = path.trim_start_matches("./").trim_start_matches('/');
        if path == "data/catalog.json" {
            let c = self.catalog().map_err(|e| anyhow!(e))?;
            return Ok(serde_json::to_vec(&c.catalog)?);
        }
        if let Some(rest) = path.strip_prefix("data/models/").and_then(|r| r.strip_suffix(".json")) {
            let key = rest.replacen("--", "/", 1);
            let c = self.catalog().map_err(|e| anyhow!(e))?;
            if let Some(d) = c.models.get(&key) {
                return Ok(serde_json::to_vec(d)?);
            }
            bail!("no model {key}");
        }
        if let Some(id) = path.strip_prefix("data/libraries/").and_then(|r| r.strip_suffix(".json")) {
            let c = self.catalog().map_err(|e| anyhow!(e))?;
            if let Some(p) = c.parts.get(id) {
                return Ok(serde_json::to_vec(p)?);
            }
            bail!("no parts pack {id}");
        }
        if let Some(rel) = path.strip_prefix("library/") {
            let lib = self.library().map_err(|e| anyhow!(e))?;
            let rel = percent_decode(rel);
            return std::fs::read(lib.resolve(&rel)?).with_context(|| format!("couldn't read {rel}"));
        }
        self.site.read(path)
    }

    /// A file in the open library, for the library:// protocol (thumbnails, part files).
    pub fn library_file(&self, rel: &str) -> Result<Vec<u8>> {
        let lib = self.library().map_err(|e| anyhow!(e))?;
        let rel = percent_decode(rel.trim_start_matches('/'));
        Ok(std::fs::read(lib.resolve(&rel)?)?)
    }
}

/// The library's "Pinned components" project (made on first use; a trashed one is made again).
fn ensure_pinned(lib: &Library) -> Result<String> {
    let id = "pinned";
    if lib.source(id).is_ok() {
        return Ok(id.into());
    }
    lib.save_source(&json!({
        "id": id, "kind": "pinned", "role": "project", "added": library::now(), "version": "pins",
        "origin": {}, "detected": { "name": "Pinned components", "summary": "Components from libraries, pinned as models.", "category": "other" },
    }))?;
    Ok(id.into())
}

/// What changed between two read versions of a project: models added or removed,
/// and settings added, removed or with a new default.
pub fn changes(lib: &Library, id: &str, old: &str, new: &str) -> Value {
    let (Some(a), Some(b)) = (lib.derived(id, old), lib.derived(id, new)) else { return json!({}) };
    let by_id = |d: &Value| -> BTreeMap<String, Value> {
        d["models"].as_array().into_iter().flatten().filter_map(|m| Some((m["id"].as_str()?.to_string(), m.clone()))).collect()
    };
    let (ma, mb) = (by_id(&a), by_id(&b));
    let added: Vec<Value> = mb.iter().filter(|(k, _)| !ma.contains_key(*k)).map(|(_, m)| m["name"].clone()).collect();
    let removed: Vec<Value> = ma.iter().filter(|(k, _)| !mb.contains_key(*k)).map(|(_, m)| m["name"].clone()).collect();
    let mut settings = vec![];
    for (k, old_m) in &ma {
        let Some(new_m) = mb.get(k) else { continue };
        let params = |m: &Value| -> BTreeMap<String, Value> {
            m["parameters"].as_array().into_iter().flatten().filter_map(|p| Some((p["name"].as_str()?.to_string(), p.clone()))).collect()
        };
        let (pa, pb) = (params(old_m), params(new_m));
        let p_added: Vec<&String> = pb.keys().filter(|n| !pa.contains_key(*n)).collect();
        let p_removed: Vec<&String> = pa.keys().filter(|n| !pb.contains_key(*n)).collect();
        let defaults: Vec<Value> = pa
            .iter()
            .filter_map(|(n, p)| {
                let q = pb.get(n)?;
                (!crate::ingest::json_eq(&p["default"], &q["default"])).then(|| json!({ "name": n, "from": p["default"], "to": q["default"] }))
            })
            .collect();
        if !p_added.is_empty() || !p_removed.is_empty() || !defaults.is_empty() {
            settings.push(json!({ "model": old_m["name"], "added": p_added, "removed": p_removed, "defaults": defaults }));
        }
    }
    let problems_new = b["problems"].as_array().map(|p| p.len()).unwrap_or(0);
    json!({ "added": added, "removed": removed, "settings": settings, "problems": problems_new })
}

fn decode_data_url(s: &str) -> Result<Vec<u8>> {
    let b64 = s.split_once(',').map(|(_, d)| d).unwrap_or(s);
    base64_decode(b64)
}

/// Standard base64 (no external crate).
pub fn base64_decode(s: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => bail!("invalid base64"),
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(decode_data_url("data:image/webp;base64,AAEC").unwrap(), vec![0, 1, 2]);
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("x%2"), "x%2");
    }
}
