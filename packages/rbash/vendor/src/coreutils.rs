//! The rest of the coreutils, so this shell covers what `just-bash` does.
//!
//! Same contract as `commands.rs`: a plain function over (args, stdin, fs),
//! no host access of any kind.

use std::fmt::Write as _;

use crate::commands::{inputs, join_lines, lines_of, parse_args, CmdOut, Ctx};
use crate::fs;

// ------------------------------------------------------------------ base64

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_cmd(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "w");
    let decode = a.has('d') || a.has_long("decode");
    let files = a.positional();
    let data: Vec<u8> = inputs("base64", &files, ctx, &mut out)
        .into_iter()
        .flat_map(|(_, d)| d)
        .collect();

    if decode {
        let filtered: Vec<u8> = data.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
        match b64_decode(&filtered) {
            Some(bytes) => out.stdout.extend_from_slice(&bytes),
            None => {
                out.stderr.extend_from_slice(b"base64: invalid input\n");
                out.code = 1;
            }
        }
    } else {
        let encoded = b64_encode(&data);
        // GNU wraps at 76 columns unless told otherwise.
        let width: usize = a.val('w').and_then(|v| v.parse().ok()).unwrap_or(76);
        if width == 0 {
            out.stdout.extend_from_slice(encoded.as_bytes());
            out.stdout.push(b'\n');
        } else {
            for chunk in encoded.as_bytes().chunks(width) {
                out.stdout.extend_from_slice(chunk);
                out.stdout.push(b'\n');
            }
        }
    }
    out
}

pub fn b64_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        s.push(B64[(n >> 18) as usize & 63] as char);
        s.push(B64[(n >> 12) as usize & 63] as char);
        s.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    s
}

fn b64_decode(data: &[u8]) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = vec![];
    for chunk in data.chunks(4) {
        if chunk.len() < 2 { return None; }
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        let mut n = 0u32;
        for i in 0..4 {
            let c = chunk.get(i).copied().unwrap_or(b'=');
            n = (n << 6) | if c == b'=' { 0 } else { value(c)? };
        }
        out.push((n >> 16) as u8);
        if pad < 2 && chunk.len() > 2 { out.push((n >> 8) as u8); }
        if pad < 1 && chunk.len() > 3 { out.push(n as u8); }
    }
    Some(out)
}

// -------------------------------------------------------------------- md5

/// RFC 1321, enough for `md5sum`. Not a security primitive and not used as one.
pub fn md5(data: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64)
        .map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32)
        .collect();

    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    for block in msg.chunks(64) {
        let m: Vec<u32> = block
            .chunks(4)
            .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
            .collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let sum = a.wrapping_add(f).wrapping_add(k[i]).wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(S[i]));
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

pub fn md5sum(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let files = a.positional();
    for (name, data) in inputs("md5sum", &files, ctx, &mut out) {
        let hex: String = md5(&data).iter().map(|b| format!("{:02x}", b)).collect();
        out.stdout.extend_from_slice(format!("{}  {}\n", hex, name).as_bytes());
    }
    out
}

// ------------------------------------------------------------------- sha256

pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 { h[i] = h[i].wrapping_add(v[i]); }
    }
    let mut out = [0u8; 32];
    for i in 0..8 { out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes()); }
    out
}

pub fn sha256sum(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let files = parse_args(args, "").positional();
    for (name, data) in inputs("sha256sum", &files, ctx, &mut out) {
        let hex: String = sha256(&data).iter().map(|b| format!("{:02x}", b)).collect();
        out.stdout.extend_from_slice(format!("{}  {}\n", hex, name).as_bytes());
    }
    out
}

// -------------------------------------------------------- text and columns

pub fn fold(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "w");
    let width: usize = a.val('w').and_then(|v| v.parse().ok()).unwrap_or(80).max(1);
    let at_spaces = a.has('s');
    for (_, data) in inputs("fold", &a.positional(), ctx, &mut out) {
        for line in lines_of(&data) {
            let chars: Vec<char> = line.chars().collect();
            if chars.is_empty() { out.stdout.push(b'\n'); continue; }
            let mut start = 0;
            while start < chars.len() {
                let mut end = (start + width).min(chars.len());
                if at_spaces && end < chars.len() {
                    // Break at the last blank in the window, if there is one.
                    if let Some(found) = chars[start..end].iter().rposition(|c| *c == ' ' || *c == '\t') {
                        if found > 0 { end = start + found + 1; }
                    }
                }
                let piece: String = chars[start..end].iter().collect();
                out.stdout.extend_from_slice(piece.as_bytes());
                out.stdout.push(b'\n');
                start = end;
            }
        }
    }
    out
}

pub fn expand(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "t");
    let stop: usize = a.val('t').and_then(|v| v.parse().ok()).unwrap_or(8).max(1);
    for (_, data) in inputs("expand", &a.positional(), ctx, &mut out) {
        for line in lines_of(&data) {
            let mut col = 0usize;
            let mut s = String::new();
            for c in line.chars() {
                if c == '\t' {
                    let pad = stop - (col % stop);
                    s.push_str(&" ".repeat(pad));
                    col += pad;
                } else {
                    s.push(c);
                    col += 1;
                }
            }
            s.push('\n');
            out.stdout.extend_from_slice(s.as_bytes());
        }
    }
    out
}

pub fn column(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "s");
    let table = a.has('t');
    let sep = a.val('s').map(|s| s.to_string());
    for (_, data) in inputs("column", &a.positional(), ctx, &mut out) {
        let lines = lines_of(&data);
        if !table {
            out.stdout.extend_from_slice(join_lines(&lines).as_bytes());
            continue;
        }
        let rows: Vec<Vec<String>> = lines
            .iter()
            .map(|l| match &sep {
                Some(s) => l.split(s.as_str()).map(|p| p.to_string()).collect(),
                None => l.split_whitespace().map(|p| p.to_string()).collect(),
            })
            .collect();
        let columns = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut widths = vec![0usize; columns];
        for r in &rows {
            for (i, cell) in r.iter().enumerate() {
                widths[i] = widths[i].max(cell.chars().count());
            }
        }
        for r in &rows {
            let mut line = String::new();
            for (i, cell) in r.iter().enumerate() {
                if i + 1 == r.len() {
                    line.push_str(cell);
                } else {
                    let _ = write!(line, "{:width$}  ", cell, width = widths[i]);
                }
            }
            line.push('\n');
            out.stdout.extend_from_slice(line.trim_end_matches(' ').as_bytes());
        }
    }
    out
}

pub fn strings(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "n");
    let min: usize = a.val('n').and_then(|v| v.parse().ok()).unwrap_or(4).max(1);
    for (_, data) in inputs("strings", &a.positional(), ctx, &mut out) {
        let mut run = Vec::new();
        for &b in data.iter().chain(std::iter::once(&0u8)) {
            if (0x20..0x7f).contains(&b) || b == b'\t' {
                run.push(b);
            } else {
                if run.len() >= min {
                    out.stdout.extend_from_slice(&run);
                    out.stdout.push(b'\n');
                }
                run.clear();
            }
        }
    }
    out
}

pub fn od(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "tN");
    // `-c` and `-t c` print characters; everything else is hex bytes, which
    // is what `-A x -t x1` and the common `-x` spellings want.
    let chars = a.has('c') || a.val('t').is_some_and(|t| t.starts_with('c'));
    let data: Vec<u8> = inputs("od", &a.positional(), ctx, &mut out)
        .into_iter().flat_map(|(_, d)| d).collect();
    for (i, chunk) in data.chunks(16).enumerate() {
        let mut line = format!("{:07o}", i * 16);
        for b in chunk {
            if chars {
                let rendered = match b {
                    b'\n' => "  \\n".to_string(),
                    b'\t' => "  \\t".to_string(),
                    b'\r' => "  \\r".to_string(),
                    0 => "  \\0".to_string(),
                    0x20..=0x7e => format!("   {}", *b as char),
                    other => format!(" {:03o}", other),
                };
                line.push_str(&rendered);
            } else {
                let _ = write!(line, " {:02x}", b);
            }
        }
        line.push('\n');
        out.stdout.extend_from_slice(line.as_bytes());
    }
    out.stdout.extend_from_slice(format!("{:07o}\n", data.len()).as_bytes());
    out
}

// --------------------------------------------------------- set-like tools

pub fn comm(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let files = a.positional();
    if files.len() < 2 {
        out.err("comm", "missing operand");
        out.code = 1;
        return out;
    }
    let read = |f: &str, out: &mut CmdOut| -> Vec<String> {
        inputs("comm", &[f.to_string()], ctx, out).into_iter().flat_map(|(_, d)| lines_of(&d)).collect()
    };
    let left = read(&files[0], &mut out);
    let right = read(&files[1], &mut out);
    let (s1, s2, s3) = (!a.has('1'), !a.has('2'), !a.has('3'));

    let (mut i, mut j) = (0usize, 0usize);
    let emit = |col: usize, text: &str, out: &mut CmdOut| {
        let indent = match col {
            1 => 0,
            2 => usize::from(s1),
            _ => usize::from(s1) + usize::from(s2),
        };
        out.stdout.extend_from_slice("\t".repeat(indent).as_bytes());
        out.stdout.extend_from_slice(text.as_bytes());
        out.stdout.push(b'\n');
    };
    while i < left.len() || j < right.len() {
        match (left.get(i), right.get(j)) {
            (Some(l), Some(r)) if l == r => {
                if s3 { emit(3, l, &mut out); }
                i += 1; j += 1;
            }
            (Some(l), Some(r)) if l < r => { if s1 { emit(1, l, &mut out); } i += 1; }
            (Some(_), Some(r)) => { if s2 { emit(2, r, &mut out); } j += 1; }
            (Some(l), None) => { if s1 { emit(1, l, &mut out); } i += 1; }
            (None, Some(r)) => { if s2 { emit(2, r, &mut out); } j += 1; }
            (None, None) => break,
        }
    }
    out
}

pub fn join(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "t12j");
    let files = a.positional();
    if files.len() < 2 {
        out.err("join", "missing operand");
        out.code = 1;
        return out;
    }
    let sep = a.val('t').map(|s| s.to_string());
    let field = |which: char| -> usize {
        a.val(which)
            .or_else(|| a.val('j'))
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1)
            - 1
    };
    let (k1, k2) = (field('1'), field('2'));
    let cut = |l: &str| -> Vec<String> {
        match &sep {
            Some(s) => l.split(s.as_str()).map(|p| p.to_string()).collect(),
            None => l.split_whitespace().map(|p| p.to_string()).collect(),
        }
    };
    let read = |f: &str, out: &mut CmdOut| -> Vec<String> {
        inputs("join", &[f.to_string()], ctx, out).into_iter().flat_map(|(_, d)| lines_of(&d)).collect()
    };
    let left = read(&files[0], &mut out);
    let right = read(&files[1], &mut out);
    let joiner = sep.clone().unwrap_or_else(|| " ".into());

    for l in &left {
        let lf = cut(l);
        let key = match lf.get(k1) { Some(k) => k.clone(), None => continue };
        for r in &right {
            let rf = cut(r);
            if rf.get(k2) != Some(&key) { continue; }
            let mut row = vec![key.clone()];
            row.extend(lf.iter().enumerate().filter(|(i, _)| *i != k1).map(|(_, v)| v.clone()));
            row.extend(rf.iter().enumerate().filter(|(i, _)| *i != k2).map(|(_, v)| v.clone()));
            out.stdout.extend_from_slice(row.join(&joiner).as_bytes());
            out.stdout.push(b'\n');
        }
    }
    out
}

// ----------------------------------------------------------------- expr

/// `expr` as POSIX defines it: one expression, result on stdout, exit 1 when
/// the result is zero or empty. The grammar is small enough to parse here.
pub fn expr(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let mut p = ExprParser { toks: args.to_vec(), i: 0 };
    match p.parse() {
        Ok(v) if p.i == p.toks.len() => {
            let text = v.text();
            out.stdout.extend_from_slice(text.as_bytes());
            out.stdout.push(b'\n');
            out.code = if text.is_empty() || text == "0" { 1 } else { 0 };
        }
        Ok(_) => { out.err("expr", "syntax error"); out.code = 2; }
        Err(e) => { out.err("expr", &e); out.code = 2; }
    }
    out
}

enum EVal { N(i64), S(String) }

impl EVal {
    fn num(&self) -> Result<i64, String> {
        match self {
            EVal::N(n) => Ok(*n),
            EVal::S(s) => s.trim().parse().map_err(|_| "non-integer argument".to_string()),
        }
    }
    fn text(&self) -> String {
        match self { EVal::N(n) => n.to_string(), EVal::S(s) => s.clone() }
    }
    fn truthy(&self) -> bool {
        match self { EVal::N(n) => *n != 0, EVal::S(s) => !s.is_empty() && s != "0" }
    }
}

struct ExprParser { toks: Vec<String>, i: usize }

impl ExprParser {
    fn peek(&self) -> Option<&str> { self.toks.get(self.i).map(|s| s.as_str()) }
    fn eat(&mut self, t: &str) -> bool {
        if self.peek() == Some(t) { self.i += 1; true } else { false }
    }
    fn parse(&mut self) -> Result<EVal, String> { self.or() }

    fn or(&mut self) -> Result<EVal, String> {
        let mut left = self.and()?;
        while self.eat("|") {
            let right = self.and()?;
            if !left.truthy() { left = right; }
        }
        Ok(left)
    }
    fn and(&mut self) -> Result<EVal, String> {
        let mut left = self.compare()?;
        while self.eat("&") {
            let right = self.compare()?;
            if !left.truthy() || !right.truthy() { left = EVal::N(0); }
        }
        Ok(left)
    }
    fn compare(&mut self) -> Result<EVal, String> {
        let left = self.additive()?;
        const OPS: &[&str] = &["=", "!=", "<", "<=", ">", ">="];
        if let Some(op) = self.peek() {
            if OPS.contains(&op) {
                let op = op.to_string();
                self.i += 1;
                let right = self.additive()?;
                // Numeric when both sides are integers, string otherwise.
                let truth = match (left.num(), right.num()) {
                    (Ok(a), Ok(b)) => match op.as_str() {
                        "=" => a == b, "!=" => a != b, "<" => a < b,
                        "<=" => a <= b, ">" => a > b, _ => a >= b,
                    },
                    _ => {
                        let (a, b) = (left.text(), right.text());
                        match op.as_str() {
                            "=" => a == b, "!=" => a != b, "<" => a < b,
                            "<=" => a <= b, ">" => a > b, _ => a >= b,
                        }
                    }
                };
                return Ok(EVal::N(i64::from(truth)));
            }
        }
        Ok(left)
    }
    fn additive(&mut self) -> Result<EVal, String> {
        let mut left = self.multiplicative()?;
        loop {
            let op = match self.peek() { Some(o @ ("+" | "-")) => o.to_string(), _ => break };
            self.i += 1;
            let right = self.multiplicative()?;
            let (a, b) = (left.num()?, right.num()?);
            left = EVal::N(if op == "+" { a + b } else { a - b });
        }
        Ok(left)
    }
    fn multiplicative(&mut self) -> Result<EVal, String> {
        let mut left = self.primary()?;
        loop {
            let op = match self.peek() { Some(o @ ("*" | "/" | "%")) => o.to_string(), _ => break };
            self.i += 1;
            let right = self.primary()?;
            let (a, b) = (left.num()?, right.num()?);
            if b == 0 && op != "*" { return Err("division by zero".into()); }
            left = EVal::N(match op.as_str() { "*" => a * b, "/" => a / b, _ => a % b });
        }
        Ok(left)
    }
    fn primary(&mut self) -> Result<EVal, String> {
        match self.peek() {
            Some("(") => {
                self.i += 1;
                let v = self.or()?;
                if !self.eat(")") { return Err("expected )".into()); }
                Ok(v)
            }
            Some("length") => { self.i += 1; let v = self.primary()?; Ok(EVal::N(v.text().chars().count() as i64)) }
            Some("substr") => {
                self.i += 1;
                let s = self.primary()?.text();
                let from = self.primary()?.num()?.max(1) as usize;
                let len = self.primary()?.num()?.max(0) as usize;
                Ok(EVal::S(s.chars().skip(from - 1).take(len).collect()))
            }
            Some("index") => {
                self.i += 1;
                let s = self.primary()?.text();
                let set = self.primary()?.text();
                let hit = s.chars().position(|c| set.contains(c));
                Ok(EVal::N(hit.map_or(0, |p| p as i64 + 1)))
            }
            Some(t) => {
                let t = t.to_string();
                self.i += 1;
                match t.parse::<i64>() { Ok(n) => Ok(EVal::N(n)), Err(_) => Ok(EVal::S(t)) }
            }
            None => Err("syntax error".into()),
        }
    }
}

// ------------------------------------------------------------------- diff

/// Unified diff, and the default normal format. The hunk finder is a plain
/// longest-common-subsequence table, which is fine at the sizes a shell sees.
pub fn diff(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "U");
    let files = a.positional();
    if files.len() < 2 {
        out.err("diff", "missing operand");
        out.code = 2;
        return out;
    }
    let read = |f: &str, out: &mut CmdOut| -> Vec<String> {
        inputs("diff", &[f.to_string()], ctx, out).into_iter().flat_map(|(_, d)| lines_of(&d)).collect()
    };
    let left = read(&files[0], &mut out);
    let right = read(&files[1], &mut out);
    if out.code != 0 { return out; }

    let unified = a.has('u') || a.has('U') || a.has_long("unified");
    let ops = lcs_diff(&left, &right);
    if ops.iter().all(|o| matches!(o, Edit::Keep(_))) { return out; }
    out.code = 1;

    if unified {
        out.stdout.extend_from_slice(format!("--- {}\n+++ {}\n", files[0], files[1]).as_bytes());
        out.stdout.extend_from_slice(
            format!("@@ -1,{} +1,{} @@\n", left.len(), right.len()).as_bytes());
        for op in &ops {
            let line = match op {
                Edit::Keep(s) => format!(" {}", s),
                Edit::Remove(s) => format!("-{}", s),
                Edit::Add(s) => format!("+{}", s),
            };
            out.stdout.extend_from_slice(line.as_bytes());
            out.stdout.push(b'\n');
        }
    } else {
        normal_format(&ops, &mut out);
    }
    out
}

/// GNU's default format: a hunk header like `3a4`, `2d1` or `4,5c4`, then the
/// lines. The headers carry the line numbers, which is the whole reason a
/// bare list of `<` and `>` lines is not a diff anyone can apply.
fn normal_format(ops: &[Edit], out: &mut CmdOut) {
    let mut i = 0usize;
    // Positions in the original and the new file, 1-based at emit time.
    let (mut a_line, mut b_line) = (0usize, 0usize);

    while i < ops.len() {
        if let Edit::Keep(_) = ops[i] {
            a_line += 1;
            b_line += 1;
            i += 1;
            continue;
        }
        let start = i;
        while i < ops.len() && !matches!(ops[i], Edit::Keep(_)) { i += 1; }
        let hunk = &ops[start..i];
        let removed: Vec<&String> = hunk.iter().filter_map(|o| match o { Edit::Remove(s) => Some(s), _ => None }).collect();
        let added: Vec<&String> = hunk.iter().filter_map(|o| match o { Edit::Add(s) => Some(s), _ => None }).collect();

        let range = |from: usize, count: usize| -> String {
            if count == 1 { from.to_string() } else { format!("{},{}", from, from + count - 1) }
        };

        let header = match (removed.len(), added.len()) {
            (0, n) => format!("{}a{}", a_line, range(b_line + 1, n)),
            (n, 0) => format!("{}d{}", range(a_line + 1, n), b_line),
            (n, m) => format!("{}c{}", range(a_line + 1, n), range(b_line + 1, m)),
        };
        out.stdout.extend_from_slice(header.as_bytes());
        out.stdout.push(b'\n');
        for line in &removed {
            out.stdout.extend_from_slice(format!("< {}\n", line).as_bytes());
        }
        if !removed.is_empty() && !added.is_empty() {
            out.stdout.extend_from_slice(b"---\n");
        }
        for line in &added {
            out.stdout.extend_from_slice(format!("> {}\n", line).as_bytes());
        }
        a_line += removed.len();
        b_line += added.len();
    }
}

enum Edit { Keep(String), Remove(String), Add(String) }

fn lcs_diff(a: &[String], b: &[String]) -> Vec<Edit> {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0usize, 0usize);
    let mut ops = vec![];
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(Edit::Keep(a[i].clone()));
            i += 1; j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            ops.push(Edit::Remove(a[i].clone()));
            i += 1;
        } else {
            ops.push(Edit::Add(b[j].clone()));
            j += 1;
        }
    }
    while i < n { ops.push(Edit::Remove(a[i].clone())); i += 1; }
    while j < m { ops.push(Edit::Add(b[j].clone())); j += 1; }
    ops
}

// --------------------------------------------------------- files and misc

pub fn split(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "ld");
    let per: usize = a.val('l').and_then(|v| v.parse().ok()).unwrap_or(1000).max(1);
    let pos = a.positional();
    let prefix = pos.get(1).cloned().unwrap_or_else(|| "x".into());
    let files: Vec<String> = pos.iter().take(1).cloned().collect();
    let lines: Vec<String> = inputs("split", &files, ctx, &mut out)
        .into_iter().flat_map(|(_, d)| lines_of(&d)).collect();

    for (n, chunk) in lines.chunks(per).enumerate() {
        // `aa`, `ab`, … as GNU does, which keeps `cat x*` in order.
        let name = format!("{}{}{}", prefix,
            (b'a' + (n / 26) as u8) as char, (b'a' + (n % 26) as u8) as char);
        let path = fs::normalize(ctx.cwd, &name);
        if let Err(e) = ctx.fs.write(&path, join_lines(chunk).as_bytes(), false) {
            out.err("split", &format!("{}: {}", name, e));
            out.code = 1;
        }
    }
    out
}

pub fn chmod(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let pos = parse_args(args, "").positional();
    if pos.len() < 2 {
        out.err("chmod", "missing operand");
        out.code = 1;
        return out;
    }
    // The filesystem has no permission bits, so this checks the file exists
    // and otherwise does nothing. Erroring instead would break every script
    // that chmods something it is about to read, which all of them do.
    for f in &pos[1..] {
        let p = fs::normalize(ctx.cwd, f);
        if ctx.fs.read(&p).is_err() && !ctx.fs.is_dir(&p) {
            out.err("chmod", &format!("cannot access '{}': No such file or directory", f));
            out.code = 1;
        }
    }
    out
}

pub fn ln(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let pos = parse_args(args, "").positional();
    if pos.len() < 2 {
        out.err("ln", "missing file operand");
        out.code = 1;
        return out;
    }
    // Copied rather than linked: there are no inodes here, so a link is a
    // second name for the same bytes at the moment it is made.
    let from = fs::normalize(ctx.cwd, &pos[0]);
    let to = fs::normalize(ctx.cwd, &pos[1]);
    match ctx.fs.read(&from) {
        Ok(data) => {
            let data = data.to_vec();
            if let Err(e) = ctx.fs.write(&to, &data, false) {
                out.err("ln", &format!("{}: {}", pos[1], e));
                out.code = 1;
            }
        }
        Err(_) => {
            out.err("ln", &format!("failed to access '{}': No such file or directory", pos[0]));
            out.code = 1;
        }
    }
    out
}

pub fn readlink(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    // No symlinks, so `-f` is the useful half: canonicalise a path.
    for p in a.positional() {
        if a.has('f') || a.has_long("canonicalize") {
            out.stdout.extend_from_slice(fs::normalize(ctx.cwd, &p).as_bytes());
            out.stdout.push(b'\n');
        } else {
            out.code = 1;
        }
    }
    out
}

pub fn mktemp(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let pos = a.positional();
    let template = pos.first().cloned().unwrap_or_else(|| "/tmp/tmp.XXXXXX".into());
    // Counter-based rather than random: there is no entropy source in wasm,
    // and a name only has to be unused, not unguessable.
    let mut n = 0u32;
    let path = loop {
        let suffix = format!("{:06}", n);
        let name = if template.contains("XXXXXX") {
            template.replacen("XXXXXX", &suffix, 1)
        } else {
            format!("{}.{}", template, suffix)
        };
        let full = fs::normalize(ctx.cwd, &name);
        if ctx.fs.read(&full).is_err() && !ctx.fs.is_dir(&full) { break full; }
        n += 1;
        if n > 999_999 {
            out.err("mktemp", "failed to create file");
            out.code = 1;
            return out;
        }
    };
    let result = if a.has('d') { ctx.fs.mkdir(&path, true) } else { ctx.fs.write(&path, b"", false) };
    match result {
        Ok(()) => {
            out.stdout.extend_from_slice(path.as_bytes());
            out.stdout.push(b'\n');
        }
        Err(e) => { out.err("mktemp", &e); out.code = 1; }
    }
    out
}

pub fn yes(args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let text = if args.is_empty() { "y".to_string() } else { args.join(" ") };
    // Real `yes` is infinite and relies on a pipe closing. Nothing here can
    // close one, so it is bounded — enough to feed any `head -n`.
    for _ in 0..10_000 {
        out.stdout.extend_from_slice(text.as_bytes());
        out.stdout.push(b'\n');
    }
    out
}

pub fn clear(_args: &[String], _ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    out.stdout.extend_from_slice(b"\x1b[H\x1b[2J");
    out
}

pub fn true_cmd(_args: &[String], _ctx: &mut Ctx) -> CmdOut { CmdOut::default() }

pub fn false_cmd(_args: &[String], _ctx: &mut Ctx) -> CmdOut {
    CmdOut { code: 1, ..Default::default() }
}

pub fn timeout(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let pos = parse_args(args, "").positional();
    // Nothing here blocks on anything but its own work, and the interpreter
    // already bounds that, so the duration is accepted and the command runs.
    if pos.len() < 2 {
        let mut out = CmdOut::default();
        out.err("timeout", "missing operand");
        out.code = 125;
        return out;
    }
    match crate::commands::run(&pos[1], &pos[2..], ctx) {
        Some(o) => o,
        None => {
            let mut out = CmdOut::default();
            out.err("timeout", &format!("{}: command not found", pos[1]));
            out.code = 127;
            out
        }
    }
}

pub fn file(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    for name in parse_args(args, "").positional() {
        let p = fs::normalize(ctx.cwd, &name);
        let kind = if ctx.fs.is_dir(&p) {
            "directory".to_string()
        } else {
            match ctx.fs.read(&p) {
                Err(_) => {
                    out.stdout.extend_from_slice(
                        format!("{}: cannot open (No such file or directory)\n", name).as_bytes());
                    out.code = 1;
                    continue;
                }
                Ok(d) if d.is_empty() => "empty".to_string(),
                Ok(d) if std::str::from_utf8(d).is_ok() => {
                    if d.starts_with(b"#!") { "a shell script, ASCII text executable".into() }
                    else { "ASCII text".into() }
                }
                Ok(_) => "data".to_string(),
            }
        };
        out.stdout.extend_from_slice(format!("{}: {}\n", name, kind).as_bytes());
    }
    out
}
