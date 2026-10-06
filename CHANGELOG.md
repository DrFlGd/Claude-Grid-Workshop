# Changelog

The history of SCAD Workshop in one place: what was built, when, why, and what was learned on the way. It combines the git log, the GitHub release notes, the "notes" sections of [docs/DESKTOP_PLAN.md](docs/DESKTOP_PLAN.md), the early backlog in [docs/FEATURES.md](docs/FEATURES.md), [docs/SOURCE_AUDIT.md](docs/SOURCE_AUDIT.md), and the owner's requests from the working sessions.

It's written for whoever picks the work up next, people or agents: start with **For agents** below, then read the newest release. Dates are the owner's time (America/New_York). Newest first.

**Keeping it up to date:** add a line under **Unreleased** with each change you push (what changed for the user, and anything the next person needs to know). When CI publishes a release, move those lines under a heading for that version. CI writes the GitHub release notes from the commit subjects; this file is where the reasons and lessons go. Design detail belongs in the plan's notes sections; link to it rather than repeating it.

---

## For agents

### What this is

A toolbox for making 3D-printable parts with OpenSCAD, in two forms that share one front end (`web/`):

- **Website** (light version): static, OpenSCAD as WebAssembly in the browser, on GitHub Pages: https://drflgd.github.io/Claude-Grid-Workshop/
- **Desktop app** (Windows, Linux; Tauri 2): native OpenSCAD, a portable library folder, projects added from GitHub, ZIPs and folders, Components from bundled OpenSCAD libraries. Installers on the [releases page](https://github.com/DrFlGd/Claude-Grid-Workshop/releases).

The owner ("DrFlGd") tests hands-on, mostly on Windows, and steers by phases. The roadmap and every design decision are in `docs/DESKTOP_PLAN.md` (Phases table; "Still open"; one notes section per finished stage).

### Where things are

| Path | What |
| --- | --- |
| `web/` | The front end (no build step). `app.js`: routing, model page (form, preview, batch, saved settings), settings and license pages. `web/ui/`: Preact + htm islands (sidebar, browser, inspector, tabs, palette, quick look, dialogs, Library settings, pin dialog and form editor, `sideview.js`: the side viewer for code and documents). `platform.js` / `platform-desktop.js`: the browser vs desktop seam. `ui/index-local.js`: search. |
| `desktop/core/` | Rust, no GUI: `api.rs` (the app's command table), `render.rs` (native OpenSCAD queue and cache), `library.rs` (library folder), `meta.rs` (layered metadata), `catalog.rs` (catalog from the library), `components.rs` (library modules as forms), `docs.rs` (reference documents: README to HTML, PDFs, text), `ingest.rs` / `sitebuild.rs` / `scan.rs` / `project.rs` (reading projects; also the website build), `sources.rs` (GitHub, ZIP, folder), `merge.rs`. `src/bin/workshop-cli.rs`: CLI and `serve` (the app's backend over HTTP, for tests). |
| `desktop/src-tauri/` | The Tauri app: a thin layer over `api.rs`, plus dialogs and the `library://` protocol. Version in `tauri.conf.json`. |
| `catalog/` | Family manifests for the built-in generators (`families/*.json`, with `ui` overlays), parts packs (`libraries/`), start values for components (`components.json`). |
| `vendor/`, `adapters/`, `sources/` | Third-party OpenSCAD projects, vendored unmodified and hash-checked (`sources/SHA256SUMS`); small adapters; upstream pins. See THIRD_PARTY.md and docs/SOURCE_AUDIT.md. |
| `libraries.json` | The OpenSCAD libraries the desktop app ships with (BOSL2, MCAD, NopSCADlib, Round-Anything, threads-scad), pinned by commit and content hash. |
| `engine.json` | Pinned OpenSCAD 2026.10.02: the WebAssembly build and the native Linux AppImage / Windows ZIP. |
| `tools/` | `build_site.py`, `build_desktop.py`, `fetch_engine.py`, `fetch_native_engine.py`, `fetch_libraries.py`, `thumbnails.py`, `set_version.py`, `import_library.py`, `parity.py`, … |
| `tests/` | `interface.py` (website, Playwright), `desktop_page.py` (acceptance test: page + real backend), `desktop_ui.py` (WebDriver on the built app), `github_mock.py`, `tauri_shim.js`, `screenshots.py`. |
| `.github/workflows/` | `site.yml` (website build, renders, tests, Pages), `desktop.yml` (site data → Linux and Windows apps → portability → release), `vendor.yml` (vendored crates for offline builds). |

### Conventions

- **Phases and releases.** The repository keeps `0.<phase>.0` in `desktop/src-tauri/tauri.conf.json`, `desktop/Cargo.toml` and `desktop/Cargo.lock` (`tools/set_version.py 0.4.0` stamps all three). CI picks the next free `0.<phase>.<n>` from the release tags and publishes `v<version>` only when the Linux and Windows apps, the acceptance test and the portability check all pass. Start a new phase by bumping the minor number.
- **Plan first.** For a new phase or a big feature, the owner wants the design written into `docs/DESKTOP_PLAN.md` before code, and a notes section ("Phase N notes", "0.N notes") afterwards recording what was built and where it differs. Some roadmap items are marked "talk through the implementation before building it": do that.
- **Commits:** a subject saying what changed for the user, a body with the details. The session tools add attribution trailers (`Co-Authored-By`, `Claude-Session`).
- **Text:** plain words, no jargon in the interface; British spellings in the UI (colour, favourites, normalise). Names the owner chose: **Parametric Models**, **Components**, **Parts Library**, **Library settings**, **SCAD Workshop**.
- **Tests grow with each phase.** Add checks to the acceptance test (`desktop_page.py`) for every user-visible feature, and to `desktop_ui.py` when it needs the real app.

### Working in a cloud session (lessons learned)

The development sandbox has a network allowlist and is reset between sessions (the clone, the scratchpad and everything built is gone). What works:

- **Rust:** crates.io is blocked. `vendor.yml` pushes `desktop/core`'s dependencies to the `crates-vendor` branch whenever `desktop/core/Cargo.toml` changes. Clone that branch, then build offline: a workspace with `core` linked to `desktop/core`, `Cargo.lock` from the branch, and `cargo <cmd> --offline --config <vendor-config.toml with directory = the branch's vendor/>` (put the flags right after the subcommand, before any `--`). New dependencies: push the `Cargo.toml` change and wait for `vendor.yml`.
- **The Tauri app can't be built locally** (no Tauri crates, npm's Tauri CLI and apt are blocked). Test the app's backend with `workshop-cli serve` + `tests/tauri_shim.js` instead (that's what `desktop_page.py` does); the real app only builds in CI.
- **Native OpenSCAD:** the `engine-cache-native` branch holds the pinned AppImage. `python3 tools/fetch_native_engine.py --file <AppImage> --out build/desktop/engine --extract build/native`. It needs `libOpenGL.so.0`, which the sandbox lacks: compile a stub with a no-op function for every `gl*` symbol `nm -D --undefined-only` lists in `openscad`, `libGLU`, `libQt6Gui` and `libQt6OpenGL`, put it in `build/native/stub/`, and run with `LD_LIBRARY_PATH=build/native/stub`.
- **WebAssembly engine:** the `engine-cache` branch holds `engine.zip`: `python3 tools/fetch_engine.py --out build/engine --zip <engine.zip>`.
- **Libraries:** `codeload.github.com` is blocked locally (CI downloads tarballs fine), but `git clone` works: clone the five libraries, check out the pinned commits, then `python3 tools/fetch_libraries.py --out build/desktop/libs --from-git <folder of clones>`.
- **Full local build:** `tools/build_site.py --engine build/engine --out _site --native-engine build/native/squashfs-root/AppRun --cli <workshop-cli>` (about 2 minutes), then `tools/build_desktop.py --site _site --out build/desktop --cli <workshop-cli>`. Local sites have no thumbnails unless you also run `tools/thumbnails.py`, so the website test's thumbnail check fails locally; that's expected.
- **Acceptance test locally:** clone `vector76/gridfinity_openscad` (full history: it needs old commit `af95c658`), `chrisspen/gears` and `BelfrySCAD/BOSL2` into one folder, run `tests/github_mock.py --repos <folder> --port 8795`, then `tests/desktop_page.py --cli … --ui build/desktop/ui --app-site build/desktop/site --starter build/desktop/starter --engine build/native/squashfs-root --home <tmp> --out <shots> --github-api http://127.0.0.1:8795`. After changing `web/`, copy it into `build/desktop/ui` (`index.html` as `build_desktop.py` writes it: without the Google Fonts lines).
- **GitHub from the session:** `gh` works through the REST API only (`gh api repos/DrFlGd/Claude-Grid-Workshop/...`); GraphQL commands such as `gh release view` are refused, and editing releases isn't permitted. Pushes to `main` are fine. CI reports land on the `desktop-ci-linux` and `desktop-ci-windows` branches (logs, JSON reports, screenshots) and `ci-screenshots` (website); clone those to read results when job logs aren't downloadable.
- **Careful with `pkill -f`:** a pattern that matches your own command line kills your shell.
- **Hosted runners sometimes aren't acquired** ("The job was not acquired by Runner…"): that's GitHub, not the code; re-run (`gh run rerun <id>`).

### Branches

`main` (everything), `crates-vendor` (vendored Rust crates), `engine-cache` / `engine-cache-native` (pinned OpenSCAD downloads), `desktop-ci-linux` / `desktop-ci-windows` / `ci-screenshots` (CI reports, force-pushed), `archive/server-v1` (the first, server-based website, on hold).

### Known limitations now

- Many components can't start on their own: about 370 of the 796 open with required settings empty (most are NopSCADlib parts that need a part type the library doesn't list as a choice). BOSL2 modules whose first doc example isn't a plain call start from a later example or wait for values (55 of 201).
- Components are desktop-only; the website stays the light version.
- Installers aren't code-signed (Windows SmartScreen asks once), and there's no auto-update: install the new release over the old one.
- Native OpenSCAD on Windows is slow with projects split into many `use`d files; the app races it against the WebAssembly engine per model (see 0.1 / Phase 1 below).
- Licenses and authors for Anylid, openGrid Shelf, Just Fit and Minimalist Kitchen are still to be supplied by the owner; Multiboard and the openGrid Connector have no sources yet; Underware's license is contradictory (kept for private use).
- The repository and website addresses keep the old name (Claude-Grid-Workshop).

### Requested and waiting (roadmap)

- **Phase 4 (0.4), model library and file formats:** the side viewer and reference documents are done (0.4.0); settings borrowed from the library and editing code in the viewer (0.4.1); still to do: collections; importing STL/3MF/OBJ/STEP; Printables ZIPs with their PDF metadata; a scratch pad of notes per part (owner, later); one item per file name with a download format picker; multi-colour and multi-part 3MF; recipes, quantities, notes, status; ZIP export; more metadata filters (creator, license family, date added).
- **Phase 5:** batch from CSV, sweeps, 3MF arranged on the bed, send to slicer, live reload of a watched `.scad` file.
- **Future and experimental (unscheduled, owner's ideas of 2026-10-06):** direct slicing in the software; multiple libraries; agent integration to edit SCAD files; and a plugin architecture (different slicers, agentic inference engines, model editors) that the first three might be built on. Each has its open questions in "Future and experimental options" in `docs/DESKTOP_PLAN.md`.
- Details and the "done when" checks for each: the Phases table in `docs/DESKTOP_PLAN.md`.

---

## Unreleased

Owner's reports and requests of 2026-10-06 (0.4.1). The owner put the settings work ahead of editing the code in the viewer; both are in this release, with a fix for links in documents asked for before it went out.

- **Fixed: no settings for models whose values are typed into a module call** (owner's report, 2026-10-06: every model of [chrisspen/gears](https://github.com/chrisspen/gears) rendered but had no settings). Its examples are files like `include <../gears.scad>` + `bevel_gear(modul=1, tooth_number=30, ...);`, with no top-level variables, so OpenSCAD's Customizer lists nothing. For any project, when a model's file is only includes and calls (no settings, definitions or blocks of its own), reading it now makes a copy with each literal argument lifted into a setting after the includes (named after the argument; positional values named from the module's signature; a second call of the same module numbered `_2`; a name the library already uses as a global gets the module's name in front; `$` arguments stay fixed), described by the library's comment for that argument where it has one (`name = description`). The copy is kept in the library (`sources/<id>/generated/<version>/`, blobs `<id>@<version>~gen:<path>`), names its original at the top, and renders in its place; the original is untouched. All 17 Gears examples now have settings (`demo.scad` already had its own). Project data format 2: projects read by 0.3 are read again when the app starts (they also get their documents then). Its first build failed the Linux acceptance test on an unrelated race (below), so it ships in 0.4.1. Not yet: files with blocks (`difference() { }`, `for`, `if`) or their own definitions.
- **Settings borrow the library's descriptions and drop-downs** (owner's request, after [cfinke/LEGO.scad](https://github.com/cfinke/LEGO.scad)'s examples came up as bare numbers). When a project file calls the module with one of its own Customizer variables (`block(width=block_width, type=block_type, …)` under `// Width of the block, in studs` and `block_type = "brick"; // [brick:Brick, tile:Tile, …]`), the lifted setting gets that variable's comment as its description and its `// [...]` note as its drop-down or slider. The library's call is looked for in the files the model includes, then the project's other model files. An expression of one variable (`reinforcement=(use_reinforcement=="yes")`) lends its description only; a note is used only for a value of the same type, and a slider only when the value is inside it. A module's own `name = description` comment (Gears) still comes first. LEGO.scad's 179 examples now have described settings with Height, Type, Wing type… as drop-downs.
- **Fractions in a call are settings too** (owner's choice: the library's drop-down rather than a number): `height=1/3` becomes the library's own 1/3 choice (`.33333333333`, labelled "1/3"); a value that isn't one of the choices (`2/3`) is added to the list, labelled as written; with no list it's a number. 111 LEGO examples had their height fixed before.
- **Setting names:** a lifted setting is renamed after its module (`block_wing_type`) only when the file `include`s a library with a variable of that name; `use` doesn't bring variables in, so LEGO's examples show "Wing type".
- **Project data format 3.** Only projects with settings lifted from calls are read again (at start-up, or with Read again); others are left as they are.
- **Fixed: a linked project's README pictures** (and the .scad buttons in its Files tab) pointed at nothing: its folder is outside the library. Library paths `~linked/<id>/<path>` now read from the linked folder (the app's `library://` protocol and `workshop-cli serve`).
- **Fixed: an update accepted while a check was still asking GitHub came back as "ready to review"** (and the project's version went back): the check saved the project as it had read it before asking. It now reads it again first. This was the Linux acceptance test failure of the first 0.4.1 build; the test also waits for its own check to finish.
- **The Code tab is an editor** (owner's request: edit the raw OpenSCAD, Generate from the edits, save them like a preset without touching the original or adding a copy of the model, so library updates aren't affected). On a model's own page, the model's own files (not a library's, not a component's or a pinned component's, not in the inspector) can be edited in place: highlighted as you type, Tab indents, Ctrl+Enter generates, Ctrl+S saves, Revert goes back to the project's version of the file. Generate renders the edited text in place of the file (native OpenSCAD reads it by its hash from the app's data folder, `blob_put`; the WebAssembly engine gets the bytes); while the code is edited only the settings changed from their defaults are passed, so a default changed in the code applies (a note above the form says so), and the status says when the preview is older than the code. **Save** (the settings bar, or Save… in the Code tab) keeps the edits in the saved-settings record next to the values, `edits: { "<path>": { text, base } }` (`recipes/<id>.json` in the library, the browser's storage on the website); the record shows as "· code edited" in the same list. Picking it brings back its values and code; Defaults goes back to the original code (asking first if the edits aren't saved); a preset changes only values. `base` is the hash of the file the edit started from: if an update changed the file since, picking the variant says so and still uses the edited copy. The project's files are never written, and no model is added.
- **Fixed: a link in a README or a PDF could take over the app's window** (owner's report: the website opened in the app with no way back short of restarting). The window is now made by the app (`"create": false` in tauri.conf.json) with a navigation guard: the app's own addresses load, anything else opens in the default browser, and no other windows open (a PDF's links included). If a link still opens a page inside the README or PDF panel, a bar offers "Back to README".
- **Roadmap: a "Future and experimental options" section** (owner's request) in `docs/DESKTOP_PLAN.md`, with direct slicing in the software, multiple libraries and agent integration to edit SCAD files, and a plugin architecture (slicers, inference engines, model editors), each with how it might work and what's still open. Documentation only.
- **Reading projects:** a model's included files are read for lifting only when the model is just includes and calls.
- **Commands:** `blob_put` (an edited file's text, stored by its hash for native renders; the `blob` command reads it back).
- **Tests:** Rust tests for borrowing (straight, expression, type mismatch, out of range, from another file), fractions, `use` vs `include` naming; the acceptance test adds a local project in LEGO.scad's style and checks the descriptions, the Type drop-down, Height showing 1/3, and a render after choosing 1; then edits its code (Generate uses it, saved as a variant with `edits` in the library's record, Defaults is the original, the file and the model list unchanged); the website test edits, saves and switches back too.

## 0.4.0 — 2026-10-06 · Side viewer and reference documents (Phase 4 starts)

Released 2026-10-06 (v0.4.0). Owner's request of 2026-10-05: view a model's raw SCAD script (read-only for now) in a viewer on the right; model documentation works the same way, in a collapsible view with tabs on its edge. The owner's answers to the reference-document questions: documents are project-level (for NopSCADlib, scroll the README to the part); stored as HTML (GitHub READMEs), the raw PDF (Printables) or text (readme.txt); a scratch pad of notes per part comes later.

- **Side viewer:** a collapsible panel on the right with tabs along its edge: **Code** (the model's OpenSCAD files, read-only: line numbers, highlighting, a file picker, Find, Wrap, Copy) and the project's documents (**README**, PDFs, readme.txt). Code and README buttons on model pages, in the inspector and on a project's page; .scad files in a project's Files tab and README links to them open in Code. A component shows the file made for its settings, then the library file that defines it, opened at the module. It follows what's on screen, overlays the right of the window when open, folds away (Esc, ×, or its tab), and remembers its tab and width (drag the edge). On the website too (Code from the model's files, the README from the build).
- **Reference documents** (`desktop/core/src/docs.rs`): found when a project is read: a Markdown README converted to HTML with pulldown-cmark (GitHub tables, task lists, footnotes, heading anchors) and kept at `sources/<id>/docs/<version>/readme.html`; raw HTML in it is kept minus scripts, frames, forms, styles and event handlers, and it's shown in a frame that can't run scripts. Pictures and links stay relative to the project's folder (offline); in-page links scroll. PDFs at the top level or one folder down are kept raw (shown where the webview has a PDF viewer, i.e. Windows; "Open in your PDF viewer" otherwise); readme.txt shows as text. Projects read by 0.3 get theirs when first opened. App libraries' READMEs are converted at build time (`libs/docs/`, pictures and links to GitHub at the pinned commit); built-in families' READMEs by the website build (`data/docs/<family>.html`), copied into the starter projects (existing libraries get them on the next start).
- **Fixed before release** (the first 0.4.0 build failed the Windows app test): the side viewer dropped what it showed whenever the library reloaded (a thumbnail saved, a project read), so Code went blank for a moment and the README frame reloaded (losing its place). It now keeps the model and documents on screen while they're fetched again; only another model or project replaces them. The app test waits for the code itself.
- **New dependency:** `pulldown-cmark` (vendored for offline builds on the `crates-vendor` branch).
- **Commands:** `docs_list` and `doc_get` (a PDF as bytes); `source_get` also returns the version folder's library-relative path. MIME types for PDF, GIF and text in the app's `library://` protocol and `workshop-cli serve`.
- **Tests:** the acceptance test opens a GitHub project model's code and README (HTML kept in the library, a picture from the project's files), a component's generated code and module file, the BOSL2 and Gridfinity Extended READMEs, and a project file from the Files tab; the website test opens Code and README; Rust tests for the conversion, cleaning, anchors and finding documents.

## 0.3.1 — 2026-10-05 · Left menu panel, drop-downs from the docs

Released 2026-10-05 (v0.3.1). Owner's requests of the evening ("a few basic UI changes"):

- **Left menu:** Parametric Models, Components and the Parts Library are rows of their own (no more "All models" / "All components" / "All parts"). The section you're browsing shows its categories, each opening to its projects, in a panel attached to the menu that scrolls on its own and folds to a strip (« / », remembered). In the small-window drawer the categories open under each section instead.
- **Component settings whose docs list their values are drop-downs** (BOSL2 `spheroid()` style: orig, aligned, stagger, octa, icosa; 85 settings in 62 BOSL2 components, including ones that point to another function's list, like `vnf_vertex_array()` style). Lists the docs leave open ("…, or a 3D point") stay text fields. The library index format is now 2.
- **Library settings:** an Edit… button on each project's row, before Hide, opens its details.
- **Fixed:** long text spilling out of its box. A long folder or ZIP path in Add a project pushed the field, the Choose… button and the dialog's contents past the dialog's edge (and the "Link instead of copying" checkbox was stretched); paths now wrap. The details editor's one-line fields wrap and grow to show all their text.
- **Tests:** the acceptance test checks the menu's panel (sections, categories, projects, folding), the spheroid drop-down rendering a choice, Edit… in Library settings, and that a long path and long details stay inside the dialog (34 checks); the website test checks the panel too.
- **This changelog**, combining the git history, release notes, the plan's notes, the early backlog and the owner's requests. `CLAUDE.md` points agents here.
- **Plan:** reference documents for projects added to Phase 4 (requested 2026-10-05; to be discussed before building).

## 0.3.0 — 2026-10-05 · Components (Phase 3)

Released 2026-10-05 (v0.3.0: AppImage, deb, Windows setup). Owner's brief: make the modules inside OpenSCAD libraries usable as forms, in a section of their own ("Components", the owner's choice of name over "Primitives"), with the user's own copy of a library winning over the bundled one and a switch to go back.

**Added**
- **Bundled libraries:** BOSL2, MCAD, NopSCADlib, Round-Anything and threads-scad ship inside the installer (`libs/`, about 9 MB), pinned in `libraries.json` by commit and a SHA-256 over the file list (`tools/fetch_libraries.py`; only OpenSCAD and data files, no docs or tests, no data file over 2 MB). Credits in THIRD_PARTY.md.
- **Components section** in the left menu, between Parametric Models and the Parts Library: 796 modules grouped by topic (Gears & pulleys, Threads, Screws/nuts/fasteners, Bearings, Hinges & joints, Motors, Electronics, Boxes & enclosures, 3D and 2D shapes, Rounding & masks, Paths & sweeps, Textures, Text, Hardware), collapsed, with the libraries inside each topic; also on Home, in the palette and the status bar.
- **Reading a library** (`components.rs`): BOSL2-style doc blocks (Synopsis, Topics, Arguments with defaults, Named Anchors, Examples), NopSCADlib's `//!` comments (and its type constants as choices), or plain module signatures with the comment above. Only modules that make geometry on their own count.
- **Component pages:** the form starts from the first doc example that is a plain call (every such example is a "Start from" preset), else start values from `catalog/components.json`, else guesses from argument names, else empty required fields that must be set first. Empty settings aren't passed (the module's default applies); expression fields take any OpenSCAD value (checked: one expression, no statements, no file access); `anchor`/`orient` are choices; 2D shapes are extruded; Detail (`$fa`, `$fs`, `$fn`). **Copy code** gives the OpenSCAD file. The first render becomes the thumbnail; Library settings can make them all.
- **Rendering a component:** the app writes the file for each render (the library's includes, then one call with the values set) beside the library's laid-out files.
- **Search:** typing a module's name puts it first ("bevel gear" → BOSL2 `bevel_gear()`).
- **Pin as a model:** a component becomes a Parametric Model ("Pinned components" project, `sources/pinned/pins/<id>.json`) with your values as defaults and only the chosen settings shown.
- **Edit form** on any model in the library: labels, help, sections, defaults, limits, box names, choices, show-when conditions, printer-profile links, presets, hidden settings. Stored as `form` in the item's metadata in the same shape as a family manifest (Copy as JSON) and applied with the website build's own code (`ingest::apply_form`, which now also takes `step`, `group` and `placeholder`).
- **Your copy or the app's:** a library you add as a project (role "library") wins over the bundled copy with the same name, for Components and for includes; Library settings → OpenSCAD libraries switches back (`prefer_bundled` in library.json). Projects that include the library are read again. Projects including `<BOSL2/...>` and the others work without adding them.
- **Category icon from an image file** (Library settings → Categories → Image…, kept in the library's `icons/`).
- `workshop-cli libs-index`, `components`, `components-check`.

**Verified**
- BOSL2: all 146 modules whose first doc example is a plain call render it (CI fails otherwise); 21 more start from a later example, 2 from defaults, 32 wait for values. Across all five libraries, every component either renders at its start values or waits for values (429 render, 367 wait).
- The bevel-gear flow (search, open, change teeth and module, preview, download) takes about 5 s in the acceptance test; the plan's target was a minute.
- A Rust test shows a form edit made in the app gives exactly what the same `ui` block in a manifest gives.
- Acceptance test 32 of 32 on Linux CI; the app test opens BOSL2 and threads-scad components in the real app on Linux and Windows.

**Fixed along the way**
- The model benchmark started rendering all 796 components (they joined the model table) and hung CI on ones with unset arguments: `bench` now renders the library's models only.
- Test flakiness: the update check now waits for background work first; the test server reports cancelled renders as cancelled, not as server errors; the browser's harmless "ResizeObserver loop" notice isn't counted as a page error.

**Details:** "Components" in section 2 and "0.3 notes" in `docs/DESKTOP_PLAN.md`.

## 0.2.0 — 2026-10-05 · Portable library (Phase 2) and follow-ups

Released 2026-10-05 (v0.2.0, the first numbered release; the unnumbered `desktop-latest` pre-release was retired).

### Phase 2: the portable library, adding projects, update checks, metadata

Owner's brief: ingest projects from GitHub (with periodic update checks), ZIPs and folders, stored locally; a searchable index ("a bevel gear for a model car, found and generated quickly"); a model library of your own and imported parts. The library folder must be selectable, portable and importable into a new build, with its metadata inside it; metadata editable per project and per file ("relicense a whole project"); printer profiles stay with the app, not the library; the built-in generators and parts become library projects installed alongside the app.

- **One project reader, in Rust**, shared by the app and the website build (`workshop-cli site-prepare` / `site-finish`; output identical to the old Python build).
- **Library folder** (format 1): `library.json`, `sources/<id>/` (source.json, metadata.json, files/<version>/, derived/, thumbs/), `local/` (your own projects, read when they change), `collections/`, `recipes/` (saved settings); relative paths, small sorted JSON, no database. A Phase 1 workspace upgrades itself; a newer format opens read-only. **Merge** combines libraries, with conflicts to pick.
- **Starter library:** the website's 58 generators and the openGrid parts become 19 library projects shipped with the installer and copied in on first start; changed ones arrive as updates.
- **Adding projects:** GitHub link (a pinned commit's tarball, no git; branch, tag, commit and subfolder links), ZIP, folder (copied or linked); "library" projects such as BOSL2 make `<BOSL2/...>` resolve.
- **Update checks:** daily and on request; the new version is read beside the current one and summarised (commits, models added or removed, settings changed); accept or skip; your edits survive.
- **Layered metadata:** item, folder, project, detected, library defaults, with where each value comes from, undo, bulk edit, open fields that become filters and columns.
- **Interface:** project pages (README, files, versions, problems, updates), condensed groups with chosen icons (also on the website).
- **Decided differently from the plan:** search stays in the page (the in-memory index is fast enough and identical to the website's) instead of SQLite.
- **Tests:** `tests/desktop_page.py` (page + real backend; real GitHub in CI, `tests/github_mock.py` locally); CI opens the Linux-made library on Windows and compares.
- **Fixed:** relative paths broke native settings export in CI; local projects re-read after copying (fingerprint by content); a toast showing "null"; the Windows WebDriver test typed the GitHub link and clicked Add before the dialog re-rendered (the dialog now reads the field when submitted); projects added from GitHub got readable names.

### 0.2 follow-ups (from the owner using Phase 2)

- **Numbered releases** (owner request): `0.<phase>.<n>`, version in Settings → About, release only when every check passed.
- **Names** (owner request): "Generators" → **Parametric Models**, "Ready-made parts" → **Parts Library**.
- **Left menu** (owner request): both sections by category, collapsed by default, projects inside; the separate Projects list removed; **Add a project** at the bottom of the menu and on Home. (The owner clarified that "grouping" meant condensing groups in these views, not a project list.)
- **Condense** button (owner request): with no grouping it groups by project; a project's tile opens its page.
- **Editing** (owner request): fields start with the value in use, editable in place; an item can be listed under another project.
- **Hide, delete, flag as broken** (owner request), for items and projects; **trash** for deleted projects with Empty the trash (owner refinement).
- **Library settings** page (owner request): folder, projects, categories (add, rename, remove with items moving, bring back), hidden and deleted items, trash, defaults, GitHub token.
- Update checks run one at a time and respect an update accepted mid-check; web links open in the default browser.
- **Fixed:** thumbnail requests failing for deleted or moved items (they now use the item's own project).

## Before numbered releases

Builds from `main` were published as the rolling `desktop-latest` pre-release.

### Phase 1.5 — 2026-10-04 · Library interface; renamed SCAD Workshop

Owner's brief: the main page had to change drastically to cope with many more models and libraries: a browsable library with several views, search, metadata editing. Also: rename to **SCAD Workshop**, add a night theme, plan for more metadata filters and for Printables ZIPs with their PDFs.

- A clickable mockup first, then the new interface in `web/ui/` (Preact + htm, vendored, no build step): sidebar, browser with grid, list, table and grouped views, inspector, workbench tabs that keep their state, status bar with background jobs, command palette (Ctrl+K), quick look (Space), favourites and recent, light/dark/night themes.
- The `index` seam (`web/ui/index-local.js`): weighted search with prefix, typo and synonym matching, typed filters, facets, sorting; under 15 ms.
- "Updated" filter, sort and column from upstream commit dates (`tools/source_dates.py`).
- Thumbnails for every generator and part (`tools/thumbnails.py`).
- 3D view renders on demand (it had kept the GPU busy even when hidden); the palette no longer loses what you type while it re-renders.
- Rename: the app's identifier stayed the same so settings carried over; the default folder became `~/SCAD Workshop`, with an existing `~/Claude Grid Workshop` still used.
- Tests: `tests/interface.py` (33 checks then; 38 by 0.2).
- 2026-10-05: tabs shrink to fit, the Library tab stays in view, the wheel scrolls the strip (a scrollbar appeared on Windows with four tabs open).

### Phase 1 — 2026-10-03/04 · Desktop shell with native OpenSCAD

Owner's choices (2026-10-03): a desktop version to get past WebAssembly's speed; Tauri over a native UI or Electron (a web wrapper reuses the front end); Windows and Linux; same repository; keep the website as the light version; write the plan into the repo first (`docs/DESKTOP_PLAN.md`, reviewed before Phase 0).

- `desktop/src-tauri` over `desktop/core` (native renders, queue, cancel, on-disk cache, workspace folder, saved settings as files); `workshop-cli` renders every model natively in CI.
- Engine bundling: Windows ships the snapshot folder; Linux ships the AppImage and unpacks it on first start (no FUSE; the `.deb` declares the OpenGL libraries).
- Desktop-only models: the three Underware channels that crash the WebAssembly engine (58 models in the app, 55 on the website).
- Printer profile (bed size, nozzle) bound to the generators that ask for them; magnet and tolerance settings left unlinked on purpose (projects define them differently).
- **Windows engine race:** native OpenSCAD on Windows spends seconds on `use`/`include` for projects split into many files (Gridfinity Extended: about 12 s native vs about 1–4 s in WebAssembly). CI experiments ruled out Defender, the library path and fonts (the same code as one file parses in 0.2 s). So the Windows app races both engines on a model's first render and remembers the winner. Worth reporting upstream.
- Windows fontconfig setup with a persistent cache; the UI font (Archivo) bundled so the app makes no web requests.
- Results: all 58 models render natively on Linux and Windows; on Linux the 55 website models take 28 s natively against 188 s in WebAssembly.

### Phase 0 — 2026-10-03 · Seams, saved settings, share links

- `web/platform.js` chooses engine and storage (browser now, desktop later); prefs in localStorage, saved settings in IndexedDB.
- A settings picker on every model: defaults, author presets, saved sets (save, update, save as new, rename, delete).
- **Share** links with the changed settings compressed into the URL; export and import of OpenSCAD Customizer parameter files.

### The website — 2026-10-03 · Claude Grid Workshop

The first product: a website to generate Gridfinity, openGrid and Honeycomb Storage Wall parts from open-source OpenSCAD projects.

- **First a server** (Starlette: catalog API, render queue with time limits and cancel, STL cache, Docker), then within hours **replaced by a static site** with OpenSCAD running in the browser (pinned 2026.10.02 WebAssembly build, one web worker per render) on GitHub Pages. The server version is kept on `archive/server-v1` (backlog item G1, on hold).
- `tools/build_site.py`: per-model dependency discovery, content-addressed files, bundled fonts, settings from OpenSCAD's own Customizer export, upstream `editor.toml` metadata (conditions, presets, help, section switches).
- Generate, preview (three.js on a 42 mm grid, with dimensions) and download (backlog A1, A2); batch generation to a ZIP (E3); a compact settings form with help on demand; the home page grouped by type, then project; Licenses & credits page.
- Generators added through the day: all of Gridfinity Extended (13 more), four label generators (Laurens Guijt, Maurice Kevenaar, Nadia Santalla with bundled BOSL v1), Just Fit Base Grid and Modular Minimalist Kitchen (owner-supplied), Pred-label bin, Gridfinity Kitchen (owner ZIP; its 12 size files became "Start from" presets, each verified identical), Anylid (owner-supplied, via a bug-fixed copy), openGrid Shelf; Underware enabled for private use with 7 more variants.
- openGrid parts library (44 official parts, CC-BY-4.0 by David D), with what the generator reproduces left out, verified by `tools/parity.py`.
- Fixes worth knowing: SCAD files with CRLF line endings break Customizer dropdowns (normalised); include paths resolved case-insensitively (Extended's marble run includes `dotscad/`, the folder is `dotSCAD`); values a file computes with an expression are passed with `-D` (Kitchen's cutout width).
- Owner's last website request: show a silverware holder's utensil settings only up to the chosen number of utensils, and name the boxes of multi-value settings (family-wide `ui` overrides).

### Foundation — 2026-10-03

- The sources were first collected in a separate repository, **Grid-Storage-Workshop** (two commits, made with Codex): 271 SCAD files vendored with licenses and an audit of the 14 project families on the reference site gridfinity.perplexinglabs.com.
- This repository started from that collection (commit `69e44ab`): 9 families carried forward and re-verified byte for byte against upstream, GRIPS and GridPlates left out (superseded, owner's decision), per-family manifests, schemas, an openGrid Snap adapter, and CI rendering every model. Details: docs/SOURCE_AUDIT.md.
- The website-era feature backlog with IDs (A1 generate, A2 preview, E3 batch, F4 in-browser OpenSCAD, G1 server fallback…) is `docs/FEATURES.md`; the desktop plan superseded it as the roadmap.

---

## Owner requests, in order (desktop era)

What the owner asked for, so the reasons behind the design stay visible. From the working sessions of 2026-10-03 to 2026-10-05.

1. After the website's feature set: "what do you recommend next?"; then fixing the Gridfinity Extended silverware form (utensil settings only up to the chosen count).
2. "Make this a more versatile toolbox for OpenSCAD generation software… something that increases productivity and usability for generating a number of different 3D models" (the owner knows native OpenSCAD).
3. A desktop version to avoid WebAssembly's slowness; asked why a web wrapper rather than native; chose **Tauri**.
4. The vision: a Swiss Army knife of 3D design; common libraries built in; ingest from GitHub links (with periodic update checks) or files, stored locally; an easy-to-search index organised by feature ("a bevel gear for a model car"); a model library for your own and premade models (rugged storage cases, parts for an RC car). Choices: Windows + Linux, same repo, website kept as the light version, plan written into the repo first.
5. Phases 0, 1 approved and built. After testing Phase 1: the interface must change drastically for many more models: browsable library with views, search, metadata editing → Phase 1.5.
6. Later filtering by more metadata; ingesting Printables ZIPs with their PDFs (creator, license, dates); rename to **SCAD Workshop**; a night theme.
7. Roadmap additions: one item per file name with a download format picker; multi-colour and multi-part 3MF; condensed groups with customisable icons.
8. Library storage: a selectable, portable folder importable into a new build; metadata stored with it, editable at group and file level (relicense a project). Printer profiles stay with the software. → Phase 2.
9. The built-in generators and parts become a library installed alongside the software (still in the installer).
10. Clarification: condensing groups in the generator and parts views, not a Projects list; remove the Projects heading. Numbered releases.
11. UI changes before the next version: rename to Parametric Models / Parts Library; editable project text; add an item to an existing project; categories under both sections, collapsible, collapsed by default, with projects inside; a Library settings page for categories; delete, hide, flag as broken. Refinement: deleted projects go to a local trash folder with an option to empty it. → 0.2.
12. Phase 3 as its own section: "Components" (over "Primitives"); for a library present twice, the user's copy wins with a switch back to the bundled one. → 0.3.
13. A reference document per project in the interface (a GitHub project's README, a Printables PDF's information); talk through the implementation when the time comes. → roadmap, Phase 4.
14. One changelog combining all the history, for future agents → this file.
15. Basic UI changes, then a release: the left menu's sub-categories in a collapsible menu attached to it that scrolls ("All Models" replaced by "Parametric Models" and so on); settings like BOSL2 spheroid's "style" as drop-downs if the SCAD files define their values; an Edit button on each project's row in Library settings, before Hide; text running past the edge of its box (the details editor, the folder path). → 0.3.1.
16. A viewer on the right for a model's raw SCAD script (read-only for now); model documentation the same way, a collapsible view with tabs on its edge; part of Phase 4, released. Answers for reference documents: project-level (scroll NopSCADlib's README to the part); HTML for GitHub READMEs, the raw PDF for Printables, readme.txt as text; a scratch pad of notes per part later. → 0.4.0.
17. Bug: the Gears project (chrisspen/gears) renders but none of its models has settings → settings lifted from the values in their module calls, for any project written that way (0.4.1).
18. LEGO.scad (cfinke): fractions like `height=1/3` should be the library's drop-down; lifted settings should borrow the library's own descriptions and choice lists. Then: make the Code viewer editable (Generate uses the edits; Save stores them like saved settings, a variant picked from the same list, never a copy of the model or a change to the original, so updates aren't affected). The owner put the first two ahead of the editor. → 0.4.1 (all three).
19. Links in a README or PDF opened the website in the app's window with no way back → the window keeps the app; the web opens in the browser (0.4.1).
20. A section of the roadmap for future and experimental options: direct slicing in the software, multiple libraries, agent integration to edit SCAD files → "Future and experimental options" in the plan; unscheduled.
21. A plugin architecture added to the same list, for different slicers, agentic inference engines, model editors and so on.
