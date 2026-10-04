//! Core of the desktop app, kept free of any GUI so it builds and tests on its
//! own (and powers `workshop-cli`, which CI uses to render every model natively).
//!
//! - [`site`]: the built site (`_site`: data/, fs/, parts/) shipped with the app
//! - [`engine`]: locating and identifying the bundled native OpenSCAD
//! - [`render`]: render queue, cancellation and the render cache
//! - [`workspace`]: the user's workspace folder and app config
//! - [`store`]: saved settings and preferences as files in the workspace

pub mod engine;
pub mod render;
pub mod site;
pub mod store;
pub mod workspace;

pub use engine::NativeEngine;
pub use render::{RenderEvent, RenderOutput, RenderRequest, Renderer};
pub use site::SiteDir;
pub use workspace::Workspace;
