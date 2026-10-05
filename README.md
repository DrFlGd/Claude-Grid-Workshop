# SCAD Workshop

Generate 3D-printable parts (Gridfinity, openGrid, Honeycomb Storage Wall and friends, with more OpenSCAD projects and libraries to come) from open-source OpenSCAD models, and download ready-made parts. Formerly Claude Grid Workshop; the repository and site addresses keep that name for now. Two ways to run it, sharing one front end:

- **Website:** a static site where OpenSCAD runs in the visitor's browser as WebAssembly, hosted free on GitHub Pages.
- **Desktop app** (Windows, Linux): the same pages in a window, rendering with native OpenSCAD on your computer, several times faster, with your work kept as files in a workspace folder.

**Live site:** https://drflgd.github.io/Claude-Grid-Workshop/
**Desktop app:** installers on the [desktop-latest pre-release](https://github.com/DrFlGd/Claude-Grid-Workshop/releases/tag/desktop-latest) (built from `main` by CI)

## How it works

```
catalog/families/*.json  ─┐                      ┌─> _site/data/catalog.json, data/models/*.json
vendor/, adapters/        ├─> tools/build_site.py ├─> _site/fs/<sha256>   (each SCAD/font file once)
upstream editor.toml      │     + OpenSCAD WASM   ├─> _site/engine/       (OpenSCAD WebAssembly)
catalog/libraries/        ┘                       └─> _site/parts/        (ready-made parts)

Browser: pick model -> form from data/models/<model>.json -> web worker loads
the model's files + OpenSCAD -> STL -> three.js preview -> download
```

- **Engine:** the official OpenSCAD WebAssembly snapshot pinned in `engine.json` (2026.10.02), downloaded and checksum-verified by `tools/fetch_engine.py`. Each render runs in its own web worker (cancel = stop the worker); the page compiles the engine once and reuses it.
- **Files per model:** the build (`build_site.py`, using the desktop app's project reading in `desktop/core` through `workshop-cli`) follows `include`/`use`/`import` from each entrypoint (next to the file first, then the family's library folders, mounted at `/libraries` in the engine) and stores each file once by content hash. The browser fetches only what a model needs and caches it.
- **Settings forms:** OpenSCAD's own Customizer export (`--export-format=param`), run on the same engine at build time. On top of that the site applies the upstream project's `editor.toml` when it has one (the [web-openscad-editor](https://github.com/yawkat/web-openscad-editor) format used by GridFlock and Gridfinity Extended): show-when conditions, presets (e.g. printer bed sizes), help links, collapsed sections, section on/off switches and warnings. Family manifests can add the same metadata (`ui`) for projects without one.
- **Interface:** a library-style layout. The sidebar lists Home, Recent, Favourites, generator categories (each opening into its projects), the parts libraries and "Needs attention". The browser shows any of these as a grid of thumbnails (three sizes), a list, a sortable table with columns you choose, or grouped by project, category, kind or license; the view is remembered per place. An inspector beside it shows the selected item: license, settings count, last upstream update, your saved settings, more from the same project. Opened generators stay open as tabs, with their settings and preview kept. Space opens a quick look (a 3D preview at default settings), Ctrl+K a command palette, `/` the search. Themes: light, dark and night, following the system by default.
- **Search:** one box for generators and parts, matching names, projects, tags, descriptions and setting names ("tooth count" finds the generator that has one), with prefix matching, one-typo tolerance and synonyms (cog → gear, box → case). Filter chips with counts for kind, category, project, license and when the source was last updated; the same filters can be typed (`tag:label project:underware updated:year`). The search sits behind an `index` interface (`web/ui/index-local.js`) so the desktop app can later swap in SQLite.
- **Thumbnails:** `tools/thumbnails.py` renders every generator at its default settings (and every previewable part) in headless Chromium with the site's own viewer, saved as small WebP images.
- **Presets and extra settings:** a model can list whole-model presets (shown as "Start from") and extra settings for values a file computes with an expression, which OpenSCAD's Customizer can't expose; those are passed with `-D`. Gridfinity Kitchen uses both: its 12 size files became presets, verified to render identically to the originals.
- **Saved settings and share links:** each model has a settings picker (defaults, author presets, your saved settings). Saving keeps only what you changed from the defaults, in the browser (IndexedDB). **Share** copies a link that opens the model with your changes (compressed into the URL; nothing is uploaded). Settings can be exported as, and imported from, OpenSCAD Customizer parameter files (`<model>.json`), so they move between the site and native OpenSCAD.
- **Platform layer:** `web/platform.js` picks the render engine and storage. The site uses the WebAssembly engine and browser storage; the desktop app swaps in native OpenSCAD and the workspace folder without changing the rest of the front end.
- **Printer profile:** Settings → print bed size and nozzle. Generators that ask for these (GridFlock, Just Fit, Gridfinity Extended baseplate and connector clips, Gridfinity Rebuilt vase bin) open with your values, marked "profile". Bindings live in the family manifests (`ui` → `"profile"`).
- **Text on parts:** Liberation Sans/Mono are bundled (`assets/fonts`, SIL OFL), since the browser engine has no system fonts. Font menus on label models are limited to these so every choice really changes the result.
- **Line endings:** SCAD files with Windows (CRLF) line endings are normalised when packaged; otherwise OpenSCAD's Customizer can't read their dropdown lists.

## Build and run locally

Needs Python 3.11+ (with numpy for part previews), Node 20+ and Rust (for `workshop-cli`, which reads the projects; the desktop app uses the same code).

```sh
python3 tools/fetch_engine.py --out build/engine        # or --zip <downloaded zip>
(cd desktop && cargo build --release -p workshop-core)   # builds workshop-cli
python3 tools/build_site.py --engine build/engine --out _site
node tools/engine/cli.mjs bench _site --out bench.json --stl-dir build/stl   # renders every model once
python3 tools/thumbnails.py --site _site --stl-dir build/stl                 # thumbnails (needs Playwright)
python3 -m http.server -d _site 8000                     # open http://localhost:8000/
```

The thumbnail step is optional: without it the browser shows a placeholder. `thumbnails.py` can also render the STLs itself with `--native-engine <openscad>`.

Checks (all run in CI, `.github/workflows/site.yml`):

```sh
python3 tools/validate_sources.py                   # vendored files match their pinned hashes
node tools/engine/cli.mjs bench _site               # every model renders; time and memory
python3 tools/parity.py --site _site                # generators vs published parts
python3 tests/screenshots.py --base http://localhost:8000/   # every model in Chromium
```

The desktop workflow (`.github/workflows/desktop.yml`) also renders all 58 models natively on Linux and Windows with `workshop-cli bench`, drives the built app through WebDriver (`tests/desktop_ui.py`) and publishes installers.

CI publishes the benchmark, parity report and screenshots to the `ci-screenshots` branch, and deploys `_site` to GitHub Pages from `main`.

## Enabling GitHub Pages (one time)

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then re-run the latest **Site** workflow (Actions tab), or push any change.

## What is here

| Path | What it holds |
| --- | --- |
| `web/` | The front end (no build step): `app.js` (routing, model pages, forms), `ui/` (sidebar, browser views, inspector, tabs, status bar, palette, quick look, the search index), `lib/` (Preact + htm helpers, a small state store), render worker, three.js preview. `platform.js` picks browser or desktop behaviour. |
| `desktop/` | The desktop app: `core/` (Rust: project reading shared with the website build, the library, native renders, cache, the app's commands, `workshop-cli`) and `src-tauri/` (window, dialogs, `library://`). |
| `vendor/` | Unmodified upstream SCAD projects, pinned to exact commits. |
| `adapters/` | Small SCAD wrappers/fixes where an upstream file can't be used directly (openGrid Snap, Anylid fix). |
| `catalog/families/` | **Generator registry.** One JSON manifest per project. Adding a file here adds a generator. |
| `catalog/libraries/`, `libraries/` | **Parts libraries.** Manifests and the files themselves (3MF, STL, STEP, Shapr3D). |
| `engine.json`, `assets/` | Pinned engine version and checksum; GPL text; bundled fonts. |
| `schema/` | JSON Schemas for families, libraries and built parameters. |
| `sources/` | Provenance: upstream commit lock, SHA-256 of every vendored file, reference-site inventory, parity specs. |
| `tools/` | Build (`build_site.py`, `fetch_engine.py`, `engine/`, `thumbnails.py`, `build_desktop.py`), checks (`validate_sources.py`, `parity.py`, `mesh_stats.py`), `import_library.py`, `source_dates.py` (records when each pinned upstream commit was made), `vendor_preact.py`. |

## Generators

| Family | Models | In the browser | License / public use |
| --- | --- | --- | --- |
| Gridfinity Rebuilt | Bin, Baseplate, Vase Bin | ✅ | MIT · ok |
| Gridfinity Extended | Bin, Baseplate, Connector Clips, Drawers, Item Holder, Lid, Sliding Lid, Bin with Removable Walls, Tray, Silverware Holder, Socket Holder, Sieve, Vertical Divider, Chess Set, Glue Stick Holder, Marble Run | ✅ | GPL-3.0 · ok |
| GridFlock | Baseplate | ✅ | MIT / CC-BY-4.0 · ok |
| Gridfinity Rugged Box | Box (12 parts) | ✅ | CC-BY-SA-4.0 + MIT · ok |
| Gridfinity Basket | Basket | ✅ | MIT · ok |
| Cullenect Label | Label | ✅ | MIT · ok |
| Honeycomb Storage Wall | Grid (v2, v2.3) | ✅ | CC-BY-4.0 · ok |
| openGrid | Grid, Snap, Border | ✅ (Connector source missing) | CC-BY-NC-SA-4.0 · review |
| Label Generator for Gridfinity | Bin Label, Storage Box Label (for Pred's bins and boxes) | ✅ | GPL-3.0 · ok |
| Gridfinity Storage Box Label (Kevenaar) | Box Label | ✅ | CC-BY-4.0 · ok |
| Gridfinity Screw Label (Santalla) | Screw Label | ✅ (adapter fixes include paths) | GPL-3.0-or-later · ok |
| Just Fit Base Grid | Skeleton Baseplate (units, cm or inches) | ✅ | Unstated · review |
| Modular Minimalist Kitchen | Scoop Bin | ✅ (about 25 s per render) | Unstated · review |
| Gridfinity Bin for Pred Labels (3DLG) | Bin with snap-in label holder | ✅ (about 11–13 s) | CC-BY-NC-SA · private use |
| Gridfinity Kitchen | Full Cutout Bin, Edge Cutout Bin (12 size presets from the original files), Spacer, Spacer with Walls | ✅ | MIT |
| Gridfinity Anylid | Lid | ✅ | Unstated · review |
| openGrid Shelf | Shelf | ✅ | Unstated · review |
| Underware (Monokini) | 17 channels, labels and textured variants | ✅ 14 in the browser; T, I-bridge and Mitre channels in the desktop app only | Conflict · private use only |
| Multiboard | — | ❌ source needed | — |

GRIPS and GridPlates are intentionally excluded (superseded). Details: [docs/SOURCE_AUDIT.md](docs/SOURCE_AUDIT.md).

## Adding a generator

1. Vendor the upstream project under `vendor/<name>/` unchanged; record it in `sources/upstream-lock.json` and append hashes to `sources/SHA256SUMS`.
2. Add `catalog/families/<id>.json` (see `schema/family.schema.json`): models, entrypoints, library folders, license, and `editor_toml` if the project ships one.
3. Push. CI builds the site, renders the new models in Node and in Chromium, and deploys.

## Adding a parts library

```sh
python3 tools/import_library.py path/to/unzipped-pack --id my-parts --name "My parts" \
    --license CC-BY-4.0 --public-use ok --author "Someone" --exclude "Big folder/*"
```

Files with the same name (`part.3mf`, `part.step`) become one item with several downloads; 3MF/STL items get a 3D preview and measured size. Rename items or categories in the JSON afterwards: re-running keeps those edits. Keep single files under 100 MB (GitHub's limit). If a generator might already make some of the parts, add a spec in `sources/parity/` and CI reports which published files it reproduces.

## Desktop app

Plan and phases: [docs/DESKTOP_PLAN.md](docs/DESKTOP_PLAN.md). Done so far: the app shell with native rendering (Phase 1), the library-style interface (Phase 1.5), and the portable library with projects added from GitHub, ZIPs and folders, update checks and metadata editing (Phase 2). Library modules as generators (BOSL2's `bevel_gear()` and friends) and the model library come next.

```
web/ (shared UI) --platform.js--> platform-desktop.js --Tauri IPC--> desktop/src-tauri (window, dialogs, library://)
                                                                       └─> desktop/core (Rust, no GUI)
                                                                           api.rs: the app's commands; native OpenSCAD,
                                                                           render queue + cache, library folder, project
                                                                           reading, metadata, updates, merging
```

- **Install:** download from the [desktop-latest pre-release](https://github.com/DrFlGd/Claude-Grid-Workshop/releases/tag/desktop-latest). Windows: the `-setup.exe` (unsigned, so SmartScreen asks once: More info → Run anyway). Linux: the `.deb` (pulls in the OpenGL libraries OpenSCAD needs) or the `.AppImage` (needs `libopengl0 libegl1 libglx0`, present on most desktops).
- **Engine:** the official OpenSCAD snapshot of the same version as the website's (pinned in `engine.json` → `native`). On Linux the app unpacks OpenSCAD's AppImage on first start (a few seconds, once).
- **Library:** everything you add, save or edit lives in one folder, `~/SCAD Workshop` by default (an existing `~/Claude Grid Workshop` folder keeps being used). It's portable: move it, sync it or keep it in git, then use Settings → Library → Open another library, here or on another computer; Merge combines two libraries. The render cache, preferences and printer profile stay with the app on each computer. Layout: `sources/<project>/` (source.json, metadata.json with your edits, files/<version>/ untouched, derived/ what reading found), `local/` (your own projects, read when they change), `recipes/` (saved settings), `library.json`.
- **Starter library:** the generators and parts the website has are packaged as 19 library projects that ship with the installer; the app copies them into your library on first start, where you can edit, relicense or remove them like any other project.
- **Adding projects:** the + beside Projects in the sidebar takes a GitHub link (pinned to a commit and downloaded as plain files; branch, tag, commit and subfolder links work), a ZIP, or a folder (copied, or linked if you're still editing it). Tick "library" for code other projects include (BOSL2, say): `include <BOSL2/std.scad>` then resolves to it. The app finds the models (`.scad` files that make something on their own), reads their settings with OpenSCAD, picks up the README, license, presets and ready-made model files, and draws thumbnails.
- **Updates:** GitHub projects are checked at most once a day (or from the project's page). A newer version is downloaded and read beside the current one and summarised (commits, models added or removed, settings changed) for you to accept or skip; your edits are kept either way. A GitHub token in Settings raises GitHub's hourly limit.
- **Editing details:** Edit details in the inspector or on a project's page changes the name, description, category, tags, license, authors, origin, notes or your own fields (material, print time…) for one item, several, a folder, a whole project or the library's defaults. Each field shows where its value comes from; Ctrl+Z undoes. Your own fields become filters and table columns.
- **Desktop-only models:** Underware T, I-bridge and Mitre channels, which crash the browser engine, work in the app.
- **Speed:** CI renders every model with default settings on both systems (`bench-native-*.json` on the `desktop-ci-linux` / `desktop-ci-windows` branches). On Linux the 55 website models take 28 s natively against 188 s in WebAssembly; the slowest browser models gain most (Minimalist Kitchen bin 25 s → 0.1 s, Pred-label bin 11 s → 0.1 s, Underware wood-texture channel 36 s → 4 s).
- **Windows:** native OpenSCAD on Windows is unusually slow with projects split into many `use`d files: Gridfinity Extended models take 10–15 s natively there, against about 1 s in WebAssembly (it isn't antivirus scanning or the library path; parsing the same code as one file takes 0.2 s). So on Windows the app also carries the website's WebAssembly engine: the first render of each model runs both, keeps the faster result and remembers the winner (Settings shows the count and can forget it). Heavy geometry such as the Underware channels still goes native.

Build it yourself (needs Rust, Node, Python and on Linux the WebKitGTK development packages; see the Linux job in `.github/workflows/desktop.yml` for the exact list):

```sh
python3 tools/fetch_engine.py --out build/engine
python3 tools/fetch_native_engine.py --out build/desktop/engine --extract build/native
(cd desktop && cargo build --release -p workshop-core)
python3 tools/build_site.py --engine build/engine --out _site --native-engine build/native/squashfs-root/AppRun
python3 tools/thumbnails.py --site _site --native-engine build/native/squashfs-root/AppRun
python3 tools/build_desktop.py --site _site --out build/desktop --fetch-fonts   # ui/, site/, starter/
cd desktop && npx @tauri-apps/cli@2 build          # installers in desktop/target/release/bundle/
```

`workshop-cli` runs the app's own code from the command line:

```sh
cli=desktop/target/release/workshop-cli
$cli bench --app-site build/desktop/site --starter build/desktop/starter --engine build/native/squashfs-root   # every model, from the starter library
$cli render --site _site --engine build/native/squashfs-root --model gridfinity-rebuilt/bin --set gridx=3 --out bin.stl
$cli serve --ui build/desktop/ui --app-site build/desktop/site --starter build/desktop/starter \
    --engine build/native/squashfs-root --home /tmp/workshop-home     # the app's page and backend in a browser
$cli library-call --library ~/"SCAD Workshop" --app-site build/desktop/site --engine build/native/squashfs-root \
    source_add '{"kind": "github", "url": "https://github.com/chrisspen/gears"}'
```

`serve` is for testing: open http://127.0.0.1:8790/ with `tests/tauri_shim.js` loaded (as `tests/desktop_page.py` does) to use the app's page in an ordinary browser.

## Server version (on hold)

The earlier version rendered on a server (Starlette + native OpenSCAD in Docker, with a shared render cache). It's preserved on the `archive/server-v1` branch and can come back as an optional fallback for models too heavy for a browser.

## Licensing

The site's **Licenses & credits** page (in the sidebar) lists every project's authors, license, status and source, plus the engine, fonts, three.js, Preact and htm. Model pages only credit the author and link there.


No repository-wide license overrides third-party terms. Each `vendor/` project keeps its own notices; see [THIRD_PARTY.md](THIRD_PARTY.md). The OpenSCAD engine is GPL-2.0-or-later (source: https://github.com/openscad/openscad; text in `assets/engine/COPYING`). Original code in `web/`, `tools/`, `adapters/`, `catalog/` and `schema/` is the repository owner's.

Reference: <https://gridfinity.perplexinglabs.com/> (inventory only; no UI code or adapter scripts copied).
