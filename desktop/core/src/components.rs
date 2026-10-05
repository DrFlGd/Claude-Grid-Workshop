//! Library modules as forms: the "Components" section (docs/DESKTOP_PLAN.md,
//! section 2). Reading a library gives an index of its usable modules (what
//! they're called, their arguments, docs and examples); a component's model
//! page is made from that index entry, and rendering it writes a small file
//! that includes the library and calls the module with the values set.
//!
//! Three ways of reading a library:
//! - BOSL2-style doc comments (`// Module:`, `// Function&Module:`, with
//!   Synopsis, Topics, Arguments and Examples): only documented modules count;
//! - NopSCADlib-style `//!` comments on the module line: only those modules;
//! - anything else: every public module, with the comment above it.

use crate::ingest::{self, dirname, join, normpath};
use crate::scan;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Version of the index format (bump to read libraries again).
pub const FORMAT: u64 = 1;

/// Files a library keeps (as tools/fetch_libraries.py): OpenSCAD files and the data files they import.
const KEEP_EXT: [&str; 8] = ["scad", "stl", "dxf", "svg", "dat", "json", "csv", "off"];
const SKIP_TOP: [&str; 9] = ["tests", "test", "docs", "gallery", "examples", "scripts", "tutorials", "images", ".github"];

/// Topic groups in the Components section, in menu order.
pub const GROUPS: [(&str, &str); 16] = [
    ("gears", "Gears & pulleys"),
    ("threads", "Threads"),
    ("fasteners", "Screws, nuts & fasteners"),
    ("bearings", "Bearings"),
    ("hinges", "Hinges & joints"),
    ("motors", "Motors"),
    ("electronics", "Electronics"),
    ("enclosures", "Boxes & enclosures"),
    ("shapes3d", "3D shapes"),
    ("shapes2d", "2D shapes"),
    ("rounding", "Rounding & masks"),
    ("paths", "Paths & sweeps"),
    ("textures", "Textures & patterns"),
    ("text", "Text"),
    ("hardware", "Hardware"),
    ("other", "Other"),
];

pub fn group_label(id: &str) -> &'static str {
    GROUPS.iter().find(|(g, _)| *g == id).map(|(_, l)| *l).unwrap_or("Other")
}

/// The Parametric Models category a pinned component starts in.
pub fn model_category(group: &str) -> &'static str {
    match group {
        "gears" | "threads" | "bearings" | "hinges" | "motors" => "mechanical",
        "fasteners" => "fasteners",
        "enclosures" => "enclosures",
        "text" => "labels",
        _ => "other",
    }
}

// ------------------------------------------------------------------ source scanning

/// The text with comments replaced by spaces (newlines kept) and strings left as they are,
/// so byte offsets match the original.
fn mask_comments(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    out[i] = b' ';
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    if b[i] != b'\n' {
                        out[i] = b' ';
                    }
                    i += 1;
                }
                for k in i..(i + 2).min(b.len()) {
                    out[k] = b' ';
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Index just past the bracket matching the one at `open` (strings skipped).
fn matching(s: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open;
    while i < s.len() {
        match s[i] {
            b'"' => {
                i += 1;
                while i < s.len() && s[i] != b'"' {
                    if s[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Split at top-level `sep` (outside brackets and strings).
pub fn split_top(s: &str, sep: u8) -> Vec<String> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut depth = 0i32;
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            c if c == sep && depth == 0 => {
                out.push(s[start..i].to_string());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(s[start..].to_string());
    out
}

/// `name` or `name = expr` -> (name, expr). None if it isn't an argument.
fn split_arg(a: &str) -> Option<(String, Option<String>)> {
    let a = a.trim();
    if a.is_empty() {
        return None;
    }
    let b = a.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
        i += 1;
    }
    let name = &a[..i];
    let rest = a[i..].trim_start();
    if name.is_empty() || name.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    if rest.is_empty() {
        return Some((name.to_string(), None));
    }
    let rest = rest.strip_prefix('=')?;
    if rest.starts_with('=') {
        return None;
    }
    Some((name.to_string(), Some(rest.trim().to_string())))
}

/// A module definition found in a file.
#[derive(Debug, Clone)]
pub struct ModuleDef {
    pub name: String,
    pub args: Vec<(String, Option<String>)>,
    pub line: usize,
    /// The body calls children() unconditionally and makes nothing itself (an operator).
    pub needs_children: bool,
    /// The body calls children() unconditionally (with or without geometry of its own).
    pub uses_children: bool,
    /// Primitives in the body: (2D ones, 3D ones).
    pub prims: (bool, bool),
    /// Draws only in OpenSCAD's preview (`if ($preview)` with no else): nothing to export.
    pub preview_only: bool,
    /// `//!` on the module line (NopSCADlib), else the comment right above it.
    pub doc_bang: Option<String>,
    pub doc_above: Option<String>,
}

fn prims(body: &str) -> (bool, bool) {
    let has = |w: &str| {
        body.match_indices(w).any(|(i, _)| {
            let before = body[..i].chars().last();
            let after = body[i + w.len()..].trim_start();
            !before.is_some_and(|c| c.is_alphanumeric() || c == '_') && after.starts_with('(')
        })
    };
    let two = ["polygon", "square", "circle", "text"].iter().any(|w| has(w));
    let three = ["cube", "cylinder", "sphere", "polyhedron", "linear_extrude", "rotate_extrude", "import", "surface", "minkowski", "hull"]
        .iter()
        .any(|w| has(w));
    (two, three)
}

/// Top-level module definitions in a file.
pub fn find_modules(text: &str) -> Vec<ModuleDef> {
    let masked = mask_comments(text);
    let b = masked.as_bytes();
    let lines: Vec<&str> = text.lines().collect();
    let mut out = vec![];
    let mut depth = 0i32;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'{' => depth += 1,
            b'}' => depth = (depth - 1).max(0),
            b'm' if depth == 0 && masked[i..].starts_with("module") && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_')) => {
                let after = &masked[i + 6..];
                if !after.starts_with(|c: char| c.is_whitespace()) {
                    i += 1;
                    continue;
                }
                let name_start = i + 6 + (after.len() - after.trim_start().len());
                let name: String = masked[name_start..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                let mut j = name_start + name.len();
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if name.is_empty() || j >= b.len() || b[j] != b'(' {
                    i += 1;
                    continue;
                }
                let Some(close) = matching(b, j) else { break };
                let args: Vec<(String, Option<String>)> = split_top(&masked[j + 1..close - 1], b',').iter().filter_map(|a| split_arg(a)).collect();
                let mut k = close;
                while k < b.len() && b[k].is_ascii_whitespace() {
                    k += 1;
                }
                let (body, end) = if k < b.len() && b[k] == b'{' {
                    let e = matching(b, k).unwrap_or(b.len());
                    (&masked[k..e], e)
                } else {
                    // `module m() statement;`
                    let e = masked[k..].find(';').map(|p| k + p + 1).unwrap_or(b.len());
                    (&masked[k..e], e)
                };
                let line = masked[..i].matches('\n').count();
                let pr = prims(body);
                // an operator: passes its children through and makes nothing of its own
                let uses_children = body.contains("children(") && !body.contains("$children");
                let needs_children = uses_children && !pr.0 && !pr.1;
                let mod_line = lines.get(line).copied().unwrap_or("");
                let doc_bang = mod_line.find("//!").map(|p| mod_line[p + 3..].trim().to_string()).filter(|s| !s.is_empty());
                let doc_above = comment_above(&lines, line);
                let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
                let preview_only = compact.contains("if($preview)") && !compact.contains("else");
                out.push(ModuleDef { name, args, line: line + 1, needs_children, uses_children, prims: pr, preview_only, doc_bang, doc_above });
                i = end;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// The comment block right above a line (`//` lines or one `/* */` block), as text.
fn comment_above(lines: &[&str], line: usize) -> Option<String> {
    let mut i = line;
    let mut got: Vec<String> = vec![];
    if i > 0 && lines[i - 1].trim_end().ends_with("*/") {
        let mut block = vec![];
        while i > 0 {
            i -= 1;
            let l = lines[i];
            block.push(l);
            if l.contains("/*") {
                break;
            }
        }
        block.reverse();
        let text = block.join("\n");
        let text = text.trim().trim_start_matches("/*").trim_end_matches("*/");
        got = text.lines().map(|l| l.trim().trim_start_matches('*').trim().to_string()).collect();
    } else {
        while i > 0 && lines[i - 1].trim_start().starts_with("//") {
            i -= 1;
            got.push(lines[i].trim_start().trim_start_matches('/').trim_start_matches('!').trim().to_string());
        }
        got.reverse();
    }
    let text = got.into_iter().filter(|l| !l.chars().all(|c| "-=*/ ".contains(c)) || l.is_empty()).collect::<Vec<_>>().join("\n");
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

// ------------------------------------------------------------------ BOSL2-style docs

#[derive(Debug, Default, Clone)]
struct Section {
    name: String,
    opts: String,
    title: String,
    body: Vec<String>,
}

/// The sections of one `//` doc block: "Synopsis", "Arguments", "Example"...
fn sections(block: &[&str]) -> Vec<Section> {
    let mut out: Vec<Section> = vec![];
    for l in block {
        let t = l.strip_prefix("//").unwrap_or(l);
        if let Some(rest) = t.strip_prefix(' ').filter(|r| !r.starts_with(' ') && !r.is_empty()) {
            // "// Name(opts): title"
            let head_end = rest.find(':');
            if let Some(he) = head_end {
                let head = &rest[..he];
                let (name, opts) = match head.find('(') {
                    Some(p) if head.ends_with(')') => (&head[..p], &head[p + 1..head.len() - 1]),
                    _ => (head, ""),
                };
                if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '&') && name.starts_with(|c: char| c.is_uppercase()) {
                    out.push(Section { name: name.trim().to_string(), opts: opts.to_string(), title: rest[he + 1..].trim().to_string(), body: vec![] });
                    continue;
                }
            }
        }
        if let Some(s) = out.last_mut() {
            // body lines: "//   text" (indented), or "//" (blank)
            let body = t.strip_prefix("   ").or_else(|| t.strip_prefix("  ")).unwrap_or(t.trim_start());
            s.body.push(body.trim_end().to_string());
        }
    }
    out
}

fn anchor_slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect::<String>()
        .replace(' ', "-")
}

/// Strip markdown the docs use: `code`, [link](target), **bold**.
fn plain(s: &str) -> String {
    let s = s.replace('`', "").replace("**", "").replace("{{", "").replace("}}", "");
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(p) = rest.find('[') {
        out.push_str(&rest[..p]);
        let tail = &rest[p + 1..];
        match (tail.find("]("), tail.find(')')) {
            (Some(a), Some(b)) if a < b && !tail[..a].contains('[') => {
                out.push_str(&tail[..a]);
                rest = &tail[b + 1..];
            }
            _ => {
                out.push('[');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

fn paragraphs(lines: &[String]) -> String {
    let mut paras: Vec<String> = vec![];
    let mut cur: Vec<String> = vec![];
    for l in lines {
        let t = l.trim();
        if t.is_empty() || t == "." {
            if !cur.is_empty() {
                paras.push(cur.join(" "));
                cur.clear();
            }
        } else {
            cur.push(plain(t));
        }
    }
    if !cur.is_empty() {
        paras.push(cur.join(" "));
    }
    paras.join("\n\n")
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ArgDoc {
    pub doc: String,
    pub default_text: Option<String>,
    pub named_only: bool,
}

/// "teeth = Number of teeth.  Default: 20" lines (aliases "l / h = ..." share one), and where `---` starts the named-only ones.
fn parse_arguments(body: &[String]) -> BTreeMap<String, ArgDoc> {
    let mut out: BTreeMap<String, ArgDoc> = BTreeMap::new();
    let mut named_only = false;
    let mut current: Vec<String> = vec![];
    let push = |names: &[String], text: &str, named_only: bool, out: &mut BTreeMap<String, ArgDoc>| {
        let doc = plain(text.trim());
        let default_text = doc.find("Default:").map(|p| doc[p + 8..].trim().trim_end_matches('.').trim().to_string());
        for n in names {
            out.insert(n.clone(), ArgDoc { doc: doc.clone(), default_text: default_text.clone(), named_only });
        }
    };
    let mut text = String::new();
    for l in body {
        let t = l.trim();
        if t == "---" {
            if !current.is_empty() {
                push(&current, &text, named_only, &mut out);
                current.clear();
                text.clear();
            }
            named_only = true;
            continue;
        }
        // a new argument starts at column 0 with "name =" or "a / b ="
        let starts = !l.starts_with(' ') && t.find(" = ").is_some_and(|p| {
            t[..p].split('/').all(|n| {
                let n = n.trim();
                !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
            })
        });
        if starts {
            if !current.is_empty() {
                push(&current, &text, named_only, &mut out);
            }
            let p = t.find(" = ").unwrap();
            current = t[..p].split('/').map(|n| n.trim().to_string()).collect();
            text = t[p + 3..].to_string();
        } else if !current.is_empty() && !t.is_empty() {
            text.push(' ');
            text.push_str(t);
        }
    }
    if !current.is_empty() {
        push(&current, &text, named_only, &mut out);
    }
    out
}

/// The library's file-level "Includes:" lines (BOSL2 LibFile header).
fn file_includes(lines: &[&str]) -> Vec<String> {
    let mut out = vec![];
    let mut in_inc = false;
    for l in lines.iter().take(80) {
        let t = l.trim();
        if !t.starts_with("//") {
            if in_inc {
                break;
            }
            continue;
        }
        let body = t.trim_start_matches('/').trim();
        if body.starts_with("Includes:") {
            in_inc = true;
            continue;
        }
        if in_inc {
            if body.starts_with("include <") || body.starts_with("use <") {
                out.push(body.trim_end_matches(';').to_string());
            } else if !body.is_empty() {
                break;
            }
        }
    }
    out
}

/// Doc blocks of modules in a BOSL2-style file.
struct DocBlock {
    kind: String,
    name: String,
    secs: Vec<Section>,
}

fn doc_blocks(lines: &[&str]) -> Vec<DocBlock> {
    let mut out = vec![];
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        let head = l.strip_prefix("// Module: ").map(|r| ("Module", r)).or_else(|| l.strip_prefix("// Function&Module: ").map(|r| ("Function&Module", r)));
        if let Some((kind, rest)) = head {
            let name: String = rest.trim().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            let start = i;
            while i < lines.len() && lines[i].starts_with("//") {
                i += 1;
            }
            if !name.is_empty() {
                out.push(DocBlock { kind: kind.into(), name, secs: sections(&lines[start..i]) });
            }
            continue;
        }
        i += 1;
    }
    out
}

// ------------------------------------------------------------------ OpenSCAD values

/// A literal OpenSCAD value as JSON (numbers, strings, booleans, undef, vectors of them).
pub fn parse_literal(s: &str) -> Option<Value> {
    let s = s.trim();
    if s == "true" {
        return Some(json!(true));
    }
    if s == "false" {
        return Some(json!(false));
    }
    if s == "undef" {
        return Some(Value::Null);
    }
    if let Some(inner) = s.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return None,
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    c => out.push(c),
                },
                c => out.push(c),
            }
        }
        return Some(json!(out));
    }
    if let Some(inner) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        if inner.trim().is_empty() {
            return Some(json!([]));
        }
        if inner.contains(':') || inner.trim_start().starts_with("for") {
            return None; // ranges, comprehensions
        }
        let items: Option<Vec<Value>> = split_top(inner, b',').iter().map(|x| parse_literal(x).filter(|v| !v.is_null())).collect();
        return items.map(Value::Array);
    }
    let num = s.strip_prefix('+').unwrap_or(s);
    let ok = num.chars().all(|c| c.is_ascii_digit() || ".-+eE".contains(c)) && num.chars().any(|c| c.is_ascii_digit());
    if ok {
        if let Ok(f) = num.parse::<f64>() {
            if f.is_finite() {
                return Some(ingest::int_if_whole(&json!(f)));
            }
        }
    }
    None
}

/// A JSON value as OpenSCAD source.
pub fn to_scad(v: &Value) -> String {
    match v {
        Value::Null => "undef".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if n.is_i64() || n.is_u64() {
                n.to_string()
            } else if f == f.trunc() && f.abs() < 1e15 {
                format!("{}", f as i64)
            } else {
                n.to_string()
            }
        }
        Value::String(s) => {
            let mut o = String::from("\"");
            for c in s.chars() {
                match c {
                    '"' => o.push_str("\\\""),
                    '\\' => o.push_str("\\\\"),
                    '\n' => o.push_str("\\n"),
                    '\t' => o.push_str("\\t"),
                    '\r' => {}
                    c => o.push(c),
                }
            }
            o.push('"');
            o
        }
        Value::Array(a) => format!("[{}]", a.iter().map(to_scad).collect::<Vec<_>>().join(", ")),
        Value::Object(_) => "undef".into(),
    }
}

/// An expression typed into a form: one expression, no statements, no file access.
pub fn check_expression(s: &str) -> Result<()> {
    let masked = mask_comments(s);
    if masked != s {
        bail!("comments aren't allowed in a value ({s})");
    }
    let mut no_strings = String::new();
    let mut in_str = false;
    let mut esc = false;
    for c in s.chars() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
        }
        no_strings.push(c);
    }
    if in_str {
        bail!("a string isn't closed in {s}");
    }
    if no_strings.contains([';', '{', '}']) {
        bail!("a value can't contain ; {{ or }} ({s})");
    }
    for w in ["import", "surface", "include", "use", "module"] {
        if no_strings.split(|c: char| !c.is_alphanumeric() && c != '_').any(|t| t == w) {
            bail!("a value can't use {w} ({s})");
        }
    }
    let mut depth = 0i32;
    for c in no_strings.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth < 0 {
                    bail!("brackets don't match in {s}");
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        bail!("brackets don't match in {s}");
    }
    Ok(())
}

// ------------------------------------------------------------------ examples

/// One statement that is a plain call of the module: its arguments by name
/// (positional ones named from the signature, example variables filled in).
fn plain_call(stmt: &str, module: &str, arg_names: &[String], vars: &BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    let rest = stmt.trim().strip_prefix(module)?.trim_start();
    if !rest.starts_with('(') {
        return None;
    }
    let close = matching(rest.as_bytes(), 0)?;
    if !rest[close..].trim().is_empty() {
        return None; // children or more after the call
    }
    let mut out = BTreeMap::new();
    let mut pos = 0;
    for a in split_top(&rest[1..close - 1], b',') {
        let a = a.trim();
        if a.is_empty() {
            continue;
        }
        let (name, value) = match split_arg(a) {
            Some((n, Some(v))) => (n, v),
            _ => {
                let n = arg_names.get(pos)?.clone();
                pos += 1;
                (n, a.to_string())
            }
        };
        if name.starts_with('$') && !["$fn", "$fa", "$fs"].contains(&name.as_str()) {
            continue;
        }
        if !arg_names.contains(&name) && !name.starts_with('$') {
            return None;
        }
        let value = vars.get(value.trim()).cloned().unwrap_or(value);
        out.insert(name, value.trim().to_string());
    }
    Some(out)
}

/// The plain calls of the module in a doc example: one set of argument values per call.
/// Simple `name = value;` assignments before them are filled in; the example must
/// start with a plain call (after those), and other statements after it are skipped.
fn example_calls(code: &str, module: &str, arg_names: &[String]) -> Vec<BTreeMap<String, String>> {
    let masked = mask_comments(code);
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    let mut specials: BTreeMap<String, String> = BTreeMap::new();
    let mut out = vec![];
    for st in split_top(&masked, b';').iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some((n, Some(v))) = split_arg(st) {
            if !out.is_empty() {
                continue;
            }
            if parse_literal(&v).is_some_and(|l| !l.is_null()) {
                if n.starts_with('$') {
                    specials.insert(n, v);
                } else {
                    vars.insert(n, v);
                }
                continue;
            }
            return vec![]; // a computed variable the call may use
        }
        match plain_call(st, module, arg_names, &vars) {
            Some(mut v) => {
                for (k, x) in &specials {
                    if ["$fn", "$fa", "$fs"].contains(&k.as_str()) {
                        v.entry(k.clone()).or_insert_with(|| x.clone());
                    }
                }
                out.push(v);
            }
            None if out.is_empty() => return vec![],
            None => {}
        }
    }
    out
}

// ------------------------------------------------------------------ reading a library

/// One usable module, as stored in the library index.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Component {
    pub module: String,
    pub file: String,
    pub line: usize,
    pub prelude: Vec<String>,
    pub fileset: usize,
    pub title: String,
    pub synopsis: String,
    pub description: String,
    pub topics: Vec<String>,
    pub group: String,
    /// 2 for a 2D shape (extruded to show and print), else 3
    pub dim: u8,
    pub doc_url: Option<String>,
    /// (name, default expression as written)
    pub args: Vec<(String, Option<String>)>,
    pub arg_docs: BTreeMap<String, ArgDoc>,
    /// the module's named anchors (BOSL2)
    pub anchors: Vec<String>,
    pub examples: Vec<Example>,
    /// choices for an argument: OpenSCAD expressions (NopSCADlib type constants)
    pub choices: BTreeMap<String, Vec<String>>,
    /// its defaults don't make a shape (catalog/components.json "$no_guess"): wait for values
    #[serde(default)]
    pub hold: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Example {
    pub title: String,
    pub code: String,
    /// the example's plain calls of the module, as argument values
    pub calls: Vec<BTreeMap<String, String>>,
    /// drawn in 2D in the docs
    #[serde(default)]
    pub flat: bool,
}

/// What a library is: its name, where it came from, its license.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct LibInfo {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub docs: Option<String>,
}

fn keep_file(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.starts_with('.')) || (parts.len() > 1 && SKIP_TOP.contains(&parts[0])) {
        return false;
    }
    Path::new(rel).extension().and_then(|e| e.to_str()).is_some_and(|e| KEEP_EXT.contains(&e.to_lowercase().as_str()))
}

fn topic_group(t: &str) -> Option<&'static str> {
    let t = t.to_lowercase();
    let is = |k: &[&str]| k.iter().any(|k| t == *k || t.starts_with(k));
    Some(if is(&["gears"]) {
        "gears"
    } else if is(&["threading", "threads", "threaded"]) {
        "threads"
    } else if is(&["screws", "nuts", "fasteners"]) {
        "fasteners"
    } else if is(&["bearings"]) {
        "bearings"
    } else if is(&["hinges", "joiners", "joints", "snaps"]) {
        "hinges"
    } else if is(&["textures", "knurling", "patterns"]) {
        "textures"
    } else if t == "text" {
        "text"
    } else if is(&["rounding", "masking", "masks", "chamfers", "fillets"]) {
        "rounding"
    } else if is(&["shapes (2d)"]) {
        "shapes2d"
    } else if is(&["shapes (3d)"]) {
        "shapes3d"
    } else if is(&["paths", "sweep", "extrusion", "path generators", "regions", "vnf", "bezier", "nurbs"]) {
        "paths"
    } else if is(&["trusses", "cubetruss"]) {
        "shapes3d"
    } else if is(&["parts", "fdm optimized"]) {
        "hardware"
    } else {
        return None;
    })
}

/// The group for a module: its topics (BOSL2), else words in its name and summary, else its file's name.
fn group_for(topics: &[String], words: &str, file: &str, dim: u8) -> &'static str {
    // the first topic that names a group (BOSL2 lists the main one first); "Parts" only if nothing else does
    let groups: Vec<&str> = topics.iter().filter_map(|t| topic_group(t)).collect();
    if let Some(g) = groups.iter().find(|g| **g != "hardware").or(groups.first()) {
        return g;
    }
    if let Some(g) = keyword_group(words).or_else(|| keyword_group(file)) {
        return g;
    }
    if dim == 2 {
        "shapes2d"
    } else if tokens(file).iter().any(|t| t == "vitamins") {
        "hardware"
    } else {
        "shapes3d"
    }
}

fn keyword_group(words: &str) -> Option<&'static str> {
    // whole words (camelCase and snake_case split), matched at their start: "nut" isn't in "donut"
    let w = tokens(words);
    let any = |k: &[&str]| k.iter().any(|k| w.iter().any(|t| t.starts_with(k)));
    Some(if any(&["gear", "rack", "worm", "pulley", "sprocket"]) {
        "gears"
    } else if any(&["thread"]) {
        "threads"
    } else if any(&["screw", "bolt", "nut", "washer", "insert", "rivet", "nail", "fastener", "standoff", "pillar"]) {
        "fasteners"
    } else if any(&["bearing"]) {
        "bearings"
    } else if any(&["hinge", "joint", "dovetail", "snap", "joiner", "clip"]) {
        "hinges"
    } else if any(&["motor", "stepper", "nema", "servo", "extruder", "fan"]) {
        "motors"
    } else if any(&["pcb", "led", "connector", "switch", "battery", "button", "display", "jack", "header", "usb", "resistor", "capacitor", "psu", "relay", "transformer", "socket", "rocker", "fuse", "microswitch", "terminal", "veroboard", "opto", "thermistor", "pin"]) {
        "electronics"
    } else if any(&["box", "enclosure", "case", "housing"]) {
        "enclosures"
    } else if any(&["round", "fillet", "chamfer", "bevel", "mask"]) {
        "rounding"
    } else if any(&["text", "label", "font", "sign", "braille"]) {
        "text"
    } else if any(&["pattern", "texture", "knurl"]) {
        "textures"
    } else if any(&["path", "sweep", "extrude", "spline", "bezier"]) {
        "paths"
    } else {
        return None;
    })
}

/// Lowercase words of a name or text: "polyRoundExtrude" -> poly, round, extrude.
fn tokens(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in s.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn humanize_module(name: &str) -> String {
    // bevel_gear -> "Bevel gear"; ScrewThread -> "Screw thread"; M3_cap -> "M3 cap"
    let mut words: Vec<String> = vec![];
    for part in name.split('_').filter(|p| !p.is_empty()) {
        let mut cur = String::new();
        let chars: Vec<char> = part.chars().collect();
        for (i, &c) in chars.iter().enumerate() {
            let split = i > 0 && c.is_uppercase() && (chars[i - 1].is_lowercase() || chars.get(i + 1).is_some_and(|n| n.is_lowercase()) && chars[i - 1].is_uppercase());
            if split && !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            cur.push(c);
        }
        if !cur.is_empty() {
            words.push(cur);
        }
    }
    let mut out: Vec<String> = vec![];
    for (i, w) in words.iter().enumerate() {
        let keep = w.len() > 1 && w.chars().all(|c| c.is_uppercase() || c.is_ascii_digit()) || w.chars().any(|c| c.is_ascii_digit());
        let w = if keep { w.clone() } else { w.to_lowercase() };
        if i == 0 {
            let mut c = w.chars();
            out.push(c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default());
        } else {
            out.push(w);
        }
    }
    let s = out.join(" ");
    if s.is_empty() { name.to_string() } else { s }
}

/// NopSCADlib-style type constants in a file: `NAME = ["..."` assignments at the top level.
fn type_constants(text: &str) -> Vec<String> {
    let masked = mask_comments(text);
    let mut out = vec![];
    for l in masked.lines() {
        let t = l.trim_start();
        if l.len() != t.len() {
            continue;
        }
        if let Some((n, Some(v))) = t.split_once('=').and_then(|(n, v)| split_arg(&format!("{n}={v}"))) {
            if v.starts_with("[\"") && n.chars().next().is_some_and(|c| c.is_alphabetic()) {
                out.push(n);
            }
        }
    }
    out
}

/// Read a library folder into its component index. `curated`: start values for
/// modules without examples ({ module: { arg: expression } }, catalog/components.json).
pub fn index_library(info: &LibInfo, root: &Path, curated: Option<&Value>, no_guess: Option<&Value>) -> Result<Value> {
    let name = info.name.clone();
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    for f in scan::list_files(root) {
        if keep_file(&f.rel) {
            let data = std::fs::read(root.join(&f.rel)).with_context(|| format!("reading {}", f.rel))?;
            files.insert(f.rel.clone(), hex::encode(Sha256::digest(&data)));
        }
    }
    let read = |rel: &str| String::from_utf8_lossy(&std::fs::read(root.join(rel)).unwrap_or_default()).into_owned();
    let scad: Vec<&String> = files.keys().filter(|r| r.to_lowercase().ends_with(".scad")).collect();
    let texts: BTreeMap<String, String> = scad.iter().map(|r| (r.to_string(), read(r))).collect();
    let docs_style = texts.values().any(|t| t.contains("\n// Module: ") || t.contains("\n// Function&Module: "));
    let bang_style = !docs_style && texts.values().filter(|t| t.contains("//!")).count() > 3;
    let style = if docs_style { "docs" } else if bang_style { "bang" } else { "signatures" };
    let mut comps: Vec<Component> = vec![];
    let mut problems: Vec<String> = vec![];
    for (rel, text) in &texts {
        let defs = find_modules(text);
        let lines: Vec<&str> = text.lines().collect();
        let shape = scan::shape(text);
        let self_ref = |kw: &str| format!("{kw} <{name}/{rel}>");
        let default_prelude = || vec![if shape.geometry { self_ref("use") } else { self_ref("include") }];
        if docs_style {
            let incs: Vec<String> = file_includes(&lines)
                .into_iter()
                .map(|l| match l.split_once('<').and_then(|(kw, r)| r.split_once('/').map(|(lib, path)| (kw, lib, path))) {
                    Some((kw, lib, path)) if lib != name => format!("{kw}<{name}/{path}"),
                    _ => l,
                })
                .collect();
            for blk in doc_blocks(&lines) {
                let get = |n: &str| blk.secs.iter().find(|s| s.name == n);
                let syntags = get("SynTags").map(|s| s.title.clone()).unwrap_or_default();
                // needs children ("CHILDREN", "{ BASE; DIFF1; }") or a parent ("PARENT() show_anchors()")
                let usage_children = blk.secs.iter().filter(|s| s.name == "Usage").any(|s| {
                    s.body.iter().any(|l| l.contains("CHILDREN") || l.contains("PARENT()") || l.contains('{'))
                });
                let Some(def) = defs.iter().find(|d| d.name == blk.name) else {
                    if blk.kind == "Module" {
                        problems.push(format!("{rel}: documented module {}() has no definition", blk.name));
                    }
                    continue;
                };
                // (documented modules call children() for attachments; the docs say which need them)
                if !syntags.split(',').any(|t| t.trim() == "Geom") || usage_children || def.preview_only {
                    continue;
                }
                let arg_names: Vec<String> = def.args.iter().map(|a| a.0.clone()).collect();
                let examples: Vec<Example> = blk
                    .secs
                    .iter()
                    .filter(|s| s.name == "Example" || s.name == "Examples")
                    .map(|s| {
                        let code = s.body.join("\n").trim().to_string();
                        let calls = example_calls(&code, &blk.name, &arg_names);
                        let title = plain(&s.title).trim_end_matches('.').trim().to_string();
                        Example { title, code, calls, flat: s.opts.split(',').any(|o| o.trim() == "2D") }
                    })
                    .collect();
                let topics_first = get("Topics").and_then(|s| s.title.split(',').next().map(|t| t.trim().to_lowercase())).unwrap_or_default();
                let dim = match examples.iter().find(|e| !e.calls.is_empty()) {
                    Some(e) if e.flat => 2,
                    Some(_) => 3,
                    None if topics_first == "shapes (2d)" => 2,
                    None => 3,
                };
                let topics: Vec<String> = get("Topics").map(|s| s.title.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()).unwrap_or_default();
                let anchors: Vec<String> = get("Named Anchors")
                    .map(|s| {
                        s.body
                            .iter()
                            .filter_map(|l| {
                                let t = l.trim();
                                let q = t.strip_prefix('"')?;
                                Some(q[..q.find('"')?].to_string())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let synopsis = get("Synopsis").map(|s| plain(&s.title)).unwrap_or_default();
                let description = get("Description").map(|s| paragraphs(&s.body)).unwrap_or_default();
                let doc_url = info.docs.as_ref().filter(|d| d.contains("BOSL2/wiki")).map(|d| {
                    format!("{}/{}#{}", d.trim_end_matches('/'), rel, anchor_slug(&format!("{}: {}()", blk.kind, blk.name)))
                });
                let group = group_for(&topics, &blk.name, rel, dim).to_string();
                comps.push(Component {
                    module: blk.name.clone(),
                    file: rel.clone(),
                    line: def.line,
                    prelude: if incs.is_empty() { default_prelude() } else { incs.clone() },
                    fileset: 0,
                    title: humanize_module(&blk.name),
                    synopsis,
                    description,
                    topics,
                    group,
                    dim,
                    doc_url,
                    args: def.args.iter().filter(|a| !a.0.starts_with('_') && !a.0.starts_with('$')).cloned().collect(),
                    arg_docs: get("Arguments").map(|s| parse_arguments(&s.body)).unwrap_or_default(),
                    anchors,
                    examples,
                    choices: BTreeMap::new(),
                    hold: false,
                });
            }
            continue;
        }
        // NopSCADlib and plain libraries
        let plural = rel.strip_suffix(".scad").map(|s| format!("{s}s.scad")).filter(|p| texts.contains_key(p));
        let consts = plural.as_ref().map(|p| type_constants(&texts[p])).unwrap_or_default();
        let is_nop = style == "bang";
        for def in &defs {
            // not examples, demos or tests
            let words = tokens(&def.name);
            // (without attachments, a module that calls children() works on them: an operator)
            if def.name.starts_with('_') || def.uses_children || def.preview_only || def.name == "main"
                || words.iter().any(|w| w.starts_with("example") || w.starts_with("demo") || w.starts_with("test") || w == "echo" || w.starts_with("skip"))
            {
                continue;
            }
            let doc = if is_nop { def.doc_bang.clone() } else { def.doc_above.clone().or_else(|| def.doc_bang.clone()) };
            if is_nop && doc.is_none() {
                continue;
            }
            let doc = doc.unwrap_or_default();
            // "inserts a hole in its children": nothing on its own
            if doc.to_lowercase().contains("children") {
                continue;
            }
            let dim = if def.prims.0 && !def.prims.1 { 2 } else { 3 };
            let mut prelude = vec![];
            if is_nop {
                if texts.contains_key("core.scad") {
                    prelude.push(format!("include <{name}/core.scad>"));
                }
                match &plural {
                    Some(p) => prelude.push(format!("include <{name}/{p}>")),
                    None => prelude.extend(default_prelude()),
                }
            } else {
                prelude.extend(default_prelude());
            }
            let mut choices = BTreeMap::new();
            if !consts.is_empty() {
                if let Some(first) = def.args.first() {
                    if first.1.is_none() && (first.0 == "type" || first.0.ends_with("_type")) {
                        choices.insert(first.0.clone(), consts.clone());
                    }
                }
            }
            let first_para = doc.split("\n\n").next().unwrap_or("").replace('\n', " ");
            let synopsis = first_para.split(". ").next().unwrap_or("").trim().trim_end_matches('.').to_string();
            let group = group_for(&[], &format!("{} {synopsis}", def.name), rel, dim).to_string();
            let doc_url = info.repo.as_ref().map(|r| format!("https://github.com/{r}/blob/{}/{rel}#L{}", info.commit.as_deref().unwrap_or("HEAD"), def.line));
            comps.push(Component {
                module: def.name.clone(),
                file: rel.clone(),
                line: def.line,
                prelude,
                fileset: 0,
                title: humanize_module(&def.name),
                synopsis,
                description: doc.clone(),
                topics: vec![],
                group,
                dim,
                doc_url,
                args: def.args.iter().filter(|a| !a.0.starts_with('$')).cloned().collect(),
                arg_docs: BTreeMap::new(),
                anchors: vec![],
                examples: vec![],
                choices,
                hold: false,
            });
        }
    }
    // start values for modules whose docs have none
    for c in comps.iter_mut().filter(|c| c.examples.iter().all(|e| e.calls.is_empty())) {
        let Some(vals) = curated.and_then(|cur| cur.get(&c.module)).and_then(Value::as_object) else { continue };
        let call: BTreeMap<String, String> = vals.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect();
        if call.keys().all(|k| c.args.iter().any(|a| &a.0 == k)) {
            let code = format!("{}({});", c.module, call.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "));
            c.examples.push(Example { title: "Suggested start".into(), code, calls: vec![call], flat: false });
        }
    }
    // otherwise guessed values for arguments with telling names (radius, height, ...) when that covers all the required ones
    let no_guess: Vec<String> = no_guess.and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    for c in comps.iter_mut().filter(|c| c.examples.iter().all(|e| e.calls.is_empty())) {
        c.hold = no_guess.contains(&c.module);
    }
    // (documented libraries have their own examples: no guessing there)
    for c in comps.iter_mut().filter(|c| style != "docs" && c.examples.iter().all(|e| e.calls.is_empty()) && !c.hold) {
        let required: Vec<&String> = c.args.iter().filter(|a| a.1.is_none()).map(|a| &a.0).collect();
        if required.is_empty() {
            continue;
        }
        let guesses: Option<BTreeMap<String, String>> = required.iter().map(|n| guess_value(n).map(|v| (n.to_string(), v.to_string()))).collect();
        if let Some(call) = guesses {
            let code = format!("{}({});", c.module, call.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "));
            c.examples.push(Example { title: "Guessed start values".into(), code, calls: vec![call], flat: false });
        }
    }
    // the same module name in two files: keep the first
    let mut seen = BTreeSet::new();
    comps.retain(|c| seen.insert(c.module.clone()));
    // the files each prelude needs
    let mut filesets: Vec<Vec<String>> = vec![];
    let mut by_prelude: BTreeMap<Vec<String>, usize> = BTreeMap::new();
    for c in comps.iter_mut() {
        let idx = *by_prelude.entry(c.prelude.clone()).or_insert_with(|| {
            filesets.push(closure(&name, &c.prelude, &files, &texts));
            filesets.len() - 1
        });
        c.fileset = idx;
    }
    comps.sort_by(|a, b| a.module.to_lowercase().cmp(&b.module.to_lowercase()));
    Ok(json!({
        "format": FORMAT,
        "library": name,
        "style": style,
        "files": files,
        "filesets": filesets,
        "components": comps,
        "problems": problems,
    }))
}

/// Every library file a prelude reaches through include/use/import.
fn closure(lib: &str, prelude: &[String], files: &BTreeMap<String, String>, texts: &BTreeMap<String, String>) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut todo: Vec<String> = vec![];
    let resolve = |base: &str, r: &str| -> Option<String> {
        let near = normpath(&join(&format!("/{base}"), r)).trim_start_matches('/').to_string();
        if files.contains_key(&near) {
            return Some(near);
        }
        let r = normpath(&format!("/{r}")).trim_start_matches('/').to_string();
        if let Some(inside) = r.strip_prefix(&format!("{lib}/")) {
            if files.contains_key(inside) {
                return Some(inside.to_string());
            }
        }
        None
    };
    for p in prelude {
        let (uses, _) = ingest::references(p);
        for u in uses {
            if let Some(r) = resolve("", &u) {
                todo.push(r);
            }
        }
    }
    while let Some(f) = todo.pop() {
        if !out.insert(f.clone()) {
            continue;
        }
        let Some(text) = texts.get(&f) else { continue };
        let base = dirname(&format!("/{f}")).trim_start_matches('/').to_string();
        let (uses, imports) = ingest::references(text);
        for r in uses.iter().chain(imports.iter()) {
            if let Some(x) = resolve(&base, r) {
                todo.push(x);
            }
        }
    }
    out.into_iter().collect()
}

// ------------------------------------------------------------------ rendering a component

/// How to call a component: its library's includes and the module, with the
/// form's values as named arguments. Sent with a render request.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Call {
    pub prelude: Vec<String>,
    pub module: String,
    /// settings passed as arguments, in order ($fa, $fs, $fn included)
    pub args: Vec<String>,
    /// settings whose values are OpenSCAD expressions, written as typed
    #[serde(default)]
    pub raw: Vec<String>,
    /// a 2D shape: extruded by this setting's value
    #[serde(default)]
    pub extrude: Option<String>,
    /// a first comment line (what made the file)
    #[serde(default)]
    pub title: Option<String>,
}

/// The OpenSCAD file for one render (and "Copy code").
pub fn call_source(call: &Call, values: &BTreeMap<String, Value>) -> Result<String> {
    let mut out = String::new();
    if let Some(t) = &call.title {
        out.push_str(&format!("// {}\n", t.replace('\n', " ")));
    }
    for p in &call.prelude {
        out.push_str(p);
        out.push('\n');
    }
    out.push('\n');
    let mut args = vec![];
    for name in &call.args {
        let Some(v) = values.get(name) else { continue };
        let text = if call.raw.contains(name) {
            match v {
                Value::Null => continue,
                Value::String(s) if s.trim().is_empty() => continue,
                Value::String(s) => {
                    check_expression(s)?;
                    s.trim().to_string()
                }
                other => to_scad(other),
            }
        } else {
            match v {
                Value::Null => continue,
                Value::Object(_) => continue,
                other => to_scad(other),
            }
        };
        if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') {
            bail!("invalid setting name {name}");
        }
        args.push(format!("{name}={text}"));
    }
    if let Some(e) = &call.extrude {
        let h = values.get(e).and_then(Value::as_f64).filter(|h| *h > 0.0).unwrap_or(1.0);
        out.push_str(&format!("linear_extrude(height={})\n  ", to_scad(&ingest::int_if_whole(&json!(h)))));
    }
    let one_line = format!("{}({});", call.module, args.join(", "));
    if one_line.len() <= 100 {
        out.push_str(&one_line);
    } else {
        out.push_str(&format!("{}(\n    {}\n);", call.module, args.join(",\n    ")));
    }
    out.push('\n');
    Ok(out)
}

// ------------------------------------------------------------------ libraries the app knows

/// A library whose modules are components: bundled with the app, or a library
/// project in the user's library.
#[derive(Clone, Debug)]
pub struct ComponentLibrary {
    pub info: LibInfo,
    /// "bundled" or "project"
    pub provider: String,
    pub source_id: Option<String>,
    pub root: PathBuf,
    pub index: Value,
}

impl ComponentLibrary {
    /// "@bosl2"
    pub fn family(&self) -> String {
        format!("@{}", crate::library::slug(&self.info.name))
    }
}

/// The libraries shipped with the app (`libs/`): their pins and indexes (made at
/// build time by `workshop-cli libs-index`, or now if missing).
pub fn bundled(libs: &Path) -> Vec<ComponentLibrary> {
    let pins: Value = std::fs::read(libs.join("libraries.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    let mut out = vec![];
    for p in pins["libraries"].as_array().into_iter().flatten() {
        let Ok(info) = serde_json::from_value::<LibInfo>(p.clone()) else { continue };
        let root = libs.join(&info.name);
        if !root.is_dir() {
            continue;
        }
        let cached = libs.join("index").join(format!("{}.json", info.name));
        let index = std::fs::read(&cached)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|v| v["format"].as_u64() == Some(FORMAT))
            .or_else(|| index_library(&info, &root, curated(libs).get(&info.name), curated(libs).get("$no_guess").and_then(|n| n.get(&info.name))).map_err(|e| eprintln!("library {}: {e:#}", info.name)).ok());
        let Some(index) = index else { continue };
        out.push(ComponentLibrary { info, provider: "bundled".into(), source_id: None, root, index });
    }
    out
}

/// A start value for a required argument, from its name (None if the name doesn't say).
fn guess_value(name: &str) -> Option<&'static str> {
    let t = tokens(name);
    let last = t.last()?.as_str();
    let has = |k: &[&str]| t.iter().any(|w| k.contains(&w.as_str()));
    Some(match last {
        "r" | "radius" | "rad" => "10",
        "d" | "dia" | "diam" | "diameter" => "20",
        "h" | "height" | "z" => "10",
        "l" | "len" | "length" => "20",
        "w" | "width" | "x" | "y" => "20",
        "depth" => "10",
        "thickness" | "thick" | "wall" => "2",
        "teeth" => "20",
        "n" | "count" | "sides" | "segments" | "number" => "6",
        "angle" | "ang" => "45",
        "pitch" => "2",
        "pos" | "position" | "offset" | "translation" => "[0, 0, 0]",
        "rot" | "rotation" | "orientation" => "[0, 0, 0]",
        _ if has(&["radius"]) => "10",
        _ if has(&["diameter", "diam"]) => "20",
        _ if has(&["height"]) => "10",
        _ if has(&["length"]) => "20",
        _ => return None,
    })
}

/// Start values for modules without examples, shipped as libs/components.json (from catalog/components.json).
pub fn curated(libs: &Path) -> Value {
    std::fs::read(libs.join("components.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}))
}

/// Write the indexes of the bundled libraries (build step).
pub fn write_bundled_indexes(libs: &Path) -> Result<Vec<(String, usize)>> {
    let pins: Value = serde_json::from_slice(&std::fs::read(libs.join("libraries.json")).context("libs/libraries.json is missing")?)?;
    std::fs::create_dir_all(libs.join("index"))?;
    let mut out = vec![];
    for p in pins["libraries"].as_array().into_iter().flatten() {
        let info: LibInfo = serde_json::from_value(p.clone())?;
        let index = index_library(&info, &libs.join(&info.name), curated(libs).get(&info.name), curated(libs).get("$no_guess").and_then(|n| n.get(&info.name)))?;
        let n = index["components"].as_array().map(|c| c.len()).unwrap_or(0);
        std::fs::write(libs.join("index").join(format!("{}.json", info.name)), serde_json::to_vec(&index)?)?;
        out.push((info.name, n));
    }
    Ok(out)
}

/// Which copy of each library is used: the user's library project with the same
/// name wins, unless the library prefers the bundled copy (`prefer_bundled` in library.json).
pub fn effective(bundled: &[ComponentLibrary], projects: &[ComponentLibrary], prefer_bundled: &[String]) -> Vec<ComponentLibrary> {
    let key = |n: &str| n.to_lowercase();
    let mut out: Vec<ComponentLibrary> = vec![];
    for p in projects {
        let k = key(&p.info.name);
        let bundled_has = bundled.iter().any(|b| key(&b.info.name) == k);
        if bundled_has && prefer_bundled.iter().any(|x| key(x) == k) {
            continue;
        }
        if out.iter().any(|o| key(&o.info.name) == k) {
            continue; // two projects for one library: the first (by id) wins
        }
        out.push(p.clone());
    }
    for b in bundled {
        if !out.iter().any(|o| key(&o.info.name) == key(&b.info.name)) {
            out.push(b.clone());
        }
    }
    out
}

// ------------------------------------------------------------------ a component's model page

const ANCHORS: [&str; 7] = ["CENTER", "BOTTOM", "TOP", "LEFT", "RIGHT", "FRONT", "BACK"];
const ORIENTS: [&str; 6] = ["UP", "DOWN", "LEFT", "RIGHT", "FWD", "BACK"];
pub const EXTRUDE: &str = "extrude_height";

fn looks_bool(doc: &str) -> bool {
    let d = doc.to_lowercase();
    d.starts_with("if true") || d.starts_with("if set") || d.starts_with("set to true") || d.contains("default: true") || d.contains("default: false")
}

fn looks_number(doc: &str, name: &str) -> bool {
    let d = doc.to_lowercase();
    let n = name.to_lowercase();
    let numeric_default = d.find("default:").is_some_and(|p| d[p + 8..].trim().starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.'));
    numeric_default
        || d.starts_with("number of")
        || d.starts_with("the number")
        || ["diam", "radius", "width", "height", "length", "thick", "angle", "teeth", "pitch", "depth", "count", "clearance", "gap", "wall"]
            .iter()
            .any(|k| n.contains(k) || d.starts_with(&format!("the {k}")))
            && !d.contains("vector")
            && !d.contains("list")
}

/// The model page (same shape as a project's model) for one component.
pub fn component_model(lib: &ComponentLibrary, c: &Component) -> Value {
    let family = lib.family();
    let key = format!("{family}/{}", c.module);
    // every plain call in the examples: (example title, call number, values)
    let calls: Vec<(&str, usize, &BTreeMap<String, String>)> =
        c.examples.iter().flat_map(|e| e.calls.iter().enumerate().map(move |(i, v)| (e.title.as_str(), i, v))).collect();
    let first = calls.first().map(|c| c.2);
    let in_any = |n: &str| calls.iter().any(|c| c.2.contains_key(n));
    let bosl = lib.index["style"] == "docs";
    let mut params: Vec<Value> = vec![];
    let mut raw: Vec<String> = vec![];
    let mut base: Map<String, Value> = Map::new(); // a setting's value when nothing sets it
    let mut names: Vec<String> = vec![];
    for (name, sig) in c.args.iter() {
        if name.starts_with('_') {
            continue;
        }
        let doc = c.arg_docs.get(name).cloned().unwrap_or_default();
        let sig_lit = sig.as_deref().and_then(parse_literal);
        let ex_texts: Vec<&String> = calls.iter().filter_map(|c| c.2.get(name)).collect();
        let ex_lits: Vec<Option<Value>> = ex_texts.iter().map(|t| parse_literal(t)).collect();
        let first_text = first.and_then(|v| v.get(name));
        let group = if bosl && ["anchor", "spin", "orient"].contains(&name.as_str()) {
            "Position"
        } else if !c.arg_docs.is_empty() && doc.named_only && !in_any(name) {
            "More settings"
        } else {
            "Settings"
        };
        let mut p = Map::new();
        p.insert("name".into(), json!(name));
        p.insert("label".into(), json!(name));
        p.insert("group".into(), json!(group));
        let mut desc = doc.doc.clone();
        if desc.is_empty() {
            desc = match sig {
                Some(d) => format!("Default: {d}"),
                None => String::new(),
            };
        }
        p.insert("description".into(), if desc.is_empty() { Value::Null } else { json!(desc) });
        let placeholder = doc.default_text.clone().or_else(|| sig.clone()).map(|d| format!("default: {d}"));
        let choice = |opts: Vec<(Value, String)>, default: Value, p: &mut Map<String, Value>| {
            p.insert("type".into(), json!("expression"));
            p.insert("widget".into(), json!("dropdown"));
            let mut list: Vec<Value> = opts.into_iter().map(|(v, l)| json!({ "value": v, "label": l })).collect();
            if !list.iter().any(|o| o["value"] == default) {
                list.push(json!({ "value": default, "label": default.as_str().unwrap_or("") }));
            }
            p.insert("options".into(), Value::Array(list));
            p.insert("default".into(), default);
        };
        let ex_default = |t: Option<&String>| t.map(|s| json!(s)).unwrap_or(Value::Null);
        if bosl && name == "anchor" {
            let mut opts: Vec<(Value, String)> = vec![(Value::Null, sig.as_ref().map(|d| format!("Default ({d})")).unwrap_or_else(|| "Default".into()))];
            opts.extend(ANCHORS.iter().map(|a| (json!(a), a.to_lowercase())));
            opts.extend(c.anchors.iter().map(|a| (json!(format!("\"{a}\"")), format!("\"{a}\""))));
            choice(opts, ex_default(first_text), &mut p);
            raw.push(name.clone());
            base.insert(name.clone(), Value::Null);
        } else if bosl && name == "orient" {
            let mut opts: Vec<(Value, String)> = vec![(Value::Null, sig.as_ref().map(|d| format!("Default ({d})")).unwrap_or_else(|| "Default".into()))];
            opts.extend(ORIENTS.iter().map(|a| (json!(a), a.to_lowercase())));
            choice(opts, ex_default(first_text), &mut p);
            raw.push(name.clone());
            base.insert(name.clone(), Value::Null);
        } else if let Some(opts) = c.choices.get(name) {
            let default = first_text.map(|s| json!(s)).unwrap_or_else(|| opts.first().map(|o| json!(o)).unwrap_or(Value::Null));
            choice(opts.iter().map(|o| (json!(o), o.clone())).collect(), default.clone(), &mut p);
            raw.push(name.clone());
            base.insert(name.clone(), default);
        } else {
            // literal kinds from the signature and the examples; anything mixed is an expression
            let sig_val = sig_lit.clone().filter(|v| !v.is_null());
            let kinds: Vec<&Value> = sig_val.iter().chain(ex_lits.iter().flatten()).collect();
            let ex_all_lit = ex_lits.iter().all(Option::is_some);
            let is = |f: fn(&Value) -> bool| ex_all_lit && !kinds.is_empty() && kinds.iter().all(|v| f(v));
            let numeric_vec = |v: &Value| v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_number));
            let sig_is_expr = sig.is_some() && sig_lit.is_none();
            if !sig_is_expr && is(Value::is_number) {
                let d = first_text.and_then(|t| parse_literal(t)).or(sig_val.clone()).unwrap_or(Value::Null);
                p.insert("type".into(), json!("number"));
                p.insert("widget".into(), json!("number"));
                if sig_val.is_none() {
                    p.insert("optional".into(), json!(true));
                }
                p.insert("default".into(), d);
                base.insert(name.clone(), sig_val.clone().unwrap_or(Value::Null));
            } else if !sig_is_expr && is(Value::is_boolean) && sig_val.is_some() {
                let d = first_text.and_then(|t| parse_literal(t)).or(sig_val.clone()).unwrap_or(json!(false));
                p.insert("type".into(), json!("boolean"));
                p.insert("widget".into(), json!("checkbox"));
                p.insert("default".into(), d);
                base.insert(name.clone(), sig_val.clone().unwrap_or(Value::Null));
            } else if !sig_is_expr && (is(Value::is_boolean) || sig_val.is_none() && ex_texts.is_empty() && looks_bool(&doc.doc)) {
                let d = first_text.and_then(|t| parse_literal(t)).unwrap_or(Value::Null);
                p.insert("type".into(), json!("boolean"));
                p.insert("widget".into(), json!("dropdown"));
                p.insert("options".into(), json!([{ "value": null, "label": "Default" }, { "value": true, "label": "Yes" }, { "value": false, "label": "No" }]));
                p.insert("default".into(), d);
                base.insert(name.clone(), Value::Null);
            } else if !sig_is_expr && is(Value::is_string) {
                let d = first_text.and_then(|t| parse_literal(t)).or(sig_val.clone()).unwrap_or(Value::Null);
                p.insert("type".into(), json!("string"));
                p.insert("widget".into(), json!("text"));
                if sig_val.is_none() {
                    p.insert("optional".into(), json!(true));
                }
                p.insert("default".into(), d);
                base.insert(name.clone(), sig_val.clone().unwrap_or(Value::Null));
            } else if !sig_is_expr && sig_val.as_ref().is_some_and(numeric_vec) && is(numeric_vec) && kinds.iter().all(|v| v.as_array().map(|a| a.len()) == sig_val.as_ref().and_then(|s| s.as_array()).map(|a| a.len())) {
                let d = first_text.and_then(|t| parse_literal(t)).or(sig_val.clone()).unwrap_or(Value::Null);
                p.insert("type".into(), json!("number[]"));
                p.insert("widget".into(), json!("vector"));
                p.insert("default".into(), d);
                base.insert(name.clone(), sig_val.clone().unwrap_or(Value::Null));
            } else if !sig_is_expr && sig_val.is_none() && ex_texts.is_empty() && looks_number(&doc.doc, name) {
                p.insert("type".into(), json!("number"));
                p.insert("widget".into(), json!("number"));
                p.insert("optional".into(), json!(true));
                p.insert("default".into(), Value::Null);
                base.insert(name.clone(), Value::Null);
            } else {
                p.insert("type".into(), json!("expression"));
                p.insert("widget".into(), json!("text"));
                p.insert("optional".into(), json!(true));
                p.insert("default".into(), ex_default(first_text));
                raw.push(name.clone());
                base.insert(name.clone(), Value::Null);
            }
        }
        if let Some(ph) = placeholder {
            p.insert("placeholder".into(), json!(ph));
        }
        params.push(Value::Object(p));
        names.push(name.clone());
    }
    // 2D shapes are extruded to show and print
    let extrude = (c.dim == 2 && !names.iter().any(|n| n == EXTRUDE)).then(|| EXTRUDE.to_string());
    if extrude.is_some() {
        params.insert(0, json!({
            "name": EXTRUDE, "label": "Extrude to (mm)", "group": "Settings", "type": "number", "widget": "number", "default": 2, "min": 0.1,
            "description": "This is a 2D shape: it's extruded to this height for the preview and the STL (not part of the module's own settings).",
        }));
        base.insert(EXTRUDE.into(), json!(2));
    }
    for (n, label, d, desc) in [
        ("$fa", "Detail angle ($fa)", json!(6), "Smallest angle between segments of a curve, in degrees. Lower is smoother and slower. OpenSCAD's own default is 12."),
        ("$fs", "Detail size ($fs)", json!(0.5), "Smallest segment length of a curve, in mm. Lower is smoother and slower. OpenSCAD's own default is 2."),
        ("$fn", "Segments ($fn)", Value::Null, "Exact number of segments for every circle (empty: worked out from $fa and $fs)."),
    ] {
        params.push(json!({ "name": n, "label": label, "group": "Detail", "type": "number", "widget": "number", "default": d, "min": if n == "$fn" { json!(0) } else { json!(0.01) }, "optional": n == "$fn", "description": desc }));
        base.insert(n.into(), d);
        names.push(n.into());
    }
    let mut groups: Vec<String> = vec![];
    for p in &params {
        let g = p["group"].as_str().unwrap_or("Settings").to_string();
        if !groups.contains(&g) {
            groups.push(g);
        }
    }
    let order = ["Settings", "More settings", "Position", "Detail"];
    groups.sort_by_key(|g| order.iter().position(|o| o == g).unwrap_or(9));
    // presets: every plain-call example, as a complete set of values
    let mut presets = vec![];
    for (n, (title, i, values)) in calls.iter().enumerate() {
        let mut vals = base.clone();
        for p in &params {
            let name = p["name"].as_str().unwrap_or("");
            if let Some(t) = values.get(name) {
                let v = if raw.iter().any(|r| r == name) { json!(t) } else { parse_literal(t).unwrap_or_else(|| json!(t)) };
                vals.insert(name.into(), v);
            }
        }
        let label = match (title.is_empty(), i) {
            (true, _) => format!("Example {}", n + 1),
            (false, 0) => format!("Example: {title}"),
            (false, i) => format!("Example: {title} ({})", i + 1),
        };
        presets.push(json!({ "label": label, "values": vals }));
    }
    let files: Map<String, Value> = c_files(lib, c);
    let license_spdx = lib.info.license.clone().unwrap_or_else(|| "NOASSERTION".into());
    let call = Call {
        prelude: c.prelude.clone(),
        module: c.module.clone(),
        args: names.clone(),
        raw: raw.clone(),
        extrude,
        title: Some(format!("{} {}() made with SCAD Workshop", lib.info.name, c.module)),
    };
    // with no example to start from, arguments without a default must be filled in first
    let needs: Vec<String> = if calls.is_empty() {
        c.args
            .iter()
            .filter(|(n, sig)| sig.is_none() && !n.starts_with('_'))
            .filter(|(n, _)| c.hold || params.iter().any(|p| p["name"] == n.as_str() && p["default"].is_null()))
            .map(|(n, _)| n.clone())
            .collect()
    } else {
        vec![]
    };
    // held: its defaults don't make a shape, so the settings it needs (at least the first) start empty
    let mut needs = needs;
    if c.hold && needs.is_empty() {
        needs.extend(c.args.first().map(|a| a.0.clone()));
    }
    if c.hold {
        for p in params.iter_mut().filter(|p| needs.iter().any(|n| p["name"] == n.as_str())) {
            p["default"] = Value::Null;
            if let Some(opts) = p["options"].as_array_mut() {
                if !opts.iter().any(|o| o["value"].is_null()) {
                    opts.insert(0, json!({ "value": null, "label": "Choose…" }));
                }
            }
        }
    }
    let terms = ingest::setting_terms(&params);
    let mut description_html = String::new();
    if !c.description.is_empty() {
        for para in c.description.split("\n\n") {
            description_html.push_str(&format!("<p>{}</p>", html_escape(para)));
        }
    }
    json!({
        "key": key, "family": family, "id": c.module, "name": c.title,
        "family_name": lib.info.name, "kind": "component",
        "summary": if c.synopsis.is_empty() { format!("{}() from {}", c.module, lib.info.name) } else { c.synopsis.clone() },
        "description_html": if description_html.is_empty() { Value::Null } else { json!(description_html) },
        "category": c.group, "category_label": group_label(&c.group),
        "tags": c.topics,
        "license": crate::meta::license_value(&license_spdx),
        "authors": lib.info.authors.iter().map(|a| json!({ "name": a })).collect::<Vec<_>>(),
        "source": { "repository": lib.info.repo.as_ref().map(|r| format!("https://github.com/{r}")), "commit": lib.info.commit, "commit_date": lib.info.date, "file": c.file },
        "links": { "docs": c.doc_url, "source": lib.info.repo.as_ref().map(|r| format!("https://github.com/{r}")) },
        "component": { "library": lib.info.name, "module": c.module, "file": c.file, "line": c.line, "provider": lib.provider, "source_id": lib.source_id, "dim": c.dim, "doc_url": c.doc_url, "topics": c.topics },
        "call": call,
        "entry": "/component.scad",
        "files": files,
        "browser": false,
        "parameters": params,
        "groups": groups,
        "tabs": { "More settings": { "collapsed": true }, "Position": { "collapsed": true }, "Detail": { "collapsed": true } },
        "presets": presets,
        "needs": needs,
        "terms": terms,
        "settings": names.len(),
        "updated": lib.info.date,
    })
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The files a component's render needs: {"/libraries/<Name>/<path>": sha256}.
fn c_files(lib: &ComponentLibrary, c: &Component) -> Map<String, Value> {
    let set = &lib.index["filesets"][c.fileset];
    set.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let r = r.as_str()?;
            Some((format!("/libraries/{}/{r}", lib.info.name), lib.index["files"][r].clone()))
        })
        .collect()
}

/// The index entry's components.
pub fn components_of(lib: &ComponentLibrary) -> Vec<Component> {
    serde_json::from_value(lib.index["components"].clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals() {
        assert_eq!(parse_literal("5"), Some(json!(5)));
        assert_eq!(parse_literal("-2.5"), Some(json!(-2.5)));
        assert_eq!(parse_literal("1e-3"), Some(json!(0.001)));
        assert_eq!(parse_literal("\"pitch\\\"base\""), Some(json!("pitch\"base")));
        assert_eq!(parse_literal("[1, 2,3]"), Some(json!([1, 2, 3])));
        assert_eq!(parse_literal("[\"a\", true]"), Some(json!(["a", true])));
        assert_eq!(parse_literal("undef"), Some(Value::Null));
        assert_eq!(parse_literal("UP"), None);
        assert_eq!(parse_literal("5/2"), None);
        assert_eq!(parse_literal("3-1"), None);
        assert_eq!(parse_literal("[0:10]"), None);
        assert_eq!(to_scad(&json!([1, 2.5, "a\"b", true])), "[1, 2.5, \"a\\\"b\", true]");
        assert_eq!(to_scad(&json!(3.0)), "3");
    }

    #[test]
    fn expressions_are_checked() {
        assert!(check_expression("[10, 20, 5]").is_ok());
        assert!(check_expression("BOTTOM+LEFT").is_ok());
        assert!(check_expression("\"a;b\"").is_ok());
        assert!(check_expression("1); import(\"/etc/passwd\"); cube(").is_err());
        assert!(check_expression("import(\"x.stl\")").is_err());
        assert!(check_expression("[1, 2").is_err());
        assert!(check_expression("5 // note").is_err());
    }

    #[test]
    fn modules_found() {
        let text = "// A box.\n// With walls.\nmodule box(size=[10,20,30], wall = 2, label) { cube(size); children(); }\n\
                    module _private() {}\nmodule op() { translate([1,0,0]) children(); }\nmodule nut(type, h = \"x)\") { //! Draw a nut\n  circle(3);\n}\n\
                    function f() = 1;\nmodule wrap() { if ($children) children(); cube(1); }\n";
        let m = find_modules(text);
        let names: Vec<&str> = m.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["box", "_private", "op", "nut", "wrap"]);
        assert_eq!(m[0].args, vec![("size".to_string(), Some("[10,20,30]".to_string())), ("wall".into(), Some("2".into())), ("label".into(), None)]);
        assert_eq!(m[0].doc_above.as_deref(), Some("A box.\nWith walls."));
        assert!(m[2].needs_children);
        assert!(!m[4].needs_children);
        assert_eq!(m[3].doc_bang.as_deref(), Some("Draw a nut"));
        assert_eq!(m[3].args[1], ("h".to_string(), Some("\"x)\"".to_string())));
        assert_eq!(m[3].prims, (true, false));
    }

    #[test]
    fn examples_become_values() {
        let names: Vec<String> = ["teeth", "mate_teeth", "shaft_angle", "circ_pitch"].iter().map(|s| s.to_string()).collect();
        let v = example_calls("bevel_gear(\n    circ_pitch=5, teeth=36, mate_teeth=36\n);", "bevel_gear", &names);
        assert_eq!(v[0]["circ_pitch"], "5");
        assert_eq!(v[0]["teeth"], "36");
        let v = example_calls("t1 = 16; t2 = 28; $fn=32;\nbevel_gear(t1, t2, 90, circ_pitch=5);", "bevel_gear", &names);
        assert_eq!(v[0]["teeth"], "16");
        assert_eq!(v[0]["mate_teeth"], "28");
        assert_eq!(v[0]["shaft_angle"], "90");
        assert_eq!(v[0]["$fn"], "32");
        let v = example_calls("bevel_gear(teeth=3);\nright(20) bevel_gear(teeth=4);\nbevel_gear(teeth=5);", "bevel_gear", &names);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1]["teeth"], "5");
        assert!(example_calls("color(\"red\") bevel_gear(teeth=3);", "bevel_gear", &names).is_empty());
        assert!(example_calls("bevel_gear(teeth=3) cube(1);", "bevel_gear", &names).is_empty());
        assert!(example_calls("d = 2*3; bevel_gear(teeth=d);", "bevel_gear", &names).is_empty());
        assert!(example_calls("bevel_gear(size=3);", "bevel_gear", &names).is_empty());
    }

    #[test]
    fn arguments_doc() {
        let body: Vec<String> = [
            "teeth = Number of teeth.  Default: 20",
            "l / h / length = Length.",
            "  More about length.",
            "---",
            "anchor = Translate so anchor point is at origin.  See [anchor](attachments.scad#subsection-anchor).  Default: `CENTER`",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let a = parse_arguments(&body);
        assert_eq!(a["teeth"].default_text.as_deref(), Some("20"));
        assert!(!a["teeth"].named_only);
        assert_eq!(a["h"].doc, "Length. More about length.");
        assert_eq!(a["anchor"].default_text.as_deref(), Some("CENTER"));
        assert!(a["anchor"].doc.contains("See anchor."));
        assert!(a["anchor"].named_only);
    }

    #[test]
    fn source_for_a_call() {
        let call = Call {
            prelude: vec!["include <BOSL2/std.scad>".into(), "include <BOSL2/gears.scad>".into()],
            module: "bevel_gear".into(),
            args: vec!["teeth".into(), "mod".into(), "anchor".into(), "$fa".into()],
            raw: vec!["anchor".into()],
            extrude: None,
            title: None,
        };
        let mut v = BTreeMap::new();
        v.insert("teeth".into(), json!(36));
        v.insert("mod".into(), Value::Null);
        v.insert("anchor".into(), json!("BOTTOM"));
        v.insert("$fa".into(), json!(6));
        assert_eq!(call_source(&call, &v).unwrap(), "include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n\nbevel_gear(teeth=36, anchor=BOTTOM, $fa=6);\n");
        v.insert("anchor".into(), json!("1); import(\"x\"); (2"));
        assert!(call_source(&call, &v).is_err());
    }

    #[test]
    fn names() {
        assert_eq!(tokens("polyRoundExtrude a_triangle donutSlice"), ["poly", "round", "extrude", "a", "triangle", "donut", "slice"]);
        assert_eq!(group_for(&[], "donutSlice", "shapes.scad", 3), "shapes3d");
        assert_eq!(group_for(&[], "MetricNut", "threads.scad", 3), "fasteners");
        assert_eq!(group_for(&[], "ScrewThread", "threads.scad", 3), "threads");
        assert_eq!(group_for(&[], "RodEnd", "threads.scad", 3), "threads");
        assert_eq!(group_for(&["Gears".into(), "Parts".into()], "", "", 3), "gears");
        assert_eq!(group_for(&["Parts".into()], "", "", 3), "hardware");
        assert_eq!(humanize_module("bevel_gear"), "Bevel gear");
        assert_eq!(humanize_module("ScrewThread"), "Screw thread");
        assert_eq!(humanize_module("MetricBolt"), "Metric bolt");
        assert_eq!(humanize_module("M3_cap"), "M3 cap");
        assert_eq!(humanize_module("NEMA_motor"), "NEMA motor");
        assert_eq!(anchor_slug("Function&Module: bevel_gear()"), "functionmodule-bevel_gear");
    }
}

