//! `sqlite3`: a small SQL engine over the in-memory filesystem.
//!
//! **Not SQLite.** It does not read or write SQLite's file format, so a
//! database made here cannot be opened by the real thing and vice versa. It
//! stores tables as JSON in the file you name. What it offers is the SQL a
//! shell script actually writes — create a table, load some rows, aggregate
//! them — with `sqlite3`'s command-line shape so those scripts run unchanged.
//!
//! Supported: CREATE TABLE, DROP TABLE, INSERT, SELECT (WHERE, GROUP BY,
//! HAVING, ORDER BY, LIMIT/OFFSET, aggregates, expressions), UPDATE, DELETE,
//! and the `.tables`, `.schema`, `.headers`, `.mode` and `.import` dot
//! commands. No joins, subqueries, indexes, transactions or types.

use std::collections::HashMap;

use crate::commands::{parse_args, CmdOut, Ctx};
use crate::fs;

#[derive(Clone, Debug, PartialEq)]
pub enum Val { Null, Int(i64), Real(f64), Text(String) }

impl Val {
    fn text(&self) -> String {
        match self {
            Val::Null => String::new(),
            Val::Int(i) => i.to_string(),
            Val::Real(f) => {
                if *f == f.trunc() && f.abs() < 1e15 { format!("{:.1}", f) } else { f.to_string() }
            }
            Val::Text(s) => s.clone(),
        }
    }
    fn num(&self) -> f64 {
        match self {
            Val::Int(i) => *i as f64,
            Val::Real(f) => *f,
            Val::Text(s) => s.trim().parse().unwrap_or(0.0),
            Val::Null => 0.0,
        }
    }
    fn truthy(&self) -> bool {
        match self { Val::Null => false, Val::Text(s) => !s.is_empty() && s != "0", v => v.num() != 0.0 }
    }
    /// SQL ordering: NULL first, then numbers, then text.
    fn cmp_sql(&self, other: &Val) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self, other) {
            (Val::Null, Val::Null) => Ordering::Equal,
            (Val::Null, _) => Ordering::Less,
            (_, Val::Null) => Ordering::Greater,
            (Val::Text(a), Val::Text(b)) => a.cmp(b),
            (a, b) => a.num().partial_cmp(&b.num()).unwrap_or(Ordering::Equal),
        }
    }
    fn parse(text: &str) -> Val {
        if text.is_empty() { return Val::Null; }
        if let Ok(i) = text.parse::<i64>() { return Val::Int(i); }
        if let Ok(f) = text.parse::<f64>() { return Val::Real(f); }
        Val::Text(text.to_string())
    }
}

#[derive(Clone, Default)]
struct Table { columns: Vec<String>, rows: Vec<Vec<Val>> }

#[derive(Default)]
struct Db { tables: HashMap<String, Table> }

// ------------------------------------------------------------------ lexer

#[derive(Clone, Debug, PartialEq)]
enum T {
    Word(String),
    /// Double-quoted: an identifier that falls back to a string literal when
    /// no column of that name exists. SQLite's rule, and the one that makes
    /// `sqlite3 db "INSERT ... VALUES (\"x\")"` work from a shell.
    Quoted(String),
    Str(String),
    Num(f64),
    Int(i64),
    Sym(String),
    Eof,
}

fn lex(sql: &str) -> Result<Vec<T>, String> {
    let c: Vec<char> = sql.chars().collect();
    let mut i = 0;
    let mut out = vec![];
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() { i += 1; continue; }
        if ch == '-' && c.get(i + 1) == Some(&'-') {
            while i < c.len() && c[i] != '\n' { i += 1; }
            continue;
        }
        if ch == '\'' || ch == '"' {
            let quote = ch;
            i += 1;
            let mut s = String::new();
            while i < c.len() {
                if c[i] == quote {
                    if c.get(i + 1) == Some(&quote) { s.push(quote); i += 2; continue; }
                    i += 1;
                    break;
                }
                s.push(c[i]);
                i += 1;
            }
            out.push(if quote == '"' { T::Quoted(s) } else { T::Str(s) });
            continue;
        }
        if ch.is_ascii_digit() {
            let start = i;
            let mut real = false;
            while i < c.len() && (c[i].is_ascii_digit() || c[i] == '.') {
                if c[i] == '.' { real = true; }
                i += 1;
            }
            let text: String = c[start..i].iter().collect();
            out.push(if real {
                T::Num(text.parse().unwrap_or(0.0))
            } else {
                T::Int(text.parse().unwrap_or(0))
            });
            continue;
        }
        if ch.is_alphabetic() || ch == '_' {
            let start = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_') { i += 1; }
            out.push(T::Word(c[start..i].iter().collect()));
            continue;
        }
        let two: String = c[i..(i + 2).min(c.len())].iter().collect();
        if ["<>", "!=", ">=", "<=", "||"].contains(&two.as_str()) {
            out.push(T::Sym(two));
            i += 2;
            continue;
        }
        if "(),*+-/%<>=;.".contains(ch) {
            out.push(T::Sym(ch.to_string()));
            i += 1;
            continue;
        }
        return Err(format!("unrecognized token: \"{}\"", ch));
    }
    out.push(T::Eof);
    Ok(out)
}

// ----------------------------------------------------------------- parser

#[derive(Clone, Debug)]
enum Expr {
    Lit(Val),
    Col(String),
    /// A double-quoted word: a column if one matches, otherwise its own text.
    ColOrText(String),
    Star,
    Bin(String, Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Neg(Box<Expr>),
    Call(String, Vec<Expr>),
    IsNull(Box<Expr>, bool),
    InList(Box<Expr>, Vec<Expr>, bool),
    Like(Box<Expr>, Box<Expr>, bool),
}

struct P { t: Vec<T>, i: usize }

impl P {
    fn peek(&self) -> &T { &self.t[self.i] }
    fn word(&self) -> Option<String> {
        match self.peek() { T::Word(w) => Some(w.to_uppercase()), _ => None }
    }
    fn eat_word(&mut self, w: &str) -> bool {
        if self.word().as_deref() == Some(w) { self.i += 1; true } else { false }
    }
    fn eat_sym(&mut self, s: &str) -> bool {
        if self.peek() == &T::Sym(s.into()) { self.i += 1; true } else { false }
    }
    fn need_sym(&mut self, s: &str) -> Result<(), String> {
        if self.eat_sym(s) { Ok(()) } else { Err(format!("near \"{:?}\": expected {}", self.peek(), s)) }
    }
    fn ident(&mut self) -> Result<String, String> {
        match self.t[self.i].clone() {
            T::Word(w) | T::Quoted(w) => { self.i += 1; Ok(w) }
            other => Err(format!("expected a name, found {:?}", other)),
        }
    }

    fn expr(&mut self) -> Result<Expr, String> { self.or() }

    fn or(&mut self) -> Result<Expr, String> {
        let mut left = self.and()?;
        while self.eat_word("OR") {
            left = Expr::Bin("OR".into(), Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }
    fn and(&mut self) -> Result<Expr, String> {
        let mut left = self.not()?;
        while self.eat_word("AND") {
            left = Expr::Bin("AND".into(), Box::new(left), Box::new(self.not()?));
        }
        Ok(left)
    }
    fn not(&mut self) -> Result<Expr, String> {
        if self.eat_word("NOT") { return Ok(Expr::Not(Box::new(self.not()?))); }
        self.comparison()
    }
    fn comparison(&mut self) -> Result<Expr, String> {
        let left = self.additive()?;
        // IS [NOT] NULL
        if self.eat_word("IS") {
            let negated = self.eat_word("NOT");
            if !self.eat_word("NULL") { return Err("expected NULL after IS".into()); }
            return Ok(Expr::IsNull(Box::new(left), !negated));
        }
        let negated = self.eat_word("NOT");
        if self.eat_word("LIKE") {
            return Ok(Expr::Like(Box::new(left), Box::new(self.additive()?), negated));
        }
        if self.eat_word("IN") {
            self.need_sym("(")?;
            let mut items = vec![];
            if !self.eat_sym(")") {
                loop {
                    items.push(self.expr()?);
                    if !self.eat_sym(",") { break; }
                }
                self.need_sym(")")?;
            }
            return Ok(Expr::InList(Box::new(left), items, negated));
        }
        if negated { return Err("unexpected NOT".into()); }

        for op in ["<=", ">=", "<>", "!=", "=", "<", ">"] {
            if self.eat_sym(op) {
                let op = if op == "!=" { "<>" } else { op };
                return Ok(Expr::Bin(op.into(), Box::new(left), Box::new(self.additive()?)));
            }
        }
        Ok(left)
    }
    fn additive(&mut self) -> Result<Expr, String> {
        let mut left = self.multiplicative()?;
        loop {
            let op = if self.eat_sym("+") { "+" }
                else if self.eat_sym("-") { "-" }
                else if self.eat_sym("||") { "||" }
                else { break };
            left = Expr::Bin(op.into(), Box::new(left), Box::new(self.multiplicative()?));
        }
        Ok(left)
    }
    fn multiplicative(&mut self) -> Result<Expr, String> {
        let mut left = self.unary()?;
        loop {
            let op = if self.eat_sym("*") { "*" }
                else if self.eat_sym("/") { "/" }
                else if self.eat_sym("%") { "%" }
                else { break };
            left = Expr::Bin(op.into(), Box::new(left), Box::new(self.unary()?));
        }
        Ok(left)
    }
    fn unary(&mut self) -> Result<Expr, String> {
        if self.eat_sym("-") { return Ok(Expr::Neg(Box::new(self.unary()?))); }
        self.primary()
    }
    fn primary(&mut self) -> Result<Expr, String> {
        if self.eat_sym("(") {
            let e = self.expr()?;
            self.need_sym(")")?;
            return Ok(e);
        }
        if self.eat_sym("*") { return Ok(Expr::Star); }
        match self.t[self.i].clone() {
            T::Int(i) => { self.i += 1; Ok(Expr::Lit(Val::Int(i))) }
            T::Num(n) => { self.i += 1; Ok(Expr::Lit(Val::Real(n))) }
            T::Str(s) => { self.i += 1; Ok(Expr::Lit(Val::Text(s))) }
            T::Quoted(w) => {
                self.i += 1;
                if self.eat_sym(".") {
                    let col = self.ident()?;
                    return Ok(Expr::Col(col));
                }
                Ok(Expr::ColOrText(w))
            }
            T::Word(w) => {
                self.i += 1;
                let upper = w.to_uppercase();
                if upper == "NULL" { return Ok(Expr::Lit(Val::Null)); }
                if upper == "TRUE" { return Ok(Expr::Lit(Val::Int(1))); }
                if upper == "FALSE" { return Ok(Expr::Lit(Val::Int(0))); }
                if self.eat_sym("(") {
                    let mut args = vec![];
                    if !self.eat_sym(")") {
                        // COUNT(*) is the one place a star is an argument.
                        loop {
                            args.push(if self.eat_sym("*") { Expr::Star } else { self.expr()? });
                            if !self.eat_sym(",") { break; }
                        }
                        self.need_sym(")")?;
                    }
                    return Ok(Expr::Call(upper, args));
                }
                // `table.column` — the table part is dropped, since there is
                // one table per query here.
                if self.eat_sym(".") {
                    let col = self.ident()?;
                    return Ok(Expr::Col(col));
                }
                Ok(Expr::Col(w))
            }
            other => Err(format!("near {:?}: syntax error", other)),
        }
    }
}

// ------------------------------------------------------------- evaluation

struct Row<'a> { columns: &'a [String], values: &'a [Val] }

impl Row<'_> {
    fn get(&self, name: &str) -> Option<Val> {
        self.columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case(name))
            .and_then(|i| self.values.get(i).cloned())
    }
}

fn is_aggregate(name: &str) -> bool {
    matches!(name, "COUNT" | "SUM" | "AVG" | "MIN" | "MAX" | "TOTAL" | "GROUP_CONCAT")
}

fn has_aggregate(e: &Expr) -> bool {
    match e {
        Expr::Call(name, args) => is_aggregate(name) || args.iter().any(has_aggregate),
        Expr::Bin(_, a, b) => has_aggregate(a) || has_aggregate(b),
        Expr::Not(a) | Expr::Neg(a) | Expr::IsNull(a, _) => has_aggregate(a),
        Expr::Like(a, b, _) => has_aggregate(a) || has_aggregate(b),
        Expr::InList(a, items, _) => has_aggregate(a) || items.iter().any(has_aggregate),
        _ => false,
    }
}

/// Evaluates against one row, or — for an aggregate — a whole group.
fn eval(e: &Expr, row: &Row, group: Option<&[Vec<Val>]>, columns: &[String]) -> Result<Val, String> {
    Ok(match e {
        Expr::Lit(v) => v.clone(),
        Expr::Star => Val::Int(1),
        Expr::Col(name) => row.get(name).ok_or_else(|| format!("no such column: {}", name))?,
        Expr::ColOrText(name) => row.get(name).unwrap_or_else(|| Val::Text(name.clone())),
        Expr::Neg(inner) => Val::Real(-eval(inner, row, group, columns)?.num()),
        Expr::Not(inner) => Val::Int(i64::from(!eval(inner, row, group, columns)?.truthy())),
        Expr::IsNull(inner, want_null) => {
            let v = eval(inner, row, group, columns)?;
            Val::Int(i64::from((v == Val::Null) == *want_null))
        }
        Expr::Like(value, pattern, negated) => {
            let text = eval(value, row, group, columns)?.text();
            let p = eval(pattern, row, group, columns)?.text();
            Val::Int(i64::from(like_match(&text, &p) != *negated))
        }
        Expr::InList(value, items, negated) => {
            let v = eval(value, row, group, columns)?;
            let mut found = false;
            for item in items {
                if eval(item, row, group, columns)?.cmp_sql(&v) == std::cmp::Ordering::Equal {
                    found = true;
                    break;
                }
            }
            Val::Int(i64::from(found != *negated))
        }
        Expr::Bin(op, a, b) => {
            // AND/OR short-circuit, as in SQL.
            if op == "AND" {
                let left = eval(a, row, group, columns)?;
                return Ok(Val::Int(i64::from(
                    left.truthy() && eval(b, row, group, columns)?.truthy(),
                )));
            }
            if op == "OR" {
                let left = eval(a, row, group, columns)?;
                return Ok(Val::Int(i64::from(
                    left.truthy() || eval(b, row, group, columns)?.truthy(),
                )));
            }
            let left = eval(a, row, group, columns)?;
            let right = eval(b, row, group, columns)?;
            match op.as_str() {
                "||" => Val::Text(format!("{}{}", left.text(), right.text())),
                "+" | "-" | "*" | "/" | "%" => {
                    let (x, y) = (left.num(), right.num());
                    if (op == "/" || op == "%") && y == 0.0 { return Ok(Val::Null); }
                    let value = match op.as_str() {
                        "+" => x + y, "-" => x - y, "*" => x * y, "/" => x / y, _ => x % y,
                    };
                    // Integer arithmetic stays integer, as SQLite does.
                    let both_int = matches!(left, Val::Int(_) | Val::Null)
                        && matches!(right, Val::Int(_) | Val::Null);
                    if both_int && op != "/" && value == value.trunc() {
                        Val::Int(value as i64)
                    } else if both_int && op == "/" {
                        Val::Int(value.trunc() as i64)
                    } else {
                        Val::Real(value)
                    }
                }
                cmp => {
                    let ordering = left.cmp_sql(&right);
                    let truth = match cmp {
                        "=" => ordering.is_eq(),
                        "<>" => !ordering.is_eq(),
                        "<" => ordering.is_lt(),
                        "<=" => ordering.is_le(),
                        ">" => ordering.is_gt(),
                        ">=" => ordering.is_ge(),
                        _ => return Err(format!("unsupported operator {}", cmp)),
                    };
                    Val::Int(i64::from(truth))
                }
            }
        }
        Expr::Call(name, args) => {
            if is_aggregate(name) {
                let rows = group.ok_or("misuse of aggregate function")?;
                return aggregate(name, args, rows, columns);
            }
            let first = |i: usize| -> Result<Val, String> {
                match args.get(i) { Some(a) => eval(a, row, group, columns), None => Ok(Val::Null) }
            };
            match name.as_str() {
                "UPPER" => Val::Text(first(0)?.text().to_uppercase()),
                "LOWER" => Val::Text(first(0)?.text().to_lowercase()),
                "LENGTH" => Val::Int(first(0)?.text().chars().count() as i64),
                "ABS" => Val::Real(first(0)?.num().abs()),
                "ROUND" => {
                    let places = if args.len() > 1 { first(1)?.num() as i32 } else { 0 };
                    let factor = 10f64.powi(places);
                    Val::Real((first(0)?.num() * factor).round() / factor)
                }
                "TRIM" => Val::Text(first(0)?.text().trim().to_string()),
                "REPLACE" => Val::Text(first(0)?.text().replace(&first(1)?.text(), &first(2)?.text())),
                "SUBSTR" => {
                    let s: Vec<char> = first(0)?.text().chars().collect();
                    let from = (first(1)?.num() as usize).max(1) - 1;
                    let len = if args.len() > 2 { first(2)?.num() as usize } else { s.len() };
                    Val::Text(s.into_iter().skip(from).take(len).collect())
                }
                "COALESCE" | "IFNULL" => {
                    let mut chosen = Val::Null;
                    for a in args {
                        let v = eval(a, row, group, columns)?;
                        if v != Val::Null { chosen = v; break; }
                    }
                    chosen
                }
                "CAST" => first(0)?,
                other => return Err(format!("no such function: {}", other)),
            }
        }
    })
}

fn aggregate(name: &str, args: &[Expr], rows: &[Vec<Val>], columns: &[String]) -> Result<Val, String> {
    let star = matches!(args.first(), Some(Expr::Star)) || args.is_empty();
    let mut values = vec![];
    if !star {
        for r in rows {
            let row = Row { columns, values: r };
            let v = eval(&args[0], &row, None, columns)?;
            if v != Val::Null { values.push(v); }
        }
    }
    Ok(match name {
        "COUNT" => Val::Int(if star { rows.len() as i64 } else { values.len() as i64 }),
        "SUM" | "TOTAL" => {
            if values.is_empty() {
                if name == "TOTAL" { Val::Real(0.0) } else { Val::Null }
            } else {
                let total: f64 = values.iter().map(|v| v.num()).sum();
                if values.iter().all(|v| matches!(v, Val::Int(_))) && name == "SUM" {
                    Val::Int(total as i64)
                } else {
                    Val::Real(total)
                }
            }
        }
        "AVG" => {
            if values.is_empty() { Val::Null }
            else { Val::Real(values.iter().map(|v| v.num()).sum::<f64>() / values.len() as f64) }
        }
        "MIN" => values.into_iter().min_by(|a, b| a.cmp_sql(b)).unwrap_or(Val::Null),
        "MAX" => values.into_iter().max_by(|a, b| a.cmp_sql(b)).unwrap_or(Val::Null),
        "GROUP_CONCAT" => {
            if values.is_empty() { Val::Null }
            else {
                Val::Text(values.iter().map(|v| v.text()).collect::<Vec<_>>().join(","))
            }
        }
        other => return Err(format!("no such aggregate: {}", other)),
    })
}

/// SQL `LIKE`: `%` is any run, `_` is one character, and it is case-insensitive.
fn like_match(text: &str, pattern: &str) -> bool {
    let mut re = String::from("(?is)^");
    for c in pattern.chars() {
        match c {
            '%' => re.push_str(".*"),
            '_' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).map(|r| r.is_match(text)).unwrap_or(false)
}

// ------------------------------------------------------------- statements

struct Output { headers: Vec<String>, rows: Vec<Vec<Val>> }

fn run_statement(db: &mut Db, sql: &str) -> Result<Option<Output>, String> {
    let toks = lex(sql)?;
    let mut p = P { t: toks, i: 0 };
    let verb = p.word().ok_or("empty statement")?;
    p.i += 1;

    match verb.as_str() {
        "CREATE" => {
            p.eat_word("TEMP");
            if !p.eat_word("TABLE") { return Err("only CREATE TABLE is supported".into()); }
            let exists_guard = p.eat_word("IF") && p.eat_word("NOT") && p.eat_word("EXISTS");
            let name = p.ident()?;
            if db.tables.contains_key(&name) {
                if exists_guard { return Ok(None); }
                return Err(format!("table {} already exists", name));
            }
            p.need_sym("(")?;
            let mut columns = vec![];
            loop {
                let col = p.ident()?;
                // The type and any constraints are read and discarded: this
                // engine is untyped, and saying otherwise would be a lie.
                let mut depth = 0;
                loop {
                    match p.peek() {
                        T::Sym(s) if s == "(" => { depth += 1; p.i += 1; }
                        T::Sym(s) if s == ")" && depth > 0 => { depth -= 1; p.i += 1; }
                        T::Sym(s) if (s == "," || s == ")") && depth == 0 => break,
                        T::Eof => break,
                        _ => p.i += 1,
                    }
                }
                columns.push(col);
                if !p.eat_sym(",") { break; }
            }
            p.need_sym(")")?;
            db.tables.insert(name, Table { columns, rows: vec![] });
            Ok(None)
        }
        "DROP" => {
            if !p.eat_word("TABLE") { return Err("only DROP TABLE is supported".into()); }
            let guard = p.eat_word("IF") && p.eat_word("EXISTS");
            let name = p.ident()?;
            if db.tables.remove(&name).is_none() && !guard {
                return Err(format!("no such table: {}", name));
            }
            Ok(None)
        }
        "INSERT" | "REPLACE" => {
            p.eat_word("OR");
            p.eat_word("REPLACE");
            p.eat_word("IGNORE");
            if !p.eat_word("INTO") { return Err("expected INTO".into()); }
            let name = p.ident()?;
            let table = db.tables.get(&name).ok_or(format!("no such table: {}", name))?.clone();

            let mut target = table.columns.clone();
            if p.eat_sym("(") {
                target.clear();
                loop {
                    target.push(p.ident()?);
                    if !p.eat_sym(",") { break; }
                }
                p.need_sym(")")?;
            }
            if !p.eat_word("VALUES") { return Err("expected VALUES".into()); }

            let mut added = vec![];
            loop {
                p.need_sym("(")?;
                let mut values = vec![];
                if !p.eat_sym(")") {
                    loop {
                        let e = p.expr()?;
                        let empty: Vec<Val> = vec![];
                        let row = Row { columns: &[], values: &empty };
                        values.push(eval(&e, &row, None, &[])?);
                        if !p.eat_sym(",") { break; }
                    }
                    p.need_sym(")")?;
                }
                // Positional against the named columns, NULL for the rest.
                let mut full = vec![Val::Null; table.columns.len()];
                for (i, col) in target.iter().enumerate() {
                    if let Some(at) = table.columns.iter().position(|c| c.eq_ignore_ascii_case(col)) {
                        full[at] = values.get(i).cloned().unwrap_or(Val::Null);
                    }
                }
                added.push(full);
                if !p.eat_sym(",") { break; }
            }
            db.tables.get_mut(&name).unwrap().rows.extend(added);
            Ok(None)
        }
        "DELETE" => {
            if !p.eat_word("FROM") { return Err("expected FROM".into()); }
            let name = p.ident()?;
            let table = db.tables.get(&name).ok_or(format!("no such table: {}", name))?.clone();
            let filter = if p.eat_word("WHERE") { Some(p.expr()?) } else { None };
            let columns = table.columns.clone();
            let mut kept = vec![];
            for r in &table.rows {
                let row = Row { columns: &columns, values: r };
                let drop = match &filter {
                    Some(f) => eval(f, &row, None, &columns)?.truthy(),
                    None => true,
                };
                if !drop { kept.push(r.clone()); }
            }
            db.tables.get_mut(&name).unwrap().rows = kept;
            Ok(None)
        }
        "UPDATE" => {
            let name = p.ident()?;
            let table = db.tables.get(&name).ok_or(format!("no such table: {}", name))?.clone();
            if !p.eat_word("SET") { return Err("expected SET".into()); }
            let mut sets = vec![];
            loop {
                let col = p.ident()?;
                p.need_sym("=")?;
                sets.push((col, p.expr()?));
                if !p.eat_sym(",") { break; }
            }
            let filter = if p.eat_word("WHERE") { Some(p.expr()?) } else { None };
            let columns = table.columns.clone();
            let mut rows = table.rows.clone();
            for r in rows.iter_mut() {
                let matched = {
                    let row = Row { columns: &columns, values: r };
                    match &filter {
                        Some(f) => eval(f, &row, None, &columns)?.truthy(),
                        None => true,
                    }
                };
                if !matched { continue; }
                for (col, e) in &sets {
                    let value = {
                        let row = Row { columns: &columns, values: r };
                        eval(e, &row, None, &columns)?
                    };
                    if let Some(at) = columns.iter().position(|c| c.eq_ignore_ascii_case(col)) {
                        r[at] = value;
                    }
                }
            }
            db.tables.get_mut(&name).unwrap().rows = rows;
            Ok(None)
        }
        "SELECT" => select(db, &mut p).map(Some),
        other => Err(format!("unsupported statement: {}", other)),
    }
}

fn select(db: &Db, p: &mut P) -> Result<Output, String> {
    p.eat_word("ALL");
    let distinct = p.eat_word("DISTINCT");

    let mut projection: Vec<(Expr, Option<String>)> = vec![];
    loop {
        let e = p.expr()?;
        let alias = if p.eat_word("AS") { Some(p.ident()?) } else { None };
        projection.push((e, alias));
        if !p.eat_sym(",") { break; }
    }

    let (columns, rows) = if p.eat_word("FROM") {
        let name = p.ident()?;
        let t = db.tables.get(&name).ok_or(format!("no such table: {}", name))?;
        (t.columns.clone(), t.rows.clone())
    } else {
        // `SELECT 1 + 1` with no table: one empty row to evaluate against.
        (vec![], vec![vec![]])
    };

    let filter = if p.eat_word("WHERE") { Some(p.expr()?) } else { None };
    let mut filtered = vec![];
    for r in &rows {
        let row = Row { columns: &columns, values: r };
        let keep = match &filter { Some(f) => eval(f, &row, None, &columns)?.truthy(), None => true };
        if keep { filtered.push(r.clone()); }
    }

    let mut group_by = vec![];
    if p.eat_word("GROUP") {
        if !p.eat_word("BY") { return Err("expected BY".into()); }
        loop {
            group_by.push(p.expr()?);
            if !p.eat_sym(",") { break; }
        }
    }
    let having = if p.eat_word("HAVING") { Some(p.expr()?) } else { None };

    // Expand `*` into the table's columns.
    let mut expanded: Vec<(Expr, Option<String>)> = vec![];
    for (e, alias) in projection.drain(..) {
        if matches!(e, Expr::Star) && !columns.is_empty() {
            for c in &columns { expanded.push((Expr::Col(c.clone()), None)); }
        } else {
            expanded.push((e, alias));
        }
    }
    let projection = expanded;

    let aggregated = projection.iter().any(|(e, _)| has_aggregate(e))
        || having.as_ref().is_some_and(has_aggregate)
        || !group_by.is_empty();

    let headers: Vec<String> = projection
        .iter()
        .map(|(e, alias)| alias.clone().unwrap_or_else(|| describe(e)))
        .collect();

    let mut out_rows: Vec<Vec<Val>> = vec![];
    if aggregated {
        // One group per distinct key, in first-seen order so output is stable.
        let mut order: Vec<String> = vec![];
        let mut groups: HashMap<String, Vec<Vec<Val>>> = HashMap::new();
        for r in &filtered {
            let row = Row { columns: &columns, values: r };
            let mut key = String::new();
            for g in &group_by {
                key.push_str(&eval(g, &row, None, &columns)?.text());
                key.push('\u{1f}');
            }
            if !groups.contains_key(&key) { order.push(key.clone()); }
            groups.entry(key).or_default().push(r.clone());
        }
        if group_by.is_empty() && filtered.is_empty() {
            // `SELECT count(*) FROM empty` is one row of zero, not no rows.
            order.push(String::new());
            groups.insert(String::new(), vec![]);
        }
        for key in order {
            let members = &groups[&key];
            let empty: Vec<Val> = vec![];
            let representative = members.first().unwrap_or(&empty);
            let row = Row { columns: &columns, values: representative };
            let mut values = vec![];
            for (e, _) in &projection {
                values.push(eval(e, &row, Some(members), &columns)?);
            }
            if let Some(h) = &having {
                // The projection is computed first so HAVING can name a
                // select alias — `HAVING total > 1000` — which is what SQL
                // allows and what anyone writes.
                let mut names = columns.clone();
                let mut cells = representative.clone();
                names.extend(headers.iter().cloned());
                cells.extend(values.iter().cloned());
                let combined = Row { columns: &names, values: &cells };
                if !eval(h, &combined, Some(members), &columns)?.truthy() { continue; }
            }
            out_rows.push(values);
        }
    } else {
        for r in &filtered {
            let row = Row { columns: &columns, values: r };
            let mut values = vec![];
            for (e, _) in &projection { values.push(eval(e, &row, None, &columns)?); }
            out_rows.push(values);
        }
    }

    if distinct {
        let mut seen = vec![];
        out_rows.retain(|r| {
            if seen.contains(r) { false } else { seen.push(r.clone()); true }
        });
    }

    if p.eat_word("ORDER") {
        if !p.eat_word("BY") { return Err("expected BY".into()); }
        let mut keys: Vec<(usize, bool)> = vec![];
        loop {
            let e = p.expr()?;
            let descending = if p.eat_word("DESC") { true } else { p.eat_word("ASC"); false };
            // `ORDER BY 2` is positional; a name matches the projection.
            let at = match &e {
                Expr::Lit(Val::Int(n)) => (*n as usize).saturating_sub(1),
                Expr::Col(name) => headers
                    .iter()
                    .position(|h| h.eq_ignore_ascii_case(name))
                    .or_else(|| columns.iter().position(|c| c.eq_ignore_ascii_case(name)))
                    .ok_or(format!("no such column: {}", name))?,
                other => headers.iter().position(|h| *h == describe(other)).unwrap_or(0),
            };
            keys.push((at, descending));
            if !p.eat_sym(",") { break; }
        }
        out_rows.sort_by(|a, b| {
            for (at, descending) in &keys {
                let ordering = a.get(*at).unwrap_or(&Val::Null).cmp_sql(b.get(*at).unwrap_or(&Val::Null));
                let ordering = if *descending { ordering.reverse() } else { ordering };
                if !ordering.is_eq() { return ordering; }
            }
            std::cmp::Ordering::Equal
        });
    }

    let mut limit = usize::MAX;
    let mut offset = 0usize;
    if p.eat_word("LIMIT") {
        limit = match p.expr()? { Expr::Lit(v) => v.num() as usize, _ => usize::MAX };
        if p.eat_word("OFFSET") {
            offset = match p.expr()? { Expr::Lit(v) => v.num() as usize, _ => 0 };
        }
    }
    let out_rows = out_rows.into_iter().skip(offset).take(limit).collect();

    Ok(Output { headers, rows: out_rows })
}

fn describe(e: &Expr) -> String {
    match e {
        Expr::Col(c) | Expr::ColOrText(c) => c.clone(),
        Expr::Call(name, args) => {
            let inner: Vec<String> = args.iter().map(describe).collect();
            format!("{}({})", name.to_lowercase(), inner.join(", "))
        }
        Expr::Star => "*".into(),
        Expr::Lit(v) => v.text(),
        Expr::Bin(op, a, b) => format!("{} {} {}", describe(a), op, describe(b)),
        _ => "expr".into(),
    }
}

// ------------------------------------------------------------ persistence

/// The database file: JSON, not SQLite's format.
///
/// Readable with `cat`, diffable, and — unlike the real format — it survives
/// a filesystem that stores text. Being honest about this in the name of the
/// command is impossible, so the README and `--help` say it instead.
fn save(db: &Db) -> String {
    let mut names: Vec<&String> = db.tables.keys().collect();
    names.sort();
    let mut out = String::from("{\"cloudfarm_sqlite\":1,\"tables\":{");
    for (i, name) in names.iter().enumerate() {
        if i > 0 { out.push(','); }
        let t = &db.tables[*name];
        out.push_str(&format!("{}:{{\"columns\":[", json_str(name)));
        for (j, c) in t.columns.iter().enumerate() {
            if j > 0 { out.push(','); }
            out.push_str(&json_str(c));
        }
        out.push_str("],\"rows\":[");
        for (j, row) in t.rows.iter().enumerate() {
            if j > 0 { out.push(','); }
            out.push('[');
            for (k, v) in row.iter().enumerate() {
                if k > 0 { out.push(','); }
                match v {
                    Val::Null => out.push_str("null"),
                    Val::Int(n) => out.push_str(&n.to_string()),
                    Val::Real(f) => out.push_str(&f.to_string()),
                    Val::Text(s) => out.push_str(&json_str(s)),
                }
            }
            out.push(']');
        }
        out.push_str("]}");
    }
    out.push_str("}}");
    out
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
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

/// Reads back what `save` wrote, via the YAML parser already linked in —
/// JSON is a subset, so it costs nothing to reuse it.
fn load(text: &str) -> Result<Db, String> {
    use saphyr::{Scalar, Yaml};
    if text.trim().is_empty() { return Ok(Db::default()); }
    let docs = saphyr::LoadableYamlNode::load_from_str(text)
        .map_err(|_| "file is not a cloudfarm sqlite database".to_string())?;
    let root = docs.into_iter().next().ok_or("empty database file")?;
    let Yaml::Mapping(top) = &root else { return Err("file is not a database".into()) };

    let tables_node = top
        .iter()
        .find(|(k, _)| matches!(k, Yaml::Value(Scalar::String(s)) if s == "tables"))
        .map(|(_, v)| v)
        .ok_or("file is not a cloudfarm sqlite database")?;
    let Yaml::Mapping(tables) = tables_node else { return Err("bad database file".into()) };

    let mut db = Db::default();
    for (name, body) in tables.iter() {
        let Yaml::Value(Scalar::String(name)) = name else { continue };
        let Yaml::Mapping(fields) = body else { continue };
        let mut table = Table::default();
        for (k, v) in fields.iter() {
            let Yaml::Value(Scalar::String(key)) = k else { continue };
            match (key.as_ref(), v) {
                ("columns", Yaml::Sequence(items)) => {
                    table.columns = items.iter().map(node_text).collect();
                }
                ("rows", Yaml::Sequence(items)) => {
                    for r in items {
                        if let Yaml::Sequence(cells) = r {
                            table.rows.push(cells.iter().map(node_val).collect());
                        }
                    }
                }
                _ => {}
            }
        }
        db.tables.insert(name.to_string(), table);
    }
    Ok(db)
}

fn node_text(n: &saphyr::Yaml) -> String {
    use saphyr::{Scalar, Yaml};
    match n {
        Yaml::Value(Scalar::String(s)) => s.to_string(),
        Yaml::Value(Scalar::Integer(i)) => i.to_string(),
        _ => String::new(),
    }
}

fn node_val(n: &saphyr::Yaml) -> Val {
    use saphyr::{Scalar, Yaml};
    match n {
        Yaml::Value(Scalar::Null) | Yaml::BadValue => Val::Null,
        Yaml::Value(Scalar::Integer(i)) => Val::Int(*i),
        Yaml::Value(Scalar::FloatingPoint(f)) => Val::Real(f.into_inner()),
        Yaml::Value(Scalar::Boolean(b)) => Val::Int(i64::from(*b)),
        Yaml::Value(Scalar::String(s)) => Val::Text(s.to_string()),
        _ => Val::Null,
    }
}

// --------------------------------------------------------------------- cli

/// `sqlite3 [file] [sql]`, plus the dot commands a script uses.
pub fn sqlite3(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "");
    let pos = a.positional();

    if a.has_long("help") {
        out.stdout.extend_from_slice(
            b"Usage: sqlite3 [FILE] [SQL]\n\n\
              A small SQL engine, not SQLite: the file is JSON and cannot be\n\
              opened by the real sqlite3. Supports CREATE TABLE, INSERT,\n\
              SELECT (WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, aggregates),\n\
              UPDATE, DELETE, and .tables/.schema/.headers/.mode/.import.\n\
              No joins, subqueries, indexes or transactions.\n",
        );
        return out;
    }

    // `sqlite3 db.sqlite "sql"`, or SQL on stdin, or `:memory:`.
    let (path, inline) = match pos.len() {
        0 => (None, None),
        1 if pos[0].contains(' ') || pos[0].starts_with('.') => (None, Some(pos[0].clone())),
        1 => (Some(pos[0].clone()), None),
        _ => (Some(pos[0].clone()), Some(pos[1..].join(" "))),
    };

    let full = path.as_ref().filter(|p| *p != ":memory:").map(|p| fs::normalize(ctx.cwd, p));
    let mut db = match &full {
        Some(p) => match ctx.fs.read(p) {
            Ok(d) => match load(&String::from_utf8_lossy(d)) {
                Ok(db) => db,
                Err(e) => { out.err("sqlite3", &e); out.code = 1; return out; }
            },
            Err(_) => Db::default(),
        },
        None => Db::default(),
    };

    let script = match inline {
        Some(s) => s,
        None => String::from_utf8_lossy(ctx.stdin).to_string(),
    };

    let mut headers = false;
    let mut mode = "list".to_string();
    let mut dirty = false;

    for statement in split_statements(&script) {
        let trimmed = statement.trim();
        if trimmed.is_empty() { continue; }

        if let Some(rest) = trimmed.strip_prefix('.') {
            let mut parts = rest.split_whitespace();
            match parts.next().unwrap_or("") {
                "tables" => {
                    let mut names: Vec<&String> = db.tables.keys().collect();
                    names.sort();
                    out.stdout.extend_from_slice(
                        format!("{}\n", names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("  ")).as_bytes());
                }
                "schema" => {
                    let mut names: Vec<&String> = db.tables.keys().collect();
                    names.sort();
                    for n in names {
                        let t = &db.tables[n];
                        out.stdout.extend_from_slice(
                            format!("CREATE TABLE {}({});\n", n, t.columns.join(", ")).as_bytes());
                    }
                }
                "headers" => headers = parts.next() == Some("on"),
                "mode" => mode = parts.next().unwrap_or("list").to_string(),
                "quit" | "exit" => break,
                "import" => {
                    // `.import file table`, the CSV loader scripts use.
                    let (Some(file), Some(table)) = (parts.next(), parts.next()) else {
                        out.err("sqlite3", "Usage: .import FILE TABLE");
                        out.code = 1;
                        continue;
                    };
                    let p = fs::normalize(ctx.cwd, file);
                    let Ok(data) = ctx.fs.read(&p) else {
                        out.err("sqlite3", &format!("cannot open {}", file));
                        out.code = 1;
                        continue;
                    };
                    let text = String::from_utf8_lossy(data).to_string();
                    let mut lines = text.lines();
                    let entry = db.tables.entry(table.to_string()).or_default();
                    if entry.columns.is_empty() {
                        if let Some(first) = lines.next() {
                            entry.columns = first.split(',').map(|s| s.trim().to_string()).collect();
                        }
                    }
                    for line in lines {
                        if line.trim().is_empty() { continue; }
                        entry.rows.push(line.split(',').map(|c| Val::parse(c.trim())).collect());
                    }
                    dirty = true;
                }
                other => {
                    out.err("sqlite3", &format!("unknown command: .{}", other));
                    out.code = 1;
                }
            }
            continue;
        }

        match run_statement(&mut db, trimmed) {
            Ok(Some(result)) => {
                if headers && !result.headers.is_empty() {
                    emit(&result.headers, &mode, &mut out.stdout);
                }
                for row in &result.rows {
                    let cells: Vec<String> = row.iter().map(|v| v.text()).collect();
                    emit(&cells, &mode, &mut out.stdout);
                }
            }
            Ok(None) => dirty = true,
            Err(e) => {
                out.stderr.extend_from_slice(format!("Parse error: {}\n", e).as_bytes());
                out.code = 1;
                return out;
            }
        }
    }

    if dirty {
        if let Some(p) = &full {
            if let Err(e) = ctx.fs.write(p, save(&db).as_bytes(), false) {
                out.err("sqlite3", &e);
                out.code = 1;
            }
        }
    }
    out
}

fn emit(cells: &[String], mode: &str, out: &mut Vec<u8>) {
    let line = match mode {
        "csv" => cells
            .iter()
            .map(|c| if c.contains([',', '"']) { format!("\"{}\"", c.replace('"', "\"\"")) } else { c.clone() })
            .collect::<Vec<_>>()
            .join(","),
        "tabs" => cells.join("\t"),
        "line" => return {
            for c in cells { out.extend_from_slice(format!("{}\n", c).as_bytes()); }
        },
        "column" => cells.iter().map(|c| format!("{:<14}", c)).collect::<Vec<_>>().join("").trim_end().to_string(),
        _ => cells.join("|"),
    };
    out.extend_from_slice(line.as_bytes());
    out.push(b'\n');
}

/// Splits on `;` outside string literals.
fn split_statements(script: &str) -> Vec<String> {
    let mut out = vec![];
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = script.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), _) if c == q => {
                current.push(c);
                if chars.peek() == Some(&q) { current.push(chars.next().unwrap()); } else { quote = None; }
            }
            (Some(_), _) => current.push(c),
            (None, '\'' | '"') => { quote = Some(c); current.push(c); }
            (None, ';') => out.push(std::mem::take(&mut current)),
            // A dot command is its own line, with no semicolon.
            (None, '\n') if current.trim_start().starts_with('.') => {
                out.push(std::mem::take(&mut current));
            }
            (None, _) => current.push(c),
        }
    }
    out.push(current);
    out
}
