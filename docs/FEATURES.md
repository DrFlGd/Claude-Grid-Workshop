# Feature backlog — pick the order

**Built:** A1, A2, a first version of C1 (one library, browse/preview/download) and C2 (import tool). Reply with the IDs you want next.

## A. Core generator (the site's reason to exist)

| ID | Feature | What you get |
| --- | --- | --- |
| A1 ✅ | **Generate & download** | Pick a model, fill in a form auto-built from the SCAD parameters, Generate (server-side OpenSCAD), download STL. |
| A2 ✅ | **3D preview** | Orbit/zoom/pan viewer of the result, with overall dimensions shown. |
| A3 | **Friendly forms** | Grouped settings, Simple/Advanced toggle, help text, units, sliders/dropdowns, reset-to-default, show-only-when-relevant fields. Curated per model on top of the auto-extracted parameters. |
| A4 | **Model catalog home** | Cards by system (Gridfinity, openGrid, HSW, …) and type (bins, baseplates, labels, wall, carrying), search, author credit and license on every model. |
| A5 | **Fast repeat renders** | Job queue with progress and cancel; identical settings are cached and download instantly. |
| A6 | **Multi-part downloads** | One click for every part of a model (e.g. Rugged Box bottom, top, latches, handle) as a ZIP. |

## B. More generators

| ID | Feature | What you get |
| --- | --- | --- |
| B1 | **Switch on vendored extras** | 13 more Gridfinity Extended generators (drawers, lids, sliding lids, item holder, silverware, socket holder, trays, sieve, dividers…) and 8 more Underware variants. Already in the repo. |
| B2 | **Drawer-fit wizard** | Enter drawer size and printer bed; get a split, interlocking baseplate set (GridFlock) plus a bin-count summary. |
| B3 | **Your new generators** | The upload path for the generators you'll provide: drop in SCAD + manifest, CI validates, form appears. |
| B4 | **Fill the source gaps** | Anylid, openGrid Shelf, Multiboard, openGrid Connector — once you supply sources. |

## C. STL libraries

| ID | Feature | What you get |
| --- | --- | --- |
| C1 (started) | **Library browser** | Done: browse by category, search, 3D preview, per-file downloads. Still to do: filters by size/system, thumbnails, ZIP downloads. |
| C2 (started) | **Library import tool** | Done: folder → manifest with sizes and hashes, grouped downloads. Still to do: grid-unit detection, thumbnails. |
| C3 | **Auto thumbnails** | Rendered previews for library items and generator presets. |
| C4 | **Unified search** | One search box across generators and libraries ("2x3 bin" finds both the generator and matching STLs). |

## D. Save & share

| ID | Feature | What you get |
| --- | --- | --- |
| D1 | **Share links** | Settings encoded in the URL; open it and the form is filled in. |
| D2 | **Presets** | Named presets per model, JSON import/export; site-provided starter presets. |
| D3 | **History & favourites** | Recent generations and starred models, stored in the browser. |
| D4 | **Accounts & cloud saves** | Sign-in, saved projects across devices. Later; needs a database. |

## E. Output

| ID | Feature | What you get |
| --- | --- | --- |
| E1 | **3MF export** | Alongside STL (where the engine supports it), including multi-colour where models define it. |
| E2 | **Source bundle** | ZIP with the STL, the exact SCAD, your settings and license notices — satisfies GPL/CC terms and makes renders reproducible. |
| E3 | **Batch generate** | A list of sizes/configs rendered in one go, downloaded as a ZIP. |

## F. Planning & quality

| ID | Feature | What you get |
| --- | --- | --- |
| F1 | **Printer profiles** | Save your bed size; warnings when a part won't fit; auto-split where the generator supports it. |
| F2 | **Print estimates** | Volume, rough filament weight and cost per part. |
| F3 | **Drawer layout planner** | Drag bins onto a measured drawer grid, catch overlaps, generate the full set. |
| F4 | **Instant in-browser preview** | OpenSCAD (WebAssembly) renders a quick preview while you type; the server makes the final file. |

## G. Running it

| ID | Feature | What you get |
| --- | --- | --- |
| G1 | **Deployable container** | One Docker image (web app + pinned OpenSCAD + workers), sandboxed renders with time/memory limits. |
| G2 | **Admin view** | Enable/disable families (license gating for openGrid/Underware), see render stats and failures. |
| G3 | **Upstream tracker** | Flags new upstream commits, re-renders, and shows what parameters changed before you update. |

## Suggested first milestone

**A1 + A2 + A3 + A4 + A5 + G1** — a working, good-looking generator for every collected model, deployable. Then **C1 + C2** (STL libraries) and **B3** (your generators), since those drive the framework's extensibility.

## Decisions needed from you

1. **Hosting** — where it runs (your own server/VPS, Fly.io, Render, Railway, home lab…). Server-side OpenSCAD needs a container host, not static hosting.
2. **Public or private** — openGrid's code is non-commercial and Underware's license is contradictory. Private/personal use is simplest; public use needs those resolved or the families hidden.
3. **Missing sources** — Anylid, openGrid Shelf, Multiboard (which one?), openGrid Connector.
4. **STL storage** — how big your libraries are (Git LFS is fine for a few GB; beyond that, object storage such as S3/R2).
