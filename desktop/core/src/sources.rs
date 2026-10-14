//! Getting projects into the library: GitHub (a pinned commit, downloaded as
//! plain files, no git needed), ZIP files, folders (copied, or linked in place)
//! and the library's own local/ folder. Also GitHub update checks.

use crate::library::{self, slug, Library};
use crate::scan;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Downloads above this size stop (a GitHub repository with large assets, say).
pub const MAX_DOWNLOAD: u64 = 500 << 20;

// ------------------------------------------------------------------ GitHub

#[derive(Clone, Debug, PartialEq)]
pub struct GitHubUrl {
    pub owner: String,
    pub repo: String,
    /// Branch, tag or commit from the URL (None: the default branch).
    pub reference: Option<String>,
    /// Subfolder from a /tree/<ref>/<folder> URL.
    pub subdir: String,
}

/// "https://github.com/o/r", ".../tree/<ref>/<folder>", ".../commit/<sha>",
/// "git@github.com:o/r.git" or "o/r".
pub fn parse_github_url(url: &str) -> Result<GitHubUrl> {
    let u = url.trim().trim_end_matches('/');
    let rest = if let Some(r) = u.strip_prefix("git@github.com:") {
        r.to_string()
    } else if let Some(i) = u.find("github.com/") {
        u[i + "github.com/".len()..].to_string()
    } else if u.split('/').count() == 2 && !u.contains(':') && !u.contains(' ') {
        u.to_string()
    } else {
        bail!("That doesn't look like a GitHub repository link (https://github.com/owner/repository).");
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("").to_string();
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        bail!("The link needs both the owner and the repository: https://github.com/owner/repository");
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok(&owner) || !ok(&repo) {
        bail!("{owner}/{repo} isn't a valid GitHub repository name");
    }
    let (mut reference, mut subdir) = (None, String::new());
    if parts.len() >= 4 && (parts[2] == "tree" || parts[2] == "blob" || parts[2] == "commit") {
        reference = Some(parts[3].to_string());
        if parts[2] == "tree" && parts.len() > 4 {
            subdir = parts[4..].join("/");
        }
    } else if parts.len() >= 5 && parts[2] == "releases" && parts[3] == "tag" {
        // ".../releases/tag/v2.0": a release's page
        reference = Some(parts[4].to_string());
    }
    Ok(GitHubUrl { owner, repo, reference, subdir })
}

pub fn is_commit_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub struct GitHub {
    api: String,
    token: Option<String>,
    agent: ureq::Agent,
}

impl GitHub {
    /// `WORKSHOP_GITHUB_API` replaces https://api.github.com (tests use a local server).
    pub fn new(token: Option<String>) -> Self {
        let api = std::env::var("WORKSHOP_GITHUB_API").unwrap_or_else(|_| "https://api.github.com".into());
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(20))
            .timeout_read(std::time::Duration::from_secs(120))
            .try_proxy_from_env(true)
            .user_agent(&format!("SCAD-Workshop/{}", crate::VERSION))
            .build();
        Self { api: api.trim_end_matches('/').to_string(), token, agent }
    }

    fn request(&self, path: &str) -> ureq::Request {
        let mut r = self.agent.get(&format!("{}{}", self.api, path)).set("Accept", "application/vnd.github+json");
        if let Some(t) = &self.token {
            r = r.set("Authorization", &format!("Bearer {t}"));
        }
        r
    }

    fn explain(e: ureq::Error, what: &str) -> anyhow::Error {
        match e {
            ureq::Error::Status(404, _) => anyhow!("GitHub says {what} doesn't exist (or is private: add a GitHub token in Settings)."),
            ureq::Error::Status(401, _) => anyhow!("GitHub didn't accept the token in Settings."),
            ureq::Error::Status(403 | 429, r) => {
                let reset = r.header("x-ratelimit-reset").and_then(|v| v.parse::<i64>().ok());
                match reset {
                    Some(t) => anyhow!("GitHub's hourly request limit is used up (until {} UTC). A GitHub token in Settings raises it.", &library::iso_from_unix(t)[11..16]),
                    None => anyhow!("GitHub refused the request ({what})."),
                }
            }
            ureq::Error::Status(code, _) => anyhow!("GitHub answered {code} for {what}."),
            ureq::Error::Transport(t) => anyhow!("Couldn't reach GitHub: {t}"),
        }
    }

    pub fn get_json(&self, path: &str, what: &str) -> Result<Value> {
        let r = self.request(path).call().map_err(|e| Self::explain(e, what))?;
        let text = r.into_string().with_context(|| format!("couldn't read GitHub's answer for {what}"))?;
        serde_json::from_str(&text).with_context(|| format!("GitHub's answer for {what} wasn't JSON"))
    }

    /// Download to a file, at most [`MAX_DOWNLOAD`] bytes.
    pub fn download(&self, path: &str, dest: &Path, what: &str) -> Result<u64> {
        let r = self.request(path).call().map_err(|e| Self::explain(e, what))?;
        let mut reader = r.into_reader().take(MAX_DOWNLOAD + 1);
        let mut f = std::fs::File::create(dest).with_context(|| format!("couldn't create {}", dest.display()))?;
        let n = std::io::copy(&mut reader, &mut f)?;
        if n > MAX_DOWNLOAD {
            let _ = std::fs::remove_file(dest);
            bail!("{what} is over {} MB; download it as a ZIP and add only the folders you need.", MAX_DOWNLOAD >> 20);
        }
        Ok(n)
    }
}

/// A repository's details and one commit, from GitHub's API.
pub struct Resolved {
    pub repo: Value,
    pub commit_sha: String,
    pub commit_date: String,
    pub commit_message: String,
    /// What updates follow: "branch:<name>" or "releases".
    pub track: String,
    /// The tag the address named, when it named one.
    pub tag: Option<String>,
}

pub fn resolve_github(gh: &GitHub, u: &GitHubUrl, releases: bool) -> Result<Resolved> {
    let repo = gh.get_json(&format!("/repos/{}/{}", u.owner, u.repo), &format!("{}/{}", u.owner, u.repo))?;
    let default_branch = repo["default_branch"].as_str().unwrap_or("main").to_string();
    let reference = u.reference.clone().unwrap_or_else(|| default_branch.clone());
    let commit = gh.get_json(&format!("/repos/{}/{}/commits/{}", u.owner, u.repo, reference), &format!("{reference} in {}/{}", u.owner, u.repo))?;
    let sha = commit["sha"].as_str().context("GitHub returned no commit id")?.to_string();
    let is_commit = is_commit_sha(&reference) || reference.len() >= 7 && sha.starts_with(&reference);
    // a named reference that isn't a commit is a branch when GitHub has a branch by that name
    let is_branch = !is_commit && (reference == default_branch || gh.get_json(&format!("/repos/{}/{}/branches/{}", u.owner, u.repo, reference), "a branch").is_ok());
    let track = if releases { "releases".to_string() } else if is_branch { format!("branch:{reference}") } else { format!("branch:{default_branch}") };
    let tag = (!is_commit && !is_branch).then(|| reference.clone());
    Ok(Resolved {
        tag,
        commit_date: commit["commit"]["committer"]["date"].as_str().unwrap_or("").to_string(),
        commit_message: commit["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string(),
        commit_sha: sha,
        repo,
        track,
    })
}

// ------------------------------------------------------------------ archives

/// Keep only regular files with plain relative paths (no "..", no absolute paths, no links).
fn safe_rel(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Strip `prefix` (a top folder, then an optional subfolder) from an archive path.
fn under(path: &Path, strip_top: bool, subdir: &str) -> Option<PathBuf> {
    let mut comps: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if strip_top {
        if comps.len() < 2 {
            return None;
        }
        comps.remove(0);
    }
    for want in subdir.split('/').filter(|s| !s.is_empty()) {
        if comps.first().map(String::as_str) != Some(want) {
            return None;
        }
        comps.remove(0);
    }
    if comps.is_empty() {
        return None;
    }
    safe_rel(&comps.iter().collect::<PathBuf>())
}

/// Unpack a GitHub tarball (.tar.gz with one top folder) into `dest`.
pub fn extract_tarball(archive: &Path, dest: &Path, subdir: &str) -> Result<usize> {
    let f = std::fs::File::open(archive)?;
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let mut n = 0;
    for entry in ar.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let Some(rel) = under(&path, true, subdir) else { continue };
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut w = std::fs::File::create(&out).with_context(|| format!("couldn't write {}", out.display()))?;
        std::io::copy(&mut entry, &mut w)?;
        n += 1;
    }
    if n == 0 {
        bail!("The download had no files{}.", if subdir.is_empty() { String::new() } else { format!(" in {subdir}") });
    }
    Ok(n)
}

/// Unpack a ZIP into `dest`. A single top folder holding everything is removed.
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<usize> {
    let f = std::fs::File::open(archive).with_context(|| format!("couldn't open {}", archive.display()))?;
    let mut z = zip::ZipArchive::new(f).context("That isn't a ZIP file this app can read.")?;
    let mut names = vec![];
    for i in 0..z.len() {
        let e = z.by_index(i)?;
        if e.is_file() {
            if let Some(p) = e.enclosed_name() {
                names.push(p);
            }
        }
    }
    let tops: std::collections::BTreeSet<String> =
        names.iter().filter_map(|p| p.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned())).collect();
    let strip_top = tops.len() == 1 && names.iter().all(|p| p.components().count() > 1);
    let mut n = 0;
    let mut total: u64 = 0;
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        if !e.is_file() || e.is_symlink() {
            continue;
        }
        let Some(p) = e.enclosed_name() else { continue };
        if p.components().any(|c| c.as_os_str() == "__MACOSX") {
            continue;
        }
        let Some(rel) = under(&p, strip_top, "") else { continue };
        total += e.size();
        if total > MAX_DOWNLOAD * 4 {
            bail!("The ZIP unpacks to over {} MB.", (MAX_DOWNLOAD * 4) >> 20);
        }
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut w = std::fs::File::create(&out).with_context(|| format!("couldn't write {}", out.display()))?;
        std::io::copy(&mut e, &mut w)?;
        n += 1;
    }
    if n == 0 {
        bail!("The ZIP has no files.");
    }
    Ok(n)
}

/// Copy a folder (skipping tool folders like .git). Returns the number of files.
pub fn copy_folder(from: &Path, to: &Path) -> Result<usize> {
    let files = scan::list_files(from);
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    if total > MAX_DOWNLOAD * 4 {
        bail!("That folder holds over {} MB; link it instead of copying it.", (MAX_DOWNLOAD * 4) >> 20);
    }
    for f in &files {
        let dst = to.join(&f.rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from.join(&f.rel), &dst).with_context(|| format!("couldn't copy {}", f.rel))?;
    }
    Ok(files.len())
}

/// SHA-256 of a file, as hex.
pub fn sha256_file(p: &Path) -> Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Build a version folder in a temporary place, then move it into files/<version>.
pub fn install_version(lib: &Library, id: &str, version: &str, fill: impl FnOnce(&Path) -> Result<usize>) -> Result<(PathBuf, usize)> {
    let files = lib.source_dir(id)?.join("files");
    std::fs::create_dir_all(&files)?;
    let target = files.join(version);
    if target.is_dir() {
        return Ok((target, 0)); // already there (re-adding the same version)
    }
    let tmp = files.join(format!(".{version}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let n = match fill(&tmp) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    std::fs::rename(&tmp, &target).with_context(|| format!("couldn't move the files into {}", target.display()))?;
    Ok((target, n))
}

/// What the user asked to add.
#[derive(Clone, Debug)]
pub enum AddRequest {
    /// `releases`: the address named a tag or commit and updates are its newer releases, not the
    /// branch (F-11); otherwise a branch named in the address, or the default branch, is followed.
    GitHub { url: String, releases: bool },
    Zip { path: PathBuf },
    Folder { path: PathBuf, link: bool },
}

/// Detected details shared by every kind of source.
fn detected(name: &str, summary: &str, license: Option<String>, authors: Value, tags: Value, url: Option<&str>) -> Value {
    json!({
        "name": name, "summary": summary,
        "license": license.as_ref().map(|s| json!({ "spdx": s, "public_use": scan::public_use(Some(s)) }))
            .unwrap_or_else(|| json!({ "spdx": "NOASSERTION", "public_use": "review" })),
        "authors": authors, "tags": tags, "origin": url,
    })
}

/// Add a project: download or copy its files into a new version folder and
/// write source.json. (Reading its models is a separate step, which needs OpenSCAD.)
pub fn add(lib: &Library, req: &AddRequest, role: &str, token: Option<String>) -> Result<Value> {
    lib.writable()?;
    let now = library::now();
    match req {
        AddRequest::GitHub { url, releases } => {
            let u = parse_github_url(url)?;
            let gh = GitHub::new(token);
            let r = resolve_github(&gh, &u, *releases)?;
            let base = if u.subdir.is_empty() { format!("{} {}", u.owner, u.repo) } else { format!("{} {} {}", u.owner, u.repo, u.subdir) };
            if let Some(existing) = lib.source_ids().into_iter().find(|id| {
                lib.source(id).is_ok_and(|s| {
                    s["origin"]["owner"].as_str().is_some_and(|o| o.eq_ignore_ascii_case(&u.owner))
                        && s["origin"]["repo"].as_str().is_some_and(|o| o.eq_ignore_ascii_case(&u.repo))
                        && s["origin"]["subdir"].as_str().unwrap_or("") == u.subdir
                })
            }) {
                bail!("{}/{} is already in the library ({existing}).", u.owner, u.repo); // (the page offers to open it)
            }
            let id = lib.new_source_id(&format!("github {base}"));
            let version = r.commit_sha[..12].to_string();
            let what = format!("{}/{}", u.owner, u.repo);
            let (_, n) = install_version(lib, &id, &version, |tmp| {
                let archive = tmp.with_extension("tar.gz");
                gh.download(&format!("/repos/{}/{}/tarball/{}", u.owner, u.repo, r.commit_sha), &archive, &what)?;
                let n = extract_tarball(&archive, tmp, &u.subdir);
                let _ = std::fs::remove_file(&archive);
                n
            })?;
            let root = lib.source_dir(&id)?.join("files").join(&version);
            let repo = &r.repo;
            let html = repo["html_url"].as_str().map(String::from).unwrap_or_else(|| format!("https://github.com/{}/{}", u.owner, u.repo));
            let license = repo["license"]["spdx_id"].as_str().filter(|s| *s != "NOASSERTION" && !s.is_empty()).map(String::from)
                .or_else(|| scan::survey_license(&root));
            let summary = repo["description"].as_str().filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| scan::readme_text(&root).map(|t| scan::readme_summary(&t)).unwrap_or_default());
            // "gridfinity_openscad" -> "Gridfinity openscad" (names like "BOSL2" stay as they are)
            let pretty = scan::humanize(&u.repo);
            let name = if u.subdir.is_empty() { pretty } else { format!("{pretty} ({})", u.subdir) };
            let owner = &repo["owner"];
            let authors = json!([{ "name": owner["login"].as_str().unwrap_or(&u.owner), "url": owner["html_url"] }]);
            let tags = repo["topics"].clone();
            let src = json!({
                "id": id, "kind": "github", "role": role, "added": now,
                // track: "branch:<name>" (follow it) or "releases" (newer tags); added_from: the branch,
                // tag or commit the address named, as history
                "origin": { "type": "github", "url": html, "owner": u.owner, "repo": u.repo, "track": r.track, "subdir": u.subdir, "added_from": u.reference },
                "version": version, "version_date": r.commit_date,
                "versions": [{ "id": version, "commit": r.commit_sha, "date": r.commit_date, "message": r.commit_message, "added": now, "files": n, "tag": r.tag }],
                "detected": detected(&name, &summary, license, authors, if tags.is_array() { tags } else { json!([]) }, Some(&html)),
            });
            // a project the app has described before (a starter project's repository): its description,
            // which says which files are models and what they're called (F-1)
            if let Some(known) = u.subdir.is_empty().then(|| known_on_github(&u.owner, &u.repo)).flatten() {
                crate::config::write_json(&lib.source_dir(&id)?.join("description.json"), &known.description)?;
            }
            lib.save_source(&src)?;
            Ok(src)
        }
        AddRequest::Zip { path } => {
            let sha = sha256_file(path).with_context(|| format!("couldn't read {}", path.display()))?;
            if let Some((id, name)) = same_origin(lib, |s| s["kind"] == "zip" && s["versions"].as_array().into_iter().flatten().any(|v| v["sha256"] == sha.as_str())) {
                bail!("{name} is already in the library, from the same ZIP file ({id}).");
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
            let id = lib.new_source_id(&format!("zip {stem}"));
            let version = format!("zip-{}", &sha[..12]);
            let (root, n) = install_version(lib, &id, &version, |tmp| extract_zip(path, tmp))?;
            let file_name = path.file_name().map(|s| s.to_string_lossy().into_owned());
            let src = json!({
                "id": id, "kind": "zip", "role": role, "added": now,
                "origin": { "type": "zip", "file": file_name },
                "version": version, "version_date": now,
                "versions": [{ "id": version, "sha256": sha, "date": now, "added": now, "files": n }],
                "detected": detected(&scan::humanize(&stem), &scan::readme_text(&root).map(|t| scan::readme_summary(&t)).unwrap_or_default(),
                    scan::survey_license(&root), json!([]), json!([]), None),
            });
            lib.save_source(&src)?;
            Ok(src)
        }
        AddRequest::Folder { path, link } => {
            if !path.is_dir() {
                bail!("{} isn't a folder.", path.display());
            }
            let path = path.canonicalize().unwrap_or_else(|_| path.clone());
            if path.starts_with(lib.root()) {
                bail!("That folder is inside the library already. Put your own projects in its local/ folder instead.");
            }
            let shown = path.display().to_string();
            if let Some((id, name)) = same_origin(lib, |s| (s["kind"] == "folder" || s["kind"] == "linked") && s["origin"]["path"] == shown.as_str()) {
                bail!("{name} is already in the library, from the same folder ({id}).");
            }
            let stem = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
            let id = lib.new_source_id(&format!("{} {stem}", if *link { "linked" } else { "folder" }));
            let (kind, version, origin, root) = if *link {
                let fp = scan::fingerprint(&path);
                (
                    "linked",
                    format!("live-{fp}"),
                    json!({ "type": "linked", "path": path.display().to_string() }),
                    path.clone(),
                )
            } else {
                let fp = scan::fingerprint(&path);
                let version = format!("copy-{fp}");
                let (root, _) = install_version(lib, &id, &version, |tmp| copy_folder(&path, tmp))?;
                ("folder", version, json!({ "type": "folder", "path": path.display().to_string() }), root)
            };
            let src = json!({
                "id": id, "kind": kind, "role": role, "added": now, "origin": origin,
                "version": version, "version_date": now,
                "versions": [{ "id": version, "date": now, "added": now }],
                "detected": detected(&scan::humanize(&stem), &scan::readme_text(&root).map(|t| scan::readme_summary(&t)).unwrap_or_default(),
                    scan::survey_license(&root), json!([]), json!([]), None),
            });
            lib.save_source(&src)?;
            Ok(src)
        }
    }
}

/// The project already in the library that `same` picks out: (id, name).
fn same_origin(lib: &Library, same: impl Fn(&Value) -> bool) -> Option<(String, String)> {
    lib.source_ids().into_iter().find_map(|id| {
        let s = lib.source(&id).ok()?;
        same(&s).then(|| (id.clone(), s["detected"]["name"].as_str().unwrap_or(&id).to_string()))
    })
}

/// What every project's `origin.type` says it came from (F-3), by its kind.
pub fn origin_type(kind: &str) -> &'static str {
    match kind {
        "github" => "github",
        "zip" => "zip",
        "folder" => "folder",
        "linked" => "linked",
        "local" => "local",
        "bundled" => "app",
        "pinned" => "pinned",
        _ => "other",
    }
}

/// Give projects added by older versions the fields every project now records: `origin.type`
/// (F-3), and `date` and `added` on every version (F-2; `files` and `content` are filled in when
/// a version is read). Returns the ids changed.
pub fn normalise(lib: &Library) -> Result<Vec<String>> {
    if lib.read_only().is_some() {
        return Ok(vec![]);
    }
    let mut changed = vec![];
    for id in lib.source_ids() {
        let Ok(mut s) = lib.source(&id) else { continue };
        let before = s.clone();
        if !s["origin"].is_object() {
            s["origin"] = json!({});
        }
        if s["origin"]["type"].is_null() {
            s["origin"]["type"] = json!(origin_type(s["kind"].as_str().unwrap_or("")));
        }
        // (0.4.9) a GitHub project's origin: `requested` became `added_from` (history, not a target),
        // and `track` says what it follows ("branch:<name>" or "releases")
        if s["kind"] == "github" {
            if let Some(o) = s["origin"].as_object_mut() {
                if let Some(r) = o.remove("requested") {
                    o.entry("added_from").or_insert(r);
                }
                if let Some(t) = o.get("track").and_then(Value::as_str).filter(|t| *t != "releases" && !t.starts_with("branch:")).map(String::from) {
                    o.insert("track".into(), json!(format!("branch:{t}")));
                }
            }
        }
        let fallback = s["version_date"].clone();
        let added = s["added"].clone();
        let kind = s["kind"].as_str().unwrap_or("").to_string();
        let src_now = s.clone();
        for v in s["versions"].as_array_mut().into_iter().flatten() {
            if v["date"].is_null() {
                v["date"] = fallback.clone();
            }
            if v["added"].is_null() {
                v["added"] = added.clone();
            }
            // (projects read before 0.4.7: what Scan for changes kept, and a count of the files)
            let vid = v["id"].as_str().unwrap_or("").to_string();
            if v["content"].is_null() {
                if let Some(fp) = lib.derived(&id, &vid).and_then(|d| d["files_fp"].as_str().map(String::from)) {
                    v["content"] = json!(fp);
                }
            }
            if v["files"].is_null() && kind != "pinned" {
                if let Some(dir) = lib.version_dir(&src_now, &vid).ok().filter(|d| d.is_dir()) {
                    v["files"] = json!(scan::list_files(&dir).len());
                }
            }
        }
        if s != before {
            lib.save_source(&s)?;
            changed.push(id);
        }
    }
    Ok(changed)
}

/// Projects in the library's local/ folder get a source entry automatically;
/// ones whose files changed get a new version id. Returns ids that need reading.
pub fn sync_local(lib: &Library) -> Result<Vec<String>> {
    if lib.read_only().is_some() {
        return Ok(vec![]);
    }
    let mut changed = vec![];
    let local = lib.root().join("local");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&local)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    let known: Vec<Value> = lib.source_ids().into_iter().filter_map(|id| lib.source(&id).ok()).filter(|s| s["kind"] == "local").collect();
    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("local/{name}");
        let fp = format!("live-{}", scan::fingerprint(&dir));
        let now = library::now();
        match known.iter().find(|s| s["origin"]["path"] == rel.as_str()) {
            Some(s) if s["version"] == fp.as_str() => {}
            Some(s) => {
                let mut s = s.clone();
                s["version"] = json!(fp);
                s["version_date"] = json!(now);
                s["versions"] = json!([{ "id": fp, "date": now, "added": now }]);
                lib.save_source(&s)?;
                changed.push(s["id"].as_str().unwrap_or_default().to_string());
            }
            None => {
                let id = lib.new_source_id(&format!("local {name}"));
                let src = json!({
                    "id": id, "kind": "local", "role": "project", "added": now, "origin": { "type": "local", "path": rel },
                    "version": fp, "version_date": now, "versions": [{ "id": fp, "date": now, "added": now }],
                    "detected": detected(&scan::humanize(&name), &scan::readme_text(&dir).map(|t| scan::readme_summary(&t)).unwrap_or_default(),
                        scan::survey_license(&dir), json!([]), json!([]), None),
                });
                lib.save_source(&src)?;
                changed.push(id);
            }
        }
    }
    // linked folders edited in place
    for s in lib.source_ids().into_iter().filter_map(|id| lib.source(&id).ok()).filter(|s| s["kind"] == "linked") {
        let p = PathBuf::from(s["origin"]["path"].as_str().unwrap_or(""));
        if !p.is_dir() {
            continue; // shown under "Needs attention"
        }
        let fp = format!("live-{}", scan::fingerprint(&p));
        if s["version"] != fp.as_str() {
            let mut s = s.clone();
            let now = library::now();
            s["version"] = json!(fp);
            s["version_date"] = json!(now);
            s["versions"] = json!([{ "id": fp, "date": now, "added": now }]);
            lib.save_source(&s)?;
            changed.push(s["id"].as_str().unwrap_or_default().to_string());
        }
    }
    Ok(changed)
}

/// Ask GitHub whether the tracked branch moved. Downloads the new version (not
/// yet used) and returns (new version id, commits since) when it did.
pub fn fetch_update(lib: &Library, src: &Value, token: Option<String>) -> Result<Option<(String, Value)>> {
    if src["kind"] != "github" {
        return Ok(None);
    }
    let o = &src["origin"];
    let (owner, repo) = (o["owner"].as_str().unwrap_or(""), o["repo"].as_str().unwrap_or(""));
    // "branch:<name>", "releases", or (before 0.4.9) a plain branch name
    let track = o["track"].as_str().unwrap_or("main");
    let gh = GitHub::new(token);
    let what = format!("{owner}/{repo}");
    let current = src["version"].as_str().unwrap_or("");
    let current_date = src["versions"].as_array().into_iter().flatten().find(|v| v["id"] == current).and_then(|v| v["date"].as_str()).unwrap_or("").to_string();
    let (reference, tag) = if track == "releases" {
        match newest_release(&gh, owner, repo, &what)? {
            Some(t) => (t.clone(), Some(t)),
            None => return Ok(None),
        }
    } else {
        (track.strip_prefix("branch:").unwrap_or(track).to_string(), None)
    };
    let latest = gh.get_json(&format!("/repos/{owner}/{repo}/commits/{reference}"), &format!("{reference} in {what}"))?;
    let sha = latest["sha"].as_str().context("GitHub returned no commit id")?.to_string();
    let version = sha[..12].to_string();
    if version == current {
        return Ok(None);
    }
    // a release older than the version in use isn't an update
    let date = latest["commit"]["committer"]["date"].as_str().unwrap_or("");
    if tag.is_some() && !current_date.is_empty() && date <= current_date.as_str() {
        return Ok(None);
    }
    let current_sha = src["versions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["id"] == current)
        .and_then(|v| v["commit"].as_str())
        .unwrap_or(current)
        .to_string();
    let compare = gh.get_json(&format!("/repos/{owner}/{repo}/compare/{current_sha}...{sha}"), &format!("changes in {what}")).unwrap_or(json!({}));
    let commits: Vec<Value> = compare["commits"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .take(30)
        .map(|c| {
            json!({
                "sha": c["sha"].as_str().map(|s| &s[..7.min(s.len())]),
                "date": c["commit"]["committer"]["date"],
                "author": c["commit"]["author"]["name"],
                "message": c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""),
            })
        })
        .collect();
    let subdir = o["subdir"].as_str().unwrap_or("").to_string();
    let id = src["id"].as_str().unwrap_or("").to_string();
    let (_, n) = install_version(lib, &id, &version, |tmp| {
        let archive = tmp.with_extension("tar.gz");
        gh.download(&format!("/repos/{owner}/{repo}/tarball/{sha}"), &archive, &what)?;
        let n = extract_tarball(&archive, tmp, &subdir);
        let _ = std::fs::remove_file(&archive);
        n
    })?;
    let info = json!({
        "id": version, "commit": sha, "tag": tag,
        "date": latest["commit"]["committer"]["date"],
        "message": latest["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""),
        "files": n, "commits": commits,
        "ahead_by": compare["ahead_by"], "files_changed": compare["files"].as_array().map(|f| f.len()),
    });
    Ok(Some((version, info)))
}

/// The newest release's tag: GitHub's latest release, or when the project publishes none, the
/// highest version-numbered tag.
fn newest_release(gh: &GitHub, owner: &str, repo: &str, what: &str) -> Result<Option<String>> {
    if let Ok(r) = gh.get_json(&format!("/repos/{owner}/{repo}/releases/latest"), &format!("the latest release of {what}")) {
        if let Some(t) = r["tag_name"].as_str() {
            return Ok(Some(t.to_string()));
        }
    }
    let tags = gh.get_json(&format!("/repos/{owner}/{repo}/tags?per_page=100"), &format!("the tags of {what}"))?;
    Ok(tags.as_array().into_iter().flatten().filter_map(|t| t["name"].as_str()).max_by_key(|t| version_key(t)).map(String::from))
}

/// "v2.10.1" -> [2, 10, 1], for comparing release tags.
pub fn version_key(tag: &str) -> Vec<u64> {
    tag.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect()
}

/// Remove version folders nothing uses (not the current version or a pending update).
pub fn clean_versions(lib: &Library, src: &Value) -> Result<Vec<String>> {
    lib.writable()?;
    let id = src["id"].as_str().context("project has no id")?;
    let keep: Vec<&str> = [src["version"].as_str(), src["update"]["latest"]["id"].as_str()].into_iter().flatten().collect();
    let dir = lib.source_dir(id)?.join("files");
    let mut removed = vec![];
    for e in std::fs::read_dir(&dir).map(|rd| rd.flatten().collect::<Vec<_>>()).unwrap_or_default() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name.as_str()) && e.path().is_dir() {
            std::fs::remove_dir_all(e.path())?;
            let _ = std::fs::remove_file(lib.source_dir(id)?.join("derived").join(format!("{name}.json")));
            let _ = std::fs::remove_dir_all(lib.source_dir(id)?.join("docs").join(&name));
            let _ = std::fs::remove_dir_all(lib.source_dir(id)?.join("generated").join(&name));
            removed.push(name);
        }
    }
    Ok(removed)
}

// ------------------------------------------------------------------ starter projects (F-1)

/// Starter projects whose copy in the app is upstream's files as they are on GitHub, at the commit
/// their family manifest records. The others stay as they are: Honeycomb Storage Wall's first model
/// is a file from an older commit, GridFlock and Rugged Box need git submodules (and GridFlock a
/// generated file) that GitHub's download leaves out, openGrid uses the app's own adapter, and the
/// rest were supplied by the owner and aren't on GitHub.
const STARTER_ON_GITHUB: [(&str, &str); 6] = [
    ("cullenect-label", include_str!("../../../catalog/families/cullenect-label.json")),
    ("gridfinity-basket", include_str!("../../../catalog/families/gridfinity-basket.json")),
    ("gridfinity-extended", include_str!("../../../catalog/families/gridfinity-extended.json")),
    ("gridfinity-rebuilt", include_str!("../../../catalog/families/gridfinity-rebuilt.json")),
    ("label-generator-gridfinity", include_str!("../../../catalog/families/label-generator-gridfinity.json")),
    ("underware", include_str!("../../../catalog/families/underware.json")),
];

/// Where a starter project comes from on GitHub, and the description the app reads it with.
pub struct StarterOnGitHub {
    pub repository: String,
    pub commit: String,
    /// where upstream's files were in this repository ("vendor/gridfinity-rebuilt")
    pub vendor_path: String,
    /// workshop.json's shape, with paths in upstream's own layout
    pub description: Value,
}

pub fn starter_on_github(id: &str) -> Option<StarterOnGitHub> {
    let (_, text) = STARTER_ON_GITHUB.iter().find(|(i, _)| *i == id)?;
    let fam: Value = serde_json::from_str(text).ok()?;
    let s = &fam["source"];
    let vendor_path = s["vendor_path"].as_str()?.trim_end_matches('/').to_string();
    let mut d = serde_json::Map::new();
    d.insert("format".into(), json!(1));
    for k in ["name", "summary", "category", "tags", "license", "authors", "links", "ui"] {
        if !fam[k].is_null() {
            d.insert(k.into(), fam[k].clone());
        }
    }
    let mut models = vec![];
    for m in fam["models"].as_array()? {
        let rel = m["entrypoint"].as_str()?.strip_prefix(&format!("{vendor_path}/"))?;
        let mut o = m.as_object()?.clone();
        o.shift_remove("status");
        o.insert("entrypoint".into(), json!(rel));
        models.push(Value::Object(o));
    }
    d.insert("models".into(), json!(models));
    d.insert("made_by".into(), json!(format!("SCAD Workshop, from the family manifest of the app's copy (catalog/families/{id}.json)")));
    Some(StarterOnGitHub {
        repository: s["repository"].as_str()?.to_string(),
        commit: s["commit"].as_str()?.to_string(),
        vendor_path,
        description: Value::Object(d),
    })
}

/// The app's description of a GitHub repository it had a starter project from.
pub fn known_on_github(owner: &str, repo: &str) -> Option<StarterOnGitHub> {
    STARTER_ON_GITHUB.iter().filter_map(|(id, _)| starter_on_github(id)).find(|s| {
        parse_github_url(&s.repository).is_ok_and(|u| u.owner.eq_ignore_ascii_case(owner) && u.repo.eq_ignore_ascii_case(repo))
    })
}

/// Turn a starter project into a GitHub project (F-1): upstream's files at the commit the app's
/// copy came from go in files/<commit>, the app's description of it in description.json beside
/// them, and source.json becomes a GitHub project's (following the default branch), keeping its
/// id, saved settings, edits and thumbnails. Returns the source as it was, for undoing.
pub fn convert_starter(lib: &Library, id: &str, token: Option<String>) -> Result<Value> {
    lib.writable()?;
    let old = lib.source(id)?;
    if old["kind"] != "bundled" {
        bail!("{id} isn't a project that came with the app.");
    }
    let conv = starter_on_github(id).with_context(|| format!("{id} isn't on GitHub as the app has it."))?;
    let mut u = parse_github_url(&conv.repository)?;
    u.reference = Some(conv.commit.clone());
    let gh = GitHub::new(token);
    let r = resolve_github(&gh, &u, false)?;
    let version = r.commit_sha[..12].to_string();
    let what = format!("{}/{}", u.owner, u.repo);
    let (root, n) = install_version(lib, id, &version, |tmp| {
        let archive = tmp.with_extension("tar.gz");
        gh.download(&format!("/repos/{}/{}/tarball/{}", u.owner, u.repo, r.commit_sha), &archive, &what)?;
        let n = extract_tarball(&archive, tmp, "");
        let _ = std::fs::remove_file(&archive);
        n
    })?;
    let missing: Vec<&str> = conv.description["models"].as_array().into_iter().flatten().filter_map(|m| m["entrypoint"].as_str()).filter(|e| !root.join(e).is_file()).collect();
    if !missing.is_empty() {
        let _ = std::fs::remove_dir_all(&root);
        bail!("{what} at {} doesn't have {}.", &version[..7], missing.join(", "));
    }
    let dir = lib.source_dir(id)?;
    crate::config::write_json(&dir.join("description.json"), &conv.description)?;
    let html = r.repo["html_url"].as_str().map(String::from).unwrap_or_else(|| format!("https://github.com/{}/{}", u.owner, u.repo));
    let mut src = old.clone();
    let now = library::now();
    src["kind"] = json!("github");
    src["origin"] = json!({
        "type": "github", "url": html, "owner": u.owner, "repo": u.repo, "track": r.track, "subdir": "", "added_from": conv.commit,
        "converted": { "from": "app", "date": now, "version": old["version"] },
    });
    src["version"] = json!(version);
    src["version_date"] = json!(r.commit_date);
    src["previous_version"] = old["version"].clone();
    let mut versions = old["versions"].as_array().cloned().unwrap_or_default();
    versions.push(json!({ "id": version, "commit": r.commit_sha, "date": r.commit_date, "message": r.commit_message, "added": now, "files": n }));
    src["versions"] = json!(versions);
    src["detected"]["origin"] = json!(html);
    if let Some(o) = src.as_object_mut() {
        o.shift_remove("update");
    }
    lib.save_source(&src)?;
    Ok(old)
}

/// Put a starter project back as it was when turning it into a GitHub project didn't work.
pub fn unconvert_starter(lib: &Library, old: &Value) -> Result<()> {
    let id = old["id"].as_str().context("project has no id")?;
    let dir = lib.source_dir(id)?;
    if let Ok(now) = lib.source(id) {
        if let Some(v) = now["version"].as_str().filter(|v| Some(*v) != old["version"].as_str()) {
            let _ = std::fs::remove_dir_all(dir.join("files").join(v));
            let _ = std::fs::remove_file(dir.join("derived").join(format!("{v}.json")));
            let _ = std::fs::remove_dir_all(dir.join("docs").join(v));
        }
    }
    let _ = std::fs::remove_file(dir.join("description.json"));
    let _ = std::fs::remove_file(dir.join("workshop.json"));
    lib.save_source(old)
}

/// Saved settings with code edits keep the edited files by path; a starter project's paths had
/// the app's folder in front ("/vendor/gridfinity-rebuilt/bins.scad" becomes "/bins.scad").
pub fn rebase_recipe_edits(lib: &Library, id: &str, vendor_path: &str) -> Result<usize> {
    let prefix = format!("/{vendor_path}/");
    let mut n = 0;
    for mut rec in lib.all_recipes() {
        if !rec["model"].as_str().is_some_and(|m| m.starts_with(&format!("{id}/"))) {
            continue;
        }
        let Some(edits) = rec["edits"].as_object().filter(|e| e.keys().any(|k| k.starts_with(&prefix))) else { continue };
        let moved: serde_json::Map<String, Value> =
            edits.iter().map(|(k, v)| (k.strip_prefix(&prefix).map(|r| format!("/{r}")).unwrap_or_else(|| k.clone()), v.clone())).collect();
        rec["edits"] = Value::Object(moved);
        lib.put_recipe(&rec)?;
        n += 1;
    }
    Ok(n)
}

/// A slug for display ids ("BOSL2" -> "bosl2").
pub fn short(s: &str) -> String {
    slug(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_tags_compare_as_versions() {
        let tags = ["v1.9", "v1.10", "v1.2.3", "nightly"];
        assert_eq!(tags.iter().max_by_key(|t| version_key(t)), Some(&"v1.10"));
        assert_eq!(version_key("release-2.0.1"), vec![2, 0, 1]);
    }

    #[test]
    fn starter_projects_on_github() {
        for (id, _) in STARTER_ON_GITHUB {
            let s = starter_on_github(id).unwrap_or_else(|| panic!("{id}: no repository, commit or vendor path, or a model outside it"));
            assert!(s.repository.starts_with("https://github.com/") && is_commit_sha(&s.commit), "{id}");
            for m in s.description["models"].as_array().unwrap() {
                let e = m["entrypoint"].as_str().unwrap();
                assert!(!e.starts_with("vendor/") && m["id"].is_string() && m.get("status").is_none(), "{id}: {e}");
            }
        }
        assert!(starter_on_github("hsw").is_none());
        assert_eq!(known_on_github("Kennetek", "gridfinity-rebuilt-openscad").map(|s| s.vendor_path), Some("vendor/gridfinity-rebuilt".to_string()));
    }

    #[test]
    fn github_urls() {
        let u = parse_github_url("https://github.com/BelfrySCAD/BOSL2").unwrap();
        assert_eq!((u.owner.as_str(), u.repo.as_str(), u.reference.clone(), u.subdir.as_str()), ("BelfrySCAD", "BOSL2", None, ""));
        let u = parse_github_url("https://github.com/o/r/tree/main/models/gears/").unwrap();
        assert_eq!((u.reference.as_deref(), u.subdir.as_str()), (Some("main"), "models/gears"));
        let u = parse_github_url("git@github.com:o/r.git").unwrap();
        assert_eq!(u.repo, "r");
        assert_eq!(parse_github_url("o/r").unwrap().owner, "o");
        assert!(parse_github_url("https://gitlab.com/o/r").is_err());
        assert_eq!(parse_github_url("https://github.com/o/r/releases/tag/v2.0").unwrap().reference.as_deref(), Some("v2.0"));
        let u = parse_github_url("https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567?x=1").unwrap();
        assert!(is_commit_sha(u.reference.as_deref().unwrap()));
    }

    #[test]
    fn archive_paths() {
        assert_eq!(under(Path::new("o-r-abc/a/b.scad"), true, ""), Some(PathBuf::from("a/b.scad")));
        assert_eq!(under(Path::new("o-r-abc/models/x.scad"), true, "models"), Some(PathBuf::from("x.scad")));
        assert_eq!(under(Path::new("o-r-abc/other/x.scad"), true, "models"), None);
        assert_eq!(under(Path::new("o-r-abc/../x"), true, ""), None);
        assert_eq!(under(Path::new("top"), true, ""), None);
    }

    #[test]
    fn zip_round_trip() {
        let d = std::env::temp_dir().join(format!("workshop-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let zpath = d.join("pack.zip");
        {
            let f = std::fs::File::create(&zpath).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let o: zip::write::SimpleFileOptions = Default::default();
            w.start_file("pack/box.scad", o).unwrap();
            std::io::Write::write_all(&mut w, b"cube(1);").unwrap();
            w.start_file("pack/files/part.stl", o).unwrap();
            std::io::Write::write_all(&mut w, b"solid").unwrap();
            w.finish().unwrap();
        }
        let out = d.join("out");
        assert_eq!(extract_zip(&zpath, &out).unwrap(), 2);
        assert!(out.join("box.scad").is_file() && out.join("files/part.stl").is_file());
        let _ = std::fs::remove_dir_all(&d);
    }
}
