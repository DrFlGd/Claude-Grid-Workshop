//! Saved settings and preferences as files in the workspace's `settings/` folder.
//! The record format is the front end's (web/platform.js): this layer only
//! stores, lists and deletes them.

use crate::workspace::{write_atomic, Workspace};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::PathBuf;

pub struct FileStore {
    saved: PathBuf,
    prefs: PathBuf,
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        bail!("invalid id {id}");
    }
    Ok(())
}

impl FileStore {
    pub fn new(ws: &Workspace) -> Self {
        Self { saved: ws.settings_dir().join("saved"), prefs: ws.settings_dir().join("prefs.json") }
    }

    /// Saved settings for one model, sorted by name.
    pub fn list(&self, model: &str) -> Result<Vec<Value>> {
        let mut out: Vec<Value> = std::fs::read_dir(&self.saved)
            .with_context(|| format!("couldn't read {}", self.saved.display()))?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
            .filter(|v| v["model"].as_str() == Some(model))
            .collect();
        out.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_lowercase());
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<Value>> {
        valid_id(id)?;
        let p = self.saved.join(format!("{id}.json"));
        if !p.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&std::fs::read(p)?)?))
    }

    /// Store a complete record (must have "id" and "model").
    pub fn put(&self, rec: &Value) -> Result<()> {
        let id = rec["id"].as_str().context("record has no id")?;
        valid_id(id)?;
        if rec["model"].as_str().is_none() {
            bail!("record has no model");
        }
        write_atomic(&self.saved.join(format!("{id}.json")), &serde_json::to_vec_pretty(rec)?)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        valid_id(id)?;
        let p = self.saved.join(format!("{id}.json"));
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    }

    pub fn prefs(&self) -> Value {
        std::fs::read(&self.prefs)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()))
    }

    pub fn set_prefs(&self, prefs: &Value) -> Result<()> {
        if !prefs.is_object() {
            bail!("preferences must be an object");
        }
        write_atomic(&self.prefs, &serde_json::to_vec_pretty(prefs)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_settings_round_trip() {
        let dir = std::env::temp_dir().join(format!("workshop-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = Workspace::open(&dir).unwrap();
        let st = FileStore::new(&ws);
        let rec = serde_json::json!({ "id": "abc-1", "model": "gridfinity-rebuilt/bin", "name": "Four wide", "values": { "gridx": 4 } });
        st.put(&rec).unwrap();
        st.put(&serde_json::json!({ "id": "abc-2", "model": "other/model", "name": "x", "values": {} })).unwrap();
        assert_eq!(st.list("gridfinity-rebuilt/bin").unwrap(), vec![rec.clone()]);
        assert_eq!(st.get("abc-1").unwrap(), Some(rec));
        assert!(st.put(&serde_json::json!({ "id": "../evil", "model": "m" })).is_err());
        st.remove("abc-1").unwrap();
        assert!(st.list("gridfinity-rebuilt/bin").unwrap().is_empty());
        st.set_prefs(&serde_json::json!({ "gw-help": true })).unwrap();
        assert_eq!(st.prefs()["gw-help"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
