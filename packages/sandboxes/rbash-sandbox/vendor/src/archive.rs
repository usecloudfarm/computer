//! `gzip`, `tar` and `rg`.
//!
//! The first two are formats rather than algorithms here: DEFLATE comes from
//! `miniz_oxide`, and tar is 512-byte headers written out by hand. `rg` is a
//! recursive search built on the same regex engine `grep` uses.

use crate::commands::{parse_args, CmdOut, Ctx};
use crate::fs;

// ------------------------------------------------------------------- gzip

const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

fn crc32(data: &[u8]) -> u32 {
    // Table built on the fly: 1 KiB of work once, against pulling in a crate.
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

pub fn gzip_bytes(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 2 + 32);
    out.extend_from_slice(&GZIP_MAGIC);
    out.push(8); // deflate
    out.push(0); // no flags, so no name or comment follows
    out.extend_from_slice(&[0, 0, 0, 0]); // mtime: zero, so output is reproducible
    out.push(0);
    out.push(255); // unknown OS, which is what a sandbox is
    out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec(data, 6));
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

pub fn gunzip_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 18 || data[0..2] != GZIP_MAGIC {
        return Err("not in gzip format".into());
    }
    let flags = data[3];
    let mut at = 10usize;
    if flags & 0b0000_0100 != 0 {
        // FEXTRA
        if at + 2 > data.len() { return Err("unexpected end of file".into()); }
        let len = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
        at += 2 + len;
    }
    for flag in [0b0000_1000u8, 0b0001_0000] {
        // FNAME, FCOMMENT: NUL-terminated
        if flags & flag != 0 {
            while at < data.len() && data[at] != 0 { at += 1; }
            at += 1;
        }
    }
    if flags & 0b0000_0010 != 0 { at += 2; } // FHCRC
    if at >= data.len() || data.len() < at + 8 { return Err("unexpected end of file".into()); }

    let body = &data[at..data.len() - 8];
    let expected_crc = u32::from_le_bytes(data[data.len() - 8..data.len() - 4].try_into().unwrap());
    let inflated = miniz_oxide::inflate::decompress_to_vec(body)
        .map_err(|e| format!("invalid compressed data: {:?}", e))?;
    if crc32(&inflated) != expected_crc {
        return Err("crc error".into());
    }
    Ok(inflated)
}

/// `gzip [-d] [-c] [-k] [file...]`, plus `gunzip` and `zcat` as aliases.
pub fn gzip(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let decompress = a.has('d') || a.has_long("decompress") || a.has_long("uncompress");
    let to_stdout = a.has('c') || a.has_long("stdout");
    let keep = a.has('k') || a.has_long("keep");
    let files = a.positional();

    if files.is_empty() {
        let data = ctx.stdin.to_vec();
        match if decompress { gunzip_bytes(&data) } else { Ok(gzip_bytes(&data)) } {
            Ok(bytes) => out.stdout.extend_from_slice(&bytes),
            Err(e) => { out.err("gzip", &e); out.code = 1; }
        }
        return out;
    }

    for name in &files {
        let path = fs::normalize(ctx.cwd, name);
        let data = match ctx.fs.read(&path) {
            Ok(d) => d.to_vec(),
            Err(_) => {
                out.err("gzip", &format!("{}: No such file or directory", name));
                out.code = 1;
                continue;
            }
        };
        let result = if decompress { gunzip_bytes(&data) } else { Ok(gzip_bytes(&data)) };
        let bytes = match result {
            Ok(b) => b,
            Err(e) => { out.err("gzip", &format!("{}: {}", name, e)); out.code = 1; continue; }
        };

        if to_stdout {
            out.stdout.extend_from_slice(&bytes);
            continue;
        }
        // In place: `x` becomes `x.gz`, `x.gz` becomes `x`, and the input
        // goes unless `-k`.
        let target = if decompress {
            name.strip_suffix(".gz").unwrap_or(name).to_string()
        } else {
            format!("{}.gz", name)
        };
        let target_path = fs::normalize(ctx.cwd, &target);
        if let Err(e) = ctx.fs.write(&target_path, &bytes, false) {
            out.err("gzip", &format!("{}: {}", target, e));
            out.code = 1;
            continue;
        }
        if !keep { let _ = ctx.fs.remove(&path, false); }
    }
    out
}

pub fn zcat(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut forced: Vec<String> = vec!["-d".into(), "-c".into()];
    forced.extend_from_slice(args);
    gzip(&forced, ctx)
}

pub fn gunzip(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut forced: Vec<String> = vec!["-d".into()];
    forced.extend_from_slice(args);
    gzip(&forced, ctx)
}

// -------------------------------------------------------------------- tar

/// One ustar header. Every field is a fixed-width, NUL-padded octal string,
/// which is why this is a format and not a library.
fn tar_header(name: &str, size: usize, is_dir: bool) -> [u8; 512] {
    let mut h = [0u8; 512];
    let put = |h: &mut [u8; 512], at: usize, width: usize, text: &str| {
        let bytes = text.as_bytes();
        let n = bytes.len().min(width);
        h[at..at + n].copy_from_slice(&bytes[..n]);
    };
    let octal = |value: usize, width: usize| format!("{:0>width$o}", value, width = width - 1);

    put(&mut h, 0, 100, name);
    put(&mut h, 100, 8, &octal(if is_dir { 0o755 } else { 0o644 }, 8));
    put(&mut h, 108, 8, &octal(0, 8));
    put(&mut h, 116, 8, &octal(0, 8));
    put(&mut h, 124, 12, &octal(if is_dir { 0 } else { size }, 12));
    put(&mut h, 136, 12, &octal(0, 12)); // mtime zero, so archives are reproducible
    h[156] = if is_dir { b'5' } else { b'0' };
    put(&mut h, 257, 6, "ustar");
    h[263] = b'0';
    h[264] = b'0';
    put(&mut h, 265, 32, "user");
    put(&mut h, 297, 32, "user");

    // The checksum is computed with its own field read as spaces.
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    put(&mut h, 148, 8, &format!("{:06o}\0 ", sum));
    h
}

fn tar_field(block: &[u8], at: usize, width: usize) -> String {
    let raw = &block[at..at + width];
    let end = raw.iter().position(|&b| b == 0 || b == b' ').unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).to_string()
}

/// `tar -c|-x|-t [-z] [-f archive] [-C dir] [paths...]`
pub fn tar(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "fC");
    let (create, extract, list) = (a.has('c'), a.has('x'), a.has('t'));
    let compressed = a.has('z');
    let verbose = a.has('v');
    let archive = a.val('f').map(|s| s.to_string());
    let chdir = a.val('C').map(|s| s.to_string());
    let paths = a.positional();

    if !(create || extract || list) {
        out.err("tar", "You must specify one of the -c, -x or -t options");
        out.code = 2;
        return out;
    }

    let base = match &chdir {
        Some(d) => fs::normalize(ctx.cwd, d),
        None => ctx.cwd.to_string(),
    };

    if create {
        let mut blocks: Vec<u8> = vec![];
        // Names in the archive are relative to `-C`, so a tarball made here
        // extracts to the same shape somewhere else.
        let mut entries: Vec<(String, String)> = vec![];
        for entry in &paths {
            let full = fs::normalize(&base, entry);
            if ctx.fs.is_dir(&full) {
                entries.push((format!("{}/", entry.trim_end_matches('/')), full.clone()));
                for child in ctx.fs.walk(&full) {
                    let relative = child.strip_prefix(&format!("{}/", full)).unwrap_or(&child);
                    let name = format!("{}/{}", entry.trim_end_matches('/'), relative);
                    let name = if ctx.fs.is_dir(&child) { format!("{}/", name) } else { name };
                    entries.push((name, child));
                }
            } else {
                entries.push((entry.clone(), full));
            }
        }

        for (name, full) in entries {
            if name.ends_with('/') {
                if verbose { out.stdout.extend_from_slice(format!("{}\n", name).as_bytes()); }
                blocks.extend_from_slice(&tar_header(&name, 0, true));
                continue;
            }
            match ctx.fs.read(&full) {
                Ok(data) => {
                    let data = data.to_vec();
                    if verbose { out.stdout.extend_from_slice(format!("{}\n", name).as_bytes()); }
                    blocks.extend_from_slice(&tar_header(&name, data.len(), false));
                    blocks.extend_from_slice(&data);
                    // Everything is padded to a 512-byte boundary.
                    let pad = (512 - data.len() % 512) % 512;
                    blocks.extend(std::iter::repeat_n(0u8, pad));
                }
                Err(_) => {
                    out.err("tar", &format!("{}: Cannot stat: No such file or directory", name));
                    out.code = 2;
                }
            }
        }
        // Two empty blocks mark the end.
        blocks.extend(std::iter::repeat_n(0u8, 1024));
        let payload = if compressed { gzip_bytes(&blocks) } else { blocks };
        match &archive {
            Some(f) => {
                let p = fs::normalize(ctx.cwd, f);
                if let Err(e) = ctx.fs.write(&p, &payload, false) {
                    out.err("tar", &format!("{}: {}", f, e));
                    out.code = 2;
                }
            }
            None => out.stdout.extend_from_slice(&payload),
        }
        return out;
    }

    // Extract and list both read the archive first.
    let raw = match &archive {
        Some(f) => {
            let p = fs::normalize(ctx.cwd, f);
            match ctx.fs.read(&p) {
                Ok(d) => d.to_vec(),
                Err(_) => {
                    out.err("tar", &format!("{}: Cannot open: No such file or directory", f));
                    out.code = 2;
                    return out;
                }
            }
        }
        None => ctx.stdin.to_vec(),
    };
    // `-z` is accepted, and gzip is also detected, which is what GNU does.
    let data = if compressed || raw.starts_with(&GZIP_MAGIC) {
        match gunzip_bytes(&raw) {
            Ok(d) => d,
            Err(e) => { out.err("tar", &e); out.code = 2; return out; }
        }
    } else {
        raw
    };

    let mut at = 0usize;
    while at + 512 <= data.len() {
        let header = &data[at..at + 512];
        if header.iter().all(|&b| b == 0) { break; }
        let name = tar_field(header, 0, 100);
        let size = usize::from_str_radix(&tar_field(header, 124, 12), 8).unwrap_or(0);
        let kind = header[156];
        at += 512;

        if kind == b'5' || name.ends_with('/') {
            if extract {
                let p = fs::normalize(&base, name.trim_end_matches('/'));
                let _ = ctx.fs.mkdir(&p, true);
            }
            if list || verbose { out.stdout.extend_from_slice(format!("{}\n", name).as_bytes()); }
            continue;
        }

        let end = (at + size).min(data.len());
        let body = data[at..end].to_vec();
        at += size.div_ceil(512) * 512;

        if list || verbose { out.stdout.extend_from_slice(format!("{}\n", name).as_bytes()); }
        if extract {
            let p = fs::normalize(&base, &name);
            if let Some(parent) = p.rsplit_once('/').map(|(d, _)| d) {
                if !parent.is_empty() { let _ = ctx.fs.mkdir(parent, true); }
            }
            if let Err(e) = ctx.fs.write(&p, &body, false) {
                out.err("tar", &format!("{}: {}", name, e));
                out.code = 2;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------- rg

/// `rg [flags] PATTERN [path...]` — recursive search, ripgrep's default
/// output: results grouped under a filename heading, with line numbers.
///
/// Built on the same regex engine `grep` uses, so the pattern dialect is the
/// same. What makes it `rg` rather than `grep -r` is the defaults: recursive
/// from the working directory, smart case, and the grouped output.
pub fn rg(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "gm");
    let pos = a.positional();
    if pos.is_empty() {
        out.err("rg", "missing PATTERN");
        out.code = 2;
        return out;
    }
    let pattern = &pos[0];
    let roots: Vec<String> = if pos.len() > 1 { pos[1..].to_vec() } else { vec![".".into()] };

    let fixed = a.has('F') || a.has_long("fixed-strings");
    let invert = a.has('v') || a.has_long("invert-match");
    let count_only = a.has('c') || a.has_long("count");
    let files_only = a.has('l') || a.has_long("files-with-matches");
    let no_heading = a.has_long("no-heading");
    let whole_word = a.has('w') || a.has_long("word-regexp");
    // Smart case: insensitive unless the pattern has an uppercase letter.
    let insensitive = a.has('i')
        || a.has_long("ignore-case")
        || (!a.has('s') && !a.has_long("case-sensitive") && !pattern.chars().any(|c| c.is_uppercase()));

    let escaped;
    let mut source = if fixed { escaped = regex::escape(pattern); &escaped } else { pattern };
    let worded;
    if whole_word {
        worded = format!(r"\b(?:{}){}", source, r"\b");
        source = &worded;
    }
    let re = match regex::RegexBuilder::new(source).case_insensitive(insensitive).build() {
        Ok(r) => r,
        Err(e) => {
            out.err("rg", &format!("invalid pattern: {}", e));
            out.code = 2;
            return out;
        }
    };

    let mut candidates: Vec<String> = vec![];
    for root in &roots {
        let full = fs::normalize(ctx.cwd, root);
        if ctx.fs.is_dir(&full) {
            candidates.extend(ctx.fs.walk(&full).into_iter().filter(|p| ctx.fs.is_file(p)));
        } else if ctx.fs.is_file(&full) {
            candidates.push(full);
        } else {
            out.err("rg", &format!("{}: No such file or directory", root));
            out.code = 2;
        }
    }
    candidates.sort();

    let mut found = false;
    let mut first = true;
    for path in candidates {
        let data = match ctx.fs.read(&path) { Ok(d) => d.to_vec(), Err(_) => continue };
        let text = String::from_utf8_lossy(&data);
        // A NUL byte means binary; ripgrep skips those rather than spraying
        // the terminal, and so does this.
        if text.contains('\u{0}') { continue; }

        let display = path.strip_prefix(&format!("{}/", ctx.cwd)).unwrap_or(&path).to_string();
        let hits: Vec<(usize, &str)> = text
            .lines()
            .enumerate()
            .filter(|(_, line)| re.is_match(line) != invert)
            .map(|(i, line)| (i + 1, line))
            .collect();
        if hits.is_empty() { continue; }
        found = true;

        if files_only {
            out.stdout.extend_from_slice(format!("{}\n", display).as_bytes());
            continue;
        }
        if count_only {
            out.stdout.extend_from_slice(format!("{}:{}\n", display, hits.len()).as_bytes());
            continue;
        }
        if no_heading {
            for (n, line) in hits {
                out.stdout.extend_from_slice(format!("{}:{}:{}\n", display, n, line).as_bytes());
            }
            continue;
        }
        // Grouped: a blank line between files, the name once, then the hits.
        if !first { out.stdout.push(b'\n'); }
        first = false;
        out.stdout.extend_from_slice(format!("{}\n", display).as_bytes());
        for (n, line) in hits {
            out.stdout.extend_from_slice(format!("{}:{}\n", n, line).as_bytes());
        }
    }

    // ripgrep exits 1 when nothing matched, which scripts branch on.
    if !found && out.code == 0 { out.code = 1; }
    out
}

// -------------------------------------------------------------------- time

/// `time COMMAND` — runs it and reports, as `time` does, on stderr.
///
/// There is no clock: `wasm32-unknown-unknown` has none, and the shell's
/// `date` is a fixed string for the same reason. Rather than invent a
/// duration, this reports the work actually done — the commands run — and
/// says where the seconds went. A script that wraps something in `time` still
/// runs it, which is the part that matters.
pub fn time_cmd(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let pos = parse_args(args, "").positional();
    if pos.is_empty() {
        return CmdOut::default();
    }
    let mut out = match crate::commands::run(&pos[0], &pos[1..], ctx) {
        Some(o) => o,
        None => {
            let mut o = CmdOut::default();
            o.err("time", &format!("{}: command not found", pos[0]));
            o.code = 127;
            o
        }
    };
    out.stderr.extend_from_slice(
        b"\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n(no clock in this sandbox)\n",
    );
    out
}
