//! Command-line access to the desktop app's render path (same code, no window).
//!
//!   workshop-cli version --engine <dir|exe>
//!   workshop-cli render  --site _site --engine <dir|exe> --model family/model --out part.stl [--set name=<json>]...
//!   workshop-cli bench   --site _site --engine <dir|exe> [--out bench-native.json] [--jobs N] [--timeout S] [keys...]
//!
//! `bench` renders every model in the site (including desktop-only ones) with
//! default settings and a fresh cache, like `tools/engine/cli.mjs bench` does for
//! the WebAssembly engine, and exits non-zero if any fails.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use workshop_core::render::{default_request, stl_triangles};
use workshop_core::{NativeEngine, Renderer, SiteDir};

struct Args {
    rest: Vec<String>,
}

impl Args {
    fn flag(&mut self, name: &str) -> Option<String> {
        let i = self.rest.iter().position(|a| a == name)?;
        if i + 1 >= self.rest.len() {
            return None;
        }
        let v = self.rest.remove(i + 1);
        self.rest.remove(i);
        Some(v)
    }
    fn flags(&mut self, name: &str) -> Vec<String> {
        let mut v = vec![];
        while let Some(x) = self.flag(name) {
            v.push(x);
        }
        v
    }
    fn need(&mut self, name: &str) -> Result<String> {
        self.flag(name).with_context(|| format!("missing {name}"))
    }
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(2);
    }
}

async fn run() -> Result<()> {
    let mut all: Vec<String> = std::env::args().skip(1).collect();
    if all.is_empty() {
        bail!("usage: workshop-cli version|render|bench ...");
    }
    let cmd = all.remove(0);
    let mut a = Args { rest: all };
    let engine = NativeEngine::locate(&PathBuf::from(a.need("--engine")?)).await?;
    match cmd.as_str() {
        "version" => {
            println!("{} ({})", engine.version, engine.exe.display());
            Ok(())
        }
        "render" => {
            let site = SiteDir::new(a.need("--site")?)?;
            let key = a.need("--model")?;
            let out = PathBuf::from(a.need("--out")?);
            let cache = a.flag("--cache").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("workshop-cli-cache"));
            let sets = a.flags("--set");
            let model = site.model(&key)?;
            let mut req = default_request(&model, &site.catalog()?["common_files"])?;
            for s in sets {
                let (k, v) = s.split_once('=').context("--set needs name=value")?;
                let v: Value = serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.to_string()));
                req.values.insert(k.to_string(), v);
            }
            let r = Renderer::new(engine, site, cache, 1)?;
            let res = r
                .render("cli", &req, |ev| {
                    if let workshop_core::RenderEvent::Log { line } = ev {
                        eprintln!("{line}");
                    }
                })
                .await
                .map_err(|e| anyhow::anyhow!("{}", e.message))?;
            std::fs::write(&out, &res.stl)?;
            println!("{} triangles, {} ms{}", stl_triangles(&res.stl).unwrap_or(0), res.ms, if res.cached { " (cached)" } else { "" });
            Ok(())
        }
        "bench" => bench(engine, a).await,
        other => bail!("unknown command {other}"),
    }
}

async fn bench(engine: NativeEngine, mut a: Args) -> Result<()> {
    let site = SiteDir::new(a.need("--site")?)?;
    let out = a.flag("--out");
    let jobs: usize = a.flag("--jobs").map(|j| j.parse()).transpose()?.unwrap_or(1);
    let timeout = Duration::from_secs(a.flag("--timeout").map(|t| t.parse()).transpose()?.unwrap_or(900));
    let cache = std::env::temp_dir().join(format!("workshop-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);
    let catalog = site.catalog()?;
    let mut keys: Vec<String> = a.rest.clone();
    if keys.is_empty() {
        keys = catalog["models"].as_array().into_iter().flatten().filter_map(|m| m["key"].as_str().map(String::from)).collect();
    }
    let version = engine.version.clone();
    let renderer = Arc::new(Renderer::new(engine, site.clone(), cache.clone(), jobs)?);
    let common = catalog["common_files"].clone();

    let mut handles = vec![];
    for key in keys {
        let renderer = renderer.clone();
        let model = site.model(&key)?;
        let req = default_request(&model, &common)?;
        let desktop_only = model["browser"].as_bool() == Some(false);
        handles.push(tokio::spawn(async move {
            let t0 = Instant::now();
            let job = format!("bench-{}", key.replace('/', "-"));
            let r = tokio::time::timeout(timeout, renderer.render(&job, &req, |_| {})).await;
            let mut secs = (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0; // includes queueing
            let (status, stl, logs, error) = match r {
                Ok(Ok(o)) => {
                    secs = (o.ms as f64 / 10.0).round() / 100.0; // the render itself
                    ("pass", o.stl, o.logs, None)
                }
                Ok(Err(e)) => ("fail", vec![], e.logs, Some(e.message)),
                Err(_) => {
                    renderer.cancel(&job);
                    ("fail", vec![], vec![], Some(format!("timed out after {} s", timeout.as_secs())))
                }
            };
            let warnings = logs.iter().filter(|l| l.starts_with("WARNING:")).count();
            let res = json!({
                "id": key, "key": key, "status": status, "seconds": secs,
                "bytes": stl.len(), "triangles": stl_triangles(&stl).unwrap_or(0), "warnings": warnings,
                "desktop_only": desktop_only,
                "error": error, "log_tail": if status == "pass" { Value::Null } else { json!(logs.iter().rev().take(15).rev().collect::<Vec<_>>()) },
            });
            eprintln!(
                "{:<5} {:<44} {:>7}s  {} tris{}",
                status,
                key,
                secs,
                res["triangles"],
                if desktop_only { "  (desktop only)" } else { "" }
            );
            res
        }));
    }
    let mut results = vec![];
    for h in handles {
        results.push(h.await?);
    }
    let failed = results.iter().filter(|r| r["status"] != "pass").count();
    let report = json!({
        "engine": version, "native": true, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "jobs": jobs, "results": results,
    });
    if let Some(out) = out {
        std::fs::write(&out, serde_json::to_string_pretty(&report)? + "\n")?;
    }
    let _ = std::fs::remove_dir_all(&cache);
    eprintln!("{} of {} passed", report["results"].as_array().map(|r| r.len()).unwrap_or(0) - failed, report["results"].as_array().map(|r| r.len()).unwrap_or(0));
    if failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}
