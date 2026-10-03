# Claude Grid Workshop

A web generator for 3D-printable storage (Gridfinity, openGrid, Honeycomb Storage Wall and friends), driven by server-side OpenSCAD and open-source SCAD projects, with room for a searchable library of ready-made STLs.

**Stage: A1 + A2 built.** Pick any of 26 models, change its settings, generate with server-side OpenSCAD, preview in 3D and download the STL. Next features come from [docs/FEATURES.md](docs/FEATURES.md).

## Run it

```sh
docker build -t grid-workshop .
docker run -p 8000:8000 -v gw-cache:/data grid-workshop
# open http://localhost:8000
```

Without Docker: install an OpenSCAD development snapshot (`openscad-nightly`), then `pip install -r requirements.txt` and `uvicorn app.main:app --port 8000`. Settings are listed at the top of `app/main.py` (workers, timeout, cache size, `GW_PUBLIC=1` to hide models whose license isn't cleared for public use).

## What is here

| Path | What it holds |
| --- | --- |
| `app/` | Web server (Starlette): catalog API, parameter validation, render queue, STL cache and downloads. |
| `web/` | Front end: catalog, auto-built settings forms, three.js 3D preview. No build step. |
| `vendor/` | Unmodified upstream SCAD projects, pinned to exact commits (273 SCAD files). |
| `adapters/` | Small SCAD wrappers/fixes where an upstream file can't be used directly (openGrid Snap, Anylid fix). |
| `catalog/families/` | **Generator registry.** One JSON manifest per project: models, entrypoints, authors, license, engine needs. Adding a file here adds a generator. |
| `catalog/params/` | Customizer parameters extracted from each entrypoint — the raw material for the site's forms. Generated; do not hand-edit. |
| `catalog/libraries/` | **STL library registry.** One manifest per collection of ready-made models (`_example.json` is the template). |
| `schema/` | JSON Schemas for families, STL libraries and extracted parameters. |
| `sources/` | Provenance: upstream commit lock, SHA-256 of every vendored file, reference-site inventory. |
| `tools/` | `extract_params.py` (SCAD → form schema), `validate_sources.py` (hashes + renders every catalog model). |
| `.github/workflows/` | CI: source hashes + STL render of every model; website end-to-end test in a real browser; Docker build and render. |

## Generators collected

| Family | Models | Status | License / public use |
| --- | --- | --- | --- |
| Gridfinity Rebuilt | Bin, Baseplate, Vase Bin | ✅ | MIT · ok |
| Gridfinity Extended | Bin, Baseplate, Connector Clips (+13 more generators vendored) | ✅ | GPL-3.0 · ok |
| GridFlock | Baseplate | ✅ | MIT / CC-BY-4.0 · ok |
| Gridfinity Rugged Box | Box (12 parts) | ✅ | CC-BY-SA-4.0 + MIT · ok |
| Gridfinity Basket | Basket | ✅ | MIT · ok |
| Cullenect Label | Label | ✅ | MIT · ok |
| Honeycomb Storage Wall | Grid (v2, v2.3) | ✅ | CC-BY-4.0 · ok |
| openGrid | Grid, Snap, Border | ⚠️ Connector missing | CC-BY-NC-SA-4.0 · review |
| Underware (Monokini) | 9 channel/label types (+8 variants vendored) | ✅ | License conflict · blocked publicly |
| Gridfinity Anylid | Lid | ✅ (supplied file, bug-fixed copy) | Unstated · review |
| openGrid Shelf | Shelf | ✅ (supplied file) | Unstated · review |
| Multiboard | — | ❌ source needed | — |

GRIPS and GridPlates are intentionally excluded (superseded). Details: [docs/SOURCE_AUDIT.md](docs/SOURCE_AUDIT.md).

## Adding a generator

1. Vendor the upstream project under `vendor/<name>/` unchanged; record it in `sources/upstream-lock.json` and append hashes to `sources/SHA256SUMS`.
2. Add `catalog/families/<id>.json` (see `schema/family.schema.json`): models, entrypoints, `fixed`/`defaults`, `part_parameter`, library paths, license.
3. Run `python3 tools/extract_params.py --all` and commit `catalog/params/`.
4. Push — CI renders every model and reports failures.

## Adding an STL library

Copy `catalog/libraries/_example.json`, list the items and files, set the license. Large binaries go in Git LFS or object storage, referenced by `storage`.

## Licensing

No repository-wide license overrides third-party terms. Each `vendor/` project keeps its own notices; see [THIRD_PARTY.md](THIRD_PARTY.md). Original code in `adapters/`, `tools/`, `catalog/` and `schema/` is the repository owner's.

Reference: <https://gridfinity.perplexinglabs.com/> (inventory only; no UI code or adapter scripts copied).
