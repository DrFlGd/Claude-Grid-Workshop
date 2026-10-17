# Settings edge cases

Each `<name>.scad` here is a model whose settings the app has read wrongly (or nearly), with `<name>.expect.json` saying what reading it should give. `cargo test -p workshop-core settings_edge_cases` reads them all (`desktop/core/src/ingest.rs`).

`<name>.expect.json`: `{ "choices": { "<setting>": ["<value>", …] }, "typed": ["<setting>", …] }` — the drop-downs read from the code, in order, and the text settings that stay typed in.

To add the owner's failed cases: put the model's file here, trimmed to what shows the problem, with its expectation.
