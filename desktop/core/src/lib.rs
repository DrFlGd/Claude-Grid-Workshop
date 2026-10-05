//! Core of the desktop app, kept free of any GUI so it builds and tests on its
//! own (and powers `workshop-cli`: native renders in CI, the website build's
//! catalog steps, and a local stand-in for the app's backend).
//!
//! - [`site`]: the app's own files (common fonts, engine version); the website build
//! - [`engine`], [`render`]: the bundled native OpenSCAD, render queue and cache
//! - [`ingest`], [`sitebuild`]: reading OpenSCAD projects (files, settings, metadata)
//! - [`config`]: what the app keeps on this computer (open library, preferences)
//! - [`library`]: the portable library folder; [`meta`]: layered metadata
//! - [`sources`]: adding projects (GitHub, ZIP, folders); [`scan`], [`project`]: reading them
//! - [`catalog`]: the page's catalog from the library; [`merge`]: merging libraries
//! - [`api`]: the commands the page calls

pub mod api;
pub mod catalog;
pub mod components;
pub mod config;
pub mod engine;
pub mod ingest;
pub mod library;
pub mod merge;
pub mod meta;
pub mod project;
pub mod scan;
pub mod sources;
pub mod render;
pub mod site;
pub mod sitebuild;

pub use engine::NativeEngine;
pub use render::{RenderEvent, RenderOutput, RenderRequest, Renderer};
pub use site::SiteDir;
pub use library::Library;

/// The app's version. The repository keeps `<major>.<minor>.0`; release builds
/// get their number from CI (tools/set_version.py), one higher each release.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
