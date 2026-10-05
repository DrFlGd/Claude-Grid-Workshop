//! Command-line access to the desktop app's render path (same code, no window).
//!
//!   workshop-cli version --engine <dir|exe>
//!   workshop-cli render  --site _site --engine <dir|exe> --model family/model --out part.stl [--set name=<json>]...
//!   workshop-cli bench   --site _site --engine <dir|exe> [--out bench-native.json] [--jobs N] [--timeout S] [keys...]
//!   workshop-cli site-prepare --repo . --out _site [--desktop] [--public] [--hide-blocked]
//!   workshop-cli site-finish  --repo . --out _site --params raw.json --engine-version V [--native-engine <dir|exe>]
//!
//! `bench` renders every model in the site (including desktop-only ones) with
//! default settings and a fresh cache, like `tools/engine/cli.mjs bench` does for
//! the WebAssembly engine, and exits non-zero if any fails.
//!
//! `site-prepare` and `site-finish` are the catalog steps of tools/build_site.py:
//! the same project reading (files, settings, metadata) as the app's library ingest.

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
    match cmd.as_str() {
        "site-prepare" => return site_prepare(a),
        "site-finish" => return site_finish(a).await,
        _ => {}
    }
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
    // pass 1 is a first render (model files laid out fresh); pass 2 repeats it with the
    // files already prepared, like any later render in the app (the result cache is off)
    let passes: usize = a.flag("--passes").map(|t| t.parse()).transpose()?.unwrap_or(2).max(1);
    let cache = std::env::temp_dir().join(format!("workshop-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);
    let catalog = site.catalog()?;
    let mut keys: Vec<String> = a.rest.clone();
    if keys.is_empty() {
        keys = catalog["models"].as_array().into_iter().flatten().filter_map(|m| m["key"].as_str().map(String::from)).collect();
    }
    let version = engine.version.clone();
    let mut r = Renderer::new(engine, site.clone(), cache.clone(), jobs)?;
    r.use_cache = false;
    let renderer = Arc::new(r);
    let common = catalog["common_files"].clone();

    let mut results: Vec<Value> = vec![];
    for pass in 0..passes {
        let mut handles = vec![];
        for key in &keys {
            let key = key.clone();
            let renderer = renderer.clone();
            let model = site.model(&key)?;
            let req = default_request(&model, &common)?;
            let desktop_only = model["browser"].as_bool() == Some(false);
            handles.push(tokio::spawn(async move {
                let t0 = Instant::now();
                let job = format!("bench-{pass}-{}", key.replace('/', "-"));
                let r = tokio::time::timeout(timeout, renderer.render(&job, &req, |_| {})).await;
                let secs = |ms: f64| (ms / 10.0).round() / 100.0;
                let (status, stl, logs, error, seconds, prepare) = match r {
                    Ok(Ok(o)) => ("pass", o.stl, o.logs, None, secs(o.ms as f64), secs(o.prepare_ms as f64)),
                    Ok(Err(e)) => ("fail", vec![], e.logs, Some(e.message), secs(t0.elapsed().as_millis() as f64), 0.0),
                    Err(_) => {
                        renderer.cancel(&job);
                        ("fail", vec![], vec![], Some(format!("timed out after {} s", timeout.as_secs())), timeout.as_secs_f64(), 0.0)
                    }
                };
                let warnings = logs.iter().filter(|l| l.starts_with("WARNING:")).count();
                let res = json!({
                    "id": key, "key": key, "status": status, "seconds": seconds, "prepare_seconds": prepare,
                    "bytes": stl.len(), "triangles": stl_triangles(&stl).unwrap_or(0), "warnings": warnings,
                    "desktop_only": desktop_only,
                    "error": error, "log_tail": if status == "pass" { Value::Null } else { json!(logs.iter().rev().take(15).rev().collect::<Vec<_>>()) },
                });
                eprintln!(
                    "{:<5} pass {} {:<44} {:>7}s (files {:>5}s)  {} tris{}",
                    status,
                    pass + 1,
                    key,
                    seconds,
                    prepare,
                    res["triangles"],
                    if desktop_only { "  (desktop only)" } else { "" }
                );
                res
            }));
        }
        let mut this_pass = vec![];
        for h in handles {
            this_pass.push(h.await?);
        }
        if pass == 0 {
            results = this_pass;
        } else {
            for (res, again) in results.iter_mut().zip(this_pass) {
                res["repeat_seconds"] = again["seconds"].clone();
                if again["status"] != "pass" {
                    res["status"] = again["status"].clone();
                    res["error"] = again["error"].clone();
                }
            }
        }
    }
    let failed = results.iter().filter(|r| r["status"] != "pass").count();
    let total = |k: &str| results.iter().filter_map(|r| r[k].as_f64()).sum::<f64>();
    let report = json!({
        "engine": version, "native": true, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "jobs": jobs, "passes": passes,
        "total_seconds": (total("seconds") * 100.0).round() / 100.0,
        "total_repeat_seconds": (total("repeat_seconds") * 100.0).round() / 100.0,
        "results": results,
    });
    if let Some(out) = out {
        std::fs::write(&out, serde_json::to_string_pretty(&report)? + "\n")?;
    }
    let _ = std::fs::remove_dir_all(&cache);
    eprintln!(
        "{} of {} passed; total {} s first render, {} s repeated",
        results.len() - failed,
        results.len(),
        report["total_seconds"],
        report["total_repeat_seconds"]
    );
    if failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}

/// Files and model stubs for every catalog model; writes <out>/.build/plan.json.
fn site_prepare(mut a: Args) -> Result<()> {
    let repo = PathBuf::from(a.need("--repo")?);
    let out = PathBuf::from(a.need("--out")?);
    let opts = workshop_core::sitebuild::PrepareOptions {
        public: a.rest.iter().any(|x| x == "--public"),
        hide_blocked: a.rest.iter().any(|x| x == "--hide-blocked"),
        desktop: a.rest.iter().any(|x| x == "--desktop"),
    };
    let plan = workshop_core::sitebuild::prepare(&repo, &out, &opts)?;
    std::fs::create_dir_all(out.join(".build"))?;
    std::fs::write(out.join(".build/plan.json"), serde_json::to_vec_pretty(&plan)?)?;
    let browser: Vec<&str> = plan.models.iter().filter(|m| m.browser).map(|m| m.key.as_str()).collect();
    println!("{}", browser.join("\n"));
    eprintln!("{} models ({} for the browser engine), {} problems", plan.models.len(), browser.len(), plan.problems.len());
    Ok(())
}

/// Model JSON and the catalog from the settings exports (desktop-only models read natively).
async fn site_finish(mut a: Args) -> Result<()> {
    let repo = PathBuf::from(a.need("--repo")?);
    let out = PathBuf::from(a.need("--out")?);
    let version = a.need("--engine-version")?;
    let plan: workshop_core::sitebuild::Plan = serde_json::from_slice(&std::fs::read(out.join(".build/plan.json"))?)?;
    let mut raw: serde_json::Map<String, Value> = match a.flag("--params") {
        Some(p) => serde_json::from_slice(&std::fs::read(&p).with_context(|| format!("couldn't read {p}"))?)?,
        None => Default::default(),
    };
    let native: Vec<_> = plan.models.iter().filter(|m| !m.browser).collect();
    if !native.is_empty() {
        let exe = a.flag("--native-engine").context("desktop-only models need --native-engine")?;
        let engine = NativeEngine::locate(&PathBuf::from(exe)).await?;
        let cache = out.join(".build/cache");
        let mut r = Renderer::new(engine, SiteDir::new(&out)?, cache, 2)?;
        r.use_cache = false;
        for m in native {
            let mut files = plan.common_files.clone();
            files.extend(m.files.clone());
            let req = workshop_core::RenderRequest { model: m.key.clone(), entry: m.entry.clone(), files, values: Default::default(), defines: vec![] };
            let v = match r.export_params(&req).await {
                Ok(v) => v,
                Err(e) => json!({ "error": format!("{}\n{}", e.message, e.logs.join("\n")) }),
            };
            raw.insert(m.key.clone(), v);
        }
    }
    let problems = workshop_core::sitebuild::finish(&repo, &out, &plan, &raw, &version)?;
    for p in &problems {
        eprintln!("PROBLEM: {p}");
    }
    if !problems.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
