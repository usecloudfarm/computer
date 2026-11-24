//! Tree-walking interpreter over brush-parser's AST.
//!
//! Design notes:
//! - No processes. Every command is a Rust function; pipelines are wired
//!   in-process by passing one stage's stdout buffer as the next stage's stdin.
//! - All state (vars, functions, cwd, fs) lives in `Shell`, so one WASM
//!   instance can host many independent shells.
//! - Hard limits (steps, loop iterations, recursion depth, output bytes) are
//!   enforced here, not trusted to individual commands.

use std::collections::{HashMap, HashSet};

use brush_parser::ast::{self, *};
use brush_parser::word::{
    self, BraceExpressionMember, BraceExpressionOrText, Parameter, ParameterExpr,
    ParameterTestType, ParameterTransformOp, SpecialParameter, SubstringMatchKind, TildeExpr,
    WordPiece, WordPieceWithSource,
};
use brush_parser::{ParserOptions, arithmetic};

use crate::commands;
use crate::fs::{self, MemFs};

#[derive(Default, Debug)]
pub struct Out {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Flow {
    Normal,
    Break(u32),
    Continue(u32),
    Return,
    Exit,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_steps: u64,
    pub max_loop_iterations: u64,
    pub max_call_depth: u32,
    pub max_output_bytes: usize,
    pub max_string_bytes: usize,
    pub max_brace_expansion: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_steps: 1_000_000,
            max_loop_iterations: 100_000,
            max_call_depth: 200,
            max_output_bytes: 32 * 1024 * 1024,
            max_string_bytes: 16 * 1024 * 1024,
            max_brace_expansion: 100_000,
        }
    }
}

pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Clone)]
struct Saved {
    vars: HashMap<String, String>,
    exported: HashSet<String>,
    cwd: String,
    positional: Vec<String>,
    functions: HashMap<String, FunctionBody>,
}

pub struct Shell {
    pub fs: MemFs,
    pub vars: HashMap<String, String>,
    pub exported: HashSet<String>,
    pub cwd: String,
    pub last_status: i32,
    pub limits: Limits,
    functions: HashMap<String, FunctionBody>,
    positional: Vec<String>,
    locals: Vec<HashMap<String, Option<String>>>,
    depth: u32,
    steps: u64,
    opts: ParserOptions,
    /// Set when a limit trips; aborts the whole script.
    fatal: Option<String>,
    /// Exit status of the most recent command substitution (for `x=$(false)`).
    last_subst: Option<i32>,
    /// Read offsets into stdin buffers, so `while read` consumes input.
    stdin_pos: HashMap<(usize, usize), usize>,
    /// `alias ll='ls -la'`. Expanded at the command position only, as in bash.
    aliases: HashMap<String, String>,
    /// Every script handed to `exec`, for `history`.
    history: Vec<String>,
    /// Requests made and responses held, for `curl`. See `crate::net`.
    pub net: crate::net::Net,
}

/// A point a suspended run can be restarted from.
pub struct Checkpoint {
    fs: MemFs,
    vars: HashMap<String, String>,
    exported: HashSet<String>,
    cwd: String,
    functions: HashMap<String, FunctionBody>,
    aliases: HashMap<String, String>,
    last_status: i32,
}

fn buf_key(b: &[u8]) -> (usize, usize) {
    (b.as_ptr() as usize, b.len())
}

/// One piece of an expanded word, tracking whether it was quoted (affects
/// field splitting and globbing).
#[derive(Debug, Clone)]
enum Seg {
    Lit { text: String, quoted: bool, split: bool },
    FieldBreak,
}

impl Default for Shell {
    fn default() -> Self {
        Self::new()
    }
}

impl Shell {
    pub fn new() -> Self {
        let mut vars = HashMap::new();
        for (k, v) in [
            ("HOME", "/home/user"),
            ("PATH", "/usr/bin:/bin"),
            ("USER", "user"),
            ("SHELL", "/bin/bash"),
            ("PWD", "/home/user"),
            ("IFS", " \t\n"),
        ] {
            vars.insert(k.to_string(), v.to_string());
        }
        let exported = ["HOME", "PATH", "USER", "SHELL", "PWD"].iter().map(|s| s.to_string()).collect();
        Shell {
            fs: MemFs::new(),
            vars,
            exported,
            cwd: "/home/user".into(),
            last_status: 0,
            limits: Limits::default(),
            functions: HashMap::new(),
            positional: vec![],
            locals: vec![],
            depth: 0,
            steps: 0,
            opts: ParserOptions::default(),
            fatal: None,
            last_subst: None,
            stdin_pos: HashMap::new(),
            aliases: HashMap::new(),
            history: Vec::new(),
            net: crate::net::Net::default(),
        }
    }

    // ---------------------------------------------------------------- entry

    pub fn exec(&mut self, script: &str) -> ExecResult {
        // One entry per call, which is what a line at a prompt would be.
        // Bounded, so a long-lived shell does not grow without limit.
        let trimmed = script.trim();
        if !trimmed.is_empty() {
            self.history.push(trimmed.to_string());
            if self.history.len() > 1000 { self.history.remove(0); }
        }
        self.steps = 0;
        self.fatal = None;
        self.stdin_pos.clear();
        let mut out = Out::default();
        let flow = self.run_script(script, &[], &mut out);
        if let Some(msg) = self.fatal.take() {
            // A suspension is not a failure; the caller handles it.
            if msg == crate::net::SUSPEND {
                return ExecResult {
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    exit_code: self.last_status,
                };
            }
            out.stderr.extend_from_slice(format!("bash: {}\n", msg).as_bytes());
            if self.last_status == 0 {
                self.last_status = 1;
            }
        }
        let _ = flow;
        ExecResult {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: self.last_status,
        }
    }

    /// Whether a name is one of the network commands, and reachable.
    fn networked(&self, name: &str) -> bool {
        self.net.enabled && matches!(name, "curl" | "wget")
    }

    /// Everything an attempt can change, so a suspended run can be rolled
    /// back before the next one. The response record is deliberately not in
    /// here: it is what carries forward.
    pub fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            fs: self.fs.clone(),
            vars: self.vars.clone(),
            exported: self.exported.clone(),
            cwd: self.cwd.clone(),
            functions: self.functions.clone(),
            aliases: self.aliases.clone(),
            last_status: self.last_status,
        }
    }

    pub fn rewind(&mut self, saved: Checkpoint) {
        self.fs = saved.fs;
        self.vars = saved.vars;
        self.exported = saved.exported;
        self.cwd = saved.cwd;
        self.functions = saved.functions;
        self.aliases = saved.aliases;
        self.last_status = saved.last_status;
        self.net.rewind();
    }

    pub fn run_script(&mut self, script: &str, stdin: &[u8], out: &mut Out) -> Flow {
        let mut parser = brush_parser::Parser::new(std::io::Cursor::new(script), &self.opts);
        let program = match parser.parse_program() {
            Ok(p) => p,
            Err(e) => {
                out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                self.last_status = 2;
                return Flow::Normal;
            }
        };
        for cc in &program.complete_commands {
            let f = self.exec_list(cc, stdin, out);
            if f != Flow::Normal || self.fatal.is_some() {
                return f;
            }
        }
        Flow::Normal
    }

    fn check_output(&mut self, out: &Out) {
        if out.stdout.len() + out.stderr.len() > self.limits.max_output_bytes {
            self.fatal = Some("output limit exceeded".into());
        }
    }

    // ------------------------------------------------------------ structure

    fn exec_list(&mut self, list: &CompoundList, stdin: &[u8], out: &mut Out) -> Flow {
        for CompoundListItem(and_or, _sep) in &list.0 {
            let f = self.exec_and_or(and_or, stdin, out);
            if f != Flow::Normal || self.fatal.is_some() {
                return f;
            }
        }
        Flow::Normal
    }

    fn exec_and_or(&mut self, list: &AndOrList, stdin: &[u8], out: &mut Out) -> Flow {
        let f = self.exec_pipeline(&list.first, stdin, out);
        if f != Flow::Normal {
            return f;
        }
        for item in &list.additional {
            let (run, p) = match item {
                AndOr::And(p) => (self.last_status == 0, p),
                AndOr::Or(p) => (self.last_status != 0, p),
            };
            if run {
                let f = self.exec_pipeline(p, stdin, out);
                if f != Flow::Normal {
                    return f;
                }
            }
        }
        Flow::Normal
    }

    fn exec_pipeline(&mut self, p: &Pipeline, stdin: &[u8], out: &mut Out) -> Flow {
        let flow = if p.seq.len() == 1 {
            self.exec_command(&p.seq[0], stdin, out)
        } else {
            let mut input = stdin.to_vec();
            let mut flow = Flow::Normal;
            for (i, cmd) in p.seq.iter().enumerate() {
                let mut stage = Out::default();
                self.stdin_pos.remove(&buf_key(&input));
                flow = self.exec_command(cmd, &input, &mut stage);
                out.stderr.extend_from_slice(&stage.stderr);
                if i == p.seq.len() - 1 {
                    out.stdout.extend_from_slice(&stage.stdout);
                } else {
                    input = stage.stdout;
                }
                if self.fatal.is_some() {
                    break;
                }
                // `exit` inside a pipeline stage only ends that stage.
                if flow == Flow::Exit {
                    flow = Flow::Normal;
                }
            }
            flow
        };
        if p.bang {
            self.last_status = if self.last_status == 0 { 1 } else { 0 };
        }
        self.check_output(out);
        flow
    }

    fn exec_command(&mut self, cmd: &Command, stdin: &[u8], out: &mut Out) -> Flow {
        match cmd {
            Command::Simple(sc) => self.exec_simple(sc, stdin, out),
            Command::Compound(cc, redirs) => {
                let redirs: Vec<IoRedirect> = redirs.as_ref().map(|r| r.0.clone()).unwrap_or_default();
                self.with_redirects(&redirs, stdin, out, |sh, input, o| sh.exec_compound(cc, input, o))
            }
            Command::Function(def) => {
                self.functions.insert(def.fname.value.clone(), def.body.clone());
                self.last_status = 0;
                Flow::Normal
            }
            Command::ExtendedTest(t, redirs) => {
                let redirs: Vec<IoRedirect> = redirs.as_ref().map(|r| r.0.clone()).unwrap_or_default();
                self.with_redirects(&redirs, stdin, out, |sh, _input, o| {
                    let ok = sh.eval_ext_test(&t.expr, o);
                    sh.last_status = if ok { 0 } else { 1 };
                    Flow::Normal
                })
            }
        }
    }

    fn exec_compound(&mut self, cc: &CompoundCommand, stdin: &[u8], out: &mut Out) -> Flow {
        match cc {
            CompoundCommand::BraceGroup(g) => self.exec_list(&g.list, stdin, out),
            CompoundCommand::Subshell(s) => {
                let saved = self.save();
                let f = self.exec_list(&s.list, stdin, out);
                self.restore(saved);
                match f {
                    Flow::Exit | Flow::Return => Flow::Normal,
                    other => other,
                }
            }
            CompoundCommand::IfClause(c) => {
                let f = self.exec_list(&c.condition, stdin, out);
                if f != Flow::Normal {
                    return f;
                }
                if self.last_status == 0 {
                    return self.exec_list(&c.then, stdin, out);
                }
                if let Some(elses) = &c.elses {
                    for e in elses {
                        match &e.condition {
                            Some(cond) => {
                                let f = self.exec_list(cond, stdin, out);
                                if f != Flow::Normal {
                                    return f;
                                }
                                if self.last_status == 0 {
                                    return self.exec_list(&e.body, stdin, out);
                                }
                            }
                            None => return self.exec_list(&e.body, stdin, out),
                        }
                    }
                }
                self.last_status = 0;
                Flow::Normal
            }
            CompoundCommand::ForClause(f) => {
                let values: Vec<String> = match &f.values {
                    Some(words) => {
                        let mut v = vec![];
                        for w in words {
                            v.extend(self.expand_fields(&w.value, out));
                        }
                        v
                    }
                    None => self.positional.clone(),
                };
                self.last_status = 0;
                let mut iters = 0u64;
                for val in values {
                    iters += 1;
                    if iters > self.limits.max_loop_iterations {
                        self.fatal = Some("loop iteration limit exceeded".into());
                        return Flow::Normal;
                    }
                    self.set_var(&f.variable_name, val);
                    match self.exec_list(&f.body.list, stdin, out) {
                        Flow::Normal => {}
                        Flow::Break(n) => {
                            if n > 1 {
                                return Flow::Break(n - 1);
                            }
                            break;
                        }
                        Flow::Continue(n) => {
                            if n > 1 {
                                return Flow::Continue(n - 1);
                            }
                        }
                        other => return other,
                    }
                    if self.fatal.is_some() {
                        break;
                    }
                }
                Flow::Normal
            }
            CompoundCommand::WhileClause(w) | CompoundCommand::UntilClause(w) => {
                let is_until = matches!(cc, CompoundCommand::UntilClause(_));
                let mut iters = 0u64;
                let mut body_status = 0;
                loop {
                    iters += 1;
                    if iters > self.limits.max_loop_iterations {
                        self.fatal = Some("loop iteration limit exceeded".into());
                        return Flow::Normal;
                    }
                    let f = self.exec_list(&w.0, stdin, out);
                    if f != Flow::Normal {
                        return f;
                    }
                    let ok = self.last_status == 0;
                    if ok == is_until {
                        break;
                    }
                    match self.exec_list(&w.1.list, stdin, out) {
                        Flow::Normal => {}
                        Flow::Break(n) => {
                            if n > 1 {
                                return Flow::Break(n - 1);
                            }
                            body_status = self.last_status;
                            break;
                        }
                        Flow::Continue(n) => {
                            if n > 1 {
                                return Flow::Continue(n - 1);
                            }
                        }
                        other => return other,
                    }
                    body_status = self.last_status;
                    if self.fatal.is_some() {
                        break;
                    }
                }
                self.last_status = body_status;
                Flow::Normal
            }
            CompoundCommand::CaseClause(c) => {
                let value = self.expand_single(&c.value.value, out);
                self.last_status = 0;
                let mut fallthrough = false;
                for item in &c.cases {
                    let matched = fallthrough
                        || item.patterns.iter().any(|p| {
                            let pat = self.expand_pattern(&p.value, out);
                            glob_match(&pat, &value)
                        });
                    if !matched {
                        continue;
                    }
                    if let Some(cmd) = &item.cmd {
                        let f = self.exec_list(cmd, stdin, out);
                        if f != Flow::Normal {
                            return f;
                        }
                    }
                    match item.post_action {
                        CaseItemPostAction::ExitCase => break,
                        CaseItemPostAction::UnconditionallyExecuteNextCaseItem => fallthrough = true,
                        CaseItemPostAction::ContinueEvaluatingCases => fallthrough = false,
                    }
                }
                Flow::Normal
            }
            CompoundCommand::Arithmetic(a) => {
                match self.eval_arith_str(&a.expr.value, out) {
                    Ok(v) => self.last_status = if v != 0 { 0 } else { 1 },
                    Err(e) => {
                        out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                        self.last_status = 1;
                    }
                }
                Flow::Normal
            }
            CompoundCommand::ArithmeticForClause(f) => {
                if let Some(init) = &f.initializer {
                    let _ = self.eval_arith_str(&init.value, out);
                }
                let mut iters = 0u64;
                loop {
                    iters += 1;
                    if iters > self.limits.max_loop_iterations {
                        self.fatal = Some("loop iteration limit exceeded".into());
                        return Flow::Normal;
                    }
                    if let Some(cond) = &f.condition {
                        match self.eval_arith_str(&cond.value, out) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(e) => {
                                out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                                break;
                            }
                        }
                    }
                    match self.exec_list(&f.body.list, stdin, out) {
                        Flow::Normal => {}
                        Flow::Break(n) => {
                            if n > 1 {
                                return Flow::Break(n - 1);
                            }
                            break;
                        }
                        Flow::Continue(n) => {
                            if n > 1 {
                                return Flow::Continue(n - 1);
                            }
                        }
                        other => return other,
                    }
                    if let Some(upd) = &f.updater {
                        let _ = self.eval_arith_str(&upd.value, out);
                    }
                    if self.fatal.is_some() {
                        break;
                    }
                }
                Flow::Normal
            }
            CompoundCommand::Coprocess(_) => {
                out.stderr.extend_from_slice(b"bash: coproc: not supported\n");
                self.last_status = 1;
                Flow::Normal
            }
        }
    }

    fn save(&self) -> Saved {
        Saved {
            vars: self.vars.clone(),
            exported: self.exported.clone(),
            cwd: self.cwd.clone(),
            positional: self.positional.clone(),
            functions: self.functions.clone(),
        }
    }
    fn restore(&mut self, s: Saved) {
        let status = self.last_status;
        self.vars = s.vars;
        self.exported = s.exported;
        self.cwd = s.cwd;
        self.positional = s.positional;
        self.functions = s.functions;
        self.last_status = status;
    }

    // ------------------------------------------------------- simple command

    fn exec_simple(&mut self, sc: &SimpleCommand, stdin: &[u8], out: &mut Out) -> Flow {
        self.steps += 1;
        if self.steps > self.limits.max_steps {
            self.fatal = Some("command step limit exceeded".into());
            return Flow::Normal;
        }
        let mut assigns: Vec<&Assignment> = vec![];
        let mut redirs: Vec<IoRedirect> = vec![];
        let mut words: Vec<&ast::Word> = vec![];
        if let Some(prefix) = &sc.prefix {
            for item in &prefix.0 {
                match item {
                    CommandPrefixOrSuffixItem::AssignmentWord(a, _) => assigns.push(a),
                    CommandPrefixOrSuffixItem::IoRedirect(r) => redirs.push(r.clone()),
                    CommandPrefixOrSuffixItem::Word(w) => words.push(w),
                    CommandPrefixOrSuffixItem::ProcessSubstitution(..) => {}
                }
            }
        }
        if let Some(w) = &sc.word_or_name {
            words.push(w);
        }
        if let Some(suffix) = &sc.suffix {
            for item in &suffix.0 {
                match item {
                    CommandPrefixOrSuffixItem::AssignmentWord(_, w) => words.push(w),
                    CommandPrefixOrSuffixItem::IoRedirect(r) => redirs.push(r.clone()),
                    CommandPrefixOrSuffixItem::Word(w) => words.push(w),
                    CommandPrefixOrSuffixItem::ProcessSubstitution(..) => {}
                }
            }
        }

        self.last_subst = None;
        let mut argv: Vec<String> = vec![];
        for w in &words {
            argv.extend(self.expand_fields(&w.value, out));
        }

        if argv.is_empty() {
            for a in &assigns {
                let v = self.assignment_value(a, out);
                let name = assignment_name(a);
                if a.append {
                    let cur = self.get_var(&name).unwrap_or_default();
                    self.set_var(&name, cur + &v);
                } else {
                    self.set_var(&name, v);
                }
            }
            let subst_status = self.last_subst.take().unwrap_or(0);
            return self.with_redirects(&redirs, stdin, out, |sh, _i, _o| {
                sh.last_status = subst_status;
                Flow::Normal
            });
        }

        // Prefix assignments apply only for the duration of this command.
        let mut restore: Vec<(String, Option<String>)> = vec![];
        for a in &assigns {
            let v = self.assignment_value(a, out);
            let name = assignment_name(a);
            restore.push((name.clone(), self.vars.get(&name).cloned()));
            self.vars.insert(name, v);
        }
        let flow = self.with_redirects(&redirs, stdin, out, |sh, input, o| sh.run_argv(&argv, input, o));
        for (k, v) in restore {
            match v {
                Some(v) => {
                    self.vars.insert(k, v);
                }
                None => {
                    self.vars.remove(&k);
                }
            }
        }
        flow
    }

    fn assignment_value(&mut self, a: &Assignment, out: &mut Out) -> String {
        match &a.value {
            AssignmentValue::Scalar(w) => self.expand_single(&w.value, out),
            AssignmentValue::Array(items) => {
                // Arrays are flattened to a space-joined scalar in this spike.
                let mut parts = vec![];
                for (_, w) in items {
                    parts.extend(self.expand_fields(&w.value, out));
                }
                parts.join(" ")
            }
        }
    }

    // -------------------------------------------------------- redirections

    fn with_redirects<F>(&mut self, redirs: &[IoRedirect], stdin: &[u8], out: &mut Out, f: F) -> Flow
    where
        F: FnOnce(&mut Self, &[u8], &mut Out) -> Flow,
    {
        if redirs.is_empty() {
            return f(self, stdin, out);
        }
        #[derive(Clone)]
        enum Dest {
            Out,
            Err,
            File(String),
            Null,
        }
        let mut input: Option<Vec<u8>> = None;
        let mut d1 = Dest::Out;
        let mut d2 = Dest::Err;
        for r in redirs {
            match r {
                IoRedirect::File(fd, kind, target) => {
                    let fd = fd.unwrap_or(match kind {
                        IoFileRedirectKind::Read | IoFileRedirectKind::DuplicateInput => 0,
                        _ => 1,
                    });
                    match kind {
                        IoFileRedirectKind::Read | IoFileRedirectKind::ReadAndWrite => {
                            if let IoFileRedirectTarget::Filename(w) = target {
                                let raw = self.expand_single(&w.value, out);
                                let p = fs::normalize(&self.cwd, &raw);
                                match self.fs.read(&p) {
                                    Ok(d) => input = Some(d.to_vec()),
                                    Err(e) => {
                                        out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                                        self.last_status = 1;
                                        return Flow::Normal;
                                    }
                                }
                            }
                        }
                        IoFileRedirectKind::Write | IoFileRedirectKind::Clobber | IoFileRedirectKind::Append => {
                            let w = match target {
                                IoFileRedirectTarget::Filename(w) => w,
                                _ => continue,
                            };
                            let raw = self.expand_single(&w.value, out);
                            let dest = if raw == "/dev/null" {
                                Dest::Null
                            } else {
                                let p = fs::normalize(&self.cwd, &raw);
                                let append = matches!(kind, IoFileRedirectKind::Append);
                                let res = if append && self.fs.exists(&p) {
                                    Ok(())
                                } else {
                                    self.fs.write(&p, b"", false)
                                };
                                if let Err(e) = res {
                                    out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                                    self.last_status = 1;
                                    return Flow::Normal;
                                }
                                Dest::File(p)
                            };
                            if fd == 2 { d2 = dest } else { d1 = dest }
                        }
                        IoFileRedirectKind::DuplicateOutput => {
                            let target_fd = match target {
                                IoFileRedirectTarget::Fd(n) => Some(*n),
                                IoFileRedirectTarget::Duplicate(w) => self.expand_single(&w.value, out).parse().ok(),
                                _ => None,
                            };
                            match (fd, target_fd) {
                                (2, Some(1)) => d2 = d1.clone(),
                                (1, Some(2)) => d1 = d2.clone(),
                                _ => {}
                            }
                        }
                        IoFileRedirectKind::DuplicateInput => {}
                    }
                }
                IoRedirect::HereDocument(_, doc) => {
                    let body = if doc.requires_expansion {
                        self.expand_heredoc(&doc.doc.value, out)
                    } else {
                        doc.doc.value.clone()
                    };
                    let body = if doc.remove_tabs {
                        body.lines().map(|l| l.trim_start_matches('\t')).collect::<Vec<_>>().join("\n") + "\n"
                    } else {
                        body
                    };
                    input = Some(body.into_bytes());
                }
                IoRedirect::HereString(_, w) => {
                    let mut s = self.expand_single(&w.value, out);
                    s.push('\n');
                    input = Some(s.into_bytes());
                }
                IoRedirect::OutputAndError(w, append) => {
                    let raw = self.expand_single(&w.value, out);
                    if raw == "/dev/null" {
                        d1 = Dest::Null;
                        d2 = Dest::Null;
                    } else {
                        let p = fs::normalize(&self.cwd, &raw);
                        if !(*append && self.fs.exists(&p)) {
                            if let Err(e) = self.fs.write(&p, b"", false) {
                                out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                                self.last_status = 1;
                                return Flow::Normal;
                            }
                        }
                        d1 = Dest::File(p.clone());
                        d2 = Dest::File(p);
                    }
                }
            }
        }
        let mut tmp = Out::default();
        if let Some(i) = &input {
            self.stdin_pos.remove(&buf_key(i));
        }
        let input_ref: &[u8] = input.as_deref().unwrap_or(stdin);
        let flow = f(self, input_ref, &mut tmp);
        for (data, dest) in [(tmp.stdout, d1), (tmp.stderr, d2)] {
            match dest {
                Dest::Out => out.stdout.extend_from_slice(&data),
                Dest::Err => out.stderr.extend_from_slice(&data),
                Dest::Null => {}
                Dest::File(p) => {
                    if let Err(e) = self.fs.write(&p, &data, true) {
                        out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                    }
                }
            }
        }
        flow
    }

    // ---------------------------------------------------------- dispatching

    pub fn run_argv(&mut self, argv: &[String], stdin: &[u8], out: &mut Out) -> Flow {
        // Aliases expand at the command position only, and not recursively
        // past the first hop — which is bash's rule and also what stops
        // `alias ls='ls -la'` looping forever.
        let expanded;
        let argv = match self.aliases.get(argv[0].as_str()) {
            Some(body) => {
                let mut words: Vec<String> = split_words(body);
                if words.first().map(|w| w.as_str()) == Some(argv[0].as_str()) && words.len() == 1 {
                    argv.to_vec()
                } else {
                    words.extend_from_slice(&argv[1..]);
                    expanded = words;
                    expanded.clone()
                }
            }
            None => argv.to_vec(),
        };
        let argv = &argv[..];
        let name = argv[0].as_str();
        let args = &argv[1..];

        if let Some(body) = self.functions.get(name).cloned() {
            if self.depth >= self.limits.max_call_depth {
                self.fatal = Some("maximum function call depth exceeded".into());
                return Flow::Normal;
            }
            self.depth += 1;
            let saved_pos = std::mem::replace(&mut self.positional, args.to_vec());
            self.locals.push(HashMap::new());
            let redirs: Vec<IoRedirect> = body.1.as_ref().map(|r| r.0.clone()).unwrap_or_default();
            let flow = self.with_redirects(&redirs, stdin, out, |sh, input, o| sh.exec_compound(&body.0, input, o));
            if let Some(frame) = self.locals.pop() {
                for (k, v) in frame {
                    match v {
                        Some(v) => {
                            self.vars.insert(k, v);
                        }
                        None => {
                            self.vars.remove(&k);
                        }
                    }
                }
            }
            self.positional = saved_pos;
            self.depth -= 1;
            return match flow {
                Flow::Return => Flow::Normal,
                other => other,
            };
        }

        match name {
            ":" | "true" => self.last_status = 0,
            "false" => self.last_status = 1,
            "cd" => {
                let target = match args.first().map(|s| s.as_str()) {
                    None | Some("~") => self.get_var("HOME").unwrap_or("/".into()),
                    Some("-") => self.get_var("OLDPWD").unwrap_or(self.cwd.clone()),
                    Some(p) => p.to_string(),
                };
                let p = fs::normalize(&self.cwd, &target);
                if self.fs.is_dir(&p) {
                    let old = std::mem::replace(&mut self.cwd, p.clone());
                    self.set_var("OLDPWD", old);
                    self.set_var("PWD", p);
                    self.last_status = 0;
                } else {
                    out.stderr.extend_from_slice(format!("bash: cd: {}: No such file or directory\n", target).as_bytes());
                    self.last_status = 1;
                }
            }
            "pwd" => {
                out.stdout.extend_from_slice(format!("{}\n", self.cwd).as_bytes());
                self.last_status = 0;
            }
            "export" => {
                for a in args {
                    if let Some((k, v)) = a.split_once('=') {
                        self.set_var(k, v.to_string());
                        self.exported.insert(k.to_string());
                    } else if a != "-n" && a != "-p" {
                        self.exported.insert(a.clone());
                    }
                }
                if args.is_empty() || args[0] == "-p" {
                    let mut keys: Vec<_> = self.exported.iter().cloned().collect();
                    keys.sort();
                    for k in keys {
                        if let Some(v) = self.vars.get(&k) {
                            out.stdout.extend_from_slice(format!("declare -x {}=\"{}\"\n", k, v).as_bytes());
                        }
                    }
                }
                self.last_status = 0;
            }
            "unset" => {
                for a in args.iter().filter(|a| !a.starts_with('-')) {
                    self.vars.remove(a);
                    self.functions.remove(a);
                    self.exported.remove(a);
                }
                self.last_status = 0;
            }
            "local" | "declare" | "typeset" | "readonly" => {
                for a in args.iter().filter(|a| !a.starts_with('-')) {
                    let (k, v) = match a.split_once('=') {
                        Some((k, v)) => (k.to_string(), Some(v.to_string())),
                        None => (a.clone(), None),
                    };
                    if name == "local" || (name == "declare" && !self.locals.is_empty()) {
                        if let Some(frame) = self.locals.last_mut() {
                            if !frame.contains_key(&k) {
                                frame.insert(k.clone(), self.vars.get(&k).cloned());
                            }
                        }
                    }
                    match v {
                        Some(v) => {
                            self.vars.insert(k, v);
                        }
                        None => {
                            self.vars.entry(k).or_default();
                        }
                    }
                }
                self.last_status = 0;
            }
            "set" => {
                if let Some(pos) = args.iter().position(|a| a == "--") {
                    self.positional = args[pos + 1..].to_vec();
                }
                self.last_status = 0;
            }
            "shift" => {
                let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
                if n <= self.positional.len() {
                    self.positional.drain(..n);
                    self.last_status = 0;
                } else {
                    self.last_status = 1;
                }
            }
            "exit" => {
                self.last_status = args.first().and_then(|s| s.parse().ok()).unwrap_or(self.last_status);
                return Flow::Exit;
            }
            "return" => {
                self.last_status = args.first().and_then(|s| s.parse().ok()).unwrap_or(self.last_status);
                return Flow::Return;
            }
            "break" => {
                self.last_status = 0;
                return Flow::Break(args.first().and_then(|s| s.parse().ok()).unwrap_or(1));
            }
            "continue" => {
                self.last_status = 0;
                return Flow::Continue(args.first().and_then(|s| s.parse().ok()).unwrap_or(1));
            }
            "test" | "[" => {
                let mut a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                if name == "[" {
                    if a.last() != Some(&"]") {
                        out.stderr.extend_from_slice(b"bash: [: missing `]'\n");
                        self.last_status = 2;
                        return Flow::Normal;
                    }
                    a.pop();
                }
                self.last_status = match self.eval_test(&a) {
                    Ok(true) => 0,
                    Ok(false) => 1,
                    Err(e) => {
                        out.stderr.extend_from_slice(format!("bash: test: {}\n", e).as_bytes());
                        2
                    }
                };
            }
            "read" => {
                let mut raw = false;
                let mut names = vec![];
                for a in args {
                    match a.as_str() {
                        "-r" => raw = true,
                        s if s.starts_with('-') => {}
                        s => names.push(s.to_string()),
                    }
                }
                let _ = raw;
                if names.is_empty() {
                    names.push("REPLY".into());
                }
                let key = buf_key(stdin);
                let pos = *self.stdin_pos.get(&key).unwrap_or(&0);
                let rest = &stdin[pos.min(stdin.len())..];
                let (line_bytes, consumed) = match rest.iter().position(|&b| b == b'\n') {
                    Some(i) => (&rest[..i], i + 1),
                    None => (rest, rest.len()),
                };
                self.stdin_pos.insert(key, pos + consumed);
                let text = String::from_utf8_lossy(line_bytes);
                let line_opt = if rest.is_empty() { None } else { Some(text.as_ref()) };
                match line_opt {
                    None => {
                        for n in &names {
                            self.set_var(n, String::new());
                        }
                        self.last_status = 1;
                    }
                    Some(line) => {
                        let mut parts: Vec<&str> = line.split_whitespace().collect();
                        for (i, n) in names.iter().enumerate() {
                            if i == names.len() - 1 {
                                let rest = if parts.len() > i { parts[i..].join(" ") } else { String::new() };
                                self.set_var(n, rest);
                            } else {
                                self.set_var(n, if parts.len() > i { parts[i].to_string() } else { String::new() });
                            }
                        }
                        parts.clear();
                        self.last_status = 0;
                    }
                }
            }
            "eval" => {
                let script = args.join(" ");
                return self.run_script(&script, stdin, out);
            }
            "source" | "." => {
                let Some(file) = args.first() else {
                    self.last_status = 2;
                    return Flow::Normal;
                };
                let p = fs::normalize(&self.cwd, file);
                match self.fs.read(&p) {
                    Ok(d) => {
                        let script = String::from_utf8_lossy(d).into_owned();
                        let f = self.run_script(&script, stdin, out);
                        return if f == Flow::Return { Flow::Normal } else { f };
                    }
                    Err(e) => {
                        out.stderr.extend_from_slice(format!("bash: {}\n", e).as_bytes());
                        self.last_status = 1;
                    }
                }
            }
            "bash" | "sh" => {
                // `bash -c '...'` or `bash script.sh` run in a subshell.
                let script = if args.first().map(|s| s.as_str()) == Some("-c") {
                    args.get(1).cloned()
                } else if let Some(f) = args.first() {
                    let p = fs::normalize(&self.cwd, f);
                    self.fs.read(&p).ok().map(|d| String::from_utf8_lossy(d).into_owned())
                } else {
                    Some(String::from_utf8_lossy(stdin).into_owned())
                };
                if let Some(s) = script {
                    let saved = self.save();
                    let script_args = if args.first().map(|s| s.as_str()) == Some("-c") { args.get(3..).unwrap_or(&[]).to_vec() } else { args.get(1..).unwrap_or(&[]).to_vec() };
                    self.positional = script_args;
                    self.run_script(&s, stdin, out);
                    self.restore(saved);
                }
            }
            "xargs" => {
                let mut cmd: Vec<String> = vec![];
                let mut n_per: Option<usize> = None;
                let mut i = 0;
                while i < args.len() {
                    match args[i].as_str() {
                        "-n" => {
                            n_per = args.get(i + 1).and_then(|s| s.parse().ok());
                            i += 1;
                        }
                        a if a.starts_with('-') && cmd.is_empty() => {}
                        a => cmd.push(a.to_string()),
                    }
                    i += 1;
                }
                if cmd.is_empty() {
                    cmd.push("echo".into());
                }
                let text = String::from_utf8_lossy(stdin).into_owned();
                let items: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();
                let chunk = n_per.unwrap_or(items.len().max(1));
                let mut status = 0;
                for group in items.chunks(chunk.max(1)) {
                    let mut full = cmd.clone();
                    full.extend(group.iter().cloned());
                    let f = self.run_argv(&full, b"", out);
                    if self.last_status != 0 {
                        status = 123;
                    }
                    if f != Flow::Normal {
                        break;
                    }
                }
                if items.is_empty() && n_per.is_none() {
                    self.run_argv(&cmd, b"", out);
                }
                self.last_status = status;
            }
            "type" | "command" => {
                let mut status = 0;
                for a in args.iter().filter(|a| !a.starts_with('-')) {
                    if self.functions.contains_key(a) {
                        out.stdout.extend_from_slice(format!("{} is a function\n", a).as_bytes());
                    } else if is_builtin(a) {
                        out.stdout.extend_from_slice(format!("{} is a shell builtin\n", a).as_bytes());
                    } else if commands::exists(a) || self.networked(a) {
                        out.stdout.extend_from_slice(format!("{} is /usr/bin/{}\n", a, a).as_bytes());
                    } else {
                        out.stderr.extend_from_slice(format!("bash: type: {}: not found\n", a).as_bytes());
                        status = 1;
                    }
                }
                self.last_status = status;
            }
            "alias" => {
                if args.is_empty() {
                    let mut names: Vec<&String> = self.aliases.keys().collect();
                    names.sort();
                    for n in names {
                        let line = format!("alias {}='{}'\n", n, self.aliases[n]);
                        out.stdout.extend_from_slice(line.as_bytes());
                    }
                } else {
                    for a in args {
                        match a.split_once('=') {
                            Some((k, v)) => {
                                // The quotes are the shell's, and are already
                                // gone by the time the word arrives.
                                self.aliases.insert(k.to_string(), v.to_string());
                            }
                            None => match self.aliases.get(a) {
                                Some(v) => {
                                    let line = format!("alias {}='{}'\n", a, v);
                                    out.stdout.extend_from_slice(line.as_bytes());
                                }
                                None => {
                                    let line = format!("bash: alias: {}: not found\n", a);
                                    out.stderr.extend_from_slice(line.as_bytes());
                                    self.last_status = 1;
                                    continue;
                                }
                            },
                        }
                    }
                }
                if self.last_status != 1 { self.last_status = 0; }
            }
            "unalias" => {
                let mut status = 0;
                if args.iter().any(|a| a == "-a") {
                    self.aliases.clear();
                } else {
                    for a in args {
                        if self.aliases.remove(a).is_none() {
                            let line = format!("bash: unalias: {}: not found\n", a);
                            out.stderr.extend_from_slice(line.as_bytes());
                            status = 1;
                        }
                    }
                }
                self.last_status = status;
            }
            "history" => {
                // `history -c` clears; a bare number limits to the last n.
                if args.iter().any(|a| a == "-c") {
                    self.history.clear();
                } else {
                    let limit: usize = args
                        .first()
                        .and_then(|a| a.parse().ok())
                        .unwrap_or(self.history.len());
                    let start = self.history.len().saturating_sub(limit);
                    for (i, entry) in self.history[start..].iter().enumerate() {
                        let line = format!("{:5}  {}\n", start + i + 1, entry);
                        out.stdout.extend_from_slice(line.as_bytes());
                    }
                }
                self.last_status = 0;
            }
            "which" => {
                let mut status = 0;
                for a in args {
                    if commands::exists(a) || is_builtin(a) || self.networked(a) {
                        out.stdout.extend_from_slice(format!("/usr/bin/{}\n", a).as_bytes());
                    } else {
                        status = 1;
                    }
                }
                self.last_status = status;
            }
            _ => {
                let env: HashMap<String, String> = self
                    .exported
                    .iter()
                    .filter_map(|k| self.vars.get(k).map(|v| (k.clone(), v.clone())))
                    .collect();
                let key = buf_key(stdin);
                let pos = *self.stdin_pos.get(&key).unwrap_or(&0);
                let remaining = &stdin[pos.min(stdin.len())..];
                if !stdin.is_empty() && commands::reads_stdin(name) {
                    self.stdin_pos.insert(key, stdin.len());
                }
                let mut ctx = commands::Ctx {
                    fs: &mut self.fs,
                    cwd: &self.cwd,
                    env: &env,
                    stdin: remaining,
                    net: &mut self.net,
                };
                // `curl` and `wget` are not in the command table: they exist
                // only when a fetch has been wired in, so that a shell with
                // no network does not advertise one.
                let networked = match name {
                    "curl" if ctx.net.enabled => Some(crate::net::curl(args, &mut ctx)),
                    "wget" if ctx.net.enabled => Some(crate::net::wget(args, &mut ctx)),
                    _ => None,
                };
                match networked.or_else(|| commands::run(name, args, &mut ctx)) {
                    Some(r) => {
                        // A request with no response yet: stop the script
                        // here. The caller fetches it and runs again, and the
                        // replay reaches this point with the answer in hand.
                        if self.net.pending.is_some() {
                            self.fatal = Some(crate::net::SUSPEND.into());
                            return Flow::Normal;
                        }
                        out.stdout.extend_from_slice(&r.stdout);
                        out.stderr.extend_from_slice(&r.stderr);
                        self.last_status = r.code;
                    }
                    None => {
                        out.stderr.extend_from_slice(format!("bash: {}: command not found\n", name).as_bytes());
                        self.last_status = 127;
                    }
                }
            }
        }
        Flow::Normal
    }

    // ------------------------------------------------------------ variables

    pub fn get_var(&self, k: &str) -> Option<String> {
        self.vars.get(k).cloned()
    }
    pub fn set_var(&mut self, k: &str, v: String) {
        if v.len() > self.limits.max_string_bytes {
            self.fatal = Some(format!("{}: variable size limit exceeded", k));
            return;
        }
        self.vars.insert(k.to_string(), v);
    }

    fn get_param(&self, p: &Parameter) -> Option<String> {
        match p {
            Parameter::Positional(0) => Some("bash".into()),
            Parameter::Positional(n) => self.positional.get(*n as usize - 1).cloned(),
            Parameter::Special(s) => Some(match s {
                SpecialParameter::AllPositionalParameters { .. } => self.positional.join(" "),
                SpecialParameter::PositionalParameterCount => self.positional.len().to_string(),
                SpecialParameter::LastExitStatus => self.last_status.to_string(),
                SpecialParameter::ProcessId => "1".into(),
                SpecialParameter::LastBackgroundProcessId => String::new(),
                SpecialParameter::ShellName => "bash".into(),
                SpecialParameter::CurrentOptionFlags => "hB".into(),
            }),
            Parameter::Named(n) => self.vars.get(n).cloned(),
            Parameter::NamedWithIndex { name, .. } => self.vars.get(name).cloned(),
            Parameter::NamedWithAllIndices { name, .. } => self.vars.get(name).cloned(),
        }
    }

    // ------------------------------------------------------------ expansion

    /// Full expansion: brace → tilde/param/cmd/arith → field split → glob.
    pub fn expand_fields(&mut self, raw: &str, out: &mut Out) -> Vec<String> {
        let mut result = vec![];
        for w in self.brace_expand(raw) {
            let segs = self.expand_to_segs(&w, out);
            for field in split_fields(&segs, &self.get_var("IFS").unwrap_or(" \t\n".into())) {
                result.extend(self.glob_field(field));
            }
        }
        result
    }

    /// Expansion without splitting or globbing (assignments, redirect targets…).
    pub fn expand_single(&mut self, raw: &str, out: &mut Out) -> String {
        let segs = self.expand_to_segs(raw, out);
        segs.iter()
            .map(|s| match s {
                Seg::Lit { text, .. } => text.as_str(),
                Seg::FieldBreak => " ",
            })
            .collect()
    }

    /// Expand a word for use as a glob pattern: quoted parts are escaped.
    fn expand_pattern(&mut self, raw: &str, out: &mut Out) -> String {
        let segs = self.expand_to_segs(raw, out);
        let mut s = String::new();
        for seg in segs {
            if let Seg::Lit { text, quoted, .. } = seg {
                if quoted {
                    s.push_str(&glob_escape(&text));
                } else {
                    s.push_str(&text);
                }
            }
        }
        s
    }

    fn expand_heredoc(&mut self, raw: &str, out: &mut Out) -> String {
        match word::parse_heredoc(raw, &self.opts) {
            Ok(pieces) => {
                let mut segs = vec![];
                self.pieces_to_segs(&pieces, true, &mut segs, out);
                segs.iter()
                    .map(|s| match s {
                        Seg::Lit { text, .. } => text.as_str(),
                        Seg::FieldBreak => " ",
                    })
                    .collect()
            }
            Err(_) => raw.to_string(),
        }
    }

    fn brace_expand(&self, raw: &str) -> Vec<String> {
        if !raw.contains('{') {
            return vec![raw.to_string()];
        }
        match word::parse_brace_expansions(raw, &self.opts) {
            Ok(Some(pieces)) => {
                let out = expand_brace_pieces(&pieces, self.limits.max_brace_expansion);
                if out.is_empty() { vec![raw.to_string()] } else { out }
            }
            _ => vec![raw.to_string()],
        }
    }

    fn expand_to_segs(&mut self, raw: &str, out: &mut Out) -> Vec<Seg> {
        let pieces = match word::parse(raw, &self.opts) {
            Ok(p) => p,
            Err(_) => {
                return vec![Seg::Lit { text: raw.to_string(), quoted: false, split: false }];
            }
        };
        let mut segs = vec![];
        self.pieces_to_segs(&pieces, false, &mut segs, out);
        let total: usize = segs.iter().map(|s| match s { Seg::Lit { text, .. } => text.len(), _ => 0 }).sum();
        if total > self.limits.max_string_bytes {
            self.fatal = Some("word expansion size limit exceeded".into());
            return vec![];
        }
        segs
    }

    fn pieces_to_segs(&mut self, pieces: &[WordPieceWithSource], in_dq: bool, segs: &mut Vec<Seg>, out: &mut Out) {
        for p in pieces {
            match &p.piece {
                WordPiece::Text(t) => segs.push(Seg::Lit { text: t.clone(), quoted: in_dq, split: false }),
                WordPiece::SingleQuotedText(t) => segs.push(Seg::Lit { text: t.clone(), quoted: true, split: false }),
                WordPiece::AnsiCQuotedText(t) => {
                    segs.push(Seg::Lit { text: unescape_ansi_c(t), quoted: true, split: false })
                }
                WordPiece::EscapeSequence(t) => {
                    let c = t.strip_prefix('\\').unwrap_or(t);
                    let c = if c == "\n" { "" } else { c };
                    segs.push(Seg::Lit { text: c.to_string(), quoted: true, split: false })
                }
                WordPiece::DoubleQuotedSequence(inner) | WordPiece::GettextDoubleQuotedSequence(inner) => {
                    // Even an empty "" produces an (empty) quoted field.
                    segs.push(Seg::Lit { text: String::new(), quoted: true, split: false });
                    self.pieces_to_segs(inner, true, segs, out);
                }
                WordPiece::TildeExpansion(t) => {
                    let v = match t {
                        TildeExpr::Home => self.get_var("HOME").unwrap_or_default(),
                        TildeExpr::UserHome(u) => format!("/home/{}", u),
                        TildeExpr::WorkingDir => self.cwd.clone(),
                        TildeExpr::OldWorkingDir => self.get_var("OLDPWD").unwrap_or_default(),
                        _ => "~".into(),
                    };
                    segs.push(Seg::Lit { text: v, quoted: true, split: false });
                }
                WordPiece::ParameterExpansion(pe) => {
                    // "$@" expands to one field per positional parameter.
                    if let ParameterExpr::Parameter {
                        parameter: Parameter::Special(SpecialParameter::AllPositionalParameters { concatenate: false }),
                        ..
                    } = pe
                    {
                        for (i, a) in self.positional.clone().iter().enumerate() {
                            if i > 0 {
                                segs.push(Seg::FieldBreak);
                            }
                            segs.push(Seg::Lit { text: a.clone(), quoted: in_dq, split: !in_dq });
                        }
                        continue;
                    }
                    let v = self.expand_param(pe, out);
                    segs.push(Seg::Lit { text: v, quoted: in_dq, split: !in_dq });
                }
                WordPiece::CommandSubstitution(cmd) | WordPiece::BackquotedCommandSubstitution(cmd) => {
                    let v = self.command_subst(cmd, out);
                    segs.push(Seg::Lit { text: v, quoted: in_dq, split: !in_dq });
                }
                WordPiece::ArithmeticExpression(e) => {
                    let v = match self.eval_arith_str(&e.value, out) {
                        Ok(v) => v.to_string(),
                        Err(err) => {
                            out.stderr.extend_from_slice(format!("bash: {}\n", err).as_bytes());
                            self.last_status = 1;
                            String::new()
                        }
                    };
                    segs.push(Seg::Lit { text: v, quoted: in_dq, split: !in_dq });
                }
            }
        }
    }

    fn command_subst(&mut self, cmd: &str, out: &mut Out) -> String {
        if self.depth >= self.limits.max_call_depth {
            self.fatal = Some("maximum substitution depth exceeded".into());
            return String::new();
        }
        self.depth += 1;
        let outer_status = self.last_status;
        let saved = self.save();
        let mut sub = Out::default();
        self.run_script(cmd, b"", &mut sub);
        self.restore(saved);
        self.last_subst = Some(self.last_status);
        self.last_status = outer_status;
        self.depth -= 1;
        out.stderr.extend_from_slice(&sub.stderr);
        let mut s = String::from_utf8_lossy(&sub.stdout).into_owned();
        while s.ends_with('\n') {
            s.pop();
        }
        s
    }

    fn expand_param(&mut self, pe: &ParameterExpr, out: &mut Out) -> String {
        let resolve = |sh: &Self, p: &Parameter, indirect: bool| -> Option<String> {
            let v = sh.get_param(p);
            if indirect { v.and_then(|name| sh.vars.get(&name).cloned()) } else { v }
        };
        let is_missing = |v: &Option<String>, t: &ParameterTestType| match t {
            ParameterTestType::UnsetOrNull => v.as_deref().map_or(true, |s| s.is_empty()),
            ParameterTestType::Unset => v.is_none(),
        };
        match pe {
            ParameterExpr::Parameter { parameter, indirect } => resolve(self, parameter, *indirect).unwrap_or_default(),
            ParameterExpr::UseDefaultValues { parameter, indirect, test_type, default_value } => {
                let v = resolve(self, parameter, *indirect);
                if is_missing(&v, test_type) {
                    self.expand_single(default_value.as_deref().unwrap_or(""), out)
                } else {
                    v.unwrap_or_default()
                }
            }
            ParameterExpr::AssignDefaultValues { parameter, indirect, test_type, default_value } => {
                let v = resolve(self, parameter, *indirect);
                if is_missing(&v, test_type) {
                    let d = self.expand_single(default_value.as_deref().unwrap_or(""), out);
                    if let Parameter::Named(n) = parameter {
                        self.set_var(n, d.clone());
                    }
                    d
                } else {
                    v.unwrap_or_default()
                }
            }
            ParameterExpr::IndicateErrorIfNullOrUnset { parameter, indirect, test_type, error_message } => {
                let v = resolve(self, parameter, *indirect);
                if is_missing(&v, test_type) {
                    let msg = self.expand_single(error_message.as_deref().unwrap_or("parameter null or not set"), out);
                    let name = match parameter {
                        Parameter::Named(n) => n.clone(),
                        _ => "?".into(),
                    };
                    out.stderr.extend_from_slice(format!("bash: {}: {}\n", name, msg).as_bytes());
                    self.last_status = 1;
                    self.fatal = Some(format!("{}: {}", name, msg));
                    String::new()
                } else {
                    v.unwrap_or_default()
                }
            }
            ParameterExpr::UseAlternativeValue { parameter, indirect, test_type, alternative_value } => {
                let v = resolve(self, parameter, *indirect);
                if is_missing(&v, test_type) {
                    String::new()
                } else {
                    self.expand_single(alternative_value.as_deref().unwrap_or(""), out)
                }
            }
            ParameterExpr::ParameterLength { parameter, indirect } => {
                if let Parameter::Special(SpecialParameter::AllPositionalParameters { .. }) = parameter {
                    return self.positional.len().to_string();
                }
                resolve(self, parameter, *indirect).unwrap_or_default().chars().count().to_string()
            }
            ParameterExpr::RemoveSmallestSuffixPattern { parameter, indirect, pattern }
            | ParameterExpr::RemoveLargestSuffixPattern { parameter, indirect, pattern }
            | ParameterExpr::RemoveSmallestPrefixPattern { parameter, indirect, pattern }
            | ParameterExpr::RemoveLargestPrefixPattern { parameter, indirect, pattern } => {
                let v = resolve(self, parameter, *indirect).unwrap_or_default();
                let pat = self.expand_pattern(pattern.as_deref().unwrap_or(""), out);
                let Some(re) = glob_regex(&pat) else { return v };
                let bounds: Vec<usize> = v.char_indices().map(|(i, _)| i).chain(std::iter::once(v.len())).collect();
                match pe {
                    ParameterExpr::RemoveSmallestPrefixPattern { .. } => {
                        bounds.iter().find(|&&i| re.is_match(&v[..i])).map(|&i| v[i..].to_string()).unwrap_or(v)
                    }
                    ParameterExpr::RemoveLargestPrefixPattern { .. } => {
                        bounds.iter().rev().find(|&&i| re.is_match(&v[..i])).map(|&i| v[i..].to_string()).unwrap_or(v)
                    }
                    ParameterExpr::RemoveSmallestSuffixPattern { .. } => {
                        bounds.iter().rev().find(|&&i| re.is_match(&v[i..])).map(|&i| v[..i].to_string()).unwrap_or(v)
                    }
                    _ => bounds.iter().find(|&&i| re.is_match(&v[i..])).map(|&i| v[..i].to_string()).unwrap_or(v),
                }
            }
            ParameterExpr::Substring { parameter, indirect, offset, length } => {
                let v: Vec<char> = resolve(self, parameter, *indirect).unwrap_or_default().chars().collect();
                let len = v.len() as i64;
                let mut off = self.eval_arith_str(&offset.value, out).unwrap_or(0);
                if off < 0 {
                    off = (len + off).max(0);
                }
                let off = off.min(len) as usize;
                let end = match length {
                    Some(l) => {
                        let l = self.eval_arith_str(&l.value, out).unwrap_or(0);
                        if l < 0 { (len + l).max(off as i64) as usize } else { (off + l as usize).min(v.len()) }
                    }
                    None => v.len(),
                };
                v[off..end].iter().collect()
            }
            ParameterExpr::Transform { parameter, indirect, op } => {
                let v = resolve(self, parameter, *indirect).unwrap_or_default();
                match op {
                    ParameterTransformOp::ToUpperCase => v.to_uppercase(),
                    ParameterTransformOp::ToLowerCase => v.to_lowercase(),
                    ParameterTransformOp::CapitalizeInitial => capitalize(&v),
                    ParameterTransformOp::Quoted => format!("'{}'", v.replace('\'', "'\\''")),
                    ParameterTransformOp::ExpandEscapeSequences => unescape_ansi_c(&v),
                    _ => v,
                }
            }
            ParameterExpr::UppercaseFirstChar { parameter, indirect, .. } => {
                capitalize(&resolve(self, parameter, *indirect).unwrap_or_default())
            }
            ParameterExpr::UppercasePattern { parameter, indirect, .. } => {
                resolve(self, parameter, *indirect).unwrap_or_default().to_uppercase()
            }
            ParameterExpr::LowercaseFirstChar { parameter, indirect, .. } => {
                let v = resolve(self, parameter, *indirect).unwrap_or_default();
                let mut c = v.chars();
                match c.next() {
                    Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
                    None => v,
                }
            }
            ParameterExpr::LowercasePattern { parameter, indirect, .. } => {
                resolve(self, parameter, *indirect).unwrap_or_default().to_lowercase()
            }
            ParameterExpr::ReplaceSubstring { parameter, indirect, pattern, replacement, match_kind } => {
                let v = resolve(self, parameter, *indirect).unwrap_or_default();
                let pat = self.expand_pattern(pattern, out);
                let rep = self.expand_single(replacement.as_deref().unwrap_or(""), out);
                replace_glob(&v, &pat, &rep, match_kind)
            }
            ParameterExpr::VariableNames { prefix, .. } => {
                let mut names: Vec<_> = self.vars.keys().filter(|k| k.starts_with(prefix.as_str())).cloned().collect();
                names.sort();
                names.join(" ")
            }
            ParameterExpr::MemberKeys { .. } => "0".into(),
        }
    }

    fn glob_field(&self, field: Vec<(String, bool)>) -> Vec<String> {
        let has_glob = field.iter().any(|(t, q)| !q && t.chars().any(|c| matches!(c, '*' | '?' | '[')));
        let literal: String = field.iter().map(|(t, _)| t.as_str()).collect();
        if !has_glob {
            return vec![literal];
        }
        let pattern: String = field
            .iter()
            .map(|(t, q)| if *q { glob_escape(t) } else { t.clone() })
            .collect();
        let matches = self.glob(&pattern);
        if matches.is_empty() { vec![literal] } else { matches }
    }

    /// Match a glob pattern against the virtual FS, one path component at a time.
    pub fn glob(&self, pattern: &str) -> Vec<String> {
        let absolute = pattern.starts_with('/');
        let comps: Vec<&str> = pattern.split('/').filter(|c| !c.is_empty()).collect();
        let mut cands: Vec<(String, String)> = vec![(
            if absolute { "/".into() } else { self.cwd.clone() },
            if absolute { "/".into() } else { String::new() },
        )];
        for (i, comp) in comps.iter().enumerate() {
            let last = i == comps.len() - 1;
            let mut next = vec![];
            let is_pat = comp.chars().any(|c| matches!(c, '*' | '?' | '['));
            for (abs, disp) in &cands {
                let join = |base: &str, name: &str| {
                    if base.is_empty() { name.to_string() } else if base.ends_with('/') { format!("{}{}", base, name) } else { format!("{}/{}", base, name) }
                };
                if is_pat {
                    let Ok(kids) = self.fs.list(abs) else { continue };
                    let re = glob_regex(comp);
                    for k in kids {
                        if k.starts_with('.') && !comp.starts_with('.') {
                            continue;
                        }
                        if re.as_ref().map_or(false, |r| r.is_match(&k)) {
                            let a = fs::normalize(abs, &k);
                            if last || self.fs.is_dir(&a) {
                                next.push((a, join(disp, &k)));
                            }
                        }
                    }
                } else {
                    let unesc = glob_unescape(comp);
                    let a = fs::normalize(abs, &unesc);
                    if self.fs.exists(&a) {
                        next.push((a, join(disp, &unesc)));
                    }
                }
            }
            cands = next;
        }
        let mut res: Vec<String> = cands.into_iter().map(|(_, d)| d).collect();
        res.sort();
        res
    }

    // ----------------------------------------------------------- arithmetic

    fn eval_arith_str(&mut self, raw: &str, out: &mut Out) -> Result<i64, String> {
        let expanded = self.expand_single(raw, out);
        if expanded.trim().is_empty() {
            return Ok(0);
        }
        let expr = arithmetic::parse(&expanded).map_err(|_| format!("{}: syntax error in expression", expanded.trim()))?;
        self.eval_arith(&expr)
    }

    fn arith_var(&self, name: &str) -> i64 {
        let v = self.vars.get(name).cloned().unwrap_or_default();
        let v = v.trim();
        if v.is_empty() {
            return 0;
        }
        if let Ok(n) = v.parse::<i64>() {
            return n;
        }
        // A variable may itself hold an expression or another var name.
        arithmetic::parse(v).ok().and_then(|e| {
            if let ArithmeticExpr::Reference(ArithmeticTarget::Variable(n)) = &e {
                if n == name {
                    return Some(0);
                }
            }
            let mut tmp = Shell::new();
            tmp.vars = self.vars.clone();
            tmp.vars.remove(name);
            tmp.eval_arith(&e).ok()
        }).unwrap_or(0)
    }

    fn eval_arith(&mut self, e: &ArithmeticExpr) -> Result<i64, String> {
        use ast::BinaryOperator as B;
        Ok(match e {
            ArithmeticExpr::Literal(n) => *n,
            ArithmeticExpr::Reference(ArithmeticTarget::Variable(n)) => self.arith_var(n),
            ArithmeticExpr::Reference(ArithmeticTarget::ArrayElement(n, _)) => self.arith_var(n),
            ArithmeticExpr::UnaryOp(op, x) => {
                let v = self.eval_arith(x)?;
                match op {
                    UnaryOperator::UnaryPlus => v,
                    UnaryOperator::UnaryMinus => v.wrapping_neg(),
                    UnaryOperator::BitwiseNot => !v,
                    UnaryOperator::LogicalNot => (v == 0) as i64,
                }
            }
            ArithmeticExpr::BinaryOp(op, a, b) => {
                if matches!(op, B::LogicalAnd) {
                    return Ok((self.eval_arith(a)? != 0 && self.eval_arith(b)? != 0) as i64);
                }
                if matches!(op, B::LogicalOr) {
                    return Ok((self.eval_arith(a)? != 0 || self.eval_arith(b)? != 0) as i64);
                }
                let x = self.eval_arith(a)?;
                let y = self.eval_arith(b)?;
                arith_binop(op, x, y)?
            }
            ArithmeticExpr::Conditional(c, a, b) => {
                if self.eval_arith(c)? != 0 { self.eval_arith(a)? } else { self.eval_arith(b)? }
            }
            ArithmeticExpr::Assignment(t, x) => {
                let v = self.eval_arith(x)?;
                self.set_var(arith_target_name(t), v.to_string());
                v
            }
            ArithmeticExpr::BinaryAssignment(op, t, x) => {
                let cur = self.arith_var(arith_target_name(t));
                let y = self.eval_arith(x)?;
                let v = arith_binop(op, cur, y)?;
                self.set_var(arith_target_name(t), v.to_string());
                v
            }
            ArithmeticExpr::UnaryAssignment(op, t) => {
                let name = arith_target_name(t).to_string();
                let cur = self.arith_var(&name);
                let (new, ret) = match op {
                    UnaryAssignmentOperator::PrefixIncrement => (cur + 1, cur + 1),
                    UnaryAssignmentOperator::PrefixDecrement => (cur - 1, cur - 1),
                    UnaryAssignmentOperator::PostfixIncrement => (cur + 1, cur),
                    UnaryAssignmentOperator::PostfixDecrement => (cur - 1, cur),
                };
                self.set_var(&name, new.to_string());
                ret
            }
        })
    }

    // ---------------------------------------------------------------- tests

    fn eval_test(&self, a: &[&str]) -> Result<bool, String> {
        if a.is_empty() {
            return Ok(false);
        }
        // -o has lowest precedence, then -a, then !
        if let Some(i) = a.iter().rposition(|x| *x == "-o") {
            if i > 0 && i < a.len() - 1 {
                return Ok(self.eval_test(&a[..i])? || self.eval_test(&a[i + 1..])?);
            }
        }
        if let Some(i) = a.iter().rposition(|x| *x == "-a") {
            if i > 0 && i < a.len() - 1 {
                return Ok(self.eval_test(&a[..i])? && self.eval_test(&a[i + 1..])?);
            }
        }
        if a[0] == "!" {
            return Ok(!self.eval_test(&a[1..])?);
        }
        if a[0] == "(" && a.last() == Some(&")") {
            return self.eval_test(&a[1..a.len() - 1]);
        }
        match a.len() {
            1 => Ok(!a[0].is_empty()),
            2 => self.unary_test(a[0], a[1]),
            3 => self.binary_test(a[0], a[1], a[2], false),
            _ => Err("too many arguments".into()),
        }
    }

    fn unary_test(&self, op: &str, v: &str) -> Result<bool, String> {
        let p = fs::normalize(&self.cwd, v);
        Ok(match op {
            "-z" => v.is_empty(),
            "-n" => !v.is_empty(),
            "-e" | "-a" => self.fs.exists(&p),
            "-f" => self.fs.is_file(&p),
            "-d" => self.fs.is_dir(&p),
            "-s" => self.fs.size(&p) > 0,
            "-r" | "-w" | "-x" => self.fs.exists(&p),
            "-L" | "-h" | "-p" | "-S" | "-b" | "-c" | "-t" => false,
            "-v" => self.vars.contains_key(v),
            _ => return Err(format!("{}: unary operator expected", op)),
        })
    }

    fn binary_test(&self, l: &str, op: &str, r: &str, pattern: bool) -> Result<bool, String> {
        let num = |s: &str| s.trim().parse::<i64>().map_err(|_| format!("{}: integer expression expected", s));
        Ok(match op {
            "=" | "==" => if pattern { glob_match(r, l) } else { l == r },
            "!=" => if pattern { !glob_match(r, l) } else { l != r },
            "<" => l < r,
            ">" => l > r,
            "-eq" => num(l)? == num(r)?,
            "-ne" => num(l)? != num(r)?,
            "-lt" => num(l)? < num(r)?,
            "-le" => num(l)? <= num(r)?,
            "-gt" => num(l)? > num(r)?,
            "-ge" => num(l)? >= num(r)?,
            "-nt" | "-ot" | "-ef" => false,
            _ => return Err(format!("{}: binary operator expected", op)),
        })
    }

    fn eval_ext_test(&mut self, e: &ExtendedTestExpr, out: &mut Out) -> bool {
        match e {
            ExtendedTestExpr::And(a, b) => self.eval_ext_test(a, out) && self.eval_ext_test(b, out),
            ExtendedTestExpr::Or(a, b) => self.eval_ext_test(a, out) || self.eval_ext_test(b, out),
            ExtendedTestExpr::Not(a) => !self.eval_ext_test(a, out),
            ExtendedTestExpr::Parenthesized(a) => self.eval_ext_test(a, out),
            ExtendedTestExpr::UnaryTest(pred, w) => {
                let v = self.expand_single(&w.value, out);
                let op = match pred {
                    UnaryPredicate::StringHasZeroLength => "-z",
                    UnaryPredicate::StringHasNonZeroLength => "-n",
                    UnaryPredicate::FileExists => "-e",
                    UnaryPredicate::FileExistsAndIsRegularFile => "-f",
                    UnaryPredicate::FileExistsAndIsDir => "-d",
                    UnaryPredicate::FileExistsAndIsNotZeroLength => "-s",
                    UnaryPredicate::FileExistsAndIsReadable
                    | UnaryPredicate::FileExistsAndIsWritable
                    | UnaryPredicate::FileExistsAndIsExecutable => "-r",
                    UnaryPredicate::ShellVariableIsSetAndAssigned => "-v",
                    _ => "-L",
                };
                self.unary_test(op, &v).unwrap_or(false)
            }
            ExtendedTestExpr::BinaryTest(pred, l, r) => {
                let lv = self.expand_single(&l.value, out);
                match pred {
                    BinaryPredicate::StringMatchesRegex => {
                        let rv = self.expand_single(&r.value, out);
                        match regex::Regex::new(&rv) {
                            Ok(re) => match re.captures(&lv) {
                                Some(c) => {
                                    let m: Vec<String> = c.iter().map(|g| g.map(|g| g.as_str().to_string()).unwrap_or_default()).collect();
                                    self.set_var("BASH_REMATCH", m.join(" "));
                                    true
                                }
                                None => false,
                            },
                            Err(_) => false,
                        }
                    }
                    BinaryPredicate::StringExactlyMatchesPattern | BinaryPredicate::StringDoesNotExactlyMatchPattern => {
                        let rv = self.expand_pattern(&r.value, out);
                        let m = glob_match(&rv, &lv);
                        if matches!(pred, BinaryPredicate::StringExactlyMatchesPattern) { m } else { !m }
                    }
                    _ => {
                        let rv = self.expand_single(&r.value, out);
                        let op = match pred {
                            BinaryPredicate::StringExactlyMatchesString => "==",
                            BinaryPredicate::StringDoesNotExactlyMatchString => "!=",
                            BinaryPredicate::LeftSortsBeforeRight => "<",
                            BinaryPredicate::LeftSortsAfterRight => ">",
                            BinaryPredicate::ArithmeticEqualTo => "-eq",
                            BinaryPredicate::ArithmeticNotEqualTo => "-ne",
                            BinaryPredicate::ArithmeticLessThan => "-lt",
                            BinaryPredicate::ArithmeticLessThanOrEqualTo => "-le",
                            BinaryPredicate::ArithmeticGreaterThan => "-gt",
                            BinaryPredicate::ArithmeticGreaterThanOrEqualTo => "-ge",
                            _ => "-nt",
                        };
                        self.binary_test(&lv, op, &rv, false).unwrap_or(false)
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ helpers

/// Splits an alias body into words, honouring quotes. Not a full parse: an
/// alias is a prefix, and anything needing more than this wants a function.
fn split_words(text: &str) -> Vec<String> {
    let mut words = vec![];
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in text.chars() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => current.push(c),
            (None, '\'' | '"') => quote = Some(c),
            (None, ' ' | '\t') => {
                if !current.is_empty() { words.push(std::mem::take(&mut current)); }
            }
            (None, _) => current.push(c),
        }
    }
    if !current.is_empty() { words.push(current); }
    words
}

fn is_builtin(n: &str) -> bool {
    matches!(
        n,
        ":" | "true" | "false" | "cd" | "pwd" | "export" | "unset" | "local" | "declare" | "typeset"
            | "readonly" | "set" | "shift" | "exit" | "return" | "break" | "continue" | "test" | "["
            | "read" | "eval" | "source" | "." | "type" | "command" | "xargs" | "which" | "bash" | "sh"
            | "alias" | "unalias" | "history"
    )
}

fn assignment_name(a: &Assignment) -> String {
    match &a.name {
        AssignmentName::VariableName(n) => n.clone(),
        AssignmentName::ArrayElementName(n, _) => n.clone(),
    }
}

fn arith_target_name(t: &ArithmeticTarget) -> &str {
    match t {
        ArithmeticTarget::Variable(n) => n,
        ArithmeticTarget::ArrayElement(n, _) => n,
    }
}

fn arith_binop(op: &ast::BinaryOperator, x: i64, y: i64) -> Result<i64, String> {
    use ast::BinaryOperator as B;
    Ok(match op {
        B::Power => {
            if y < 0 { return Err("exponent less than 0".into()) }
            x.wrapping_pow(y as u32)
        }
        B::Multiply => x.wrapping_mul(y),
        B::Divide => {
            if y == 0 { return Err("division by 0".into()) }
            x.wrapping_div(y)
        }
        B::Modulo => {
            if y == 0 { return Err("division by 0".into()) }
            x.wrapping_rem(y)
        }
        B::Comma => y,
        B::Add => x.wrapping_add(y),
        B::Subtract => x.wrapping_sub(y),
        B::ShiftLeft => x.wrapping_shl(y as u32),
        B::ShiftRight => x.wrapping_shr(y as u32),
        B::LessThan => (x < y) as i64,
        B::LessThanOrEqualTo => (x <= y) as i64,
        B::GreaterThan => (x > y) as i64,
        B::GreaterThanOrEqualTo => (x >= y) as i64,
        B::Equals => (x == y) as i64,
        B::NotEquals => (x != y) as i64,
        B::BitwiseAnd => x & y,
        B::BitwiseXor => x ^ y,
        B::BitwiseOr => x | y,
        B::LogicalAnd => (x != 0 && y != 0) as i64,
        B::LogicalOr => (x != 0 || y != 0) as i64,
    })
}

/// Split expanded segments into fields on IFS (only unquoted expansion results split).
fn split_fields(segs: &[Seg], ifs: &str) -> Vec<Vec<(String, bool)>> {
    let mut fields: Vec<Vec<(String, bool)>> = vec![];
    let mut cur: Vec<(String, bool)> = vec![];
    let mut cur_has = false;
    for s in segs {
        match s {
            Seg::FieldBreak => {
                fields.push(std::mem::take(&mut cur));
                cur_has = false;
            }
            Seg::Lit { text, quoted, split } => {
                if *split && !ifs.is_empty() {
                    let mut buf = String::new();
                    for c in text.chars() {
                        if ifs.contains(c) {
                            if !buf.is_empty() {
                                cur.push((std::mem::take(&mut buf), false));
                                cur_has = true;
                            }
                            if cur_has {
                                fields.push(std::mem::take(&mut cur));
                                cur_has = false;
                            }
                        } else {
                            buf.push(c);
                        }
                    }
                    if !buf.is_empty() {
                        cur.push((buf, false));
                        cur_has = true;
                    }
                } else {
                    if *quoted || !text.is_empty() {
                        cur_has = true;
                    }
                    cur.push((text.clone(), *quoted));
                }
            }
        }
    }
    if cur_has {
        fields.push(cur);
    }
    fields
}

fn expand_brace_pieces(pieces: &[BraceExpressionOrText], cap: usize) -> Vec<String> {
    let mut acc = vec![String::new()];
    for p in pieces {
        let alts: Vec<String> = match p {
            BraceExpressionOrText::Text(t) => vec![t.clone()],
            BraceExpressionOrText::Expr(members) => {
                let mut v = vec![];
                for m in members {
                    match m {
                        BraceExpressionMember::NumberSequence { start, end, increment } => {
                            let inc = increment.abs().max(1);
                            if start <= end {
                                let mut i = *start;
                                while i <= *end && v.len() < cap { v.push(i.to_string()); i += inc; }
                            } else {
                                let mut i = *start;
                                while i >= *end && v.len() < cap { v.push(i.to_string()); i -= inc; }
                            }
                        }
                        BraceExpressionMember::CharSequence { start, end, increment } => {
                            let inc = increment.abs().max(1) as u32;
                            let (s, e) = (*start as u32, *end as u32);
                            if s <= e {
                                let mut i = s;
                                while i <= e { if let Some(c) = char::from_u32(i) { v.push(c.to_string()); } i += inc; }
                            } else {
                                let mut i = s as i64;
                                while i >= e as i64 { if let Some(c) = char::from_u32(i as u32) { v.push(c.to_string()); } i -= inc as i64; }
                            }
                        }
                        BraceExpressionMember::Child(c) => v.extend(expand_brace_pieces(c, cap)),
                    }
                }
                v
            }
        };
        if acc.len().saturating_mul(alts.len()) > cap {
            return vec![];
        }
        let mut next = Vec::with_capacity(acc.len() * alts.len());
        for a in &acc {
            for b in &alts {
                next.push(format!("{}{}", a, b));
            }
        }
        acc = next;
    }
    acc
}

pub fn glob_regex(pattern: &str) -> Option<regex::Regex> {
    let body = brush_parser::pattern::pattern_to_regex_str(pattern, true).ok()?;
    regex::Regex::new(&format!("^(?s:{})$", body)).ok()
}

pub fn glob_match(pattern: &str, text: &str) -> bool {
    glob_regex(pattern).map_or(pattern == text, |r| r.is_match(text))
}

fn glob_escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn glob_unescape(s: &str) -> String {
    let mut o = String::new();
    let mut esc = false;
    for c in s.chars() {
        if esc { o.push(c); esc = false; } else if c == '\\' { esc = true; } else { o.push(c); }
    }
    o
}

fn replace_glob(v: &str, pat: &str, rep: &str, kind: &SubstringMatchKind) -> String {
    let Some(re) = glob_regex(pat) else { return v.to_string() };
    let bounds: Vec<usize> = v.char_indices().map(|(i, _)| i).chain(std::iter::once(v.len())).collect();
    // Longest match starting at a given position.
    let longest_at = |start: usize| -> Option<usize> {
        bounds.iter().rev().filter(|&&e| e >= start).find(|&&e| e > start && re.is_match(&v[start..e])).copied()
    };
    match kind {
        SubstringMatchKind::Prefix => match longest_at(0) {
            Some(e) => format!("{}{}", rep, &v[e..]),
            None => v.to_string(),
        },
        SubstringMatchKind::Suffix => {
            for &s in &bounds {
                if s < v.len() && re.is_match(&v[s..]) {
                    return format!("{}{}", &v[..s], rep);
                }
            }
            v.to_string()
        }
        SubstringMatchKind::FirstOccurrence | SubstringMatchKind::Anywhere => {
            let all = matches!(kind, SubstringMatchKind::Anywhere);
            let mut out = String::new();
            let mut i = 0;
            let mut replaced = false;
            while i < v.len() {
                if !(replaced && !all) {
                    if let Some(e) = longest_at(i) {
                        out.push_str(rep);
                        i = e;
                        replaced = true;
                        continue;
                    }
                }
                let c = v[i..].chars().next().unwrap();
                out.push(c);
                i += c.len_utf8();
            }
            out
        }
    }
}

fn capitalize(v: &str) -> String {
    let mut c = v.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub fn unescape_ansi_c(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('a') => out.push('\x07'),
            Some('b') => out.push('\x08'),
            Some('e') | Some('E') => out.push('\x1b'),
            Some('f') => out.push('\x0c'),
            Some('v') => out.push('\x0b'),
            Some('\\') => out.push('\\'),
            Some('\'') => out.push('\''),
            Some('"') => out.push('"'),
            Some('0') => {
                let mut n = String::new();
                while n.len() < 3 && it.peek().map_or(false, |c| c.is_digit(8)) { n.push(it.next().unwrap()); }
                if let Some(ch) = u32::from_str_radix(if n.is_empty() { "0" } else { &n }, 8).ok().and_then(char::from_u32) { out.push(ch); }
            }
            Some('x') => {
                let mut n = String::new();
                while n.len() < 2 && it.peek().map_or(false, |c| c.is_ascii_hexdigit()) { n.push(it.next().unwrap()); }
                if let Some(ch) = u32::from_str_radix(&n, 16).ok().and_then(char::from_u32) { out.push(ch); }
            }
            Some(o) => { out.push('\\'); out.push(o); }
            None => out.push('\\'),
        }
    }
    out
}
