//! Native renders: one OpenSCAD process per job, a limited number at once,
//! cancellable, with finished results cached on disk by a hash of everything
//! that affects the output.

use crate::{engine::NativeEngine, site::SiteDir};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify, Semaphore};

/// What to render. `files` maps the model's virtual paths ("/vendor/x/y.scad",
/// "/libraries/BOSL/...", "/fonts/...") to content hashes in the site's `fs/`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RenderRequest {
    #[serde(default)]
    pub model: String,
    pub entry: String,
    pub files: BTreeMap<String, String>,
    pub values: BTreeMap<String, Value>,
    /// Settings passed with -D instead of the parameter file (values the file computes).
    #[serde(default)]
    pub defines: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RenderEvent {
    Stage { stage: String },
    Log { line: String },
}

#[derive(Debug)]
pub struct RenderOutput {
    pub stl: Vec<u8>,
    pub ms: u64,
    pub cached: bool,
    pub logs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RenderFailure {
    pub message: String,
    pub cancelled: bool,
    pub logs: Vec<String>,
}

impl std::fmt::Display for RenderFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RenderFailure {}

impl RenderFailure {
    fn failed(message: impl Into<String>, logs: Vec<String>) -> Self {
        Self { message: message.into(), cancelled: false, logs }
    }
    fn cancelled(logs: Vec<String>) -> Self {
        Self { message: "Render cancelled.".into(), cancelled: true, logs }
    }
}

#[derive(Serialize, Deserialize)]
struct CacheMeta {
    ms: u64,
    engine: String,
    model: String,
}

const MAX_LOG_LINES: usize = 400;

pub struct Renderer {
    engine: NativeEngine,
    site: SiteDir,
    cache_dir: PathBuf,
    slots: Arc<Semaphore>,
    concurrency: usize,
    jobs: Mutex<HashMap<String, Arc<Notify>>>,
    /// Render cache size limit in bytes; oldest results are removed beyond it.
    pub cache_limit: u64,
}

/// Default number of renders at once: all cores but one, at least one.
pub fn default_concurrency() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).max(1)
}

fn rel_path(virtual_path: &str) -> Result<PathBuf> {
    let rel = Path::new(virtual_path.trim_start_matches('/'));
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("invalid model file path {virtual_path}");
    }
    Ok(rel.to_path_buf())
}

fn sha_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p);
    }
    hex::encode(h.finalize())
}

/// Number of triangles in a binary STL.
pub fn stl_triangles(stl: &[u8]) -> Option<u32> {
    (stl.len() >= 84).then(|| u32::from_le_bytes([stl[80], stl[81], stl[82], stl[83]]))
}

/// OpenSCAD parameter-set file: strings unquoted, everything else as JSON text
/// (mirrors web/render-worker.js).
fn parameter_set(values: &BTreeMap<String, Value>, skip: &[String]) -> String {
    let set: serde_json::Map<String, Value> = values
        .iter()
        .filter(|(k, _)| !skip.contains(k))
        .map(|(k, v)| {
            let s = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            (k.clone(), Value::String(s))
        })
        .collect();
    serde_json::json!({ "fileFormatVersion": "1", "parameterSets": { "site": set } }).to_string()
}

fn stage_for(line: &str) -> Option<&'static str> {
    if line.starts_with("Parsing design") {
        Some("Parsing…")
    } else if line.starts_with("Compiling design") {
        Some("Compiling…")
    } else if line.starts_with("Rendering") || line.contains("Rendering Polygon Mesh") {
        Some("Rendering…")
    } else {
        None
    }
}

impl Renderer {
    pub fn new(engine: NativeEngine, site: SiteDir, cache_dir: PathBuf, concurrency: usize) -> Result<Self> {
        for d in ["renders", "trees", "jobs"] {
            std::fs::create_dir_all(cache_dir.join(d))
                .with_context(|| format!("couldn't create {}", cache_dir.join(d).display()))?;
        }
        let concurrency = concurrency.max(1);
        Ok(Self {
            engine,
            site,
            cache_dir,
            slots: Arc::new(Semaphore::new(concurrency)),
            concurrency,
            jobs: Mutex::new(HashMap::new()),
            cache_limit: 1 << 30,
        })
    }

    pub fn engine(&self) -> &NativeEngine {
        &self.engine
    }
    pub fn site(&self) -> &SiteDir {
        &self.site
    }
    pub fn concurrency(&self) -> usize {
        self.concurrency
    }
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    /// Everything that changes the output: engine version, entry, every input file, values, defines.
    pub fn cache_key(&self, req: &RenderRequest) -> String {
        let files = serde_json::to_vec(&req.files).unwrap_or_default();
        let values = serde_json::to_vec(&req.values).unwrap_or_default();
        let mut defines = req.defines.clone();
        defines.sort();
        let defines = defines.join("\n");
        sha_hex(&[self.engine.version.as_bytes(), req.entry.as_bytes(), &files, &values, defines.as_bytes()])
    }

    /// Ask a running or queued job to stop. Returns false if it isn't known (already finished).
    pub fn cancel(&self, job: &str) -> bool {
        match self.jobs.lock().unwrap().get(job) {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        }
    }

    /// Look up a finished render without starting one.
    pub fn cached(&self, req: &RenderRequest) -> Option<RenderOutput> {
        let key = self.cache_key(req);
        let stl_path = self.cache_dir.join("renders").join(format!("{key}.stl"));
        let stl = std::fs::read(&stl_path).ok()?;
        if let Ok(f) = std::fs::File::options().append(true).open(&stl_path) {
            let _ = f.set_modified(SystemTime::now()); // keep recently used results when pruning
        }
        let meta: Option<CacheMeta> = std::fs::read(self.cache_dir.join("renders").join(format!("{key}.json")))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        Some(RenderOutput { stl, ms: meta.map(|m| m.ms).unwrap_or(0), cached: true, logs: vec![] })
    }

    pub async fn render<F>(&self, job: &str, req: &RenderRequest, on_event: F) -> Result<RenderOutput, RenderFailure>
    where
        F: Fn(RenderEvent) + Send + Sync,
    {
        if let Some(hit) = self.cached(req) {
            return Ok(hit);
        }
        let cancel = Arc::new(Notify::new());
        self.jobs.lock().unwrap().insert(job.to_string(), cancel.clone());
        let result = self.render_uncached(job, req, &on_event, &cancel).await;
        self.jobs.lock().unwrap().remove(job);
        result
    }

    async fn render_uncached<F>(&self, job: &str, req: &RenderRequest, on_event: &F, cancel: &Notify) -> Result<RenderOutput, RenderFailure>
    where
        F: Fn(RenderEvent) + Send + Sync,
    {
        // wait for a free engine slot (batches queue here)
        let _permit = match self.slots.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                on_event(RenderEvent::Stage { stage: "Waiting for a free engine…".into() });
                tokio::select! {
                    p = self.slots.clone().acquire_owned() => p.map_err(|_| RenderFailure::failed("The render queue was closed.", vec![]))?,
                    _ = cancel.notified() => return Err(RenderFailure::cancelled(vec![])),
                }
            }
        };

        let started = Instant::now(); // render time, not counting the wait for a slot
        on_event(RenderEvent::Stage { stage: "Preparing model files…".into() });
        let tree = {
            let files = req.files.clone();
            let site = self.site.clone();
            let trees = self.cache_dir.join("trees");
            tokio::task::spawn_blocking(move || ensure_tree(&site, &trees, &files))
                .await
                .map_err(|e| RenderFailure::failed(format!("Couldn't prepare the model files: {e}"), vec![]))?
                .map_err(|e| RenderFailure::failed(format!("Couldn't prepare the model files: {e:#}"), vec![]))?
        };
        let entry = rel_path(&req.entry).map_err(|e| RenderFailure::failed(e.to_string(), vec![]))?;

        let safe_job: String = job.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
        let job_dir = self.cache_dir.join("jobs").join(format!("{}-{}", safe_job, std::process::id()));
        let _cleanup = RemoveOnDrop(job_dir.clone());
        std::fs::create_dir_all(&job_dir).map_err(|e| RenderFailure::failed(format!("Couldn't create a job folder: {e}"), vec![]))?;
        let params = job_dir.join("params.json");
        let out = job_dir.join("out.stl");
        std::fs::write(&params, parameter_set(&req.values, &req.defines))
            .map_err(|e| RenderFailure::failed(format!("Couldn't write settings: {e}"), vec![]))?;

        let mut cmd = self.engine.command();
        cmd.arg(tree.join(&entry));
        for d in &req.defines {
            if let Some(v) = req.values.get(d) {
                cmd.arg("-D").arg(format!("{d}={v}"));
            }
        }
        cmd.args(["--backend=Manifold", "--export-format=binstl", "-P", "site"])
            .arg("-p")
            .arg(&params)
            .arg("-o")
            .arg(&out)
            .current_dir(&tree)
            .env("OPENSCADPATH", tree.join("libraries"))
            .env("OPENSCAD_FONT_PATH", tree.join("fonts"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        on_event(RenderEvent::Stage { stage: "Starting OpenSCAD…".into() });
        let mut child = cmd
            .spawn()
            .map_err(|e| RenderFailure::failed(format!("Couldn't start OpenSCAD ({}): {e}", self.engine.exe.display()), vec![]))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
                       child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)]
            .into_iter()
            .flatten()
        {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);

        let mut logs: Vec<String> = vec![];
        let push = |line: String, logs: &mut Vec<String>| {
            if let Some(s) = stage_for(&line) {
                on_event(RenderEvent::Stage { stage: s.into() });
            }
            on_event(RenderEvent::Log { line: line.clone() });
            logs.push(line);
            if logs.len() > MAX_LOG_LINES {
                logs.remove(0);
            }
        };
        let mut status = None;
        let mut streams_open = true;
        while status.is_none() || streams_open {
            tokio::select! {
                line = rx.recv(), if streams_open => match line {
                    Some(l) => push(l, &mut logs),
                    None => streams_open = false,
                },
                s = child.wait(), if status.is_none() => {
                    status = Some(s.map_err(|e| RenderFailure::failed(format!("OpenSCAD failed: {e}"), vec![]))?);
                }
                _ = cancel.notified() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(RenderFailure::cancelled(logs));
                }
            }
        }
        let status = status.unwrap();
        let ms = started.elapsed().as_millis() as u64;
        let first_error = logs.iter().find(|l| l.starts_with("ERROR:")).cloned();
        let stl = std::fs::read(&out).unwrap_or_default();
        if !status.success() || first_error.is_some() || stl.len() <= 84 {
            let msg = first_error.unwrap_or_else(|| match status.code() {
                Some(0) | None if stl.len() <= 84 => "OpenSCAD produced no geometry. These settings may not be valid for this model.".into(),
                Some(c) => format!("OpenSCAD stopped with code {c}."),
                None => "OpenSCAD stopped unexpectedly.".into(),
            });
            return Err(RenderFailure::failed(msg, logs));
        }

        let key = self.cache_key(req);
        let renders = self.cache_dir.join("renders");
        let tmp = renders.join(format!("{key}.tmp-{safe_job}"));
        if std::fs::write(&tmp, &stl).is_ok() && std::fs::rename(&tmp, renders.join(format!("{key}.stl"))).is_ok() {
            let meta = CacheMeta { ms, engine: self.engine.version.clone(), model: req.model.clone() };
            let _ = std::fs::write(renders.join(format!("{key}.json")), serde_json::to_vec(&meta).unwrap_or_default());
            let _ = self.prune();
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(RenderOutput { stl, ms, cached: false, logs })
    }

    /// Total size of cached renders in bytes.
    pub fn cache_size(&self) -> u64 {
        std::fs::read_dir(self.cache_dir.join("renders"))
            .map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
            .unwrap_or(0)
    }

    /// Remove the oldest cached renders until the cache is below 80% of its limit.
    pub fn prune(&self) -> Result<()> {
        let dir = self.cache_dir.join("renders");
        let mut items: Vec<(SystemTime, u64, PathBuf)> = std::fs::read_dir(&dir)?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "stl"))
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((m.modified().ok()?, m.len(), e.path()))
            })
            .collect();
        let mut total: u64 = items.iter().map(|i| i.1).sum();
        if total <= self.cache_limit {
            return Ok(());
        }
        items.sort();
        for (_, len, path) in items {
            if total <= self.cache_limit / 10 * 8 {
                break;
            }
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("json"));
            total = total.saturating_sub(len);
        }
        Ok(())
    }

    /// Delete cached renders and prepared model folders. Returns bytes freed.
    pub fn clear_cache(&self) -> Result<u64> {
        let before = self.cache_size();
        for d in ["renders", "trees"] {
            let p = self.cache_dir.join(d);
            if p.exists() {
                std::fs::remove_dir_all(&p)?;
            }
            std::fs::create_dir_all(&p)?;
        }
        Ok(before)
    }
}

struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Lay a model's files out as a real folder tree (once per distinct file set) so
/// native OpenSCAD can follow its includes. Returns the tree's root.
fn ensure_tree(site: &SiteDir, trees: &Path, files: &BTreeMap<String, String>) -> Result<PathBuf> {
    let listing: String = files.iter().map(|(p, s)| format!("{p}\0{s}\n")).collect();
    let key = &sha_hex(&[listing.as_bytes()])[..24];
    let root = trees.join(key);
    if root.join(".complete").is_file() {
        return Ok(root);
    }
    let tmp = trees.join(format!("{key}.tmp-{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
    let _ = std::fs::remove_dir_all(&tmp);
    for (vpath, sha) in files {
        let dst = tmp.join(rel_path(vpath)?);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(site.blob(sha)?, &dst).with_context(|| format!("copying {vpath}"))?;
    }
    std::fs::write(tmp.join(".complete"), b"")?;
    match std::fs::rename(&tmp, &root) {
        Ok(()) => Ok(root),
        Err(_) if root.join(".complete").is_file() => {
            // another render prepared the same tree at the same time
            let _ = std::fs::remove_dir_all(&tmp);
            Ok(root)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::rename(&tmp, &root).with_context(|| format!("preparing model folder: {e}"))?;
            Ok(root)
        }
    }
}

/// Default settings for a built model (parameters' defaults plus its fixed values),
/// with the names that go through -D. Used by the CLI and tests.
pub fn default_request(model: &Value, common_files: &Value) -> Result<RenderRequest> {
    let mut files: BTreeMap<String, String> = serde_json::from_value(common_files.clone()).unwrap_or_default();
    let model_files: BTreeMap<String, String> =
        serde_json::from_value(model["files"].clone()).context("model has no files")?;
    files.extend(model_files);
    let mut values = BTreeMap::new();
    let mut defines = vec![];
    for p in model["parameters"].as_array().into_iter().flatten() {
        let name = p["name"].as_str().unwrap_or_default().to_string();
        values.insert(name.clone(), p["default"].clone());
        if p["define"].as_bool() == Some(true) {
            defines.push(name);
        }
    }
    if let Some(fixed) = model["fixed"].as_object() {
        for (k, v) in fixed {
            values.insert(k.clone(), v.clone());
        }
    }
    Ok(RenderRequest {
        model: model["key"].as_str().unwrap_or_default().to_string(),
        entry: model["entry"].as_str().context("model has no entry")?.to_string(),
        files,
        values,
        defines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parameter_set_matches_the_browser_worker() {
        let mut v = BTreeMap::new();
        v.insert("text".to_string(), json_str("M3"));
        v.insert("size".to_string(), serde_json::json!([1, 2.5]));
        v.insert("on".to_string(), serde_json::json!(true));
        v.insert("computed".to_string(), serde_json::json!(4));
        let s: Value = serde_json::from_str(&parameter_set(&v, &["computed".to_string()])).unwrap();
        let set = &s["parameterSets"]["site"];
        assert_eq!(set["text"], "M3");
        assert_eq!(set["size"], "[1,2.5]");
        assert_eq!(set["on"], "true");
        assert!(set.get("computed").is_none());
    }

    fn json_str(s: &str) -> Value {
        Value::String(s.to_string())
    }

    #[test]
    fn model_paths_stay_inside_the_tree() {
        assert!(rel_path("/vendor/x/y.scad").is_ok());
        assert!(rel_path("/../etc/passwd").is_err());
        assert!(rel_path("/a/../../b").is_err());
        assert!(rel_path("").is_err());
    }

    #[test]
    fn stages_from_openscad_output() {
        assert_eq!(stage_for("Parsing design (AST generation)..."), Some("Parsing…"));
        assert_eq!(stage_for("Rendering Polygon Mesh using Manifold..."), Some("Rendering…"));
        assert_eq!(stage_for("ECHO: 1"), None);
    }

    #[test]
    fn triangle_count() {
        let mut stl = vec![0u8; 84];
        stl[80..84].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(stl_triangles(&stl), Some(12));
        assert_eq!(stl_triangles(&[0u8; 10]), None);
    }
}
