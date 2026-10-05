# SCAD Workshop: desktop app plan

The project was called Claude Grid Workshop until Phase 1.5. The repository and website addresses keep the old name for now.

Status (2026-10-04):

- **Phase 0 done:** engine and storage seams, saved settings, share links, OpenSCAD parameter-file import/export.
- **Phase 1 done:** see "Phase 1 notes" at the end.
- **Phase 1.5 done:** the library interface (section 5); see "Phase 1.5 notes" at the end.
- **Next:** Phase 2, ingest and the SQLite index.

## Goal

A desktop "Swiss Army knife" for parametric 3D design on **Windows and Linux**:

1. **Generate**: find any generator or library part quickly ("bevel gear", "gridfinity bin", "hinge") and get a printable file in seconds.
2. **Ingest**: add new projects from a GitHub link (with update checks) or from a file, ZIP or folder, stored locally.
3. **Index**: one searchable, browsable index of everything available, organised by what it makes.
4. **Library**: keep models, both ones you generated and premade ones you imported, in collections for a use case (a rugged case, the parts for one RC car).
5. **Browse**: a library-style interface (grid, list and table views, search with filters, an inspector that edits metadata) that stays quick with thousands of items.

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
  └── in Tauri ──────> engine: native OpenSCAD (render queue)  storage: library folder
                         │
desktop/src-tauri (Rust) ├── jobs: run openscad, N in parallel, cancel, cache
                         ├── sources: download, pin, check for updates
                         ├── ingest: entrypoints, includes, settings, licenses, thumbnails
                         ├── index: SQLite + full-text search
                         └── library: collections, imports, recipes, export
```

**Seams in the front end** make one UI work in both places:

- `engine`: `render(model, files, settings) -> STL/3MF` plus progress and cancel. Today's `engine-client.js` becomes the browser implementation; the desktop one calls a Tauri command.
- `store`: saved settings, projects and library. Browser: IndexedDB. Desktop: files in the library folder.
- `index` (added for the new interface, section 5): `query({ text, filters, sort, group, offset, limit }) -> { total, items, facets }`, `get(id)`, `update(id, patch)`. Browser: in memory over `catalog.json`, read-only. Desktop: SQLite in Rust, so the page never loads the whole catalog.

The page detects Tauri at start-up and picks the implementation. Everything above the seams is shared.

### Native engine

- The pinned OpenSCAD snapshot (same version as `engine.json`, today 2026.10.02) ships inside the app. On Windows that's the snapshot's ZIP folder. On Linux it's the AppImage contents, extracted at build time so there's no AppImage inside an AppImage. Both are bundled as Tauri resources and launched by path. CI downloads them and checks their SHA-256, like the WebAssembly engine.
- **Render queue:** one OpenSCAD process per job, up to (cores − 1) at once; cancel kills the process.
- **Cache:** results are stored in the app's data folder on the computer (not in the library), keyed by a hash of (engine version, model files, settings). Repeating a render is instant.
- **Fonts and libraries:** native OpenSCAD sees system fonts, and `OPENSCADPATH` points at the bundled libraries and those in the library folder.
- **Benchmark:** `tools/engine/cli.mjs bench` gets a native mode, so CI records native vs WebAssembly times side by side.

### Library folder

Everything you add, make or edit lives in one **library folder**. You choose it on first run and can change it in Settings. The default is `~/SCAD Workshop`: today's workspace folder becomes the library in Phase 2, without moving anything. The folder is self-contained and portable:

- move or copy it to another disk or computer, sync it (Syncthing, OneDrive, Dropbox) or put it in git, then point any build of the app at it with **Open library…**;
- it holds the files and all their metadata; nothing about the library lives only inside the app;
- paths inside it are relative, and its JSON files are small, pretty-printed with sorted keys and written atomically (write, then rename), so sync tools and git diffs stay clean;
- it holds no database. The search index is rebuilt from the folder (a few seconds per thousand items) and kept on the computer, because SQLite files and file-sync tools don't mix well.

```
My SCAD Library/
  library.json                        name, id, format version, library-wide defaults
  sources/<source>/                   one folder per project you added
    source.json                       origin (GitHub repo + pinned commit, Printables page, ZIP or folder),
                                      what ingest detected (license, authors, dates), update state
    metadata.json                     your edits: project, folder and file level (see "Metadata levels")
    files/<version>/...               the downloaded or extracted files, untouched, one folder per version
  local/<project>/                    your own projects: drop .scad or model files here and the app picks them up
                                      (edited in place, not versioned)
  collections/<name>/collection.json  items by id (not copies), quantities, notes, status, icon
  recipes/<id>.json (+ output file)   saved settings, with their output format and last output
  builtin/metadata.json               your edits to the app's built-in generators and parts
  profiles/                           printer profiles (bed size, nozzle)
  thumbs/                             thumbnails, so a moved library shows at once (rebuildable)
```

**How files get in:**

- **GitHub:** not a git clone. The app downloads the repository at one commit (GitHub's tarball) into `files/<commit>/`: plain files exactly as upstream has them, which open in OpenSCAD directly, with no git needed and each version pinned. An update downloads the new commit beside the old one. The old one is kept while a saved recipe uses it; "Clean up" removes unused versions.
- **Printables or any ZIP:** extracted unchanged into `files/<version>/`. What the PDF or README says goes into `source.json` as detected metadata.
- **A folder elsewhere on disk:** copied in by default. A project you are still developing can instead be **linked** (left where it is). A linked folder isn't portable, so if it's missing after a move it shows under "Needs attention" to relink.

**On this computer only** (the app's data folder, not the library): the search index, the render cache, the unpacked OpenSCAD engine, window layout and view preferences, and the list of libraries you've opened. Deleting any of it loses nothing.

**Moving the library or installing a new build:** install, choose **Open library…** and pick the folder. A newer app upgrades an older library format when it opens it (after backing up the JSON files it changes). An older app opens a newer library read-only and says why. **Merge library…** copies another library's sources, collections and recipes into the open one: a source with the same origin and version is kept once, and conflicting metadata is shown side by side to choose from.

**From Phase 1:** today's workspace holds `settings/saved/`, `settings/prefs.json` and `cache/`. On the first start of the Phase 2 app, saved settings move to `recipes/`, the printer profile to `profiles/`, and view preferences and the cache to the computer's app data.

### Metadata levels

Metadata is layered, so one edit can cover a whole project, part of it, or a single item:

| Level | Stored in | Example |
| --- | --- | --- |
| Library | `library.json` | default license and author for your own `local/` projects |
| Project | `sources/<source>/metadata.json` → `project` | license CC-BY-4.0 for the whole project; author; category; icon |
| Folder in a project | same file → `groups["<folder>"]` | tag "lids" for everything in `lids/` |
| Item (one name, all its formats) | same file → `items["<item>"]` | a different license or name for one part |

- **Which value wins:** your edits beat detected values, and among your edits the most specific level wins (item, then folder, then project). Detected values (README, LICENSE, Printables PDF, family manifest) come next, and library defaults only fill fields nothing else set.
- **Changing a whole project** is one edit at project level. Items with their own value keep it, and the inspector says how many do and offers to clear them.
- **Provenance:** every field shows its value and where it came from ("License: CC-BY-4.0, set on the project; detected: none"). "Revert" removes your value at that level.
- **Updates:** detected values live in `source.json` and are refreshed by a source update; your edits live in `metadata.json` and are never touched by one. Edits that no longer match anything (a renamed file or setting) go to "Needs attention".
- **Cross-project groups** (categories, collections) have their own name, description and icon. Editing them doesn't change the license or author of the items inside; for that, select the items and bulk-edit them at item level.
- **Form overlays** (renamed settings, conditions, presets; section 5) are stored per generator in the same project file.

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

**From a model-site download (Printables first):** a Printables ZIP holds the model files plus PDFs carrying the page's details: creator, license, published and updated dates, description, tags and print settings. Ingest reads the PDF text and fills the form from it, so nothing has to be typed:

- fields are picked out by their labels; the exact layout gets confirmed against sample ZIPs when this is built;
- every value records where it came from ("from the Printables PDF"), so the inspector's provenance and "Revert to source" work as for any other source;
- the origin URL lets the app check the page later for a newer upload, as GitHub sources are checked for new commits;
- other sites follow the same pattern with their own extractor (Thingiverse ZIPs carry a README and LICENSE text file; MakerWorld to check).

Items with STL/3MF only go into the model library (section 4); ZIPs that include `.scad` files also become sources with generators.

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
- A module can be **pinned as a generator**, with a nicer name, chosen settings and hidden extras. Pinned generators are stored as small JSON files in the library folder, in the same shape as `catalog/families/*.json`.

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
- creator and origin URL;
- dates: updated upstream (the pinned commit, or the date on a downloaded page), added to the library, last used;
- thumbnail and size;
- any further fields a source supplies (print settings, material, a model site's own category), kept as open key/value metadata so new filters don't need a schema change.

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

**Browse:** see section 5. The home page becomes recent, favourites and category tiles; the current family/project grouping becomes one of the browser's views.

**Target flow (acceptance test for the bevel-gear case):** search "bevel gear" → BOSL2 `bevel_gear()` is the first result → form opens with a preset from the docs → change teeth and module → preview → download STL. All in under a minute on a normal laptop.

## 4. Model library

**Collections** are lists, not folders of copies: a `collection.json` refers to items by id, so one part can be in several collections. Imported files live in `sources/` like any other project (see "Library folder"). Each item is either:

- **premade:** STL, 3MF, OBJ or STEP (files with the same name are one item; see "Files and formats" below), plus origin URL, author and license; or
- **recipe:** a generated model, stored as source, version, model and settings, with its last output file. Recipes can be re-opened in their form, changed, or re-rendered after a source update.

**Per item:** quantity, notes, print settings (material, nozzle, infill and so on, free text to start with), status (to print / printed), and tags.

**Import:** drop files, a ZIP or a folder. Duplicates are found by content hash. Sizes and thumbnails are measured on import. STEP gets a preview through OpenCascade's WebAssembly build (occt-import-js; license to confirm before bundling).

**Export:** a collection as a ZIP (files × quantity, with a parts list), or as a 3MF with parts arranged on the plate (Phase 5).

**Search:** library items are in the same index as generators, so "case latch" finds your saved latch and the generator that made it.

### Files and formats

**One item per name.** Files in the same folder whose names differ only by extension (`latch.stl`, `latch.3mf`, `latch.step`, `latch.f3d`) are one item, wherever they come from: the built-in parts libraries (as `tools/import_library.py` does now), imported folders and ZIPs, Printables downloads, and your own generated outputs. Matching ignores case. Near misses (`latch_v2.stl` beside `latch.3mf`) are listed after an import so you can merge them, and any selection can be merged or split by hand.

- The item lists the formats it has (STL · 3MF · STEP). **Download** has a format picker. The default is your preferred format from Settings (for example "3MF where there is one, otherwise STL"), and the last choice is remembered.
- The preview and thumbnail use the best format the viewer reads: 3MF, then STL, then OBJ; STEP goes through OpenCascade.
- A collection export (ZIP) applies one rule for items with several formats ("3MF where available"), or lets you choose per item.
- Generators get the same picker for their output: STL or 3MF. Saved settings and recipes remember the format.

**Multi-colour and multi-part 3MF**, when a model calls for it:

- **When:** the model colours its parts with `color()` (a label with raised text in a second colour, an inlay), or makes several separate parts at once (the Rugged Box's case, lid and latches; a batch of labels). The render reports how many objects and colours it produced, and the picker offers "3MF, 2 colours" or "3MF, 12 parts" only then. One-part, one-colour models stay a plain choice of STL or 3MF.
- **How:** OpenSCAD keeps top-level objects separate when lazy union is on, and its 3MF export can write colours. Each object becomes a named object in the 3MF with its colour as a material, so Bambu Studio, OrcaSlicer and PrusaSlicer can give each part its own filament. Both need checking against the pinned snapshot, in the WebAssembly and the native engine, before the app relies on them.
- **Projects with a part picker:** many generators make one part at a time, chosen by a setting ("part to print: base / lid / latch"). A family manifest can name that setting, and the download then offers "All parts in one 3MF": the app renders each choice and combines them, laid out side by side.
- **Preview:** the 3D view shows each object in its own colour, with a parts list to show, hide or recolour them, so what you see is what the slicer gets.
- **Batch:** the batch download gains "one 3MF with every variant as a separate object".
- Arranging the parts on the print bed for your printer profile comes in Phase 5.

## 5. Interface

Today's home page is one long scrolling page grouped by type and project. It works for 58 models from 20 projects. It won't work for hundreds of generators, thousands of library modules, and collections of imported parts. The desktop app moves to a workspace layout like a file manager or photo library. The model page (form + 3D view) stays, as the "workbench".

### App layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [≡]  Search everything (Ctrl+K)                          jobs ◔   ⚙       │
├─────────────┬──────────────────────────────────────────┬─────────────────┤
│ Home        │  Gridfinity › Bins            ⊞ ☰ ▤  Sort ▾ │ Inspector       │
│ Recent      │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐        │ [thumbnail]     │
│ Favourites  │  │    │ │    │ │    │ │    │ │    │        │ Basic Bin       │
│ ─────────   │  └────┘ └────┘ └────┘ └────┘ └────┘        │ Gridfinity Ext. │
│ Generators ▸│  Basic  Drawer Tray   Sieve  Lid           │ tags, category, │
│ Modules    ▸│                                            │ license, source │
│ Parts      ▸│  ┌────┐ ┌────┐ ...                         │ [Open] [★] [⋯]  │
│ Collections▸│                                            │                 │
│ Sources    ▸│                                            │ saved settings: │
│ Smart lists▸│                                            │ ▢ ▢ ▢           │
├─────────────┴──────────────────────────────────────────┴─────────────────┤
│ 3 renders running · update available for 2 sources                        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Sidebar** (collapsible):

- Home, Recent and Favourites.
- Generators, library modules, ready-made parts, collections and sources, each as a category tree with counts.
- Smart lists (saved searches).
- "Needs attention": sources with missing includes, failed thumbnails, unknown licenses or updates waiting. Today that list lives only in SOURCE_AUDIT.md.

**Browser** (centre) shows whatever is selected in the sidebar or searched.

**Inspector** (right, toggleable) shows the selected item's details and edits them.

**Workbench:** opening an item opens it in tabs, so several models can stay open with their settings and preview.

**Status bar:** background jobs (renders, batch queue, ingest, thumbnails, update checks) with a drawer to see or cancel them.

### Browser views

All views share selection, sorting and grouping. The app remembers the view per place, so parts can default to large thumbnails and modules to a table.

| View | For | Shows |
| --- | --- | --- |
| **Grid** | Looking for a shape | Thumbnails at three sizes (slider), name, small kind badge |
| **List** | Scanning names | One row each: small thumbnail, name, project, category, tags |
| **Table** | Managing metadata | Sortable, resizable columns you choose: kind, source, license, version, added, last used, size, triangle count, render time |
| **Grouped** | Today's look | Sections by category, project or source, with items as chips or thumbnails |

**Sort:** name, recently used, recently added, most used, source, size.

**Group by:** category, project/source, kind, license or none.

**Condensed groups:** whenever a grouping is chosen, a "Condense" switch beside the Group menu shows each group as a single tile instead of a section. It works in every view and every place: generators, parts, collections and search results.

- The tile shows the group's icon, name and item count. Opening it shows that group's items, with a path back ("Generators › Gridfinity Extended").
- Searching still finds items inside condensed groups; each matching group shows how many of its items match.
- **Group icon:** by default a collage of the first few items' thumbnails. Once metadata is editable (see "Metadata editing" below), you can choose it: one item's thumbnail, a render of a saved setting, or an image of your own. The same icon then appears for that project or category on the home page and in the sidebar.

**Quick look:** Space opens a large preview that you can spin, without leaving the list. For a generator it shows its default render; for a part, the part.

**Multi-select:** Shift/Ctrl-click, or drag a box, then act on all of them:

- tag, set category, favourite;
- add to collection;
- batch render;
- export, or hide.

**Keyboard:** arrows move, Enter opens, Space for quick look, `/` searches, Ctrl+K opens the command palette.

**Scale:** lists are virtualised and thumbnails load lazily, so browsing stays fast with thousands of items.

### Search

- **One search box** for everything: generators, modules, parts, collections, sources, saved settings and setting names ("tooth count" finds gears). Results are grouped by kind with counts.
- **Filters** appear as chips with counts: kind, category, tags, source, license, updated (last month / 3 months / year / older), desktop-only, has thumbnail, recently used. Tags can also be typed: `tag:gear source:BOSL2 kind:module updated:month`.
- **More metadata filters as sources supply them:** creator, license family (CC BY, CC BY-NC, GPL…), date added, and any open metadata field (section 3). A filter menu lists the fields present in the current results, so a field arriving from a new kind of source (a Printables PDF, say) becomes filterable, sortable and a table column without a code change.
- **Forgiving matching:** prefix matching, typo tolerance (SQLite FTS5 plus trigram), and the synonym list from section 3.
- **Size search** for parts and generators that report dimensions: "fits within 84 × 42 mm", or for Gridfinity "2 × 1 units".
- **Saved searches** become smart lists in the sidebar. Recent searches are kept.
- **Command palette** (Ctrl+K): the same box also runs actions such as "Add GitHub source…", "New collection", "Clear render cache" or "Open settings".

### Metadata editing

Everything from a source can be adjusted without touching the source files. Edits are stored in the library folder beside the project they belong to (`sources/<source>/metadata.json`, at project, folder or item level; see "Metadata levels" in the architecture section), so they survive upstream updates and travel with the library.

**In the inspector** (one item, many at once, or a whole group):

- **Level:** selecting a project or folder (in the sidebar, a group heading or a condensed group tile) edits that level, so "license for the whole project" is one change. Each field says which level its value comes from.
- **Item details:**
  - display name, description (Markdown), category (tree picker), tags (autocomplete), favourite, personal notes;
  - author, origin URL and license, with a note of where the information came from.
- **Thumbnail:** re-render from the current or a saved setting, choose the camera angle and colour, or use an image.
- **Groups:** a project's, category's or collection's name, description and icon (the tile shown when groups are condensed, also used on the home page and in the sidebar).
- **Provenance:** each field shows whether it came from the source or from you, with "Revert to source".
- **Undo:** for every edit.

**Form editor** (on the workbench, "Edit form"): what the family manifests' `ui` blocks do today, without editing JSON:

- rename settings;
- set box names for list values (narrow/wide/length/position);
- hide, reorder or group settings;
- add show-when conditions ("only when utensil count ≥ N");
- mark settings as linked to the printer profile;
- add presets.

These are saved as overlays in the same form as `catalog/families` `ui`. A good one can be copied into the repo for everyone.

**Category editor:** rename, move and merge categories, and drag items between them.

**After a source update**, overlays that no longer apply (a renamed or removed setting) show up under "Needs attention" instead of failing silently.

**Exchange:** metadata can be exported and imported, to share a curated catalog or move it between machines.

### Thumbnails

- Rendered automatically at ingest and import, with the same viewer camera and colour for every item, so the grid looks consistent.
- Saved settings and recipes get their own thumbnails, so the inspector shows the variants you've made.
- Premade STL/3MF files are rendered directly; STEP files go through OpenCascade (section 4).
- Thumbnails are stored in `cache/thumbs/` and rebuilt when the source or the engine changes.

### Other parts of the interface

- **Source page:**
  - the README, rendered;
  - license, files, generators and modules found;
  - pinned version, available update with a summary of what changed, and ingest problems.
- **Collection page:**
  - items with quantities and printed/to-print checkboxes, plus a progress bar ("12 of 30 printed");
  - drag in from the browser;
  - export.
- **Compare variants:** two saved settings side by side, or overlaid in the 3D view, with the differing settings highlighted.
- **Drag and drop:**
  - drop a `.scad` file, a ZIP, a folder or an STL/3MF on the window to import it;
  - drag a finished part out to the file manager or a slicer.
- **Theme:** light, dark and night (dim and warm, for a dark workshop), following the system by default.
- **Accessibility:** everything reachable by keyboard, with visible focus, labelled controls and enough contrast. The layout works down to a 900 px wide window.
- **Website:** gets the browser views and search, in read-only form over the built-in catalog. Editing, sources and collections stay desktop-only.

### Front-end structure

`web/app.js` is already about 1,400 lines of hand-built DOM. The new interface (virtual lists, multi-select, an inspector, tabs) needs structure, so before building it:

- Split the front end into modules: shell, browser, inspector, search, workbench, settings.
- Add a small shared state store.
- Use **Preact + htm** for the new views. Both are vendored ES modules of a few KB each and need no build step, so the website still deploys as static files.

Plain web components would also work. Preact makes list virtualisation and editable inspectors much less code.

**Before building:** a clickable mockup of the layout and the four views, to settle the look before code.

## Phases

Each phase ends with something usable and with checks in CI.

| Phase | Delivers | Done when |
| --- | --- | --- |
| **0. Seams** | Engine and store interfaces in `web/`; saved settings and share links on the website (browser storage) | Website unchanged for users, plus saved settings; all 55 models still pass in Chromium |
| **1. Desktop shell** | Tauri app (Windows + Linux) with native engine, render queue, cache, workspace folder, built-in catalog offline, saved settings as files, workspace profile (bed size, tolerances, font) | Installers built in CI; all 55 models render natively (including the 3 Underware channels the browser can't); native vs WebAssembly benchmark published |
| **1.5 Interface** | Mockup first. Then: front end split into modules (Preact + htm); app layout with sidebar, browser, inspector, workbench tabs, status bar; grid, list, table and grouped views; search with filters and command palette; `index` seam (in-memory over `catalog.json` for now); thumbnails for the 58 models; favourites, recent; light/dark/night themes; "Updated" filter and sort from source dates | All 58 models and the parts library browsable in all four views; search and filters answer in under 100 ms; the website keeps working with the new browser views; WebDriver tests updated |
| **2. Ingest + index** | Add from GitHub / file / ZIP; update checks with change summary; Rust ingest CLI shared with the website build; SQLite index behind the `index` seam, with open metadata fields that become filters, sorts and columns; source pages; "Needs attention"; portable library folder (choose, open, move, merge; versioned format; workspace migrated); layered metadata editing at library, project, folder and item level (inspector, overlays, bulk edit, undo, provenance); condensed groups in the browser, with editable group icons | Add 3 public repos by URL; search finds their generators; a simulated upstream change is detected and summarised; edits survive a source update; a project-level license change shows on all its items except those with their own; the library folder, moved to another path and opened on the other operating system's CI runner, shows the same items and metadata; a condensed project shows the icon chosen for it |
| **3. Libraries + modules** | Bundled libraries; BOSL2 doc parser; signature parser; module → form; pinned generators; form editor (labels, box names, conditions, presets as overlays); category editor | The bevel-gear acceptance test passes; every BOSL2 module with geometry gets a form that renders its first doc example; a form edit made in the app matches what a family manifest `ui` block produces |
| **4. Model library + file formats** | Collections; premade import (STL/3MF/OBJ/STEP); Printables ZIPs with their PDF metadata (creator, license, dates); one item per file name with a download format picker (built-in parts, imports and generator output); multi-colour and multi-part 3MF export; recipes; quantities, notes, status; ZIP export; collection page; drag and drop in and out; saved-setting thumbnails and variant compare; size search | Import a pack, save 3 recipes, re-render them after a source update, export the collection; a pack with STL, 3MF and STEP copies of each part imports as one item per name; a two-colour label and the Rugged Box download as 3MF files that open in Bambu Studio and OrcaSlicer with their colours and separate parts |
| **5. Productivity** | Batch from CSV, multi-setting sweeps, multi-part 3MF arranged on the bed for the printer profile, send to slicer (open the file in Bambu Studio / OrcaSlicer / PrusaSlicer), live reload when a watched .scad file is saved | As listed |

## Testing

- **Linux:** automated UI tests through `tauri-driver` (WebDriver) in CI (this environment can't build the app; see Phase 1 notes).
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
| 3MF colour or object export behaves differently in the WebAssembly and native builds | Check both engines in CI with a coloured and a multi-part model; fall back to one STL per colour or part in a ZIP |

## Still open

- Licenses and authors for Anylid, openGrid Shelf, Just Fit and Minimalist Kitchen (owner to supply).
- Multiboard and openGrid Connector sources (owner to supply).
- STEP/Shapr3D files for openGrid tiles: on hold.

## Phase 1 notes

What was built, and where it differs from the plan above.

- **App:** `desktop/src-tauri` (window and commands) over `desktop/core` (Rust with no GUI: native renders, queue, cache, workspace, saved settings as files). The website's front end runs unchanged except for `web/platform-desktop.js`. Data and model files go through the app's commands rather than URLs.
- **Engine bundling:** Windows ships the snapshot folder. Linux ships OpenSCAD's AppImage as one file and unpacks it on first start into the app's data folder, which avoids FUSE and symlinks in the package. The Linux AppImage expects `libOpenGL`, `libEGL` and `libGLX` from the system; the `.deb` declares them.
- **Desktop-only models:** `build_site.py --native-engine` reads the settings of the three Underware channels that crash the WebAssembly engine. The desktop build includes them (58 models); the website build leaves them out (55).
- **Printer profile:** limited to print bed size and nozzle. Magnet and tolerance settings are left unlinked: projects define them differently (hole size with or without clearance), so one value can't safely feed them all. The profile works on the website too.
- **Windows engine race:** native OpenSCAD on Windows spends 4–5 s handling `use`/`include` for Gridfinity Extended. CI experiments ruled out Defender, the library path and font setup; the same code parsed as one file takes 0.2 s. So the Windows app races native against the WebAssembly engine on each model's first render and remembers the faster one. It might be worth reporting upstream to OpenSCAD.
- **Fonts:** on Windows the app writes a fontconfig file (system fonts, OpenSCAD's bundled fonts, a cache in the workspace), because the snapshot ships none. The UI font (Archivo) is bundled, so the app makes no web requests.
- **Testing:** this development environment can't reach crates.io, npm's Tauri packages or Ubuntu's package mirrors. All Rust builds and app tests therefore run in CI (`desktop.yml`):
  - unit tests;
  - `workshop-cli bench` (all 58 models, first and repeated renders) on Linux and Windows;
  - a WebDriver test of the built app on both systems: catalog, native and desktop-only renders, saved settings in the workspace, Settings, a part preview;
  - installers on the `desktop-latest` pre-release.
- **Results (CI, 2026-10-04):**
  - All 58 models render natively on Linux and Windows.
  - In the built app on Windows, the race picked WebAssembly for the Gridfinity Extended bin: 3.7 s, against about 12 s native on the same runner.
  - On Linux, native won (1.1 s).
- **Not yet:**
  - code signing;
  - auto-update (the release is rebuilt from `main`; download it again to update).

## Phase 1.5 notes

What was built, and where it differs from section 5.

- **Mockup first:** a clickable mockup of the layout and the four views settled the look before code.
- **Front end:** `web/ui/` holds the new interface as Preact + htm islands (sidebar, browser, inspector, tabs, status bar, command palette, quick look) sharing one small store (`web/lib/store.js`); about 1,300 lines. `web/app.js` keeps routing, the model workbench (form, preview, batch, saved settings) and the settings and license pages. Preact and htm are vendored as ES modules (`tools/vendor_preact.py`), so the website still deploys as static files with no build step.
- **`index` seam:** `web/ui/index-local.js`, in memory over `catalog.json` and the parts libraries: weighted fields (name, project, tags, category, description, setting names), prefix matching, one-typo tolerance, synonyms, typed filters (`kind:`, `tag:`, `project:`, `cat:`, `license:`, `updated:`), facet counts and sorting. Searches take under 15 ms in CI's Chromium. SQLite replaces it behind the same `query()` in Phase 2.
- **Updated date:** `tools/source_dates.py` records when each pinned upstream commit was made (`source.commit_date` in the family manifests); owner-supplied files use their supply date. The browser can filter (last month / 3 months / year / older), sort and show a column by it. This is the first of the "more metadata" filters (section 5, Search); creator, license family and fields from model-site downloads follow with the Phase 2 index.
- **Thumbnails:** `tools/thumbnails.py` draws every generator's default render and every part preview with the site's own viewer in headless Chromium (480 × 360 WebP, transparent, about 0.8 MB for all). CI makes them from the benchmark's STLs on the website and with native OpenSCAD for the app. Parts that come only as CAD files show their initials.
- **Workbench tabs:** each opened generator keeps its form, unsaved changes and last render while you switch tabs; the open tabs are remembered (browser storage, or the workspace in the app).
- **Themes:** light, dark and night (near-black and warm, with dimmed thumbnails, for a dark workshop), following the system by default. The top-bar button cycles them; Settings has all four choices.
- **Render on demand:** the 3D view now draws only when something changes, so a preview in a hidden tab or a closed quick look uses no GPU time.
- **Rename:** SCAD Workshop. The app's identifier stays the same, so settings carry over; the workspace default is `~/SCAD Workshop`, with an existing `~/Claude Grid Workshop` folder kept in use.
- **Not yet (later phases):** metadata editing (the inspector's "Edit details" is a placeholder), saved searches as smart lists, drag-select, and resizable table columns.
- **Testing:** `tests/interface.py` (33 checks in Chromium: views, parts, filters, search speed and relevance, inspector, quick look, favourites, palette, tabs, themes, phone width) runs in the Site workflow; `tests/desktop_ui.py` gained the library, thumbnails, search, tabs and night-theme checks for both app builds.
