# Desktop app plan

Status: **Phase 0 done** (2026-10-03): engine and storage seams, saved settings, share links, OpenSCAD parameter-file import/export. Phase 1 next.

## Goal

A desktop "Swiss Army knife" for parametric 3D design on **Windows and Linux**:

1. **Generate**: find any generator or library part quickly ("bevel gear", "gridfinity bin", "hinge") and get a printable file in seconds.
2. **Ingest**: add new projects from a GitHub link (with update checks) or from a file, ZIP or folder, stored locally.
3. **Index**: one searchable, browsable index of everything available, organised by what it makes.
4. **Library**: keep models, both ones you generated and premade ones you imported, in collections for a use case (a rugged case, the parts for one RC car).

The website stays as the **light version**: the built-in catalog in the browser, with the same UI. Ingest and the model library are desktop-only.

## Decisions taken

| Question | Decision |
| --- | --- |
| Wrapper or native UI | Wrapper: **Tauri 2**, reusing the existing `web/` front end |
| Platforms | Windows and Linux (no macOS for now) |
| Repository | This repo: `desktop/` beside the website |
| Website | Kept as the light version, sharing the front end |

## Architecture

```
web/  (shared UI: catalog, search, forms, viewer, library pages)
  │
  ├── in a browser ──> engine: OpenSCAD WebAssembly worker  storage: IndexedDB
  │
  └── in Tauri ──────> engine: native OpenSCAD (render queue)  storage: workspace folder
                         │
desktop/src-tauri (Rust) ├── jobs: run openscad, N in parallel, cancel, cache
                         ├── sources: download, pin, check for updates
                         ├── ingest: entrypoints, includes, settings, licenses, thumbnails
                         ├── index: SQLite + full-text search
                         └── library: collections, imports, recipes, export
```

**Two seams in the front end** make one UI work in both places:

- `engine`: `render(model, files, settings) -> STL/3MF` plus progress and cancel. Today's `engine-client.js` becomes the browser implementation; the desktop one calls a Tauri command.
- `store`: saved settings, projects and library. Browser: IndexedDB. Desktop: files in the workspace folder.

The page detects Tauri at start-up and picks the implementation. Everything above the seams is shared.

### Native engine

- The pinned OpenSCAD snapshot (same version as `engine.json`, today 2026.10.02) ships inside the app. On Windows that's the snapshot's ZIP folder. On Linux it's the AppImage contents, extracted at build time so there's no AppImage inside an AppImage. Both are bundled as Tauri resources and launched by path. CI downloads them and checks their SHA-256, like the WebAssembly engine.
- **Render queue:** one OpenSCAD process per job, up to (cores − 1) at once; cancel kills the process.
- **Cache:** results are stored under `cache/` keyed by a hash of (engine version, model files, settings). Repeating a render is instant.
- **Fonts and libraries:** native OpenSCAD sees system fonts, and `OPENSCADPATH` points at the bundled and workspace libraries.
- **Benchmark:** `tools/engine/cli.mjs bench` gets a native mode, so CI records native vs WebAssembly times side by side.

### Workspace folder

You choose it on first run (default `~/OpenSCAD Workshop`). It's plain files so it can be synced or put in git:

```
workspace/
  sources/<id>/<commit>/        downloaded projects, one folder per pinned version
  sources/<id>/source.json      origin, license, pinned version, update state
  libraries/                    bundled libraries (read-only) + your own
  collections/<name>/           collection.json + premade files + generated outputs
  settings/                     saved settings, workspace profile
  cache/                        render cache (safe to delete)
  index.sqlite                  search index (rebuilt from the above if deleted)
```

## 1. Sources (ingest)

**From GitHub:** paste a repo URL (optionally a branch, tag or subfolder).

- The app downloads the tarball for a specific commit through GitHub's API. That's no git dependency, and it is pinned exactly.
- **Update checks:** on start-up, at most daily, the app asks GitHub for the latest commit on the tracked branch. Unauthenticated limits (60 requests an hour) are plenty; a personal token can be added for many sources. When there's a newer commit, the app shows:
  - the commit messages since the pinned one;
  - settings added, removed or changed default, for each generator;
  - a re-render of your saved recipes from that source on the new version, compared with the old by size and volume (as `tools/parity.py` does).

  You accept or skip. The old version stays until nothing uses it, so saved recipes always rebuild exactly.
- Other git hosts (GitLab, Codeberg) follow later.

**From a file, ZIP or folder:** copied into `sources/`, with a form for name, author, origin URL and license.

**Ingest steps** (generalising today's `tools/build_site.py`):

1. Find entry files: `.scad` files that produce geometry at top level and/or have Customizer settings. Files that only define modules and functions are library files.
2. Follow `include`, `use` and `import`. Paths that point at a bundled library (`<BOSL2/std.scad>`) resolve to it; anything missing is listed on the source page.
3. Read settings with OpenSCAD's own Customizer export, as now. Apply `editor.toml` when present.
4. Read the README (description), LICENSE (identified as SPDX where possible) and any parameter-set JSON files (as presets).
5. Render a thumbnail at default settings.
6. Write the index entries.

The ingest logic gets **one implementation in Rust**, used by the app and, through a small CLI, by the website build in CI. `build_site.py` then keeps only the website-specific steps, so the two can't drift apart.

**Safety:** OpenSCAD can't run programs, but `import()` can read any file the user can read. Renders therefore run with the job's folder as the working directory, and ingest warns about absolute paths. Downloads have a size limit, with a prompt above it.

## 2. Bundled libraries

Pinned and hash-checked like `vendor/`:

| Library | Source (checked 2026-10-03) | License |
| --- | --- | --- |
| BOSL2 | BelfrySCAD/BOSL2 @ e173fa0 (2026-10-02) | BSD-2-Clause |
| MCAD | openscad/MCAD @ bd0a7ba (2021-10-25) | LGPL-2.1 (some files more permissive) |
| NopSCADlib | nophead/NopSCADlib @ 00ec289 (2026-09-24) | GPL-3.0 |
| Round-Anything | Irev-Dev/Round-Anything @ 061fef7 (2023-08-07) | MIT |
| threads-scad | rcolyer/threads-scad @ 4ae9aeb (2021-12-01) | CC0-1.0 |

More can be added the same way, or ingested as ordinary sources.

### Module → generator

Most mechanical parts (gears, threads, hinges, bearings) are modules inside libraries, not ready-made generator files. The app makes them usable directly:

- **BOSL2:** its public modules have structured doc comments (`// Module:`, `Synopsis:`, `Topics:`, `Arguments:`, `Example:`), 964 documented functions and modules in the current version. The parser turns this into:
  - an index entry, with the synopsis and the BOSL2 topics as tags (`bevel_gear()` has topics Gears, Parts);
  - a form, one field per argument with its description as help; types and defaults come from the signature and the description ("Default: 90");
  - presets, from the doc examples (`bevel_gear(mod=3, teeth=35, mate_teeth=35, face_width=20)`).
- **Other libraries:** the form comes from the module signature (`module name(a=1, b=[2,3])`): names, defaults and types inferred from the defaults. Comments directly above the module become its description.
- **Rendering:** a generated wrapper file (`include <BOSL2/std.scad>` + `include <BOSL2/gears.scad>` + one call with the form's values), rendered like any other model.
- A module can be **pinned as a generator**, with a nicer name, chosen settings and hidden extras. Pinned generators are stored as small JSON files in the workspace, in the same shape as `catalog/families/*.json`.

## 3. Index and search

**One index** for everything:

- generators (built-in and ingested);
- library modules;
- pinned generators;
- library items (premade and generated).

**Each entry has:**

- kind, name, description and tags;
- a category path;
- settings (names and descriptions, so "tooth count" finds gears);
- source and version, and license;
- thumbnail and size.

**Categories:** a starting taxonomy you can edit:

- Storage › Gridfinity / openGrid / Boxes / Labels
- Mechanical › Gears / Threads / Hinges / Bearings / Springs
- Fasteners › Screws / Nuts / Inserts
- Enclosures
- Text and signs
- Shapes and helpers

Ingest suggests a category from keywords, BOSL2 topics, file and module names, and the README; you can change it.

**Search:** SQLite FTS5 with:

- prefix matching;
- a synonym list (cog → gear, box → enclosure / case, nut → fastener);
- filters by category, kind, source, license, "in my library", and "runs fast";
- results ranked by match, then by how often you use them.

**Browse:** the home page becomes category tiles, recent and favourites; the current family/project grouping becomes one view of it.

**Target flow (acceptance test for the bevel-gear case):** search "bevel gear" → BOSL2 `bevel_gear()` is the first result → form opens with a preset from the docs → change teeth and module → preview → download STL. All in under a minute on a normal laptop.

## 4. Model library

**Collections** are folders with a `collection.json`. Each item is either:

- **premade:** STL, 3MF, OBJ or STEP (files with the same name are grouped, as `tools/import_library.py` does now), plus origin URL, author and license; or
- **recipe:** a generated model, stored as source, version, model and settings, with its last output file. Recipes can be re-opened in their form, changed, or re-rendered after a source update.

**Per item:** quantity, notes, print settings (material, nozzle, infill and so on, free text to start with), status (to print / printed), and tags.

**Import:** drop files, a ZIP or a folder. Duplicates are found by content hash. Sizes and thumbnails are measured on import. STEP gets a preview through OpenCascade's WebAssembly build (occt-import-js; license to confirm before bundling).

**Export:** a collection as a ZIP (files × quantity, with a parts list), or as a 3MF with parts arranged on the plate (Phase 5).

**Search:** library items are in the same index as generators, so "case latch" finds your saved latch and the generator that made it.

## Phases

Each phase ends with something usable and with checks in CI.

| Phase | Delivers | Done when |
| --- | --- | --- |
| **0. Seams** | Engine and store interfaces in `web/`; saved settings and share links on the website (browser storage) | Website unchanged for users, plus saved settings; all 55 models still pass in Chromium |
| **1. Desktop shell** | Tauri app (Windows + Linux) with native engine, render queue, cache, workspace folder, built-in catalog offline, saved settings as files, workspace profile (bed size, tolerances, font) | Installers built in CI; all 55 models render natively (including the 3 Underware channels the browser can't); native vs WebAssembly benchmark published |
| **2. Ingest + index** | Add from GitHub / file / ZIP; update checks with change summary; Rust ingest CLI shared with the website build; SQLite index; search and category browse | Add 3 public repos by URL; search finds their generators; a simulated upstream change is detected and summarised |
| **3. Libraries + modules** | Bundled libraries; BOSL2 doc parser; signature parser; module → form; pinned generators | The bevel-gear acceptance test passes; every BOSL2 module with geometry gets a form that renders its first doc example |
| **4. Model library** | Collections; premade import (STL/3MF/OBJ/STEP); recipes; quantities, notes, status; ZIP export | Import a pack, save 3 recipes, re-render them after a source update, export the collection |
| **5. Productivity** | Batch from CSV, multi-setting sweeps, arranged multi-colour 3MF, send to slicer (open the file in Bambu Studio / OrcaSlicer / PrusaSlicer), live reload when a watched .scad file is saved | As listed |

## Testing

- **Linux:** build and run in this environment; automated UI tests through `tauri-driver` (WebDriver), reusing the screenshot test's steps.
- **Windows:** CI builds the installer and runs the same WebDriver tests on a Windows runner. The owner does hands-on testing.
- The existing website checks stay as they are.

## Risks and how they're handled

| Risk | Handling |
| --- | --- |
| Linux webview (WebKitGTK) has weaker WebGL than Chromium | Test the viewer early in Phase 1; if it's a problem, Linux falls back to an Electron build of the same front end |
| OpenSCAD snapshot packaging differs per OS | Phase 1 starts with a spike that bundles and runs it on both; pinned and hash-checked |
| Unsigned installers | Fine for private use (Windows shows a SmartScreen prompt the first time) |
| Ingested projects with unusual layouts | Ingest reports what it couldn't resolve; per-source overrides in the same JSON form as `catalog/families` |
| License mix in a collection | Each item keeps its license; export includes a credits file |

## Still open

- Licenses and authors for Anylid, openGrid Shelf, Just Fit and Minimalist Kitchen (owner to supply).
- Multiboard and openGrid Connector sources (owner to supply).
- STEP/Shapr3D files for openGrid tiles: on hold.
