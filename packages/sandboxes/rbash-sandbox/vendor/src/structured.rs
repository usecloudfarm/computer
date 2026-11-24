//! `yq`, `xan` and `html-to-markdown`.
//!
//! All three turn one shape of text into another. `yq` leans on the `jq` that
//! is already here rather than reimplementing a query language.

use crate::commands::{inputs, parse_args, CmdOut, Ctx};

// --------------------------------------------------------------------- yq

/// YAML in, `jq` in the middle, YAML or JSON out.
///
/// `yq` is a YAML front end to the same filter language, so that is what this
/// is: parse to JSON, hand the existing `jq` the filter, and re-emit. The
/// filter dialect is therefore exactly `jq`'s, which is the point of yq.
pub fn yq(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "o");
    let pos = a.positional();

    let json_out = a.has('j')
        || a.val('o').is_some_and(|v| v.starts_with("j"))
        || a.has_long("output-format=json")
        || args.iter().any(|x| x == "-o=json" || x == "--output-format=json");

    // `yq '.a'` and `yq '.a' file.yaml`, the same shapes as jq.
    let (filter, files): (String, Vec<String>) = match pos.split_first() {
        Some((f, rest)) => (f.clone(), rest.to_vec()),
        None => (".".into(), vec![]),
    };

    let raw: Vec<u8> = inputs("yq", &files, ctx, &mut out).into_iter().flat_map(|(_, d)| d).collect();
    if out.code != 0 { return out; }

    let text = String::from_utf8_lossy(&raw);
    let json = match yaml_to_json(&text) {
        Ok(j) => j,
        Err(e) => {
            out.err("yq", &e);
            out.code = 1;
            return out;
        }
    };

    // Feed the JSON to `jq` through its own stdin, so every flag it supports
    // keeps working.
    let mut jq_args: Vec<String> = vec![];
    for flag in ["-r", "--raw-output", "-S", "--sort-keys", "-e"] {
        if args.iter().any(|x| x == flag) { jq_args.push(flag.into()); }
    }
    // Compact unless the caller wants pretty JSON: one result per line is
    // what lets each be re-emitted as its own YAML document below.
    let pretty_json = json_out && !args.iter().any(|x| x == "-c" || x == "--compact-output");
    if !pretty_json { jq_args.push("-c".into()); }
    jq_args.push(filter);

    let env = ctx.env.clone();
    let mut jq_ctx = crate::commands::Ctx {
        fs: ctx.fs,
        cwd: ctx.cwd,
        env: &env,
        stdin: json.as_bytes(),
        net: ctx.net,
    };
    let result = match crate::commands::run("jq", &jq_args, &mut jq_ctx) {
        Some(r) => r,
        None => {
            out.err("yq", "jq is not available in this build");
            out.code = 1;
            return out;
        }
    };

    out.stderr.extend_from_slice(&result.stderr);
    out.code = result.code;
    if json_out || args.iter().any(|x| x == "-r" || x == "--raw-output") {
        out.stdout.extend_from_slice(&result.stdout);
        return out;
    }
    // Default output is YAML, which is the difference from `jq`.
    let produced = String::from_utf8_lossy(&result.stdout);
    for doc in produced.split('\n').filter(|l| !l.trim().is_empty()) {
        match json_text_to_yaml(doc) {
            Ok(y) => out.stdout.extend_from_slice(y.as_bytes()),
            Err(_) => {
                out.stdout.extend_from_slice(doc.as_bytes());
                out.stdout.push(b'\n');
            }
        }
    }
    out
}

fn yaml_to_json(text: &str) -> Result<String, String> {
    let docs = saphyr::LoadableYamlNode::load_from_str(text).map_err(|e| e.to_string())?;
    let first = docs.into_iter().next().unwrap_or(saphyr::Yaml::Value(saphyr::Scalar::Null));
    let mut s = String::new();
    write_json(&first, &mut s);
    Ok(s)
}

fn write_json(node: &saphyr::Yaml, out: &mut String) {
    use saphyr::{Scalar, Yaml};
    match node {
        Yaml::Value(Scalar::Null) | Yaml::BadValue => out.push_str("null"),
        Yaml::Value(Scalar::Boolean(b)) => out.push_str(if *b { "true" } else { "false" }),
        Yaml::Value(Scalar::Integer(i)) => out.push_str(&i.to_string()),
        Yaml::Value(Scalar::FloatingPoint(f)) => out.push_str(&f.into_inner().to_string()),
        Yaml::Value(Scalar::String(s)) => out.push_str(&json_quote(s)),
        Yaml::Sequence(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 { out.push(','); }
                write_json(item, out);
            }
            out.push(']');
        }
        Yaml::Mapping(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 { out.push(','); }
                // JSON keys are strings, whatever YAML allowed.
                let key = match k {
                    Yaml::Value(Scalar::String(s)) => s.to_string(),
                    other => {
                        let mut tmp = String::new();
                        write_json(other, &mut tmp);
                        tmp.trim_matches('"').to_string()
                    }
                };
                out.push_str(&json_quote(&key));
                out.push(':');
                write_json(v, out);
            }
            out.push('}');
        }
        other => {
            // Aliases, tagged nodes and anything else this does not model.
            let _ = other;
            out.push_str("null");
        }
    }
}

fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JSON text back to YAML, for yq's default output.
fn json_text_to_yaml(text: &str) -> Result<String, String> {
    let docs = saphyr::LoadableYamlNode::load_from_str(text).map_err(|e| e.to_string())?;
    let first = docs.into_iter().next().ok_or("empty")?;
    let mut out = String::new();
    write_yaml(&first, 0, &mut out, false);
    Ok(out)
}

fn write_yaml(node: &saphyr::Yaml, indent: usize, out: &mut String, inline: bool) {
    use saphyr::{Scalar, Yaml};
    let pad = "  ".repeat(indent);
    match node {
        Yaml::Mapping(map) if !map.is_empty() => {
            for (i, (k, v)) in map.iter().enumerate() {
                let key = match k {
                    Yaml::Value(Scalar::String(s)) => s.to_string(),
                    other => scalar_text(other),
                };
                if !(inline && i == 0) { out.push_str(&pad); }
                out.push_str(&key);
                out.push(':');
                match v {
                    Yaml::Mapping(m) if !m.is_empty() => {
                        out.push('\n');
                        write_yaml(v, indent + 1, out, false);
                    }
                    Yaml::Sequence(items) if !items.is_empty() => {
                        out.push('\n');
                        write_yaml(v, indent, out, false);
                    }
                    other => {
                        out.push(' ');
                        out.push_str(&scalar_text(other));
                        out.push('\n');
                    }
                }
            }
        }
        Yaml::Sequence(items) if !items.is_empty() => {
            for item in items {
                out.push_str(&pad);
                out.push_str("- ");
                match item {
                    Yaml::Mapping(m) if !m.is_empty() => {
                        let _ = m;
                        write_yaml(item, indent + 1, out, true);
                    }
                    other => {
                        out.push_str(&scalar_text(other));
                        out.push('\n');
                    }
                }
            }
        }
        other => {
            out.push_str(&pad);
            out.push_str(&scalar_text(other));
            out.push('\n');
        }
    }
}

fn scalar_text(node: &saphyr::Yaml) -> String {
    use saphyr::{Scalar, Yaml};
    match node {
        Yaml::Value(Scalar::Null) => "null".into(),
        Yaml::Value(Scalar::Boolean(b)) => b.to_string(),
        Yaml::Value(Scalar::Integer(i)) => i.to_string(),
        Yaml::Value(Scalar::FloatingPoint(f)) => f.into_inner().to_string(),
        Yaml::Value(Scalar::String(s)) => {
            // Quote only where a bare scalar would be read as something else.
            let needs = s.is_empty()
                || s.parse::<f64>().is_ok()
                || matches!(s.as_ref(), "true" | "false" | "null" | "yes" | "no")
                || s.contains(['#', ':', '\n'])
                || s.starts_with(' ')
                || s.ends_with(' ');
            if needs { format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")) } else { s.to_string() }
        }
        Yaml::Sequence(items) if items.is_empty() => "[]".into(),
        Yaml::Mapping(m) if m.is_empty() => "{}".into(),
        _ => "null".into(),
    }
}

// ------------------------------------------------------- html-to-markdown

/// A small HTML reader and Markdown writer.
///
/// Not a conforming HTML parser — it does not build a DOM, recover from bad
/// nesting, or know about every element. It walks tags and text in order and
/// emits the Markdown each one implies, which covers an article, a README or
/// a scraped page: the shapes a shell actually gets handed.
pub fn html_to_markdown(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let raw: Vec<u8> = inputs("html-to-markdown", &a.positional(), ctx, &mut out)
        .into_iter().flat_map(|(_, d)| d).collect();
    if out.code != 0 { return out; }
    let markdown = convert_html(&String::from_utf8_lossy(&raw));
    out.stdout.extend_from_slice(markdown.as_bytes());
    out
}

struct HtmlWriter {
    out: String,
    list_stack: Vec<Option<usize>>,
    in_pre: bool,
    link: Option<String>,
    pending_text: String,
}

impl HtmlWriter {
    fn flush_text(&mut self) {
        if self.pending_text.is_empty() { return; }
        let text = std::mem::take(&mut self.pending_text);
        self.out.push_str(&text);
    }
    fn block(&mut self) {
        self.flush_text();
        while self.out.ends_with(' ') { self.out.pop(); }
        if !self.out.is_empty() && !self.out.ends_with("\n\n") {
            if !self.out.ends_with('\n') { self.out.push('\n'); }
            self.out.push('\n');
        }
    }
}

fn convert_html(html: &str) -> String {
    let mut w = HtmlWriter {
        out: String::new(),
        list_stack: vec![],
        in_pre: false,
        link: None,
        pending_text: String::new(),
    };
    let bytes: Vec<char> = html.chars().collect();
    let mut i = 0usize;
    // Elements whose content is not markup and is not wanted.
    let mut skipping: Option<String> = None;

    while i < bytes.len() {
        if bytes[i] == '<' {
            let close = match bytes[i..].iter().position(|&c| c == '>') {
                Some(p) => i + p,
                None => break,
            };
            let tag: String = bytes[i + 1..close].iter().collect();
            i = close + 1;
            let lower = tag.trim().to_lowercase();

            if lower.starts_with("!--") || lower.starts_with('!') { continue; }

            let closing = lower.starts_with('/');
            let name: String = lower
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();

            if let Some(skip) = &skipping {
                if closing && &name == skip { skipping = None; }
                continue;
            }

            match (closing, name.as_str()) {
                (false, "script" | "style" | "head" | "noscript") => skipping = Some(name),
                (false, "br") => { w.flush_text(); w.out.push_str("  \n"); }
                (false, "hr") => { w.block(); w.out.push_str("---\n\n"); }
                (false, "p" | "div" | "section" | "article" | "table" | "tr") => w.block(),
                (true, "p" | "div" | "section" | "article" | "table") => w.block(),
                (false, h @ ("h1" | "h2" | "h3" | "h4" | "h5" | "h6")) => {
                    w.block();
                    let level = h[1..].parse::<usize>().unwrap_or(1);
                    w.out.push_str(&"#".repeat(level));
                    w.out.push(' ');
                }
                (true, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => w.block(),
                (false, "strong" | "b") => { w.flush_text(); w.out.push_str("**"); }
                (true, "strong" | "b") => { w.flush_text(); w.out.push_str("**"); }
                (false, "em" | "i") => { w.flush_text(); w.out.push('*'); }
                (true, "em" | "i") => { w.flush_text(); w.out.push('*'); }
                (false, "code") if !w.in_pre => { w.flush_text(); w.out.push('`'); }
                (true, "code") if !w.in_pre => { w.flush_text(); w.out.push('`'); }
                (false, "pre") => { w.block(); w.in_pre = true; w.out.push_str("```\n"); }
                (true, "pre") => {
                    w.flush_text();
                    w.in_pre = false;
                    if !w.out.ends_with('\n') { w.out.push('\n'); }
                    w.out.push_str("```\n\n");
                }
                (false, "blockquote") => { w.block(); w.out.push_str("> "); }
                (true, "blockquote") => w.block(),
                (false, "ul") => { w.block(); w.list_stack.push(None); }
                (false, "ol") => { w.block(); w.list_stack.push(Some(1)); }
                (true, "ul" | "ol") => { w.flush_text(); w.list_stack.pop(); w.block(); }
                (false, "li") => {
                    w.flush_text();
                    if !w.out.ends_with('\n') && !w.out.is_empty() { w.out.push('\n'); }
                    let depth = w.list_stack.len().saturating_sub(1);
                    w.out.push_str(&"  ".repeat(depth));
                    match w.list_stack.last_mut() {
                        Some(Some(n)) => { w.out.push_str(&format!("{}. ", n)); *n += 1; }
                        _ => w.out.push_str("- "),
                    }
                }
                (true, "li") => { w.flush_text(); if !w.out.ends_with('\n') { w.out.push('\n'); } }
                (false, "a") => {
                    w.flush_text();
                    w.link = attr(&tag, "href");
                    if w.link.is_some() { w.out.push('['); }
                }
                (true, "a") => {
                    w.flush_text();
                    if let Some(href) = w.link.take() {
                        w.out.push_str(&format!("]({})", href));
                    }
                }
                (false, "img") => {
                    w.flush_text();
                    let src = attr(&tag, "src").unwrap_or_default();
                    let alt = attr(&tag, "alt").unwrap_or_default();
                    w.out.push_str(&format!("![{}]({})", alt, src));
                }
                (false, "td" | "th") => { w.flush_text(); w.out.push_str("| "); }
                (true, "td" | "th") => { w.flush_text(); w.out.push(' '); }
                (true, "tr") => { w.flush_text(); w.out.push_str("|\n"); }
                _ => {}
            }
            continue;
        }

        // Text.
        let next = bytes[i..].iter().position(|&c| c == '<').map(|p| i + p).unwrap_or(bytes.len());
        let chunk: String = bytes[i..next].iter().collect();
        i = next;
        if skipping.is_some() { continue; }
        let decoded = decode_entities(&chunk);
        if w.in_pre {
            w.out.push_str(&decoded);
            continue;
        }
        // Outside <pre>, runs of whitespace collapse, as a browser would.
        let mut collapsed = String::new();
        let mut last_space = w.out.ends_with(' ') || w.out.ends_with('\n') || w.out.is_empty();
        for c in decoded.chars() {
            if c.is_whitespace() {
                if !last_space { collapsed.push(' '); }
                last_space = true;
            } else {
                collapsed.push(c);
                last_space = false;
            }
        }
        w.pending_text.push_str(&collapsed);
        w.flush_text();
    }

    w.flush_text();
    // Collapse runs of blank lines, and end with exactly one newline.
    let mut result = String::new();
    let mut blanks = 0;
    for line in w.out.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blanks += 1;
            if blanks > 1 { continue; }
        } else {
            blanks = 0;
        }
        result.push_str(trimmed);
        result.push('\n');
    }
    while result.ends_with("\n\n") { result.pop(); }
    result
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let at = lower.find(&format!("{}=", name))?;
    let rest = &tag[at + name.len() + 1..];
    let mut chars = rest.chars();
    match chars.next()? {
        q @ ('"' | '\'') => Some(chars.take_while(|c| *c != q).collect()),
        first => {
            let mut v = String::from(first);
            v.extend(chars.take_while(|c| !c.is_whitespace() && *c != '>'));
            Some(v)
        }
    }
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') { return s.to_string(); }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = match rest.find(';') {
            Some(e) if e <= 10 => e,
            _ => { out.push('&'); rest = &rest[1..]; continue; }
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'),
            "quot" => Some('"'), "apos" | "#39" => Some('\''), "nbsp" => Some(' '),
            "mdash" => Some('—'), "ndash" => Some('–'), "hellip" => Some('…'),
            e if e.starts_with("#x") || e.starts_with("#X") => {
                u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
            }
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => { out.push(c); rest = &rest[end + 1..]; }
            None => { out.push('&'); rest = &rest[1..]; }
        }
    }
    out.push_str(rest);
    out
}

// -------------------------------------------------------------------- xan

/// A CSV toolkit: `xan <subcommand> [flags] [file]`.
///
/// The subcommands a shell actually reaches for — `headers`, `count`,
/// `select`, `search`, `slice`, `sort`, `frequency`, `behead`, `flatten` —
/// over a real CSV reader, so quoted fields with commas and newlines in them
/// survive. Not the whole of upstream `xan`, which has dozens.
pub fn xan(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let Some((sub, rest)) = args.split_first() else {
        out.err("xan", "missing subcommand");
        out.code = 2;
        return out;
    };
    let a = parse_args(rest, "sln");
    let all = a.positional();
    // `xan select a,b data.csv`: the file is last when a subcommand took an
    // argument of its own.
    let files: Vec<String> = if matches!(sub.as_str(), "select" | "search") && all.len() >= 2 {
        all[1..].to_vec()
    } else {
        all.clone()
    };
    let no_headers = a.has_long("no-headers") || a.has('n');

    let raw: Vec<u8> = inputs("xan", &files, ctx, &mut out).into_iter().flat_map(|(_, d)| d).collect();
    if out.code != 0 { return out; }
    let rows = parse_csv(&String::from_utf8_lossy(&raw));
    if rows.is_empty() {
        if sub == "count" { out.stdout.extend_from_slice(b"0\n"); }
        return out;
    }
    let (header, body): (Vec<String>, &[Vec<String>]) = if no_headers {
        ((0..rows[0].len()).map(|i| i.to_string()).collect(), &rows[..])
    } else {
        (rows[0].clone(), &rows[1..])
    };

    // Column references are names or zero-based indices, as upstream allows.
    let resolve = |spec: &str| -> Option<usize> {
        header.iter().position(|h| h == spec).or_else(|| spec.parse::<usize>().ok())
    };

    match sub.as_str() {
        "headers" => {
            for (i, h) in header.iter().enumerate() {
                out.stdout.extend_from_slice(format!("{}\t{}\n", i, h).as_bytes());
            }
        }
        "count" => {
            out.stdout.extend_from_slice(format!("{}\n", body.len()).as_bytes());
        }
        "behead" => {
            for row in body { write_csv_row(row, &mut out.stdout); }
        }
        "flatten" => {
            for (n, row) in body.iter().enumerate() {
                if n > 0 { out.stdout.push(b'\n'); }
                for (i, cell) in row.iter().enumerate() {
                    let name = header.get(i).cloned().unwrap_or_else(|| i.to_string());
                    out.stdout.extend_from_slice(format!("{:<12} {}\n", name, cell).as_bytes());
                }
            }
        }
        "select" => {
            let spec = match a.positional_before_file(rest) {
                Some(s) => s,
                None => { out.err("xan", "select needs columns"); out.code = 2; return out; }
            };
            let wanted: Vec<usize> = spec.split(',').filter_map(|s| resolve(s.trim())).collect();
            if wanted.is_empty() {
                out.err("xan", &format!("no such column: {}", spec));
                out.code = 2;
                return out;
            }
            if !no_headers {
                let picked: Vec<String> = wanted.iter().map(|&i| header[i].clone()).collect();
                write_csv_row(&picked, &mut out.stdout);
            }
            for row in body {
                let picked: Vec<String> =
                    wanted.iter().map(|&i| row.get(i).cloned().unwrap_or_default()).collect();
                write_csv_row(&picked, &mut out.stdout);
            }
        }
        "search" => {
            let pattern = match a.positional_before_file(rest) {
                Some(s) => s,
                None => { out.err("xan", "search needs a pattern"); out.code = 2; return out; }
            };
            let re = match regex::Regex::new(&pattern) {
                Ok(r) => r,
                Err(e) => { out.err("xan", &format!("bad pattern: {}", e)); out.code = 2; return out; }
            };
            let only = a.val('s').and_then(|s| resolve(s));
            if !no_headers { write_csv_row(&header, &mut out.stdout); }
            for row in body {
                let hit = match only {
                    Some(i) => row.get(i).is_some_and(|c| re.is_match(c)),
                    None => row.iter().any(|c| re.is_match(c)),
                };
                if hit { write_csv_row(row, &mut out.stdout); }
            }
        }
        "slice" => {
            let start: usize = a.val('s').and_then(|v| v.parse().ok()).unwrap_or(0);
            let len: usize = a.val('l').and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
            if !no_headers { write_csv_row(&header, &mut out.stdout); }
            for row in body.iter().skip(start).take(len) { write_csv_row(row, &mut out.stdout); }
        }
        "sort" => {
            let key = a.val('s').and_then(|s| resolve(s));
            let numeric = a.has_long("numeric") || a.has('N');
            let reverse = a.has('R') || a.has_long("reverse");
            let mut sorted = body.to_vec();
            sorted.sort_by(|x, y| {
                let pick = |r: &Vec<String>| match key {
                    Some(i) => r.get(i).cloned().unwrap_or_default(),
                    None => r.first().cloned().unwrap_or_default(),
                };
                let (l, r) = (pick(x), pick(y));
                if numeric {
                    let ln: f64 = l.trim().parse().unwrap_or(f64::MIN);
                    let rn: f64 = r.trim().parse().unwrap_or(f64::MIN);
                    ln.partial_cmp(&rn).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    l.cmp(&r)
                }
            });
            if reverse { sorted.reverse(); }
            if !no_headers { write_csv_row(&header, &mut out.stdout); }
            for row in &sorted { write_csv_row(row, &mut out.stdout); }
        }
        "frequency" | "freq" => {
            let key = a.val('s').and_then(|s| resolve(s)).unwrap_or(0);
            let mut counts: std::collections::HashMap<String, usize> = Default::default();
            for row in body {
                *counts.entry(row.get(key).cloned().unwrap_or_default()).or_insert(0) += 1;
            }
            let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
            // Commonest first, ties broken by name so the output is stable.
            pairs.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
            write_csv_row(&["field".into(), "value".into(), "count".into()], &mut out.stdout);
            let name = header.get(key).cloned().unwrap_or_else(|| key.to_string());
            for (value, count) in pairs {
                write_csv_row(&[name.clone(), value, count.to_string()], &mut out.stdout);
            }
        }
        other => {
            out.err("xan", &format!("unknown subcommand: {}", other));
            out.code = 2;
        }
    }
    out
}

/// RFC 4180: quoted fields, doubled quotes inside them, newlines allowed.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => { chars.next(); field.push('"'); }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn write_csv_row(row: &[String], out: &mut Vec<u8>) {
    for (i, cell) in row.iter().enumerate() {
        if i > 0 { out.push(b','); }
        if cell.contains([',', '"', '\n']) {
            out.push(b'"');
            out.extend_from_slice(cell.replace('"', "\"\"").as_bytes());
            out.push(b'"');
        } else {
            out.extend_from_slice(cell.as_bytes());
        }
    }
    out.push(b'\n');
}
