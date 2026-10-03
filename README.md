# Claude Grid Workshop

Generate 3D-printable storage (Gridfinity, openGrid, Honeycomb Storage Wall and friends) from open-source OpenSCAD models, right in the browser, and download ready-made parts. It's a static website: OpenSCAD runs in each visitor's browser as WebAssembly, so it can be hosted free on GitHub Pages.

**Live site:** https://drflgd.github.io/Claude-Grid-Workshop/ (once Pages is enabled; see below)

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
- **Files per model:** `build_site.py` follows `include`/`use`/`import` from each entrypoint (next to the file first, then the family's library folders, mounted at `/libraries` in the engine) and stores each file once by content hash. The browser fetches only what a model needs and caches it.
- **Settings forms:** OpenSCAD's own Customizer export (`--export-format=param`), run on the same engine at build time. On top of that the site applies the upstream project's `editor.toml` when it has one (the [web-openscad-editor](https://github.com/yawkat/web-openscad-editor) format used by GridFlock and Gridfinity Extended): show-when conditions, presets (e.g. printer bed sizes), help links, collapsed sections, section on/off switches and warnings. Family manifests can add the same metadata (`ui`) for projects without one.
- **Home page:** grouped by type, then by project (each project one block with its generators as chips). Sections fold and remember their state; search shows generators whose name matches, or whole projects whose name, author or description does.
- **Text on parts:** Liberation Sans/Mono are bundled (`assets/fonts`, SIL OFL), since the browser engine has no system fonts. Font menus on label models are limited to these so every choice really changes the result.
- **Line endings:** SCAD files with Windows (CRLF) line endings are normalised when packaged; otherwise OpenSCAD's Customizer can't read their dropdown lists.

## Build and run locally

Needs Python 3.11+ (with numpy for part previews) and Node 20+.

```sh
python3 tools/fetch_engine.py --out build/engine        # or --zip <downloaded zip>
python3 tools/build_site.py --engine build/engine --out _site
python3 -m http.server -d _site 8000                     # open http://localhost:8000/
```

Checks (all run in CI, `.github/workflows/site.yml`):

```sh
python3 tools/validate_sources.py                   # vendored files match their pinned hashes
node tools/engine/cli.mjs bench _site               # every model renders; time and memory
python3 tools/parity.py --site _site                # generators vs published parts
python3 tests/screenshots.py --base http://localhost:8000/   # every model in Chromium
```

CI publishes the benchmark, parity report and screenshots to the `ci-screenshots` branch, and deploys `_site` to GitHub Pages from `main`.

## Enabling GitHub Pages (one time)

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then re-run the latest **Site** workflow (Actions tab), or push any change.

## What is here

| Path | What it holds |
| --- | --- |
| `web/` | The front end (no build step): catalog, forms, render worker, three.js preview, parts pages. |
| `vendor/` | Unmodified upstream SCAD projects, pinned to exact commits. |
| `adapters/` | Small SCAD wrappers/fixes where an upstream file can't be used directly (openGrid Snap, Anylid fix). |
| `catalog/families/` | **Generator registry.** One JSON manifest per project. Adding a file here adds a generator. |
| `catalog/libraries/`, `libraries/` | **Parts libraries.** Manifests and the files themselves (3MF, STL, STEP, Shapr3D). |
| `engine.json`, `assets/` | Pinned engine version and checksum; GPL text; bundled fonts. |
| `schema/` | JSON Schemas for families, libraries and built parameters. |
| `sources/` | Provenance: upstream commit lock, SHA-256 of every vendored file, reference-site inventory, parity specs. |
| `tools/` | Build (`build_site.py`, `fetch_engine.py`, `engine/`), checks (`validate_sources.py`, `parity.py`, `mesh_stats.py`), `import_library.py`. |

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
| Gridfinity Anylid | Lid | ✅ | Unstated · review |
| openGrid Shelf | Shelf | ✅ | Unstated · review |
| Underware (Monokini) | 14 channels, labels and textured variants | ⚠️ T, I-bridge and Mitre channels crash the WASM engine | Conflict · private use only |
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

## Server version (on hold)

The earlier version rendered on a server (Starlette + native OpenSCAD in Docker, with a shared render cache). It's preserved on the `archive/server-v1` branch and can come back as an optional fallback for models too heavy for a browser.

## Licensing

The site's **Licenses & credits** page (linked at the bottom of the home page) lists every project's authors, license, status and source, plus the engine, fonts and three.js. Model pages only credit the author and link there.


No repository-wide license overrides third-party terms. Each `vendor/` project keeps its own notices; see [THIRD_PARTY.md](THIRD_PARTY.md). The OpenSCAD engine is GPL-2.0-or-later (source: https://github.com/openscad/openscad; text in `assets/engine/COPYING`). Original code in `web/`, `tools/`, `adapters/`, `catalog/` and `schema/` is the repository owner's.

Reference: <https://gridfinity.perplexinglabs.com/> (inventory only; no UI code or adapter scripts copied).
