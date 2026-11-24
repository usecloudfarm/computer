//! A useful subset of awk.
//!
//! Patterns and actions, `BEGIN`/`END`, fields, the usual variables
//! (`NR`, `NF`, `FS`, `OFS`, `ORS`, `FILENAME`), arrays, `if`/`while`/`for`,
//! `print`/`printf`, and the string and math builtins. Enough for what a
//! model writes at a shell: summing a column, reformatting a line, counting
//! by key.
//!
//! Not here: user-defined functions, `getline`, output redirection from
//! inside a rule, and `RS` other than newline. Each is a parser change rather
//! than a rethink, and none of them showed up in the scripts this had to run.

use std::collections::HashMap;

use crate::commands::{CmdOut, Ctx};

// ------------------------------------------------------------------- values

/// Awk's one type: a string that is also a number when it looks like one.
///
/// `Str` and `StrNum` differ only in comparison, and the difference is
/// POSIX's: a string *constant* is always a string, so `"10" < "9"` is true,
/// while a field that looks like a number compares as one, so `$1 < $2` on
/// `10` and `9` is false. Collapsing the two gets one of those wrong.
#[derive(Clone, Debug)]
pub enum Value {
    /// A string constant, or the result of a string operation.
    Str(String),
    /// Text from input — a field, a `split` part, a `-v` assignment — which
    /// compares numerically when it looks numeric.
    StrNum(String),
    Num(f64),
    /// Unset. Numerically zero, and the empty string, but compares as either.
    Uninit,
}

impl Value {
    fn num(&self) -> f64 {
        match self {
            Value::Num(n) => *n,
            Value::Uninit => 0.0,
            Value::Str(s) | Value::StrNum(s) => str_to_num(s),
        }
    }
    fn text(&self) -> String {
        match self {
            Value::Str(s) | Value::StrNum(s) => s.clone(),
            Value::Uninit => String::new(),
            Value::Num(n) => fmt_num(*n),
        }
    }
    fn truthy(&self) -> bool {
        match self {
            Value::Num(n) => *n != 0.0,
            Value::Uninit => false,
            // A constant is true when non-empty, even if it reads as zero:
            // `if ("0")` is true. A numeric string compares as its number.
            Value::Str(s) => !s.is_empty(),
            Value::StrNum(s) => {
                if looks_numeric(s) { str_to_num(s) != 0.0 } else { !s.is_empty() }
            }
        }
    }
    /// True when this side is willing to be compared as a number.
    fn numeric(&self) -> bool {
        match self {
            Value::Num(_) | Value::Uninit => true,
            Value::StrNum(s) => looks_numeric(s),
            Value::Str(_) => false,
        }
    }
}

fn looks_numeric(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.parse::<f64>().is_ok()
}

fn str_to_num(s: &str) -> f64 {
    // awk takes the longest numeric prefix: "12abc" is 12.
    let t = s.trim_start();
    let mut end = 0;
    let bytes = t.as_bytes();
    let mut seen_digit = false;
    let mut seen_dot = false;
    let mut seen_e = false;
    for (i, &b) in bytes.iter().enumerate() {
        let ok = match b {
            b'0'..=b'9' => { seen_digit = true; true }
            b'+' | b'-' => i == 0 || (seen_e && matches!(bytes[i - 1], b'e' | b'E')),
            b'.' if !seen_dot && !seen_e => { seen_dot = true; true }
            b'e' | b'E' if seen_digit && !seen_e => { seen_e = true; true }
            _ => false,
        };
        if !ok { break; }
        end = i + 1;
    }
    t[..end].parse::<f64>().unwrap_or(0.0)
}

fn fmt_num(n: f64) -> String {
    if n.is_nan() { return "nan".into(); }
    if n.is_infinite() { return if n > 0.0 { "inf".into() } else { "-inf".into() }; }
    if n == n.trunc() && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        // awk's OFMT, %.6g.
        let s = format!("{:.6}", n);
        let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
        if s.is_empty() { "0".into() } else { s }
    }
}

// -------------------------------------------------------------------- lexer

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Regex(String),
    Ident(String),
    Func(String),
    Kw(&'static str),
    Op(&'static str),
    LBrace,
    RBrace,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Semi,
    Comma,
    Newline,
    Eof,
}

const KEYWORDS: &[&str] = &[
    "BEGIN", "END", "if", "else", "while", "for", "do", "break", "continue",
    "next", "exit", "print", "printf", "in", "delete", "getline",
];

const BUILTINS: &[&str] = &[
    "length", "substr", "index", "split", "sub", "gsub", "match", "sprintf",
    "sin", "cos", "atan2", "exp", "log", "sqrt", "int", "rand", "srand",
    "tolower", "toupper", "system", "close",
];

struct Lexer<'a> {
    src: &'a [u8],
    i: usize,
    toks: Vec<Tok>,
}

impl<'a> Lexer<'a> {
    /// A `/` starts a regex only where a value is expected; after a value it
    /// is division. Tracking the previous token is the whole of the rule.
    fn regex_ok(&self) -> bool {
        match self.toks.last() {
            None | Some(Tok::Newline) | Some(Tok::Semi) | Some(Tok::LBrace) | Some(Tok::RBrace)
            | Some(Tok::LParen) | Some(Tok::LBracket) | Some(Tok::Comma) | Some(Tok::Op(_))
            | Some(Tok::Kw(_)) => true,
            _ => false,
        }
    }

    fn lex(mut self) -> Result<Vec<Tok>, String> {
        while self.i < self.src.len() {
            let c = self.src[self.i];
            match c {
                b' ' | b'\t' | b'\r' => self.i += 1,
                b'\\' if self.src.get(self.i + 1) == Some(&b'\n') => self.i += 2,
                b'\n' => { self.toks.push(Tok::Newline); self.i += 1; }
                b'#' => { while self.i < self.src.len() && self.src[self.i] != b'\n' { self.i += 1; } }
                b'"' => { let s = self.string()?; self.toks.push(Tok::Str(s)); }
                b'/' if self.regex_ok() => { let r = self.regex()?; self.toks.push(Tok::Regex(r)); }
                b'0'..=b'9' => self.number(),
                b'.' if self.src.get(self.i + 1).is_some_and(|d| d.is_ascii_digit()) => self.number(),
                b'{' => { self.toks.push(Tok::LBrace); self.i += 1; }
                b'}' => { self.toks.push(Tok::RBrace); self.i += 1; }
                b'(' => { self.toks.push(Tok::LParen); self.i += 1; }
                b')' => { self.toks.push(Tok::RParen); self.i += 1; }
                b'[' => { self.toks.push(Tok::LBracket); self.i += 1; }
                b']' => { self.toks.push(Tok::RBracket); self.i += 1; }
                b';' => { self.toks.push(Tok::Semi); self.i += 1; }
                b',' => { self.toks.push(Tok::Comma); self.i += 1; }
                _ if c.is_ascii_alphabetic() || c == b'_' => self.word(),
                _ => self.operator()?,
            }
        }
        self.toks.push(Tok::Eof);
        Ok(self.toks)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut s = String::new();
        while self.i < self.src.len() {
            match self.src[self.i] {
                b'"' => { self.i += 1; return Ok(s); }
                b'\\' => {
                    self.i += 1;
                    let e = *self.src.get(self.i).ok_or("unterminated string")?;
                    s.push(match e {
                        b'n' => '\n', b't' => '\t', b'r' => '\r', b'\\' => '\\',
                        b'"' => '"', b'/' => '/', b'a' => '\x07', b'b' => '\x08',
                        b'f' => '\x0c', b'v' => '\x0b', b'0' => '\0',
                        other => other as char,
                    });
                    self.i += 1;
                }
                b => { 
                    // Multi-byte UTF-8 passes through intact.
                    let start = self.i;
                    let len = utf8_len(b);
                    self.i += len;
                    s.push_str(&String::from_utf8_lossy(&self.src[start..self.i.min(self.src.len())]));
                }
            }
        }
        Err("unterminated string".into())
    }

    fn regex(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut s = String::new();
        while self.i < self.src.len() {
            match self.src[self.i] {
                b'/' => { self.i += 1; return Ok(s); }
                b'\\' if self.src.get(self.i + 1) == Some(&b'/') => { s.push('/'); self.i += 2; }
                b'\\' => { s.push('\\'); self.i += 1; if self.i < self.src.len() { s.push(self.src[self.i] as char); self.i += 1; } }
                _ => {
                    let start = self.i;
                    self.i += utf8_len(self.src[self.i]);
                    s.push_str(&String::from_utf8_lossy(&self.src[start..self.i.min(self.src.len())]));
                }
            }
        }
        Err("unterminated regex".into())
    }

    fn number(&mut self) {
        let start = self.i;
        while self.i < self.src.len()
            && (self.src[self.i].is_ascii_digit() || self.src[self.i] == b'.'
                || ((self.src[self.i] | 32) == b'e' && self.i > start)
                || ((self.src[self.i] == b'+' || self.src[self.i] == b'-')
                    && self.i > start && (self.src[self.i - 1] | 32) == b'e'))
        {
            self.i += 1;
        }
        let text = String::from_utf8_lossy(&self.src[start..self.i]);
        self.toks.push(Tok::Num(text.parse().unwrap_or(0.0)));
    }

    fn word(&mut self) {
        let start = self.i;
        while self.i < self.src.len()
            && (self.src[self.i].is_ascii_alphanumeric() || self.src[self.i] == b'_')
        {
            self.i += 1;
        }
        let w = String::from_utf8_lossy(&self.src[start..self.i]).to_string();
        if let Some(k) = KEYWORDS.iter().find(|k| **k == w) {
            self.toks.push(Tok::Kw(k));
        } else if BUILTINS.contains(&w.as_str()) {
            self.toks.push(Tok::Func(w));
        } else {
            self.toks.push(Tok::Ident(w));
        }
    }

    fn operator(&mut self) -> Result<(), String> {
        const OPS3: &[&str] = &["**="];
        const OPS2: &[&str] = &[
            "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=",
            "/=", "%=", "^=", "!~", "**",
        ];
        const OPS1: &[&str] = &["+", "-", "*", "/", "%", "^", "<", ">", "=", "!", "~", "?", ":", "$", "|"];
        let rest = &self.src[self.i..];
        for set in [OPS3, OPS2, OPS1] {
            for op in set {
                if rest.starts_with(op.as_bytes()) {
                    self.toks.push(Tok::Op(op));
                    self.i += op.len();
                    return Ok(());
                }
            }
        }
        Err(format!("unexpected character '{}'", self.src[self.i] as char))
    }
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 { 1 } else if b >> 5 == 0b110 { 2 } else if b >> 4 == 0b1110 { 3 } else if b >> 3 == 0b11110 { 4 } else { 1 }
}

// --------------------------------------------------------------------- ast

#[derive(Clone, Debug)]
enum Expr {
    Num(f64),
    Str(String),
    Regex(String),
    Var(String),
    Field(Box<Expr>),
    Index(String, Vec<Expr>),
    Assign(Box<Expr>, &'static str, Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Unary(&'static str, Box<Expr>),
    Incr(Box<Expr>, &'static str, bool),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Match(Box<Expr>, Box<Expr>, bool),
    Concat(Box<Expr>, Box<Expr>),
    In(Vec<Expr>, String),
    Call(String, Vec<Expr>),
    Grouping(Vec<Expr>),
}

#[derive(Clone, Debug)]
enum Stmt {
    Expr(Expr),
    Print(Vec<Expr>),
    Printf(Vec<Expr>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    While(Expr, Box<Stmt>),
    DoWhile(Box<Stmt>, Expr),
    For(Option<Box<Stmt>>, Option<Expr>, Option<Box<Stmt>>, Box<Stmt>),
    ForIn(String, String, Box<Stmt>),
    Block(Vec<Stmt>),
    Next,
    Exit(Option<Expr>),
    Break,
    Continue,
    Delete(String, Vec<Expr>),
    Nop,
}

#[derive(Clone, Debug)]
enum Pattern {
    Begin,
    End,
    Always,
    Expr(Expr),
    Range(Expr, Expr),
}

#[derive(Clone, Debug)]
struct Rule {
    pattern: Pattern,
    action: Option<Stmt>,
    /// Live state for a range pattern: whether it is currently inside.
    active: bool,
}

// ------------------------------------------------------------------ parser

struct Parser {
    toks: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> &Tok { &self.toks[self.i] }
    fn next(&mut self) -> Tok { let t = self.toks[self.i].clone(); self.i += 1; t }
    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == t { self.i += 1; true } else { false }
    }
    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Tok::Newline | Tok::Semi) { self.i += 1; }
    }
    fn skip_terms(&mut self) {
        while matches!(self.peek(), Tok::Newline) { self.i += 1; }
    }
    fn expect(&mut self, t: Tok) -> Result<(), String> {
        if self.eat(&t) { Ok(()) } else { Err(format!("expected {:?}, found {:?}", t, self.peek())) }
    }

    fn program(&mut self) -> Result<Vec<Rule>, String> {
        let mut rules = vec![];
        self.skip_newlines();
        while !matches!(self.peek(), Tok::Eof) {
            rules.push(self.rule()?);
            self.skip_newlines();
        }
        Ok(rules)
    }

    fn rule(&mut self) -> Result<Rule, String> {
        let pattern = match self.peek() {
            Tok::Kw("BEGIN") => { self.i += 1; Pattern::Begin }
            Tok::Kw("END") => { self.i += 1; Pattern::End }
            Tok::LBrace => Pattern::Always,
            _ => {
                let first = self.expr()?;
                if self.eat(&Tok::Comma) {
                    self.skip_terms();
                    Pattern::Range(first, self.expr()?)
                } else {
                    Pattern::Expr(first)
                }
            }
        };
        let action = if matches!(self.peek(), Tok::LBrace) { Some(self.block()?) } else { None };
        Ok(Rule { pattern, action, active: false })
    }

    fn block(&mut self) -> Result<Stmt, String> {
        self.expect(Tok::LBrace)?;
        let mut body = vec![];
        self.skip_newlines();
        while !matches!(self.peek(), Tok::RBrace | Tok::Eof) {
            body.push(self.stmt()?);
            self.skip_newlines();
        }
        self.expect(Tok::RBrace)?;
        Ok(Stmt::Block(body))
    }

    fn stmt(&mut self) -> Result<Stmt, String> {
        let s = match self.peek().clone() {
            Tok::LBrace => return self.block(),
            Tok::Semi => { self.i += 1; return Ok(Stmt::Nop); }
            Tok::Kw("print") => { self.i += 1; Stmt::Print(self.print_args()?) }
            Tok::Kw("printf") => { self.i += 1; Stmt::Printf(self.print_args()?) }
            Tok::Kw("if") => {
                self.i += 1;
                self.expect(Tok::LParen)?;
                let cond = self.expr()?;
                self.expect(Tok::RParen)?;
                self.skip_terms();
                let then = Box::new(self.stmt()?);
                // `else` may sit after a newline, so look past one — but only
                // if it is really there, or the next rule gets eaten.
                let save = self.i;
                self.skip_newlines();
                let otherwise = if self.eat(&Tok::Kw("else")) {
                    self.skip_terms();
                    Some(Box::new(self.stmt()?))
                } else {
                    self.i = save;
                    None
                };
                Stmt::If(cond, then, otherwise)
            }
            Tok::Kw("while") => {
                self.i += 1;
                self.expect(Tok::LParen)?;
                let cond = self.expr()?;
                self.expect(Tok::RParen)?;
                self.skip_terms();
                Stmt::While(cond, Box::new(self.stmt()?))
            }
            Tok::Kw("do") => {
                self.i += 1;
                self.skip_terms();
                let body = Box::new(self.stmt()?);
                self.skip_newlines();
                self.expect(Tok::Kw("while"))?;
                self.expect(Tok::LParen)?;
                let cond = self.expr()?;
                self.expect(Tok::RParen)?;
                Stmt::DoWhile(body, cond)
            }
            Tok::Kw("for") => return self.for_stmt(),
            Tok::Kw("next") => { self.i += 1; Stmt::Next }
            Tok::Kw("break") => { self.i += 1; Stmt::Break }
            Tok::Kw("continue") => { self.i += 1; Stmt::Continue }
            Tok::Kw("exit") => {
                self.i += 1;
                let code = if self.ends_stmt() { None } else { Some(self.expr()?) };
                Stmt::Exit(code)
            }
            Tok::Kw("delete") => {
                self.i += 1;
                let name = match self.next() {
                    Tok::Ident(n) => n,
                    t => return Err(format!("delete expects a name, found {:?}", t)),
                };
                let mut subs = vec![];
                if self.eat(&Tok::LBracket) {
                    loop {
                        subs.push(self.expr()?);
                        if !self.eat(&Tok::Comma) { break; }
                    }
                    self.expect(Tok::RBracket)?;
                }
                Stmt::Delete(name, subs)
            }
            _ => Stmt::Expr(self.expr()?),
        };
        self.eat(&Tok::Semi);
        Ok(s)
    }

    fn for_stmt(&mut self) -> Result<Stmt, String> {
        self.i += 1;
        self.expect(Tok::LParen)?;
        // `for (k in arr)` — distinguished by looking ahead for `in`.
        if let (Tok::Ident(name), Tok::Kw("in")) = (self.peek().clone(), self.toks[self.i + 1].clone()) {
            self.i += 2;
            let array = match self.next() {
                Tok::Ident(a) => a,
                t => return Err(format!("for-in expects an array, found {:?}", t)),
            };
            self.expect(Tok::RParen)?;
            self.skip_terms();
            return Ok(Stmt::ForIn(name, array, Box::new(self.stmt()?)));
        }
        let init = if matches!(self.peek(), Tok::Semi) { None } else { Some(Box::new(Stmt::Expr(self.expr()?))) };
        self.expect(Tok::Semi)?;
        let cond = if matches!(self.peek(), Tok::Semi) { None } else { Some(self.expr()?) };
        self.expect(Tok::Semi)?;
        let step = if matches!(self.peek(), Tok::RParen) { None } else { Some(Box::new(Stmt::Expr(self.expr()?))) };
        self.expect(Tok::RParen)?;
        self.skip_terms();
        Ok(Stmt::For(init, cond, step, Box::new(self.stmt()?)))
    }

    fn ends_stmt(&self) -> bool {
        matches!(self.peek(), Tok::Semi | Tok::Newline | Tok::RBrace | Tok::Eof)
    }

    /// `print` takes a bare list; `>` after it is redirection in real awk, and
    /// is treated as comparison here, which is why output redirection is not
    /// supported rather than silently wrong.
    fn print_args(&mut self) -> Result<Vec<Expr>, String> {
        if self.ends_stmt() { return Ok(vec![]); }
        let mut args = vec![self.expr()?];
        while self.eat(&Tok::Comma) {
            self.skip_terms();
            args.push(self.expr()?);
        }
        // `print (a, b)` parses as one grouping; flatten it.
        if args.len() == 1 {
            if let Expr::Grouping(inner) = &args[0] {
                if inner.len() > 1 { return Ok(inner.clone()); }
            }
        }
        Ok(args)
    }
}

// Expression parsing, by precedence. Lowest first.
impl Parser {
    fn expr(&mut self) -> Result<Expr, String> { self.assignment() }

    fn assignment(&mut self) -> Result<Expr, String> {
        let left = self.ternary()?;
        const OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "^=", "**="];
        if let Tok::Op(op) = self.peek() {
            if OPS.contains(op) {
                let op = *op;
                if !matches!(left, Expr::Var(_) | Expr::Field(_) | Expr::Index(..)) {
                    return Err("assignment to something that is not a variable".into());
                }
                self.i += 1;
                self.skip_terms();
                let value = self.assignment()?;
                return Ok(Expr::Assign(Box::new(left), op, Box::new(value)));
            }
        }
        Ok(left)
    }

    fn ternary(&mut self) -> Result<Expr, String> {
        let cond = self.or()?;
        if self.eat(&Tok::Op("?")) {
            self.skip_terms();
            let then = self.ternary()?;
            self.expect(Tok::Op(":"))?;
            self.skip_terms();
            let otherwise = self.ternary()?;
            return Ok(Expr::Ternary(Box::new(cond), Box::new(then), Box::new(otherwise)));
        }
        Ok(cond)
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut left = self.and()?;
        while self.eat(&Tok::Op("||")) {
            self.skip_terms();
            left = Expr::Binary("||", Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut left = self.in_expr()?;
        while self.eat(&Tok::Op("&&")) {
            self.skip_terms();
            left = Expr::Binary("&&", Box::new(left), Box::new(self.in_expr()?));
        }
        Ok(left)
    }

    fn in_expr(&mut self) -> Result<Expr, String> {
        let left = self.matching()?;
        if self.eat(&Tok::Kw("in")) {
            let array = match self.next() {
                Tok::Ident(a) => a,
                t => return Err(format!("`in` expects an array, found {:?}", t)),
            };
            return Ok(Expr::In(vec![left], array));
        }
        Ok(left)
    }

    fn matching(&mut self) -> Result<Expr, String> {
        let mut left = self.comparison()?;
        loop {
            let negated = match self.peek() {
                Tok::Op("~") => false,
                Tok::Op("!~") => true,
                _ => break,
            };
            self.i += 1;
            let right = self.comparison()?;
            left = Expr::Match(Box::new(left), Box::new(right), negated);
        }
        Ok(left)
    }

    fn comparison(&mut self) -> Result<Expr, String> {
        let left = self.concat()?;
        const OPS: &[&str] = &["<", "<=", ">", ">=", "==", "!="];
        if let Tok::Op(op) = self.peek() {
            if OPS.contains(op) {
                let op = *op;
                self.i += 1;
                // Non-associative in awk, so this does not loop.
                return Ok(Expr::Binary(op, Box::new(left), Box::new(self.concat()?)));
            }
        }
        Ok(left)
    }

    /// Concatenation has no operator: adjacency is the syntax. Deciding where
    /// it stops is the fiddly part of parsing awk.
    fn concat(&mut self) -> Result<Expr, String> {
        let mut left = self.additive()?;
        while self.starts_value() {
            left = Expr::Concat(Box::new(left), Box::new(self.additive()?));
        }
        Ok(left)
    }

    fn starts_value(&self) -> bool {
        match self.peek() {
            Tok::Num(_) | Tok::Str(_) | Tok::Regex(_) | Tok::Ident(_) | Tok::Func(_)
            | Tok::LParen => true,
            // `$` and `!` begin a value; `-`/`+` are taken as binary above.
            Tok::Op("$") | Tok::Op("!") => true,
            _ => false,
        }
    }

    fn additive(&mut self) -> Result<Expr, String> {
        let mut left = self.multiplicative()?;
        loop {
            let op = match self.peek() { Tok::Op(o @ ("+" | "-")) => *o, _ => break };
            self.i += 1;
            left = Expr::Binary(op, Box::new(left), Box::new(self.multiplicative()?));
        }
        Ok(left)
    }

    fn multiplicative(&mut self) -> Result<Expr, String> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() { Tok::Op(o @ ("*" | "/" | "%")) => *o, _ => break };
            self.i += 1;
            left = Expr::Binary(op, Box::new(left), Box::new(self.unary()?));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Tok::Op("-") => { self.i += 1; Ok(Expr::Unary("-", Box::new(self.unary()?))) }
            Tok::Op("+") => { self.i += 1; Ok(Expr::Unary("+", Box::new(self.unary()?))) }
            Tok::Op("!") => { self.i += 1; Ok(Expr::Unary("!", Box::new(self.unary()?))) }
            _ => self.power(),
        }
    }

    fn power(&mut self) -> Result<Expr, String> {
        let base = self.postfix()?;
        if matches!(self.peek(), Tok::Op("^") | Tok::Op("**")) {
            self.i += 1;
            // Right-associative, and binds tighter than unary minus on the
            // right: 2^-1 is a half.
            return Ok(Expr::Binary("^", Box::new(base), Box::new(self.unary()?)));
        }
        Ok(base)
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let value = self.primary()?;
        if matches!(value, Expr::Var(_) | Expr::Field(_) | Expr::Index(..)) {
            if let Tok::Op(op @ ("++" | "--")) = self.peek() {
                let op = *op;
                self.i += 1;
                return Ok(Expr::Incr(Box::new(value), op, false));
            }
        }
        Ok(value)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Tok::Num(n) => Ok(Expr::Num(n)),
            Tok::Str(s) => Ok(Expr::Str(s)),
            Tok::Regex(r) => Ok(Expr::Regex(r)),
            Tok::Op("$") => Ok(Expr::Field(Box::new(self.primary()?))),
            Tok::Op(op @ ("++" | "--")) => {
                let target = self.primary()?;
                Ok(Expr::Incr(Box::new(target), op, true))
            }
            Tok::LParen => {
                let mut items = vec![self.expr()?];
                while self.eat(&Tok::Comma) {
                    self.skip_terms();
                    items.push(self.expr()?);
                }
                self.expect(Tok::RParen)?;
                // `(a, b) in arr` is a multi-subscript membership test.
                if self.eat(&Tok::Kw("in")) {
                    let array = match self.next() {
                        Tok::Ident(a) => a,
                        t => return Err(format!("`in` expects an array, found {:?}", t)),
                    };
                    return Ok(Expr::In(items, array));
                }
                if items.len() == 1 { Ok(items.pop().unwrap()) } else { Ok(Expr::Grouping(items)) }
            }
            Tok::Func(name) => {
                let mut args = vec![];
                if self.eat(&Tok::LParen) {
                    if !matches!(self.peek(), Tok::RParen) {
                        loop {
                            args.push(self.expr()?);
                            if !self.eat(&Tok::Comma) { break; }
                            self.skip_terms();
                        }
                    }
                    self.expect(Tok::RParen)?;
                } else if name != "length" {
                    return Err(format!("{} expects arguments", name));
                }
                Ok(Expr::Call(name, args))
            }
            Tok::Ident(name) => {
                if self.eat(&Tok::LBracket) {
                    let mut subs = vec![self.expr()?];
                    while self.eat(&Tok::Comma) { subs.push(self.expr()?); }
                    self.expect(Tok::RBracket)?;
                    return Ok(Expr::Index(name, subs));
                }
                Ok(Expr::Var(name))
            }
            t => Err(format!("unexpected {:?}", t)),
        }
    }
}

// ------------------------------------------------------------- interpreter

enum Flow { Normal, Next, Break, Continue, Exit }

struct Interp {
    globals: HashMap<String, Value>,
    arrays: HashMap<String, HashMap<String, Value>>,
    fields: Vec<String>,
    record: String,
    out: String,
    err: String,
    exit_code: Option<i32>,
    regexes: HashMap<String, regex::Regex>,
    rng: u64,
    /// Bounded like the shell's own loops: a wasm module that spins cannot be
    /// interrupted from outside, so it has to stop itself.
    steps: u64,
}

const MAX_STEPS: u64 = 50_000_000;

impl Interp {
    fn new() -> Self {
        let mut globals = HashMap::new();
        globals.insert("FS".into(), Value::Str(" ".into()));
        globals.insert("OFS".into(), Value::Str(" ".into()));
        globals.insert("ORS".into(), Value::Str("\n".into()));
        globals.insert("RS".into(), Value::Str("\n".into()));
        globals.insert("SUBSEP".into(), Value::Str("\u{1c}".into()));
        globals.insert("NR".into(), Value::Num(0.0));
        globals.insert("NF".into(), Value::Num(0.0));
        globals.insert("FNR".into(), Value::Num(0.0));
        globals.insert("FILENAME".into(), Value::Str(String::new()));
        globals.insert("RSTART".into(), Value::Num(0.0));
        globals.insert("RLENGTH".into(), Value::Num(-1.0));
        Interp {
            globals,
            arrays: HashMap::new(),
            fields: vec![],
            record: String::new(),
            out: String::new(),
            err: String::new(),
            exit_code: None,
            regexes: HashMap::new(),
            rng: 0x2545F491_4F6CDD1D,
            steps: 0,
        }
    }

    fn tick(&mut self) -> Result<(), String> {
        self.steps += 1;
        if self.steps > MAX_STEPS { return Err("awk: step limit exceeded".into()); }
        Ok(())
    }

    fn get(&self, name: &str) -> Value {
        self.globals.get(name).cloned().unwrap_or(Value::Uninit)
    }

    fn set(&mut self, name: &str, value: Value) {
        if name == "NF" {
            let n = value.num().max(0.0) as usize;
            self.fields.resize(n, String::new());
            self.rebuild_record();
        }
        self.globals.insert(name.into(), value);
    }

    fn regex(&mut self, pattern: &str) -> Result<regex::Regex, String> {
        if let Some(r) = self.regexes.get(pattern) { return Ok(r.clone()); }
        let compiled = regex::Regex::new(&translate_ere(pattern))
            .map_err(|e| format!("awk: bad regex /{}/: {}", pattern, e))?;
        self.regexes.insert(pattern.into(), compiled.clone());
        Ok(compiled)
    }

    // ---- fields

    fn set_record(&mut self, line: &str) {
        self.record = line.to_string();
        self.split_record();
    }

    fn split_record(&mut self) {
        let fs = self.get("FS").text();
        self.fields = split_fields(&self.record, &fs, &mut self.regexes);
        let n = self.fields.len() as f64;
        self.globals.insert("NF".into(), Value::Num(n));
    }

    fn rebuild_record(&mut self) {
        let ofs = self.get("OFS").text();
        self.record = self.fields.join(&ofs);
    }

    fn field(&self, i: usize) -> Value {
        // Fields are input, so they take part in numeric comparison.
        if i == 0 { return Value::StrNum(self.record.clone()); }
        match self.fields.get(i - 1) {
            Some(s) => Value::StrNum(s.clone()),
            None => Value::Uninit,
        }
    }

    fn set_field(&mut self, i: usize, value: String) {
        if i == 0 {
            self.set_record(&value);
            return;
        }
        if self.fields.len() < i { self.fields.resize(i, String::new()); }
        self.fields[i - 1] = value;
        self.globals.insert("NF".into(), Value::Num(self.fields.len() as f64));
        self.rebuild_record();
    }
}

/// Field splitting, with awk's three cases: default (any run of blanks, edges
/// trimmed), a single character, and a regex.
fn split_fields(line: &str, fs: &str, cache: &mut HashMap<String, regex::Regex>) -> Vec<String> {
    if line.is_empty() { return vec![]; }
    if fs == " " {
        return line.split_whitespace().map(|s| s.to_string()).collect();
    }
    if fs.chars().count() == 1 && !"\\^$.[]|()*+?{}".contains(fs) {
        return line.split(fs).map(|s| s.to_string()).collect();
    }
    if fs.is_empty() {
        return line.chars().map(|c| c.to_string()).collect();
    }
    let re = cache.entry(fs.to_string()).or_insert_with(|| {
        regex::Regex::new(&translate_ere(fs)).unwrap_or_else(|_| regex::Regex::new(r"\s+").unwrap())
    });
    re.split(line).map(|s| s.to_string()).collect()
}

/// POSIX ERE bracket classes the `regex` crate spells differently.
fn translate_ere(p: &str) -> String {
    p.replace("[:alpha:]", "a-zA-Z")
        .replace("[:digit:]", "0-9")
        .replace("[:alnum:]", "a-zA-Z0-9")
        .replace("[:space:]", r"\s")
        .replace("[:upper:]", "A-Z")
        .replace("[:lower:]", "a-z")
        .replace("[:punct:]", r"!-/:-@\[-`{-~")
        .replace("[:blank:]", r" \t")
}

impl Interp {
    fn eval(&mut self, e: &Expr) -> Result<Value, String> {
        self.tick()?;
        Ok(match e {
            Expr::Num(n) => Value::Num(*n),
            Expr::Str(s) => Value::Str(s.clone()),
            // A bare regex is a match against $0.
            Expr::Regex(r) => {
                let re = self.regex(r)?;
                Value::Num(if re.is_match(&self.record) { 1.0 } else { 0.0 })
            }
            Expr::Var(name) => self.get(name),
            Expr::Field(i) => {
                let n = self.eval(i)?.num();
                if n < 0.0 { return Err("awk: trying to access out of range field".into()); }
                self.field(n as usize)
            }
            Expr::Index(name, subs) => {
                let key = self.subscript(subs)?;
                self.arrays.entry(name.clone()).or_default();
                self.arrays[name].get(&key).cloned().unwrap_or(Value::Uninit)
            }
            Expr::Grouping(items) => {
                let mut last = Value::Uninit;
                for item in items { last = self.eval(item)?; }
                last
            }
            Expr::Concat(a, b) => {
                let left = self.eval(a)?.text();
                let right = self.eval(b)?.text();
                Value::Str(format!("{}{}", left, right))
            }
            Expr::Unary(op, operand) => {
                let v = self.eval(operand)?;
                match *op {
                    "-" => Value::Num(-v.num()),
                    "+" => Value::Num(v.num()),
                    _ => Value::Num(if v.truthy() { 0.0 } else { 1.0 }),
                }
            }
            Expr::Binary(op, a, b) => return self.binary(op, a, b),
            Expr::Ternary(c, t, f) => {
                if self.eval(c)?.truthy() { self.eval(t)? } else { self.eval(f)? }
            }
            Expr::Match(value, pattern, negated) => {
                let text = self.eval(value)?.text();
                let p = match &**pattern {
                    Expr::Regex(r) => r.clone(),
                    other => self.eval(other)?.text(),
                };
                let re = self.regex(&p)?;
                let hit = re.is_match(&text);
                Value::Num(if hit != *negated { 1.0 } else { 0.0 })
            }
            Expr::In(subs, array) => {
                let key = self.subscript(subs)?;
                let present = self.arrays.get(array).is_some_and(|a| a.contains_key(&key));
                Value::Num(if present { 1.0 } else { 0.0 })
            }
            Expr::Assign(target, op, value) => {
                let rhs = self.eval(value)?;
                let next = if *op == "=" {
                    rhs
                } else {
                    let current = self.eval(target)?.num();
                    let n = rhs.num();
                    Value::Num(match *op {
                        "+=" => current + n,
                        "-=" => current - n,
                        "*=" => current * n,
                        "/=" => current / n,
                        "%=" => current % n,
                        _ => current.powf(n),
                    })
                };
                self.store(target, next.clone())?;
                next
            }
            Expr::Incr(target, op, prefix) => {
                let before = self.eval(target)?.num();
                let after = if *op == "++" { before + 1.0 } else { before - 1.0 };
                self.store(target, Value::Num(after))?;
                Value::Num(if *prefix { after } else { before })
            }
            Expr::Call(name, args) => return self.call(name, args),
        })
    }

    fn binary(&mut self, op: &str, a: &Expr, b: &Expr) -> Result<Value, String> {
        // Short-circuit before evaluating the right side.
        if op == "&&" {
            return Ok(Value::Num(
                if self.eval(a)?.truthy() && self.eval(b)?.truthy() { 1.0 } else { 0.0 },
            ));
        }
        if op == "||" {
            return Ok(Value::Num(
                if self.eval(a)?.truthy() || self.eval(b)?.truthy() { 1.0 } else { 0.0 },
            ));
        }
        let left = self.eval(a)?;
        let right = self.eval(b)?;
        Ok(match op {
            "+" => Value::Num(left.num() + right.num()),
            "-" => Value::Num(left.num() - right.num()),
            "*" => Value::Num(left.num() * right.num()),
            "/" => {
                if right.num() == 0.0 { return Err("awk: division by zero".into()); }
                Value::Num(left.num() / right.num())
            }
            "%" => {
                if right.num() == 0.0 { return Err("awk: division by zero in %".into()); }
                Value::Num(left.num() % right.num())
            }
            "^" => Value::Num(left.num().powf(right.num())),
            _ => {
                // Numbers compare numerically only when both sides look like
                // numbers; otherwise it is a string comparison.
                let ordering = if left.numeric() && right.numeric() {
                    left.num().partial_cmp(&right.num())
                } else {
                    Some(left.text().cmp(&right.text()))
                };
                let truth = match (op, ordering) {
                    ("<", Some(o)) => o.is_lt(),
                    ("<=", Some(o)) => o.is_le(),
                    (">", Some(o)) => o.is_gt(),
                    (">=", Some(o)) => o.is_ge(),
                    ("==", Some(o)) => o.is_eq(),
                    ("!=", Some(o)) => !o.is_eq(),
                    _ => false,
                };
                Value::Num(if truth { 1.0 } else { 0.0 })
            }
        })
    }

    fn store(&mut self, target: &Expr, value: Value) -> Result<(), String> {
        match target {
            Expr::Var(name) => { self.set(name, value); }
            Expr::Field(i) => {
                let n = self.eval(i)?.num() as usize;
                self.set_field(n, value.text());
            }
            Expr::Index(name, subs) => {
                let key = self.subscript(subs)?;
                self.arrays.entry(name.clone()).or_default().insert(key, value);
            }
            _ => return Err("awk: cannot assign to that".into()),
        }
        Ok(())
    }

    /// Multi-dimensional subscripts are joined with SUBSEP, as in real awk.
    fn subscript(&mut self, subs: &[Expr]) -> Result<String, String> {
        let sep = self.get("SUBSEP").text();
        let mut parts = vec![];
        for s in subs { parts.push(self.eval(s)?.text()); }
        Ok(parts.join(&sep))
    }
}

impl Interp {
    fn call(&mut self, name: &str, args: &[Expr]) -> Result<Value, String> {
        let arg = |me: &mut Self, i: usize| -> Result<Value, String> {
            match args.get(i) { Some(e) => me.eval(e), None => Ok(Value::Uninit) }
        };
        Ok(match name {
            "length" => {
                if args.is_empty() {
                    Value::Num(self.record.chars().count() as f64)
                } else if let Expr::Var(v) = &args[0] {
                    // `length(arr)` counts members; on a scalar it is the text.
                    if let Some(a) = self.arrays.get(v) {
                        Value::Num(a.len() as f64)
                    } else {
                        Value::Num(self.get(v).text().chars().count() as f64)
                    }
                } else {
                    Value::Num(arg(self, 0)?.text().chars().count() as f64)
                }
            }
            "substr" => {
                let s: Vec<char> = arg(self, 0)?.text().chars().collect();
                // 1-based, and awk clamps rather than erroring.
                // A start below 1 is clamped to 1 and the length is kept, so
                // `substr("hello", 0, 3)` is "hel". POSIX can be read as
                // trimming the overshoot instead, giving "he"; this follows
                // what awk on the reference machine actually does.
                let start = arg(self, 1)?.num().round();
                let from = (start.max(1.0) as usize).saturating_sub(1);
                let count = if args.len() > 2 {
                    arg(self, 2)?.num().round().max(0.0) as usize
                } else {
                    s.len().saturating_sub(from)
                };
                Value::Str(s.into_iter().skip(from).take(count).collect())
            }
            "index" => {
                let haystack = arg(self, 0)?.text();
                let needle = arg(self, 1)?.text();
                Value::Num(match haystack.find(&needle) {
                    Some(byte) => haystack[..byte].chars().count() as f64 + 1.0,
                    None => 0.0,
                })
            }
            "split" => {
                let text = arg(self, 0)?.text();
                let array = match args.get(1) {
                    Some(Expr::Var(v)) => v.clone(),
                    _ => return Err("awk: split expects an array".into()),
                };
                let fs = if args.len() > 2 {
                    match &args[2] { Expr::Regex(r) => r.clone(), other => self.eval(other)?.text() }
                } else {
                    self.get("FS").text()
                };
                let parts = split_fields(&text, &fs, &mut self.regexes);
                let slot = self.arrays.entry(array).or_default();
                slot.clear();
                for (i, p) in parts.iter().enumerate() {
                    slot.insert((i + 1).to_string(), Value::StrNum(p.clone()));
                }
                Value::Num(parts.len() as f64)
            }
            "sub" | "gsub" => {
                let pattern = match &args[0] {
                    Expr::Regex(r) => r.clone(),
                    other => self.eval(other)?.text(),
                };
                let replacement = arg(self, 1)?.text();
                let target = args.get(2).cloned().unwrap_or(Expr::Field(Box::new(Expr::Num(0.0))));
                let subject = self.eval(&target)?.text();
                let re = self.regex(&pattern)?;

                let mut count = 0usize;
                let mut result = String::new();
                let mut last = 0usize;
                for m in re.find_iter(&subject) {
                    if name == "sub" && count >= 1 { break; }
                    result.push_str(&subject[last..m.start()]);
                    // `&` in the replacement is the matched text; `\&` is a
                    // literal ampersand.
                    let mut chars = replacement.chars().peekable();
                    while let Some(c) = chars.next() {
                        match c {
                            '\\' if chars.peek() == Some(&'&') => { chars.next(); result.push('&'); }
                            '&' => result.push_str(m.as_str()),
                            other => result.push(other),
                        }
                    }
                    last = m.end();
                    count += 1;
                    if m.start() == m.end() { break; }
                }
                result.push_str(&subject[last..]);
                if count > 0 { self.store(&target, Value::Str(result))?; }
                Value::Num(count as f64)
            }
            "match" => {
                let text = arg(self, 0)?.text();
                let pattern = match &args[1] {
                    Expr::Regex(r) => r.clone(),
                    other => self.eval(other)?.text(),
                };
                let re = self.regex(&pattern)?;
                match re.find(&text) {
                    Some(m) => {
                        let start = text[..m.start()].chars().count() as f64 + 1.0;
                        let len = m.as_str().chars().count() as f64;
                        self.globals.insert("RSTART".into(), Value::Num(start));
                        self.globals.insert("RLENGTH".into(), Value::Num(len));
                        Value::Num(start)
                    }
                    None => {
                        self.globals.insert("RSTART".into(), Value::Num(0.0));
                        self.globals.insert("RLENGTH".into(), Value::Num(-1.0));
                        Value::Num(0.0)
                    }
                }
            }
            "sprintf" => {
                let mut values = vec![];
                for a in &args[1..] { values.push(self.eval(a)?); }
                Value::Str(format_spec(&arg(self, 0)?.text(), &values))
            }
            "toupper" => Value::Str(arg(self, 0)?.text().to_uppercase()),
            "tolower" => Value::Str(arg(self, 0)?.text().to_lowercase()),
            "int" => Value::Num(arg(self, 0)?.num().trunc()),
            "sqrt" => Value::Num(arg(self, 0)?.num().sqrt()),
            "exp" => Value::Num(arg(self, 0)?.num().exp()),
            "log" => Value::Num(arg(self, 0)?.num().ln()),
            "sin" => Value::Num(arg(self, 0)?.num().sin()),
            "cos" => Value::Num(arg(self, 0)?.num().cos()),
            "atan2" => Value::Num(arg(self, 0)?.num().atan2(arg(self, 1)?.num())),
            "rand" => {
                // xorshift: deterministic, seeded by srand, and enough for a
                // shell script. No entropy source in wasm anyway.
                self.rng ^= self.rng << 13;
                self.rng ^= self.rng >> 7;
                self.rng ^= self.rng << 17;
                Value::Num((self.rng >> 11) as f64 / (1u64 << 53) as f64)
            }
            "srand" => {
                let previous = self.rng;
                self.rng = if args.is_empty() { 0x9E3779B9 } else { arg(self, 0)?.num() as u64 | 1 };
                Value::Num(previous as f64)
            }
            // No processes and no files to close, so these are honest no-ops
            // rather than errors: a script that calls them still runs.
            "system" => Value::Num(-1.0),
            "close" => Value::Num(0.0),
            other => return Err(format!("awk: unknown function {}", other)),
        })
    }
}

/// `printf`-style formatting over awk values.
fn format_spec(spec: &str, args: &[Value]) -> String {
    let mut out = String::new();
    let mut next = 0usize;
    let mut chars = spec.chars().peekable();
    let take = |i: &mut usize| -> Value {
        let v = args.get(*i).cloned().unwrap_or(Value::Uninit);
        *i += 1;
        v
    };

    while let Some(c) = chars.next() {
        if c != '%' { out.push(c); continue; }
        if chars.peek() == Some(&'%') { chars.next(); out.push('%'); continue; }

        let mut flags = String::new();
        while let Some(&f) = chars.peek() {
            if "-+ #0".contains(f) { flags.push(f); chars.next(); } else { break; }
        }
        let mut width = String::new();
        while let Some(&d) = chars.peek() {
            if d.is_ascii_digit() { width.push(d); chars.next(); } else { break; }
        }
        if chars.peek() == Some(&'*') { chars.next(); width = fmt_num(take(&mut next).num()); }
        let mut precision: Option<usize> = None;
        if chars.peek() == Some(&'.') {
            chars.next();
            let mut p = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() { p.push(d); chars.next(); } else { break; }
            }
            if chars.peek() == Some(&'*') { chars.next(); p = fmt_num(take(&mut next).num()); }
            precision = Some(p.parse().unwrap_or(0));
        }
        let conv = match chars.next() { Some(c) => c, None => { out.push('%'); break; } };

        let body = match conv {
            'd' | 'i' => format!("{}", take(&mut next).num().trunc() as i64),
            'u' => format!("{}", take(&mut next).num().trunc().max(0.0) as u64),
            'c' => {
                let v = take(&mut next);
                match v {
                    Value::Num(n) => char::from_u32(n as u32).map(String::from).unwrap_or_default(),
                    other => other.text().chars().next().map(String::from).unwrap_or_default(),
                }
            }
            's' => {
                let s = take(&mut next).text();
                match precision { Some(p) => s.chars().take(p).collect(), None => s }
            }
            'f' | 'F' => format!("{:.*}", precision.unwrap_or(6), take(&mut next).num()),
            'e' | 'E' => {
                let s = format!("{:.*e}", precision.unwrap_or(6), take(&mut next).num());
                // Rust writes `1.5e3`; C writes `1.5e+03`.
                let s = match s.split_once('e') {
                    Some((m, exp)) => {
                        let value: i32 = exp.parse().unwrap_or(0);
                        format!("{}e{}{:02}", m, if value < 0 { '-' } else { '+' }, value.abs())
                    }
                    None => s,
                };
                if conv == 'E' { s.to_uppercase() } else { s }
            }
            'g' | 'G' => {
                let n = take(&mut next).num();
                let s = format!("{}", n);
                if conv == 'G' { s.to_uppercase() } else { s }
            }
            'x' => format!("{:x}", take(&mut next).num().trunc() as i64),
            'X' => format!("{:X}", take(&mut next).num().trunc() as i64),
            'o' => format!("{:o}", take(&mut next).num().trunc() as i64),
            other => { out.push('%'); out.push(other); continue; }
        };

        let width: usize = width.parse().unwrap_or(0);
        let pad = width.saturating_sub(body.chars().count());
        if pad == 0 {
            out.push_str(&body);
        } else if flags.contains('-') {
            out.push_str(&body);
            out.push_str(&" ".repeat(pad));
        } else if flags.contains('0') && !matches!(conv, 's' | 'c') {
            // Zero padding goes after any sign.
            let (sign, rest) = match body.strip_prefix('-') { Some(r) => ("-", r), None => ("", &body[..]) };
            out.push_str(sign);
            out.push_str(&"0".repeat(pad));
            out.push_str(rest);
        } else {
            out.push_str(&" ".repeat(pad));
            out.push_str(&body);
        }
    }
    out
}

impl Interp {
    fn exec(&mut self, s: &Stmt) -> Result<Flow, String> {
        self.tick()?;
        Ok(match s {
            Stmt::Nop => Flow::Normal,
            Stmt::Expr(e) => { self.eval(e)?; Flow::Normal }
            Stmt::Block(body) => {
                for st in body {
                    match self.exec(st)? {
                        Flow::Normal => {}
                        other => return Ok(other),
                    }
                }
                Flow::Normal
            }
            Stmt::Print(args) => {
                let ofs = self.get("OFS").text();
                let ors = self.get("ORS").text();
                let text = if args.is_empty() {
                    self.record.clone()
                } else {
                    let mut parts = vec![];
                    for a in args { parts.push(self.eval(a)?.text()); }
                    parts.join(&ofs)
                };
                self.out.push_str(&text);
                self.out.push_str(&ors);
                Flow::Normal
            }
            Stmt::Printf(args) => {
                if args.is_empty() { return Err("awk: printf needs a format".into()); }
                let spec = self.eval(&args[0])?.text();
                let mut values = vec![];
                for a in &args[1..] { values.push(self.eval(a)?); }
                self.out.push_str(&format_spec(&spec, &values));
                Flow::Normal
            }
            Stmt::If(cond, then, otherwise) => {
                if self.eval(cond)?.truthy() {
                    self.exec(then)?
                } else if let Some(e) = otherwise {
                    self.exec(e)?
                } else {
                    Flow::Normal
                }
            }
            Stmt::While(cond, body) => {
                while self.eval(cond)?.truthy() {
                    match self.exec(body)? {
                        Flow::Break => break,
                        Flow::Normal | Flow::Continue => {}
                        other => return Ok(other),
                    }
                }
                Flow::Normal
            }
            Stmt::DoWhile(body, cond) => {
                loop {
                    match self.exec(body)? {
                        Flow::Break => break,
                        Flow::Normal | Flow::Continue => {}
                        other => return Ok(other),
                    }
                    if !self.eval(cond)?.truthy() { break; }
                }
                Flow::Normal
            }
            Stmt::For(init, cond, step, body) => {
                if let Some(i) = init { self.exec(i)?; }
                loop {
                    if let Some(c) = cond {
                        if !self.eval(c)?.truthy() { break; }
                    }
                    match self.exec(body)? {
                        Flow::Break => break,
                        Flow::Normal | Flow::Continue => {}
                        other => return Ok(other),
                    }
                    if let Some(s) = step { self.exec(s)?; }
                }
                Flow::Normal
            }
            Stmt::ForIn(name, array, body) => {
                // Keys are snapshotted and sorted: real awk leaves the order
                // unspecified, and an unspecified order that changes between
                // runs is a script that passes once.
                let mut keys: Vec<String> =
                    self.arrays.get(array).map(|a| a.keys().cloned().collect()).unwrap_or_default();
                keys.sort();
                for k in keys {
                    self.set(name, Value::Str(k));
                    match self.exec(body)? {
                        Flow::Break => break,
                        Flow::Normal | Flow::Continue => {}
                        other => return Ok(other),
                    }
                }
                Flow::Normal
            }
            Stmt::Delete(name, subs) => {
                if subs.is_empty() {
                    self.arrays.entry(name.clone()).or_default().clear();
                } else {
                    let key = self.subscript(subs)?;
                    self.arrays.entry(name.clone()).or_default().remove(&key);
                }
                Flow::Normal
            }
            Stmt::Next => Flow::Next,
            Stmt::Break => Flow::Break,
            Stmt::Continue => Flow::Continue,
            Stmt::Exit(code) => {
                let c = match code { Some(e) => self.eval(e)?.num() as i32, None => 0 };
                self.exit_code = Some(c);
                Flow::Exit
            }
        })
    }
}

// ------------------------------------------------------------- entry point

/// `awk [-F fs] [-v var=value]... 'program' [file...]`
pub fn awk(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let mut program: Option<String> = None;
    let mut assigns: Vec<(String, String)> = vec![];
    let mut fs: Option<String> = None;
    let mut files: Vec<String> = vec![];

    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if program.is_none() && a == "-F" {
            i += 1;
            fs = args.get(i).cloned();
        } else if program.is_none() && a.starts_with("-F") && a.len() > 2 {
            fs = Some(a[2..].to_string());
        } else if program.is_none() && a == "-v" {
            i += 1;
            if let Some(kv) = args.get(i) {
                if let Some((k, v)) = kv.split_once('=') { assigns.push((k.into(), v.into())); }
            }
        } else if program.is_none() && a.starts_with("-v") && a.len() > 2 {
            if let Some((k, v)) = a[2..].split_once('=') { assigns.push((k.into(), v.into())); }
        } else if program.is_none() && (a == "-f" || a == "--file") {
            i += 1;
            match args.get(i) {
                Some(path) => {
                    let p = crate::fs::normalize(ctx.cwd, path);
                    match ctx.fs.read(&p) {
                        Ok(d) => program = Some(String::from_utf8_lossy(d).to_string()),
                        Err(_) => {
                            out.stderr.extend_from_slice(
                                format!("awk: can't open file {}\n", path).as_bytes());
                            out.code = 2;
                            return out;
                        }
                    }
                }
                None => { out.stderr.extend_from_slice(b"awk: -f needs a file\n"); out.code = 2; return out; }
            }
        } else if a == "--" {
            i += 1;
            while let Some(rest) = args.get(i) {
                if program.is_none() { program = Some(rest.clone()); } else { files.push(rest.clone()); }
                i += 1;
            }
            break;
        } else if program.is_none() {
            program = Some(a.clone());
        } else {
            files.push(a.clone());
        }
        i += 1;
    }

    let source = match program {
        Some(p) => p,
        None => {
            out.stderr.extend_from_slice(b"usage: awk [-F fs] [-v var=value] 'program' [file ...]\n");
            out.code = 2;
            return out;
        }
    };

    let rules = match parse(&source) {
        Ok(r) => r,
        Err(e) => {
            out.stderr.extend_from_slice(format!("awk: {}\n", e).as_bytes());
            out.code = 2;
            return out;
        }
    };

    let mut interp = Interp::new();
    if let Some(f) = fs { interp.set("FS", Value::Str(unescape(&f))); }
    for (k, v) in &assigns { interp.set(k, Value::StrNum(unescape(v))); }

    // A trailing `var=value` among the files is an assignment, not a file.
    let mut sources: Vec<(String, Vec<u8>)> = vec![];
    let mut pending: Vec<(String, String)> = vec![];
    if files.is_empty() {
        sources.push(("-".into(), ctx.stdin.to_vec()));
    } else {
        for f in &files {
            if let Some((k, v)) = f.split_once('=') {
                if !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    pending.push((k.into(), v.into()));
                    continue;
                }
            }
            if f == "-" {
                sources.push(("-".into(), ctx.stdin.to_vec()));
                continue;
            }
            let p = crate::fs::normalize(ctx.cwd, f);
            match ctx.fs.read(&p) {
                Ok(d) => sources.push((f.clone(), d.to_vec())),
                Err(_) => {
                    out.stderr.extend_from_slice(
                        format!("awk: can't open file {}\n", f).as_bytes());
                    out.code = 2;
                }
            }
        }
        if sources.is_empty() && out.code == 0 { sources.push(("-".into(), ctx.stdin.to_vec())); }
    }
    for (k, v) in pending { interp.set(&k, Value::StrNum(v)); }

    match run_program(&mut interp, rules, sources) {
        Ok(()) => {}
        Err(e) => {
            out.stderr.extend_from_slice(format!("{}\n", e).as_bytes());
            out.stdout.extend_from_slice(interp.out.as_bytes());
            out.code = 2;
            return out;
        }
    }

    out.stdout.extend_from_slice(interp.out.as_bytes());
    out.stderr.extend_from_slice(interp.err.as_bytes());
    if let Some(c) = interp.exit_code { out.code = c; }
    out
}

fn parse(source: &str) -> Result<Vec<Rule>, String> {
    let toks = Lexer { src: source.as_bytes(), i: 0, toks: vec![] }.lex()?;
    Parser { toks, i: 0 }.program()
}

fn run_program(
    interp: &mut Interp,
    mut rules: Vec<Rule>,
    sources: Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let mut exited = false;

    for rule in rules.iter() {
        if matches!(rule.pattern, Pattern::Begin) {
            if let Some(action) = &rule.action {
                if matches!(interp.exec(action)?, Flow::Exit) { exited = true; break; }
            }
        }
    }

    // A program with only BEGIN never reads input, which is what makes
    // `awk 'BEGIN { ... }'` usable as a calculator.
    let main_rules = rules.iter().any(|r| !matches!(r.pattern, Pattern::Begin));
    if !exited && main_rules {
        'outer: for (name, data) in &sources {
            interp.set("FILENAME", Value::Str(name.clone()));
            interp.globals.insert("FNR".into(), Value::Num(0.0));
            for line in lines_of_input(data) {
                let nr = interp.get("NR").num() + 1.0;
                let fnr = interp.get("FNR").num() + 1.0;
                interp.globals.insert("NR".into(), Value::Num(nr));
                interp.globals.insert("FNR".into(), Value::Num(fnr));
                interp.set_record(&line);

                for rule in rules.iter_mut() {
                    let matched = match &rule.pattern {
                        Pattern::Begin | Pattern::End => continue,
                        Pattern::Always => true,
                        Pattern::Expr(e) => interp.eval(e)?.truthy(),
                        Pattern::Range(start, end) => {
                            if rule.active {
                                if interp.eval(end)?.truthy() { rule.active = false; }
                                true
                            } else if interp.eval(start)?.truthy() {
                                // A one-line range closes immediately.
                                rule.active = !interp.eval(end)?.truthy();
                                true
                            } else {
                                false
                            }
                        }
                    };
                    if !matched { continue; }
                    match &rule.action {
                        None => {
                            let ors = interp.get("ORS").text();
                            let record = interp.record.clone();
                            interp.out.push_str(&record);
                            interp.out.push_str(&ors);
                        }
                        Some(action) => match interp.exec(action)? {
                            Flow::Next => break,
                            // END still runs after `exit`, so nothing else
                            // needs to know we stopped early.
                            Flow::Exit => break 'outer,
                            _ => {}
                        },
                    }
                }
            }
        }
    }

    // END runs even after `exit`, which is how awk is specified.
    for rule in rules.iter() {
        if matches!(rule.pattern, Pattern::End) {
            if let Some(action) = &rule.action {
                if matches!(interp.exec(action)?, Flow::Exit) { break; }
            }
        }
    }
    Ok(())
}

fn lines_of_input(data: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(data);
    let mut v: Vec<String> = s.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    if v.last().is_some_and(|l| l.is_empty()) { v.pop(); }
    v
}

/// `-F '\t'` arrives as a literal backslash-t from the shell.
fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' { out.push(c); continue; }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => { out.push('\\'); out.push(other); }
            None => out.push('\\'),
        }
    }
    out
}
