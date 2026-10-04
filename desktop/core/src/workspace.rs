//! The workspace folder: everything the user makes or keeps, as plain files.
//!
//! ```text
//! workspace/
//!   sources/       downloaded projects (Phase 2)
//!   libraries/     the user's own libraries (Phase 3)
//!   collections/   model library (Phase 4)
//!   settings/      saved settings (saved/<id>.json) and prefs.json
//!   cache/         render cache and prepared model folders (safe to delete)
//! ```
//!
//! Which folder is the workspace is remembered in the app's config file.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SUBDIRS: [&str; 5] = ["sources", "libraries", "collections", "settings", "cache"];

const README: &str = "SCAD Workshop workspace\n\
\n\
This folder holds what you make and keep in the SCAD Workshop desktop app:\n\
  settings/     saved settings (one file each) and app preferences\n\
  cache/        finished renders and prepared model files; safe to delete\n\
  sources/      projects you add from GitHub or files (coming)\n\
  libraries/    your own OpenSCAD libraries (coming)\n\
  collections/  your model library (coming)\n\
\n\
It's all plain files, so you can back it up or sync it with git, Dropbox or OneDrive.\n\
Leave cache/ out of syncing; it rebuilds itself.\n";

#[derive(Clone, Debug)]
pub struct Workspace {
    root: PathBuf,
}

/// The user's home folder.
pub fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Workspace {
    /// `~/SCAD Workshop`; a folder from before the rename (`~/Claude Grid Workshop`) keeps being used.
    pub fn default_path() -> PathBuf {
        let new = home_dir().join("SCAD Workshop");
        let old = home_dir().join("Claude Grid Workshop");
        if !new.exists() && old.join("settings").is_dir() {
            return old;
        }
        new
    }

    /// Open (creating if needed) a workspace folder.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        for d in SUBDIRS {
            std::fs::create_dir_all(root.join(d)).with_context(|| format!("couldn't create {}", root.join(d).display()))?;
        }
        std::fs::create_dir_all(root.join("settings/saved"))?;
        let readme = root.join("README.txt");
        if !readme.exists() {
            let _ = std::fs::write(readme, README);
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }
    pub fn settings_dir(&self) -> PathBuf {
        self.root.join("settings")
    }
}

/// App config (in the OS's per-user config folder, not the workspace).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub workspace: Option<PathBuf>,
    /// Renders at once; None = all cores but one.
    #[serde(default)]
    pub concurrency: Option<usize>,
    /// Folder of the last "Save" (the dialog opens there next time).
    #[serde(default)]
    pub last_save_dir: Option<PathBuf>,
}

impl AppConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_atomic(path, &serde_json::to_vec_pretty(self)?)
    }

    pub fn workspace_path(&self) -> PathBuf {
        self.workspace.clone().unwrap_or_else(Workspace::default_path)
    }
}

/// Write via a temporary file and rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, data).with_context(|| format!("couldn't write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("couldn't write {}", path.display()))?;
    Ok(())
}
