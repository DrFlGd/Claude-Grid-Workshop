// SCAD Workshop desktop app: the website's front end in a window, with
// native OpenSCAD and the workspace folder behind web/platform-desktop.js.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use workshop_core::render::default_concurrency;
use workshop_core::store::FileStore;
use workshop_core::workspace::AppConfig;
use workshop_core::{NativeEngine, RenderRequest, Renderer, SiteDir, Workspace};

struct AppState {
    site: SiteDir,
    engine_bundle: PathBuf,
    engine_scratch: PathBuf,
    config_path: PathBuf,
    engine: tokio::sync::OnceCell<Result<NativeEngine, String>>,
    workspace: Mutex<Option<(Workspace, Arc<FileStore>)>>,
    renderer: tokio::sync::Mutex<Option<Arc<Renderer>>>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl AppState {
    async fn engine(&self) -> Result<NativeEngine, String> {
        self.engine
            .get_or_init(|| async {
                NativeEngine::prepare(&self.engine_bundle, &self.engine_scratch).await.map_err(|e| format!("{e:#}"))
            })
            .await
            .clone()
    }

    fn config(&self) -> AppConfig {
        AppConfig::load(&self.config_path)
    }

    fn workspace(&self) -> Result<(Workspace, Arc<FileStore>), String> {
        let mut g = self.workspace.lock().unwrap();
        if let Some((ws, st)) = g.as_ref() {
            return Ok((ws.clone(), st.clone()));
        }
        let ws = Workspace::open(self.config().workspace_path()).map_err(|e| format!("{e:#}"))?;
        let st = Arc::new(FileStore::new(&ws));
        *g = Some((ws.clone(), st.clone()));
        Ok((ws, st))
    }

    async fn renderer(&self) -> Result<Arc<Renderer>, String> {
        let mut g = self.renderer.lock().await;
        if let Some(r) = g.as_ref() {
            return Ok(r.clone());
        }
        let engine = self.engine().await?;
        let (ws, _) = self.workspace()?;
        let jobs = self.config().concurrency.unwrap_or_else(default_concurrency);
        let r = Arc::new(Renderer::new(engine, self.site.clone(), ws.cache_dir(), jobs).map_err(|e| format!("{e:#}"))?);
        *g = Some(r.clone());
        Ok(r)
    }

    /// Forget the open workspace (after the user picks another folder).
    async fn reset(&self) {
        *self.workspace.lock().unwrap() = None;
        *self.renderer.lock().await = None;
    }
}

#[tauri::command]
async fn app_info(state: State<'_, AppState>) -> Result<Value, String> {
    let engine = state.engine().await;
    let ws = state.workspace();
    let renderer = state.renderer().await.ok();
    Ok(json!({
        "os": std::env::consts::OS,
        "engine": engine.as_ref().ok().map(|e| e.version.clone()),
        "engine_path": engine.as_ref().ok().map(|e| e.exe.display().to_string()),
        "engine_error": engine.err(),
        "workspace": ws.as_ref().ok().map(|(w, _)| w.root().display().to_string()),
        "workspace_error": ws.err(),
        "concurrency": renderer.as_ref().map(|r| r.concurrency()),
        "cache_bytes": renderer.as_ref().map(|r| r.cache_size()),
    }))
}

/// A file from the bundled site (data/, parts/), as raw bytes.
#[tauri::command]
async fn site_read(path: String, state: State<'_, AppState>) -> Result<Response, String> {
    let site = state.site.clone();
    let bytes = tokio::task::spawn_blocking(move || site.read(&path)).await.map_err(err)?.map_err(|e| format!("{e:#}"))?;
    Ok(Response::new(bytes))
}

/// Render with native OpenSCAD. Progress and log lines go to `on_event`; the result is the STL.
#[tauri::command]
async fn render(job: String, req: RenderRequest, on_event: Channel<Value>, state: State<'_, AppState>) -> Result<Response, Value> {
    let r = state.renderer().await.map_err(|e| json!({ "message": e, "cancelled": false, "logs": [] }))?;
    let ch = on_event.clone();
    let res = r
        .render(&job, &req, move |ev| {
            let _ = ch.send(serde_json::to_value(ev).unwrap_or(Value::Null));
        })
        .await;
    match res {
        Ok(out) => {
            let tail: Vec<&String> = out.logs.iter().rev().take(200).rev().collect();
            let _ = on_event.send(json!({ "type": "done", "ms": out.ms, "cached": out.cached, "logs": tail }));
            Ok(Response::new(out.stl))
        }
        Err(e) => Err(serde_json::to_value(&e).unwrap_or_else(|_| json!({ "message": e.message }))),
    }
}

#[tauri::command]
async fn render_cancel(job: String, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.renderer.lock().await.as_ref().map(|r| r.cancel(&job)).unwrap_or(false))
}

#[tauri::command]
fn settings_list(model: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    state.workspace()?.1.list(&model).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn settings_get(id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    state.workspace()?.1.get(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn settings_put(record: Value, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace()?.1.put(&record).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn settings_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace()?.1.remove(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn prefs_get(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.workspace()?.1.prefs())
}

#[tauri::command]
fn prefs_set(prefs: Value, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace()?.1.set_prefs(&prefs).map_err(|e| format!("{e:#}"))
}

fn percent_decode(s: &str) -> String {
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

/// Ask where to save, then write the bytes sent as the request body. The file
/// name comes in the `x-name` header (URI-encoded). Returns the saved path.
#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("No file data was sent.".into()),
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "model.stl".into());
    let state = app.state::<AppState>();
    let mut cfg = state.config();
    let mut dialog = app.dialog().file().set_file_name(&name).set_title("Save");
    if let Some(dir) = cfg.last_save_dir.clone().filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(ext) = name.rsplit_once('.').map(|(_, e)| e.to_string()) {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    std::fs::write(&path, data).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    cfg.last_save_dir = path.parent().map(|p| p.to_path_buf());
    let _ = cfg.save(&state.config_path);
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(PathBuf::from(path)).map_err(err)
}

#[tauri::command]
fn workspace_open(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (ws, _) = state.workspace()?;
    app.opener().open_path(ws.root().display().to_string(), None::<&str>).map_err(err)
}

#[tauri::command]
async fn workspace_choose(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().set_title("Choose a workspace folder").blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = picked.into_path().map_err(err)?;
    Workspace::open(&dir).map_err(|e| format!("{e:#}"))?;
    let mut cfg = state.config();
    cfg.workspace = Some(dir.clone());
    cfg.save(&state.config_path).map_err(|e| format!("{e:#}"))?;
    state.reset().await;
    Ok(Some(dir.display().to_string()))
}

#[tauri::command]
async fn cache_clear(state: State<'_, AppState>) -> Result<u64, String> {
    let r = state.renderer().await?;
    tokio::task::spawn_blocking(move || r.clear_cache()).await.map_err(err)?.map_err(|e| format!("{e:#}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            // development overrides: WORKSHOP_SITE=_site WORKSHOP_ENGINE=<dir with OpenSCAD>
            let site = std::env::var_os("WORKSHOP_SITE").map(PathBuf::from).unwrap_or_else(|| resources.join("site"));
            let engine = std::env::var_os("WORKSHOP_ENGINE").map(PathBuf::from).unwrap_or_else(|| resources.join("engine"));
            app.manage(AppState {
                site: SiteDir::new(site)?,
                engine_bundle: engine,
                engine_scratch: app.path().app_local_data_dir()?.join("engine"),
                config_path: app.path().app_config_dir()?.join("config.json"),
                engine: tokio::sync::OnceCell::new(),
                workspace: Mutex::new(None),
                renderer: tokio::sync::Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            site_read,
            render,
            render_cancel,
            settings_list,
            settings_get,
            settings_put,
            settings_remove,
            prefs_get,
            prefs_set,
            save_file,
            reveal,
            workspace_open,
            workspace_choose,
            cache_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SCAD Workshop");
}
