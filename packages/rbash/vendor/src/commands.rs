//! Commands. Each is a plain function over (args, stdin, fs) -> (stdout, stderr, code).
//! None of them can reach the host: there is no std::fs, no std::process, no sockets.

use std::collections::HashMap;
use std::fmt::Write as _;

use regex::{Regex, RegexBuilder};

use crate::fs::{self, MemFs};

pub struct Ctx<'a> {
    pub fs: &'a mut MemFs,
    pub cwd: &'a str,
    pub env: &'a HashMap<String, String>,
    pub stdin: &'a [u8],
    /// Where `curl` finds its responses, and leaves its requests.
    pub net: &'a mut crate::net::Net,
}

#[derive(Default)]
pub struct CmdOut {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

impl CmdOut {
    pub fn out(&mut self, s: &str) {
        self.stdout.extend_from_slice(s.as_bytes());
    }
    pub fn err(&mut self, cmd: &str, s: &str) {
        self.stderr.extend_from_slice(format!("{}: {}\n", cmd, s).as_bytes());
    }
}

type CmdFn = fn(&[String], &mut Ctx) -> CmdOut;

const COMMANDS: &[(&str, CmdFn)] = &[
    ("echo", echo),
    ("printf", printf),
    ("cat", cat),
    ("ls", ls),
    ("mkdir", mkdir),
    ("rm", rm),
    ("rmdir", rmdir),
    ("touch", touch),
    ("cp", cp),
    ("mv", mv),
    ("head", head),
    ("tail", tail),
    ("wc", wc),
    ("grep", grep),
    ("egrep", grep),
    ("fgrep", grep),
    ("sort", sort),
    ("uniq", uniq),
    ("cut", cut),
    ("tr", tr),
    ("sed", sed),
    #[cfg(feature = "jq")]
    ("jq", jq),
    ("find", find),
    ("seq", seq),
    ("basename", basename),
    ("dirname", dirname),
    ("tee", tee),
    ("env", env),
    ("printenv", env),
    ("rev", rev),
    ("tac", tac),
    ("nl", nl),
    ("sleep", sleep),
    ("date", date),
    ("whoami", whoami),
    ("hostname", hostname),
    ("tree", tree),
    ("du", du),
    ("stat", stat),
    ("paste", paste),
    ("awk", crate::awk::awk),
    // The rest of the coreutils, to match what `just-bash` offers.
    ("base64", crate::coreutils::base64_cmd),
    ("md5sum", crate::coreutils::md5sum),
    ("sha256sum", crate::coreutils::sha256sum),
    ("fold", crate::coreutils::fold),
    ("expand", crate::coreutils::expand),
    ("column", crate::coreutils::column),
    ("strings", crate::coreutils::strings),
    ("od", crate::coreutils::od),
    ("comm", crate::coreutils::comm),
    ("join", crate::coreutils::join),
    ("expr", crate::coreutils::expr),
    ("diff", crate::coreutils::diff),
    ("split", crate::coreutils::split),
    ("chmod", crate::coreutils::chmod),
    ("ln", crate::coreutils::ln),
    ("readlink", crate::coreutils::readlink),
    ("mktemp", crate::coreutils::mktemp),
    ("yes", crate::coreutils::yes),
    ("clear", crate::coreutils::clear),
    ("true", crate::coreutils::true_cmd),
    ("false", crate::coreutils::false_cmd),
    ("timeout", crate::coreutils::timeout),
    ("file", crate::coreutils::file),
    ("gzip", crate::archive::gzip),
    ("gunzip", crate::archive::gunzip),
    ("zcat", crate::archive::zcat),
    ("tar", crate::archive::tar),
    ("rg", crate::archive::rg),
    ("time", crate::archive::time_cmd),
    ("yq", crate::structured::yq),
    ("html-to-markdown", crate::structured::html_to_markdown),
    ("xan", crate::structured::xan),
    ("sqlite3", crate::sql::sqlite3),
];

pub fn exists(name: &str) -> bool {
    COMMANDS.iter().any(|(n, _)| *n == name)
}

/// Commands that consume stdin (so `while read` loops see the right remainder).
pub fn reads_stdin(name: &str) -> bool {
    matches!(name, "cat" | "head" | "tail" | "wc" | "grep" | "egrep" | "fgrep" | "sort" | "uniq" | "cut" | "tr"
        | "sed" | "jq" | "tee" | "rev" | "tac" | "nl" | "paste" | "awk"
        | "base64" | "md5sum" | "sha256sum" | "fold" | "expand" | "column" | "strings" | "od"
        | "gzip" | "gunzip" | "zcat" | "tar" | "yq" | "xan" | "html-to-markdown" | "rg" | "sqlite3")
}

/// Used by the wasm `Bash.commands()`; unreferenced in a native build.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn names() -> Vec<&'static str> {
    COMMANDS.iter().map(|(n, _)| *n).collect()
}

pub fn run(name: &str, args: &[String], ctx: &mut Ctx) -> Option<CmdOut> {
    let name = name.rsplit('/').next().unwrap_or(name);
    COMMANDS.iter().find(|(n, _)| *n == name).map(|(n, f)| {
        let mut a = args.to_vec();
        if *n == "egrep" { a.insert(0, "-E".into()); }
        if *n == "fgrep" { a.insert(0, "-F".into()); }
        f(&a, ctx)
    })
}

// ----------------------------------------------------------------- helpers

/// Split `-abc` style short flags; stops at `--` or first non-flag.
/// `with_value` lists flags that take an argument (e.g. "n" for `head -n 5`).
pub struct Args {
    flags: Vec<(char, Option<String>)>,
    long: Vec<String>,
    pos: Vec<String>,
}

pub fn parse_args(args: &[String], with_value: &str) -> Args {
    let mut a = Args { flags: vec![], long: vec![], pos: vec![] };
    let mut i = 0;
    let mut only_pos = false;
    while i < args.len() {
        let s = &args[i];
        if only_pos || s == "-" || !s.starts_with('-') || s.len() == 1 {
            a.pos.push(s.clone());
        } else if s == "--" {
            only_pos = true;
        } else if let Some(l) = s.strip_prefix("--") {
            a.long.push(l.to_string());
        } else {
            let chars: Vec<char> = s[1..].chars().collect();
            let mut j = 0;
            while j < chars.len() {
                let c = chars[j];
                if with_value.contains(c) {
                    let rest: String = chars[j + 1..].iter().collect();
                    let v = if !rest.is_empty() {
                        rest
                    } else {
                        i += 1;
                        args.get(i).cloned().unwrap_or_default()
                    };
                    a.flags.push((c, Some(v)));
                    break;
                }
                a.flags.push((c, None));
                j += 1;
            }
        }
        i += 1;
    }
    a
}

impl Args {
    pub fn has(&self, c: char) -> bool {
        self.flags.iter().any(|(f, _)| *f == c)
    }
    pub fn val(&self, c: char) -> Option<&str> {
        self.flags.iter().rev().find(|(f, _)| *f == c).and_then(|(_, v)| v.as_deref())
    }
    pub fn vals(&self, c: char) -> Vec<String> {
        self.flags.iter().filter(|(f, _)| *f == c).filter_map(|(_, v)| v.clone()).collect()
    }
    pub fn positional(&self) -> Vec<String> {
        self.pos.clone()
    }
    /// The first positional, when a subcommand takes one before its file —
    /// `xan select a,b data.csv`. Returns None when there is only a file.
    pub fn positional_before_file(&self, _args: &[String]) -> Option<String> {
        if self.pos.len() >= 2 { self.pos.first().cloned() } else { None }
    }
    pub fn has_long(&self, l: &str) -> bool {
        self.long.iter().any(|x| x == l || x.starts_with(&format!("{}=", l)))
    }
}

/// Read each named file (or stdin for none / "-"). Errors go to stderr.
pub fn inputs(cmd: &str, files: &[String], ctx: &Ctx, out: &mut CmdOut) -> Vec<(String, Vec<u8>)> {
    if files.is_empty() {
        return vec![("-".into(), ctx.stdin.to_vec())];
    }
    let mut v = vec![];
    for f in files {
        if f == "-" {
            v.push(("-".into(), ctx.stdin.to_vec()));
            continue;
        }
        let p = fs::normalize(ctx.cwd, f);
        match ctx.fs.read(&p) {
            Ok(d) => v.push((f.clone(), d.to_vec())),
            Err(_) if ctx.fs.is_dir(&p) => {
                out.err(cmd, &format!("{}: Is a directory", f));
                out.code = 1;
            }
            Err(_) => {
                out.err(cmd, &format!("{}: No such file or directory", f));
                out.code = 1;
            }
        }
    }
    v
}

pub fn lines_of(data: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(data);
    let mut v: Vec<String> = s.split('\n').map(|l| l.to_string()).collect();
    if v.last().map_or(false, |l| l.is_empty()) {
        v.pop();
    }
    v
}

pub fn join_lines(lines: &[String]) -> String {
    let mut s = String::new();
    for l in lines {
        s.push_str(l);
        s.push('\n');
    }
    s
}

/// Convert POSIX basic regex to the ERE-ish syntax the `regex` crate speaks.
fn bre_to_ere(p: &str) -> String {
    let mut o = String::new();
    let mut it = p.chars().peekable();
    let mut in_bracket = false;
    while let Some(c) = it.next() {
        if in_bracket {
            o.push(c);
            if c == ']' { in_bracket = false; }
            continue;
        }
        match c {
            '[' => {
                in_bracket = true;
                o.push('[');
                if it.peek() == Some(&'^') { o.push(it.next().unwrap()); }
                if it.peek() == Some(&']') { o.push(it.next().unwrap()); }
            }
            '\\' => match it.next() {
                Some(n @ ('(' | ')' | '{' | '}' | '|' | '+' | '?')) => o.push(n),
                Some(n) => { o.push('\\'); o.push(n); }
                None => o.push_str("\\\\"),
            },
            '(' | ')' | '{' | '}' | '|' | '+' | '?' => { o.push('\\'); o.push(c); }
            _ => o.push(c),
        }
    }
    o
}

fn build_regex(pat: &str, extended: bool, fixed: bool, icase: bool, word: bool, line: bool) -> Result<Regex, String> {
    let mut p = if fixed { regex::escape(pat) } else if extended { pat.to_string() } else { bre_to_ere(pat) };
    if word { p = format!(r"\b(?:{})\b", p); }
    if line { p = format!("^(?:{})$", p); }
    RegexBuilder::new(&p).case_insensitive(icase).build().map_err(|e| e.to_string().lines().last().unwrap_or("bad regex").to_string())
}

// ---------------------------------------------------------------- commands

fn echo(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let mut newline = true;
    let mut escapes = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a.len() > 1 && a.starts_with('-') && a[1..].chars().all(|c| matches!(c, 'n' | 'e' | 'E')) {
            for c in a[1..].chars() {
                match c { 'n' => newline = false, 'e' => escapes = true, 'E' => escapes = false, _ => {} }
            }
            i += 1;
        } else {
            break;
        }
    }
    let mut s = args[i..].join(" ");
    if escapes {
        if let Some(idx) = s.find("\\c") { s.truncate(idx); newline = false; }
        s = crate::interp::unescape_ansi_c(&s);
    }
    if newline { s.push('\n'); }
    o.out(&s);
    o
}

fn printf(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let Some(fmt) = args.first() else {
        o.err("printf", "usage: printf format [arguments]");
        o.code = 2;
        return o;
    };
    let fmt = crate::interp::unescape_ansi_c(fmt);
    let rest = &args[1..];
    let mut idx = 0;
    loop {
        let mut used = false;
        let chars: Vec<char> = fmt.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c != '%' { o.out(&c.to_string()); i += 1; continue; }
            i += 1;
            if i >= chars.len() { o.out("%"); break; }
            if chars[i] == '%' { o.out("%"); i += 1; continue; }
            let mut spec = String::new();
            while i < chars.len() && "-+ #0123456789.".contains(chars[i]) { spec.push(chars[i]); i += 1; }
            let conv = chars.get(i).copied().unwrap_or('s');
            i += 1;
            let arg = rest.get(idx).cloned().unwrap_or_default();
            if idx < rest.len() { used = true; }
            idx += 1;
            let (left, zero, width, prec) = parse_spec(&spec);
            let body = match conv {
                'd' | 'i' => {
                    let n = parse_num_arg(&arg) as i64;
                    let s = n.abs().to_string();
                    let s = if let Some(p) = prec { format!("{:0>w$}", s, w = p) } else { s };
                    let sign = if n < 0 { "-" } else if spec.contains('+') { "+" } else { "" };
                    if zero && !left {
                        let w = width.saturating_sub(sign.len());
                        format!("{}{:0>w$}", sign, s, w = w)
                    } else { format!("{}{}", sign, s) }
                }
                'u' => (parse_num_arg(&arg) as u64).to_string(),
                'x' => format!("{:x}", parse_num_arg(&arg) as i64),
                'X' => format!("{:X}", parse_num_arg(&arg) as i64),
                'o' => format!("{:o}", parse_num_arg(&arg) as i64),
                'f' | 'F' => format!("{:.*}", prec.unwrap_or(6), arg.trim().parse::<f64>().unwrap_or(0.0)),
                'e' => format!("{:.*e}", prec.unwrap_or(6), arg.trim().parse::<f64>().unwrap_or(0.0)),
                'g' => format!("{}", arg.trim().parse::<f64>().unwrap_or(0.0)),
                'c' => arg.chars().next().map(|c| c.to_string()).unwrap_or_default(),
                'b' => crate::interp::unescape_ansi_c(&arg),
                'q' => format!("'{}'", arg.replace('\'', "'\\''")),
                _ => match prec { Some(p) => arg.chars().take(p).collect(), None => arg },
            };
            let padded = if body.chars().count() >= width { body } else if left {
                format!("{:<w$}", body, w = width)
            } else if zero && matches!(conv, 'f' | 'x' | 'X' | 'o' | 'u') {
                format!("{:0>w$}", body, w = width)
            } else {
                format!("{:>w$}", body, w = width)
            };
            o.out(&padded);
        }
        if !used || idx >= rest.len() { break; }
    }
    o
}

fn parse_spec(spec: &str) -> (bool, bool, usize, Option<usize>) {
    let left = spec.contains('-');
    let flags_end = spec.find(|c: char| c.is_ascii_digit() && c != '0').unwrap_or(spec.find('.').unwrap_or(spec.len()));
    let zero = spec[..flags_end].contains('0');
    let rest: String = spec.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let rest = rest.trim_start_matches('0');
    let (w, p) = match rest.split_once('.') {
        Some((w, p)) => (w.parse().unwrap_or(0), Some(p.parse().unwrap_or(0))),
        None => (rest.parse().unwrap_or(0), None),
    };
    (left, zero, w, p)
}

fn parse_num_arg(s: &str) -> f64 {
    let t = s.trim();
    if let Some(c) = t.strip_prefix('\'').or_else(|| t.strip_prefix('"')) {
        return c.chars().next().map_or(0.0, |c| c as u32 as f64);
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(h, 16).unwrap_or(0) as f64;
    }
    t.parse::<f64>().unwrap_or(0.0).trunc()
}

fn cat(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let number = a.has('n');
    let mut n = 0;
    for (_, d) in inputs("cat", &a.pos, ctx, &mut o) {
        if number {
            for l in lines_of(&d) {
                n += 1;
                o.out(&format!("{:>6}\t{}\n", n, l));
            }
        } else {
            o.stdout.extend_from_slice(&d);
        }
    }
    o
}

fn ls(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let all = a.has('a') || a.has('A');
    let long = a.has('l');
    let one = a.has('1') || long || true;
    let recursive = a.has('R');
    let targets = if a.pos.is_empty() { vec![".".to_string()] } else { a.pos.clone() };
    let multi = targets.len() > 1 || recursive;
    let fmt_entry = |fs: &MemFs, path: &str, name: &str| -> String {
        if long {
            let (kind, size) = if fs.is_dir(path) { ('d', 4096) } else { ('-', fs.size(path)) };
            format!("{}rw-r--r-- 1 user user {:>8} Jan  1 00:00 {}", kind, size, name)
        } else {
            name.to_string()
        }
    };
    let mut first = true;
    let mut stack: Vec<(String, String)> = targets.iter().rev().map(|t| (t.clone(), fs::normalize(ctx.cwd, t))).collect();
    while let Some((label, p)) = stack.pop() {
        if ctx.fs.is_file(&p) {
            o.out(&format!("{}\n", fmt_entry(ctx.fs, &p, &label)));
            continue;
        }
        let Ok(mut kids) = ctx.fs.list(&p) else {
            o.err("ls", &format!("cannot access '{}': No such file or directory", label));
            o.code = 2;
            continue;
        };
        if !all { kids.retain(|k| !k.starts_with('.')); }
        if multi {
            if !first { o.out("\n"); }
            o.out(&format!("{}:\n", label));
        }
        first = false;
        if long { o.out(&format!("total {}\n", kids.len())); }
        let _ = one;
        for k in &kids {
            let kp = fs::normalize(&p, k);
            o.out(&format!("{}\n", fmt_entry(ctx.fs, &kp, k)));
        }
        if recursive {
            for k in kids.iter().rev() {
                let kp = fs::normalize(&p, k);
                if ctx.fs.is_dir(&kp) {
                    let lbl = if label.ends_with('/') { format!("{}{}", label, k) } else { format!("{}/{}", label, k) };
                    stack.push((lbl, kp));
                }
            }
        }
    }
    o
}

fn mkdir(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "m");
    for d in &a.pos {
        let p = fs::normalize(ctx.cwd, d);
        if let Err(e) = ctx.fs.mkdir(&p, a.has('p')) {
            o.err("mkdir", &e.replace(&p, d));
            o.code = 1;
        }
    }
    o
}

fn rm(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let rec = a.has('r') || a.has('R');
    let force = a.has('f');
    for f in &a.pos {
        let p = fs::normalize(ctx.cwd, f);
        if !ctx.fs.exists(&p) {
            if !force { o.err("rm", &format!("cannot remove '{}': No such file or directory", f)); o.code = 1; }
            continue;
        }
        if ctx.fs.is_dir(&p) && !rec {
            o.err("rm", &format!("cannot remove '{}': Is a directory", f));
            o.code = 1;
            continue;
        }
        if let Err(e) = ctx.fs.remove(&p, rec) { o.err("rm", &e); o.code = 1; }
    }
    o
}

fn rmdir(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for f in args {
        let p = fs::normalize(ctx.cwd, f);
        if !ctx.fs.is_dir(&p) { o.err("rmdir", &format!("failed to remove '{}': Not a directory", f)); o.code = 1; continue; }
        if let Err(e) = ctx.fs.remove(&p, false) { o.err("rmdir", &e); o.code = 1; }
    }
    o
}

fn touch(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for f in parse_args(args, "dt").pos {
        let p = fs::normalize(ctx.cwd, &f);
        if !ctx.fs.exists(&p) {
            if let Err(e) = ctx.fs.write(&p, b"", false) { o.err("touch", &e); o.code = 1; }
        }
    }
    o
}

fn cp(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let rec = a.has('r') || a.has('R') || a.has('a');
    if a.pos.len() < 2 { o.err("cp", "missing file operand"); o.code = 1; return o; }
    let (srcs, dest) = a.pos.split_at(a.pos.len() - 1);
    let dp = fs::normalize(ctx.cwd, &dest[0]);
    for s in srcs {
        let sp = fs::normalize(ctx.cwd, s);
        let target = if ctx.fs.is_dir(&dp) { fs::normalize(&dp, fs::basename(&sp)) } else { dp.clone() };
        if let Err(e) = ctx.fs.copy(&sp, &target, rec) { o.err("cp", &e.replace(&sp, s)); o.code = 1; }
    }
    o
}

fn mv(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    if a.pos.len() < 2 { o.err("mv", "missing file operand"); o.code = 1; return o; }
    let (srcs, dest) = a.pos.split_at(a.pos.len() - 1);
    let dp = fs::normalize(ctx.cwd, &dest[0]);
    for s in srcs {
        let sp = fs::normalize(ctx.cwd, s);
        let target = if ctx.fs.is_dir(&dp) { fs::normalize(&dp, fs::basename(&sp)) } else { dp.clone() };
        if let Err(e) = ctx.fs.rename(&sp, &target) { o.err("mv", &e.replace(&sp, s)); o.code = 1; }
    }
    o
}

/// Accept `head -5` as shorthand for `head -n 5`.
fn normalize_count_flag(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|a| if a.len() > 1 && a.starts_with('-') && a[1..].chars().all(|c| c.is_ascii_digit()) { format!("-n{}", &a[1..]) } else { a.clone() })
        .collect()
}

fn head(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(&normalize_count_flag(args), "nc");
    let n: i64 = a.val('n').and_then(|v| v.parse().ok()).unwrap_or(10);
    let ins = inputs("head", &a.pos, ctx, &mut o);
    let multi = ins.len() > 1;
    for (i, (name, d)) in ins.iter().enumerate() {
        if multi { o.out(&format!("{}==> {} <==\n", if i > 0 { "\n" } else { "" }, name)); }
        if let Some(c) = a.val('c').and_then(|v| v.parse::<usize>().ok()) {
            o.stdout.extend_from_slice(&d[..c.min(d.len())]);
            continue;
        }
        let lines = lines_of(d);
        let take = if n >= 0 { (n as usize).min(lines.len()) } else { lines.len().saturating_sub((-n) as usize) };
        o.out(&join_lines(&lines[..take]));
    }
    o
}

fn tail(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(&normalize_count_flag(args), "nc");
    let spec = a.val('n').unwrap_or("10").to_string();
    for (_, d) in inputs("tail", &a.pos, ctx, &mut o) {
        let lines = lines_of(&d);
        let slice = if let Some(from) = spec.strip_prefix('+') {
            let k: usize = from.parse().unwrap_or(1);
            &lines[(k.saturating_sub(1)).min(lines.len())..]
        } else {
            let k: usize = spec.parse().unwrap_or(10);
            &lines[lines.len().saturating_sub(k)..]
        };
        o.out(&join_lines(slice));
    }
    o
}

fn wc(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let (mut l, mut w, mut c) = (a.has('l'), a.has('w'), a.has('c') || a.has('m'));
    if !l && !w && !c { l = true; w = true; c = true; }
    let ins = inputs("wc", &a.pos, ctx, &mut o);
    let mut tot = (0, 0, 0);
    let single_stdin = a.pos.is_empty();
    let fmt = |n: (usize, usize, usize), name: &str| {
        let mut parts = vec![];
        if l { parts.push(n.0); }
        if w { parts.push(n.1); }
        if c { parts.push(n.2); }
        let nums: Vec<String> = if parts.len() == 1 && (single_stdin || ins.len() == 1) { parts.iter().map(|p| p.to_string()).collect() } else { parts.iter().map(|p| format!("{:>7}", p)).collect() };
        let mut s = nums.join(" ");
        if !name.is_empty() { s.push(' '); s.push_str(name); }
        s.push('\n');
        s
    };
    for (name, d) in &ins {
        let text = String::from_utf8_lossy(d);
        let n = (d.iter().filter(|&&b| b == b'\n').count(), text.split_whitespace().count(), if a.has('m') { text.chars().count() } else { d.len() });
        tot = (tot.0 + n.0, tot.1 + n.1, tot.2 + n.2);
        o.out(&fmt(n, if name == "-" { "" } else { name }));
    }
    if ins.len() > 1 { o.out(&fmt(tot, "total")); }
    o
}

fn grep(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "efABCm");
    let mut patterns = a.vals('e');
    let mut pos = a.pos.clone();
    if patterns.is_empty() {
        if pos.is_empty() { o.err("grep", "usage: grep [OPTION]... PATTERNS [FILE]..."); o.code = 2; return o; }
        patterns.push(pos.remove(0));
    }
    let extended = a.has('E') || a.has('P');
    let pat = if extended || a.has('F') { patterns.join("|") } else { patterns.join("\\|") };
    let pat = if a.has('F') && patterns.len() > 1 { patterns.iter().map(|p| regex::escape(p)).collect::<Vec<_>>().join("|") } else { pat };
    let re = match build_regex(&pat, extended || (a.has('F') && patterns.len() > 1), a.has('F') && patterns.len() == 1, a.has('i') || a.has_long("ignore-case"), a.has('w'), a.has('x')) {
        Ok(r) => r,
        Err(e) => { o.err("grep", &e); o.code = 2; return o; }
    };
    let invert = a.has('v');
    let count = a.has('c');
    let list = a.has('l');
    let quiet = a.has('q');
    let only = a.has('o');
    let number = a.has('n');
    let max: Option<usize> = a.val('m').and_then(|v| v.parse().ok());
    let recursive = a.has('r') || a.has('R');

    let mut files: Vec<(String, Vec<u8>)> = vec![];
    if recursive {
        let roots = if pos.is_empty() { vec![".".to_string()] } else { pos.clone() };
        for r in roots {
            let rp = fs::normalize(ctx.cwd, &r);
            if ctx.fs.is_file(&rp) { files.push((r.clone(), ctx.fs.read(&rp).unwrap().to_vec())); continue; }
            for p in ctx.fs.walk(&rp) {
                if ctx.fs.is_file(&p) {
                    let disp = if r == "." { p[rp.len()..].trim_start_matches('/').to_string() } else { format!("{}{}", r.trim_end_matches('/'), &p[rp.len()..]) };
                    files.push((disp, ctx.fs.read(&p).unwrap().to_vec()));
                }
            }
        }
    } else {
        files = inputs("grep", &pos, ctx, &mut o);
    }
    let show_name = (files.len() > 1 || recursive) && !a.has('h') || a.has('H');
    let mut any = false;
    for (name, d) in &files {
        let mut n = 0usize;
        for (i, line) in lines_of(d).iter().enumerate() {
            if max.map_or(false, |m| n >= m) { break; }
            let hit = re.is_match(line);
            if hit == invert { continue; }
            n += 1;
            any = true;
            if quiet || list || count { continue; }
            let prefix = format!("{}{}", if show_name { format!("{}:", name) } else { String::new() }, if number { format!("{}:", i + 1) } else { String::new() });
            if only && !invert {
                for m in re.find_iter(line) { o.out(&format!("{}{}\n", prefix, m.as_str())); }
            } else {
                o.out(&format!("{}{}\n", prefix, line));
            }
        }
        if quiet && any { return o; }
        if list && n > 0 { o.out(&format!("{}\n", if name == "-" { "(standard input)" } else { name })); }
        if count { o.out(&format!("{}{}\n", if show_name { format!("{}:", name) } else { String::new() }, n)); }
    }
    if o.code == 0 { o.code = if any { 0 } else { 1 }; }
    o
}

fn sort(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "ktTo");
    let mut lines = vec![];
    for (_, d) in inputs("sort", &a.pos, ctx, &mut o) { lines.extend(lines_of(&d)); }
    let numeric = a.has('n') || a.has('g');
    let human = a.has('h');
    let fold = a.has('f');
    let sep = a.val('t').map(|s| s.to_string());
    let key: Option<(usize, Option<usize>)> = a.val('k').map(|k| {
        let k = k.split(|c: char| !c.is_ascii_digit() && c != ',').next().unwrap_or("1");
        let (s, e) = k.split_once(',').map(|(s, e)| (s, Some(e))).unwrap_or((k, None));
        (s.parse().unwrap_or(1), e.and_then(|e| e.parse().ok()))
    });
    let key_of = |l: &str| -> String {
        match key {
            None => l.to_string(),
            Some((s, e)) => {
                let fields: Vec<&str> = match &sep { Some(t) => l.split(t.as_str()).collect(), None => l.split_whitespace().collect() };
                let end = e.unwrap_or(fields.len()).min(fields.len());
                if s == 0 || s > fields.len() { return String::new(); }
                fields[s - 1..end.max(s)].join(sep.as_deref().unwrap_or(" "))
            }
        }
    };
    let num = |s: &str| -> f64 {
        let t = s.trim();
        if human {
            let (n, m) = t.split_at(t.find(|c: char| c.is_alphabetic()).unwrap_or(t.len()));
            let mult = match m.chars().next().map(|c| c.to_ascii_uppercase()) { Some('K') => 1e3, Some('M') => 1e6, Some('G') => 1e9, Some('T') => 1e12, _ => 1.0 };
            return n.parse::<f64>().unwrap_or(0.0) * mult;
        }
        let end = t.char_indices().take_while(|(i, c)| c.is_ascii_digit() || *c == '.' || (*i == 0 && *c == '-')).map(|(i, c)| i + c.len_utf8()).last().unwrap_or(0);
        t[..end].parse().unwrap_or(0.0)
    };
    lines.sort_by(|x, y| {
        let (kx, ky) = (key_of(x), key_of(y));
        let ord = if numeric || human {
            num(&kx).partial_cmp(&num(&ky)).unwrap_or(std::cmp::Ordering::Equal)
        } else if fold {
            kx.to_lowercase().cmp(&ky.to_lowercase())
        } else {
            kx.cmp(&ky)
        };
        ord.then_with(|| if key.is_some() || numeric { x.cmp(y) } else { std::cmp::Ordering::Equal })
    });
    if a.has('r') { lines.reverse(); }
    if a.has('u') {
        lines.dedup_by(|x, y| if numeric { num(&key_of(x)) == num(&key_of(y)) } else { key_of(x) == key_of(y) });
    }
    let text = join_lines(&lines);
    if let Some(of) = a.val('o') {
        let p = fs::normalize(ctx.cwd, of);
        if let Err(e) = ctx.fs.write(&p, text.as_bytes(), false) { o.err("sort", &e); o.code = 2; }
    } else {
        o.out(&text);
    }
    o
}

fn uniq(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let mut lines = vec![];
    for (_, d) in inputs("uniq", &a.pos[..a.pos.len().min(1)], ctx, &mut o) { lines.extend(lines_of(&d)); }
    let icase = a.has('i');
    let mut groups: Vec<(String, usize)> = vec![];
    for l in lines {
        match groups.last_mut() {
            Some((prev, n)) if (icase && prev.eq_ignore_ascii_case(&l)) || *prev == l => *n += 1,
            _ => groups.push((l, 1)),
        }
    }
    for (l, n) in groups {
        if a.has('d') && n < 2 { continue; }
        if a.has('u') && n > 1 { continue; }
        if a.has('c') { o.out(&format!("{:>7} {}\n", n, l)); } else { o.out(&format!("{}\n", l)); }
    }
    o
}

fn parse_ranges(spec: &str) -> Vec<(usize, usize)> {
    spec.split(',')
        .filter_map(|r| {
            if let Some((s, e)) = r.split_once('-') {
                Some((s.parse().unwrap_or(1), e.parse().unwrap_or(usize::MAX)))
            } else {
                r.parse().ok().map(|n| (n, n))
            }
        })
        .collect()
}

fn cut(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "dfcb");
    let delim = a.val('d').map(|d| d.to_string()).unwrap_or("\t".into());
    let in_range = |i: usize, rs: &[(usize, usize)]| rs.iter().any(|(s, e)| i >= *s && i <= *e);
    for (_, d) in inputs("cut", &a.pos, ctx, &mut o) {
        for line in lines_of(&d) {
            if let Some(f) = a.val('f') {
                let rs = parse_ranges(f);
                if !line.contains(delim.as_str()) {
                    if !a.has('s') { o.out(&format!("{}\n", line)); }
                    continue;
                }
                let parts: Vec<&str> = line.split(delim.as_str()).collect();
                let sel: Vec<&str> = parts.iter().enumerate().filter(|(i, _)| in_range(i + 1, &rs)).map(|(_, p)| *p).collect();
                o.out(&format!("{}\n", sel.join(&delim)));
            } else if let Some(c) = a.val('c').or(a.val('b')) {
                let rs = parse_ranges(c);
                let s: String = line.chars().enumerate().filter(|(i, _)| in_range(i + 1, &rs)).map(|(_, c)| c).collect();
                o.out(&format!("{}\n", s));
            }
        }
    }
    o
}

fn expand_tr_set(s: &str) -> Vec<char> {
    let classes = [
        ("[:upper:]", ('A'..='Z').collect::<Vec<_>>()),
        ("[:lower:]", ('a'..='z').collect()),
        ("[:digit:]", ('0'..='9').collect()),
        ("[:alpha:]", ('A'..='Z').chain('a'..='z').collect()),
        ("[:alnum:]", ('0'..='9').chain('A'..='Z').chain('a'..='z').collect()),
        ("[:space:]", vec![' ', '\t', '\n', '\r', '\x0b', '\x0c']),
        ("[:blank:]", vec![' ', '\t']),
        ("[:punct:]", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".chars().collect()),
    ];
    let s = crate::interp::unescape_ansi_c(s);
    let chars: Vec<char> = s.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    'outer: while i < chars.len() {
        for (name, set) in &classes {
            let n: Vec<char> = name.chars().collect();
            if chars[i..].starts_with(&n) {
                out.extend(set.iter().copied());
                i += n.len();
                continue 'outer;
            }
        }
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            let (a, b) = (chars[i] as u32, chars[i + 2] as u32);
            for c in a..=b { if let Some(c) = char::from_u32(c) { out.push(c); } }
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn tr(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    let input = String::from_utf8_lossy(ctx.stdin).into_owned();
    let set1 = a.pos.first().map(|s| expand_tr_set(s)).unwrap_or_default();
    let set2 = a.pos.get(1).map(|s| expand_tr_set(s)).unwrap_or_default();
    let complement = a.has('c') || a.has('C');
    let in1 = |c: char| set1.contains(&c) != complement;
    let mut res = String::new();
    let mut last: Option<char> = None;
    let squeeze_set: &Vec<char> = if a.has('d') { &set2 } else if !set2.is_empty() { &set2 } else { &set1 };
    for c in input.chars() {
        let mapped = if a.has('d') {
            if in1(c) { continue; }
            c
        } else if !set2.is_empty() && !complement {
            match set1.iter().position(|&x| x == c) {
                Some(i) => *set2.get(i).unwrap_or(set2.last().unwrap()),
                None => c,
            }
        } else if !set2.is_empty() && complement {
            if in1(c) { *set2.last().unwrap() } else { c }
        } else {
            c
        };
        if a.has('s') && last == Some(mapped) && squeeze_set.contains(&mapped) { continue; }
        last = Some(mapped);
        res.push(mapped);
    }
    o.out(&res);
    o
}

// ---------------------------------------------------------------------- sed

#[derive(Clone)]
enum Addr { Line(usize), Last, Re(Regex) }

#[derive(Clone)]
enum SedCmd {
    Sub { re: Regex, rep: String, global: bool, nth: usize, print: bool },
    Delete,
    Print,
    Quit,
    LineNo,
    Append(String),
    Insert(String),
    Change(String),
    Trans(Vec<char>, Vec<char>),
}

struct SedInstr { a1: Option<Addr>, a2: Option<Addr>, negate: bool, cmd: SedCmd }

fn sed_parse(script: &str, extended: bool) -> Result<Vec<SedInstr>, String> {
    let chars: Vec<char> = script.chars().collect();
    let mut i = 0;
    let mut instrs = vec![];
    let mk_re = |p: &str, icase: bool| -> Result<Regex, String> {
        let p = if extended { p.to_string() } else { bre_to_ere(p) };
        RegexBuilder::new(&p).case_insensitive(icase).build().map_err(|e| format!("bad regex: {}", e.to_string().lines().last().unwrap_or("")))
    };
    let read_delim = |i: &mut usize, d: char| -> String {
        let mut s = String::new();
        while *i < chars.len() && chars[*i] != d {
            if chars[*i] == '\\' && *i + 1 < chars.len() {
                if chars[*i + 1] == d { s.push(d); } else { s.push('\\'); s.push(chars[*i + 1]); }
                *i += 2;
                continue;
            }
            s.push(chars[*i]);
            *i += 1;
        }
        *i += 1;
        s
    };
    let parse_addr = |i: &mut usize| -> Result<Option<Addr>, String> {
        if *i >= chars.len() { return Ok(None); }
        if chars[*i].is_ascii_digit() {
            let mut n = String::new();
            while *i < chars.len() && chars[*i].is_ascii_digit() { n.push(chars[*i]); *i += 1; }
            return Ok(Some(Addr::Line(n.parse().unwrap())));
        }
        if chars[*i] == '$' { *i += 1; return Ok(Some(Addr::Last)); }
        if chars[*i] == '/' {
            *i += 1;
            let p = read_delim(i, '/');
            return Ok(Some(Addr::Re(mk_re(&p, false)?)));
        }
        Ok(None)
    };
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ';') { i += 1; }
        if i >= chars.len() { break; }
        let a1 = parse_addr(&mut i)?;
        let mut a2 = None;
        if a1.is_some() && i < chars.len() && chars[i] == ',' { i += 1; a2 = parse_addr(&mut i)?; }
        while i < chars.len() && chars[i] == ' ' { i += 1; }
        let mut negate = false;
        if i < chars.len() && chars[i] == '!' { negate = true; i += 1; }
        if i >= chars.len() { return Err("missing command".into()); }
        let c = chars[i];
        i += 1;
        let text_arg = |i: &mut usize| -> String {
            if *i < chars.len() && chars[*i] == '\\' { *i += 1; }
            while *i < chars.len() && chars[*i] == ' ' { *i += 1; }
            let mut s = String::new();
            while *i < chars.len() && chars[*i] != '\n' && chars[*i] != ';' { s.push(chars[*i]); *i += 1; }
            s
        };
        let cmd = match c {
            's' => {
                let d = chars.get(i).copied().ok_or("unterminated s")?;
                i += 1;
                let pat = read_delim(&mut i, d);
                let rep = read_delim(&mut i, d);
                let mut global = false; let mut print = false; let mut icase = false; let mut nth = 1;
                while i < chars.len() && !matches!(chars[i], ';' | '\n' | '}' | ' ') {
                    match chars[i] { 'g' => global = true, 'p' => print = true, 'i' | 'I' => icase = true, d if d.is_ascii_digit() => nth = d.to_digit(10).unwrap() as usize, _ => {} }
                    i += 1;
                }
                SedCmd::Sub { re: mk_re(&pat, icase)?, rep: sed_rep(&rep), global, nth, print }
            }
            'y' => {
                let d = chars.get(i).copied().ok_or("unterminated y")?;
                i += 1;
                let a = read_delim(&mut i, d);
                let b = read_delim(&mut i, d);
                SedCmd::Trans(a.chars().collect(), b.chars().collect())
            }
            'd' => SedCmd::Delete,
            'p' => SedCmd::Print,
            'q' => SedCmd::Quit,
            '=' => SedCmd::LineNo,
            'a' => SedCmd::Append(text_arg(&mut i)),
            'i' => SedCmd::Insert(text_arg(&mut i)),
            'c' => SedCmd::Change(text_arg(&mut i)),
            other => return Err(format!("unknown command: `{}'", other)),
        };
        instrs.push(SedInstr { a1, a2, negate, cmd });
    }
    Ok(instrs)
}

/// sed replacement → regex crate replacement: `&` → `${0}`, `\1` → `${1}`.
fn sed_rep(r: &str) -> String {
    let mut o = String::new();
    let mut it = r.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '&' => o.push_str("${0}"),
            '$' => o.push_str("$$"),
            '\\' => match it.next() {
                Some(d) if d.is_ascii_digit() => o.push_str(&format!("${{{}}}", d)),
                Some('n') => o.push('\n'),
                Some('t') => o.push('\t'),
                Some('&') => o.push('&'),
                Some(x) => o.push(x),
                None => o.push('\\'),
            },
            _ => o.push(c),
        }
    }
    o
}

fn sed(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "ef");
    let mut scripts = a.vals('e');
    let mut pos = a.pos.clone();
    if scripts.is_empty() {
        if pos.is_empty() { o.err("sed", "no script specified"); o.code = 1; return o; }
        scripts.push(pos.remove(0));
    }
    let extended = a.has('E') || a.has('r');
    let instrs = match sed_parse(&scripts.join("\n"), extended) {
        Ok(v) => v,
        Err(e) => { o.err("sed", &format!("-e expression #1: {}", e)); o.code = 1; return o; }
    };
    let quiet = a.has('n');
    let in_place = a.has('i');
    let files = if in_place { pos.clone() } else { vec![] };
    let ins = inputs("sed", &pos, ctx, &mut o);
    for (name, d) in ins {
        let lines = lines_of(&d);
        let total = lines.len();
        let mut result = String::new();
        let mut active: Vec<bool> = vec![false; instrs.len()];
        'lines: for (idx, line) in lines.iter().enumerate() {
            let ln = idx + 1;
            let mut ps = line.clone();
            let mut append_after: Vec<String> = vec![];
            let matches = |ad: &Addr, ps: &str| match ad { Addr::Line(n) => *n == ln, Addr::Last => ln == total, Addr::Re(r) => r.is_match(ps) };
            let mut deleted = false;
            for (k, ins) in instrs.iter().enumerate() {
                let sel = match (&ins.a1, &ins.a2) {
                    (None, _) => true,
                    (Some(x), None) => matches(x, &ps),
                    (Some(x), Some(y)) => {
                        if active[k] {
                            if matches(y, &ps) || matches!(y, Addr::Line(n) if ln >= *n) { active[k] = false; }
                            true
                        } else if matches(x, &ps) {
                            active[k] = !matches!(y, Addr::Line(n) if ln >= *n);
                            true
                        } else { false }
                    }
                };
                if sel == ins.negate { continue; }
                match &ins.cmd {
                    SedCmd::Sub { re, rep, global, nth, print } => {
                        let new = if *global { re.replace_all(&ps, rep.as_str()).into_owned() } else if *nth > 1 {
                            match re.find_iter(&ps).nth(nth - 1) {
                                Some(m) => {
                                    let caps_rep = re.replace(&ps[m.start()..], rep.as_str());
                                    format!("{}{}", &ps[..m.start()], caps_rep)
                                }
                                None => ps.clone(),
                            }
                        } else { re.replace(&ps, rep.as_str()).into_owned() };
                        let changed = new != ps || re.is_match(&ps);
                        ps = new;
                        if *print && changed { result.push_str(&ps); result.push('\n'); }
                    }
                    SedCmd::Trans(x, y) => ps = ps.chars().map(|c| x.iter().position(|&z| z == c).and_then(|i| y.get(i).copied()).unwrap_or(c)).collect(),
                    SedCmd::Delete => { deleted = true; break; }
                    SedCmd::Print => { result.push_str(&ps); result.push('\n'); }
                    SedCmd::LineNo => { result.push_str(&format!("{}\n", ln)); }
                    SedCmd::Append(t) => append_after.push(t.clone()),
                    SedCmd::Insert(t) => { result.push_str(t); result.push('\n'); }
                    SedCmd::Change(t) => { result.push_str(t); result.push('\n'); deleted = true; break; }
                    SedCmd::Quit => {
                        if !quiet { result.push_str(&ps); result.push('\n'); }
                        for t in &append_after { result.push_str(t); result.push('\n'); }
                        break 'lines;
                    }
                }
            }
            if !deleted && !quiet { result.push_str(&ps); result.push('\n'); }
            for t in append_after { result.push_str(&t); result.push('\n'); }
        }
        if in_place && name != "-" && files.contains(&name) {
            let p = fs::normalize(ctx.cwd, &name);
            let _ = ctx.fs.write(&p, result.as_bytes(), false);
        } else {
            o.out(&result);
        }
    }
    o
}

// ----------------------------------------------------------------------- jq

#[cfg(feature = "jq")]
fn jq(args: &[String], ctx: &mut Ctx) -> CmdOut {
    use jaq_core::load::{Arena, File, Loader};
    use jaq_core::{Compiler, Ctx as JCtx, Vars, data, unwrap_valr};
    use jaq_json::Val;

    let mut o = CmdOut::default();
    let mut raw = false;
    let mut compact = false;
    let mut null_input = false;
    let mut slurp = false;
    let mut join = false;
    let mut tab = false;
    let mut indent = 2usize;
    let mut sort_keys = false;
    let mut exit_status = false;
    let mut pos = vec![];
    let mut vars: Vec<(String, Val)> = vec![];
    let mut i = 0;
    while i < args.len() {
        let s = args[i].as_str();
        match s {
            "-r" | "--raw-output" => raw = true,
            "-j" | "--join-output" => { raw = true; join = true; }
            "-c" | "--compact-output" => compact = true,
            "-n" | "--null-input" => null_input = true,
            "-s" | "--slurp" => slurp = true,
            "-S" | "--sort-keys" => sort_keys = true,
            "-e" | "--exit-status" => exit_status = true,
            "--tab" => tab = true,
            "--indent" => { i += 1; indent = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(2); }
            "--arg" => {
                if let (Some(k), Some(v)) = (args.get(i + 1), args.get(i + 2)) { vars.push((k.clone(), Val::from(v.clone()))); }
                i += 2;
            }
            "--argjson" => {
                if let (Some(k), Some(v)) = (args.get(i + 1), args.get(i + 2)) {
                    match jaq_json::read::parse_single(v.as_bytes()) {
                        Ok(val) => vars.push((k.clone(), val)),
                        Err(_) => { o.err("jq", &format!("invalid JSON text passed to --argjson")); o.code = 2; return o; }
                    }
                }
                i += 2;
            }
            s if s.starts_with('-') && s.len() > 1 && pos.is_empty() => {
                // combined short flags like -rc
                for c in s[1..].chars() {
                    match c { 'r' => raw = true, 'c' => compact = true, 'n' => null_input = true, 's' => slurp = true, 'S' => sort_keys = true, 'e' => exit_status = true, 'j' => { raw = true; join = true; } _ => {} }
                }
            }
            _ => pos.push(args[i].clone()),
        }
        i += 1;
    }
    let filter_src = if pos.is_empty() { ".".to_string() } else { pos.remove(0) };

    let program = File { code: filter_src.as_str(), path: () };
    let defs = jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs());
    let funs = jaq_core::funs().chain(jaq_std::funs()).chain(jaq_json::funs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules = match loader.load(&arena, program) {
        Ok(m) => m,
        Err(_) => { o.err("jq", &format!("error: syntax error in filter: {}", filter_src)); o.code = 3; return o; }
    };
    let var_names: Vec<String> = vars.iter().map(|(k, _)| format!("${}", k)).collect();
    let filter = match Compiler::default().with_funs(funs).with_global_vars(var_names.iter().map(|s| s.as_str())).compile(modules) {
        Ok(f) => f,
        Err(_) => { o.err("jq", &format!("error: compile error in filter: {}", filter_src)); o.code = 3; return o; }
    };

    // Collect inputs.
    let mut values: Vec<Val> = vec![];
    if null_input {
        values.push(Val::Null);
    } else {
        let mut data: Vec<u8> = vec![];
        for (_, d) in inputs("jq", &pos, ctx, &mut o) { data.extend_from_slice(&d); data.push(b'\n'); }
        if o.code != 0 { o.code = 2; return o; }
        let mut parsed = vec![];
        for v in jaq_json::read::parse_many(&data) {
            match v {
                Ok(v) => parsed.push(v),
                Err(e) => { o.err("jq", &format!("error: cannot parse input: {:?}", e)); o.code = 2; return o; }
            }
        }
        if slurp { values.push(Val::Arr(jaq_json::Rc::new(parsed))); } else { values = parsed; }
    }

    let pp = jaq_json::write::Pp {
        indent: if compact { None } else if tab { Some("\t".to_string()) } else { Some(" ".repeat(indent)) },
        sort_keys,
        styles: Default::default(),
        sep_space: !compact,
    };
    let mut last: Option<Val> = None;
    for input in values {
        let ctx_j = JCtx::<data::JustLut<Val>>::new(&filter.lut, Vars::new(vars.iter().map(|(_, v)| v.clone())));
        for r in filter.id.run((ctx_j, input)).map(unwrap_valr) {
            match r {
                Ok(v) => {
                    let mut buf: Vec<u8> = vec![];
                    match (&v, raw) {
                        (Val::TStr(b), true) | (Val::BStr(b), true) => buf.extend_from_slice(b.as_ref()),
                        _ => { let _ = jaq_json::write::write(&mut buf, &pp, 0, &v); }
                    }
                    if !join { buf.push(b'\n'); }
                    o.stdout.extend_from_slice(&buf);
                    last = Some(v);
                }
                Err(e) => { o.err("jq", &format!("error (at <stdin>): {}", e)); o.code = 5; }
            }
        }
    }
    if exit_status && o.code == 0 {
        o.code = match last { None => 4, Some(Val::Null) | Some(Val::Bool(false)) => 1, _ => 0 };
    }
    o
}

// -------------------------------------------------------------------- misc

fn find(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let mut roots = vec![];
    let mut i = 0;
    while i < args.len() && !args[i].starts_with('-') { roots.push(args[i].clone()); i += 1; }
    if roots.is_empty() { roots.push(".".into()); }
    let mut name: Option<Regex> = None;
    let mut iname = false;
    let mut ftype: Option<char> = None;
    let mut maxdepth: Option<usize> = None;
    let mut mindepth: usize = 0;
    let mut path_pat: Option<Regex> = None;
    while i < args.len() {
        match args[i].as_str() {
            "-name" | "-iname" => {
                iname = args[i] == "-iname";
                i += 1;
                let p = args.get(i).cloned().unwrap_or_default();
                let body = brush_parser::pattern::pattern_to_regex_str(&p, false).unwrap_or(regex::escape(&p));
                name = RegexBuilder::new(&format!("^(?s:{})$", body)).case_insensitive(iname).build().ok();
            }
            "-path" => {
                i += 1;
                let p = args.get(i).cloned().unwrap_or_default();
                let body = brush_parser::pattern::pattern_to_regex_str(&p, false).unwrap_or(regex::escape(&p));
                path_pat = Regex::new(&format!("^(?s:{})$", body)).ok();
            }
            "-type" => { i += 1; ftype = args.get(i).and_then(|s| s.chars().next()); }
            "-maxdepth" => { i += 1; maxdepth = args.get(i).and_then(|s| s.parse().ok()); }
            "-mindepth" => { i += 1; mindepth = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(0); }
            "-print" => {}
            other => { o.err("find", &format!("unknown predicate `{}'", other)); o.code = 1; return o; }
        }
        i += 1;
    }
    for r in roots {
        let rp = fs::normalize(ctx.cwd, &r);
        if !ctx.fs.exists(&rp) { o.err("find", &format!("'{}': No such file or directory", r)); o.code = 1; continue; }
        let mut all = vec![rp.clone()];
        all.extend(ctx.fs.walk(&rp));
        for p in all {
            let rel = &p[rp.len()..];
            let depth = rel.matches('/').count();
            if maxdepth.map_or(false, |m| depth > m) || depth < mindepth { continue; }
            let disp = if rel.is_empty() { r.clone() } else { format!("{}{}", r.trim_end_matches('/'), rel) };
            if let Some(t) = ftype {
                let ok = match t { 'f' => ctx.fs.is_file(&p), 'd' => ctx.fs.is_dir(&p), _ => false };
                if !ok { continue; }
            }
            if let Some(re) = &name { if !re.is_match(fs::basename(&p)) { continue; } }
            if let Some(re) = &path_pat { if !re.is_match(&disp) { continue; } }
            o.out(&format!("{}\n", disp));
        }
    }
    o
}

fn seq(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "sf");
    let sep = a.val('s').unwrap_or("\n").to_string();
    let nums: Vec<f64> = a.pos.iter().filter_map(|s| s.parse().ok()).collect();
    let (start, step, end) = match nums.len() { 1 => (1.0, 1.0, nums[0]), 2 => (nums[0], 1.0, nums[1]), 3 => (nums[0], nums[1], nums[2]), _ => { o.err("seq", "missing operand"); o.code = 1; return o; } };
    if step == 0.0 { o.err("seq", "invalid Zero increment value"); o.code = 1; return o; }
    let is_int = a.pos.iter().all(|s| !s.contains('.'));
    let mut v = start;
    let mut parts = vec![];
    let mut guard = 0;
    while (step > 0.0 && v <= end + 1e-9) || (step < 0.0 && v >= end - 1e-9) {
        parts.push(if is_int { format!("{}", v as i64) } else { format!("{}", v) });
        v += step;
        guard += 1;
        if guard > 10_000_000 { break; }
    }
    if !parts.is_empty() { o.out(&parts.join(&sep)); o.out("\n"); }
    o
}

fn basename(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "s");
    if a.has('a') || a.val('s').is_some() {
        for p in &a.pos {
            let mut b = fs::basename(p).to_string();
            if let Some(s) = a.val('s') { if b.ends_with(s) && b != s { b.truncate(b.len() - s.len()); } }
            o.out(&format!("{}\n", b));
        }
    } else if let Some(p) = a.pos.first() {
        let mut b = fs::basename(p).to_string();
        if let Some(s) = a.pos.get(1) { if b.ends_with(s.as_str()) && b != *s { b.truncate(b.len() - s.len()); } }
        o.out(&format!("{}\n", b));
    }
    o
}

fn dirname(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for p in args {
        let t = p.trim_end_matches('/');
        let d = match t.rfind('/') { Some(0) => "/".to_string(), Some(i) => t[..i].to_string(), None => ".".to_string() };
        o.out(&format!("{}\n", d));
    }
    o
}

fn tee(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "");
    for f in &a.pos {
        let p = fs::normalize(ctx.cwd, f);
        if let Err(e) = ctx.fs.write(&p, ctx.stdin, a.has('a')) { o.err("tee", &e); o.code = 1; }
    }
    o.stdout.extend_from_slice(ctx.stdin);
    o
}

fn env(_args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let mut keys: Vec<_> = ctx.env.keys().collect();
    keys.sort();
    for k in keys { o.out(&format!("{}={}\n", k, ctx.env[k])); }
    o
}

fn rev(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for (_, d) in inputs("rev", args, ctx, &mut o) {
        for l in lines_of(&d) { o.out(&format!("{}\n", l.chars().rev().collect::<String>())); }
    }
    o
}

fn tac(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for (_, d) in inputs("tac", args, ctx, &mut o) {
        let mut l = lines_of(&d);
        l.reverse();
        o.out(&join_lines(&l));
    }
    o
}

fn nl(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let mut n = 0;
    for (_, d) in inputs("nl", args, ctx, &mut o) {
        for l in lines_of(&d) {
            if l.is_empty() { o.out("\n"); continue; }
            n += 1;
            o.out(&format!("{:>6}\t{}\n", n, l));
        }
    }
    o
}

fn sleep(_args: &[String], _ctx: &mut Ctx) -> CmdOut { CmdOut::default() }

fn date(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    // Deterministic clock in the sandbox; host can override via env later.
    if args.iter().any(|a| a == "+%s") { o.out("1767225600\n"); } else { o.out("Thu Jan  1 00:00:00 UTC 2026\n"); }
    o
}

fn whoami(_args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    o.out(&format!("{}\n", ctx.env.get("USER").cloned().unwrap_or("user".into())));
    o
}

fn hostname(_args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    o.out("sandbox\n");
    o
}

fn tree(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let root = args.iter().find(|a| !a.starts_with('-')).cloned().unwrap_or(".".into());
    let rp = fs::normalize(ctx.cwd, &root);
    o.out(&format!("{}\n", root));
    let (mut dirs, mut files) = (0, 0);
    fn walk(fs: &MemFs, p: &str, prefix: &str, o: &mut CmdOut, dirs: &mut usize, files: &mut usize) {
        let kids = fs.list(p).unwrap_or_default();
        for (i, k) in kids.iter().enumerate() {
            let last = i == kids.len() - 1;
            o.out(&format!("{}{} {}\n", prefix, if last { "└──" } else { "├──" }, k));
            let kp = fs::normalize(p, k);
            if fs.is_dir(&kp) {
                *dirs += 1;
                walk(fs, &kp, &format!("{}{}", prefix, if last { "    " } else { "│   " }), o, dirs, files);
            } else {
                *files += 1;
            }
        }
    }
    walk(ctx.fs, &rp, "", &mut o, &mut dirs, &mut files);
    o.out(&format!("\n{} directories, {} files\n", dirs, files));
    o
}

fn du(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "d");
    let targets = if a.pos.is_empty() { vec![".".to_string()] } else { a.pos.clone() };
    for t in targets {
        let p = fs::normalize(ctx.cwd, &t);
        let total: usize = std::iter::once(p.clone()).chain(ctx.fs.walk(&p)).map(|x| ctx.fs.size(&x)).sum();
        let shown = if a.has('h') { human_size(total) } else { ((total + 1023) / 1024).to_string() };
        o.out(&format!("{}\t{}\n", shown, t));
    }
    o
}

fn human_size(n: usize) -> String {
    let mut f = n as f64;
    for u in ["", "K", "M", "G"] {
        if f < 1024.0 { return if u.is_empty() { format!("{}", n) } else { format!("{:.1}{}", f, u) }; }
        f /= 1024.0;
    }
    format!("{:.1}T", f)
}

fn stat(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    for f in parse_args(args, "c").pos {
        let p = fs::normalize(ctx.cwd, &f);
        if !ctx.fs.exists(&p) { o.err("stat", &format!("cannot stat '{}': No such file or directory", f)); o.code = 1; continue; }
        let kind = if ctx.fs.is_dir(&p) { "directory" } else { "regular file" };
        let _ = write!(String::new(), "");
        o.out(&format!("  File: {}\n  Size: {}\t{}\n", f, ctx.fs.size(&p), kind));
    }
    o
}

fn paste(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut o = CmdOut::default();
    let a = parse_args(args, "d");
    let delim = a.val('d').unwrap_or("\t").to_string();
    let ins: Vec<Vec<String>> = inputs("paste", &a.pos, ctx, &mut o).iter().map(|(_, d)| lines_of(d)).collect();
    if a.has('s') {
        for l in ins { o.out(&format!("{}\n", l.join(&delim))); }
        return o;
    }
    let max = ins.iter().map(|l| l.len()).max().unwrap_or(0);
    for i in 0..max {
        let row: Vec<&str> = ins.iter().map(|l| l.get(i).map(|s| s.as_str()).unwrap_or("")).collect();
        o.out(&format!("{}\n", row.join(&delim)));
    }
    o
}
