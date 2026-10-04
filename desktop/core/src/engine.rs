//! The bundled native OpenSCAD.
//!
//! Layout inside the engine folder (prepared by `tools/fetch_native_engine.py`):
//! - Linux: the OpenSCAD AppImage file, or its extracted folder (`AppRun` at the top)
//! - Windows: the snapshot ZIP's folder (`openscad.exe`, possibly one level down)
//!
//! A path to an `openscad` executable also works (e.g. a system install).
//!
//! The Linux app ships OpenSCAD's AppImage as one file; [`NativeEngine::prepare`]
//! extracts it once into the app's local data folder (no FUSE needed).

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Clone, Debug)]
pub struct NativeEngine {
    pub exe: PathBuf,
    pub version: String,
}

fn candidates(dir: &Path) -> Vec<PathBuf> {
    let mut v = vec![];
    if cfg!(windows) {
        v.push(dir.join("openscad.exe"));
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    v.push(e.path().join("openscad.exe"));
                }
            }
        }
    } else {
        v.push(dir.join("AppRun"));
        v.push(dir.join("squashfs-root/AppRun"));
        v.push(dir.join("usr/bin/openscad"));
        v.push(dir.join("bin/openscad"));
        v.push(dir.join("openscad"));
        v.push(dir.join("OpenSCAD.app/Contents/MacOS/OpenSCAD"));
    }
    v
}

impl NativeEngine {
    /// Find OpenSCAD in `path` (a folder or the executable itself) and ask it for its version.
    pub async fn locate(path: &Path) -> Result<Self> {
        let exe = if path.is_file() {
            path.to_path_buf()
        } else {
            candidates(path)
                .into_iter()
                .find(|p| p.is_file())
                .with_context(|| format!("no OpenSCAD executable found in {}", path.display()))?
        };
        let version = Self::query_version(&exe).await?;
        Ok(Self { exe, version })
    }

    /// Use the bundled engine folder; an AppImage in it is extracted under `scratch` first.
    pub async fn prepare(bundled: &Path, scratch: &Path) -> Result<Self> {
        if let Some(appimage) = find_appimage(bundled) {
            let name = appimage.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "openscad".into());
            let target = scratch.join(&name);
            if !target.join("squashfs-root/AppRun").exists() {
                extract_appimage(&appimage, scratch, &target).await?;
            }
            return Self::locate(&target.join("squashfs-root")).await;
        }
        Self::locate(bundled).await
    }

    async fn query_version(exe: &Path) -> Result<String> {
        let mut cmd = tokio::process::Command::new(exe);
        cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        no_window(&mut cmd);
        let out = cmd.output().await.with_context(|| format!("couldn't start {}", exe.display()))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if let Some(v) = text.lines().find_map(|l| l.trim().strip_prefix("OpenSCAD version ")) {
            return Ok(v.trim().to_string());
        }
        if let Some(lib) = text.split("error while loading shared libraries: ").nth(1).and_then(|r| r.split(':').next()) {
            bail!(
                "OpenSCAD needs the system library {lib}, which isn't installed. On Debian or Ubuntu: \
                 sudo apt install libopengl0 libegl1 libglx0 (other distributions: the package providing {lib})."
            );
        }
        bail!("{} didn't report a version: {}", exe.display(), text.trim())
    }

    pub fn command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.exe);
        no_window(&mut cmd);
        cmd
    }
}

/// Don't flash a console window for each render on Windows.
pub fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn find_appimage(dir: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("AppImage")))
}

async fn extract_appimage(appimage: &Path, scratch: &Path, target: &Path) -> Result<()> {
    let tmp = scratch.join(format!(".extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).with_context(|| format!("couldn't create {}", tmp.display()))?;
    let copy = tmp.join("engine.AppImage");
    std::fs::copy(appimage, &copy).with_context(|| format!("couldn't copy {}", appimage.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o755))?;
    }
    let out = tokio::process::Command::new(&copy)
        .arg("--appimage-extract")
        .current_dir(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("couldn't run the OpenSCAD AppImage to unpack it")?;
    if !out.status.success() || !tmp.join("squashfs-root/AppRun").exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        bail!("unpacking OpenSCAD failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    std::fs::remove_file(&copy)?;
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&tmp, target).with_context(|| format!("couldn't move OpenSCAD into {}", target.display()))?;
    Ok(())
}
