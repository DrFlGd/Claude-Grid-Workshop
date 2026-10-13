//! Backing up a library folder to one ZIP file, and restoring a backup as a new
//! library folder. The backup is the folder as it is (projects, saved settings,
//! metadata, trash), optionally without thumbnails, which the app makes again.
//! Linked projects live outside the library and aren't in it.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Every file under `root`, as "/"-separated paths, sorted.
fn walk(root: &Path) -> Result<Vec<(String, u64)>> {
    let mut out = vec![];
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        for e in std::fs::read_dir(&dir).with_context(|| format!("couldn't read {}", dir.display()))?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push((e.path(), rel));
            } else if ft.is_file() {
                out.push((rel, e.metadata().map(|m| m.len()).unwrap_or(0)));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// A project's thumbnails (`sources/<id>/thumbs/...`): made again when the library opens.
fn is_thumb(rel: &str) -> bool {
    let p: Vec<&str> = rel.split('/').collect();
    p.len() >= 4 && p[0] == "sources" && p[2] == "thumbs"
}

/// Write the library folder `root` to the ZIP file `dest`. `progress(files done, files, bytes done,
/// bytes)`; `cancelled()` stops it (nothing is left at `dest`). Written to a `.part` file first, so a
/// stopped or failed backup never looks like a finished one.
pub fn backup(
    root: &Path,
    dest: &Path,
    leave_out_thumbs: bool,
    progress: impl Fn(usize, usize, u64, u64),
    cancelled: impl Fn() -> bool,
) -> Result<Value> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let dest_dir = dest.parent().map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf())).unwrap_or_default();
    if dest_dir.starts_with(&root) {
        bail!("Save the backup outside the library folder.");
    }
    let mut files = walk(&root)?;
    let all = files.len();
    if leave_out_thumbs {
        files.retain(|(rel, _)| !is_thumb(rel));
    }
    let total: u64 = files.iter().map(|f| f.1).sum();
    let part = dest.with_file_name(format!("{}.part", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "backup.zip".into())));
    let run = || -> Result<Option<u64>> {
        let f = std::fs::File::create(&part).with_context(|| format!("couldn't write {}", part.display()))?;
        let mut z = zip::ZipWriter::new(std::io::BufWriter::new(f));
        let mut done: u64 = 0;
        let mut buf = vec![0u8; 1 << 16];
        for (i, (rel, size)) in files.iter().enumerate() {
            if cancelled() {
                return Ok(None);
            }
            // already-compressed files are stored as they are
            let packed = matches!(rel.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref(), Some("zip" | "3mf" | "webp" | "png" | "jpg" | "jpeg" | "gz" | "mp4" | "pdf"));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(if packed { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated })
                .large_file(*size >= 0xFFFF_FFFF);
            z.start_file(rel.as_str(), opts)?;
            let mut r = std::fs::File::open(root.join(rel)).with_context(|| format!("couldn't read {rel}"))?;
            loop {
                let n = r.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                z.write_all(&buf[..n])?;
                done += n as u64;
            }
            if i % 50 == 0 || i + 1 == files.len() {
                progress(i + 1, files.len(), done, total);
            }
        }
        let mut w = z.finish()?;
        w.flush()?;
        drop(w);
        Ok(Some(std::fs::metadata(&part)?.len()))
    };
    match run() {
        Ok(Some(size)) => {
            std::fs::rename(&part, dest).with_context(|| format!("couldn't write {}", dest.display()))?;
            Ok(json!({ "path": dest.display().to_string(), "files": files.len(), "left_out": all - files.len(), "bytes": total, "size": size }))
        }
        Ok(None) => {
            let _ = std::fs::remove_file(&part);
            bail!("Stopped; no backup was made.")
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Unpack a backup into `dest` (a new or empty folder) and check it's a library.
pub fn restore(archive: &Path, dest: &Path, progress: impl Fn(usize, usize), cancelled: impl Fn() -> bool) -> Result<PathBuf> {
    if dest.exists() && std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
        bail!("{} isn't empty; choose a new folder for the restored library.", dest.display());
    }
    let f = std::fs::File::open(archive).with_context(|| format!("couldn't open {}", archive.display()))?;
    let mut z = zip::ZipArchive::new(f).context("That isn't a ZIP file this app can read.")?;
    if z.by_name("library.json").is_err() {
        bail!("That ZIP isn't a library backup (it has no library.json at the top).");
    }
    std::fs::create_dir_all(dest)?;
    let n = z.len();
    let run = |z: &mut zip::ZipArchive<std::fs::File>| -> Result<bool> {
        for i in 0..n {
            if cancelled() {
                return Ok(false);
            }
            let mut e = z.by_index(i)?;
            if !e.is_file() || e.is_symlink() {
                continue;
            }
            let Some(rel) = e.enclosed_name() else { continue };
            let out = dest.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut w = std::fs::File::create(&out).with_context(|| format!("couldn't write {}", out.display()))?;
            std::io::copy(&mut e, &mut w)?;
            if i % 50 == 0 || i + 1 == n {
                progress(i + 1, n);
            }
        }
        Ok(true)
    };
    match run(&mut z) {
        Ok(true) => Ok(dest.to_path_buf()),
        Ok(false) => {
            let _ = std::fs::remove_dir_all(dest);
            bail!("Stopped; nothing was restored.")
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(dest);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_and_restore() {
        let d = std::env::temp_dir().join(format!("workshop-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let lib = d.join("lib");
        std::fs::create_dir_all(lib.join("sources/zip-a/files/v1")).unwrap();
        std::fs::create_dir_all(lib.join("sources/zip-a/thumbs")).unwrap();
        std::fs::create_dir_all(lib.join("recipes")).unwrap();
        std::fs::write(lib.join("library.json"), r#"{"format": 2, "id": "x", "name": "Mine"}"#).unwrap();
        std::fs::write(lib.join("sources/zip-a/files/v1/box.scad"), "cube(1);\n".repeat(100)).unwrap();
        std::fs::write(lib.join("sources/zip-a/thumbs/box.webp"), b"RIFF").unwrap();
        std::fs::write(lib.join("recipes/r1.json"), "{}").unwrap();
        // inside the library: refused
        assert!(backup(&lib, &lib.join("b.zip"), false, |_, _, _, _| {}, || false).is_err());
        // stopped: nothing left
        let zip = d.join("backup.zip");
        assert!(backup(&lib, &zip, false, |_, _, _, _| {}, || true).is_err());
        assert!(!zip.exists() && !d.join("backup.zip.part").exists());
        // without thumbnails
        let r = backup(&lib, &zip, true, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(r["files"], json!(3));
        assert_eq!(r["left_out"], json!(1));
        let out = d.join("restored");
        restore(&zip, &out, |_, _| {}, || false).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("sources/zip-a/files/v1/box.scad")).unwrap(), "cube(1);\n".repeat(100));
        assert!(out.join("recipes/r1.json").is_file() && !out.join("sources/zip-a/thumbs/box.webp").exists());
        // not into a folder with things in it, and not a ZIP that isn't a library
        assert!(restore(&zip, &out, |_, _| {}, || false).is_err());
        let other = d.join("other.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&other).unwrap());
            z.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        assert!(restore(&other, &d.join("r2"), |_, _| {}, || false).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
